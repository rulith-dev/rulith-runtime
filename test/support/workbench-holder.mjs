#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A real second workbench process, for the arms about one installation.
 *
 * It runs the production entry — `createManagerServer(...).listen()` — against a manager root
 * the caller names, so what the test observes is the claim the product actually takes, not a
 * re-enactment of it. Prints one JSON line and then waits to be killed.
 *
 * `MODE=lock` skips the server entirely and writes a lock record by hand, so an arm can stage
 * a lock whose recorded owner is a *living* process with an old timestamp — the shape an
 * expiry rule would have stolen.
 */
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createManagerServer } from '../../local/manager-server.mjs'

const root = process.env.WORKBENCH_ROOT
const key = process.env.WORKBENCH_KEY ?? 'holder-key-0123456789'

if (process.env.MODE === 'lock') {
  writeFileSync(join(root, 'workbench.lock'),
    JSON.stringify({ pid: process.pid, host: hostname(), id: 'holder-' + process.pid, at: Date.now() - 10 * 60_000, purpose: 'workbench' }))
  console.log(JSON.stringify({ held: true, pid: process.pid }))
} else {
  const manager = createManagerServer({ root, port: 0, key, legacyConfigFile: join(root, 'absent.json') })
  try {
    await manager.listen()
    console.log(JSON.stringify({ held: true, pid: process.pid, port: manager.port }))
  } catch (error) {
    console.log(JSON.stringify({ held: false, teaching: String(error?.message ?? error), name: error?.name }))
    process.exit(3)
  }
  process.on('SIGTERM', async () => { await manager.close().catch(() => undefined); process.exit(0) })
}
const beat = setInterval(() => {}, 1000)
process.on('SIGINT', () => { clearInterval(beat); process.exit(0) })
