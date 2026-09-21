#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A Worker stand-in that answers the launching host's custody hop.
 *
 * What the Local host contributes to a local read is routing and its own disclosure check; what
 * the custodian contributes is the Gateway claim and the bytes. Those are exercised against the
 * real Worker in `worker-material-delivery.test.mjs`. This stand-in exists so the *host* arms
 * can drive the hop without also standing up a Gateway — it answers whatever
 * `RULITH_TEST_CUSTODY_REPLY` scripts, and records what it was asked.
 */
import { appendFileSync } from 'node:fs'

const LOG = process.env.RULITH_TEST_TASK_LOG ?? ''
const REPLY = JSON.parse(process.env.RULITH_TEST_CUSTODY_REPLY ?? '{"ok":false,"errorCode":"material_custodian_offline"}')
const record = (entry) => { if (LOG !== '') appendFileSync(LOG, `${JSON.stringify(entry)}\n`) }

record({
  kind: 'worker-start',
  environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^RULITH_/.test(name))),
})
process.send?.({ protocol: 'rulith-local-event', event: { type: 'up', t: Date.now() } })

process.on('message', (message) => {
  if (message?.protocol === 'rulith-local-material' && message.operation === 'read') {
    record({ kind: 'custody-read', ticket: message.ticket, modelDestination: message.modelDestination })
    if (REPLY.silent === true) return
    process.send?.({ protocol: 'rulith-local-material', id: message.id, ...REPLY })
    return
  }
  if (message?.operation === 'stop') leave()
})
const beat = setInterval(() => {}, 1000)
const leave = () => { clearInterval(beat); process.exit(0) }
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
