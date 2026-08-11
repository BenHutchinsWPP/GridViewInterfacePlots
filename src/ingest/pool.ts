// src/ingest/pool.ts
//
// Worker pool, file dispatch, cube assembly.
//
// The pool's unit of work is a BYTE RANGE, not a case (D10). One dropped
// file therefore uses every core, which is the common interaction, and ten
// dropped files queue into the same pool rather than a second one.
//
// Two things in here are load-bearing for correctness rather than speed:
//
//   * The cube is pre-filled with NaN. "Never written" then looks exactly
//     like "this file never carried that interface" -- both NaN, both refused
//     by the presence bitmap. Leaving the allocator's zeros in place would
//     turn a truncated file into 8,760 hours of plausible zeros.
//   * Block size is derived from the file's own row length, not fixed at
//     8 MiB, so one block can never span more than block.c's slab window on a
//     narrow export.

import { HOURS_PER_YEAR } from '../calendar';
import { unitOf } from '../rules';
import type { CaseData } from '../types';
import {
  buildColumnPlan,
  parseHeaderLine,
  parseTitleLine,
  unionSchema,
  PREAMBLE_LINES,
  type ColumnPlan,
  type HeaderInfo,
  type TitleInfo,
} from './header';
import { MAX_BLOCK_HOURS, NEWLINE, type BlockPayload } from './block';
import type { BlockMessage, BlockResult, InitMessage, WorkerResponse } from './worker';

/** D10: >= 8 MiB. 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/** Of block.c's MAX_BLOCK_HOURS, leaving headroom for row-length variance.
 * Exceeding it is caught and refused in the worker, not silently dropped, but
 * sizing blocks so it cannot happen is cheaper than the error. */
const SAFE_BLOCK_HOURS = Math.floor(MAX_BLOCK_HOURS * 0.9);

/** Enough for the four preamble lines, a ~4 KB header and a first data row. */
const HEAD_PROBE_BYTES = 256 * 1024;

/** The whole file is read through the pool; this is only the header probe. */
const decoder = new TextDecoder();

export interface CasePlan {
  file: File;
  header: HeaderInfo;
  /** What the title line says this file measures. */
  title: TitleInfo;
  /** Byte offset of the first data row -- block 0 starts here, not at 0. */
  dataStart: number;
  year: number;
  bytesPerRow: number;
}

export interface IngestResult {
  cases: CaseData[];
  /** User-facing notes: dropped Feb 29, absent columns, partial coverage. */
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

/** Byte offset just past the `n`-th newline in `bytes`, or -1. */
function skipLines(bytes: Uint8Array, n: number): number {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = bytes.indexOf(NEWLINE, at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
}

/** The case label: the file name without its extension. */
export function caseNameOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

/**
 * Read one file's preamble, header, and enough of its first row to size
 * blocks.
 *
 * The header is line 5, under four preamble lines (PREAMBLE_LINES). Those
 * lines are not skipped by "keep reading until something parses as a header":
 * a title line happens to contain commas, so a tolerant scan would happily
 * accept `Interface Hourly 'Power Flow (MW)' Data for Year 2034` as a
 * three-column header and then fail somewhere less obvious.
 */
export async function readCasePlan(file: File): Promise<CasePlan> {
  const probe = new Uint8Array(await file.slice(0, HEAD_PROBE_BYTES).arrayBuffer());

  const titleEnd = probe.indexOf(NEWLINE);
  if (titleEnd < 0) {
    throw new Error(`${file.name}: no line ending in the first ${HEAD_PROBE_BYTES} B.`);
  }
  const title = parseTitleLine(decoder.decode(probe.subarray(0, titleEnd)));

  const headerStart = skipLines(probe, PREAMBLE_LINES);
  if (headerStart < 0) {
    throw new Error(
      `${file.name}: fewer than ${PREAMBLE_LINES + 1} lines — a GridView interface export ` +
        `opens with ${PREAMBLE_LINES} preamble lines and carries its column header on line ` +
        `${PREAMBLE_LINES + 1}.`,
    );
  }
  const headerEnd = probe.indexOf(NEWLINE, headerStart);
  if (headerEnd < 0) {
    throw new Error(`${file.name}: no column header within the first ${HEAD_PROBE_BYTES} B.`);
  }
  const header = parseHeaderLine(decoder.decode(probe.subarray(headerStart, headerEnd)));
  const dataStart = headerEnd + 1;

  const rowEnd = probe.indexOf(NEWLINE, dataStart);
  if (rowEnd < 0) throw new Error(`${file.name}: header but no data rows.`);
  const firstRow = decoder.decode(probe.subarray(dataStart, rowEnd));

  // Date is `M/D/YYYY`, parsed as three integers -- never a Date object
  // (footgun 3: one `new Date(str)` shifts rows by a day in half the world).
  const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`${file.name}: could not read a year from the first Date field.`);
  }

