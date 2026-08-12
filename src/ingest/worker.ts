// src/ingest/worker.ts
//
// One worker = one WASM instance = one byte range at a time.
//
// The unit of work is a BYTE RANGE, not a case (D10): a single dropped file
// must use every core, so one dropped file and ten dropped files feed the
// same pool. Blocks are position-independent because block.c derives each
// row's hour from the row's own Date/Hour fields, so a worker needs its bytes
// and nothing else -- and for the same reason the rows inside a block need
// not be in any order either.
//
// Per-instance memory is a function of BLOCK size, never case size
// (footgun 22): a 12 MiB input window + an 8 MiB slab.
//
// All the real work is in block.ts, which test_ingest.mjs drives directly.
// This file is only: read the bytes, widen to whole rows, transfer back.

import {
  afterNextNewline,
  instantiateParser,
  parseBytes,
  type BlockPayload,
  type ParserExports,
} from './block';

/** Bytes read past the requested end to complete the final row. An interface
 * export's rows run ~1.5 KB at 167 columns, so this is ~40 rows of slack; a
 * longer row is handled by re-reading wider rather than by truncating. */
const TAIL_BYTES = 64 * 1024;

export interface InitMessage {
  kind: 'init';
  module: WebAssembly.Module;
}

export interface BlockMessage {
  kind: 'block';
  blockId: number;
  caseIndex: number;
  file: File;
  start: number;
  end: number;
  /** False only for a file's first block, whose `start` is already the first
   * byte after the header. Every other block starts mid-row and must discard
   * the partial row its predecessor owns. */
  skipPartialFirstRow: boolean;
  /** Slab planes with a cube destination, ascending (ColumnPlan.activePlanes). */
  activePlanes: Int32Array;
  /** The case's calendar year, from its first data row. Every row's own year
   * is checked against it, so a file holding two years is refused rather than
   * folded onto one set of 8,760 hours. */
  year: number;
}

export type WorkerRequest = InitMessage | BlockMessage;

export interface BlockResult extends BlockPayload {
  kind: 'done';
  blockId: number;
  caseIndex: number;
}

export interface WorkerReady {
  kind: 'ready';
}

export interface WorkerError {
  kind: 'error';
  blockId: number;
  message: string;
}

export type WorkerResponse = WorkerReady | BlockResult | WorkerError;

let parser: ParserExports | null = null;

/**
 * Read [start, end) widened to whole rows: forward to the first row boundary
 * (the previous block owns the row straddling `start`) and past `end` to the
 * next one. Block boundaries never align to rows, so both ends move.
 *
 * Exported for test_ingest.mjs. The ranges it returns must TILE the data
 * region -- every row in exactly one block -- and an overlap here is a
 * duplicated hour, not a visible error.
 */
export async function readWholeRows(
  message: BlockMessage,
): Promise<{ bytes: Uint8Array; from: number; to: number }> {
  const size = message.file.size;
  let tail = TAIL_BYTES;
  for (;;) {
    const stop = Math.min(message.end + tail, size);
    const bytes = new Uint8Array(await message.file.slice(message.start, stop).arrayBuffer());

    let from = 0;
    if (message.skipPartialFirstRow) {
      from = afterNextNewline(bytes, 0);
      // No row boundary at all: every byte here belongs to a row the previous
      // block already claimed.
      if (from < 0) return { bytes, from: 0, to: 0 };
    }

    // Only the LAST block runs to the end of the file. The test used to be
    // `stop >= size` -- true for any block whose end came within TAIL_BYTES of
    // EOF, which then re-parsed every row after it and handed the same hours
    // in twice. Under the old slab those rows overwrote their own cells with
    // their own values and nothing showed; the coverage map in blitBlock turns
    // it into a refusal, which is how it was finally seen.
    if (message.end >= size) return { bytes, from, to: bytes.length };

    const to = afterNextNewline(bytes, message.end - message.start);
    if (to >= 0) return { bytes, from, to };

    // Read to EOF without finding a boundary past `end`: the file's final row
    // straddles `end`, and it belongs to this block.
    if (stop >= size) return { bytes, from, to: bytes.length };

    // One row longer than the whole tail. Rare enough to just retry wider.
    tail *= 4;
    if (message.start + tail > size + TAIL_BYTES) {
      throw new Error(`No row boundary within ${tail} B past byte ${message.end}.`);
    }
  }
}

/** The message pump, installed only in a real Worker. The guard is what lets
 * test_ingest.mjs import this module in node to drive readWholeRows -- the
 * widening it does has to tile, and that is not something worker plumbing
 * should be trusted with untested. */
const handleMessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      parser = await instantiateParser(message.module);
      const ready: WorkerReady = { kind: 'ready' };
      (self as unknown as Worker).postMessage(ready);
      return;
    }

    if (!parser) throw new Error('worker received a block before init');
    const { bytes, from, to } = await readWholeRows(message);
    const payload = parseBytes(parser, bytes, from, to, message.activePlanes, message.year);
    const result: BlockResult = {
      kind: 'done',
      blockId: message.blockId,
      caseIndex: message.caseIndex,
      ...payload,
    };
    (self as unknown as Worker).postMessage(result, [
      result.data.buffer,
      result.rowHour.buffer,
      result.rowTou.buffer,
    ]);
  } catch (error) {
    const failure: WorkerError = {
      kind: 'error',
      blockId: message.kind === 'block' ? message.blockId : -1,
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(failure);
  }
};

if (typeof self !== 'undefined') self.onmessage = handleMessage;
