// src/ingest/pool.ts
//
// Worker pool, file dispatch, cube assembly.
//
// The pool's unit of work is a BYTE RANGE, not a case (D10). One dropped
// file therefore uses every core, which is the common interaction, and ten
// dropped files queue into the same pool rather than a second one. Workers
// are pre-warmed at page load because startup is ~40 ms each.
//
// Two things in here are load-bearing for correctness rather than speed:
//
//   * The cube is pre-filled with NaN. "Never written" then looks exactly
//     like "this case never exported that column" -- both NaN, both refused
//     by the presence bitmap. Leaving the allocator's zeros in place would
//     turn a truncated file into 8,760 hours of plausible zeros.
//   * Block size is derived from the file's own row length, not fixed at
//     8 MiB, so one block can never span more than block.c's 1,024-hour
//     slab window on a narrow export.

import { HOURS_PER_YEAR } from '../calendar';
import { derivedFor, requiredInputs, ruleFor } from '../rules';
import type { CaseData } from '../types';
import {
  areaHashes,
  buildColumnPlan,
  parseHeaderLine,
  unionSchema,
  SLAB_AREAS,
  type ColumnPlan,
  type HeaderInfo,
} from './header';
import type { BlockPayload } from './block';
import type { BlockMessage, BlockResult, InitMessage, WorkerResponse } from './worker';

/** D10: >= 8 MiB. 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/** Of block.c's MAX_BLOCK_HOURS = 1024, leaving headroom for row-length
 * variance. Exceeding it is caught and refused in the worker, not silently
 * dropped, but sizing blocks so it cannot happen is cheaper than the error. */
const SAFE_BLOCK_HOURS = 900;

/** Enough for the real export's 1,028 B header plus a first data row. */
const HEAD_PROBE_BYTES = 256 * 1024;

/** The whole file is read through the pool; this is only the header probe. */
const decoder = new TextDecoder();

export interface CasePlan {
  file: File;
  header: HeaderInfo;
  /** Byte offset of the first data row -- block 0 starts here, not at 0. */
  dataStart: number;
  year: number;
  bytesPerRow: number;
  /** Area names in file order -- this case's area axis, read from the file. */
  areas: string[];
}

export interface IngestResult {
  cases: CaseData[];
  /** User-facing notes: dropped Feb 29, missing weights, partial coverage. */
  warnings: string[];
}

// ---------------------------------------------------------------- feature gate

/** The wasm-feature-detect SIMD128 probe: a module whose only instruction
 * needing the proposal is `i8x16.splat`, so validation fails without it.
 * The byte sequence is load-bearing -- an earlier hand-written variant
 * declared a v128 result and then dropped it, which is a type error, so it
 * validated false everywhere and would have refused every browser. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, // magic + version
  1, 4, 1, 96, 0, 0, // type: () -> ()
  3, 2, 1, 0, // one function of that type
  10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11, // i32.const 0; i8x16.splat; drop; end
]);

/** There is no scalar JS fallback (D12): feature-detect and refuse instead. */
export function hasSimd(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
}

export const NO_SIMD_MESSAGE =
  'This tool needs WebAssembly SIMD, which has shipped in Chrome and Edge since ' +
  'version 91 (May 2021). Please open it in an up-to-date Chrome or Edge.';

// ---------------------------------------------------------------- header probe

/** Read one file's header and enough of its first row to size blocks. */
export async function readCasePlan(file: File): Promise<CasePlan> {
  const probe = new Uint8Array(await file.slice(0, HEAD_PROBE_BYTES).arrayBuffer());
  const headerEnd = probe.indexOf(10);
  if (headerEnd < 0) {
    throw new Error(`${file.name}: no line ending in the first ${HEAD_PROBE_BYTES} B.`);
  }
  const header = parseHeaderLine(decoder.decode(probe.subarray(0, headerEnd)));
  const dataStart = headerEnd + 1;

  const rowEnd = probe.indexOf(10, dataStart);
  if (rowEnd < 0) throw new Error(`${file.name}: header but no data rows.`);
  const firstRow = decoder.decode(probe.subarray(dataStart, rowEnd));

  // Date is `M/D/YYYY`, parsed as three integers -- never a Date object
  // (footgun 3: one `new Date(str)` shifts rows by a day in half the world).
  const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`${file.name}: could not read a year from the first Date field.`);
  }

  return {
    file,
    header,
    dataStart,
    year,
    bytesPerRow: rowEnd - dataStart + 1,
    areas: readAreaAxis(file.name, decoder.decode(probe.subarray(dataStart)), header.nameCol),
  };
}