  return { file, header, title, dataStart, year, bytesPerRow: rowEnd - dataStart + 1 };
}

/** Every interface any dropped file carries, in first-seen order (D14). */
export function unionOf(plans: CasePlan[]): string[] {
  return unionSchema(plans.map((p) => p.header));
}

/** Which of `plans` carries each interface -- what the picker shows next to a
 * column that only some files have. */
export function coverageOf(plans: CasePlan[]): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const plan of plans) {
    const name = caseNameOf(plan.file.name);
    for (const column of plan.header.interfaceNames) {
      const seen = coverage.get(column);
      if (seen) seen.push(name);
      else coverage.set(column, [name]);
    }
  }
  return coverage;
}

// ---------------------------------------------------------------- the pool

let poolPromise: Promise<Worker[]> | null = null;

function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores, 8));
}

async function createPool(): Promise<Worker[]> {
  if (!hasSimd()) throw new Error(NO_SIMD_MESSAGE);

  // Compiled once on the main thread and cloned to every worker: a
  // WebAssembly.Module is structured-cloneable, so N workers cost one fetch
  // and one compile rather than N of each.
  const module = await WebAssembly.compileStreaming(fetch('./block.wasm'));

  const workers: Worker[] = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const init: InitMessage = { kind: 'init', module };
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
  return workers;
}

/**
 * The pool. Workers hold no per-study state at all now that interfaces are
 * columns -- a plane is located by the JS-side column plan, not by a hash
 * table inside the module -- so one pool serves every file for the life of
 * the page and can be warmed before anything is dropped.
 */
export function warmPool(): void {
  if (!poolPromise && hasSimd()) poolPromise = createPool();
}

function pool(): Promise<Worker[]> {
  if (!poolPromise) poolPromise = createPool();
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
  hourSeen: Uint8Array;
  /** Feb 29 rows the parser dropped (D4). */
  feb29: number;
}

export function createAccumulator(plan: ColumnPlan): CaseAccumulator {
  const cube = new Float32Array(plan.interfaces.length * HOURS_PER_YEAR);
  // See the header comment: NaN, not zero, is the correct "no data here".
  cube.fill(NaN);
  return {
    plan,
    cube,
    tou: new Uint8Array(HOURS_PER_YEAR).fill(0xff),
    hourSeen: new Uint8Array(HOURS_PER_YEAR),
    feb29: 0,
  };
}

/**
 * Blit one block's slab into the cube at its own hour offset. Blocks are
 * position-independent, so this is correct in any arrival order.
 *
 * One row is one whole hour in this format, and a block is widened to whole
 * rows before it is parsed, so no hour is ever split between two blocks and
 * this is a straight copy per plane. The area-export version of this function
 * had to merge the two edge hours by hand; that whole class of bug is gone
 * with the area column (D13).
 */
