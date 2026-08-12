// The WASM CSV parser for GridView MONITORED-INTERFACE exports.
//
// Shape of the input:
//
//   line 1   Interface Hourly 'Power Flow (MW)' Data for Year 2034
//   line 2   (blank)
//   line 3   (From the first hour of 1/1/2034 ... Column identifier -- InterfaceName)
//   line 4   (blank)
//   line 5   Date, Hour, TOU,<interface 1>,<interface 2>,...
//   line 6+  one row per HOUR
//
// The four preamble lines and the header are consumed on the JS side; this
// module only ever sees whole DATA rows. Four invariants:
//
// 1. MEMORY. Every Worker needs its own WASM instance, so per-instance memory
//    must be a function of BLOCK size, never of case size: 12 MiB input
//    window + an 8 MiB slab.
// 2. BLOCK INDEPENDENCE. Each row's hour comes from its OWN Date and
//    Hour fields, never from a running row counter, so a worker needs its
//    bytes and not its position and blocks may be parsed in any order.
// 3. ONE ROW = ONE HOUR. Every interface is a column, so a row is a complete
//    hour and no hour is ever split across two blocks.
// 4. ROW ORDER DOES NOT MATTER. Output is a ROW LIST: slab column `r` holds
//    row `r`'s values and rowHour[r] says which hour of the year that row
//    lands on. The main thread scatters it. Nothing here assumes rows arrive
//    sorted, inside a block or across blocks.
//
// (4) replaced an hour-windowed slab indexed by `hour - baseHour`, where
// baseHour came from the block's FIRST row. Rows out of order within a block
// were placed correctly, but any row EARLIER than its block's first row fell
// outside the window and the whole load was refused -- so a value-sorted or
// descending export could not be loaded at all, and the error blamed block
// sizing. The slab is still [NUM x 4096] and still 8 MiB; only what a column
// means has changed.
//
// Build: ./build.sh

#include <wasm_simd128.h>

// Interface columns per export. The reference exports carry 167; 512 leaves
// room for a wider study without another rebuild, and costs 8 MiB of slab at
// MAX_BLOCK_ROWS. A file with more columns than this is REFUSED on the JS
// side (last_wide_field), never silently truncated.
#define NUM             512
#define KEY_COLS        3           // Date, Hour, TOU
#define BLOCK_BYTES     (12u * 1024u * 1024u)
// Rows one block may hold. One row is one hour, so this is the same 8 MiB the
// hour-windowed slab cost. Blocks are sized on the JS side from the file's own
// row length so this is never reached; reaching it is counted and refused
// rather than wrapped.
#define MAX_BLOCK_ROWS  4096u

// Bumped on any change to the exported surface or the slab's meaning.
// block.wasm is committed, so a stale binary against updated TypeScript has to
// fail at instantiate rather than produce a wrong number at parse time. v2 is
// the row list; v1 was the hour-windowed slab.
#define ABI_VERSION     2u

static unsigned char inbuf[BLOCK_BYTES];
// slab[m * MAX_BLOCK_ROWS + r] -- PLANE-major, so lifting one interface's
// values for the whole block stays a contiguous copy on the JS side. Row-major
// would make that a strided gather for no gain: the scatter into the cube is
// per cell either way.
static float         slab[(unsigned)NUM * MAX_BLOCK_ROWS];

// Where each emitted row lands: hour of the year, 0..8759. Every row carries
// its own placement, which is the whole of invariant 4.
static unsigned short rowHour[MAX_BLOCK_ROWS];

// Per-ROW TOU code, 0 = OffPeak, 1 = OnPeak. TOU is FILE DATA and is never
// recomputed from the calendar (footgun 17) -- the real rule is HE 6-22
// Mon-Sat with Sunday fully OffPeak, varies by tariff, and drops holidays. It
// is read here rather than in a second JS pass purely so the block's bytes are
// scanned once; the value itself still comes from the file's own TOU column.
static unsigned char rowTou[MAX_BLOCK_ROWS];

