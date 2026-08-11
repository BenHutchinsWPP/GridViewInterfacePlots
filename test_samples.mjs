// test_samples.mjs — the same ingest checks, against the sample exports.
//
// test_ingest.mjs proves the parser against a synthetic file whose shape this
// repo controls. This script runs the same comparison against the anonymised
// sample exports in input/, which this repo does NOT control: real column
// counts, real name shapes, real number formats, real file sizes.
//
// It is skipped, not failed, when input/ holds no CSVs — a clone that carries
// no samples still runs the full suite.
//
// Nothing here prints a data row. Cell counts, hour counts and timings only
// (CLAUDE.md: aggregate statistics and timings are fine).
//
// Run:  node test_samples.mjs

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import './test_loader.mjs';

const { buildColumnPlan, dayOfYear, KEY_COLS, PREAMBLE_LINES } = await import(
  './src/ingest/header.ts'
);
const { instantiateParser, parseBytes, afterNextNewline } = await import('./src/ingest/block.ts');
const { createAccumulator, blitBlock, finalizeCase, readCasePlan, unionOf, coverageOf } =
  await import('./src/ingest/pool.ts');
const { HOURS_PER_YEAR } = await import('./src/calendar.ts');
const { totalIsMeaningful, unitOf } = await import('./src/rules.ts');

const HOURS = HOURS_PER_YEAR;
const decoder = new TextDecoder();
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const inputDir = fileURLToPath(new URL('./input/', import.meta.url));
let files = [];
try {
  files = readdirSync(inputDir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort();
} catch {
  files = [];
}
if (files.length === 0) {
  console.log('skip - no CSV exports in input/; the synthetic suite covers the parser');
  process.exit(0);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('./parser/block.wasm', import.meta.url)),
);
const parser = await instantiateParser(wasmModule);

/** Independent parser: strings, split, parseFloat. Deliberately naive. */
function referenceCube(text, retained) {
  const lines = text.split('\n');
  const header = lines[PREAMBLE_LINES]
    .replace(/\r$/, '')
    .split(',')
    .map((s) => s.trim());
  const dest = new Map();
  retained.forEach((name, index) => dest.set(name, index));

  const cube = new Float32Array(retained.length * HOURS).fill(NaN);
  let rows = 0;
  for (let i = PREAMBLE_LINES + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.length === 0) continue;
    const fields = line.split(',');
    const [month, day] = fields[0].split('/').map(Number);
    const doy = dayOfYear(month, day);
    if (doy < 0) continue;
    const hour = doy * 24 + (Number(fields[1]) - 1);
    rows++;
    for (let col = KEY_COLS; col < fields.length; col++) {
      const column = dest.get(header[col]);
      if (column === undefined) continue;
      cube[column * HOURS + hour] = parseFloat(fields[col]);
    }
  }
  return { cube, rows };
}

/** 2^-23: one float32 ulp, the precision the cube stores at. */
const F32_ULP_RELATIVE = 1.1920929e-7;

const plans = [];
for (const name of files) {
  const bytes = readFileSync(inputDir + name);
  plans.push(await readCasePlan(new File([bytes], name)));
}

for (const [index, name] of files.entries()) {
  const plan = plans[index];
  const bytes = new Uint8Array(readFileSync(inputDir + name));
  const columns = plan.header.interfaceNames;

  // Block boundaries at the size the pool would choose for this row length.
  const blockBytes = Math.min(8 * 1024 * 1024, 3686 * plan.bytesPerRow);
  const columnPlan = buildColumnPlan(plan.header, columns);
  const accumulator = createAccumulator(columnPlan);

  const started = performance.now();
  const ranges = [];
  for (let start = plan.dataStart; start < bytes.length; start += blockBytes) {
    const from = start === plan.dataStart ? plan.dataStart : afterNextNewline(bytes, start);
    if (from < 0) continue;
    let to = afterNextNewline(bytes, Math.min(start + blockBytes, bytes.length));
    if (to < 0) to = bytes.length;
    if (to > from) ranges.push([from, to]);
  }
  let rows = 0;
  for (const [from, to] of ranges) {
    const payload = parseBytes(parser, bytes, from, to, columnPlan.activePlanes);
    rows += payload.rows;
    blitBlock(accumulator, payload);
  }
  const elapsed = performance.now() - started;

  const finalized = finalizeCase(accumulator, name, columns, plan.year, plan.title);
  let covered = 0;
  for (let hour = 0; hour < HOURS; hour++) covered += accumulator.hourSeen[hour];

  const megabytes = statSync(inputDir + name).size / (1024 * 1024);
  ok(
    `${name}: ${columns.length} interfaces × ${covered.toLocaleString()} h from ` +
      `${rows.toLocaleString()} rows in ${ranges.length} block(s), ` +
      `${megabytes.toFixed(1)} MB in ${elapsed.toFixed(0)} ms ` +
      `(${(megabytes / (elapsed / 1000)).toFixed(0)} MB/s, single-threaded)`,
  );

  assert.equal(finalized.data.interfaces.length, columns.length);
  assert.ok(plan.title.quantity.length > 0, `${name}: the title line must name a quantity`);
  assert.ok(finalized.data.unit.length > 0, `${name}: the quantity must carry a unit`);
  assert.equal(covered, HOURS, `${name}: a full year must cover every hour`);

  // Cell-by-cell against the naive reference, over every retained column.
  const { cube: expected, rows: referenceRows } = referenceCube(decoder.decode(bytes), columns);
  assert.equal(rows, referenceRows, `${name}: both parsers must see the same row count`);

  let live = 0;
  let withinOneUlp = 0;
  let beyond = 0;
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i];
    const b = accumulator.cube[i];
    if (Number.isNaN(a)) {
      assert.ok(Number.isNaN(b), `${name}: cell ${i} absent in the reference but ${b} in the parser`);
      continue;
    }
    live++;
    if (a === b) continue;
    const relative = Math.abs(a - b) / Math.max(Math.abs(a), 1e-30);
    if (relative <= F32_ULP_RELATIVE) {
      withinOneUlp++;
      if (relative > worst) worst = relative;
      continue;
    }
    beyond++;
    if (beyond < 4) {
      console.error(
        `  ${name}: column ${Math.floor(i / HOURS)}, hour ${i % HOURS} differs by ${relative}`,
      );
    }
  }
  assert.equal(beyond, 0, `${name}: no cell may differ by more than one float32 ulp`);
  ok(
    `${name}: ${live.toLocaleString()} cells match the JS reference ` +
      `(${withinOneUlp} within 1 ulp, worst ${worst === 0 ? 'exact' : worst.toExponential(2)})`,
  );
}

// Across the whole drop: the union axis and the coverage map the picker opens
// with. Sample exports of the same study monitor the same paths, so this is
// mostly a statement that they do — and it would catch the day they stop.
{
  const union = unionOf(plans);
  const coverage = coverageOf(plans);
  const everywhere = union.filter((name) => (coverage.get(name)?.length ?? 0) === plans.length);
  ok(
    `${plans.length} sample file(s): ${union.length} interfaces in the union, ` +
      `${everywhere.length} of them in every file`,
  );

  const quantities = [...new Set(plans.map((plan) => plan.title.quantity))];
  const summable = quantities.filter((quantity) => totalIsMeaningful(unitOf(quantity)));
  ok(
    `quantities present: ${quantities.join(', ')} — ` +
      `${summable.length} of ${quantities.length} may be totalled over time`,
  );
}

console.log(`\n${checks} checks passed.`);
