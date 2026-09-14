// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { invokeMcp, closeMcpClients } from '../worker/mcp-client.mjs'
import { adapterEnv, workerToolsOf } from '../worker/rulith-worker.mjs'

export const MCP_CATALOG = Object.freeze([Object.freeze({
  id: 'filesystem', title: 'Filesystem', package: '@modelcontextprotocol/server-filesystem', version: '2026.8.31',
  entry: 'dist/index.js', integrity: 'sha512-kKaFkyAh6oipvc9+EAbJ552JafnMnOq5nzmzWkp1jJdBhTAAGpmIpWihUG1+rfNhmEFM98gUZDdCHCDD4v6a7Q==',
  homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
})])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const read = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
function write(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
function sourceName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) throw new Error('Source name needs 1–40 lowercase letters, digits, _ or -, starting with a letter.')
  return value
}
function stringMap(value, label) {
  if (!record(value) || Object.entries(value).some(([key, text]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^RULITH_/i.test(key) || typeof text !== 'string')) throw new Error(label + ' must be a string map without Rulith credentials.')
  return value
}

/** MCP schema 只投影现有参数类型，不猜业务含义；保留完整 schema 供人审阅与服务端验证。 */
export function parametersOf(schema) {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties ?? {})) throw new Error('An object input schema with named properties is required.')
  if (['allOf', 'anyOf', 'oneOf', '$ref', 'patternProperties'].some(key => schema[key] !== undefined) || schema.additionalProperties === true || record(schema.additionalProperties)) throw new Error('Open or composed root schemas need a manually authored adapter.')
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties ?? {}, key)))) throw new Error('Invalid required fields in MCP schema.')
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, field]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || key === 'source') throw new Error('Parameter ' + key + ' requires a manual adapter: source is reserved and names must use lowercase underscores.')
    const type = ['string', 'number', 'boolean'].includes(field?.type) ? field.type : field?.type === 'integer' ? 'number' : 'json'
    return [key, type + ((schema.required ?? []).includes(key) ? '' : '?')]
  }))
}

/** 安装只接受内置目录中的固定 npm 身份，零 shell，不读取用户 npm 凭据，不执行生命周期脚本。 */
async function installPackage(entry, root, trackChild) {
  const destination = join(root, 'packages', entry.id + '-' + entry.version)
  if (existsSync(join(destination, 'node_modules', entry.package, entry.entry))) return destination
  const npmCli = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync)
  if (!npmCli) throw new Error('npm is not installed beside Node.js. Install Node.js with npm, then retry.')
  const stage = join(root, 'packages', '.install-' + randomUUID())
  mkdirSync(stage, { recursive: true, mode: 0o700 })
  writeFileSync(join(stage, '.npmrc'), '')
  write(join(stage, 'package.json'), { name: 'rulith-local-mcp', private: true, version: '1.0.0' })
  try {
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [npmCli, 'install', '--prefix', stage, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
        '--registry=https://registry.npmjs.org', '--userconfig', join(stage, '.npmrc'), '--cache', join(root, 'npm-cache'), entry.package + '@' + entry.version],
      { cwd: stage, windowsHide: true, env: adapterEnv(process.env, []), stdio: ['ignore', 'pipe', 'pipe'] })
      trackChild(child)
      // npm output may contain machine details. The UI reports only a bounded status, never raw logs.
      child.stdout.resume(); child.stderr.resume()
      const timer = setTimeout(() => child.kill(), 180_000)
      child.once('error', error => { clearTimeout(timer); trackChild(null); reject(error) })
      child.once('exit', code => { clearTimeout(timer); trackChild(null); code === 0 ? accept() : reject(new Error('npm installation failed or timed out. Check registry connectivity and retry.')) })
    })
    const lock = read(join(stage, 'package-lock.json'), {})
    if (lock.packages?.['node_modules/' + entry.package]?.integrity !== entry.integrity) throw new Error('Installed package does not match the catalog integrity.')
    if (!existsSync(join(stage, 'node_modules', entry.package, entry.entry))) throw new Error('Installed package has no expected entry point.')
    renameSync(stage, destination)
    return destination
  } finally {
    // stage is minted here under the fixed Local-owned packages directory, never a request path.
    rmSync(stage, { recursive: true, force: true })
  }
}

