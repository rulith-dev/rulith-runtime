import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app ships inside the Runtime repository (D-1019c): its Runtime is this repository, unless RULITH_RUNTIME_DIR names another.
export function runtimeDirectory(env = process.env) {
  return path.resolve(env.RULITH_RUNTIME_DIR || fileURLToPath(new URL('../..', import.meta.url)));
}
export const generalKit = (env = process.env) => path.join(runtimeDirectory(env), 'kits', 'general');
// Whether the Runtime under use ships the general kit (published rulith 0.16.3 does not).
export const kitReady = (env = process.env) => fs.existsSync(path.join(generalKit(env), 'worker-tools.json'));
export const KIT_SKIP = 'set RULITH_RUNTIME_DIR to a Runtime checkout with kits/general';