static unsigned g_rows, g_overflow, g_wideField, g_badRow, g_feb29, g_yearMismatch;

__attribute__((export_name("inbuf_ptr")))     unsigned char* inbuf_ptr(void)    { return inbuf; }
__attribute__((export_name("inbuf_size")))    unsigned       inbuf_size(void)   { return BLOCK_BYTES; }
__attribute__((export_name("slab_ptr")))      float*         slab_ptr(void)     { return slab; }
__attribute__((export_name("row_hour_ptr")))  unsigned short* row_hour_ptr(void){ return rowHour; }
__attribute__((export_name("row_tou_ptr")))   unsigned char* row_tou_ptr(void)  { return rowTou; }
__attribute__((export_name("slab_rows")))     unsigned       slab_rows(void)    { return MAX_BLOCK_ROWS; }
__attribute__((export_name("slab_metrics")))  unsigned       slab_metrics(void) { return NUM; }
__attribute__((export_name("abi_version")))   unsigned       abi_version(void)  { return ABI_VERSION; }
__attribute__((export_name("last_rows")))     unsigned       last_rows(void)    { return g_rows; }
// Rows past MAX_BLOCK_ROWS: the block held more rows than the slab has
// columns. JS sizes blocks to make this unreachable and shrinks them if it
// happens anyway, so this is a backstop, never a normal outcome.
__attribute__((export_name("last_overflow")))   unsigned     last_overflow(void){ return g_overflow; }
// Fields past the slab's NUM columns, and rows whose Date/Hour did not
// resolve to an hour of the year. Both are silent data loss if unreported,
// which is the one failure mode this project cannot see by eye. Feb 29 is
// counted apart from them because dropping it is intended and stated, not a
// fault.
__attribute__((export_name("last_wide_field"))) unsigned     last_wide_field(void){ return g_wideField; }
__attribute__((export_name("last_bad_row")))    unsigned     last_bad_row(void)  { return g_badRow; }
__attribute__((export_name("last_feb29")))      unsigned     last_feb29(void)    { return g_feb29; }
// Rows whose Date carries a year other than the one JS read from the file's
// first data row. date_to_day deliberately ignores the year -- it maps M/D to
// a day of THE case's year -- so without this a file holding two years would
// fold both onto the same 8,760 hours. With rows in file order that shows up
// as duplicate hours; shuffled, it need not. Counted here, refused by JS.
__attribute__((export_name("last_year_mismatch"))) unsigned  last_year_mismatch(void){ return g_yearMismatch; }

// Cumulative days before each month, non-leap. Feb 29 is dropped at ingest
// so a leap year uses the same table and the Feb 29 rows are skipped.
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
  //   * Eisel-Lemire is already refuted for wasm32 here.
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

// M/D/YYYY -> day-of-year, with the YEAR handed back through `yearOut` so the
// caller can check every row belongs to the same year. Two distinct failure
// values: FEB29 for the day this build drops on purpose (D4), NO_DAY for a
// date it could not read. They are counted separately so "the leap day went"
// never looks like "the file is mangled", and neither looks like a clean
// parse.
#define FEB29  0xFFFFFFFEu
#define NO_DAY 0xFFFFFFFFu
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e,
                                   unsigned* yearOut) {
  unsigned month = 0, day = 0, year = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    year = year * 10u + d;
    p++;
  }
  *yearOut = year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return NO_DAY;
  if (month == 2 && day == 29) return FEB29;   // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}

/**
 * NaN-fill the value columns for `rows` rows.
 *
 * Still necessary with a row list: a row carrying fewer fields than the header
 * leaves the planes past its last field untouched, and a stale float from the
 * previous block is a plausible-looking wrong number -- precisely the failure
 * this project cannot see by eye. The fill is plane-strided because the slab
 * is plane-major.
 */
