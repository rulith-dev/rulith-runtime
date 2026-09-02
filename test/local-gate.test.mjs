// SPDX-License-Identifier: Apache-2.0
/**
 * The Local UI's per-run key gates every route, including the page itself.
 *
 * `/` used to be answered before the gate ran and had the key substituted into the
 * HTML, so `curl 127.0.0.1:7790/` from any process on the machine returned a working
 * key for `/control`, `/cases` and `/status`. Loopback is shared by every local
 * account, every application, and anything a browser page can reach; the key is the
 * only thing separating them, and the page was handing it out.
 *
 * These arms drive the real host over real HTTP. Two of them are calibration: an
 * assertion that "GET / is refused" would also pass against a host that refused
 * everything, and an assertion that the page has no key would pass against a page that
 * had been emptied.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { localPage } from '../local/local-ui.mjs'

const KEY = 'local-gate-key'

/** Start the real host on a free loopback port with no child roles to spawn. */
async function withHost(run) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-gate-'))
  const probe = createServer()
  let port
  await new Promise((ready) => probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(ready) }))
  const config = defaultLocalConfig()
  // Point both roles at a path that does not exist: the host reports the missing
  // runtime as an event and starts no child, which is all these arms need.
  config.paths = { agent: join(dir, 'absent-agent.mjs'), worker: join(dir, 'absent-worker.mjs') }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port, key: KEY })
  try {
    await host.listen()
    await run({ port, host })
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Raw request so a hostile `Host` header can be sent; fetch forbids overriding it. */
function rawGet(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), 'Connection: close', '', '']
    const socket = new Socket()
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { raw += chunk })
    socket.on('error', fail)
    socket.on('close', () => {
      const [head, ...rest] = raw.split('\r\n\r\n')
      done({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, body: rest.join('\r\n\r\n') })
    })
    socket.connect(port, '127.0.0.1', () => socket.end(lines.join('\r\n')))
  })
}
test('GET / without the key is refused with 401 and returns no page', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, '/', { Host: `127.0.0.1:${port}` })
    assert.equal(response.status, 401, response.head)
    assert.doesNotMatch(response.body, /<!DOCTYPE html>/i, 'the workbench page was served to an unauthenticated caller')
    assert.doesNotMatch(response.body, new RegExp(KEY), 'the refusal body disclosed the per-run key')
    assert.match(response.body, /Missing or invalid Rulith Local key/)
  })
})

test('GET /?k=<key> with a rebound Host is refused with 403', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, `/?k=${KEY}`, { Host: 'rulith-local.attacker.example' })
    assert.equal(response.status, 403, response.head)
    assert.doesNotMatch(response.body, /<!DOCTYPE html>/i)
    assert.match(response.body, /Non-local Host rejected/)
  })
})

test('GET /?k=<key> with a cross-origin Origin is refused with 403', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example' })
    assert.equal(response.status, 403, response.head)
    assert.doesNotMatch(response.body, /<!DOCTYPE html>/i)
  })
})

test('GET /?k=<key> from loopback serves the workbench page (calibration)', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}` })
    assert.equal(response.status, 200, response.head)
    assert.match(response.head, /content-type: text\/html/i)
    assert.match(response.head, /cache-control: no-store/i)
    assert.match(response.body, /<!DOCTYPE html>/i)
    assert.match(response.body, /New Case/, 'the page must still be the workbench, not an empty shell')
  })
})

test('the served page carries no key of its own and takes it from its address', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}` })
    assert.doesNotMatch(response.body, new RegExp(KEY),
      'the page embedded the per-run key, so any copy of the response is a working credential')
    assert.doesNotMatch(response.body, /__KEY__/, 'a leftover substitution placeholder means the key was meant to be injected')
    assert.match(localPage, /new URLSearchParams\(location\.search\)\.get\('k'\)/)
  })
})

test('the page, once loaded with the key, can still reach the data routes', async () => {
  // The end the fix must not break: a browser opened at the printed URL keeps working.
  await withHost(async ({ port }) => {
    const status = await fetch(`http://127.0.0.1:${port}/status?k=${KEY}`)
    assert.equal(status.status, 200)
    const body = await status.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, 'agent')

    const events = await fetch(`http://127.0.0.1:${port}/events?k=${KEY}`, { headers: { accept: 'text/event-stream' } })
    assert.equal(events.status, 200)
    await events.body.cancel()

    const unauthorized = await fetch(`http://127.0.0.1:${port}/status`)
    assert.equal(unauthorized.status, 401, 'the data routes must refuse a missing key the same way the page does')
  })
})

test('the CLI prints a URL that carries the key it just minted', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'local', 'rulith-local.mjs'), 'utf8')
  assert.match(source, /Local UI: http:\/\/127\.0\.0\.1:\$\{host\.port\}\/\?k=\$\{host\.key\}/,
    'the page is only reachable with the key, so the printed URL is the only way in')
})
