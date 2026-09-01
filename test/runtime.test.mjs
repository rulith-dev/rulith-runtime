import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { adapterToolFromSpec, builtinSourceTools, builtinWorkspaceTools, execute, orderWork, toolFromSpec, workerToolManifest } from '../worker/rulith-worker.mjs'
import { createLocalHost, defaultConfigPath, defaultLocalConfig, modeOf, normalizeLocalConfig, rolesFromArgs, rolesOf } from '../local/rulith-local.mjs'
import { localPage } from '../local/local-ui.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const PRODUCTION_DIRS = ['agent', 'worker', 'local', 'examples', 'config']
const LEGACY_RESPONSE_PATTERNS = [
  '/不认|不收|未知|无此|不支持|不识别|unknown|unsupported|unrecognized|not recognized/i',
  '/(?:已存在|already exists)/i',
  '/work-ordered|退避窗|backoff window/',
  '/退避窗\\(还剩约 (\\d+)s\\)|backoff window \\(about (\\d+)s/',
  '/gap|rejected|缺口|放电拒/i',
  '/^\\[discharge\\]|^verification ·|^\\[放电\\]|^求证 ·/i',
  '/case sealed|not closed|board.*deliverable|outstanding obligation|封板结案|没有结案|板判可交付|未结义务/i',
  '/提示:|锚建议/',
]

function productionFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.(?:mjs|json)$/.test(entry.name) ? [path] : []
  })
}

function executableText(source) {
  let text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')
  for (const pattern of LEGACY_RESPONSE_PATTERNS) text = text.replaceAll(pattern, '<legacy-response-pattern>')
  return text
}

test('artifact manifest matches every downloadable local file', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'rulith-local-runtime-artifacts/v1')
  assert.ok(Object.keys(manifest.files).length >= 15)
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const canonical = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const actual = createHash('sha256').update(canonical, 'utf8').digest('hex')
    assert.equal(actual, entry.sha256, `${rel} drifted from artifact-manifest.json`)
  }
})

test('worker prioritizes world-changing actions while preserving stable order', () => {
  const rows = [
    { workType: 'verification', id: 'v1' },
    { workType: 'action', id: 'a1' },
    { workType: 'action', id: 'a2' },
    { workType: 'evidence', id: 'e1' },
  ]
  assert.deepEqual(orderWork(rows).map((x) => x.id), ['a1', 'a2', 'v1', 'e1'])
})

test('Rulith Local has exactly agent, worker, and combined startup modes', () => {
  assert.deepEqual(rolesOf('agent'), ['agent'])
  assert.deepEqual(rolesOf('worker'), ['worker'])
  assert.deepEqual(rolesOf('agent+worker'), ['agent', 'worker'])
  assert.equal(modeOf(['agent', 'worker']), 'agent+worker')
  assert.deepEqual(rolesFromArgs(['start', '--role', 'worker'], ['agent']), ['worker'])
  assert.throws(() => rolesOf('operator'), /agent, worker, or both/)
  const config = defaultLocalConfig()
  assert.equal(config.agent.env.RULITH_MODEL_URL, 'https://api.anthropic.com/v1/messages')
  assert.equal(config.agent.env.RULITH_MODEL, 'claude-sonnet-5')
  assert.equal(config.agent.env.RULITH_MODEL_KEY, '')
  assert.equal(config.agent.env.RULITH_AGENT, undefined)
  const upgraded = normalizeLocalConfig({ roles: ['agent'], cloud: { refreshToken: 'retired' }, agent: { env: { RULITH_AGENT: 'retired-selector', RULITH_TOKEN: 'kept' } } })
  assert.equal(upgraded.agent.env.RULITH_TOKEN, 'kept')
  assert.equal(upgraded.agent.env.RULITH_AGENT, undefined)
  assert.equal(upgraded.agent.env.RULITH_MODEL_URL, 'https://api.anthropic.com/v1/messages')
  assert.equal(upgraded.cloud, undefined)
})

test('the npm package installs the Rulith Local command rather than the retired MCP binary', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'rulith')
  assert.equal(pkg.version, '0.6.1')
  assert.deepEqual(pkg.bin, { rulith: 'local/rulith-local.mjs' })
  assert.equal(pkg.private, undefined)
  assert.ok(pkg.files.includes('agent/') && pkg.files.includes('worker/') && pkg.files.includes('local/'))
  assert.equal(pkg.files.includes('examples/'), false, 'generated example runtime directories must never enter the npm package')
  assert.ok(pkg.files.includes('examples/verified-calculation/setup.mjs'))
  assert.match(defaultConfigPath('C:\\Users\\example'), /\.rulith[\\/]local\.json$/)
})

test('the first-party Agent uses the same public MCP bearer surface as every other Agent client', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /\/mcp/)
  assert.match(source, /authorization:\s*`Bearer \$\{TOKEN\}`/)
  assert.match(source, /mcpRpc\('tools\/list'\)/)
  assert.doesNotMatch(source, /agentToken=/, 'Agent credentials must never enter a URL query string')
  assert.doesNotMatch(source, /\/board\/v1\/command|\/agent\/v1\//,
    'the first-party Agent must not retain a native Cloud route unavailable to ordinary MCP clients')
})