/**
 * The area axis, read from the file rather than shipped with the app.
 *
 * An export is ordered (date, hour, area) with every area present in every
 * hour -- the same assumption block sizing already makes (`hourBytes =
 * bytesPerRow * SLAB_AREAS`). So the first hour's rows ARE the axis, in the
 * order the cube indexes them: read Name until it repeats.
 */
function readAreaAxis(filename: string, body: string, nameCol: number): string[] {
  const seen = new Set<string>();
  const areas: string[] = [];
  let start = 0;
  while (start < body.length) {
    const end = body.indexOf('\n', start);
    if (end < 0) break; // a partial row at the end of the probe
    const name = body.slice(start, end).split(',')[nameCol]?.trim();
    start = end + 1;
    if (!name) continue;
    if (seen.has(name)) return areas; // second hour: the axis is complete
    seen.add(name);
    areas.push(name);
  }
  if (areas.length === 0) throw new Error(`${filename}: no area names in the first rows.`);
  throw new Error(
    `${filename}: read ${areas.length} distinct area names in the first ` +
      `${HEAD_PROBE_BYTES / 1024} KB without one repeating, so the area axis could not be ` +
      'established. An export must list every area in every hour.',
  );
}

export function unionOf(plans: CasePlan[]): string[] {
  const columns = unionSchema(plans.map((p) => p.header));
  // Calculated columns are in no file's header, so they are appended here or
  // the picker never offers them.
  return [...columns, ...derivedFor(columns)];
}

// ---------------------------------------------------------------- the pool

let poolPromise: Promise<Worker[]> | null = null;
/** The axis the workers' hash tables were built from, joined. */
let poolAxis = '';

function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores, 8));
}

async function createPool(areas: string[]): Promise<Worker[]> {
  if (!hasSimd()) throw new Error(NO_SIMD_MESSAGE);

  // Compiled once on the main thread and cloned to every worker: a
  // WebAssembly.Module is structured-cloneable, so N workers cost one fetch
  // and one compile rather than N of each.
  const module = await WebAssembly.compileStreaming(fetch('./block.wasm'));
  const hashes = areaHashes(areas);

  const workers: Worker[] = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const init: InitMessage = { kind: 'init', module, areaHashes: hashes };
    await new Promise<void>((resolve, reject) => {
      const handler = (event: MessageEvent<WorkerResponse>) => {
        worker.removeEventListener('message', handler);
        if (event.data.kind === 'ready') resolve();
        else reject(new Error(`worker init failed: ${JSON.stringify(event.data)}`));
      };
      worker.addEventListener('message', handler);
      worker.postMessage(init);
    });
    workers.push(worker);
  }
  poolAxis = areas.join(',');
  return workers;
}

/**
 * The pool, built for this area axis. The workers hold a hash table of area
 * names; a file whose axis differs routes its rows into the wrong cube planes
 * unless they are rebuilt, so a changed axis takes the pool down with it.
 */
function poolFor(areas: string[]): Promise<Worker[]> {
  if (poolPromise && poolAxis === areas.join(',')) return poolPromise;
  const dying = poolPromise;
  void dying?.then((workers) => workers.forEach((worker) => worker.terminate())).catch(() => {});
  poolPromise = createPool(areas);
  return poolPromise;
}

function runBlock(worker: Worker, job: BlockMessage): Promise<BlockResult> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<WorkerResponse>) => {
      worker.removeEventListener('message', handler);
      const message = event.data;
      if (message.kind === 'done') resolve(message);
      else if (message.kind === 'error') reject(new Error(message.message));
      else reject(new Error(`unexpected worker message: ${message.kind}`));
    };
    worker.addEventListener('message', handler);
    worker.postMessage(job);
  });
}

// ---------------------------------------------------------------- cube assembly

export interface CaseAccumulator {
  plan: ColumnPlan;
  cube: Float32Array;
  /** Per-hour TOU code, 0xFF until a row covers the hour. */
  tou: Uint8Array;
  areaSeen: Uint8Array;
  hourSeen: Uint8Array;
}

