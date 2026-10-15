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
  // Memoized matching avoids exponential regular-expression backtracking on model input.
  return { test(name) {
    const memo = new Map();
    function match(i, j) {
      const key = i + ':' + j;
      if (memo.has(key)) return memo.get(key);
      let yes;
      if (i === tokens.length) yes = j === name.length;
      else {
        const token = tokens[i], ch = name[j];
        if (token.kind === 'any' || token.kind === 'star')
          yes = match(i + 1, j) || j < name.length && (token.kind === 'any' || ch !== '/') && match(i, j + 1);
        else if (token.kind === 'directories') {
          yes = match(i + 1, j);
          for (let at = name.indexOf('/', j); !yes && at >= 0; at = name.indexOf('/', at + 1)) yes = match(i + 1, at + 1);
        } else yes = j < name.length && (token.kind === 'literal' ? token.value === ch
          : ch !== '/' && (token.kind === 'one' || token.regex.test(ch))) && match(i + 1, j + 1);
      }
      memo.set(key, yes); return yes;
    }
    return match(0, 0);
  } };
}

export function globFiles(ctx, { pattern, limit = 64 }) {
  const regex = globMatcher(pattern);
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) refuse('glob limit refused');
  const skip = exclusions(ctx), names = [];
  let visited = 0;
  function walk(prefix) {
    for (const entry of fs.readdirSync(fenced(ctx.root, prefix || '.'), { withFileTypes: true })) {
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
