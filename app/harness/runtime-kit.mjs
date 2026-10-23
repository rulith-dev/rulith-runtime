import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// A checkout is useful until the Runtime release containing kits/general is published.
export function runtimeDirectory(env = process.env) {
  return path.resolve(env.RULITH_RUNTIME_DIR || path.dirname(createRequire(import.meta.url).resolve('rulith/package.json')));
}
export const generalKit = (env = process.env) => path.join(runtimeDirectory(env), 'kits', 'general');
// Whether the Runtime under use ships the general kit (published rulith 0.16.3 does not).
export const kitReady = (env = process.env) => fs.existsSync(path.join(generalKit(env), 'worker-tools.json'));
export const KIT_SKIP = 'set RULITH_RUNTIME_DIR to a Runtime checkout with kits/general';
