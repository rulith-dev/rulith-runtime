// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { invokeMcp, closeMcpClients } from '../worker/mcp-client.mjs'
import { adapterEnv, workerToolsOf, configuredWorkerTools } from '../worker/rulith-worker.mjs'
import { createMcpRegistry } from './mcp-registry.mjs'

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

/** 只约束自动生成的 Worker 动作；不改变能力包自己声明的 JSON 合同或 Kernel 接地语义。 */
export function automaticActionProblem(kind, params = {}) {
  if (Object.hasOwn(params, 'source')) return 'Parameter source is reserved for the structural Source selector. Rename the business parameter in the adapter.'
  const requiredJson = Object.entries(params).filter(([, type]) => type === 'json').map(([name]) => name)
  if (['write', 'run'].includes(kind) && requiredJson.length) return 'Required JSON parameter(s): ' + requiredJson.join(', ')
    + '. Automatic grounded write/run Actions cannot authorize these inputs: objects, arrays and null have no grounding rule. Use scalar inputs with explicit validation. JSON reads remain supported; do not classify a write as a read.'
  return undefined
}

/** 安装只接受服务端解析的固定 npm 身份，零 shell，不读取用户 npm 凭据，不执行生命周期脚本。 */
async function installPackage(entry, root, trackChild) {
  const destination = join(root, 'packages', entry.id + '-' + entry.version)
  const verify = directory => {
    const packageRoot = join(directory, 'node_modules', entry.package), executable = join(packageRoot, entry.entry)
    const lock = read(join(directory, 'package-lock.json'), {})
    if (lock.packages?.['node_modules/' + entry.package]?.integrity !== entry.integrity) throw new Error('Installed package does not match the catalog integrity.')
    const metadata = read(join(packageRoot, 'package.json'), {})
    if (metadata.name !== entry.package || metadata.version !== entry.version || (entry.serverName && metadata.mcpName !== entry.serverName)) throw new Error('Installed package identity differs from reviewed metadata.')
    if (!existsSync(executable) || !statSync(executable).isFile()) throw new Error('Installed package has no expected entry point.')
    const rel = relative(realpathSync(packageRoot), realpathSync(executable))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Package executable escapes its installation directory.')
    if (!/\.(mjs|cjs|js)$/i.test(executable)) {
      const header = Buffer.alloc(256), fd = openSync(executable, 'r')
      try { readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
      if (!/^#![^\n]*\bnode\b/.test(header.toString('utf8'))) throw new Error('Only Node.js package executables support automatic setup.')
    }
  }
  if (existsSync(destination)) { verify(destination); return destination }
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
    verify(stage)
    renameSync(stage, destination)
    return destination
  } finally {
    // stage is minted here under the fixed Local-owned packages directory, never a request path.
    rmSync(stage, { recursive: true, force: true })
  }
}

export function createMcpServices(configFile, { registry = createMcpRegistry(), workerContext } = {}) {
  const root = join(dirname(resolve(configFile)), 'mcp')
  const stateFile = join(root, 'services.json')
  const toolsFile = join(root, 'worker-tools.json'), vaultFile = join(root, 'worker-secrets.json')
  let busy = false, closed = false, installChild = null, pending = Promise.resolve()
  const probes = new Map()
  const preparations = new Map()
  const state = () => {
    const value = read(stateFile, { format: 'rulith-local-mcp/1', services: {} })
    if (value.format !== 'rulith-local-mcp/1' || !record(value.services)) throw new Error('Invalid Local MCP configuration.')
    return value
  }
  const publicService = row => ({ name: row.name, mode: row.mode, directory: row.directory, registry: row.registry,
    // Registry arguments may contain secrets too. The browser can rediscover a saved service
    // without receiving its launch configuration; reconfiguration requires explicit fresh inputs.
    source: row.mode === 'registry' ? { type: 'mcp', transport: row.source.transport, url: row.source.url }
      : { ...row.source, env: undefined, headers: undefined, token: undefined },
    secretConfigured: Object.keys(row.source.env ?? {}).length > 0 || Object.keys(row.source.headers ?? {}).length > 0,
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
    if (workerContext) {
      const { environment, directory } = workerContext()
      configuredWorkerTools(project(environment, directory, next).manifest, String(environment.RULITH_WORKSPACE_TOOLS ?? 'read').trim())
    }
    // These are stopped-Worker projections. A fresh start rebuilds both from the one committed state.
    for (const file of [toolsFile, vaultFile]) rmSync(file, { force: true })
    write(stateFile, next)
  }
  /** 只读投影也供工具管理页使用；读取清单不能落盘或修复配置。 */
  const project = (environment, workerDirectory, saved = state()) => {
    const originalTools = resolve(workerDirectory, environment.RULITH_TOOLS_FILE || './worker-tools.json')
    const originalVault = resolve(workerDirectory, environment.RULITH_SECRETS_FILE || './worker-secrets.json')
    if ([toolsFile, vaultFile].includes(originalTools) || [toolsFile, vaultFile].includes(originalVault)) throw new Error('Do not configure generated MCP projections as input files.')
    const originalManifest = read(originalTools, { format: 'rulith-worker-tools/1', tools: {} })
    const manifest = structuredClone(originalManifest), vault = read(originalVault, {})
    workerToolsOf(manifest)
    if (!record(vault)) throw new Error('Worker Source vault must be an object.')
    for (const row of Object.values(saved.services)) {
      if (Object.hasOwn(vault, row.name)) throw new Error('MCP Source conflicts with the existing vault: ' + row.name)
      vault[row.name] = row.source
      for (const [id, tool] of Object.entries(row.tools)) {
        if (Object.hasOwn(manifest.tools, id)) throw new Error('MCP Tool conflicts with the existing manifest: ' + id)
        manifest.tools[id] = tool
      }
    }
    workerToolsOf(manifest)
    return { manifest, originalManifest, vault, originalTools, originalVault }
  }
  return {
    get busy() { return busy }, overview,
    projectWorkerInputs: project,
    search: (query, cursor) => registry.search(query, cursor),
    downloads: packageName => registry.downloads(packageName),
    detail: (name, version) => registry.detail(name, version),
    close: async () => { closed = true; installChild?.kill(); await closeMcpClients(); await pending.catch(() => {}); probes.clear(); preparations.clear() },
    prepareRegistry: body => exclusive(async () => {
      const prepared = await registry.prepare(body)
      if (closed) throw new Error('Local is closing.')
      let source = prepared.source
      if (prepared.entry) {
        const directory = await installPackage(prepared.entry, root, child => { installChild = child })
        source = { type: 'mcp', transport: 'stdio', command: process.execPath,
          args: [join(directory, 'node_modules', prepared.entry.package, prepared.entry.entry), ...prepared.configuration.args], env: prepared.configuration.env }
      }
      if (closed) throw new Error('Local is closing.')
      const preparationId = randomUUID()
      preparations.clear()
      preparations.set(preparationId, { source, registry: prepared.provenance, expires: Date.now() + 600_000 })
      return { preparationId, registry: prepared.provenance, transport: source.transport }
    }),
    install: id => exclusive(async () => {
      const entry = MCP_CATALOG.find(row => row.id === id)
      if (!entry) throw new Error('Choose an MCP server from the local catalog.')
      await installPackage(entry, root, child => { installChild = child })
      return { installed: true, catalogId: id }
    }),
    probe: body => exclusive(async () => {
      const name = sourceName(body.name), current = state(), old = current.services[name]
      if (body.isNew === true && old) throw new Error('This Source ID already exists. Edit that service or choose a new ID.')
      if (body.originalName !== undefined && (body.originalName !== name || !old)) throw new Error('An existing Source identity cannot be renamed. Add a separate service instead.')
      const mode = body.mode
      let source, directory, provenance
      if (mode === 'registry') {
        const prepared = body.preparationId ? preparations.get(body.preparationId) : undefined
        if (prepared && prepared.expires >= Date.now()) { source = prepared.source; provenance = prepared.registry }
        else if (!body.preparationId && old?.mode === 'registry') { source = old.source; provenance = old.registry }
        else throw new Error('Directory configuration expired. Review and configure the service again.')
        if (source.transport === 'stdio' && !source.cwd) {
          const workingDirectory = join(root, 'workspaces', name)
          mkdirSync(workingDirectory, { recursive: true, mode: 0o700 })
          source = { ...source, cwd: workingDirectory }
        }
      } else if (mode === 'filesystem') {
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
        const sameTarget = old?.mode === mode && old.source.command === body.command.trim()
          && hash(old.source.args ?? []) === hash(body.args) && (old.source.cwd ?? '') === (body.cwd ?? '')
        if (!sameTarget && !body.clearSecrets && body.env === undefined && Object.keys(old?.source.env ?? {}).length) {
          throw new Error('The stdio launch target changed. Enter credentials for this target or explicitly clear the saved credentials.')
        }
        const env = body.clearSecrets ? {} : body.env ?? (sameTarget ? old.source.env : {}) ?? {}
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
        return { name: tool.name, description: String(tool.description ?? '').slice(0, 1000), inputSchema: tool.inputSchema, params, unsupported,
          groundedWriteProblem: params ? automaticActionProblem('write', params) : undefined }
      })
      probes.clear()
      const probeId = randomUUID()
      probes.set(probeId, { name, mode, directory, source, registry: provenance, tools, base: hash(current), expires: Date.now() + 600_000 })
      const selected = Object.values(old?.tools ?? {}).flatMap(tool => {
        const previous = old.discovered?.find(item => item.name === tool.entry), current = tools.find(item => item.name === tool.entry)
        return current && !current.unsupported && previous && hash(previous.inputSchema) === hash(current.inputSchema)
          ? [{ name: tool.entry, kind: tool.kind }] : []
      })
      return { probeId, tools, selected, truncated: discovered.truncated }
    }),
    apply: body => exclusive(async () => {
      const draft = probes.get(body.probeId), current = state()
      if (!draft || draft.expires < Date.now() || draft.base !== hash(current)) throw new Error('Configuration changed or discovery expired. Probe again before saving.')
      if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > 32) throw new Error('Select 1–32 discovered tools and classify their operations.')
      const tools = {}, accessModes = [], seen = new Set()
      for (const selection of body.tools) {
        const tool = draft.tools.find(row => row.name === selection.name)
        if (!tool || tool.unsupported || seen.has(tool.name) || !['read', 'write', 'run'].includes(selection.kind)) throw new Error('Select supported tools once, each with an explicit read/write/run classification.')
        const problem = automaticActionProblem(selection.kind, tool.params)
        if (problem) throw new Error(tool.name + ': ' + problem)
        seen.add(tool.name)
        const fingerprint = hash({ source: draft.name, name: tool.name, schema: tool.inputSchema, kind: selection.kind }).slice(0, 12)
        const id = 'local.mcp.' + draft.name.replaceAll('_', '-') + '.' + fingerprint + '@1'
        tools[id] = { adapter: 'mcp', sourceTypes: ['mcp'], entry: tool.name, kind: selection.kind, params: tool.params, returns: [] }
        accessModes.push({ id: 'tool_' + fingerprint, action: 'mcp_' + draft.name.replaceAll('-', '_') + '_' + fingerprint,
          title: tool.name, operation: selection.kind, tool: id, params: tool.params, returns: [] })
      }
      workerToolsOf({ format: 'rulith-worker-tools/1', tools })
      const definition = { name: draft.name, type: 'mcp', words: [], accessModes }
      current.services[draft.name] = { name: draft.name, mode: draft.mode, directory: draft.directory, source: draft.source, registry: draft.registry,
        tools, discovered: draft.tools.filter(tool => seen.has(tool.name)), definition }
      save(current); probes.clear(); preparations.clear()
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
      const { manifest, vault } = project(environment, workerDirectory)
      write(toolsFile, manifest); write(vaultFile, vault)
      return { ...environment, RULITH_TOOLS_FILE: toolsFile, RULITH_SECRETS_FILE: vaultFile }
    },
  }
}
