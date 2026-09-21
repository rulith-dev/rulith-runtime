#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A Local host running a real role child, for the arm that kills it.
 *
 * The point of this script is to be killed. It launches the production runtime through the
 * production path — `createLocalHost`, the same spawn, the same IPC channel — prints the
 * child's operating-system pid, and then waits. The test kills this process without warning
 * and asks the kernel what became of that pid.
 *
 * `ORPHAN_ROLE` picks which one. The Worker comes up whether or not its Gateway is reachable,
 * so it needs no fixture; the Agent needs a real MCP endpoint and model, which the caller
 * supplies in `ORPHAN_GATEWAY` and `ORPHAN_TOKEN`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalHost, defaultLocalConfig } from '../../local/rulith-local.mjs'

const role = process.env.ORPHAN_ROLE === 'agent' ? 'agent' : 'worker'
const gateway = process.env.ORPHAN_GATEWAY ?? ''
const directory = mkdtempSync(join(tmpdir(), 'rulith-orphan-'))
const configFile = join(directory, 'local.json')
const config = defaultLocalConfig()
config.roles = [role]
config.agent.env = {
  ...config.agent.env,
  RULITH_URL: gateway,
  RULITH_TOKEN: process.env.ORPHAN_TOKEN ?? '',
  RULITH_MODEL_URL: gateway + '/v1/messages',
  RULITH_MODEL: 'orphan-model',
  RULITH_MODEL_KEY: '',
  RULITH_SERVE_PORT: process.env.ORPHAN_SERVE_PORT ?? '0',
  RULITH_SESSION_FILE: join(directory, 'agent-sessions.json'),
}
config.worker.env = {
  ...config.worker.env,
  // An address nothing answers on: the Worker reports that and comes up regardless.
  RULITH_WORK_URL: 'http://127.0.0.1:1/work',
  RULITH_CONNECTION: 'orphan-connection',
  RULITH_CONNECTION_KEY: 'orphan-key',
  RULITH_TOOLS_FILE: join(directory, 'worker-tools.json'),
  RULITH_SECRETS_FILE: join(directory, 'worker-secrets.json'),
  RULITH_WORKER_ROOT: directory,
}
writeFileSync(configFile, JSON.stringify(config, null, 2))
writeFileSync(join(directory, 'worker-tools.json'), JSON.stringify({ format: 'rulith-worker-tools/1', tools: {} }))

const host = createLocalHost({ configFile, config, roles: [role], port: 0, autoStart: true, isolateEnvironment: true })
await host.listen()

const readyEvent = role === 'agent' ? 'start' : 'up'
const deadline = Date.now() + 25_000
while (Date.now() < deadline) {
  const up = host.events().some((event) => event.src === role && event.type === readyEvent)
  const children = host.children()
  if (up && children.length > 0) {
    console.log(JSON.stringify({ ready: true, children }))
    break
  }
  const died = host.events().find((event) => event.src === role && event.type === 'exit')
  if (died !== undefined) {
    console.log(JSON.stringify({ ready: false, teaching: `the ${role} exited during startup`, events: host.events().slice(-6) }))
    process.exit(1)
  }
  await new Promise((done) => setTimeout(done, 100))
}
// Nothing further: this process exists to be killed while that child is running.
setInterval(() => {}, 1000)
