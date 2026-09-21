// SPDX-License-Identifier: Apache-2.0
/**
 * Importing the installation that is actually there, into the directory it actually goes to.
 *
 * The default layout is the whole test. A real installation is `~/.rulith/local.json` and a
 * real instance is `~/.rulith/manager/instances/<id>/local.json`, so the destination is
 * *inside* the source's directory — and a blanket "the instance may not live inside the
 * installation" rule refused the only import anybody is ever offered. Every fixture here uses
 * that exact parent/manager/instances shape rather than two unrelated temporary directories.
 *
 * The second half is what an import may carry. An imported profile arrives **unpaired**: the
 * operator's settings come across and nothing that authenticates does, because the Agent token
 * and Worker Connection of the old installation were never issued under this device and
 * signing this device out cannot revoke them. An instance that held them would sit in a list
 * of instances that a sign-out really does stop, and be the one that quietly still runs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { createManagerServer } from '../local/manager-server.mjs'
import { importLegacyInstall, loadInstanceConfig } from '../local/instance-manager.mjs'

const KEY = 'manager-import-test-key'
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Every file under a directory, by path relative to it, with its hash. */
function fingerprint(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.set(relative(root, path).split('\\').join('/'), sha(path))
    }
  }
  walk(root)
  return out
}

/**
 * The layout an operator really has: `~/.rulith/local.json`, with the manager's instances
 * directory nested inside `~/.rulith`.
 */
function realHome() {
  const home = mkdtempSync(join(tmpdir(), 'rulith-home-'))
  const dotRulith = join(home, '.rulith')
  const managerRoot = join(dotRulith, 'manager')
  const runtime = join(home, 'runtime')
  const workerDir = join(runtime, 'worker')
  const project = join(home, 'project')
  mkdirSync(join(workerDir, 'tools'), { recursive: true })
  mkdirSync(managerRoot, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(workerDir, 'rulith-worker.mjs'), '// stand-in worker\n')
  writeFileSync(join(workerDir, 'worker-secrets.json'), JSON.stringify({ legacyVaultEntry: { type: 'file' } }, null, 2))
  writeFileSync(join(workerDir, 'tools', 'custom-tools.json'), JSON.stringify({ format: 'rulith-worker-tools/1', tools: {} }, null, 2))
  writeFileSync(join(project, 'notes.txt'), 'operator data\n')

  const mcp = join(dotRulith, 'mcp')
  mkdirSync(join(mcp, 'packages', 'filesystem-1'), { recursive: true })
  mkdirSync(join(mcp, 'workspaces', 'files'), { recursive: true })
  mkdirSync(join(mcp, 'npm-cache'), { recursive: true })
  writeFileSync(join(mcp, 'packages', 'filesystem-1', 'index.js'), '// installed server\n')
  writeFileSync(join(mcp, 'workspaces', 'files', 'scratch.txt'), 'server scratch\n')
  writeFileSync(join(mcp, 'npm-cache', 'blob'), 'cache\n')
  writeFileSync(join(mcp, 'services.json'), JSON.stringify({
    format: 'rulith-local-mcp/1',
    services: { files: { name: 'files', mode: 'stdio', source: { type: 'mcp', transport: 'stdio',
      command: process.execPath, args: [join(mcp, 'packages', 'filesystem-1', 'index.js'), project], cwd: join(mcp, 'workspaces', 'files') },
      tools: {}, discovered: [], definition: { name: 'files', type: 'mcp', words: [], accessModes: [] } } },
  }, null, 2))

  const configFile = join(dotRulith, 'local.json')
  writeFileSync(configFile, JSON.stringify({
    roles: ['agent', 'worker'],
    agent: { args: [], env: {
      RULITH_URL: 'https://console.example', RULITH_TOKEN: 'rlt_agt_legacy',
      RULITH_MODEL_URL: 'http://127.0.0.1:8080/v1', RULITH_MODEL: 'local-model', RULITH_MODEL_KEY: 'legacy-model-key',
      RULITH_SESSION_FILE: join(home, 'agent-sessions.json'), RULITH_SERVE_PORT: '7799' } },
    worker: { env: {
      RULITH_WORK_URL: 'https://console.example/work', RULITH_CONNECTION: 'conn-legacy', RULITH_CONNECTION_KEY: 'legacy-connection-key',
      RULITH_TOOLS_FILE: './tools/custom-tools.json', RULITH_WORKSPACE_TOOLS: 'read-write' } },
    paths: { worker: '../runtime/worker/rulith-worker.mjs' },
    operatorNote: 'keep me',
  }, null, 2))
  writeFileSync(configFile + '.setup.json', JSON.stringify({
    requestId: 'legacy-request', base: 'https://console.example', clientMode: 'local_agent',
    agentId: 'agent-legacy', connectionId: 'conn-legacy', credentialDigest: 'abc',
    resources: [{ name: 'verified-calculation-local', type: 'file', access: project }],
  }, null, 2))
  writeFileSync(join(home, 'agent-sessions.json'), JSON.stringify({ schema: 'rulith-agent-sessions/1', endpoints: {
    'https://console.example#0c4d1c2e6c2ef3a0': { unresolved: { invocation: 'inv-1' } },
  } }, null, 2))
  return { home, dotRulith, managerRoot, configFile, runtime, workerDir, project, mcp,
    store: join(home, 'agent-sessions.json') }
}

