// SPDX-License-Identifier: Apache-2.0
// An owned, offline role fixture: records process boundaries and drains a simulated execution.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
const agent = process.argv.includes('--serve')
const role = agent ? 'agent' : 'worker'
const record = (type, extra = {}) => appendFileSync(process.env.RULITH_TEST_LIFECYCLE_LOG, JSON.stringify({
  type, role, pid: process.pid, at: Date.now(), model: process.env.RULITH_MODEL,
  key: process.env.RULITH_CONNECTION_KEY, ...extra,
}) + '\n')
const emit = (type, extra = {}) => process.send?.({ protocol: 'rulith-local-event', event: { type, t: Date.now(), ...extra } })
record('spawn')
if (process.env.RULITH_TEST_EXIT_CODE) process.exit(Number(process.env.RULITH_TEST_EXIT_CODE))
let busy = false, stopping = false
const leave = () => { record('exit'); process.exit(0) }
const drained = () => setTimeout(leave, Number(process.env.RULITH_TEST_DRAIN_MS ?? 0))
const server = agent ? createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const authorized = req.headers['x-rulith-serve'] === process.env.RULITH_SERVE_KEY
  if (req.url === '/turn/stop') {
    record('turn-stop', { body, authorized })
    res.writeHead(authorized ? 200 : 403, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ ok: authorized, state: 'stopping', sessionKey: body.sessionKey }))
  }
  if (stopping) {
    record('task-refused', { body })
    res.writeHead(503, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ ok: false, teaching: 'The Agent is reloading between turns.' }))
  }
  const id = randomUUID(); busy = true
  record('turn-start', { body }); emit('task-start', { id, session: body.sessionKey, text: body.text })
  res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id, sessionKey: body.sessionKey }))
  setTimeout(() => {
    record('turn-done'); emit('task-done', { id, session: body.sessionKey, sessionKey: body.sessionKey, outcome: 'conversation' })
    busy = false; if (stopping) drained()
  }, Number(process.env.RULITH_TEST_TURN_MS ?? 100))
}) : undefined
const ready = () => {
  emit(agent ? 'start' : 'up', { managedStop: true, ...(agent ? { agentId: 'test-agent' }
    : process.env.RULITH_TEST_AVAILABILITY ? { reportsAvailability: true } : {}) })
  if (!agent && !process.env.RULITH_TEST_AVAILABILITY && !process.env.RULITH_TEST_NO_AVAILABILITY) emit('availability', { state: 'online' })
  if (!agent && process.env.RULITH_TEST_AVAILABILITY) {
    for (const { after, state } of JSON.parse(process.env.RULITH_TEST_AVAILABILITY)) {
      setTimeout(() => emit('availability', { state }), after)
    }
  }
}
if (agent) server.listen(Number(process.env.RULITH_SERVE_PORT), '127.0.0.1', ready)
else ready()
if (process.env.RULITH_TEST_CRASH_MS) setTimeout(() => { record('crash'); process.exit(1) }, Number(process.env.RULITH_TEST_CRASH_MS))
process.on('message', message => {
  if (message?.protocol !== 'rulith-local-control' || !['stop', 'reload'].includes(message.operation) || stopping) return
  stopping = true; record('drain')
  if (agent) { if (!busy) drained() }
  else drained()
})
setInterval(() => {}, 1000)
