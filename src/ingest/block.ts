// src/ingest/block.ts
//
// The WASM parser's JS side: instantiate the module, hand it a block of
// whole rows, lift the active planes back out of the slab.
//
// This lives apart from worker.ts on purpose. It is the riskiest index
// arithmetic in the build -- slab plane -> cube metric, area-major with an
// hour stride of MAX_BLOCK_HOURS -- so test_ingest.mjs (T4) drives *this*
// code directly in node rather than a reimplementation of it. worker.ts is
// then only plumbing: read bytes, call this, transfer the result.

import { SLAB_AREAS, SLAB_METRICS } from './header';

/** block.c's MAX_BLOCK_HOURS. Compiled in, not exported by the module. */
export const MAX_BLOCK_HOURS = 1024;

export const NEWLINE = 10;

export interface ParserExports {
  memory: WebAssembly.Memory;
  inbuf_ptr(): number;
  inbuf_size(): number;
  slab_ptr(): number;
  tou_ptr(): number;
  area_seen_ptr(): number;
  slab_hours(): number;
  last_rows(): number;
  last_base_hour(): number;
  last_max_hour(): number;
  last_unknown_area(): number;
  last_out_of_range(): number;
  area_table_reset(): void;
  area_table_put(hash: number, idx: number): void;
  slab_fill_nan(hours: number): void;
  parse_block(len: number, baseHour: number): number;
}

/** One parsed block, ready to blit into a cube. */
export interface BlockPayload {
  /** Hour-of-year the block's first covered hour maps to. */
  baseHour: number;
  /** Hours covered, so `data` is [activePlanes x SLAB_AREAS x hours]. */
  hours: number;
  rows: number;
  /** data[(p * SLAB_AREAS + area) * hours + t] for active plane p. */
  data: Float32Array;
  /** Per-hour TOU code straight from the file's TOU column; 0xFF = uncovered. */
  tou: Uint8Array;
  /** 1 = this area had at least one row in the block. */
  areaSeen: Uint8Array;
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
    areaSeen: new Uint8Array(SLAB_AREAS),
  };
}

/**
 * Instantiate the parser and fill its area hash table. Every worker needs
 * its own instance: linear memory cannot be shared without SharedArrayBuffer,
 * which D2 forbids on GitHub Pages.
 */
export async function instantiateParser(
  module: WebAssembly.Module,
  hashes: Uint32Array,
): Promise<ParserExports> {
  const instance = await WebAssembly.instantiate(module, {});
  const parser = instance.exports as unknown as ParserExports;
  if (parser.slab_hours() !== MAX_BLOCK_HOURS) {
    throw new Error(
      `block.wasm reports slab_hours()=${parser.slab_hours()} but this module mirrors ` +
        `MAX_BLOCK_HOURS=${MAX_BLOCK_HOURS}. Rebuild the parser or fix the constant.`,
    );
  }
  parser.area_table_reset();
  for (let i = 0; i < hashes.length; i++) parser.area_table_put(hashes[i], i);
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

  const unknown = parser.last_unknown_area();
  if (unknown > 0) {
    throw new Error(
      `${unknown} row(s) carry an area name that is not on the area axis read from this ` +
        `export's first hour. Those rows would be dropped silently, so the load is refused ` +
        `instead.`,
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

  const slab = new Float32Array(
    parser.memory.buffer,
    parser.slab_ptr(),
    SLAB_AREAS * SLAB_METRICS * MAX_BLOCK_HOURS,
  );
  const data = new Float32Array(activePlanes.length * SLAB_AREAS * hours);
  for (let p = 0; p < activePlanes.length; p++) {
    const plane = activePlanes[p];
    for (let area = 0; area < SLAB_AREAS; area++) {
      const src = (area * SLAB_METRICS + plane) * MAX_BLOCK_HOURS;
      data.set(slab.subarray(src, src + hours), (p * SLAB_AREAS + area) * hours);
    }
  }

  const tou = new Uint8Array(parser.memory.buffer, parser.tou_ptr(), MAX_BLOCK_HOURS);
  const areaSeen = new Uint8Array(parser.memory.buffer, parser.area_seen_ptr(), SLAB_AREAS);

  return {
    baseHour,
    hours,
    rows,
    data,
    tou: tou.slice(0, hours),
    areaSeen: areaSeen.slice(0, SLAB_AREAS),
  };
}

/** Index just past the first `\n` at or after `from`, or -1. */
export function afterNextNewline(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(NEWLINE, Math.max(0, from));
  return at < 0 ? -1 : at + 1;
}
