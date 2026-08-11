import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const parserWasm = readFileSync(new URL('./parser/block.wasm', import.meta.url));
const publicWasm = readFileSync(new URL('./public/block.wasm', import.meta.url));
assert.equal(publicWasm.length, parserWasm.length, 'served wasm has the same size as parser/block.wasm');
assert.ok(publicWasm.equals(parserWasm), 'served wasm is byte-identical to parser/block.wasm');

console.log('ok - block.wasm is present for Vite dev and matches the parser binary');
