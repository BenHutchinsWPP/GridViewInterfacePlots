// src/ingest/block.ts
//
// The WASM parser's JS side: instantiate the module, hand it a block of
// whole rows, lift the active planes back out of the slab.
//
// This lives apart from worker.ts on purpose. It is the riskiest index
// arithmetic in the build -- slab plane -> cube interface, with a row stride
// of MAX_BLOCK_ROWS -- so test_ingest.mjs (T4) drives *this* code directly in
// node rather than a reimplementation of it. worker.ts is then only plumbing:
// read bytes, call this, transfer the result.

import { SLAB_METRICS } from './header';

/** block.c's MAX_BLOCK_ROWS. Compiled in, and checked against the module's
 * own `slab_rows()` at instantiation. */
export const MAX_BLOCK_ROWS = 4096;

/** block.c's ABI_VERSION. */
export const PARSER_ABI = 2;

/**
 * Marker on the block-slab overflow error.
 *
 * A worker reports failure by posting `error.message`, so the Error class is
 * gone by the time ingest sees it. This marker is how the retry recognises the
 * one failure it can actually fix -- by re-cutting the file into smaller
 * blocks -- and it must not be localised or reworded.
 */
export const OVERFLOW_MARKER = 'block-slab-overflow';

/** True for the overflow error above, wherever it has been stringified. */
export function isOverflowError(message: string): boolean {
  return message.includes(OVERFLOW_MARKER);
}

export const NEWLINE = 10;

export interface ParserExports {
  memory: WebAssembly.Memory;
  inbuf_ptr(): number;
  inbuf_size(): number;
  slab_ptr(): number;
  row_hour_ptr(): number;
  row_tou_ptr(): number;
  slab_rows(): number;
  slab_metrics(): number;
  abi_version(): number;
  last_rows(): number;
  last_overflow(): number;
  last_wide_field(): number;
  last_bad_row(): number;
  last_feb29(): number;
  last_year_mismatch(): number;
  slab_fill_nan(rows: number): void;
  parse_block(len: number, year: number): number;
}

/**
 * One parsed block, ready to scatter into a cube.
 *
 * A ROW LIST, not an hour window: row `r` holds the values at `rowHour[r]`,
 * and rows appear in the order the bytes did. Nothing downstream may assume
 * that order means anything, which is what makes a value-sorted export load
 * identically to a date-ordered one.
 */
export interface BlockPayload {
  /** Rows emitted -- valid rows only. Feb 29 and refused rows are counted
   * separately and occupy no slot. */
  rows: number;
  /** data[p * rows + r]: active plane p, row r. Plane-major, so lifting one
   * interface out of the slab stays a contiguous copy. */
  data: Float32Array;
  /** Hour of the year each row lands on, 0..8759. Length `rows`. */
  rowHour: Uint16Array;
  /** Per-row TOU code straight from the file's TOU column. Length `rows`. */
  rowTou: Uint8Array;
  /** Rows dropped because they are Feb 29 (D4) -- intended, and stated. */
  feb29: number;
}

/** A block that contributed nothing. Freshly allocated every time: the
 * buffers are transferred out of the worker, and a transferred buffer is
 * detached, so a shared constant would break the second empty block. */
function emptyPayload(feb29 = 0): BlockPayload {
  return {
    rows: 0,
    data: new Float32Array(0),
    rowHour: new Uint16Array(0),
    rowTou: new Uint8Array(0),
    feb29,
  };
}

/**
 * Instantiate the parser. Every worker needs its own instance: linear memory
 * cannot be shared without SharedArrayBuffer, which D2 forbids on GitHub
 * Pages.
 *
 * Both slab dimensions are checked against this module's mirrored constants.
 * A rebuilt block.c with a different NUM would otherwise be read with the old
 * stride -- every plane after the first shifted by a fixed offset, every
 * number plausible.
 */
export async function instantiateParser(module: WebAssembly.Module): Promise<ParserExports> {
  const instance = await WebAssembly.instantiate(module, {});
  const parser = instance.exports as unknown as ParserExports;
  // A stale block.wasm against updated TypeScript must fail HERE. The ABI
  // check catches the case the dimension checks cannot: a binary whose slab is
  // the right shape but means something else -- v1's columns were hours, v2's
  // are rows, and reading one as the other is wrong numbers, not an error.
  if (typeof parser.abi_version !== 'function' || parser.abi_version() !== PARSER_ABI) {
    const found = typeof parser.abi_version === 'function' ? parser.abi_version() : 'none';
    throw new Error(
      `block.wasm reports ABI ${found}, but this build speaks ABI ${PARSER_ABI}. ` +
        `Rebuild the parser: parser/build.sh.`,
    );
  }
  if (parser.slab_rows() !== MAX_BLOCK_ROWS || parser.slab_metrics() !== SLAB_METRICS) {
    throw new Error(
      `block.wasm reports slab_rows()=${parser.slab_rows()}, ` +
        `slab_metrics()=${parser.slab_metrics()}, but this build mirrors ` +
        `MAX_BLOCK_ROWS=${MAX_BLOCK_ROWS}, SLAB_METRICS=${SLAB_METRICS}. ` +
        `Rebuild the parser or fix the constants.`,
    );
  }
  return parser;
}