test('the default layout imports: the instance lives inside ~/.rulith and the installation is untouched', async (t) => {
  const legacy = realHome()
  t.after(() => rmSync(legacy.home, { recursive: true, force: true }))
  // Exactly where the manager puts an instance: <home>/.rulith/manager/instances/<id>.
  const directory = join(legacy.managerRoot, 'instances', 'inst-0000000000aa')
  const before = fingerprint(legacy.dotRulith)
  const homeBefore = fingerprint(legacy.home)

  const imported = importLegacyInstall({ sourceConfigFile: legacy.configFile, directory, servePort: 7891, runtimeRoot: legacy.runtime })
  assert.equal(existsSync(join(directory, 'local.json')), true, 'the default offered import must not refuse its own default destination')

  // Nothing under the installation changed, byte for byte — apart from the instance the
  // import was asked to create.
  const after = fingerprint(legacy.dotRulith)
  for (const [file, hash] of before) assert.equal(after.get(file), hash, `${file} changed during an import that only copies`)
  const added = [...after.keys()].filter((file) => !before.has(file))
  assert.ok(added.length > 0)
  assert.ok(added.every((file) => file.startsWith('manager/instances/inst-0000000000aa/')), `unexpected new files: ${added}`)
  for (const [file, hash] of homeBefore) {
    if (file.startsWith('.rulith/')) continue
    assert.equal(sha(join(legacy.home, file)), hash, `${file} outside the installation changed`)
  }

  // Settings the operator chose came across.
  const config = imported.config
  assert.equal(config.agent.env.RULITH_MODEL_URL, 'http://127.0.0.1:8080/v1')
  assert.equal(config.agent.env.RULITH_MODEL, 'local-model')
  assert.equal(config.agent.env.RULITH_MODEL_KEY, 'legacy-model-key')
  assert.equal(config.worker.env.RULITH_WORKSPACE_TOOLS, 'read-write')
  assert.equal(config.operatorNote, 'keep me')
  assert.equal(config.paths.worker, join(legacy.workerDir, 'rulith-worker.mjs'), 'a relative runtime path resolves from the old configuration directory')
  assert.equal(config.agent.env.RULITH_SERVE_PORT, '7891')

  // Credentials did not.
  assert.equal(imported.paired, false)
  assert.equal(config.agent.env.RULITH_TOKEN, '', 'an Agent token this device never issued must not arrive attached to a managed instance')
  assert.equal(config.worker.env.RULITH_CONNECTION, '')
  assert.equal(config.worker.env.RULITH_CONNECTION_KEY, '')
  assert.deepEqual(imported.legacy.keptCredentials.sort(), ['RULITH_CONNECTION', 'RULITH_CONNECTION_KEY', 'RULITH_TOKEN'])
  assert.ok(imported.notes.some((note) => note.includes('rulith start --legacy') && note.includes('does not revoke them')),
    'the original installation\'s independent authority has to be stated, not discovered')

  // No identity was inferred from the old pairing file.
  const setup = JSON.parse(readFileSync(join(directory, 'local.json.setup.json'), 'utf8'))
  assert.equal(setup.agentId, undefined, 'an Agent id read off disk must not become what this manager believes it is attached to')
  assert.equal(setup.connectionId, undefined)
  assert.equal(setup.credentialDigest, undefined)
  assert.equal(setup.resources[0].access, legacy.project, 'the operator\'s local resource locations are theirs and come across')

  // Unresolved calls stayed with the credential that made them.
  assert.equal(existsSync(join(directory, 'agent-sessions.json')), false)
  assert.equal(JSON.parse(readFileSync(legacy.store, 'utf8')).endpoints['https://console.example#0c4d1c2e6c2ef3a0'].unresolved.invocation, 'inv-1')
  assert.ok(imported.notes.some((note) => note.includes('belong to the credential that made those calls')))
})

