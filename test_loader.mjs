// test_loader.mjs
//
// Shared setup for the assert-based test scripts, so they import the real
// src/*.ts modules rather than a reimplementation of them.
//
// One job: a Node module hook for extensionless relative imports (`./header`),
// which are normal TypeScript and normal Vite but which Node's ESM resolver
// rejects. Everything else — Node >= 22.6 type stripping, `with { type:
// 'json' }` — Node already handles unaided.
//
// It used to have a second job, seeding an area axis and a grouping mapping
// into module state before anything else imported them. Neither exists now:
// an interface is a COLUMN, so a case carries its own axis and no module holds
// study state that a test has to prime (D13).
//
// Usage:  import './test_loader.mjs';   (must come before the src imports)

import { register } from 'node:module';

const hooks = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
      // Rewrite the specifier and delegate, rather than short-circuiting with
      // a url of our own: only the default resolver tags the module as
      // TypeScript, and without that tag Node skips type stripping.
      if (existsSync(resolvePath(base, candidate))) return nextResolve(candidate, context);
    }
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);