export function createAccumulator(plan: ColumnPlan): CaseAccumulator {
  const cube = new Float32Array(SLAB_AREAS * plan.metrics.length * HOURS_PER_YEAR);
  // See the header comment: NaN, not zero, is the correct "no data here".
  cube.fill(NaN);
  return {
    plan,
    cube,
    tou: new Uint8Array(HOURS_PER_YEAR).fill(0xff),
    areaSeen: new Uint8Array(SLAB_AREAS),
    hourSeen: new Uint8Array(HOURS_PER_YEAR),
  };
}

/** Blit one block's slab into the cube at its own hour offset. Blocks are
 * position-independent, so this is correct in any arrival order. */
export function blitBlock(accumulator: CaseAccumulator, block: BlockPayload): void {
  const { plan, cube } = accumulator;
  const { baseHour, hours, data } = block;
  if (hours === 0) return;
  if (baseHour + hours > HOURS_PER_YEAR) {
    throw new Error(
      `Block covers hours ${baseHour}..${baseHour + hours - 1}, past the ${HOURS_PER_YEAR}-hour ` +
        `year. Feb 29 should have been dropped at parse time (D4).`,
    );
  }

  // Block boundaries land mid-row, so a block routinely starts partway
  // through an hour's 43 area-rows and ends partway through another. Those
  // two hours are NaN in this block's slab for the areas the neighbouring
  // block owns, and a straight copy would overwrite good values with NaN.
  //
  // Rows are area-fastest within (date, hour) and a block is a contiguous
  // row range, so only the FIRST and LAST hour can ever be partial: every
  // hour in between has all 43 of its rows inside this block. Copy the
  // interior with one memcpy per (plane, area) and NaN-skip only the two
  // edges.
  const numMetrics = plan.metrics.length;
  for (let p = 0; p < plan.activePlanes.length; p++) {
    const metric = plan.slabPlan[plan.activePlanes[p]];
    for (let area = 0; area < SLAB_AREAS; area++) {
      const src = (p * SLAB_AREAS + area) * hours;
      const dst = (area * numMetrics + metric) * HOURS_PER_YEAR + baseHour;

      if (hours >= 3) cube.set(data.subarray(src + 1, src + hours - 1), dst + 1);

      const first = data[src];
      if (!Number.isNaN(first)) cube[dst] = first;
      if (hours > 1) {
        const last = data[src + hours - 1];
        if (!Number.isNaN(last)) cube[dst + hours - 1] = last;
      }
    }
  }

  for (let t = 0; t < hours; t++) {
    const code = block.tou[t];
    if (code === 0xff) continue;
    accumulator.tou[baseHour + t] = code;
    accumulator.hourSeen[baseHour + t] = 1;
  }
  for (let area = 0; area < SLAB_AREAS; area++) {
    if (block.areaSeen[area]) accumulator.areaSeen[area] = 1;
  }
}

/**
 * Fill every CALCULATED column's plane from its operands, after the last block
 * has blitted. NaN propagates on its own -- an hour either operand never
 * covered stays absent rather than becoming a plausible zero.
 *
 * Per-area subtraction is sound only because both operands are same-unit
 * EXTENSIVE (see ColumnRule.derived). A per-area RATIO (`op: 'div'`) is only a
 * per-area answer; what makes it right for a grouping is the WEIGHTED_MEAN
 * rule weighted by its denominator, applied after the collapse in kernels.ts.
 * Presence follows the operands either way: a calculated column whose inputs
 * were not retained has no plane to build and stays absent, which is what the
 * pane then refuses on.
 *
 * Returns warnings about operand SIGN (the one thing about a subtraction the
 * schema cannot establish) and about zero denominators.
 */