export function createMcpServices(configFile) {
  const root = join(dirname(resolve(configFile)), 'mcp')
  const stateFile = join(root, 'services.json')
  const toolsFile = join(root, 'worker-tools.json'), vaultFile = join(root, 'worker-secrets.json')
  let busy = false, closed = false, installChild = null, pending = Promise.resolve()
  const probes = new Map()
  const state = () => {
    const value = read(stateFile, { format: 'rulith-local-mcp/1', services: {} })
    if (value.format !== 'rulith-local-mcp/1' || !record(value.services)) throw new Error('Invalid Local MCP configuration.')
    return value
  }
  const publicService = row => ({ name: row.name, mode: row.mode, directory: row.directory,
    source: { ...row.source, env: undefined, headers: undefined, token: undefined },
    secretConfigured: Object.keys(row.source.env ?? {}).length > 0 || !!row.source.headers?.authorization,
    tools: row.tools, discovered: row.discovered, definition: row.definition })
  const overview = () => ({ catalog: MCP_CATALOG.map(entry => ({ ...entry, installed: existsSync(join(root, 'packages', entry.id + '-' + entry.version, 'node_modules', entry.package, entry.entry)) })),
    services: Object.values(state().services).map(publicService), busy })
  const exclusive = action => {
    if (busy || closed) return Promise.reject(new Error('Another MCP configuration operation is in progress or Local is closing.'))
    busy = true
    pending = (async () => { try { return await action() } finally { busy = false } })()
    return pending
  }
  const save = next => {
    // These are stopped-Worker projections. A fresh start rebuilds both from the one committed state.
    for (const file of [toolsFile, vaultFile]) rmSync(file, { force: true })
    write(stateFile, next)
  }
  return {
    get busy() { return busy }, overview,
    close: async () => { closed = true; installChild?.kill(); await closeMcpClients(); await pending.catch(() => {}); probes.clear() },
    install: id => exclusive(async () => {
      const entry = MCP_CATALOG.find(row => row.id === id)
      if (!entry) throw new Error('Choose an MCP server from the local catalog.')
      await installPackage(entry, root, child => { installChild = child })
      return { installed: true, catalogId: id }
    }),
    probe: body => exclusive(async () => {
      const name = sourceName(body.name), current = state(), old = current.services[name]
      const mode = body.mode
      let source, directory
      if (mode === 'filesystem') {
        const entry = MCP_CATALOG[0]
        const script = join(root, 'packages', entry.id + '-' + entry.version, 'node_modules', entry.package, entry.entry)
        if (!existsSync(script)) throw new Error('Install Filesystem from the catalog first.')
        if (!isAbsolute(body.directory ?? '') || !statSync(body.directory).isDirectory()) throw new Error('Choose an existing absolute directory for this server.')
        directory = realpathSync(body.directory)
        for (const protectedPath of [resolve(configFile), root, resolve(import.meta.dirname, '..')]) {
          const actual = existsSync(protectedPath) ? realpathSync(protectedPath) : protectedPath
          const rel = relative(directory, actual), reverse = relative(actual, directory)
          const overlapsDirectory = existsSync(actual) && statSync(actual).isDirectory()
            && (reverse === '' || (!reverse.startsWith('..') && !isAbsolute(reverse)))
          if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) || overlapsDirectory) throw new Error('Allowed directory must not overlap Rulith configuration, credentials or executable files.')
        }
        source = { type: 'mcp', transport: 'stdio', command: process.execPath, args: [script, directory] }
      } else if (mode === 'stdio') {
        if (typeof body.command !== 'string' || !body.command.trim() || !Array.isArray(body.args) || body.args.some(value => typeof value !== 'string')) throw new Error('Specify an executable and a JSON array of arguments.')
        if (body.cwd && (!isAbsolute(body.cwd) || !statSync(body.cwd).isDirectory())) throw new Error('Working directory must be an existing absolute directory.')
        const env = body.clearSecrets ? {} : body.env ?? (old?.mode === mode ? old.source.env : {}) ?? {}
        source = { type: 'mcp', transport: 'stdio', command: body.command.trim(), args: body.args, ...(body.cwd ? { cwd: body.cwd } : {}), env: stringMap(env, 'Environment') }
      } else if (mode === 'streamable-http') {
        const url = new URL(body.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) endpoint without credentials, query or fragment; enter the token separately.')
        // Changing endpoints never forwards a saved credential to the new address.
        const authorization = body.clearSecrets ? '' : body.token ? 'Bearer ' + body.token
          : old?.source.url === url.href ? old.source.headers?.authorization ?? '' : ''
        source = { type: 'mcp', transport: 'streamable-http', url: url.href, headers: authorization ? { authorization } : {} }
      } else throw new Error('Choose Filesystem, an existing stdio server, or Streamable HTTP.')
      let discovered
      try {
        discovered = await invokeMcp({ sourceName: 'local-probe-' + randomUUID(), source, discovering: true, environment: adapterEnv(process.env, []) })
      } catch {
        // Remote errors can echo tokens or environment. Do not publish raw third-party diagnostics.
        throw new Error('MCP discovery failed. Check the executable, arguments, endpoint and credentials. No tool was called or saved.')
      } finally { await closeMcpClients() }
      const names = new Set()
      const tools = discovered.tools.map(tool => {
        if (typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('Server returned invalid or duplicate tool names.')
        names.add(tool.name)
        let params, unsupported
        try { params = parametersOf(tool.inputSchema) } catch (error) { unsupported = error.message }
        return { name: tool.name, description: String(tool.description ?? '').slice(0, 1000), inputSchema: tool.inputSchema, params, unsupported }
      })
      probes.clear()
      const probeId = randomUUID()
      probes.set(probeId, { name, mode, directory, source, tools, base: hash(current), expires: Date.now() + 600_000 })
      return { probeId, tools, truncated: discovered.truncated }
    }),
    apply: body => exclusive(async () => {
      const draft = probes.get(body.probeId), current = state()
      if (!draft || draft.expires < Date.now() || draft.base !== hash(current)) throw new Error('Configuration changed or discovery expired. Probe again before saving.')
      if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > 32) throw new Error('Select 1–32 discovered tools and classify their operations.')
      const tools = {}, accessModes = [], seen = new Set()
      for (const selection of body.tools) {
        const tool = draft.tools.find(row => row.name === selection.name)
        if (!tool || tool.unsupported || seen.has(tool.name) || !['read', 'write', 'run'].includes(selection.kind)) throw new Error('Select supported tools once, each with an explicit read/write/run classification.')
        seen.add(tool.name)
        const fingerprint = hash({ source: draft.name, name: tool.name, schema: tool.inputSchema, kind: selection.kind }).slice(0, 12)
        const id = 'local.mcp.' + draft.name.replaceAll('_', '-') + '.' + fingerprint + '@1'
        tools[id] = { adapter: 'mcp', sourceTypes: ['mcp'], entry: tool.name, kind: selection.kind, params: tool.params, returns: [] }
        accessModes.push({ id: 'tool_' + fingerprint, action: 'mcp_' + draft.name.replaceAll('-', '_') + '_' + fingerprint,
          title: tool.name, operation: selection.kind, tool: id, params: tool.params, returns: [] })
      }
      workerToolsOf({ format: 'rulith-worker-tools/1', tools })
      const definition = { name: draft.name, type: 'mcp', words: [], accessModes }
      current.services[draft.name] = { name: draft.name, mode: draft.mode, directory: draft.directory, source: draft.source,
        tools, discovered: draft.tools.filter(tool => seen.has(tool.name)), definition }
      save(current); probes.clear()
      return { service: publicService(current.services[draft.name]), teaching: 'Saved locally. Start Worker, import the Source definition in Console, then bind and enable its tools for the Agent.' }
    }),
    remove: name => exclusive(async () => {
      sourceName(name)
      const current = state()
      delete current.services[name]; save(current); probes.clear()
      return { removed: true, teaching: 'Local configuration removed. Existing Cloud grants and historical receipts are unchanged.' }
    }),
    /** 合并原 manifest/vault 的只读输入；撞名拒绝，绝不覆盖已有来源或已审定工具。 */
    workerEnvironment(environment, workerDirectory) {
      if (busy) throw new Error('Wait for MCP configuration to finish before starting Worker.')
      const services = Object.values(state().services)
      if (!services.length) return environment
      const originalTools = resolve(workerDirectory, environment.RULITH_TOOLS_FILE || './worker-tools.json')
      const originalVault = resolve(workerDirectory, environment.RULITH_SECRETS_FILE || './worker-secrets.json')
      if ([toolsFile, vaultFile].includes(originalTools) || [toolsFile, vaultFile].includes(originalVault)) throw new Error('Do not configure generated MCP projections as input files.')
      const manifest = read(originalTools, { format: 'rulith-worker-tools/1', tools: {} }), vault = read(originalVault, {})
      workerToolsOf(manifest)
      if (!record(vault)) throw new Error('Worker Source vault must be an object.')
      for (const row of services) {
        if (Object.hasOwn(vault, row.name)) throw new Error('MCP Source conflicts with the existing vault: ' + row.name)
        vault[row.name] = row.source
        for (const [id, tool] of Object.entries(row.tools)) {
          if (Object.hasOwn(manifest.tools, id)) throw new Error('MCP Tool conflicts with the existing manifest: ' + id)
          manifest.tools[id] = tool
        }
      }
      workerToolsOf(manifest)
      write(toolsFile, manifest); write(vaultFile, vault)
      return { ...environment, RULITH_TOOLS_FILE: toolsFile, RULITH_SECRETS_FILE: vaultFile }
    },
  }
}
