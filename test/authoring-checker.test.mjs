import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { downloadPinnedAuthoringFile } from '../local/authoring-checker.mjs'

const fixture = () => {
  const bytes = Buffer.alloc(1024 * 1024 + 17)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  return {
    bytes,
    file: {
      url: 'https://console.rulith.ai/downloads/authoring/' + 'a'.repeat(40) + '/local-authoring.jar',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}

function ranged(bytes, { corrupt = false, failOnce = false, unavailableOnce = false, incompleteOnce = false } = {}) {
  let active = 0, maximum = 0, retried = false, unavailable = false, incomplete = false
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['Accept-Encoding'], 'identity')
    assert.ok(options.signal)
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)
    assert.ok(match, 'every request must be a bounded range')
    const start = Number(match[1]), end = Number(match[2])
    if (failOnce && start === 0 && !retried) { retried = true; throw new Error('transient connection failure') }
    if (unavailableOnce && start === 0 && !unavailable) { unavailable = true; return new Response('retry', { status: 503 }) }
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    const part = Buffer.from(bytes.subarray(start, end + 1))
    if (incompleteOnce && start === 0 && !incomplete) { incomplete = true; return new Response(part.subarray(0, part.length - 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } }) }
    if (corrupt && start === 0) part[0] ^= 1
    return new Response(part, { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': String(part.length),
    } })
  }
  return { fetchImpl, maximum: () => maximum, retried: () => retried, unavailable: () => unavailable, incomplete: () => incomplete }
}

test('pinned checker download assembles bounded concurrent ranges and recovers one transient failure', async () => {
  const { bytes, file } = fixture()
  const source = ranged(bytes, { failOnce: true })
  assert.deepEqual(await downloadPinnedAuthoringFile(file, source.fetchImpl), bytes)
  assert.equal(source.retried(), true)
  assert.ok(source.maximum() > 1 && source.maximum() <= 6)
})

test('pinned checker download accepts a full pinned body when a server ignores Range', async () => {
  const { bytes, file } = fixture()
  const requests = []
  assert.deepEqual(await downloadPinnedAuthoringFile(file, async (_url, options) => {
    requests.push(options.headers)
    return new Response(bytes, { status: 200 })
  }), bytes)
  assert.equal(requests.length, 2)
  assert.ok(requests[0].Range)
  assert.equal(requests[1].Range, undefined)
  const altered = Buffer.from(bytes)
  altered[0] ^= 1
  await assert.rejects(downloadPinnedAuthoringFile(file, async () => new Response(altered, { status: 200 })),
    /does not match its release digest/)
})

test('pinned checker download falls back when a later range loses Range support', async () => {
  const { bytes, file } = fixture()
  let whole = 0
  const fetchImpl = async (_url, options) => {
    if (!options.headers.Range) { whole++; return new Response(bytes, { status: 200 }) }
    const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)
    const start = Number(startText), end = Number(endText)
    if (start > 0) return new Response(bytes, { status: 200 })
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
    } })
  }
  assert.deepEqual(await downloadPinnedAuthoringFile(file, fetchImpl), bytes)
  assert.equal(whole, 1)
})

test('pinned checker download retries transient server and incomplete range responses', async () => {
  const { bytes, file } = fixture()
  const unavailable = ranged(bytes, { unavailableOnce: true })
  assert.deepEqual(await downloadPinnedAuthoringFile(file, unavailable.fetchImpl), bytes)
  assert.equal(unavailable.unavailable(), true)
  const incomplete = ranged(bytes, { incompleteOnce: true })
  assert.deepEqual(await downloadPinnedAuthoringFile(file, incomplete.fetchImpl), bytes)
  assert.equal(incomplete.incomplete(), true)
})

test('pinned checker download rejects same-length corrupt ranges after whole-file digest check', async () => {
  const { bytes, file } = fixture()
  await assert.rejects(downloadPinnedAuthoringFile(file, ranged(bytes, { corrupt: true }).fetchImpl),
    /does not match its release digest/)
})

test('pinned checker download stops outstanding transfers when the caller cancels', async () => {
  const { file } = fixture()
  const controller = new AbortController()
  let cancelled = 0
  const pending = downloadPinnedAuthoringFile(file, async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { cancelled++; reject(options.signal.reason) }, { once: true })
  }), { signal: controller.signal })
  controller.abort(new Error('operator cancelled preparation'))
  await assert.rejects(pending, /operator cancelled preparation/)
  assert.ok(cancelled >= 1)
})

test('pinned checker download rejects an oversized first range without retrying it', async () => {
  const { bytes, file } = fixture()
  let requests = 0
  await assert.rejects(downloadPinnedAuthoringFile(file, async () => {
    requests++
    return new Response(Buffer.alloc(256 * 1024 + 1), { status: 206, headers: {
      'Content-Range': `bytes 0-${256 * 1024 - 1}/${bytes.length}`,
    } })
  }), /exceeds its declared size/)
  assert.equal(requests, 1)
})
