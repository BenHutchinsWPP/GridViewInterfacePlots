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
import { isOverflowError, MAX_BLOCK_ROWS, NEWLINE, type BlockPayload } from './block';
import type { BlockMessage, BlockResult, InitMessage, WorkerResponse } from './worker';

/** D10: >= 8 MiB. 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/** Of block.c's MAX_BLOCK_ROWS, leaving headroom for row-length variance.
 * Exceeding it is caught and refused in the worker, not silently dropped, but
 * sizing blocks so it cannot happen is cheaper than the error. */
const SAFE_BLOCK_ROWS = Math.floor(MAX_BLOCK_ROWS * 0.9);

/** Enough for the four preamble lines, a ~4 KB header and a first data row. */
const HEAD_PROBE_BYTES = 256 * 1024;

/** Data rows measured in the head probe to size blocks. The first row alone is
 * a sample of one: an export whose first row happens to be long would size
 * blocks in bytes that hold far more of the shorter rows that follow. */
const ROW_SAMPLE = 64;

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
  /** The SHORTEST data row seen in the head probe, so a block's byte size
   * bounds its row count from above. See readCasePlan. */
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
  //
  // This is the case's year, and it comes from whichever row happens to be
  // first -- which, on an export that is not in date order, is not the
  // earliest. That is safe because a year is a property of the FILE, not of
  // the row: block.c checks every row's own year against this one and the
  // load is refused if they disagree. A shuffled single-year file gives the
  // same answer whichever row is first; a two-year file is refused whichever
  // row is first.
  const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`${file.name}: could not read a year from the first Date field.`);
  }

  // Blocks are cut in BYTES but bounded in ROWS, so the conversion between
  // them has to be pessimistic: take the shortest row in the sample, not the
  // first row and not the mean. A row shorter than every row sampled is the
  // only way a block can still overrun, and the parser refuses that rather
  // than wrapping -- ingest then re-cuts the file smaller.
  let shortest = rowEnd - dataStart + 1;
  let cursor = rowEnd + 1;
  for (let seen = 1; seen < ROW_SAMPLE; seen++) {
    const next = probe.indexOf(NEWLINE, cursor);
    if (next < 0) break;
    shortest = Math.min(shortest, next - cursor + 1);
    cursor = next + 1;
  }

  return { file, header, title, dataStart, year, bytesPerRow: Math.max(1, shortest) };
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
  /** One bit per hour of the year: has a row already claimed it? The scatter
   * would otherwise keep whichever worker finished last, silently. 1,095
   * bytes, because one row is one whole hour here -- the area build needed
   * 47 KB for the same guarantee across 43 areas. */
  covered: Uint8Array;
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
    covered: new Uint8Array(Math.ceil(HOURS_PER_YEAR / 8)),
    feb29: 0,
  };
}

/**
 * Scatter one block's rows into the cube, each row at the hour it carries.
 *
 * Correct in any arrival order across blocks, and -- unlike the contiguous
 * copy this replaced -- correct for any row order INSIDE a block too. A
 * value-sorted or descending export lands exactly like a date-ordered one.
 *
 * The loop is plane-outer, row-inner on purpose. One interface's year is a
 * contiguous 35 KB run of the cube, so scattering within it stays in cache;
 * row-outer would walk the whole cube once per row. The area build needed a
 * counting sort to get the same locality -- here it falls out of the layout,
 * because one row is one whole hour and the plane is the outer axis.
 */
export function blitBlock(accumulator: CaseAccumulator, block: BlockPayload): void {
  const { plan, cube, covered } = accumulator;
  const { rows, data, rowHour, rowTou } = block;
  accumulator.feb29 += block.feb29;
  if (rows === 0) return;

  // Claim each hour before any value is written. Two rows for one hour is the
  // one thing a scatter cannot resolve: it would keep whichever worker
  // finished last, silently, and both values look perfectly plausible.
  for (let r = 0; r < rows; r++) {
    const hour = rowHour[r];
    const byte = hour >> 3;
    const mask = 1 << (hour & 7);
    if (covered[byte] & mask) {
      throw new Error(
        `Two rows both describe hour ${hour} of the year. One case is one calendar year, so an ` +
          `hour cannot appear twice; two exports concatenated into one file look like this. ` +
          `Load them as separate files.`,
      );
    }
    covered[byte] |= mask;
    accumulator.tou[hour] = rowTou[r];
    accumulator.hourSeen[hour] = 1;
  }

  for (let p = 0; p < plan.activePlanes.length; p++) {
    const base = plan.slabPlan[plan.activePlanes[p]] * HOURS_PER_YEAR;
    const src = p * rows;
    for (let r = 0; r < rows; r++) cube[base + rowHour[r]] = data[src + r];
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
  shrink: number,
): BlockMessage[] {
  // A block must never hold more rows than block.c's slab has columns, and row
  // length varies with the number of interfaces the export monitors, so the
  // bound comes from this file's own rows rather than a constant.
  // `plan.bytesPerRow` is the shortest row sampled, so this over-estimates the
  // rows a block can hold rather than under-estimating them.
  const blockBytes = Math.max(
    plan.bytesPerRow,
    Math.floor(Math.min(BLOCK_TARGET_BYTES, SAFE_BLOCK_ROWS * plan.bytesPerRow) / shrink),
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
      year: plan.year,
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
  const workers = await pool();

  /**
   * One pass over every file at a given block size. Accumulators are built
   * here rather than by the caller because a retry must start from empty
   * cubes -- a half-filled one would fail the duplicate check on rows it had
   * already taken.
   */
  async function attempt(shrink: number): Promise<CaseAccumulator[]> {
    const accumulators = columnPlans.map(createAccumulator);
    let id = 0;
    const jobs: BlockMessage[] = [];
    plans.forEach((plan, index) => {
      jobs.push(...blocksFor(plan, index, columnPlans[index].activePlanes, () => id++, shrink));
    });

    let done = 0;
    let next = 0;
    let aborted = false;

    // allSettled, not all: a retry reuses these same workers, and `all`
    // returns the moment one rejects while the others are still mid-block.
    // Posting the next attempt's jobs to a worker that has not yet answered
    // for this one crosses the responses -- runBlock resolves on the first
    // message it sees -- and the ingest hangs. Every worker loop must be
    // finished before this function returns.
    const outcomes = await Promise.allSettled(
      workers.map(async (worker) => {
        for (;;) {
          // A failure anywhere ends the attempt; the remaining blocks would
          // be thrown away regardless.
          if (aborted) return;
          const index = next++;
          if (index >= jobs.length) return;
          const job = jobs[index];
          try {
            const result = await runBlock(worker, job);
            blitBlock(accumulators[job.caseIndex], result);
          } catch (error) {
            aborted = true;
            throw error;
          }
          onProgress?.(++done, jobs.length);
        }
      }),
    );

    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure && failure.status === 'rejected') throw failure.reason;
    return accumulators;
  }

  // Blocks are cut in bytes and bounded in rows, and readCasePlan converts
  // between the two from a sample. A file whose rows shrink below everything
  // sampled -- a study that starts wide and later writes short fields -- can
  // still overrun the slab. The parser refuses that rather than wrapping, and
  // the fix is entirely on this side, so re-cut the file smaller instead of
  // handing the user an error they cannot act on. Four attempts take the block
  // to 1/64th, well past any real row-length variance.
  let accumulators: CaseAccumulator[];
  for (let shrink = 1; ; shrink *= 4) {
    try {
      accumulators = await attempt(shrink);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isOverflowError(message) || shrink >= 64) {
        throw error instanceof Error ? error : new Error(message);
      }
    }
  }

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
