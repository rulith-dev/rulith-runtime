import fs from 'node:fs';
import path from 'node:path';
import { plainFenced, refuse, refuseRootGit, settings, sha, textLimit } from './lib.mjs';

// No fuzzy matching: each context hunk must match exactly once after the preceding hunk.
function update(original, lines) {
  const source = original.split('\n').map((text, i, lines) => ({
    text: i < lines.length - 1 && text.endsWith('\r') ? text.slice(0, -1) : text,
    eol: i === lines.length - 1 ? '' : text.endsWith('\r') ? '\r\n' : '\n',
  }));
  const trailing = source.at(-1).text === '';
  if (trailing) source.pop();
  const defaultEol = source.find(line => line.eol)?.eol ?? '\n';
  let cursor = 0, index = 0, hunks = 0;
  while (index < lines.length) {
    const marker = lines[index++];
    if (marker !== '@@' && !marker.startsWith('@@ ')) refuse('patch format refused');
    // Codex's optional @@ section text anchors the following context.
    if (marker !== '@@') {
      const anchor = marker.slice(3);
      const found = source.findIndex((line, i) => i >= cursor && line.text === anchor);
      if (found < 0) refuse('patch hunk refused');
      cursor = found + 1;
    }
    const old = [], operations = [];
    let eof = false;
    while (index < lines.length && !lines[index].startsWith('@@')) {
      const line = lines[index++];
      if (line === '*** End of File') { eof = true; break; }
      if (line !== '' && ![' ', '+', '-'].includes(line[0])) refuse('patch format refused');
      const kind = line === '' ? ' ' : line[0], text = line.slice(1);
      if (kind !== '+') old.push(text);
      operations.push({ kind, text });
    }
    if (!old.length && source.length) refuse('patch hunk refused');
    const matches = [];
    for (let at = cursor; at <= source.length - old.length; at++)
      if ((!eof || at + old.length === source.length) && old.every((line, n) => source[at + n].text === line)) matches.push(at);
    if (matches.length !== 1) refuse('patch hunk refused');
    const next = [];
    let at = matches[0];
    for (let i = 0; i < operations.length;) {
      if (operations[i].kind === ' ') { next.push(source[at++]); i++; continue; }
      const removed = [], added = [];
      while (i < operations.length && operations[i].kind !== ' ') {
        const op = operations[i++];
        if (op.kind === '-') removed.push(source[at++]); else added.push(op.text);
      }
      const localEol = removed.find(line => line.eol)?.eol || next.at(-1)?.eol || source[at]?.eol || defaultEol;
      next.push(...added.map((text, n) => ({ text, eol: removed[n]?.eol ?? localEol })));
    }
    source.splice(matches[0], old.length, ...next);
    // Inserting after an unterminated line must create a separator; the new last line
    // keeps the original file's final-newline convention. Untouched lines keep their EOL.
    for (let i = 0; i < source.length - 1; i++) if (!source[i].eol) source[i] = { ...source[i], eol: defaultEol };
    if (source.length && !trailing) source[source.length - 1] = { ...source.at(-1), eol: '' };
    cursor = matches[0] + next.length;
    hunks++;
  }
  if (!hunks) refuse('patch format refused');
  return source.map(line => line.text + line.eol).join('');
}

function targetPath(ctx, name) {
  if (!name || name.length > 240 || name.includes('\\') || name.includes(':') || name.startsWith('/')
    || name.split('/').some(p => !p || p === '.' || p === '..')) refuse('path refused');
  const target = plainFenced(ctx.root, name);
  refuseRootGit(ctx, target);
  if (!fs.existsSync(path.dirname(target))) refuse('parent directory missing');
  return target;
}

export function applyPatch(ctx, patch) {
  const lines = textLimit(patch).replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') refuse('patch format refused');
  const changes = [], seen = new Set();
  for (let i = 0; i < lines.length;) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!match) refuse('patch format refused');
    const [, kind, name] = match;
    const target = targetPath(ctx, name);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (seen.has(key)) refuse('patch path repeated');
    seen.add(key);
    if (kind === 'Delete' && !settings(ctx.home).allow.has('delete')) refuse('delete refused');
    const exists = fs.existsSync(target);
    if (exists && !fs.lstatSync(target).isFile()) refuse('path refused');
    if (kind === 'Add' ? exists : !exists) refuse('patch hunk refused');
    const original = exists ? fs.readFileSync(target) : Buffer.alloc(0);
    if (original.length > 1024 * 1024 || !Buffer.from(original.toString('utf8')).equals(original)) refuse('patch file refused');
    const body = [];
    while (i < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i])) body.push(lines[i++]);
    let output = null;
    if (kind === 'Add') {
      if (body.some(line => !line.startsWith('+'))) refuse('patch format refused');
      output = Buffer.from(body.map(line => line.slice(1)).join('\n') + (body.length ? '\n' : ''));
    } else if (kind === 'Update') output = Buffer.from(update(original.toString('utf8'), body));
    else if (body.length) refuse('patch format refused');
    changes.push({ name, target, original, output, exists, mode: exists ? fs.statSync(target).mode : undefined });
  }
  // Keep every file row and its facts within the ordinary inline receipt budget.
  if (!changes.length || changes.length > 4) refuse('patch file count refused');
  const preview = changes.map(c => ({ path: c.name, prev_digest: sha(c.original), digest: sha(c.output ?? ''),
    readback_digest: sha(c.output ?? ''), bytes: c.output?.length ?? 0, from_gen: Number.MAX_SAFE_INTEGER, to_gen: Number.MAX_SAFE_INTEGER }));
  const reportRows = preview.flatMap(row => [row, row]); // invalidation replay and this mutation
  const facts = reportRows.flatMap(({ from_gen, to_gen, ...args }) => [
    { predicate: 'eng.file_state', args }, { predicate: 'eng.tree_step', args: { from_gen, to_gen } },
  ]);
  if (Buffer.byteLength(JSON.stringify({ result: JSON.stringify({ rows: reportRows }), facts })) > 7400) refuse('patch file count refused');
  for (const change of changes) {
    targetPath(ctx, change.name);
    if (fs.existsSync(change.target) !== change.exists || change.exists && !fs.readFileSync(change.target).equals(change.original)) refuse('file digest changed');
  }
  const applied = [];
  try {
    for (const change of changes) {
      if (change.output === null) { fs.unlinkSync(change.target); applied.push(change); }
      else {
        // Own a newly created file before adding it to rollback; an EEXIST race must
        // never remove somebody else's file. Existing files stay recoverable on short writes.
        const fd = fs.openSync(change.target, change.exists ? 'r+' : 'wx');
        applied.push(change);
        try { fs.writeFileSync(fd, change.output); fs.ftruncateSync(fd, change.output.length); }
        finally { fs.closeSync(fd); }
      }
    }
    return changes.map(change => {
      const readback = change.output === null ? Buffer.alloc(0) : fs.readFileSync(change.target);
      if (change.output !== null && !readback.equals(change.output)) refuse('read-back failed');
      return { path: change.name, prev_digest: sha(change.original), digest: sha(readback), readback_digest: sha(readback), bytes: readback.length };
    });
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.exists) { fs.writeFileSync(change.target, change.original); fs.chmodSync(change.target, change.mode); }
      else if (fs.existsSync(change.target)) fs.unlinkSync(change.target);
    }
    throw error;
  }
}