export function applyDerived(accumulator: CaseAccumulator): string[] {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const warnings: string[] = [];

  for (let metric = 0; metric < numMetrics; metric++) {
    const derived = ruleFor(plan.metrics[metric])?.derived;
    if (!derived) continue;
    const left = plan.metrics.indexOf(derived.minuend);
    const right = plan.metrics.indexOf(derived.subtrahend);
    if (left < 0 || right < 0 || !plan.presence[left] || !plan.presence[right]) continue;

    // A subtraction only means what the column's NAME claims if both operands
    // are unsigned magnitudes. `Net Interchange` = Import - Export is net
    // imports only while Export is stored positive; if an export ever ships
    // its flows as negatives, the same subtraction silently becomes a sum of
    // magnitudes. The sign is data, so it is checked rather than assumed.
    let negativeLeft = 0;
    let negativeRight = 0;
    let zeroDenominator = 0;
    let live = 0;
    const divide = derived.op === 'div';

    for (let area = 0; area < SLAB_AREAS; area++) {
      const out = (area * numMetrics + metric) * HOURS_PER_YEAR;
      const a = (area * numMetrics + left) * HOURS_PER_YEAR;
      const b = (area * numMetrics + right) * HOURS_PER_YEAR;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        const x = cube[a + hour];
        const y = cube[b + hour];
        // A zero denominator is undefined, not infinite: x/0 would put
        // Infinity in the cube, which every downstream kernel treats as a
        // number and no NaN guard catches (footgun 21). Absent is the honest
        // read -- an area with no installed capacity has no capacity factor.
        cube[out + hour] = divide ? (y === 0 ? NaN : x / y) : x - y;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        live++;
        if (x < 0) negativeLeft++;
        if (y < 0) negativeRight++;
        if (y === 0) zeroDenominator++;
      }
    }
    plan.presence[metric] = 1;

    if (divide) {
      if (zeroDenominator > 0) {
        warnings.push(
          `"${plan.metrics[metric]}" has ${zeroDenominator.toLocaleString()} area-hour(s) where ` +
            `${derived.subtrahend} is zero; those read as no-data rather than as a ratio.`,
        );
      }
      // The sign guard below is about what a SUBTRACTION means. A ratio's
      // equivalent question is answered by the weight pairing, which
      // test_kernels.mjs asserts against the rule table.
      continue;
    }

    // A tenth, not one cell: a few negatives are ordinary (solver noise, a
    // genuinely negative net position), a systematically signed column is not.
    const threshold = live / 10;
    const signed = [
      negativeLeft > threshold ? derived.minuend : null,
      negativeRight > threshold ? derived.subtrahend : null,
    ].filter((name): name is string => name !== null);
    if (signed.length > 0) {
      warnings.push(
        `"${plan.metrics[metric]}" subtracts ${derived.subtrahend} from ${derived.minuend}, ` +
          `but ${signed.join(' and ')} ${signed.length === 1 ? 'carries' : 'carry'} negative ` +
          `values in this export — so the result is not the net figure the name implies. ` +
          `Check the export's sign convention before reading it.`,
      );
    }
  }
  return warnings;
}

