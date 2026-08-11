// T8 lever-1b: the PRODUCTION shape of the WASM parser under D9 + D10.
//
// Two problems with the lever-1 spike (parser.c), both fixed here:
//
// 1. MEMORY (footgun #22). parser.c allocates a full 75.3 MB cube as static
//    linear memory. Every Worker needs its own WASM instance (linear memory
//    cannot be shared without SharedArrayBuffer, which D2 forbids on GitHub
//    Pages), so 8 workers x 140 MiB = 1.1 GB of parse scratch and the 1.0 GB
//    gate fails before a single case is retained.
//    Fix: rows are area-fastest within (date, hour), so a contiguous byte range
//    is a contiguous run of HOURS. A worker's output is a compact
//    [43 areas x 50 metrics x hoursInBlock] slab the main thread blits into the
//    real cube. Per-worker memory becomes a function of BLOCK size, not case
//    size: 12 MiB in + 8.8 MB out = ~21 MB; eight workers ~168 MB.
//
// 2. BLOCK INDEPENDENCE (D10). parser.c derived (area, hour) from a global row
//    counter, which forces blocks to be parsed in order and to start on an
//    exact 43-row boundary -- neither is knowable from a raw byte offset.
//    Fix: derive area and hour from each row's OWN fields (Date / Hour / Name),
//    exactly as footguns #17 and #18 require anyway. Blocks then become
//    genuinely independent: a worker needs only its bytes, not its position.
//    This also absorbs the "row machinery" D9 flagged as an open cost.
//
// Build: bench/parse-lab/wasm/build.sh

#include <wasm_simd128.h>

#define NUM             50
#define NUM_AREAS       43
#define BLOCK_BYTES     (12u * 1024u * 1024u)
#define MAX_BLOCK_HOURS 1024u
#define AREA_TABLE      128u        // power of 2, open addressing, 43 entries
#define NO_AREA         0xFFFFFFFFu

static unsigned char inbuf[BLOCK_BYTES];
static float         slab[(unsigned)NUM_AREAS * NUM * MAX_BLOCK_HOURS];

// Per-hour TOU code for this block, 0 = OffPeak, 1 = OnPeak, 0xFF = no row
// covered that hour. TOU is FILE DATA and is never recomputed from the
// calendar (footgun #17) -- the real rule is HE 6-22 Mon-Sat with Sunday
// fully OffPeak, varies by tariff, and drops holidays. It is read here
// rather than in a second JS pass purely so the block's bytes are scanned
// once; the value itself still comes from the file's own TOU column.
static unsigned char touOut[MAX_BLOCK_HOURS];
// 1 = at least one row for this area appeared in the block. Feeds the
// per-(area, metric) presence bitmap so an area a case never exported is
// excluded up front rather than left as NaN for a kernel to trip over.
static unsigned char areaSeen[NUM_AREAS];

// Open-addressed FNV1a(name) -> areaIdx table, filled from JS at startup.
static unsigned areaHash[AREA_TABLE];
static unsigned areaIdx [AREA_TABLE];

static unsigned g_rows, g_baseHour, g_maxHour, g_unknownArea, g_outOfRange;

__attribute__((export_name("inbuf_ptr")))    unsigned char* inbuf_ptr(void)    { return inbuf; }
__attribute__((export_name("inbuf_size")))   unsigned       inbuf_size(void)   { return BLOCK_BYTES; }
__attribute__((export_name("slab_ptr")))     float*         slab_ptr(void)     { return slab; }
__attribute__((export_name("tou_ptr")))      unsigned char* tou_ptr(void)      { return touOut; }
__attribute__((export_name("area_seen_ptr")))unsigned char* area_seen_ptr(void){ return areaSeen; }
__attribute__((export_name("slab_hours")))   unsigned       slab_hours(void)   { return MAX_BLOCK_HOURS; }
__attribute__((export_name("last_rows")))    unsigned       last_rows(void)    { return g_rows; }
__attribute__((export_name("last_base_hour")))unsigned      last_base_hour(void){ return g_baseHour; }
__attribute__((export_name("last_max_hour")))unsigned       last_max_hour(void){ return g_maxHour; }
__attribute__((export_name("last_unknown_area"))) unsigned  last_unknown_area(void){ return g_unknownArea; }
__attribute__((export_name("last_out_of_range"))) unsigned  last_out_of_range(void){ return g_outOfRange; }