test('Agent identity comes from the authenticated public MCP surface, never from decoding the bearer secret', () => {
  const agent = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  const local = readFileSync(join(ROOT, 'local', 'rulith-local.mjs'), 'utf8')
  assert.match(agent, /agentProtocol\('identity'\)/)
  assert.match(agent, /legacyAgentIdHint/, 'old JWTs may remain a non-authoritative display fallback during migration')
  assert.doesNotMatch(agent, /agentIdFromToken/)
  assert.doesNotMatch(local, /agentIdFromToken|split\('\.'\).*token|base64url/)
})

test('the Agent completes a minimal run through plain public MCP JSON-RPC with no native Cloud route', async () => {
  const paths = []
  const server = createServer(async (req, res) => {
    paths.push(String(req.url ?? ''))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ choices: [{ message: { content: 'DONE:' } }] }))
      return
    }
    assert.equal(req.url, '/mcp')
    assert.equal(String(req.headers.authorization), `Bearer rlt_agt_${'a'.repeat(43)}`)
    if (input.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { tools: [{ name: 'agent_protocol', inputSchema: { type: 'object' } }] } }))
      return
    }
    assert.equal(input.method, 'tools/call')
    assert.equal(input.params?.name, 'agent_protocol')
    const args = input.params?.arguments ?? {}
    let result
    if (args.mode === 'identity') result = { ok: true, agentId: 'agent-public-1' }
    else if (args.mode === 'source_access') result = { ok: true, sources: [] }
    else if (args.mode === 'evidence_chase') result = { ok: true, plans: [] }
    else if (args.mode === 'trace') result = { ok: true, took: (args.events ?? []).length }
    else {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') result = { accepted: true, revision: 'r1', payload: { status: 'open', cases: [], operations: { topLevel: ['GetCompletion', 'QueryBoard', 'ApplyBatch', 'CloseCase'], workingMemory: ['assert_fact'] } } }
      else if (operation.kind === 'OpenCase') result = { accepted: true, revision: 'r2', caseRevision: 'c0', payload: { caseId: operation.caseId, caseRevision: 'c0', capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract' } }
      else if (operation.kind === 'GetProjection' && operation.format === 'json') result = { accepted: true, revision: 'r3', payload: { context: { facts: [{ atom: { predicate: 'root', args: { node: 'case-test' } } }] } } }
      else if (operation.kind === 'GetProjection') result = { accepted: true, revision: 'r3', payload: { text: 'logic_context case-test' } }
      else if (operation.kind === 'GetCompletion') result = { accepted: true, revision: 'r3', payload: { state: 'done', certified: true, floor: 'attested', leaves: [], gaps: [], frontier: [], blocked: [] } }
      else if (operation.kind === 'QueryBoard') result = { accepted: true, revision: 'r3', payload: { facts: [] } }
      else if (operation.kind === 'GetHealth') result = { accepted: true, revision: 'r3', payload: {} }
      else if (operation.kind === 'CloseCase') result = { accepted: true, revision: 'r4', caseRevision: 'c1', payload: { disposition: 'completed' } }
      else if (operation.kind === 'ApplyBatch') result = { accepted: true, revision: 'r3', caseRevision: 'c1', payload: { text: '' }, delta: { added: [], removed: [] } }
      else result = { accepted: true, revision: 'r3', payload: {} }
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
  })
  let port
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolveReady() }))
  const child = spawn(process.execPath, ['agent/rulith-agent.mjs', '--case', 'case-test', 'test'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_URL: `http://127.0.0.1:${port}`,
      RULITH_TOKEN: `rlt_agt_${'a'.repeat(43)}`,
      RULITH_MODEL_URL: `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '',
      RULITH_TRACE: 'off', RULITH_AUTO_DISCHARGE: 'off', RULITH_MAX_ROUNDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let timeout
  const status = await Promise.race([
    new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code))),
    new Promise((resolveTimeout) => { timeout = setTimeout(() => { child.kill(); resolveTimeout('timeout') }, 12_000) }),
  ])
  clearTimeout(timeout)
  await new Promise((resolveClose) => server.close(resolveClose))
  assert.equal(status, 0, `${stdout}\n${stderr}`)
  assert.ok(paths.includes('/mcp'))
  assert.ok(paths.includes('/v1/chat/completions'))
  assert.ok(paths.every((path) => path === '/mcp' || path === '/v1/chat/completions'), `unexpected privileged path: ${paths.join(', ')}`)
})

test('rulith --help is side-effect free and does not create a credential file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-help-'))
  const config = join(dir, 'local.json')
  try {
    const run = spawnSync(process.execPath, ['local/rulith-local.mjs', '--help'], {
      cwd: ROOT, env: { ...process.env, RULITH_LOCAL_CONFIG: config }, encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /rulith start/)
    assert.equal(existsSync(config), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Rulith Local starts exactly the selected roles and receives structured child events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-roles-'))
  const child = join(dir, 'role.mjs')
  writeFileSync(child, `process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'ready'}});setInterval(()=>{},1000)\n`)
  try {
    for (const [mode, expected] of [['agent', { agent: true, worker: false }], ['worker', { agent: false, worker: true }], ['agent+worker', { agent: true, worker: true }]]) {
      const config = defaultLocalConfig()
      config.paths = { agent: child, worker: child }
      const host = createLocalHost({ configFile: join(dir, `${mode}.json`), config, roles: rolesOf(mode), port: 0, key: 'test-key' })
      try {
        await host.listen()
        await new Promise((accept) => setTimeout(accept, 80))
        assert.deepEqual(host.status(), { mode, roles: rolesOf(mode), ...expected })
        const sources = new Set(host.events().filter((event) => event.type === 'ready').map((event) => event.src))
        assert.equal(sources.has('agent'), expected.agent)
        assert.equal(sources.has('worker'), expected.worker)
      } finally { await host.close() }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Rulith Local status is a read-only redacted runtime projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-status-'))
  const child = join(dir, 'role.mjs')
  writeFileSync(child, "process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start',agentId:'agent-public-1',concurrency:1}});setInterval(()=>{},1000)\n")
  const probe = createServer()
  let port
  await new Promise((resolveReady) => probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(resolveReady) }))
  const config = defaultLocalConfig()
  config.paths = { agent: child }
  config.agent.env.RULITH_TOKEN = `rlt_agt_${'a'.repeat(43)}`
  config.agent.env.RULITH_MODEL_KEY = 'model-secret-value'
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port, key: 'status-key' })
  try {
    await host.listen()
    await new Promise((accept) => setTimeout(accept, 80))
    const response = await fetch(`http://127.0.0.1:${port}/status?k=status-key`)
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.doesNotMatch(text, /agent-secret-value|model-secret-value/)
    const status = JSON.parse(text)
    assert.equal(status.runtime.agent.id, 'agent-public-1')
    assert.equal(status.runtime.agent.credentialConfigured, true)
    assert.equal(status.runtime.agent.modelKeyConfigured, true)
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Rulith Local reports an immediate child exit instead of claiming the role restarted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-exit-'))
  const child = join(dir, 'exit.mjs')
  writeFileSync(child, 'process.exit(3)\n')
  const probe = createServer()
  let port
  await new Promise((resolveReady) => probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(resolveReady) }))
  const config = defaultLocalConfig()
  config.paths = { agent: child }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port, key: 'exit-key' })
  try {
    await host.listen()
    await new Promise((resolveWait) => setTimeout(resolveWait, 80))
    const response = await fetch(`http://127.0.0.1:${port}/control?k=exit-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', operation: 'start' }),
    })
    assert.equal(response.status, 400)
    assert.match(String((await response.json()).teaching), /exited during startup/i)
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('built-in workspace Tools expose a bounded read set and require an explicit write mode', () => {
  const readOnly = builtinWorkspaceTools('read')
  assert.deepEqual(Object.keys(readOnly).sort(), [
    'rulith.workspace.count@1',
    'rulith.workspace.hash@1',
    'rulith.workspace.list@1',
    'rulith.workspace.read_json@1',
    'rulith.workspace.read_text@1',
    'rulith.workspace.search@1',
  ])
  assert.ok(Object.values(readOnly).every((tool) => tool.adapter === 'workspace' && JSON.stringify(tool.sourceTypes) === '["file"]'))
  assert.equal(readOnly['rulith.workspace.write_text@1'], undefined)

  const readWrite = builtinWorkspaceTools('read-write')
  assert.ok(readWrite['rulith.workspace.write_text@1'])
  assert.ok(readWrite['rulith.workspace.write_json@1'])
  assert.throws(() => builtinWorkspaceTools('all'), /read or read-write/)
  assert.deepEqual(workerToolManifest(readOnly, new Set(['rulith.workspace.count@1'])).map((row) => row.id), ['rulith.workspace.count@1'],
    'the Worker presents only the built-ins authorized by its exact Connection recipe')
})

test('built-in workspace Tools stay inside their Source root and return bounded machine-readable results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-workspace-'))
  try {
    writeFileSync(join(root, 'input.json'), JSON.stringify({ amount: 7 }))
    writeFileSync(join(root, 'notes.txt'), 'alpha\nbeta\nalpha again\n')
    const tools = builtinWorkspaceTools('read-write')
    const sources = { workspace: { access: root, type: 'file' } }
    const call = (id, args) => {
      if (Object.values(args).some((value) => value !== null && typeof value === 'object')) {
        const definition = tools[id]
        const local = { name: id, kind: 'write', impl: definition.adapter, source: 'workspace', operation: definition.entry }
        return execute(id, args, { [id]: local }, sources)
      }
      const params = Object.fromEntries(Object.entries(args).map(([name, value]) => [name, typeof value]))
      const local = toolFromSpec(JSON.stringify({
        name: id, kind: id.includes('write_') ? 'write' : 'read', impl: 'worker-tool',
        source: 'workspace', exec: id, params,
      }), JSON.stringify(args), tools, tools[id].digest, sources)
      return execute(id, args, { [id]: local }, sources)
    }

    const readResult = await call('rulith.workspace.read_json@1', { path: 'input.json' })
    const read = JSON.parse(String(readResult.result))
    assert.deepEqual(read, { amount: 7 })
    assert.deepEqual(readResult.rows[0], { source: 'workspace', path: 'input.json', json: '{"amount":7}', digest: readResult.rows[0].digest })
    const searchResult = await call('rulith.workspace.search@1', { query: 'alpha', path: '.' })
    const search = JSON.parse(String(searchResult.result))
    assert.equal(search.matches.length, 2)
    assert.ok(search.matches.every((row) => row.path === 'notes.txt'))
    const count = await call('rulith.workspace.count@1', { path: '.', recursive: false })
    assert.deepEqual(count.rows[0], {
      source: 'workspace', path: '.', recursive: false, file_count: 2, directory_count: 0,
      digest: count.rows[0].digest,
    })
    assert.match(count.rows[0].digest, /^[a-f0-9]{64}$/)
    const countTool = toolFromSpec(JSON.stringify({
      name: 'count_source', kind: 'read', impl: 'worker-tool', source: 'workspace', exec: 'rulith.workspace.count@1',
      params: { path: 'string', recursive: 'boolean' },
      returns: [{ predicate: 'acme.files.directory_count', args: { source: '$source', path: '$path', file_count: '$file_count', digest: '$digest' } }],
    }), JSON.stringify({ path: '.', recursive: false }), tools, tools['rulith.workspace.count@1'].digest, sources)
    for (const [args, expected] of [
      [{ path: '.', recursive: false, surprise: true }, /undeclared parameter/i],
      [{ path: '.' }, /missing required parameter/i],
      [{ path: '.', recursive: 'false' }, /recursive must be boolean/i],
    ]) {
      assert.throws(() => toolFromSpec(JSON.stringify({
        name: 'count_source', kind: 'read', impl: 'worker-tool', source: 'workspace', exec: 'rulith.workspace.count@1',
        params: { path: 'string', recursive: 'boolean' },
      }), JSON.stringify(args), tools, tools['rulith.workspace.count@1'].digest, sources), expected)
    }
    const counted = await execute('count_source', { path: '.', recursive: false }, { count_source: countTool }, sources)
    assert.deepEqual(counted.facts, [{ predicate: 'acme.files.directory_count', args: {
      source: 'workspace', path: '.', file_count: 2, digest: count.rows[0].digest,
    } }], 'workspace returns must cross the same structured result membrane as run adapters')
    const hash = await call('rulith.workspace.hash@1', { path: 'input.json' })
    const digest = String(hash.result)
    assert.match(digest, /^[a-f0-9]{64}$/)
    assert.deepEqual(hash.rows[0], { source: 'workspace', path: 'input.json', sha256: digest, size: 12 })

    await call('rulith.workspace.write_json@1', { path: 'out/result.json', value: { ok: true } })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'out', 'result.json'), 'utf8')), { ok: true })
    assert.ok(!readdirSync(join(root, 'out')).some((name) => name.includes('.rulith-') && name.endsWith('.tmp')),
      'strict file writes must publish by same-directory rename and leave no partial artifact')
    await assert.rejects(
      call('rulith.workspace.read_text@1', { path: '../outside.txt' }),
      /outside the configured Source root/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('database Tool templates compile to driver parameters and never interpolate model values into SQL', () => {
  const compiled = adapterToolFromSpec(JSON.stringify({
    name: 'orders.lookup', impl: 'db-query', source: 'orders',
    exec: 'SELECT * FROM orders WHERE id={order_id} OR parent_id={order_id} AND active={active} AND label={label}',
    params: { order_id: 'number', active: 'boolean', label: 'string' },
  }), JSON.stringify({ order_id: 702, active: true, label: "x' OR 1=1 --" }))
  assert.equal(compiled.sql, 'SELECT * FROM orders WHERE id=$1 OR parent_id=$1 AND active=$2 AND label=$3')
  assert.deepEqual(compiled.values, [702, true, "x' OR 1=1 --"])
  assert.ok(!compiled.sql.includes('702') && !compiled.sql.includes('OR 1=1'),
    'business values must reach the database only through the driver values array')
})

test('MCP discovery returns bounded governed rows without authorizing a generic remote call', async () => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(request)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: 1, result: { tools: [{
          name: 'orders.lookup', description: 'Look up one order', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
        }] } }
      : { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"rows":[{"exists":true}]}' }] } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const tools = builtinSourceTools()
    const id = 'rulith.mcp.discover@1'
    const sources = { erp: { type: 'mcp', url: `http://127.0.0.1:${server.address().port}` } }
    const local = toolFromSpec(JSON.stringify({
      name: 'discover_erp', kind: 'read', impl: 'worker-tool', source: 'erp', exec: id, params: {},
      returns: [{ predicate: 'rulith.source.mcp_tool', args: {
        source: '$source', tool_name: '$tool_name', description: '$description', input_schema_json: '$input_schema_json',
      } }],
    }), '{}', tools, tools[id].digest, sources)
    const out = await execute('discover_erp', {}, { discover_erp: local }, sources)
    assert.equal(requests[0].method, 'tools/list')
    assert.deepEqual(out.facts, [{ predicate: 'rulith.source.mcp_tool', args: {
      source: 'erp', tool_name: 'orders.lookup', description: 'Look up one order',
      input_schema_json: '{"type":"object","properties":{"order_id":{"type":"string"}}}',
    } }])
    const named = adapterToolFromSpec(JSON.stringify({
      name: 'acme.erp.lookup@1', impl: 'mcp', source: 'erp', exec: 'orders.lookup',
    }), JSON.stringify({ order_id: 'O-1' }))
    await execute('named_mcp_call', { order_id: 'O-1' }, { named_mcp_call: named }, sources)
    assert.equal(requests[1].method, 'tools/call')
    assert.equal(requests[1].params.name, 'orders.lookup',
      'the local manifest entry fixes the remote Tool; an Action name cannot choose an arbitrary MCP Tool')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    server.closeAllConnections()
  }
})

