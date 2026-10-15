import fs from 'node:fs';
import path from 'node:path';
import { plainFenced, sha, refuse } from './lib.mjs';
import { generalSettings } from './general-settings.mjs';

export function readImage(ctx, args) {
  if (typeof args.path !== 'string' || !args.path) refuse('path refused');
  const target = plainFenced(ctx.root, args.path);
  const limit = generalSettings(ctx.home).imageMaxBytes;
  if (!fs.statSync(target).isFile()) refuse('image refused');
  if (fs.statSync(target).size > limit) refuse('image size exceeded');
  const fd = fs.openSync(target, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += n;
    if (length > limit) refuse('image size exceeded');
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  let mediaType;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mediaType = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) mediaType = 'image/gif';
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') mediaType = 'image/webp';
  else refuse('image refused');
  return { rows: [], 'rulith.artifacts': [{ path: path.relative(ctx.root, target).replaceAll('\\', '/'), mediaType, digest: `sha256:${sha(bytes)}` }] };
}