export function blitBlock(accumulator: CaseAccumulator, block: BlockPayload): void {
  const { plan, cube } = accumulator;
  const { baseHour, hours, data } = block;
  accumulator.feb29 += block.feb29;
  if (hours === 0) return;
  if (baseHour + hours > HOURS_PER_YEAR) {
    throw new Error(
      `Block covers hours ${baseHour}..${baseHour + hours - 1}, past the ${HOURS_PER_YEAR}-hour ` +
        `year. Feb 29 should have been dropped at parse time (D4).`,
    );
  }

  for (let p = 0; p < plan.activePlanes.length; p++) {
    const column = plan.slabPlan[plan.activePlanes[p]];
    cube.set(data.subarray(p * hours, (p + 1) * hours), column * HOURS_PER_YEAR + baseHour);
  }

  for (let t = 0; t < hours; t++) {
    const code = block.tou[t];
    if (code === 0xff) continue;
    accumulator.tou[baseHour + t] = code;
    accumulator.hourSeen[baseHour + t] = 1;
  }
}

export function finalizeCase(
  accumulator: CaseAccumulator,
  name: string,
  sourceColumns: string[],
  year: number,
  title: TitleInfo,
): { data: CaseData; warnings: string[] } {
  const { plan, cube } = accumulator;
  const warnings: string[] = [];

  const absent = plan.interfaces.filter((_, i) => !plan.presence[i]);
  if (absent.length > 0) {
    warnings.push(
      `${name}: ${absent.length} selected interface(s) are not in this export ` +
        `(${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', …' : ''}).`,
    );
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
  if (accumulator.feb29 > 0) {
    warnings.push(
      `${name}: ${year} is a leap year — ${accumulator.feb29.toLocaleString()} Feb 29 row(s) ` +
        `were dropped at ingest so every case is exactly ${HOURS_PER_YEAR.toLocaleString()} ` +
        `hours (D4).`,
    );
  }
  if (title.quantity === '') {
    warnings.push(
      `${name}: the title line does not name a quantity, so this case has no unit. Its ` +
        `series still plot, on an axis of their own.`,
    );
  } else if (title.year !== null && title.year !== year) {
    warnings.push(
      `${name}: the title line says year ${title.year} but the first data row is ${year}. ` +
        `The data rows win.`,
    );
  }

  return {
    data: {
      name,
      cube,
      interfaces: plan.interfaces,
      presence: plan.presence.slice(),
      tou: accumulator.tou,
      sourceColumns,
      year,
      quantity: title.quantity,
      unit: unitOf(title.quantity),
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
  // length varies with the number of interfaces the export monitors, so the
  // bound comes from this file's own rows rather than a constant.
  const blockBytes = Math.max(
    plan.bytesPerRow,
    Math.min(BLOCK_TARGET_BYTES, SAFE_BLOCK_HOURS * plan.bytesPerRow),
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
 * Parse every plan into its own cube. `retained` defines the cube's interface
 * axis; the caller gets it from the picker, or passes the union schema for
 * "everything".
 *
 * Files need not agree on their columns: the axis is the union and each case
 * carries a presence bitmap, so a path monitored in one run and not another
 * loads as absent in that case rather than refusing the drop (D14).
 */
export async function ingest(
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<IngestResult> {
  if (plans.length === 0) return { cases: [], warnings: [] };

  const interfaces = retained.map((name) => name.trim());
  if (interfaces.length === 0) {
    throw new Error('No interfaces selected — there would be nothing to plot.');
  }
  const warnings: string[] = [];

  const columnPlans = plans.map((plan) => buildColumnPlan(plan.header, interfaces));
  const accumulators = columnPlans.map(createAccumulator);

  let id = 0;
  const jobs: BlockMessage[] = [];
  plans.forEach((plan, index) => {
    jobs.push(...blocksFor(plan, index, columnPlans[index].activePlanes, () => id++));
  });

  const workers = await pool();
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
    const finalized = finalizeCase(
      accumulator,
      caseNameOf(plan.file.name),
      plan.header.interfaceNames,
      plan.year,
      plan.title,
    );
    cases.push(finalized.data);
    warnings.push(...finalized.warnings);
  });

  return { cases, warnings };
}

/** Bytes one case's cube occupies, for the picker's readout. Exact, not an
 * estimate: this is the allocation createAccumulator makes. */
export function cubeBytesFor(interfaceCount: number): number {
  return interfaceCount * HOURS_PER_YEAR * Float32Array.BYTES_PER_ELEMENT;
}