test('HTTP Tools stay under the governed Source origin and preserve typed GET/write result rows', async () => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rows: req.method === 'GET'
      ? [{ item_id: 'O-1', exists: true }]
      : [{ accepted: true }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const sources = { api: { type: 'http', url: `http://127.0.0.1:${server.address().port}/` } }
    const read = adapterToolFromSpec(JSON.stringify({
      name: 'catalog.get', kind: 'read', impl: 'http', source: 'api', exec: '/items/{item_id}',
      params: { item_id: 'string' }, fence: { method: 'GET', maxResponseBytes: 4096 },
      returns: [{ predicate: 'acme.catalog.item_exists', args: { item_id: '$item_id', exists: '$exists' } }],
    }), JSON.stringify({ item_id: 'O-1' }))
    const readOut = await execute('catalog_get', { item_id: 'O-1' }, { catalog_get: read }, sources)
    assert.deepEqual(readOut.facts, [{ predicate: 'acme.catalog.item_exists', args: { item_id: 'O-1', exists: true } }])
    assert.deepEqual(requests[0], { method: 'GET', url: '/items/O-1', body: '' })

    const write = adapterToolFromSpec(JSON.stringify({
      name: 'webhook.post', kind: 'write', impl: 'http', source: 'api', exec: '/events',
      params: { event: 'string' }, fence: { method: 'POST', maxResponseBytes: 4096 },
      returns: [{ predicate: 'acme.webhook.accepted', args: { accepted: '$accepted' } }],
    }), JSON.stringify({ event: 'closed' }))
    const writeOut = await execute('webhook_post', { event: 'closed' }, { webhook_post: write }, sources)
    assert.deepEqual(writeOut.facts, [{ predicate: 'acme.webhook.accepted', args: { accepted: true } }])
    assert.deepEqual(requests[1], { method: 'POST', url: '/events', body: '{"event":"closed"}' })
    assert.throws(() => adapterToolFromSpec(JSON.stringify({
      name: 'escape', kind: 'read', impl: 'http', source: 'api', exec: 'https://other.example/data', params: {},
    }), '{}'), /relative path/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    server.closeAllConnections()
  }
})

