import fs from 'node:fs';
import { sha, plainFenced, fileDigest, refuse } from './lib.mjs';

export const CHECK = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectPath = value => typeof value === 'string' && value.length <= 512
  && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const below = (name, dir) => {
  if (process.platform === 'win32') { name = name.toLowerCase(); dir = dir.toLowerCase(); }
  return name === dir || name.startsWith(`${dir}/`);
};
const invalid = () => refuse('acceptance spec invalid');

// JSON.parse followed by recursive object-key sorting (UTF-16 code unit order), compact JSON.stringify,
// UTF-8, no BOM or trailing newline. Arrays retain their order; no defaults are inserted into the digest.
export function canonicalSpec(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalSpec(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function acceptanceSpec(ctx, check) {
  if (typeof check !== 'string' || !CHECK.test(check)) refuse('acceptance check invalid');
  try {
    const target = plainFenced(ctx.root, `.rulith/acceptance/${check}.json`);
    if (!fs.statSync(target).isFile() || fs.statSync(target).size > 16384) invalid();
    const spec = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target)));
    if (!object(spec) || Object.keys(spec).some(k => !['command', 'cwd', 'files', 'output_dirs', 'shell'].includes(k))) invalid();
    if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(s => typeof s !== 'string' || !s || s.includes('\0'))) invalid();
    if (spec.cwd !== '.' && !projectPath(spec.cwd)) invalid();
    if (!object(spec.files)) invalid();
    for (const [name, digest] of Object.entries(spec.files))
      if (!projectPath(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) invalid();
    if (spec.shell !== undefined && typeof spec.shell !== 'boolean') invalid();
    if (spec.output_dirs !== undefined && (!Array.isArray(spec.output_dirs) || spec.output_dirs.some(dir =>
      !projectPath(dir) || below('.rulith/acceptance', dir) || below(dir, '.rulith/acceptance')
      || Object.keys(spec.files).some(name => below(name, dir))))) invalid();
    return { spec, digest: sha(canonicalSpec(spec)) };
  } catch { invalid(); }
}

// Enumerates this directory only. No dependency files, project tree, state, or Source lock are touched.
export function acceptanceEntries(ctx) {
  let directory;
  try {
    directory = plainFenced(ctx.root, '.rulith/acceptance');
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
      const check = name.slice(0, -5);
      try { return { check, ...acceptanceSpec(ctx, check) }; }
      catch { return { check, error: 'acceptance spec invalid' }; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    refuse('acceptance spec invalid');
  }
}

export function acceptanceRows(ctx, args) {
  if (Object.keys(args).length) refuse('acceptance takes no arguments');
  const rows = [], errors = [];
  let truncated = false;
  for (const entry of acceptanceEntries(ctx)) {
    // Untrusted invalid filenames never become unbounded receipt text.
    const row = entry.error ? { error: entry.error, ...(CHECK.test(entry.check) ? { check: entry.check } : {}) }
      : { check: entry.check, spec_digest: entry.digest, files: Object.keys(entry.spec.files).length };
    if (Buffer.byteLength(JSON.stringify({ rows, errors })) + Buffer.byteLength(JSON.stringify(row)) > 1800) { truncated = true; break; }
    // Worker return mappings apply to every `rows` item. Diagnostics belong to text-only rows,
    // otherwise one invalid spec would reject the entire receipt as missing scalar columns.
    (entry.error ? errors : rows).push(row);
  }
  return { rows, ...(errors.length ? { errors } : {}), ...(truncated ? { truncated: true } : {}) };
}

export function verifyAcceptanceFiles(ctx, spec) {
  for (const name of Object.keys(spec.files).sort()) {
    try {
      const target = plainFenced(ctx.root, name);
      if (!fs.statSync(target).isFile() || fileDigest(target) !== spec.files[name]) throw new Error();
    } catch { refuse(`acceptance file changed: ${name}`); }
  }
}

export function acceptanceOutputDirs(ctx) {
  const entries = acceptanceEntries(ctx);
  const dependencies = entries.flatMap(entry => Object.keys(entry.spec?.files ?? {}));
  // One spec's output must not hide another spec's frozen tests from subsequent tree receipts.
  return entries.flatMap(entry => entry.spec?.output_dirs ?? [])
    .filter(dir => !dependencies.some(name => below(name, dir)));
}