__attribute__((export_name("slab_fill_nan")))
void slab_fill_nan(unsigned rows) {
  if (rows > MAX_BLOCK_ROWS) rows = MAX_BLOCK_ROWS;
  const float nan = 0.0f / 0.0f;
  for (unsigned m = 0; m < (unsigned)NUM; m++) {
    float* column = slab + m * MAX_BLOCK_ROWS;
    for (unsigned r = 0; r < rows; r++) column[r] = nan;
  }
}

// Parse a block of WHOLE rows. `len` bytes in inbuf, starting at a row boundary
// and ending just after a '\n'. `year` is the case's year, read by JS from the
// file's first data row; every row's own year is checked against it.
//
// Slab layout: [interface * MAX_BLOCK_ROWS + row], with rowHour[row] carrying
// where that row belongs. Rows are emitted in the order they appear in the
// bytes, which is not necessarily hour order and does not need to be.
//
// Interfaces are positional here -- source column `c` writes plane `c -
// KEY_COLS`. Production maps a plane to its cube index by TRIMMED HEADER NAME
// (footgun 18) through a JS-side plan array; different exports list different
// interfaces in different orders, so position is only ever a transport detail.
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len, unsigned year) {
  const unsigned char* b = inbuf;
  unsigned col = 0, fs = 0;
  unsigned rowDay = NO_DAY, rowYear = 0;
  // Slot this row will occupy, or NO_DAY while the row is being rejected.
  unsigned slot = NO_DAY;
  g_rows = 0; g_overflow = 0; g_wideField = 0; g_badRow = 0; g_feb29 = 0;
  g_yearMismatch = 0;

  const v128_t vcomma = wasm_i8x16_splat(',');
  const v128_t vnl    = wasm_i8x16_splat('\n');
  unsigned i = 0;

  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0) {                                                           \
        rowDay = date_to_day(b + fs, b + e, &rowYear);                          \
      } else if (col == 1) {                                                    \
        unsigned hourOfDay = parse_uint(b + fs, b + e);                         \
        slot = NO_DAY;                                                          \
        if (rowDay == FEB29) {                                                  \
          g_feb29++;                     /* dropped on purpose (D4) */          \
        } else if (rowDay == NO_DAY || hourOfDay < 1 || hourOfDay > 24) {       \
          g_badRow++;                    /* unreadable Date or Hour */          \
        } else if (rowYear != year) {                                           \
          g_yearMismatch++;              /* a second year in one case */        \
        } else if (g_rows >= MAX_BLOCK_ROWS) {                                  \
          g_overflow++;                  /* more rows than the slab holds */    \
        } else {                                                                \
          slot = g_rows++;                                                      \
          rowHour[slot] = (unsigned short)(rowDay * 24u + (hourOfDay - 1u));    \
          rowTou[slot] = 0;                                                     \
        }                                                                       \
      } else if (col == 2) {                                                    \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        if (slot != NO_DAY) {                                                   \
          rowTou[slot] = (unsigned char)((e > fs + 1 && b[fs + 1] == 'n') ? 1 : 0); \
        }                                                                       \
      } else {                                                                  \
        unsigned m = col - (unsigned)KEY_COLS;                                  \
        if (m >= (unsigned)NUM) g_wideField++;                                  \
        else if (slot != NO_DAY) {                                              \
          slab[m * MAX_BLOCK_ROWS + slot] = parse_float(b + fs, b + e);         \
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
      /* g_rows counts EMITTED rows and is advanced when a slot is claimed, so
         a newline only resets the per-row state. */
      if (b[pos] == '\n') { col = 0; rowDay = NO_DAY; slot = NO_DAY; }
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') {
      FIELD(i)
      fs = i + 1;
      col++;
      if (c == '\n') { col = 0; rowDay = NO_DAY; slot = NO_DAY; }
    }
  }
  #undef FIELD
  return g_rows;
}
