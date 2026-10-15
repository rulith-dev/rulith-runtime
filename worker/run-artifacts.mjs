// Run adapters describe project files; only the Worker takes custody and registers a reference.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { materialMediaType } from './material-store.mjs';

export async function runArtifactOutput(stdout, { sourceRoot, maxBytes, putResult }) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return stdout; }
  if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'artifacts')) return stdout;
  const fail = () => { throw new Error('Run adapter Artifact refused'); };
  if (!Array.isArray(envelope.artifacts) || envelope.artifacts.length !== 1
    || !Array.isArray(envelope.rows) || envelope.rows.length || !sourceRoot || !path.isAbsolute(sourceRoot)) fail();
  const artifact = envelope.artifacts[0];
  if (!artifact || Object.keys(artifact).sort().join(',') !== 'digest,mediaType,path'
    || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.includes('\\')
    || artifact.path.includes(':') || artifact.path.split('/').some(p => !p || p === '.' || p === '..')
    || typeof artifact.mediaType !== 'string' || !artifact.mediaType
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) fail();
  try { materialMediaType(artifact.mediaType); } catch { fail(); }
  const root = fs.realpathSync(sourceRoot), target = path.resolve(root, artifact.path);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail();
  for (let cursor = target; cursor !== root; cursor = path.dirname(cursor)) if (fs.lstatSync(cursor).isSymbolicLink()) fail();
  const limit = Math.min(Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 20 * 1024 * 1024, 20 * 1024 * 1024);
  const fd = fs.openSync(target, 'r');
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += n;
    if (length !== stat.size) fail();
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== artifact.digest) fail();
  const localArtifact = await putResult({ name: path.basename(target), bytes, mediaType: artifact.mediaType, encoding: 'base64' });
  return { rows: [], result: 'File attached as an Artifact.', localArtifact };
}
