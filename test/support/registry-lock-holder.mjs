#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A live process holding the manager registry lock, for the adversarial lock arms.
 *
 * It writes the lock file itself rather than going through the registry, because what the
 * arms need to reproduce is a *shape* of lock: one whose timestamp is long past while its
 * owner is very much alive, and one that exists but has no metadata in it yet. Both are
 * states a real holder passes through, and both were previously treated as proof of death.
 *
 * Prints `held` once the lock exists, then stays alive until it is killed.
 */
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

const [file, shape = 'stale'] = process.argv.slice(2)
const body = shape === 'empty'
  // Exactly what another process sees between `open(…, 'wx')` and the write that follows it.
  ? ''
  : JSON.stringify({ pid: process.pid, host: hostname(), id: 'holder-' + process.pid, at: Date.now() - 10 * 60_000 })
writeFileSync(file, body, { flag: 'w' })
console.log('held')
const beat = setInterval(() => {}, 1000)
const leave = () => { clearInterval(beat); process.exit(0) }
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
