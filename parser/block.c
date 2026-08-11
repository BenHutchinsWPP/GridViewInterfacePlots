// The WASM CSV parser for GridView MONITORED-INTERFACE exports.
//
// Shape of the input (docs/data-format.md):
//
//   line 1   Interface Hourly 'Power Flow (MW)' Data for Year 2034
//   line 2   (blank)
//   line 3   (From the first hour of 1/1/2034 ... Column identifier -- InterfaceName)
//   line 4   (blank)
//   line 5   Date, Hour, TOU,<interface 1>,<interface 2>,...
//   line 6+  one row per HOUR
//
// The four preamble lines and the header are consumed on the JS side; this
// module only ever sees whole DATA rows. Two invariants carry over from the
// area-export parser this replaced, and one is new:
//
// 1. MEMORY (footgun 22). Every Worker needs its own WASM instance (linear
//    memory cannot be shared without SharedArrayBuffer, which D2 forbids on
//    GitHub Pages), so per-instance memory must be a function of BLOCK size,
//    never of case size: 12 MiB input window + an 8 MiB slab.
// 2. BLOCK INDEPENDENCE (D10). Each row's hour comes from its OWN Date and
//    Hour fields, never from a running row counter, so a worker needs its
//    bytes and not its position and blocks may be parsed in any order.
// 3. ONE ROW = ONE HOUR (D13). The area column is gone: every interface is a
//    COLUMN, so a row is a complete hour and no hour is ever split across two
//    blocks. The slab is [NUM interfaces x MAX_BLOCK_HOURS] and the blit on
//    the JS side is a straight copy rather than an edge-aware merge.
//
// Build: ./build.sh

#include <wasm_simd128.h>

// Interface columns per export. The reference exports carry 167; 512 leaves
// room for a wider study without another rebuild, and costs 8 MiB of slab at
// MAX_BLOCK_HOURS. A file with more columns than this is REFUSED on the JS
// side (last_wide_field), never silently truncated.
#define NUM             512
#define KEY_COLS        3           // Date, Hour, TOU
#define BLOCK_BYTES     (12u * 1024u * 1024u)
// Hours one block may span. Blocks are sized on the JS side from the file's
// own row length so this is never exceeded; exceeding it is counted and
// refused rather than wrapped.
#define MAX_BLOCK_HOURS 4096u

static unsigned char inbuf[BLOCK_BYTES];
static float         slab[(unsigned)NUM * MAX_BLOCK_HOURS];

// Per-hour TOU code for this block, 0 = OffPeak, 1 = OnPeak, 0xFF = no row
// covered that hour. TOU is FILE DATA and is never recomputed from the
// calendar (footgun 17) -- the real rule is HE 6-22 Mon-Sat with Sunday
// fully OffPeak, varies by tariff, and drops holidays. It is read here
// rather than in a second JS pass purely so the block's bytes are scanned
// once; the value itself still comes from the file's own TOU column.
static unsigned char touOut[MAX_BLOCK_HOURS];

static unsigned g_rows, g_baseHour, g_maxHour, g_outOfRange, g_wideField, g_badRow, g_feb29;

__attribute__((export_name("inbuf_ptr")))     unsigned char* inbuf_ptr(void)    { return inbuf; }
__attribute__((export_name("inbuf_size")))    unsigned       inbuf_size(void)   { return BLOCK_BYTES; }
__attribute__((export_name("slab_ptr")))      float*         slab_ptr(void)     { return slab; }
__attribute__((export_name("tou_ptr")))       unsigned char* tou_ptr(void)      { return touOut; }
__attribute__((export_name("slab_hours")))    unsigned       slab_hours(void)   { return MAX_BLOCK_HOURS; }
__attribute__((export_name("slab_metrics")))  unsigned       slab_metrics(void) { return NUM; }
__attribute__((export_name("last_rows")))     unsigned       last_rows(void)    { return g_rows; }
__attribute__((export_name("last_base_hour")))unsigned       last_base_hour(void){ return g_baseHour; }
__attribute__((export_name("last_max_hour"))) unsigned       last_max_hour(void){ return g_maxHour; }
__attribute__((export_name("last_out_of_range"))) unsigned   last_out_of_range(void){ return g_outOfRange; }
// Fields past the slab's NUM columns, and rows whose Date/Hour did not
// resolve to an hour of the year. Both are silent data loss if unreported,
// which is the one failure mode this project cannot see by eye. Feb 29 is
// counted apart from them because dropping it is intended (D4) and stated,
// not a fault.
__attribute__((export_name("last_wide_field"))) unsigned     last_wide_field(void){ return g_wideField; }
__attribute__((export_name("last_bad_row")))    unsigned     last_bad_row(void)  { return g_badRow; }
__attribute__((export_name("last_feb29")))      unsigned     last_feb29(void)    { return g_feb29; }

