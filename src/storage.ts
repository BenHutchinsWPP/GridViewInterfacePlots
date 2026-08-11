// src/storage.ts
//
// Save / load of the processed cubes, main-thread side. The actual OPFS I/O
// runs in storage-worker.ts because `createSyncAccessHandle` is worker-only.
//
// The manifest carries BOTH the retained interface list and the full source
// column list. Without the source list a saved bundle looks like a study that
// never monitored a path, when in fact the user just did not keep that column
// -- and the UI needs to offer a re-ingest for the second case and not the
// first.
//
// Presence and TOU bitmaps ride in the manifest as base64. They are small
// (one byte per interface, and 8.8 KB per case) and keeping them out of the
// binary section means the cube bytes stay a plain concatenation of
// Float32Array dumps.

import { HOURS_PER_YEAR } from './calendar';
import type { CaseData } from './types';
import type { StorageRequest, StorageResponse } from './storage-worker';

interface ManifestCase {
  name: string;
  year: number;
  /** The cube's interface axis, in index order. */
  interfaces: string[];
  /** Every interface the source CSV carried, retained or not. */
  sourceColumns: string[];
  /** The file's title-line quantity, e.g. `Power Flow (MW)`, and its unit. */
  quantity: string;
  unit: string;
  presence: string;
  tou: string;
  cubeBytes: number;
}

interface Manifest {
  /** 2 = the interface cube. Version 1 was the area cube of the tool this
   * grew out of; it has a different shape and a different magic, so it is
   * rejected at the magic rather than half-read here. */
  version: 2;
  cases: ManifestCase[];
}

// Single String.fromCharCode spread; the ceiling is the argument-count limit
// (~64K). Only ever called on `presence` (one byte per interface) and `tou`
// (8,760 B fixed), so the chunked loop this replaced could never run twice.
// Chunk again if either grows past ~32 KB.
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let worker: Worker | null = null;

function storageWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./storage-worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Pre-warm at page load, for the same reason the parse pool is pre-warmed
 * (D10): worker startup is ~40 ms, and on a Load it lands entirely inside
 * the measured reload-from-cache window. */
export function warmStorage(): void {
  storageWorker();
}

function request(message: StorageRequest, transfer: Transferable[] = []): Promise<StorageResponse> {
  const target = storageWorker();
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<StorageResponse>) => {
      target.removeEventListener('message', handler);
      if (event.data.kind === 'error') reject(new Error(event.data.message));
      else resolve(event.data);
    };
    target.addEventListener('message', handler);
    target.postMessage(message, transfer);
  });
}

function buildManifest(cases: CaseData[]): Manifest {
  return {
    version: 2,
    cases: cases.map((data) => ({
      name: data.name,
      year: data.year,
      interfaces: data.interfaces,
      sourceColumns: data.sourceColumns,
      quantity: data.quantity,
      unit: data.unit,
      presence: toBase64(data.presence),
      tou: toBase64(data.tou),
      cubeBytes: data.cube.byteLength,
    })),
  };
}

function cubeBytes(data: CaseData): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data.cube.buffer as ArrayBuffer, data.cube.byteOffset, data.cube.byteLength);
}

