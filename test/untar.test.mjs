// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import test from 'node:test'

import { extractTgz } from './support/untar.mjs'

const ROOT = dirname(import.meta.dirname)

function putString(buffer, value, start, width) {
  const bytes = Buffer.from(value, 'utf8')
  assert.ok(bytes.length <= width, `${value} does not fit in a ustar field`)
  bytes.copy(buffer, start)
}

function putOctal(buffer, value, start, width) {
  const encoded = `${value.toString(8).padStart(width - 1, '0')}\0`
  putString(buffer, encoded, start, width)
}

function ustarEntry(name, bytes = Buffer.alloc(0), typeflag = '0') {
  const header = Buffer.alloc(512)
  putString(header, name, 0, 100)
  putOctal(header, 0o644, 100, 8)
  putOctal(header, 0, 108, 8)
  putOctal(header, 0, 116, 8)
  putOctal(header, bytes.length, 124, 12)
  putOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = typeflag.charCodeAt(0)
  putString(header, 'ustar\0', 257, 6)
  putString(header, '00', 263, 2)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `
  putString(header, checksumText, 148, 8)

  const padding = Buffer.alloc((512 - bytes.length % 512) % 512)
  return Buffer.concat([header, bytes, padding])
}

function makeTgz(...entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`)
  let length = body.length + 2
  while (true) {
    const prefix = Buffer.from(`${length} `)
    const actualLength = prefix.length + body.length
    if (actualLength === length) return Buffer.concat([prefix, body])
    length = actualLength
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('npm pack extracts package files byte for byte without a system tar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rulith-untar-pack-'))
  try {
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const npmrc = join(directory, 'empty.npmrc')
    const globalNpmrc = join(directory, 'empty-global.npmrc')
    writeFileSync(npmrc, '')
    writeFileSync(globalNpmrc, '')
    const packed = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, npm_config_cache: join(directory, 'npm-cache'), npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc },
    })
    assert.equal(packed.status, 0, packed.stderr)
    const filename = JSON.parse(packed.stdout)[0].filename
    const destination = join(directory, 'extract')
    extractTgz(join(directory, filename), destination)
    assert.equal(existsSync(join(destination, 'package/docs/releasing.md')), true,
      'the published CONTRIBUTING.md release link must have its target')

    for (const file of ['package.json', 'worker/rulith-worker.mjs']) {
      assert.equal(
        sha256(readFileSync(join(destination, 'package', file))),
        sha256(readFileSync(join(ROOT, file))),
        `${file} differs between the packed archive and working tree`,
      )
    }
  } finally {
    assert.equal(dirname(directory), tmpdir())
    rmSync(directory, { recursive: true, force: true })
  }
})

test('extractTgz refuses a parent path entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rulith-untar-parent-'))
  try {
    const archive = join(directory, 'parent.tgz')
    writeFileSync(archive, makeTgz(ustarEntry('../escape', Buffer.from('no'))))
    assert.throws(() => extractTgz(archive, join(directory, 'extract')), /parent path/)
    assert.equal(existsSync(join(directory, 'escape')), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('extractTgz refuses an absolute path entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rulith-untar-absolute-'))
  try {
    const archive = join(directory, 'absolute.tgz')
    writeFileSync(archive, makeTgz(ustarEntry('/outside', Buffer.from('no'))))
    assert.throws(() => extractTgz(archive, join(directory, 'extract')), /absolute or empty tar path/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('extractTgz applies a local pax path record and skips a global pax header', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rulith-untar-pax-'))
  try {
    const local = join(directory, 'local.tgz')
    const global = join(directory, 'global.tgz')
    writeFileSync(local, makeTgz(
      ustarEntry('PaxHeaders/local', paxRecord('path', 'package/local/name.txt'), 'x'),
      ustarEntry('ignored-local-name', Buffer.from('local')),
    ))
    writeFileSync(global, makeTgz(
      ustarEntry('GlobalHead', paxRecord('path', 'package/global/name.txt'), 'g'),
      ustarEntry('package/kept-name.txt', Buffer.from('global')),
    ))

    const destination = join(directory, 'extract')
    extractTgz(local, destination)
    extractTgz(global, destination)
    assert.equal(readFileSync(join(destination, 'package/local/name.txt'), 'utf8'), 'local')
    // A global header carries archive-wide records; it does not rename the entries after it.
    assert.equal(readFileSync(join(destination, 'package/kept-name.txt'), 'utf8'), 'global')
    assert.equal(existsSync(join(destination, 'package/global/name.txt')), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