// Cumulative days before each month, non-leap. Feb 29 is dropped at ingest
// (D4), so a leap year uses the same table and the Feb 29 rows are skipped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// f64 digit accumulation -- measured FASTER than the Eisel-Lemire u64-mantissa
// approach on wasm32 in lever-1 (130.2 ms vs 157.0 ms). Do NOT "optimize" this
// into fast_float's algorithm; it loses here.
// Exponent notation IS present in real exports -- the interface exports carry
// `2.568664E-03` and `1.338663E-04` for near-zero flows and costs, and the
// export writes tiny magnitudes that way rather than as long decimal strings.
// Returning NaN on them (as this did until T4 caught it cell-by-cell) is
// silent data loss: the cell simply reads as absent, which every kernel is
// designed to skip without complaint.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where a correctly
  // rounded strtod rounds once, and on the widest columns that shows up as a
  // 1-ulp float32 difference on a handful of cells.
  //
  // MEASURED, do not "fix" this:
  //   * Folding both parts into one f64 mantissa with a single division
  //     costs 20% throughput (204 -> 160 MiB/s) and changes none of the
  //     differing cells -- those values carry 18 significant digits, so the
  //     mantissa is inexact either way.
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

// M/D/YYYY -> day-of-year. Two distinct failure values: FEB29 for the day
// this build drops on purpose (D4), NO_DAY for a date it could not read. They
// are counted separately so "the leap day went" never looks like "the file is
// mangled", and neither looks like a clean parse.
#define FEB29  0xFFFFFFFEu
#define NO_DAY 0xFFFFFFFFu
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e) {
  unsigned month = 0, day = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  if (month < 1 || month > 12 || day < 1 || day > 31) return NO_DAY;
  if (month == 2 && day == 29) return FEB29;   // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}

__attribute__((export_name("slab_fill_nan")))
void slab_fill_nan(unsigned hours) {
  if (hours > MAX_BLOCK_HOURS) hours = MAX_BLOCK_HOURS;
  const float nan = 0.0f / 0.0f;
  unsigned n = (unsigned)NUM * hours;
  for (unsigned i = 0; i < n; i++) slab[i] = nan;
}

// Parse a block of WHOLE rows. `len` bytes in inbuf, starting at a row boundary
// and ending just after a '\n'. `baseHour` is the hour index the slab maps to
// index 0 (pass 0xFFFFFFFF to have this function take it from the first row it
// sees).
//
// Slab layout: [interface * MAX_BLOCK_HOURS + (hour - baseHour)]
// Interfaces are positional here -- source column `c` writes plane `c -
// KEY_COLS`. Production maps a plane to its cube index by TRIMMED HEADER NAME
// (footgun 18) through a JS-side plan array; different exports list different
// interfaces in different orders, so position is only ever a transport detail.
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len, unsigned baseHour) {
  const unsigned char* b = inbuf;
  unsigned col = 0, fs = 0;
  unsigned rowDay = NO_DAY, hIdx = NO_DAY, rel = 0;
  g_rows = 0; g_outOfRange = 0; g_wideField = 0; g_badRow = 0; g_feb29 = 0;
  g_baseHour = baseHour; g_maxHour = 0;
  int haveBase = (baseHour != 0xFFFFFFFFu);

  for (unsigned k = 0; k < MAX_BLOCK_HOURS; k++) touOut[k] = 0xFFu;

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
        unsigned rowHour = parse_uint(b + fs, b + e);                           \
        hIdx = NO_DAY;                                                          \
        if (rowDay == FEB29) {                                                  \
          g_feb29++;                     /* dropped on purpose (D4) */          \
        } else if (rowDay == NO_DAY || rowHour < 1 || rowHour > 24) {           \
          g_badRow++;                    /* unreadable Date or Hour */          \
        } else {                                                                \
          unsigned h = rowDay * 24u + (rowHour - 1u);                           \
          if (!haveBase) { g_baseHour = h; haveBase = 1; }                      \
          if (h < g_baseHour || h - g_baseHour >= MAX_BLOCK_HOURS) {            \
            g_outOfRange++;                                                     \
          } else {                                                              \
            hIdx = h;                                                           \
            rel = h - g_baseHour;                                               \
            if (rel > g_maxHour) g_maxHour = rel;                               \
          }                                                                     \
        }                                                                       \
      } else if (col == 2) {                                                    \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        if (hIdx != NO_DAY) {                                                   \
          touOut[rel] = (unsigned char)((e > fs + 1 && b[fs + 1] == 'n') ? 1 : 0); \
        }                                                                       \
      } else {                                                                  \
        unsigned m = col - (unsigned)KEY_COLS;                                  \
        if (m >= (unsigned)NUM) g_wideField++;                                  \
        else if (hIdx != NO_DAY) {                                              \
          slab[m * MAX_BLOCK_HOURS + rel] = parse_float(b + fs, b + e);         \
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
      if (b[pos] == '\n') { g_rows++; col = 0; rowDay = NO_DAY; hIdx = NO_DAY; }
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') {
      FIELD(i)
      fs = i + 1;
      col++;
      if (c == '\n') { g_rows++; col = 0; rowDay = NO_DAY; hIdx = NO_DAY; }
    }
  }
  #undef FIELD
  return g_rows;
}
