#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A Worker stand-in that reports the environment the Local host actually gave it.
 *
 * The material binding a Worker receives is the one place where a credential leak would be
 * both easy and invisible: the Worker must know *whose* material area it is reading without
 * ever holding the Agent credential that identifies the owner. Asserting that against what
 * the child received, rather than against what the host intended to pass, is the point.
 */
import { appendFileSync } from 'node:fs'

const LOG = process.env.RULITH_TEST_TASK_LOG ?? ''
if (LOG !== '') {
  appendFileSync(LOG, `${JSON.stringify({
    kind: 'worker-start',
    environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^RULITH_/.test(name))),
  })}\n`)
}
process.send?.({ protocol: 'rulith-local-event', event: { type: 'up', t: Date.now() } })
const beat = setInterval(() => {}, 1000)
const leave = () => { clearInterval(beat); process.exit(0) }
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
process.on('message', (message) => { if (message?.operation === 'stop') leave() })