test('mutable Worker configuration is copied, and what its tools point at is not moved', async (t) => {
  const legacy = realHome()
  t.after(() => rmSync(legacy.home, { recursive: true, force: true }))
  // The operator put their manifest in their own project, outside both the installation and
  // the runtime package — the case the first version left shared with a warning.
  const projectTools = join(legacy.project, 'worker-tools.json')
  writeFileSync(projectTools, JSON.stringify({ format: 'rulith-worker-tools/1', tools: { 'demo@1': { adapter: 'command', entry: './run.mjs', kind: 'read', params: {} } } }, null, 2))
  const config = JSON.parse(readFileSync(legacy.configFile, 'utf8'))
  config.worker.env.RULITH_TOOLS_FILE = projectTools
  config.worker.env.RULITH_WORKER_ROOT = legacy.project
  writeFileSync(legacy.configFile, JSON.stringify(config, null, 2))
  const toolsBefore = readFileSync(projectTools, 'utf8')

  const directory = join(legacy.managerRoot, 'instances', 'inst-0000000000bb')
  const imported = importLegacyInstall({ sourceConfigFile: legacy.configFile, directory, servePort: 7892, runtimeRoot: legacy.runtime })

  assert.equal(imported.config.worker.env.RULITH_TOOLS_FILE, join(directory, 'worker-tools.json'),
    'two instances editing one tool manifest is two owners of one mutable configuration')
  assert.equal(readFileSync(join(directory, 'worker-tools.json'), 'utf8'), toolsBefore, 'the copy has the same tools in it')
  assert.equal(imported.config.worker.env.RULITH_WORKER_ROOT, legacy.project,
    'the workspace the operator chose is a resource target, and re-pointing it would move their work')
  assert.ok(imported.notes.some((note) => note.includes('own file now') && note.includes('original is unchanged')))

  // Editing the instance's copy does not reach back.
  writeFileSync(join(directory, 'worker-tools.json'), JSON.stringify({ format: 'rulith-worker-tools/1', tools: {} }))
  assert.equal(readFileSync(projectTools, 'utf8'), toolsBefore)
})

