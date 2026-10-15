import fs from 'node:fs';
import { fenced, exclusions, skipped, refuse } from './lib.mjs';

// Deliberately small glob grammar: *, **, ?, and character classes. No absolute paths.
export function globMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || pattern.includes('\\')
    || pattern.startsWith('/') || pattern.includes(':') || pattern.split('/').some(p => p === '..' || p === '.')) refuse('glob refused');
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; tokens.push({ kind: 'directories' }); }
      else tokens.push({ kind: 'any' });
    } else if (ch === '*') tokens.push({ kind: 'star' });
    else if (ch === '?') tokens.push({ kind: 'one' });
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0 || !/^[!A-Za-z0-9_-]+$/.test(pattern.slice(i + 1, end))) refuse('glob refused');
      let regex;
      try { regex = new RegExp('^[' + pattern.slice(i + 1, end).replace(/^!/, '^') + ']$'); }
      catch { refuse('glob refused'); }
      tokens.push({ kind: 'class', regex }); i = end;
    } else tokens.push({ kind: 'literal', value: ch });
  }
  if (tokens.filter(t => ['any', 'star', 'directories'].includes(t.kind)).length > 20) refuse('glob complexity refused');
  // Five seconds covers traversal plus matching on ordinary repositories, including
  // slower disks. Token/name/walk caps bound memory and per-name matching work.
  const deadline = performance.now() + 5000;
  const check = () => { if (performance.now() > deadline) refuse('glob complexity refused'); };
  // Iterative prefix matching uses O(name.length) memory, with no recursion or backtracking.
  // The wall-clock deadline is shared by every match in this walk.
  return { check, test(name) {
    check();
    if (name.length > 32768) refuse('glob complexity refused');
    let previous = new Uint8Array(name.length + 1); previous[0] = 1;
    for (const token of tokens) {
      check();
      const next = new Uint8Array(name.length + 1);
      let directoryPrefix = false;
      for (let j = 0; j <= name.length; j++) {
        const ch = name[j - 1];
        if (token.kind === 'any' || token.kind === 'star')
          next[j] = previous[j] || j > 0 && (token.kind === 'any' || ch !== '/') && next[j - 1];
        else if (token.kind === 'directories') {
          next[j] = previous[j] || j > 0 && ch === '/' && directoryPrefix;
          directoryPrefix ||= !!previous[j];
        } else next[j] = j > 0 && previous[j - 1] && (token.kind === 'literal' ? token.value === ch
          : ch !== '/' && (token.kind === 'one' || token.regex.test(ch)));
      }
      previous = next;
    }
    return !!previous[name.length];
  } };
}

export function globFiles(ctx, { pattern, limit = 64 }) {
  const regex = globMatcher(pattern);
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) refuse('glob limit refused');
  const skip = exclusions(ctx), names = [];
  let visited = 0;
  function walk(prefix) {
    regex.check();
    for (const entry of fs.readdirSync(fenced(ctx.root, prefix || '.'), { withFileTypes: true })) {
      regex.check();
      if (++visited > 20000) refuse('glob walk limit exceeded');
      const name = prefix + entry.name;
      if (entry.name === '.git' || entry.isSymbolicLink() || skipped(skip, name)) continue;
      if (entry.isDirectory()) walk(name + '/');
      else if (entry.isFile() && regex.test(name)) names.push(name);
    }
  }
  walk('');
  const rows = [];
  for (const name of names.sort()) {
    const row = { path: name };
    if (rows.length === limit || Buffer.byteLength(JSON.stringify([...rows, row])) > 1800) break;
    rows.push(row);
  }
  return { rows, ...(rows.length < names.length ? { truncated: true } : {}) };
}
