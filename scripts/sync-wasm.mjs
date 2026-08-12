import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'parser', 'block.wasm');
const target = resolve(root, 'public', 'block.wasm');
const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  throw new Error('parser/block.wasm is missing; build the parser before starting the app.');
}

function sameFile() {
  if (!existsSync(target)) return false;
  const left = readFileSync(source);
  const right = readFileSync(target);
  return left.length === right.length && left.equals(right);
}

if (checkOnly) {
  if (!sameFile()) {
    throw new Error('public/block.wasm is missing or stale; run npm run sync-wasm.');
  }
} else if (!sameFile()) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