__attribute__((export_name("area_table_reset")))
void area_table_reset(void) {
  for (unsigned i = 0; i < AREA_TABLE; i++) { areaHash[i] = 0; areaIdx[i] = NO_AREA; }
}
__attribute__((export_name("area_table_put")))
void area_table_put(unsigned hash, unsigned idx) {
  unsigned s = hash & (AREA_TABLE - 1);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1);
    if (areaIdx[k] == NO_AREA) { areaHash[k] = hash; areaIdx[k] = idx; return; }
  }
}
static inline unsigned area_lookup(unsigned hash) {
  unsigned s = hash & (AREA_TABLE - 1);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1);
    if (areaIdx[k] == NO_AREA) return NO_AREA;
    if (areaHash[k] == hash) return areaIdx[k];
  }
  return NO_AREA;
}

static inline unsigned fnv1a(const unsigned char* p, const unsigned char* e) {
  unsigned h = 0x811c9dc5u;
  for (; p < e; p++) { h ^= *p; h *= 0x01000193u; }
  return h;
}

// Cumulative days before each month, non-leap. Feb 29 is dropped at ingest
// (D4), so a leap year uses the same table and the Feb 29 rows are skipped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// f64 digit accumulation -- measured FASTER than the Eisel-Lemire u64-mantissa
// approach on wasm32 in lever-1 (130.2 ms vs 157.0 ms). Do NOT "optimize" this
// into fast_float's algorithm; it loses here.
// Exponent notation IS present in real exports -- testcase.csv carries
// `7E-05` and `8E-05` for near-zero A.S. amounts, and the export writes
// tiny magnitudes that way rather than as long decimal strings. Returning
// NaN on them (as this did until T4 caught it cell-by-cell) is silent data
// loss: the cell simply reads as absent, which every kernel is designed to
// skip without complaint.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where a correctly
  // rounded strtod rounds once, and on the two 8-digit money columns that
  // shows up as a 1-ulp float32 difference in 8 cells out of 18,834,000
  // (worst relative 9.79e-8, under one f32 ulp of 1.19e-7).
  //
  // MEASURED, do not "fix" this:
  //   * Folding both parts into one f64 mantissa with a single division
  //     costs 20% throughput (204 -> 160 MiB/s) and changes none of the 8
  //     cells -- those values carry 18 significant digits, so the mantissa
  //     is inexact either way.
  //   * Eisel-Lemire is already refuted for wasm32 in csv-parsing.md.
  // The residual is below f32 storage precision by construction, which is
  // the only reason it is acceptable. T4 gates it at <= 1 ulp, not at zero.
  double ip = 0.0;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    ip = ip * 10.0 + (double)d;
    p++;
  }
  double v = ip;
  if (p < e && *p == '.') {
    p++;
    double f = 0.0, sc = 1.0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      f = f * 10.0 + (double)d;
      sc *= 10.0;
      p++;
    }
    v += f / sc;
  }
  if (p < e && (*p == 'e' || *p == 'E')) {
    p++;
    int eneg = 0;
    if (p < e && (*p == '-' || *p == '+')) { eneg = (*p == '-'); p++; }
    int ex = 0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      ex = ex * 10 + (int)d;
      if (ex > 400) ex = 400;   // past f32 range either way
      p++;
    }
    // Exponentiation by squaring: no libm in a freestanding module, and a
    // POW10 table would still need this path for the out-of-table cases.
    double scale = 1.0, base = 10.0;
    for (int k = ex; k; k >>= 1) { if (k & 1) scale *= base; base *= base; }
    v = eneg ? v / scale : v * scale;
  }

  // Anything left over is garbage, not a number. Kept strict: the old loop
  // bailed to NaN on the first non-digit, and a partial parse of a mangled
  // field would be a plausible-looking wrong number.
  if (p != e) return 0.0f / 0.0f;
  return (float)(neg ? -v : v);
}

static inline unsigned parse_uint(const unsigned char* p, const unsigned char* e) {
  unsigned v = 0;
  for (; p < e; p++) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    v = v * 10u + d;
  }
  return v;
}

