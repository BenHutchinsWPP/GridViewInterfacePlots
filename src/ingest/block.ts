// src/ingest/block.ts
//
// The WASM parser's JS side: instantiate the module, hand it a block of
// whole rows, lift the active planes back out of the slab.
//
// This lives apart from worker.ts on purpose. It is the riskiest index
// arithmetic in the build -- slab plane -> cube interface, with an hour stride
// of MAX_BLOCK_HOURS -- so test_ingest.mjs (T4) drives *this* code directly in
// node rather than a reimplementation of it. worker.ts is then only plumbing:
// read bytes, call this, transfer the result.

import { SLAB_METRICS } from './header';

/** block.c's MAX_BLOCK_HOURS. Compiled in, and checked against the module's
 * own `slab_hours()` at instantiation. */
export const MAX_BLOCK_HOURS = 4096;

export const NEWLINE = 10;

export interface ParserExports {
  memory: WebAssembly.Memory;
  inbuf_ptr(): number;
  inbuf_size(): number;
  slab_ptr(): number;
  tou_ptr(): number;
  slab_hours(): number;
  slab_metrics(): number;
  last_rows(): number;
  last_base_hour(): number;
  last_max_hour(): number;
  last_out_of_range(): number;
  last_wide_field(): number;
  last_bad_row(): number;
  last_feb29(): number;
  slab_fill_nan(hours: number): void;
  parse_block(len: number, baseHour: number): number;
}

/** One parsed block, ready to blit into a cube. */
export interface BlockPayload {
  /** Hour-of-year the block's first covered hour maps to. */
  baseHour: number;
  /** Hours covered, so `data` is [activePlanes x hours]. */
  hours: number;
  rows: number;
  /** data[p * hours + t] for active plane p. */
  data: Float32Array;
  /** Per-hour TOU code straight from the file's TOU column; 0xFF = uncovered. */
  tou: Uint8Array;
  /** Rows dropped because they are Feb 29 (D4) -- intended, and stated. */
  feb29: number;
}

/** A block that contributed nothing. Freshly allocated every time: the
 * buffers are transferred out of the worker, and a transferred buffer is
 * detached, so a shared constant would break the second empty block. */
function emptyPayload(): BlockPayload {
  return {
    baseHour: 0,
    hours: 0,
    rows: 0,
    data: new Float32Array(0),
    tou: new Uint8Array(0),
    feb29: 0,
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
  if (parser.slab_hours() !== MAX_BLOCK_HOURS || parser.slab_metrics() !== SLAB_METRICS) {
    throw new Error(
      `block.wasm reports slab_hours()=${parser.slab_hours()}, ` +
        `slab_metrics()=${parser.slab_metrics()}, but this build mirrors ` +
        `MAX_BLOCK_HOURS=${MAX_BLOCK_HOURS}, SLAB_METRICS=${SLAB_METRICS}. ` +
        `Rebuild the parser or fix the constants.`,
    );
  }
  return parser;
}

/**
 * Parse `bytes[from, to)` -- which must start at a row boundary and end just
 * after a `\n` -- and lift `activePlanes` out of the slab.
 *
 * `baseHour` comes from the block's own first row, so the result is
 * position-independent: any block can be parsed by any worker in any order
 * (D10).
 */
export function parseBytes(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
  activePlanes: Int32Array,
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

  // Clear the whole slab, not only the hours this block will fill. A stale
  // float left over from the previous block is a plausible-looking wrong
  // number, which is precisely the failure this project cannot see by eye.
  parser.slab_fill_nan(MAX_BLOCK_HOURS);
  const rows = parser.parse_block(padded, 0xffffffff);
  if (rows === 0) return emptyPayload();

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
  const outOfRange = parser.last_out_of_range();
  if (outOfRange > 0) {
    throw new Error(
      `${outOfRange} row(s) fell outside the ${MAX_BLOCK_HOURS}-hour slab window. Blocks must ` +
        `be sized so one spans at most ${MAX_BLOCK_HOURS} hours.`,
    );
  }

  const baseHour = parser.last_base_hour();
  const hours = parser.last_max_hour() + 1;

  const slab = new Float32Array(parser.memory.buffer, parser.slab_ptr(), SLAB_METRICS * MAX_BLOCK_HOURS);
  const data = new Float32Array(activePlanes.length * hours);
  for (let p = 0; p < activePlanes.length; p++) {
    const src = activePlanes[p] * MAX_BLOCK_HOURS;
    data.set(slab.subarray(src, src + hours), p * hours);
  }

  const tou = new Uint8Array(parser.memory.buffer, parser.tou_ptr(), MAX_BLOCK_HOURS);

  return {
    baseHour,
    hours,
    rows,
    data,
    tou: tou.slice(0, hours),
    feb29: parser.last_feb29(),
  };
}

/** Index just past the first `\n` at or after `from`, or -1. */
export function afterNextNewline(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(NEWLINE, Math.max(0, from));
  return at < 0 ? -1 : at + 1;
}