test('MCP state is copied with its mutable working directories re-rooted, and the cache is not', async (t) => {
  const legacy = realHome()
  t.after(() => rmSync(legacy.home, { recursive: true, force: true }))
  const directory = join(legacy.managerRoot, 'instances', 'inst-0000000000cc')
  importLegacyInstall({ sourceConfigFile: legacy.configFile, directory, servePort: 7893, runtimeRoot: legacy.runtime })

  const services = JSON.parse(readFileSync(join(directory, 'mcp', 'services.json'), 'utf8'))
  const source = services.services.files.source
  assert.equal(source.cwd, join(directory, 'mcp', 'workspaces', 'files'), 'two instances must not share one MCP server working directory')
  assert.equal(source.args[0], join(directory, 'mcp', 'packages', 'filesystem-1', 'index.js'))
  assert.equal(source.args[1], legacy.project, 'a directory the operator chose is left alone')
  assert.equal(existsSync(join(directory, 'mcp', 'workspaces', 'files', 'scratch.txt')), true)
  assert.equal(existsSync(join(directory, 'mcp', 'npm-cache')), false)
  assert.equal(existsSync(join(legacy.mcp, 'npm-cache', 'blob')), true)
})

test('destinations that would consume or overwrite the installation are still refused', async (t) => {
  const legacy = realHome()
  t.after(() => rmSync(legacy.home, { recursive: true, force: true }))
  const attempt = (directory) => importLegacyInstall({ sourceConfigFile: legacy.configFile, directory, runtimeRoot: legacy.runtime })

  // The installation's own directory: its local.json is the file being read.
  assert.throws(() => attempt(legacy.dotRulith), /directory of its own/)
  // A destination containing the installation: the copy would walk into itself.
  assert.throws(() => attempt(legacy.home), /does not contain the installation/)
  // Inside the tree that is copied recursively.
  assert.throws(() => attempt(join(legacy.mcp, 'workspaces', 'nested')), /outside the installation's mcp directory/)
  assert.throws(() => importLegacyInstall({ sourceConfigFile: join(legacy.home, 'nope.json'), directory: join(legacy.managerRoot, 'i') }),
    /No Rulith configuration/)

  // And the sibling-inside-the-same-tree case still works, which is the default one.
  const ok = join(legacy.managerRoot, 'instances', 'inst-0000000000dd')
  attempt(ok)
  assert.equal(statSync(join(ok, 'local.json')).isFile(), true)
})

test('the manager registers an imported profile as unpaired and infers no Agent for it', async (t) => {
  const legacy = realHome()
  t.after(() => rmSync(legacy.home, { recursive: true, force: true }))
  const manager = createManagerServer({ root: legacy.managerRoot, port: 0, key: KEY, legacyConfigFile: legacy.configFile })
  await manager.listen()
  t.after(() => manager.close())

  const imported = await manager.instances.import({ sourceConfigFile: legacy.configFile, name: 'Existing installation' })
  const row = manager.registry.instance(imported.id)
  assert.equal(row.importedFrom, legacy.configFile)
  assert.equal(row.agentId, undefined, 'an imported profile has no identity until it is attached')
  assert.equal(row.origin, undefined)
  assert.equal(imported.paired, false)

  const card = manager.instances.overview().find((entry) => entry.id === imported.id)
  assert.equal(card.paired, false)
  assert.deepEqual(card.legacyImport.credentialsLeftInPlace.sort(), ['RULITH_CONNECTION', 'RULITH_CONNECTION_KEY', 'RULITH_TOKEN'])
  assert.match(card.blocked, /not attached to an Agent yet|Sign in to a Rulith account/)

  // Importing the same installation twice is allowed now: there is no identity to clash, and
  // both profiles are inert until somebody attaches them to different Agents.
  const again = await manager.instances.import({ sourceConfigFile: legacy.configFile, name: 'Second look' })
  assert.notEqual(again.id, imported.id)
  assert.equal(manager.registry.read().instances.length, 2)

  // No credential of the imported installation is anywhere in what this manager serves.
  const served = JSON.stringify(manager.state()) + readFileSync(manager.registry.file, 'utf8')
  for (const secret of ['legacy-connection-key', 'legacy-model-key', 'rlt_agt_legacy']) {
    assert.equal(served.includes(secret), false, `the manager disclosed ${secret}`)
  }
  assert.equal(loadInstanceConfig(resolve(row.directory)).agent.env.RULITH_MODEL_KEY, 'legacy-model-key',
    'the model key stays in the instance configuration, where only that instance reads it')
})
