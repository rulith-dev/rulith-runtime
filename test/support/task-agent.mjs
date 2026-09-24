#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * An Agent stand-in that serves the task endpoint and records exactly what it was sent.
 *
 * The Local host forwards a case submission to the Agent over loopback, and what matters
 * about attachments is *what crosses that hop*: metadata and a host-only ticket, never a
 * byte of content. Asserting that against the real Agent would also be asserting against the
 * model loop; asserting it here is asserting against the hop.
 *
 * Every body reaches `RULITH_TEST_TASK_LOG` as one JSON line, alongside the environment this
 * child was actually given — so an arm about "the Agent was handed the delivery endpoint and
 * not the page key" reads what the child received rather than what the host meant to pass.
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const LOG = process.env.RULITH_TEST_TASK_LOG ?? ''
const KEY = process.env.RULITH_SERVE_KEY ?? ''
const PORT = Number(process.env.RULITH_SERVE_PORT ?? 7799)
const record = (entry) => { if (LOG !== '') appendFileSync(LOG, `${JSON.stringify(entry)}\n`) }

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = JSON.parse(raw || '{}') } catch { body = { unparsed: raw } }
    record({ kind: 'task', path: request.url, authorized: request.headers['x-rulith-serve'] === KEY, body })
    response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, id: 'task-1', queued: 1, sessionKey: String(body.sessionKey ?? '') }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  record({
    kind: 'start',
    environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^RULITH_/.test(name))),
  })
  process.send?.({ protocol: 'rulith-local-event', event: { type: 'start', t: Date.now(),
    agentId: process.env.RULITH_TEST_AGENT_ID ?? 'agent-test-1' } })
})
const beat = setInterval(() => {}, 1000)
const leave = () => { clearInterval(beat); server.close(() => process.exit(0)) }
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
process.on('message', (message) => { if (message?.operation === 'stop') leave() })