test('agent help is available before credentials and points automation at the service port', () => {
  const run = spawnSync(process.execPath, ['agent/rulith-agent.mjs', '--help'], {
    cwd: ROOT,
    env: { ...process.env, RULITH_TOKEN: '', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RULITH_SERVE_PORT/)
  assert.doesNotMatch(run.stdout, /--ui|RULITH_UI_PORT/)
  assert.match(run.stdout, /--case <id>/)
  assert.doesNotMatch(run.stdout, /--case-boards|--recipe/)
  assert.doesNotMatch(run.stderr, /missing/i)
})

test('the Agent permits a keyless loopback model without sending an empty authorization header', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /keylessLoopbackModel/)
  assert.match(source, /cfg\.key === '' \? baseHeaders/)
  assert.match(source, /OpenAI-compatible model service URLs must be the server root/)
})

test('the local runtime has no client-owned recipe or Board-profile surface', () => {
  const run = spawnSync(process.execPath, ['agent/rulith-agent.mjs', '--case-boards', '--recipe', 'client-owned.json', 'test'], {
    cwd: ROOT,
    env: { ...process.env, RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: 'test-token', RULITH_MODEL_KEY: 'test-model-key' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Unknown option: --case-boards/)
  assert.doesNotMatch(run.stderr, /Cannot read recipe file/)
})

test('worker rejects bad credentials before claiming to be online and exits cleanly', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ accepted: false, teaching: 'credential rejected' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_WORK_URL: `http://127.0.0.1:${port}/work`,
      RULITH_CONNECTION: 'test-connection',
      RULITH_CONNECTION_KEY: 'wrong-key',
      RULITH_TOOLS_FILE: join(ROOT, 'test', 'does-not-exist.json'),
      RULITH_SOURCES_FILE: join(ROOT, 'test', 'does-not-exist.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const code = await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not exit after credential rejection')), 5000)),
  ]).finally(() => server.close())

  assert.equal(code, 3, stderr)
  assert.doesNotMatch(stdout, /online/)
  assert.match(stderr, /Connection credential rejected/)
  assert.doesNotMatch(stderr, /edge preserves|Assertion failed|UV_HANDLE_CLOSING/)
})