export function finalizeCase(
  accumulator: CaseAccumulator,
  name: string,
  sourceColumns: string[],
  year: number,
  areas: string[],
): { data: CaseData; warnings: string[] } {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const presence = new Uint8Array(SLAB_AREAS * numMetrics);
  for (let area = 0; area < SLAB_AREAS; area++) {
    if (!accumulator.areaSeen[area]) continue;
    for (let metric = 0; metric < numMetrics; metric++) {
      presence[area * numMetrics + metric] = plan.presence[metric];
    }
  }

  const warnings: string[] = [];
  const absentMetrics = plan.metrics.filter((_, i) => !plan.presence[i]);
  if (absentMetrics.length > 0) {
    warnings.push(
      `${name}: ${absentMetrics.length} retained column(s) are not in this export ` +
        `(${absentMetrics.slice(0, 3).join(', ')}${absentMetrics.length > 3 ? ', …' : ''}).`,
    );
  }
  const missingAreas = areas.filter((_, i) => !accumulator.areaSeen[i]);
  if (missingAreas.length > 0) {
    warnings.push(`${name}: no rows for ${missingAreas.length} area(s): ${missingAreas.join(', ')}.`);
  }
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  if (covered < HOURS_PER_YEAR) {
    warnings.push(
      `${name}: covers ${covered.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} hours; ` +
        `the rest read as no-data.`,
    );
  }
  // D4, and it must be stated rather than silent.
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
    warnings.push(`${name}: ${year} is a leap year — Feb 29 was dropped at ingest (D4).`);
  }

  return {
    data: {
      name,
      cube,
      areas,
      metrics: plan.metrics,
      presence,
      tou: accumulator.tou,
      sourceColumns,
      year,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- ingest

function blocksFor(
  plan: CasePlan,
  caseIndex: number,
  activePlanes: Int32Array,
  nextId: () => number,
): BlockMessage[] {
  // A block must never span more hours than block.c's slab window, and row
  // length varies 20x between a 5-column sample and the 54-column export, so
  // the bound comes from this file's own rows rather than a constant.
  const hourBytes = plan.bytesPerRow * SLAB_AREAS;
  const blockBytes = Math.max(
    plan.bytesPerRow * SLAB_AREAS,
    Math.min(BLOCK_TARGET_BYTES, SAFE_BLOCK_HOURS * hourBytes),
  );

  const jobs: BlockMessage[] = [];
  for (let start = plan.dataStart; start < plan.file.size; start += blockBytes) {
    jobs.push({
      kind: 'block',
      blockId: nextId(),
      caseIndex,
      file: plan.file,
      start,
      end: Math.min(start + blockBytes, plan.file.size),
      skipPartialFirstRow: start !== plan.dataStart,
      activePlanes,
    });
  }
  return jobs;
}

/**
 * Parse every plan into its own cube. `retained` defines the cube's metric
 * axis; the caller gets it from the picker, or passes the union schema for
 * "everything".
 */
export async function ingest(
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<IngestResult> {
  if (plans.length === 0) return { cases: [], warnings: [] };

  // The axis comes from the files themselves. Every case in one drop has to
  // agree on it, because one cube layout is shared by all of them and an area
  // index means the same thing in each.
  const areas = plans[0].areas;
  if (areas.length !== SLAB_AREAS) {
    throw new Error(
      `${plans[0].file.name} has ${areas.length} areas per hour but parser/block.c is built ` +
        `for ${SLAB_AREAS}. Rebuild the parser with a matching NUM_AREAS.`,
    );
  }
  for (const plan of plans.slice(1)) {
    if (plan.areas.join(',') !== areas.join(',')) {
      throw new Error(
        `${plan.file.name} lists a different set or order of areas than ` +
          `${plans[0].file.name}. Load exports that share an area axis, or load them ` +
          'separately.',
      );
    }
  }

  // Exactly the columns that were picked. A weight the selection needs but
  // does not include is reported, not smuggled in: the multi-area series that
  // depends on it refuses to draw later (footgun 20), which is the honest
  // outcome of the choice rather than a silent 35 MB per case per column.
  const metrics = retained.map((name) => name.trim());
  const warnings: string[] = [];
  const kept = new Set(metrics);
  for (const name of requiredInputs(metrics)) {
    if (kept.has(name)) continue;
    warnings.push(
      `"${name}" was not retained. Columns weighted by it can only be plotted for a single ` +
        `area, and calculated columns that subtract it cannot be built at all. Re-ingest ` +
        `with it kept.`,
    );
  }

  const columnPlans = plans.map((plan) => buildColumnPlan(plan.header, metrics));
  const accumulators = columnPlans.map(createAccumulator);

  let id = 0;
  const jobs: BlockMessage[] = [];
  plans.forEach((plan, index) => {
    jobs.push(...blocksFor(plan, index, columnPlans[index].activePlanes, () => id++));
  });

  const workers = await poolFor(areas);
  let done = 0;
  let next = 0;
  await Promise.all(
    workers.map(async (worker) => {
      for (;;) {
        const index = next++;
        if (index >= jobs.length) return;
        const job = jobs[index];
        const result = await runBlock(worker, job);
        blitBlock(accumulators[job.caseIndex], result);
        onProgress?.(++done, jobs.length);
      }
    }),
  );

  const cases: CaseData[] = [];
  accumulators.forEach((accumulator, index) => {
    const plan = plans[index];
    // After every block, before presence is read: a calculated column's plane
    // needs its operands complete across the whole year, and finalizeCase is
    // what turns plan.presence into the per-(area, metric) bitmap.
    warnings.push(...applyDerived(accumulator));
    const finalized = finalizeCase(
      accumulator,
      plan.file.name,
      plan.header.metricNames,
      plan.year,
      areas,
    );
    cases.push(finalized.data);
    warnings.push(...finalized.warnings);
  });

  return { cases, warnings };
}
