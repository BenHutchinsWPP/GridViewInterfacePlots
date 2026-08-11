// src/ingest/worker.ts
//
// One worker = one WASM instance = one byte range at a time.
//
// The unit of work is a BYTE RANGE, not a case (D10): a single dropped file
// must use every core, so one dropped file and ten dropped files feed the
// same pool. Blocks are position-independent because block.c derives each
// row's area and hour from the row's own Date/Hour/Name fields, so a worker
// needs its bytes and nothing else.
//
// Per-instance memory is a function of BLOCK size, never case size
// (footgun 22): 12 MiB input window + 8.8 MB slab, so eight workers cost
// ~256 MiB of scratch instead of 1,280 MiB.
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

/** Bytes read past the requested end to complete the final row. Rows average
 * 364 B in the real export, so this is ~180 rows of slack; a longer row is
 * handled by re-reading wider rather than by truncating. */
const TAIL_BYTES = 64 * 1024;

export interface InitMessage {
  kind: 'init';
  module: WebAssembly.Module;
  /** FNV-1a of every area name, in cube-area-index order. */
  areaHashes: Uint32Array;
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
 */
async function readWholeRows(
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

    if (stop >= size) return { bytes, from, to: bytes.length };

    const to = afterNextNewline(bytes, message.end - message.start);
    if (to >= 0) return { bytes, from, to };

    // One row longer than the whole tail. Rare enough to just retry wider.
    tail *= 4;
    if (message.start + tail > size + TAIL_BYTES) {
      throw new Error(`No row boundary within ${tail} B past byte ${message.end}.`);
    }
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      parser = await instantiateParser(message.module, message.areaHashes);
      const ready: WorkerReady = { kind: 'ready' };
      (self as unknown as Worker).postMessage(ready);
      return;
    }

    if (!parser) throw new Error('worker received a block before init');
    const { bytes, from, to } = await readWholeRows(message);
    const payload = parseBytes(parser, bytes, from, to, message.activePlanes);
    const result: BlockResult = {
      kind: 'done',
      blockId: message.blockId,
      caseIndex: message.caseIndex,
      ...payload,
    };
    (self as unknown as Worker).postMessage(result, [
      result.data.buffer,
      result.tou.buffer,
      result.areaSeen.buffer,
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
