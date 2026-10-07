// SPDX-License-Identifier: Apache-2.0

import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { gunzipSync } from 'node:zlib'

const BLOCK_SIZE = 512

function stringField(header, start, length) {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

function octalField(header, start, length) {
  const value = stringField(header, start, length).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid octal value in tar header')
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) throw new Error('tar entry is too large')
  return number
}

function paxPath(payload) {
  let offset = 0
  let result
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) throw new Error('invalid pax record')
    const lengthText = payload.subarray(offset, space).toString('ascii')
    if (!/^\d+$/.test(lengthText)) throw new Error('invalid pax record length')
    const length = Number(lengthText)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > payload.length || payload[end - 1] !== 0x0a)
      throw new Error('truncated pax record')
    const record = payload.subarray(space + 1, end - 1)
    const equals = record.indexOf(0x3d)
    if (equals !== -1 && record.subarray(0, equals).toString('ascii') === 'path')
      result = record.subarray(equals + 1).toString('utf8')
    offset = end
  }
  return result
}

function entryPath(rawPath, root, typeflag) {
  if (!rawPath || rawPath.includes('\0') || isAbsolute(rawPath) || win32.isAbsolute(rawPath)
    || /^[a-zA-Z]:/.test(rawPath)) throw new Error(`refusing absolute or empty tar path: ${rawPath}`)

  const parts = rawPath.replaceAll('\\', '/').split('/')
  if (parts.includes('..')) throw new Error(`refusing parent path in tar entry: ${rawPath}`)
  const safeParts = parts.filter(part => part !== '' && part !== '.')
  if (safeParts.length === 0 && typeflag !== '5') throw new Error(`refusing empty tar file path: ${rawPath}`)

  const target = resolve(root, ...safeParts)
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error(`refusing tar entry outside destination: ${rawPath}`)
  return target
}

function existingPath(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function ensureParents(root, target) {
  if (target === root) return
  const parents = relative(root, dirname(target)).split(sep).filter(Boolean)
  let current = root
  for (const part of parents) {
    current = join(current, part)
    const stat = existingPath(current)
    if (stat?.isSymbolicLink()) throw new Error(`refusing to follow a symlink while extracting: ${current}`)
    if (stat && !stat.isDirectory()) throw new Error(`tar parent is not a directory: ${current}`)
    if (!stat) mkdirSync(current)
  }
}

function ensureDirectory(root, target) {
  ensureParents(root, target)
  const stat = existingPath(target)
  if (stat?.isSymbolicLink()) throw new Error(`refusing to follow a symlink while extracting: ${target}`)
  if (stat && !stat.isDirectory()) throw new Error(`tar directory conflicts with a file: ${target}`)
  if (!stat) mkdirSync(target)
}

/** Extract regular files and directories from a gzip-compressed POSIX ustar archive. */
export function extractTgz(tgzPath, destinationDir) {
  mkdirSync(destinationDir, { recursive: true })
  const root = realpathSync(destinationDir)
  const archive = gunzipSync(readFileSync(tgzPath))
  let offset = 0

  let nextPath

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    const empty = header.every(byte => byte === 0)
    if (empty) {
      const next = archive.subarray(offset + BLOCK_SIZE, offset + 2 * BLOCK_SIZE)
      if (next.length !== BLOCK_SIZE || !next.every(byte => byte === 0))
        throw new Error('tar archive must end with two zero blocks')
      return
    }

    const size = octalField(header, 124, 12)
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    const paddedEnd = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (dataEnd > archive.length || paddedEnd > archive.length) throw new Error('truncated tar entry')
    const payload = archive.subarray(dataStart, dataEnd)
    const typeflag = String.fromCharCode(header[156])
    offset = paddedEnd

    // A pax extended header (`x`) can name the next entry; a global one (`g`) carries archive-wide
    // records and never a path that should rename every later entry, so it is skipped.
    if (typeflag === 'x') { nextPath = paxPath(payload); continue }
    if (typeflag === 'g') { paxPath(payload); continue }

    const name = stringField(header, 0, 100)
    const prefix = stringField(header, 345, 155)
    const headerPath = prefix ? `${prefix}/${name}` : name
    const path = nextPath ?? headerPath
    nextPath = undefined
    const target = entryPath(path, root, typeflag)

    if (typeflag === '5') ensureDirectory(root, target)
    else if (typeflag === '0' || typeflag === '\0') {
      ensureParents(root, target)
      const existing = existingPath(target)
      if (existing?.isSymbolicLink()) throw new Error(`refusing to follow a symlink while extracting: ${target}`)
      if (existing?.isDirectory()) throw new Error(`tar file conflicts with a directory: ${target}`)
      writeFileSync(target, payload)
    } else throw new Error(`refusing unsupported tar entry type: ${typeflag}`)
  }

  throw new Error('tar archive is missing its two zero end blocks')
}