// M/D/YYYY -> hour-of-year base. Returns 0xFFFFFFFF for Feb 29 (dropped, D4).
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e) {
  unsigned month = 0, day = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0xFFFFFFFFu;
  if (month == 2 && day == 29) return 0xFFFFFFFFu;   // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}

__attribute__((export_name("slab_fill_nan")))
void slab_fill_nan(unsigned hours) {
  if (hours > MAX_BLOCK_HOURS) hours = MAX_BLOCK_HOURS;
  const float nan = 0.0f / 0.0f;
  unsigned n = (unsigned)NUM_AREAS * NUM * hours;
  for (unsigned i = 0; i < n; i++) slab[i] = nan;
}

// Parse a block of WHOLE rows. `len` bytes in inbuf, starting at a row boundary
// and ending just after a '\n'. `baseHour` is the hour index the slab maps to
// index 0 (the caller derives it from the block's first row; pass 0xFFFFFFFF to
// have this function take it from the first row it sees).
//
// Slab layout: [(area*NUM + metric)*MAX_BLOCK_HOURS + (hour - baseHour)]
// Column roles come from the canonical order Date,Hour,TOU,Name,<50 metrics>;
// production must map metrics by trimmed header name (footgun #18), which is a
// JS-side plan array passed in -- not modelled here, the cost is identical.
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len, unsigned baseHour) {
  const unsigned char* b = inbuf;
  unsigned col = 0, fs = 0;
  unsigned rowDay = 0, rowHour = 0, rowArea = NO_AREA, hIdx = 0xFFFFFFFFu;
  unsigned rowTou = 0xFFu;
  g_rows = 0; g_unknownArea = 0; g_outOfRange = 0;
  g_baseHour = baseHour; g_maxHour = 0;
  int haveBase = (baseHour != 0xFFFFFFFFu);

  for (unsigned k = 0; k < MAX_BLOCK_HOURS; k++) touOut[k] = 0xFFu;
  for (unsigned k = 0; k < NUM_AREAS; k++)       areaSeen[k] = 0;

  const v128_t vcomma = wasm_i8x16_splat(',');
  const v128_t vnl    = wasm_i8x16_splat('\n');
  unsigned i = 0;

  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0) {                                                           \
        rowDay = date_to_day(b + fs, b + e);                                    \
      } else if (col == 1) {                                                    \
        rowHour = parse_uint(b + fs, b + e);                                    \
      } else if (col == 2) {                                                    \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        rowTou = (e > fs + 1 && b[fs + 1] == 'n') ? 1u : 0u;                    \
      } else if (col == 3) {                                                    \
        rowArea = area_lookup(fnv1a(b + fs, b + e));                            \
        if (rowArea == NO_AREA) g_unknownArea++;                                \
        else areaSeen[rowArea] = 1;                                             \
        if (rowDay != 0xFFFFFFFFu && rowHour >= 1 && rowHour <= 24) {           \
          hIdx = rowDay * 24u + (rowHour - 1u);                                 \
          if (!haveBase) { g_baseHour = hIdx; haveBase = 1; }                   \
        } else hIdx = 0xFFFFFFFFu;                                              \
        if (hIdx != 0xFFFFFFFFu && hIdx >= g_baseHour &&                        \
            hIdx - g_baseHour < MAX_BLOCK_HOURS) {                              \
          touOut[hIdx - g_baseHour] = (unsigned char)rowTou;                    \
        }                                                                       \
      } else if (col >= 4) {                                                    \
        unsigned m = col - 4u;                                                  \
        if (m < NUM && rowArea != NO_AREA && hIdx != 0xFFFFFFFFu) {             \
          unsigned rel = hIdx - g_baseHour;                                     \
          if (hIdx >= g_baseHour && rel < MAX_BLOCK_HOURS) {                    \
            slab[(rowArea * NUM + m) * MAX_BLOCK_HOURS + rel] =                 \
              parse_float(b + fs, b + e);                                       \
            if (rel > g_maxHour) g_maxHour = rel;                               \
          } else g_outOfRange++;                                                \
        }                                                                       \
      }                                                                         \
    }

  for (; i + 16 <= len; i += 16) {
    v128_t chunk = wasm_v128_load(b + i);
    v128_t hit   = wasm_v128_or(wasm_i8x16_eq(chunk, vcomma), wasm_i8x16_eq(chunk, vnl));
    unsigned mask = (unsigned)wasm_i8x16_bitmask(hit);
    while (mask) {
      unsigned pos = i + (unsigned)__builtin_ctz(mask);
      mask &= mask - 1;
      FIELD(pos)
      fs = pos + 1;
      col++;
      if (b[pos] == '\n') { g_rows++; col = 0; rowArea = NO_AREA; hIdx = 0xFFFFFFFFu; }
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') {
      FIELD(i)
      fs = i + 1;
      col++;
      if (c == '\n') { g_rows++; col = 0; rowArea = NO_AREA; hIdx = 0xFFFFFFFFu; }
    }
  }
  #undef FIELD
  return g_rows;
}
