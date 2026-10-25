// SPDX-License-Identifier: Apache-2.0
/**
 * The Local UI's per-run key gates every route, including the page itself.
 *
 * `/` used to be answered before the gate ran and had the key substituted into the
 * HTML, so `curl 127.0.0.1:7790/` from any process on the machine returned a working
 * key for `/worker-setting`, `/turn/stop`, `/cases` and `/status`. Loopback is shared by every local
 * account, every application, and anything a browser page can reach; the key is the
 * only thing separating them, and the page was handing it out.
 *
 * These arms drive the real host over real HTTP. Two of them are calibration: an
 * assertion that "GET / is refused" would also pass against a host that refused
 * everything, and an assertion that the page has no key would pass against a page that
 * had been emptied.
 * The host fixture also checks that simultaneous listeners retain distinct ports,
 * so parallel release checks can exercise these HTTP gates without port handoffs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'

const KEY = 'local-gate-key'

/** Start the real host on a free loopback port with no child roles to spawn. */
async function withHost(run) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-gate-'))
  const config = defaultLocalConfig()
  // Point both roles at a path that does not exist: the host reports the missing
  // runtime as an event and starts no child, which is all these arms need.
  config.paths = { agent: join(dir, 'absent-agent.mjs'), worker: join(dir, 'absent-worker.mjs') }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: KEY })
  try {
    await host.listen()
    await run({ port: host.port, host })
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Local hosts retain distinct system-assigned ports while both are listening', async () => {
  await withHost(async ({ port: first }) => {
    await withHost(async ({ port: second }) => {
      assert.ok(first > 0 && second > 0)
      assert.notEqual(first, second)
      for (const port of [first, second]) {
        const response = await fetch(`http://127.0.0.1:${port}/status?k=${KEY}`)
        assert.equal(response.status, 200)
        assert.equal((await response.json()).ok, true)
      }
    })
  })
})

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
    assert.doesNotMatch(response.body, /<!DOCTYPE html>/i, 'a page was served to an unauthenticated caller')
    assert.doesNotMatch(response.body, new RegExp(KEY), 'the refusal body disclosed the per-run key')
    assert.match(response.body, /Missing or invalid Rulith key/)
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

test('GET /?k=<key> from loopback serves no page: the English workbench page is retired', async () => {
  await withHost(async ({ port }) => {
    const response = await rawGet(port, `/?k=${KEY}`, { Host: `127.0.0.1:${port}` })
    assert.equal(response.status, 404, response.head)
    assert.doesNotMatch(response.body, /<!DOCTYPE html>/i)
    assert.doesNotMatch(response.body, new RegExp(KEY), 'the answer disclosed the per-run key')
    for (const path of ['/setup', '/worker-tools', '/mcp-services']) {
      const page = await rawGet(port, `${path}?k=${KEY}`, { Host: `127.0.0.1:${port}` })
      assert.equal(page.status, 404, `${path}: ${page.head}`)
      assert.doesNotMatch(page.body, /<!DOCTYPE html>/i)
    }
  })
})

test('with the key, the data routes answer', async () => {
  // The end the fix must not break: a client holding the key keeps working.
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
    assert.equal(unauthorized.status, 401, 'the data routes must refuse a missing key')
  })
})
