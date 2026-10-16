import fs from 'node:fs';
import { sha, plainFenced, fileDigest, refuse } from './lib.mjs';

// A check name starts with a letter: the Kernel would read an all-digit name as a number, and the
// signed leaf's first argument must stay text.
export const CHECK = /^[a-z][a-z0-9_-]{0,39}$/;
export const MAX_FILES = 32;
// The Worker's inline receipt budget is 8 KiB on rulith.ai; a check_spec receipt keeps 1 KiB of headroom
// for the envelope. Measured as the Worker measures it: the adapter output as text, plus its facts.
export const RECEIPT_BYTES = 7168;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectPath = value => typeof value === 'string' && value.length <= 512
  && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
// An output directory is a literal path: `*` and `?` would read as glob patterns to a reader and to the tree walk.
const outputPath = value => projectPath(value) && !/[*?]/.test(value);
export const below = (name, dir) => {
  if (process.platform === 'win32') { name = name.toLowerCase(); dir = dir.toLowerCase(); }
  return name === dir || name.startsWith(`${dir}/`);
};
const invalid = () => refuse('acceptance spec invalid');

// JSON.parse accepts a repeated key and keeps the last value; a reader of the file may see the first.
// One meaning only: any object with a repeated key (compared after unescaping) is refused.
export function duplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (/\s/.test(text[next] ?? '')) next++;
      const keys = stack.at(-1);
      if (text[next] === ':' && keys) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (keys.has(key)) return true;
        keys.add(key);
      }
      i = end;
    }
  }
  return false;
}

// The digest covers the spec with its defaults written out (`output_dirs: []`, `shell: false`), so it is a
// function of the eng.check_spec fact alone. Keys are sorted recursively (UTF-16 code unit order), arrays keep
// their order, JSON.stringify encodes keys and values, no whitespace; SHA-256 of the UTF-8 bytes, no BOM or newline.
export function canonicalSpec(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalSpec(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const normalizedSpec = spec => ({ command: spec.command, cwd: spec.cwd, files: spec.files,
  output_dirs: spec.output_dirs ?? [], shell: spec.shell === true });

export function acceptanceSpec(ctx, check) {
  if (typeof check !== 'string' || !CHECK.test(check)) refuse('acceptance check invalid');
  try {
    const target = plainFenced(ctx.root, `.rulith/acceptance/${check}.json`);
    if (!fs.statSync(target).isFile() || fs.statSync(target).size > 16384) invalid();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target));
    const spec = JSON.parse(text);
    if (duplicateKeys(text)) invalid();
    if (!object(spec) || Object.keys(spec).some(k => !['command', 'cwd', 'files', 'output_dirs', 'shell'].includes(k))) invalid();
    if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(s => typeof s !== 'string' || !s || s.includes('\0'))) invalid();
    if (spec.cwd !== '.' && !projectPath(spec.cwd)) invalid();
    if (!object(spec.files) || Object.keys(spec.files).length > MAX_FILES) invalid();
    for (const [name, digest] of Object.entries(spec.files))
      if (!projectPath(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) invalid();
    if (spec.shell !== undefined && typeof spec.shell !== 'boolean') invalid();
    if (spec.output_dirs !== undefined && (!Array.isArray(spec.output_dirs) || spec.output_dirs.some(dir =>
      !outputPath(dir) || below('.rulith/acceptance', dir) || below(dir, '.rulith/acceptance')
      || Object.keys(spec.files).some(name => below(name, dir))))) invalid();
    const normal = normalizedSpec(spec);
    return { spec: normal, digest: sha(canonicalSpec(normal)) };
  } catch { invalid(); }
}

// The command as one readable line: a word without whitespace, quotes or control characters stands as written;
// any other word is a JSON string. Reversible: a token that starts with `"` is JSON, every other token is literal.
export const commandLine = command =>
  command.map(word => /^[^\s"\x00-\x1f\x7f]+$/.test(word) ? word : JSON.stringify(word)).join(' ');

// The eng.check_spec row: everything the spec digest denotes, so the person who signs a leaf reads on the Board
// what the digest freezes. `files` and `output_dirs` are JSON text (facts hold scalars only).
export function checkSpecRow(check, { spec, digest }) {
  const row = { check, spec_digest: digest, command: commandLine(spec.command), cwd: spec.cwd, shell: spec.shell,
    output_dirs: JSON.stringify(spec.output_dirs),
    files: JSON.stringify(Object.keys(spec.files).sort().map(name => ({ path: name, sha256: spec.files[name] }))) };
  if (receiptBytes({ rows: [row] }) > RECEIPT_BYTES) refuse('acceptance spec too large');
  return row;
}
const receiptBytes = out => Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), reason: '',
  facts: out.rows.map(args => ({ predicate: 'eng.check_spec', args })) }));

// Enumerates this directory only. No dependency files, project tree, state, or Source lock are touched.
// A directory that cannot be listed (a file, a link, unreadable) is reported, never thrown: only this tool reads it.
export function acceptanceEntries(ctx) {
  let names;
  try {
    names = fs.readdirSync(plainFenced(ctx.root, '.rulith/acceptance'));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null;
  }
  return names.filter(name => name.endsWith('.json')).sort().map(name => {
    const check = name.slice(0, -5);
    try { return { check, row: checkSpecRow(check, acceptanceSpec(ctx, check)) }; }
    catch (error) { return { check, error: error.message === 'acceptance spec too large' ? error.message : 'acceptance spec invalid' }; }
  });
}

export function acceptanceRows(ctx, args) {
  if (Object.keys(args).length) refuse('acceptance takes no arguments');
  const entries = acceptanceEntries(ctx);
  if (entries === null) return { rows: [], errors: [{ error: 'acceptance directory unreadable' }] };
  const rows = [], errors = [];
  let truncated = false;
  for (const entry of entries) {
    // Untrusted invalid filenames never become unbounded receipt text.
    const row = entry.error ? { error: entry.error, ...(CHECK.test(entry.check) ? { check: entry.check } : {}) } : entry.row;
    // Worker return mappings apply to every `rows` item. Diagnostics belong to text-only rows,
    // otherwise one invalid spec would reject the entire receipt as missing scalar columns.
    const next = entry.error ? { rows, errors: [...errors, row] } : { rows: [...rows, row], errors };
    if (receiptBytes({ ...next, truncated: true }) > RECEIPT_BYTES) { truncated = true; break; }
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

// True when every path the run changed lies in one of the spec's own output directories. Only the spec's own
// eng.test@2 run is measured this way; every other tool hashes those directories like any other.
export function onlyOutput(paths, outputDirs) {
  return paths.length > 0 && paths.every(name => outputDirs.some(dir => below(name, dir)));
}