export async function saveBundle(
  cases: CaseData[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const manifest = buildManifest(cases);

  await request({ kind: 'saveBegin', manifest: JSON.stringify(manifest) });
  for (let i = 0; i < cases.length; i++) {
    // Cloned, not transferred: transferring would detach the live cube the
    // app is still rendering from. One case at a time bounds the transient
    // copy at one case instead of the whole working set.
    await request({ kind: 'saveChunk', bytes: cubeBytes(cases[i]) });
    onProgress?.(i + 1, cases.length);
  }
  await request({ kind: 'saveEnd' });
}

// ---------------------------------------------------------------- disk file
//
// The .gvip file is the same manifest and the same cube bytes as the OPFS
// bundle, in one stream: "GVIP" | uint32 manifest length | manifest JSON |
// cube bytes, concatenated in manifest order. It is written through a
// FileSystemWritableFileStream where the browser has one, so a multi-case
// study never needs a second full copy of itself in memory to be saved.

const MAGIC = 'GVIP';

/** Chrome/Edge expose showSaveFilePicker; nothing else does yet. */
interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** True when the user cancelled the file dialog rather than hitting an error. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function downloadBundle(
  cases: CaseData[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const manifest = new TextEncoder().encode(JSON.stringify(buildManifest(cases)));
  const header = new Uint8Array(MAGIC.length + 4);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(MAGIC.length, manifest.byteLength, true);

  const suggestedName = `gridview-interfaces-${cases.length}-case${cases.length === 1 ? '' : 's'}.gvip`;
  const picker = (window as SavePickerWindow).showSaveFilePicker;

  if (picker) {
    const handle = await picker.call(window, {
      suggestedName,
      types: [
        {
          description: 'GridView Interface Plots bundle',
          accept: { 'application/octet-stream': ['.gvip'] },
        },
      ],
    });
    const stream = await handle.createWritable();
    await stream.write(header);
    await stream.write(manifest);
    for (let i = 0; i < cases.length; i++) {
      await stream.write(cubeBytes(cases[i]));
      onProgress?.(i + 1, cases.length);
    }
    await stream.close();
    return handle.name;
  }

  // Fallback: one Blob and an anchor click. The Blob references the cube
  // buffers rather than copying them up front, but the browser still has to
  // materialise the file, so this path costs the study's size on disk.
  const blob = new Blob([header, manifest, ...cases.map(cubeBytes)], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  // Revoked on the next task: revoking synchronously races the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  onProgress?.(cases.length, cases.length);
  return suggestedName;
}

/** True for a file that is a saved bundle rather than a CSV export. */
export async function isBundleFile(file: File): Promise<boolean> {
  const head = await file.slice(0, MAGIC.length).text();
  return head === MAGIC;
}

export async function readBundleFile(file: File): Promise<RestoredBundle> {
  const headerBytes = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  const magic = new TextDecoder().decode(headerBytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) {
    throw new Error(
      magic === 'GVAP'
        ? `${file.name} is an area-plots bundle (GVAP). This tool reads interface bundles.`
        : `${file.name} is not a GridView interface bundle.`,
    );
  }
  const manifestLength = new DataView(headerBytes.buffer).getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  const manifest = JSON.parse(await file.slice(start, start + manifestLength).text()) as Manifest;

  let offset = start + manifestLength;
  const cubes: ArrayBuffer[] = [];
  for (const entry of manifest.cases) {
    cubes.push(await file.slice(offset, offset + entry.cubeBytes).arrayBuffer());
    offset += entry.cubeBytes;
  }
  return restore(manifest, cubes);
}

export interface RestoredBundle {
  cases: CaseData[];
}

export async function loadBundle(): Promise<RestoredBundle> {
  const response = await request({ kind: 'load' });
  if (response.kind !== 'loaded') throw new Error('unexpected storage reply');
  return restore(JSON.parse(response.manifest) as Manifest, response.cubes);
}

function restore(manifest: Manifest, cubes: ArrayBuffer[]): RestoredBundle {
  return { cases: casesFromManifest(manifest, cubes) };
}

function casesFromManifest(manifest: Manifest, cubes: ArrayBuffer[]): CaseData[] {
  if (manifest.version !== 2) {
    throw new Error(`Saved bundle is version ${manifest.version}; this build reads version 2.`);
  }

  return manifest.cases.map((entry, index) => {
    const cube = new Float32Array(cubes[index]);
    const expected = entry.interfaces.length * HOURS_PER_YEAR;
    if (cube.length !== expected) {
      throw new Error(
        `Saved cube for "${entry.name}" is ${cube.length} values, expected ${expected} ` +
          `(${entry.interfaces.length} interfaces × ${HOURS_PER_YEAR} h).`,
      );
    }
    return {
      name: entry.name,
      cube,
      interfaces: entry.interfaces,
      presence: fromBase64(entry.presence),
      tou: fromBase64(entry.tou),
      sourceColumns: entry.sourceColumns,
      year: entry.year,
      quantity: entry.quantity ?? '',
      unit: entry.unit ?? '',
    };
  });
}