test('worker surfaces non-authenticated Poll refusal instead of printing an idle heartbeat', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.method === 'GET' ? 200 : 403, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.method === 'GET'
      ? { sources: [] }
      : { accepted: false, errorCode: 'worker_tool_not_authorized', teaching: 'versioned Tool id is not carried by this Connection' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const child = spawn(process.execPath, ['worker/rulith-worker.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_WORK_URL: `http://127.0.0.1:${port}/work`,
      RULITH_CONNECTION: 'test-connection',
      RULITH_CONNECTION_KEY: 'test-key',
      RULITH_TOOLS_FILE: join(ROOT, 'test', 'does-not-exist.json'),
      RULITH_SOURCES_FILE: join(ROOT, 'test', 'does-not-exist.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const deadline = Date.now() + 5_000
  while (!/Worker endpoint rejected Poll with HTTP 403/.test(stderr) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('close', resolve))
  await new Promise((resolve) => server.close(resolve))

  assert.match(stderr, /Worker endpoint rejected Poll with HTTP 403: versioned Tool id is not carried by this Connection/)
})

test('the local Agent does not assemble, fingerprint, or install governance recipes', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.doesNotMatch(source, /fingerprintRecipePacks|recipeDigestOver|--recipe/)
  assert.match(source, /Do not attempt add_axiom, define_action, RegisterPack/)
})

test('the local Agent sends business values while Cloud injects commercial pins and exposes one bounded Case View', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /--business-key <json>/)
  assert.match(source, /kind: 'OpenCase'[\s\S]{0,180}businessKey/)
  assert.match(source, /RULITH_ATTENTION_FACTS \?\? 80/)
  assert.match(source, /kind: 'GetCompletion'/)
  assert.match(source, /reply VIEW: to refresh it/)
  assert.doesNotMatch(source, /projectionText\(ctx, \{ full: true \}\)/)
})