/**
 * Parse `bytes[from, to)` -- which must start at a row boundary and end just
 * after a `\n` -- and lift `activePlanes` out of the slab.
 *
 * Every row carries its own hour, so the result is position-independent twice
 * over: any block can be parsed by any worker in any order (D10), and the rows
 * inside a block need not be in any order either.
 *
 * `year` is the case's year, from the file's first data row. Rows carrying a
 * different one are refused rather than folded onto the same 8,760 hours.
 */
export function parseBytes(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
  activePlanes: Int32Array,
  year: number,
): BlockPayload {
  const length = to - from;
  if (length <= 0) return emptyPayload();

  const inbufPtr = parser.inbuf_ptr();
  const inbufSize = parser.inbuf_size();
  if (length + 1 > inbufSize) {
    throw new Error(`Block of ${length} B exceeds the ${inbufSize} B WASM input window.`);
  }

  const memory = new Uint8Array(parser.memory.buffer);
  memory.set(bytes.subarray(from, to), inbufPtr);
  let padded = length;
  // parse_block only emits a row once it sees the terminator, so a file that
  // does not end in a newline would otherwise lose its final row.
  if (memory[inbufPtr + padded - 1] !== NEWLINE) memory[inbufPtr + padded++] = NEWLINE;

  // Clear the whole slab, not only the rows this block will fill. A stale
  // float left over from the previous block is a plausible-looking wrong
  // number, which is precisely the failure this project cannot see by eye.
  parser.slab_fill_nan(MAX_BLOCK_ROWS);
  const rows = parser.parse_block(padded, year);

  // Counters are read BEFORE the empty-block shortcut: a block that emitted no
  // rows because every row was refused has the most to report, and returning
  // early on rows === 0 would swallow exactly that.
  const wide = parser.last_wide_field();
  if (wide > 0) {
    throw new Error(
      `${wide} field(s) sit past column ${SLAB_METRICS + 3} — this export is wider than ` +
        `parser/block.c's ${SLAB_METRICS}-interface slab. Those columns would be dropped ` +
        `silently, so the load is refused instead. Widen NUM in block.c and rebuild.`,
    );
  }
  const bad = parser.last_bad_row();
  if (bad > 0) {
    throw new Error(
      `${bad} row(s) carry a Date or Hour this parser could not read (expected M/D/YYYY and ` +
        `an hour-ending 1-24). Those rows would be dropped silently, so the load is refused.`,
    );
  }
  const mismatched = parser.last_year_mismatch();
  if (mismatched > 0) {
    throw new Error(
      `${mismatched} row(s) carry a year other than ${year}, which is the year on this file's ` +
        `first data row. A case is one calendar year of 8,760 hours, so a second year would be ` +
        `folded onto the same hours. Split the export by year and load the files separately.`,
    );
  }
  const overflow = parser.last_overflow();
  if (overflow > 0) {
    throw new Error(
      `${OVERFLOW_MARKER}: ${overflow} row(s) past the ${MAX_BLOCK_ROWS}-row block slab — this ` +
        `block held more rows than its byte length predicted.`,
    );
  }

  const feb29 = parser.last_feb29();
  if (rows === 0) return emptyPayload(feb29);

  // Plane-major on both sides, so each interface is one contiguous copy.
  const slab = new Float32Array(
    parser.memory.buffer,
    parser.slab_ptr(),
    SLAB_METRICS * MAX_BLOCK_ROWS,
  );
  const data = new Float32Array(activePlanes.length * rows);
  for (let p = 0; p < activePlanes.length; p++) {
    const src = activePlanes[p] * MAX_BLOCK_ROWS;
    data.set(slab.subarray(src, src + rows), p * rows);
  }

  const rowHour = new Uint16Array(parser.memory.buffer, parser.row_hour_ptr(), MAX_BLOCK_ROWS);
  const rowTou = new Uint8Array(parser.memory.buffer, parser.row_tou_ptr(), MAX_BLOCK_ROWS);

  return {
    rows,
    data,
    // Copied out of linear memory, not viewed into it: these are transferred
    // to the main thread, and the next block reuses the same addresses.
    rowHour: rowHour.slice(0, rows),
    rowTou: rowTou.slice(0, rows),
    feb29,
  };
}

/** Index just past the first `\n` at or after `from`, or -1. */
export function afterNextNewline(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(NEWLINE, Math.max(0, from));
  return at < 0 ? -1 : at + 1;
}
