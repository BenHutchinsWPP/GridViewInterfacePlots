// test_fixtures.mjs
//
// Synthetic test data, generated in memory. Nothing here comes from a real
// study: the interface names, the values and the calendar are invented, and
// only the FORMAT is copied from GridView's exporter.
//
// The synthetic export is not decorative. It has to reproduce every property
// the ingest tests actually gate on, because a fixture that quietly loses one
// turns a real parser bug into a passing run:
//
//   * The four preamble lines and a header on line 5.
//   * A title line naming a quoted quantity and a year — the file's unit and
//     its aggregation rule are read from there and nowhere else.
//   * CRLF throughout, so the last-column trailing-\r trap is exercised
//     (footgun 16). The last numeric column is populated in every row, or the
//     check that covers that trap compares nothing and passes vacuously.
//   * Exponent notation, which is in the real exports (`2.568664E-03`) and
//     parsed to NaN for a whole build before the parity test caught it.
//   * Both TOU labels, since TOU is read from the file and never recomputed
//     (footgun 17).
//   * Interface names with spaces, hyphens, plus signs and doubled
//     underscores — the real ones have all of these, and they must survive a
//     trim and an exact-name match without being "cleaned up".
//   * Optionally Feb 29, so the D4 drop has something to fire on.

/** Interface names in the shapes the real exports use. Invented; the shapes
 * are what matters -- a name with a comma would be a different problem and
 * GridView does not emit one. */
const NAME_SHAPES = [
  (i) => `P${String(i).padStart(2, '0')} Alpha Beta ${i % 2 ? 'N-S' : 'E-W'}`,
  (i) => `W${String(i).padStart(2, '0')}_AA_ONE__BB_TWO_1`,
  (i) => `Pth ${String(i).padStart(2, '0')} Gamma - Delta`,
  (i) => `AA${String(i).padStart(2, '0')}_Epsilon+`,
];

/** `count` distinct interface names. Distinctness matters: columns map by
 * trimmed name, and a duplicate would double-write one cube plane. */
export function interfaceNames(count = 12) {
  return Array.from({ length: count }, (_, i) => NAME_SHAPES[i % NAME_SHAPES.length](i + 1));
}

/** Deterministic; a fixture that changes between runs cannot be compared
 * against anything. Mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Non-leap month lengths. Feb 29 is emitted only when asked for, and then
 * only to prove ingest drops it (D4). */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function preamble(quantity, year) {
  return [
    `Interface Hourly '${quantity}' Data for Year ${year}`,
    '',
    `(From the first hour of 1/1/${year} to the last hour of 12/31/${year}. Column identifier -- InterfaceName)`,
    '',
  ];
}

function headerLine(names) {
  // The real header carries a stray leading space on Hour and TOU, and some
  // interface names arrive padded. Columns map by trimmed name precisely so
  // this is harmless -- keep it, or the test stops proving that.
  return ['Date', ' Hour', ' TOU', ...names.map((n, i) => (i % 5 === 2 ? ` ${n}` : n))].join(',');
}

/**
 * Emit the export row by row. `days` calendar days from Jan 1, `hours` of
 * hour-ending 1..24 within each -- block.c rejects an Hour outside that range,
 * so a longer file has to advance the DATE, not the hour.
 */
function* rows({ year, days, hours, seed, names, quantity, feb29 }) {
  const next = rng(seed);
  for (const line of preamble(quantity, year)) yield line;
  yield headerLine(names);

  let month = 1;
  let day = 1;
  for (let d = 0; d < days; d++) {
    for (let hour = 1; hour <= hours; hour++) {
      const tou = hour % 2 === 0 ? 'OnPeak' : 'OffPeak';
      const fields = [`${month}/${day}/${year}`, String(hour), tou];
      for (let m = 0; m < names.length; m++) fields.push(value(next, m));
      yield fields.join(',');
    }
    // Feb 29, when asked for: the rows exist in the file and must not exist
    // in the cube (D4).
    if (feb29 && month === 2 && day === 28) {
      for (let hour = 1; hour <= hours; hour++) {
        const fields = [`2/29/${year}`, String(hour), 'OffPeak'];
        for (let m = 0; m < names.length; m++) fields.push(value(next, m));
        yield fields.join(',');
      }
    }
    if (++day > MONTH_LENGTHS[month - 1]) {
      day = 1;
      month++;
    }
  }
}

/**
 * One synthetic export as raw bytes. Small by default — the ingest tests want
 * a couple of days, not a year.
 */
export function exportCsv({
  year = 2036,
  days = 1,
  hours = 2,
  seed = 12345,
  names = interfaceNames(),
  quantity = 'Power Flow (MW)',
  feb29 = false,
} = {}) {
  // CRLF throughout, including a terminator on the final row.
  return new TextEncoder().encode(
    [...rows({ year, days, hours, seed, names, quantity, feb29 })].join('\r\n') + '\r\n',
  );
}

/**
 * Stream a full-size export to `path`. A year of 167 interfaces is ~13 MB —
 * still joinable as one string, but the tests that want a year want it on
 * disk, and streaming keeps the generator honest at any width.
 */
export async function writeExportCsv(path, options = {}) {
  const { createWriteStream } = await import('node:fs');
  const { once } = await import('node:events');
  const settings = {
    year: 2036,
    days: 365,
    hours: 24,
    seed: 12345,
    names: interfaceNames(),
    quantity: 'Power Flow (MW)',
    feb29: false,
    ...options,
  };
  const out = createWriteStream(path);
  let chunk = '';
  for (const row of rows(settings)) {
    chunk += row + '\r\n';
    if (chunk.length > 1 << 20) {
      if (!out.write(chunk)) await once(out, 'drain');
      chunk = '';
    }
  }
  if (chunk) out.write(chunk);
  out.end();
  await once(out, 'finish');
  return path;
}

/** One field. The shapes are chosen to cover what block.c's number parser has
 * to survive, not to look like plausible power-system output. */
function value(next, index) {
  const r = next();
  if (index % 17 === 5) return '0';
  // Exponent notation -- real exports carry `2.568664E-03` for near-zero
  // flows, and it parsed to NaN for a whole build.
  if (index % 23 === 7) return `${(r * 9 + 1).toFixed(6)}E-03`;
  // Flows are signed: a path runs both ways and the sign is the direction.
  if (index % 3 === 2) return (-r * 2000).toFixed(6);
  // Eight significant digits: the shape that makes block.c's two-step rounding
  // differ from strtod by under one ulp on a handful of cells.
  if (index % 13 === 4) return (r * 100000).toFixed(8);
  return (r * 500).toFixed(6);
}