test('exploration uses an explicit Case-local provisional program without widening normal execution', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /const SYSTEM_EXPLORATION =/)
  assert.match(source, /case_context\(case_id, root, case_type\)/)
  assert.match(source, /rulith\.exploration\.completed\(case_id\)/)
  assert.match(source, /platform-owned bridge/)
  assert.match(source, /do not create pack_acceptance, pack_bridge_evidence, pack_loaded, or pack_rule bookkeeping/)
  assert.match(source, /caseType === 'exploration' \? SYSTEM_EXPLORATION : SYSTEM/)
  assert.match(source, /const SYSTEM = `[\s\S]*Do not add temporary axioms, define actions, or register packs/,
    'normal Capability execution must remain closed to provisional semantics')
})

test('the Agent teaches the same typed Action parameter contract enforced by Core and Worker', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /Every argument must be declared, present when required, and match its declared string\/number\/boolean type/)
  assert.match(source, /rejects the call before creating an invocation/)
})

test('the Agent asks Cloud for ranked frontier routes without treating a plan as authority', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /agentProtocol\('evidence_chase'/)
  assert.doesNotMatch(source, /\/agent\/v1\/evidence-chase/)
  assert.match(source, /ranked hints, not automatic authority/)
  assert.match(source, /Supply missing clue bindings; never assert them as facts/)
})

test('agent lifecycle events shown to users use the English product vocabulary', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /\[Verification\]/)
  assert.match(source, /Closed Case "\$\{bound\.root\}" with disposition/)
  assert.match(source, /emitOn\(ctx, 'case-closed'/)
  assert.match(source, /Board certified the case as deliverable/)
  assert.doesNotMatch(source, /notes\.push\(`\[放电/)
  assert.doesNotMatch(source, /log\(`◎ 案卷/)
})

test('Rulith Local presents a familiar Case-first Agent workbench in English', () => {
  const hostSource = readFileSync(join(ROOT, 'local', 'rulith-local.mjs'), 'utf8')
  const visible = localPage.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(localPage)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script), 'the embedded Local UI script must compile')
  assert.match(localPage, /New Case/)
  assert.match(localPage, /Case View/)
  assert.match(localPage, /Current frontier/)
  assert.match(localPage, /Worker activity/)
  assert.match(localPage, /Give the Agent a task/)
  assert.match(localPage, /receipt committed/)
  assert.match(localPage, /Authoritative receipt/)
  assert.match(localPage, /e\.invocation/)
  assert.match(localPage, /'remote'/)
  assert.match(localPage, /role="dialog"/)
  assert.match(localPage, /Runtime details/)
  assert.match(localPage, /Read-only projection of the single-Agent Runtime configuration/)
  assert.match(localPage, /Start Agent/)
  assert.match(localPage, /Stop Worker/)
  assert.match(localPage, /id="detailconfig"/)
  assert.match(localPage, /id="caseoptions"/)
  assert.match(localPage, /id="modelbadge"/)
  assert.match(localPage, /data-view="case"/)
  assert.match(localPage, /Session log/)
  assert.doesNotMatch(localPage, /Sign in to Rulith Cloud|Use this Agent|Bind to this Local/)
  assert.doesNotMatch(localPage, /Provider API key|Load models|data-save=/)
  assert.doesNotMatch(hostSource, /\/local\/v1\/account|\/account\/logout|\/auth\/start/)
  assert.doesNotMatch(hostSource, /path === '\/config'/, 'the observer UI has no browser configuration write surface')
  assert.doesNotMatch(localPage, /<details>/, 'settings must open in a visible modal rather than below the inspector fold')
  assert.match(localPage, /response\?\.status===403\)\{location\.reload\(\)/)
  assert.match(localPage, /\.composebox\{position:relative;width:min\(790px,100%\)/)
  assert.doesNotMatch(localPage, /padding:12px max\(/, 'percentage padding collapses the composer inside the center grid column')
  assert.match(hostSource, /'cache-control': 'no-store'/)
  assert.doesNotMatch(visible, /本地站|智能体（脑）|手的流水|核验通过|还没开单/)
})

test('production-facing runtime text is English-only', () => {
  const files = PRODUCTION_DIRS.flatMap((dir) => productionFiles(join(ROOT, dir)))
  assert.ok(files.length >= 15)
  for (const file of files) {
    const text = executableText(readFileSync(file, 'utf8'))
    const match = text.match(/[\u3400-\u9fff]/)
    if (match) {
      const line = text.slice(0, match.index).split('\n').length
      assert.fail(`${file.slice(ROOT.length + 1)}:${line} contains CJK in production-facing text`)
    }
  }
})

test('verified calculation prepares a local Tool Manifest and adapters; governed Capability stays off the client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-runtime-'))
  const example = join(ROOT, 'examples', 'verified-calculation')
  try {
    const run = spawnSync(process.execPath, ['prepare-runtime.mjs'], {
      cwd: example,
      env: { ...process.env, RULITH_CALC_RUNTIME: dir },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    assert.equal(existsSync(join(dir, 'worker-tools.json')), true,
      'local Adapter bindings must be explicit in the Worker Tool Manifest')
    assert.equal(existsSync(join(dir, 'input.json')), true)
    assert.equal(existsSync(join(dir, 'adapters', 'verified-calculation', 'read-input.mjs')), true)
    assert.equal(existsSync(join(dir, 'recipe.json')), false, 'managed capability packages must not be rendered into the client workspace')
    assert.equal(existsSync(join(dir, 'recipe.template.json')), false,
      'the public market source must not be downloaded as a client-owned recipe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verified calculation is one Capability composed of Program and Sources', () => {
  const recipe = JSON.parse(readFileSync(join(ROOT, 'examples', 'verified-calculation', 'recipe.template.json'), 'utf8'))
  const guide = readFileSync(join(ROOT, 'examples', 'verified-calculation', 'README.md'), 'utf8')
  assert.deepEqual(recipe.packs.map((entry) => entry.packType), ['program', 'sources'])
  assert.deepEqual(recipe.packs.map((entry) => entry.title ?? entry.pack.title ?? entry.pack.meta?.title), [
    'Verified Calculation — Program',
    'Verified Calculation — Local source',
  ])
  assert.equal(recipe.collection.id, 'verified_calculation')
  assert.equal(recipe.collection.version, '1.0.0')
  assert.deepEqual(recipe.packs[0].pack.pins, ['rulith.verified_calculation.calculation_result', 'rulith.verified_calculation.calculation_completed'],
    'the public recipe must pin the Case result and acceptance root used by the hosted Capability')
  assert.equal(recipe.collection.caseContracts?.[0]?.format, 'rulith-case-contract/1')
  assert.equal(recipe.collection.caseContracts?.[0]?.caseType, 'verified_calculation')
  assert.equal(recipe.collection.caseContracts?.[0]?.acceptance?.predicate, 'rulith.verified_calculation.calculation_completed')
  assert.equal(recipe.collection.caseContracts?.[0]?.terminal?.cardinality, 'once_per_case')
  assert.equal('line' in recipe.packs[1].pack.sources[0], false)
  assert.equal(recipe.packs[0].pack.acceptance.length, 1)
  assert.match(guide, /one\s+installed Capability, with four inspectable sections/i)
  assert.doesNotMatch(guide, /two governed components|install.*Knowledge[\s\S]*install.*source/i,
    'typed protocol components must not leak back into the user installation ritual')
  assert.match(guide, /verified-calc-worker/)
  assert.doesNotMatch(guide, /verified-calculation-worker/)
  assert.match(guide, /RULITH_WORKER_ROOT=<this-directory>\/runtime/,
    'source-checkout instructions must resolve Adapter entries from the generated runtime directory')
})

test('verified calculation intake roots its task tree in the trusted active Case', () => {
  const adapter = readFileSync(join(ROOT, 'examples', 'verified-calculation', 'read-input.mjs'), 'utf8')
  assert.match(adapter, /RULITH_CASE_ID/)
  assert.doesNotMatch(adapter, /task_root:\s*['"]CALCULATION_CASE['"]/)
})

test('public runtime contains no private deployment addresses or credential material', () => {
  for (const rel of [
    'agent/rulith-agent.mjs',
    'worker/rulith-worker.mjs',
    'local/rulith-local.mjs',
    'local/local-ui.mjs',
  ]) {
    const source = readFileSync(join(ROOT, rel), 'utf8')
    assert.doesNotMatch(source, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    assert.doesNotMatch(source, /(?:192\.168\.|43\.161\.|49\.51\.)/)
    assert.doesNotMatch(source, /michaltina|victor shaw/i)
  }
})

// ── Published knobs must exist ───────────────────────────────────────────────
//
// The failure this closes has no error channel of its own. A README that teaches
// `RULITH_CHANNEL` after the Worker renamed it to `RULITH_CONNECTION` reads
// perfectly, ships green, and costs the reader an `exit(2)` on their first run —
// they blame themselves, not the document. Same for a flag: the Agent's argument
// parser rejects anything it does not know and exits 1, so a documented
// `--case-boards` is a published instruction to fail.
//
// The guard therefore checks the two directions that can rot silently:
//   · every RULITH_* name taught in a committed public file is read by the code;
//   · every Agent flag taught in an Agent invocation is accepted by the parser.
//
// Extraction failure must be RED, not green: an empty read of either source set
// would make every taught name look supported. The floors below are the assertion
// that the extractors still have hold of the sources.

/** Environment variable names the shipped runtime actually reads. */
function runtimeEnvNamesRead() {
  const names = new Set()
  const roots = ['agent', 'worker', 'local', 'examples', 'scripts']
  for (const root of roots) {
    const dir = join(ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of productionFiles(dir)) {
      if (!file.endsWith('.mjs')) continue
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1])
      for (const m of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) names.add(m[1])
    }
  }
  return names
}

/** Command-line flags the Agent's argument parser accepts; everything else exits 1. */
function agentFlagsAccepted() {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  const flags = new Set()
  for (const m of source.matchAll(/argv(?:\[i\]\s*===|\.includes\()\s*'(--[a-z][a-z0-9-]*)'/g)) flags.add(m[1])
  return flags
}

/** Committed files a reader copies from. Anything here is an instruction, not a note. */
const PUBLIC_INSTRUCTION_FILES = [
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'examples/verified-calculation/README.md',
  'config/rulith-local.example.json',
  'config/rulith-sources.example.json',
  'config/worker-tools.example.json',
]

test('committed public files only teach environment variables the runtime reads', () => {
  const read = runtimeEnvNamesRead()
  assert.ok(read.size >= 20, `only extracted ${read.size} environment reads from the runtime — the extractor lost the source`)

  const taught = []
  let scanned = 0
  for (const rel of PUBLIC_INSTRUCTION_FILES) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) continue
    scanned += 1
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/\bRULITH_[A-Z0-9_]+\b/g)) taught.push({ name: m[0], rel })
  }
  assert.equal(scanned, PUBLIC_INSTRUCTION_FILES.length, 'a listed public file is missing; the scan would silently shrink')
  assert.ok(taught.length >= 15, `only found ${taught.length} taught names — the document scan is not reaching the code fences`)

  const unread = [...new Set(taught.filter((e) => !read.has(e.name)).map((e) => `${e.name} (${e.rel})`))].sort()
  assert.deepEqual(unread, [],
    'these names are published as instructions but nothing in the runtime reads them.\n  '
    + unread.join('\n  ')
    + '\nA reader who copies them gets a process that exits without ever seeing the value it needed.')
})

test('committed public files only teach Agent flags the Agent accepts', () => {
  const accepted = agentFlagsAccepted()
  assert.ok(accepted.size >= 4, `only extracted ${accepted.size} accepted flags — the parser scan failed`)
  assert.ok(!accepted.has('--agent') && accepted.has('--serve'), 'the Agent id must come only from the MCP token')

  // Only flags on an Agent invocation count. `git clone --depth` in the same README
  // belongs to another command; widening the scan to every flag would make this guard
  // noisy and the next person would delete it.
  const taught = []
  for (const rel of PUBLIC_INSTRUCTION_FILES) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!/rulith-agent\.mjs/.test(line)) continue
      for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) taught.push({ flag: m[1], rel })
    }
  }
  // The Local example launches the Agent through `paths.agent`, so its argument
  // array is an Agent invocation even though the binary name is on another line.
  const local = JSON.parse(readFileSync(join(ROOT, 'config', 'rulith-local.example.json'), 'utf8'))
  for (const arg of local.agent?.args ?? []) {
    if (/^--/.test(arg)) taught.push({ flag: arg, rel: 'config/rulith-local.example.json' })
  }
  assert.ok(taught.length >= 3, `only found ${taught.length} taught Agent flags — the invocation scan is not matching`)

  const rejected = [...new Set(taught.filter((e) => !accepted.has(e.flag)).map((e) => `${e.flag} (${e.rel})`))].sort()
  assert.deepEqual(rejected, [],
    'these flags are published but the Agent rejects them and exits 1.\n  '
    + rejected.join('\n  '))
})
