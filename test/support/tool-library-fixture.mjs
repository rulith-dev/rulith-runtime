// SPDX-License-Identifier: Apache-2.0
/**
 * A manager, a Gateway and Agents whose Workers are the reporting stand-in, for the arms about an
 * environment's tools (`local-tool-library.test.mjs`, `local-tool-library-migration.test.mjs`).
 *
 * Everything is real but the Worker: the manager's registry and hosts, the child processes, an MCP
 * server where a service is saved. The stand-in reads the two files it was given the way a Worker
 * does and reports what they held, so what an arm asserts is what a Worker received.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createManagerServer } from '../../local/manager-server.mjs'
import { loadInstanceConfig, saveInstanceConfig } from '../../local/instance-manager.mjs'
import { createMcpServices } from '../../local/mcp-services.mjs'
import { createDevicesGateway } from './local-devices-gateway.mjs'

export const ECHO = resolve(import.meta.dirname, 'echo-role.mjs')
export const MCP_FIXTURE = resolve(import.meta.dirname, 'local-mcp-server.mjs')
export const KEY = 'manager-instance-key'
export const AGENTS = ['agent-alpha', 'agent-beta', 'agent-gamma']

/** A manager and a Gateway on real sockets, signed in. */
export async function withManager(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'rulith-environment-'))
  const gateway = createDevicesGateway()
  await gateway.listen()
  const manager = createManagerServer({ root, port: 0, key: KEY, startConfirmMs: 8000 })
  await manager.listen()
  t.after(async () => {
    await manager.close()
    await gateway.close()
    rmSync(root, { recursive: true, force: true })
  })
  const started = await manager.device.start({ consoleUrl: gateway.origin, name: 'Test computer' })
  gateway.approve(started.code, AGENTS)
  await manager.device.poll()
  await run({ manager, root, gateway, library: manager.instances.library })
}

/**
 * An Agent attached to `agentId`, its Worker re-pointed at the reporting stand-in.
 *
 * `markers` are strings planted for the stand-in to look for in its environment and files. The
 * Worker setting is on, as it is for an Agent that uses its tools: opening the Agent starts its
 * Worker, and a reload restarts it.
 */
export async function addInstance(manager, name, { agentId, markers = '' } = {}) {
  const created = await manager.instances.create({ name })
  await manager.instances.pair(created.id, { agentId })
  await manager.instances.closeHost(created.id)
  const config = loadInstanceConfig(created.directory)
  config.paths = { agent: ECHO, worker: ECHO }
  config.agent.env = { ...config.agent.env, RULITH_MODEL_URL: 'http://127.0.0.1:11434/v1', RULITH_MODEL: 'fixture-model', RULITH_TEST_IDENTITY: agentId }
  config.worker.env = { ...config.worker.env, RULITH_TEST_IDENTITY: agentId, ...(markers ? { RULITH_TEST_MARKERS: markers } : {}) }
  config.worker.enabled = true
  saveInstanceConfig(created.directory, config)
  return created
}

export const waitUntil = async (check, what = 'condition') => {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}
export const startWorker = async (manager, id) => {
  await manager.instances.open(id)
  await waitUntil(() => manager.instances.hosts.get(id).host.status().ready.worker, 'the Worker to be ready')
}
/** Every Worker start this host has seen for the Agent, as the stand-in reported it. */
export const starts = (manager, id) => manager.instances.hosts.get(id).host.events().filter((row) => row.src === 'worker' && row.type === 'up')
export const composedOf = (manager, id) => starts(manager, id).at(-1).composed
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export const http = { adapter: 'http', sourceTypes: ['http'], entry: '/orders', fence: { method: 'GET' }, kind: 'read', params: {}, returns: [] }
export const lookup = (suffix = '') => ({ ...http, entry: '/orders' + suffix })
export const script = { adapter: 'run', sourceTypes: [], entry: 'adapters/tool.mjs', kind: 'run', params: {}, returns: [] }
/** Save one tool in the environment as the page would: against the revision it was shown. */
export const saveTool = (library, id, definition) => library.save({ id, definition, revision: library.state().revision, confirmed: true })
/** Save an MCP service the way the page does: discover, select, apply. */
export async function saveService(library, name, { env, cwd } = {}) {
  const probe = await library.probe({ name, mode: 'stdio', isNew: true, command: process.execPath, args: [MCP_FIXTURE], ...(cwd ? { cwd } : {}), env: env ?? {} })
  return library.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }], confirmed: true })
}
export const writeOwn = (directory, { tools = {}, vault } = {}) => {
  writeFileSync(join(directory, 'worker-tools.json'), JSON.stringify({ format: 'rulith-worker-tools/1', tools }))
  if (vault !== undefined) writeFileSync(join(directory, 'worker-secrets.json'), JSON.stringify(vault))
}

/** A server an installer would have left under `<mcp>/packages`: a real MCP server behind the installed entry path. */
export function installServer(mcpDirectory) {
  const entry = join(mcpDirectory, 'packages/filesystem-2026.8.31/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `import { localMcpServer } from ${JSON.stringify(import.meta.resolve('./local-mcp-server.mjs'))}\n`
    + `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}\n`
    + 'await localMcpServer().connect(new StdioServerTransport())\n')
  return entry
}

/**
 * An Agent as 0.11 left it: its tools, vault and MCP services in its own directory, and nothing on
 * its row about an environment. `services` are saved through the same code that saved them then.
 */
export async function legacyInstance(manager, name, { agentId, markers, tools = {}, vault = {}, services = [] } = {}) {
  const instance = await addInstance(manager, name, { agentId, markers })
  writeOwn(instance.directory, { tools, vault })
  for (const service of services) {
    const own = createMcpServices(join(instance.directory, 'local.json'), { protectedPaths: [manager.registry.root] })
    // `install` saves the service as an installer would have left it: launched from a package under the Agent's own MCP directory.
    const entry = service.install === true ? installServer(join(instance.directory, 'mcp')) : undefined
    try {
      const probe = await own.probe({ name: service.name, mode: 'stdio', isNew: true, command: process.execPath, args: service.args ?? [entry ?? MCP_FIXTURE],
        ...(service.cwd ? { cwd: service.cwd } : {}), env: service.env ?? {} })
      await own.apply({ probeId: probe.probeId, tools: [{ name: 'mail.read', kind: 'read' }] })
    } finally { await own.close() }
  }
  await manager.registry.update((state) => { delete state.instances.find((row) => row.id === instance.id).tools; return state })
  return instance
}
export const rowOf = (manager, id) => manager.registry.instance(id)
export { assert }
