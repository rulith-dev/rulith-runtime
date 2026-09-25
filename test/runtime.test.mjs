import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { adapterToolFromSpec, builtinSourceTools, builtinWorkspaceTools, execute, orderWork, protectedWorkerExecutables, toolDigest, toolFromSpec, workerToolManifest, workerToolsOf, workspaceWriteEnabled } from '../worker/rulith-worker.mjs'
import { createLocalHost, defaultConfigPath, defaultLocalConfig, effectiveChildEnv, localInteger, modeOf, normalizeLocalConfig, rolesFromArgs, rolesOf } from '../local/rulith-local.mjs'
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

function productionFiles(dir, root = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // These generated example directories are excluded by .gitignore and
      // package.json. Keep scanning all other source, including new Adapters.
      if (/^examples[/\\]/.test(relative(root, path))
        && ['runtime', '.runtime-test', 'rulith-demo'].includes(entry.name)) return []
      return productionFiles(path, root)
    }
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

test('Rulith Local validates shared port settings once instead of letting parent and Agent diverge', () => {
  assert.equal(localInteger('RULITH_SERVE_PORT', '7798', 7799), 7798)
  assert.equal(localInteger('RULITH_SERVE_PORT', undefined, 7799), 7799)
  assert.throws(() => localInteger('RULITH_SERVE_PORT', 'NaN', 7799), /integer between 1 and 65535/)
  // A bounded integer setting the supervisor still validates for itself. Cross-conversation
  // concurrency is gone — one Agent, one connection, one segment — so there is no such
  // setting to check any more; the port is what both sides must agree on.
  assert.throws(() => localInteger('RULITH_SERVE_PORT', '70000', 7799), /integer between 1 and 65535/)
})

test('blank example config values inherit non-empty supervisor environment values', () => {
  const effective = effectiveChildEnv({
    RULITH_TOKEN: 'supervisor-agent-token',
    RULITH_CONNECTION_KEY: 'supervisor-worker-key',
    RULITH_MODEL: 'supervisor-model',
  }, {
    RULITH_TOKEN: '',
    RULITH_CONNECTION_KEY: '   ',
    RULITH_MODEL: 'configured-model',
  })
  assert.equal(effective.RULITH_TOKEN, 'supervisor-agent-token')
  assert.equal(effective.RULITH_CONNECTION_KEY, 'supervisor-worker-key')
  assert.equal(effective.RULITH_MODEL, 'configured-model')
})

test('the npm package installs the Rulith Local command rather than the retired MCP binary', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.name, 'rulith')
  assert.equal(pkg.version, '0.8.17')
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages?.['']?.version, pkg.version)
  assert.match(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'),
    new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')}(?: - |$)`, 'm'),
    'the package version has no release notes')
  assert.ok(readFileSync(join(ROOT, 'examples/verified-calculation/README.md'), 'utf8').includes(`rulith@${pkg.version}`),
    'the installation guide still names another npm release')
  assert.ok(readFileSync(join(ROOT, 'examples/verified-calculation/setup.mjs'), 'utf8').includes(`/v${pkg.version}`),
    'the example setup still downloads another release tag')
  assert.deepEqual(pkg.bin, { rulith: 'local/rulith-local.mjs' })
  assert.equal(pkg.private, undefined)
  assert.ok(pkg.files.includes('agent/') && pkg.files.includes('worker/') && pkg.files.includes('local/'))
  assert.equal(pkg.files.includes('examples/'), false, 'generated example runtime directories must never enter the npm package')
  assert.ok(pkg.files.includes('examples/verified-calculation/setup.mjs'))
  assert.match(defaultConfigPath('C:\\Users\\example'), /\.rulith[\\/]local\.json$/)
})

test('the first-party Agent uses the same public MCP bearer surface as every other Agent client', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /const MCP_URL = `\$\{URL_BASE\}\/mcp`/)
  assert.doesNotMatch(source, /\/mcp\/host/,
    'the host-only MCP surface is retired; first-party and tools-only clients share one path')
  assert.match(source, /authorization:\s*`Bearer \$\{TOKEN\}`/)
  assert.match(source, /mcpRpc\('tools\/list', cursor === undefined \? \{\} : \{ cursor \}, \{ handshake: true \}\)/)
  assert.doesNotMatch(source, /agentToken=/, 'Agent credentials must never enter a URL query string')
  assert.doesNotMatch(source, /\/board\/v1\/command|\/agent\/v1\//,
    'the first-party Agent must not retain a native Cloud route unavailable to ordinary MCP clients')
})

test('the model surface is the seven tools of the unified list, and no second grammar survives', () => {
  const whole = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  // The runtime names the retired surfaces once, in the constant it refuses them by. That
  // single declaration is the allow-list; the scan below runs over everything else, so a
  // retired name reappearing anywhere it could be *called* still turns this red.
  assert.match(whole, /const RETIRED_TOOL_NAMES = \['agent_protocol', 'GetCompletion', 'GetBoardManifest', 'RunDischarge', 'GetProjection', 'GetChanges'\]/,
    'the refusal list for retired host surfaces is gone, so advertising one would no longer be named')
  const source = whole.split('\n').filter((line) => !line.startsWith('const RETIRED_TOOL_NAMES =')).join('\n')
  // Membership comes from the vendored projection of `protocol/mcp-surface.json`, with each
  // tool's dispatch target beside it, and from nowhere else. The retired handwritten
  // `agentVerb` / `agentRead` membership fields are gone with the host split.
  assert.match(source, /const RULITH_MCP_SURFACE = Object\.freeze\(\[/)
  assert.match(source, /const MODEL_TOOLS = RULITH_MCP_SURFACE\.map\(\(entry\) => entry\.name\)/)
  assert.match(source, /name: 'ReadArtifact', target: 'artifact'/)
  assert.match(source, /name: 'ReadOperation', target: 'operation'/)
  assert.match(source, /const BOARD_TOOLS = new Set\(RULITH_MCP_SURFACE\.filter\(\(entry\) => entry\.target === 'core'\)/)
  assert.doesNotMatch(source, /agentVerb|agentRead/)
  // The retired fenced-JSON dialect, the retired host tool split, and the client-side
  // orchestration that used to sit behind it — by name. A path that is merely unreachable
  // is one edit away from being reachable again.
  for (const retired of [
    'EXECUTION_GUIDE', 'OPTIONAL_RULITH', 'SYSTEM_EXPLORATION', 'SYSTEM_LOCKED',
    'parseRulithEnvelope', 'extractSubmission', 'containsNonExclusiveRulithEnvelope',
    'MODEL_COMMAND_KINDS', 'modelCommandRefusal', 'FLOOR_ORDER',
    'start_case', 'apply_batch', 'request_action', 'finish_case', 'read_case', 'pause_case', 'resume_case',
    'HOST_TOOLS', 'agentProtocol', 'GetCompletion', 'agent_protocol', 'RunDischarge', 'GetBoardManifest',
    'ResumeCase', 'runDischarge', 'probeLawLock', 'hostView', 'traceForward', 'flushTrace',
    // The retired host poll loop, by its declaration rather than by the word: the host no
    // longer polls the Board for progress. Settling an *unresolved call* against the
    // authority's own recovery record is a different thing and keeps the word.
    'async function settle\\(', 'SETTLE_POLL_MS',
    'CASE_CONTEXT_OPERATIONS', 'RULITH_TRACE', 'RULITH_AUTO_DISCHARGE', 'RULITH_SETTLE_WAIT_MS',
    'certifiedOf', 'expectedRevision:',
    // The observation layer, by every name it wore. A dependency-level view token, the
    // ledger behind it and the first-write exception are retired together; keeping any one
    // of them would be keeping the rule.
    'OBSERVATION_REFUSALS', 'stale_observation', 'scope_expanded', 'turnObservation', 'bootstrapUsed',
    'persistSlotRecord', 'restoreSlotRecord',
  ]) {
    assert.doesNotMatch(source, new RegExp(retired), `${retired} survived the single-MCP rewrite`)
  }
  assert.doesNotMatch(source, /DONE:|STOP:|VIEW:/, 'a reply protocol is a second grammar')
  // Lifecycle words are the authority's. The local ladder that used to rank an evidence
  // floor had to be edited whenever Core added a tier, and an unknown tier read as the
  // weakest — a silent downgrade in the direction that looks safe.
  // The authority's closed lifecycle set, exactly. Carrying the words the retired per-Case
  // model used would let a status Core says it never sends be displayed as if it had.
  assert.match(source, /const LIFECYCLE = \['running', 'paused', 'closed'\]/)
  assert.match(source, /const TERMINAL_LIFECYCLE = new Set\(\['closed'\]\)/)
  assert.doesNotMatch(source, /TIER_ORDER|floorRank/)
})

test('the retired wire fields are stripped from schemas and refused when a model sends them', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  // `viewToken` moved from "host-supplied" to "retired": there is no observation to
  // present any more, so a model that names one is refused rather than quietly stripped.
  assert.match(source, /const RETIRED_TOOL_FIELDS = \['case', 'expectedRevision', 'caseRevision', 'expectedBoardSharedEpoch', 'viewToken'\]/)
  assert.match(source, /const HOST_METADATA_FIELDS = \[[^\]]*'kind'[^\]]*'queryContext'[^\]]*'audienceProfile'[^\]]*'requestedRoots'[^\]]*'requestId'/s)
  assert.match(source, /const HOST_OWNED_TOOL_FIELDS = \[\.\.\.RETIRED_TOOL_FIELDS, \.\.\.HOST_METADATA_FIELDS\]/)
  assert.match(source, /refusal\(retired\.length > 0 \? 'retired_wire_field' : 'host_owned_field', teaching\)/)
  assert.match(source, /retiredFieldTeaching/)
  assert.match(source, /hostFieldTeaching/)
})

test('Agent identity comes from the authenticated MCP handshake, never from decoding the bearer secret', () => {
  const agent = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  const local = readFileSync(join(ROOT, 'local', 'rulith-local.mjs'), 'utf8')
  assert.match(agent, /await openSession\(\)/)
  // One connection for the Agent, not one per conversation: a second authenticated
  // connection does not isolate two conversations, it takes the Agent away from one of them.
  assert.match(agent, /const connection = \{/)
  assert.doesNotMatch(agent, /makeSession\(/, 'a per-conversation session factory survived')
  assert.doesNotMatch(agent, /SERVE_CONCURRENCY/, 'cross-conversation concurrency survived')
  assert.match(agent, /meta\?\.agentId === 'string'/)
  assert.match(agent, /returned no Agent identity in/)
  assert.doesNotMatch(agent, /legacyAgentIdHint|agentIdFromToken/,
    'decoding the bearer secret authenticates nothing and must not survive as an identity fallback')
  assert.doesNotMatch(local, /agentIdFromToken|split\('\.'\).*token|base64url/)
})

test('ordinary startup performs no Board read of any kind', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  // The startup block runs `initialize`, the initialized notification, and `tools/list`.
  // A bootstrap `QueryBoard` — even a dummy one issued only to learn the Agent id — would
  // make the Board tool mandatory in everything but name.
  const startup = /let startupFailed = false\n([\s\S]*?)\nif \(!startupFailed\)/.exec(source)?.[1]
  assert.ok(startup, 'the startup block could not be found')
  assert.doesNotMatch(startup, /callTool|QueryBoard|OpenCase/,
    'startup reached the Board before the model had decided whether Rulith was useful')
  assert.match(source, /it will not open a Case or read the Board merely to learn who it is/)
})

test('the Agent completes a minimal run through a real local MCP server, on /mcp and nothing else', async () => {
  // A hand-written server rather than the shared harness: this arm is about the protocol
  // the Runtime speaks to an arbitrary MCP endpoint — the lifecycle, the session header,
  // the metadata channel — not about Board behaviour. If the two ever disagree, the one
  // that fails first is the one to trust.
  const paths = []
  const methods = []
  const toolNames = []
  const sentMeta = []
  const terminated = []
  let closed = false
  const sessionId = 'live-session-1'
  const boardView = (focused) => ({
    roots: focused ? [{ caseId: 'CASE_LIVE', root: 'ROOT_LIVE', status: 'running' }] : [],
    cases: { directory: [{ caseId: 'CASE_LIVE', root: 'ROOT_LIVE', status: focused ? 'running' : 'closed' }], total: 1 },
    gaps: [], nodes: [], actions: [],
  })
  const server = createServer(async (req, res) => {
    paths.push(String(req.url ?? ''))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'application/json')
      // Native tool use, not a fenced dialect: the model names a tool the endpoint
      // advertised, and the runtime carries it as a tools/call.
      const answered = toolNames.includes('CloseCase')
      res.end(JSON.stringify({
        choices: [{
          message: answered
            ? { content: 'The Case is closed.' }
            : {
                content: null,
                tool_calls: [{
                  id: 'call_1', type: 'function',
                  function: {
                    name: toolNames.includes('OpenCase') ? 'CloseCase' : 'OpenCase',
                    arguments: toolNames.includes('OpenCase') ? '{"disposition":"completed"}' : '{}',
                  },
                }],
              },
        }],
      }))
      return
    }
    assert.equal(req.url, '/mcp', 'first-party and tools-only clients cross one endpoint')
    assert.equal(String(req.headers.authorization), `Bearer rlt_agt_${'a'.repeat(43)}`)
    if (req.method === 'DELETE') {
      // The client gives its session back when it is done, so a Gateway can tell a client
      // that has gone from one that has merely fallen silent.
      terminated.push(String(req.headers['mcp-session-id'] ?? ''))
      res.writeHead(204)
      return void res.end()
    }
    methods.push(String(input.method ?? ''))
    res.setHeader('mcp-session-id', sessionId)
    if (input.method === 'notifications/initialized') {
      res.writeHead(202)
      return void res.end()
    }
    res.setHeader('content-type', 'application/json')
    const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
    if (input.method === 'initialize') {
      return void reply({
        protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'live-mcp', version: '1' },
        // A conforming endpoint always publishes the recovery record. `none` is the
        // authority saying there is nothing outstanding — which is why this run never has
        // to ping for it.
        _meta: { 'rulith/v2': { agentId: 'agent-public-1', focusedRoots: [], recovery: { state: 'none' } } },
      })
    }
    if (input.method === 'ping') {
      return void reply({ _meta: { 'rulith/v2': { agentId: 'agent-public-1', focusedRoots: [], recovery: { state: 'none' } } } })
    }
    if (input.method === 'tools/list') {
      assert.equal(String(req.headers['mcp-session-id']), sessionId, 'the session header was not carried after initialize')
      return void reply({
        tools: [
          { name: 'OpenCase', inputSchema: { type: 'object', properties: { caseType: { type: 'string' }, caseId: { type: 'string' }, case: { type: 'object' } } } },
          { name: 'ApplyBatch', inputSchema: { type: 'object', properties: { operations: { type: 'array' }, case: { type: 'object' } } } },
          { name: 'ApplyAction', inputSchema: { type: 'object', properties: { action: { type: 'string' }, case: { type: 'object' } } } },
          { name: 'CloseCase', inputSchema: { type: 'object', properties: { disposition: { type: 'string' }, case: { type: 'object' } } } },
          { name: 'QueryBoard', inputSchema: { type: 'object', properties: { include: { type: 'array' } } } },
          { name: 'ReadArtifact', inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, offset: { type: 'integer' }, maxBytes: { type: 'integer' } } } },
          { name: 'ReadOperation', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
        ],
        _meta: { 'rulith/v2': { agentId: 'agent-public-1', focusedRoots: [], recovery: { state: 'none' } } },
      })
    }
    assert.equal(input.method, 'tools/call')
    const name = String(input.params?.name ?? '')
    toolNames.push(name)
    sentMeta.push(input.params?._meta?.['rulith/v2'])
    if (name === 'CloseCase') closed = true
    const core = {
      accepted: true, revision: `r${toolNames.length}`, payload: boardView(!closed),
      ...(closed ? { receipt: { disposition: 'completed' } } : {}),
    }
    reply({
      content: [{ type: 'text', text: JSON.stringify(core) }],
      _meta: { 'rulith/v2': {
        agentId: 'agent-public-1',
        recovery: { state: 'none' },
        boardRevision: `r${toolNames.length}`,
        focusedRoots: closed ? [] : [{ caseId: 'CASE_LIVE', root: 'ROOT_LIVE' }],
        ...(closed ? { affectedCases: ['CASE_LIVE'] } : {}),
      } },
    })
  })
  let port
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolveReady() }))
  const store = mkdtempSync(join(tmpdir(), 'rulith-live-mcp-'))
  const child = spawn(process.execPath, ['agent/rulith-agent.mjs', 'test'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RULITH_URL: `http://127.0.0.1:${port}`,
      RULITH_TOKEN: `rlt_agt_${'a'.repeat(43)}`,
      RULITH_MODEL_URL: `http://127.0.0.1:${port}`,
      RULITH_MODEL: 'test-model', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '',
      RULITH_MAX_ROUNDS: '4', RULITH_CASE_TYPE: '', RULITH_MODEL_TOOLS: '',
      RULITH_SESSION_FILE: join(store, 'sessions.json'),
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
  rmSync(store, { recursive: true, force: true })
  assert.equal(status, 0, `${stdout}\n${stderr}`)
  assert.deepEqual(methods.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list'],
    `the MCP lifecycle was not performed: ${methods.join(', ')}`)
  assert.deepEqual(toolNames, ['OpenCase', 'CloseCase'], `the model surface did not reach the Board as tools/call: ${toolNames.join(', ')}`)
  // Identity came from the handshake. Nothing of this client's own travelled beside the
  // arguments: the protected query context is the Gateway's to inject and the session is a
  // transport header, so a conforming client attaches no metadata at all.
  assert.match(stdout, /Agent "agent-public-1"/)
  assert.deepEqual(sentMeta, [undefined, undefined],
    `the client attached metadata of its own: ${JSON.stringify(sentMeta)}`)
  assert.match(stdout, /Closed Case "CASE_LIVE" with disposition "completed"/)
  assert.ok(paths.includes('/mcp'))
  assert.ok(paths.includes('/v1/chat/completions'))
  assert.ok(paths.every((path) => path === '/mcp' || path === '/v1/chat/completions'), `unexpected privileged path: ${paths.join(', ')}`)
  assert.deepEqual(terminated, [sessionId], 'the run ended without giving its session back')
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
        // Wait for the events this arm is about rather than for a fixed 80ms. Spawning a
        // Node child and receiving its first IPC message takes longer than that on a
        // loaded Windows host, and the arm failed intermittently against a correct host —
        // a flake that names its own subject reads exactly like the defect coming back.
        const readySources = () => new Set(host.events().filter((event) => event.type === 'ready').map((event) => event.src))
        const wanted = Object.entries(expected).filter(([, on]) => on).map(([role]) => role)
        const deadline = Date.now() + 5_000
        while (wanted.some((role) => !readySources().has(role)) && Date.now() < deadline) {
          await new Promise((accept) => setTimeout(accept, 25))
        }
        assert.deepEqual(host.status(), { mode, roles: rolesOf(mode), ...expected, ready: { agent: false, worker: false } })
        const sources = readySources()
        assert.equal(sources.has('agent'), expected.agent)
        assert.equal(sources.has('worker'), expected.worker)
      } finally { await host.close() }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-LOCAL-CONFIG-1: Worker receives the absolute Local config path even when the host was given a relative path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-config-'))
  const child = join(dir, 'worker.mjs')
  writeFileSync(child, `process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'config-path',configFile:process.env.RULITH_LOCAL_CONFIG}});setInterval(()=>{},1000)\n`)
  const configFile = relative(process.cwd(), join(ROOT, 'test', 'fixtures', 'relative-local.json'))
  const config = defaultLocalConfig()
  config.paths = { worker: child }
  const host = createLocalHost({ configFile, config, roles: ['worker'], port: 0, key: 'config-key' })
  try {
    await host.listen()
    const deadline = Date.now() + 5_000
    while (!host.events().some((event) => event.type === 'config-path') && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    const event = host.events().find((candidate) => candidate.type === 'config-path')
    assert.equal(event?.configFile, resolve(configFile))
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Rulith Local status is a read-only redacted runtime projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-status-'))
  const child = join(dir, 'role.mjs')
  writeFileSync(child, "process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start',agentId:'agent-public-1',concurrency:1}});setInterval(()=>{},1000)\n")
  const config = defaultLocalConfig()
  config.paths = { agent: child }
  config.agent.env.RULITH_TOKEN = `rlt_agt_${'a'.repeat(43)}`
  config.agent.env.RULITH_MODEL_KEY = 'model-secret-value'
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'status-key' })
  try {
    await host.listen()
    const deadline = Date.now() + 5_000
    while (!host.events().some((event) => event.src === 'agent' && event.type === 'start' && event.agentId === 'agent-public-1')
      && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    assert.ok(host.events().some((event) => event.src === 'agent' && event.type === 'start' && event.agentId === 'agent-public-1'),
      'the child never published its Agent identity')
    const response = await fetch(`http://127.0.0.1:${host.port}/status?k=status-key`)
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

// ── Rulith Local confirms a start; it does not time one ──────────────────────
//
// `/control {operation:"start"}` used to sleep a fixed 350 ms and then ask whether the child
// was still running. That answered the wrong question in both directions, and only one of the
// two was ever noticed: on a busy machine a child that exits immediately has not exited yet at
// 350 ms, so the operator was told `200 {ok:true}` about a role that was already dying; and a
// child that legitimately takes longer than 350 ms to finish initializing was never confirmed,
// only assumed. The four outcomes below are the whole contract, and each has an arm.

/** One Local host driving one scripted role child, torn down with its temp directory. */
async function localRole({ role = 'agent', source, startConfirmMs }, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-start-'))
  const child = join(dir, `${role}.mjs`)
  writeFileSync(child, source, 'utf8')
  const config = defaultLocalConfig()
  config.paths = { [role]: child }
  const host = createLocalHost({
    configFile: join(dir, 'local.json'), config, roles: [role], port: 0, key: 'start-key',
    ...(startConfirmMs === undefined ? {} : { startConfirmMs }),
  })
  const control = async (operation) => {
    const response = await fetch(`http://127.0.0.1:${host.port}/control?k=start-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, operation }),
    })
    return { status: response.status, body: await response.json() }
  }
  const exits = () => host.events().filter((event) => event.src === role && event.type === 'exit').length
  /** Put the host back to "this role is not running", so a `start` really starts one. */
  const quiesce = async () => {
    const before = exits()
    const stopped = await control('stop')
    if (stopped.body.ok !== true) return stopped // already gone: the child exited on its own
    const deadline = Date.now() + 5_000
    while (exits() === before && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 25))
    assert.ok(exits() > before, `${role} did not report the exit its stop caused`)
    return stopped
  }
  try {
    // `listen` starts the selected roles, which is the product's behaviour and not what these
    // arms are about: each drives an explicit operator `start` from a stopped state.
    await host.listen()
    await run({ host, control, quiesce, port: host.port })
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The readiness event each role really sends, named where the host reads it. */
const READY_EVENT = { agent: 'start', worker: 'up' }

test('Rulith Local confirms a start by the role readiness event, however long it takes', async () => {
  // 1.2 s — comfortably past the retired 350 ms guess, so this is the arm the old code could
  // not answer at all. Each role is driven with the event it actually sends.
  for (const role of ['agent', 'worker']) {
    await localRole({
      role,
      source: `setTimeout(() => process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'${READY_EVENT[role]}'}}), 1200)\n`
        + 'setInterval(() => {}, 1000)\n',
    }, async ({ control, host, quiesce }) => {
      await quiesce()
      const started = Date.now()
      const answer = await control('start')
      assert.equal(answer.status, 200, `${role}: ${JSON.stringify(answer.body)}`)
      assert.equal(answer.body.ok, true)
      assert.equal(answer.body.state, 'ready')
      assert.ok(Date.now() - started >= 1_000, `${role} was confirmed before its readiness event could have arrived`)
      assert.ok(host.events().some((event) => event.src === role && event.type === READY_EVENT[role]),
        `${role} readiness never reached the Local event stream`)
    })
  }
})

test('Rulith Local reports a child that dies after the old fixed wait would have passed it', async () => {
  // The regression this replaces: alive at 350 ms, dead at 900. The old gate answered
  // `200 {ok:true}` here, which is the operator being told a role started as it was dying.
  await localRole({
    source: 'setTimeout(() => process.exit(4), 900)\nsetInterval(() => {}, 1000)\n',
  }, async ({ control, quiesce }) => {
    await quiesce()
    const answer = await control('start')
    assert.equal(answer.status, 400, JSON.stringify(answer.body))
    assert.equal(answer.body.ok, false)
    assert.match(String(answer.body.teaching), /exited during startup/i)
  })
})

test('Rulith Local refuses to call an unconfirmable program started, and does not call it failed either', async () => {
  // An operator may point `paths.agent` at any program. One that never reports readiness and
  // never exits cannot be confirmed, and neither verdict would be true: it is answered as
  // itself. A short bound keeps the arm quick; the production default is the same code path.
  await localRole({
    source: 'setInterval(() => {}, 1000)\n',
    startConfirmMs: 600,
  }, async ({ control, quiesce }) => {
    await quiesce()
    const answer = await control('start')
    assert.equal(answer.status, 202, JSON.stringify(answer.body))
    assert.equal(answer.body.ok, false, 'an unconfirmed start must never read as success')
    assert.equal(answer.body.state, 'unconfirmed')
    assert.match(String(answer.body.teaching), /has not reported that it finished initializing/i)
    assert.match(String(answer.body.teaching), /readiness event/i)
    assert.doesNotMatch(String(answer.body.teaching), /exited during startup/i,
      'a running program must not be reported as one that died')
  })
})

test('Rulith Local runs the whole start / stop / start lifecycle, and readiness is not sticky', async () => {
  await localRole({
    source: "process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start'}})\nsetInterval(() => {}, 1000)\n",
    // Short on purpose: if the second start were confirmed by the *first* child's readiness
    // rather than the new child's own, this bound would never be reached and the arm would
    // pass for the wrong reason. It is reached only when nothing confirms the new process.
    startConfirmMs: 4_000,
  }, async ({ control, host, quiesce }) => {
    await quiesce()
    const readyBefore = () => host.events().filter((event) => event.src === 'agent' && event.type === 'start').length
    const baseline = readyBefore()
    assert.equal((await control('start')).status, 200)
    const exits = () => host.events().filter((event) => event.src === 'agent' && event.type === 'exit').length
    const exitsBefore = exits()
    const stopped = await control('stop')
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    // `stop` returns once the signal is sent; the exit is the child's own answer to it, and a
    // restart is only a restart once that has arrived.
    const deadline = Date.now() + 5_000
    while (exits() === exitsBefore && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 25))
    assert.equal(exits(), exitsBefore + 1, 'a stopped role must report its exit')
    const again = await control('start')
    assert.equal(again.status, 200, `a restart must be confirmed by the new child: ${JSON.stringify(again.body)}`)
    assert.equal(again.body.state, 'ready')
    assert.equal(readyBefore() - baseline, 2,
      'each start must be confirmed by its own readiness event')
  })
})

test('Rulith Local calls a stop stopped, and reserves ready for a role that reported it', async () => {
  await localRole({
    source: "process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start'}})\nsetInterval(() => {}, 1000)\n",
  }, async ({ control, quiesce }) => {
    const stopped = await quiesce()
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    assert.equal(stopped.body.ok, true)
    assert.equal(stopped.body.state, 'stopped',
      'a stop that answers "ready" says the opposite of what happened, and the UI prints it')
    const started = await control('start')
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.state, 'ready')
  })
})

test('Rulith Local calls an operator Stop during startup a cancellation, not a configuration defect', async () => {
  // The child is healthy and simply slow: it would report ready at 3 s. The operator stops it
  // at 300 ms. Deciding this by which listener ran first would blame their own gesture on a
  // missing configuration and send them looking for a defect that is not there; the decision
  // is an explicit per-child record of the Stop.
  await localRole({
    source: "setTimeout(() => process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start'}}), 3000)\n"
      + 'setInterval(() => {}, 1000)\n',
  }, async ({ control, quiesce }) => {
    await quiesce()
    const pending = control('start')
    await new Promise((accept) => setTimeout(accept, 300))
    const stopped = await control('stop')
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    const answer = await pending
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.state, 'cancelled')
    // "A stop was requested", not "was stopped": the sentence must not assert an outcome the
    // rest of the teaching may go on to deny.
    assert.match(String(answer.body.teaching), /A stop was requested for the Agent before this start finished/i)
    assert.doesNotMatch(String(answer.body.teaching), /^Agent was stopped/i)
    assert.doesNotMatch(String(answer.body.teaching), /fix the missing local configuration/i,
      'a role the operator stopped has nothing for them to go and fix')
  })
})

// A sent signal is a request, not an acknowledgement. On POSIX a child may install a SIGTERM
// handler, answer it however it likes, and keep running — so `kill()` returning is not the
// process having ended, and anything the process says afterwards is not evidence for the start
// that was just cancelled. Windows has no equivalent: `child.kill()` there is a terminate the
// child cannot handle, so the arm that needs a surviving child can only run on POSIX and says
// so rather than passing quietly.
const POSIX_ONLY = process.platform === 'win32'
  ? 'POSIX-only: a Windows child cannot handle SIGTERM, so a child that survives a stop is unreachable here'
  : false

test('Rulith Local does not let a child that answers the stop signal confirm the start it cancelled',
  { skip: POSIX_ONLY }, async () => {
    // The shape of Root's Linux counterexample, driven the same way: the second child installs
    // a SIGTERM handler that reports **readiness** and stays alive. Before the fix this
    // answered `stop → 200 {state:"stopped"}` and `start → 200 {state:"ready"}` while the
    // process was still running: a stop reported as an outcome, and a late report accepted as
    // confirmation of the very start it had cancelled.
    const dir = mkdtempSync(join(tmpdir(), 'rulith-local-sigterm-'))
    const counter = join(dir, 'count').replaceAll('\\', '\\\\')
    const child = join(dir, 'agent.mjs')
    writeFileSync(child,
      "import { readFileSync, writeFileSync } from 'node:fs'\n"
      + `const path = '${counter}'\n`
      + "let count = 0; try { count = Number(readFileSync(path, 'utf8')) } catch {}\n"
      + "writeFileSync(path, String(++count))\n"
      + "const send = (type) => process.send?.({protocol:'rulith-local-event',event:{type,t:Date.now()}})\n"
      + "if (count === 1) send('start')\n"
      + "else { process.on('SIGTERM', () => send('start')); send('armed') }\n"
      + 'setInterval(() => {}, 1000)\n', 'utf8')
    const config = defaultLocalConfig()
    config.paths = { agent: child }
    const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'sigterm-key', startConfirmMs: 5_000 })
    const control = async (operation) => {
      const response = await fetch(`http://127.0.0.1:${host.port}/control?k=sigterm-key`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'agent', operation }),
      })
      return { status: response.status, body: await response.json() }
    }
    const until = async (predicate, what) => {
      const deadline = Date.now() + 10_000
      while (!predicate() && Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 10))
      assert.ok(predicate(), `timed out waiting for ${what}`)
    }
    try {
      await host.listen()
      await until(() => host.events().some((e) => e.src === 'agent' && e.type === 'start'), 'the first child to report ready')
      await control('stop')
      await until(() => !host.status().agent, 'the first child to exit')

      const pending = control('start')
      await until(() => host.events().some((e) => e.type === 'armed'), 'the second child to arm its SIGTERM handler')
      const stopped = await control('stop')
      const started = await pending

      // The stop says what it observed, and it observed no exit.
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
      assert.equal(stopped.body.state, 'stopping',
        'a signal that was sent is not an exit that was seen')
      assert.match(String(stopped.body.teaching), /has not exited yet/i)

      // The start is cancelled, never ready — the readiness that arrived was the child's answer
      // to the stop signal, and it confirms nothing.
      assert.equal(started.status, 409, JSON.stringify(started.body))
      assert.equal(started.body.ok, false)
      assert.equal(started.body.state, 'cancelled')
      assert.notEqual(started.body.state, 'ready')
      assert.match(String(started.body.teaching), /has not exited yet/i)
      assert.doesNotMatch(String(started.body.teaching), /It is not running/i,
        'the child is still running, and the teaching must not say otherwise')
      assert.doesNotMatch(String(started.body.teaching), /fix the missing local configuration/i)

      // And the host still lists it as running, which is the truth every message above agrees with.
      assert.equal(host.status().agent, true)
      assert.ok(host.events().some((e) => e.src === 'agent' && e.type === 'start' && e.at >= 0),
        'the readiness event itself is still published to Trace; it is simply not evidence')
    } finally {
      // Only this test's own last child, and only if it is still alive. Nothing else is touched,
      // and no escalation was added to the product to make this unnecessary.
      const spawned = host.events().filter((e) => e.src === 'agent' && e.type === 'spawn').at(-1)
      if (host.status().agent && Number.isInteger(spawned?.pid)) {
        try { process.kill(spawned.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

test('Rulith Local says a role stopped only when it saw it exit, and says so when it did', async () => {
  // The other half, reachable everywhere: an ordinary child that exits on the signal. `stopped`
  // is the observation, not the request — and the cancelled teaching for a child that really did
  // go says it is not running, because this time that is true.
  await localRole({
    source: "setTimeout(() => process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start'}}), 3000)\n"
      + 'setInterval(() => {}, 1000)\n',
  }, async ({ control, quiesce, host }) => {
    await quiesce()
    const pending = control('start')
    await new Promise((accept) => setTimeout(accept, 300))
    const stopped = await control('stop')
    assert.equal(stopped.body.state, 'stopped', 'an ordinary child exits on the signal, and that is what was observed')
    assert.equal(stopped.body.teaching, undefined, 'an observed exit needs no explanation')
    const answer = await pending
    assert.equal(answer.body.state, 'cancelled')
    assert.match(String(answer.body.teaching), /It is not running/i,
      'this child really did exit, so the teaching may say so')
    assert.equal(host.status().agent, false)
  })
})

test('Rulith Local confirms each start by its own process, so an earlier role readiness never stands in', async () => {
  // Readiness must belong to a process, not to a role. The child reports ready the first time
  // it runs and stays silent afterwards — a real event stream, from two real processes — so a
  // host that remembered "this role has reported ready" would confirm the second start. It
  // must not: the second answer is `unconfirmed`, with the first process's readiness still
  // sitting in the event log where anything counting events would find it.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-identity-'))
  const child = join(dir, 'agent.mjs')
  const marker = join(dir, 'first-run').replaceAll('\\', '\\\\')
  writeFileSync(child,
    "import { existsSync, writeFileSync } from 'node:fs'\n"
    + `const marker = '${marker}'\n`
    + "if (!existsSync(marker)) {\n"
    + "  writeFileSync(marker, 'ran')\n"
    + "  process.send?.({protocol:'rulith-local-event',event:{t:Date.now(),type:'start'}})\n"
    + '}\n'
    + 'setInterval(() => {}, 1000)\n', 'utf8')
  const config = defaultLocalConfig()
  config.paths = { agent: child }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'identity-key', startConfirmMs: 1_500 })
  const control = async (operation) => {
    const response = await fetch(`http://127.0.0.1:${host.port}/control?k=identity-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', operation }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await host.listen()
    // The role auto-starts with `listen`, and that first process is the one that reports ready.
    const deadline = Date.now() + 5_000
    while (!host.events().some((event) => event.src === 'agent' && event.type === 'start') && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    assert.ok(host.events().some((event) => event.src === 'agent' && event.type === 'start'),
      'the first process never reported ready, so this arm would prove nothing')
    const exitsBefore = host.events().filter((event) => event.src === 'agent' && event.type === 'exit').length
    assert.equal((await control('stop')).status, 200)
    while (host.events().filter((event) => event.src === 'agent' && event.type === 'exit').length === exitsBefore
      && Date.now() < deadline + 5_000) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    const second = await control('start')
    assert.equal(second.status, 202, `the second process reported nothing and must not be confirmed: ${JSON.stringify(second.body)}`)
    assert.equal(second.body.state, 'unconfirmed')
    assert.equal(host.events().filter((event) => event.src === 'agent' && event.type === 'start').length, 1,
      'exactly one readiness event exists, and it belongs to the process that has already exited')
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped Worker really sends the readiness event Rulith Local confirms a start by', async () => {
  // The three arms above drive scripted children, so they prove the host's half of the
  // contract and assume the other. This one starts `worker/rulith-worker.mjs` itself, with a
  // work endpoint that drops every connection: the Source fetch fails, the Worker says so and comes
  // up anyway, and Local confirms the start. If the Worker ever stopped sending `up`, or only
  // sent it once Cloud answered, this goes red — and an offline machine's healthy Worker would
  // otherwise be reported as one that never started.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-real-worker-'))
  const unavailable = createServer()
  unavailable.on('connection', (socket) => socket.destroy())
  await new Promise((ready) => unavailable.listen(0, '127.0.0.1', ready))
  const config = defaultLocalConfig()
  config.worker.env.RULITH_WORK_URL = `http://127.0.0.1:${unavailable.address().port}/work`
  config.worker.env.RULITH_CONNECTION = 'conn-local-readiness'
  config.worker.env.RULITH_CONNECTION_KEY = 'key-local-readiness'
  config.worker.env.RULITH_TOOLS_FILE = join(dir, 'absent-tools.json')
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['worker'], port: 0, key: 'real-key' })
  try {
    await host.listen()
    const deadline = Date.now() + 20_000
    while (!host.events().some((event) => event.src === 'worker' && event.type === 'up') && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    const up = host.events().find((event) => event.src === 'worker' && event.type === 'up')
    assert.ok(up, `the shipped Worker never reported readiness: ${JSON.stringify(host.events().slice(-6))}`)
    assert.equal(typeof up.workerId, 'string')
    assert.equal(up.connectionId, 'conn-local-readiness')
    assert.ok(host.events().some((event) => event.src === 'worker' && event.type === 'log' && /Could not reach Rulith Cloud/i.test(String(event.line ?? ''))),
      'this arm is only meaningful while the Worker cannot reach a working Gateway')
  } finally {
    await host.close()
    await new Promise((ready) => unavailable.close(ready))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped Agent refuses to start without its Gateway, and Rulith Local reports that as the failure it is', async () => {
  // The other half of "each role's own answer". The Agent establishes its authenticated MCP
  // session before it serves, so an unreachable Gateway is a startup failure of the Agent's own
  // making — and it must arrive as one. The retired fixed wait answered `200 {ok:true}` here
  // whenever the failure took longer than 350 ms, which is the exact shape of fake success.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-real-agent-'))
  const unavailable = createServer()
  unavailable.on('connection', (socket) => socket.destroy())
  await new Promise((ready) => unavailable.listen(0, '127.0.0.1', ready))
  const config = defaultLocalConfig()
  config.agent.env.RULITH_URL = `http://127.0.0.1:${unavailable.address().port}`
  config.agent.env.RULITH_TOKEN = `rlt_agt_${'a'.repeat(43)}`
  config.agent.env.RULITH_MODEL_URL = `http://127.0.0.1:${unavailable.address().port}/v1`
  config.agent.env.RULITH_MODEL_KEY = 'unused-offline'
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'real-agent-key' })
  const control = async (operation) => {
    const response = await fetch(`http://127.0.0.1:${host.port}/control?k=real-agent-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', operation }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await host.listen()
    const deadline = Date.now() + 20_000
    while (!host.events().some((event) => event.src === 'agent' && event.type === 'exit') && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    const answer = await control('start')
    assert.equal(answer.status, 400, `an Agent that cannot reach its Gateway must not read as started: ${JSON.stringify(answer.body)}`)
    assert.equal(answer.body.ok, false)
    assert.match(String(answer.body.teaching), /exited during startup/i)
    assert.ok(host.events().some((event) => event.src === 'agent' && event.type === 'log'
      && /Cannot establish an authenticated MCP session|Cannot reach the public MCP endpoint/i.test(String(event.line ?? ''))),
    `the Agent's own diagnostic must reach Trace: ${JSON.stringify(host.events().slice(-6))}`)
  } finally {
    await host.close()
    await new Promise((ready) => unavailable.close(ready))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Rulith Local reports an immediate child exit instead of claiming the role restarted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-local-exit-'))
  const child = join(dir, 'exit.mjs')
  writeFileSync(child, 'process.exit(3)\n')
  const config = defaultLocalConfig()
  config.paths = { agent: child }
  const host = createLocalHost({ configFile: join(dir, 'local.json'), config, roles: ['agent'], port: 0, key: 'exit-key' })
  try {
    await host.listen()
    const deadline = Date.now() + 5_000
    while (!host.events().some((event) => event.src === 'agent' && event.type === 'exit') && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 25))
    }
    assert.ok(host.events().some((event) => event.src === 'agent' && event.type === 'exit'),
      'the immediate child exit never reached the Local host')
    const response = await fetch(`http://127.0.0.1:${host.port}/control?k=exit-key`, {
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
  // Mode is a local capability ceiling, not an authorization: what this process can
  // present at all. Everything it does present, it presents (board-spec TOOL-08, and
  // RT-WK-TOOLS-2) — the Connection lock in Console decides what receives work.
  assert.deepEqual(workerToolManifest(readOnly).map((row) => row.id).sort(), Object.keys(readOnly).sort(),
    'the Worker advertises every built-in it has; it is not the authorization point')
  assert.ok(workerToolManifest(readWrite).every((row) => ['read', 'write', 'run'].includes(row.kind)))
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
        sourceTypes: ['file'], exec: id, params,
      }), JSON.stringify({ ...args, source: 'workspace' }), tools, tools[id].digest, sources, 'workspace')
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
      name: 'count_source', kind: 'read', impl: 'worker-tool', sourceTypes: ['file'], exec: 'rulith.workspace.count@1',
      params: { path: 'string', recursive: 'boolean' },
      returns: [{ predicate: 'acme.files.directory_count', args: { source: '$source', path: '$path', file_count: '$file_count', digest: '$digest' } }],
    }), JSON.stringify({ path: '.', recursive: false, source: 'workspace' }), tools, tools['rulith.workspace.count@1'].digest, sources, 'workspace')
    for (const [args, expected] of [
      [{ path: '.', recursive: false, surprise: true }, /undeclared parameter/i],
      [{ path: '.' }, /missing required parameter/i],
      [{ path: '.', recursive: 'false' }, /recursive must be boolean/i],
    ]) {
      assert.throws(() => toolFromSpec(JSON.stringify({
        name: 'count_source', kind: 'read', impl: 'worker-tool', sourceTypes: ['file'], exec: 'rulith.workspace.count@1',
        params: { path: 'string', recursive: 'boolean' },
      }), JSON.stringify({ ...args, source: 'workspace' }), tools, tools['rulith.workspace.count@1'].digest, sources, 'workspace'), expected)
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

test('RT-WORKSPACE-SECRET-1: a workspace Source cannot contain the Local runtime credential file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-workspace-sensitive-'))
  const previous = process.env.RULITH_LOCAL_CONFIG
  try {
    const configFile = join(root, 'local.json')
    writeFileSync(configFile, JSON.stringify({ agent: { env: { RULITH_MODEL_KEY: 'must-not-leak' } } }))
    writeFileSync(join(root, 'notes.txt'), 'safe-looking content')
    process.env.RULITH_LOCAL_CONFIG = configFile
    const tools = builtinWorkspaceTools('read')
    const id = 'rulith.workspace.read_text@1'
    const sources = { workspace: { access: root, type: 'file' } }
    const local = toolFromSpec(JSON.stringify({
      name: id, kind: 'read', impl: 'worker-tool', sourceTypes: ['file'], exec: id, params: { path: 'string' },
    }), JSON.stringify({ path: 'notes.txt', source: 'workspace' }), tools, tools[id].digest, sources, 'workspace')
    await assert.rejects(
      execute(id, { path: 'notes.txt' }, { [id]: local }, sources),
      /runtime credential or manifest file/i,
    )
  } finally {
    if (previous === undefined) delete process.env.RULITH_LOCAL_CONFIG
    else process.env.RULITH_LOCAL_CONFIG = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('RT-WORKSPACE-CODE-1: read-write workspace access cannot cover Worker executable code', async () => {
  const previous = process.env.RULITH_WORKSPACE_TOOLS
  try {
    process.env.RULITH_WORKSPACE_TOOLS = 'read-write'
    const tools = builtinWorkspaceTools('read-write')
    const id = 'rulith.workspace.read_text@1'
    const sources = { workspace: { access: ROOT, type: 'file' } }
    const local = toolFromSpec(JSON.stringify({
      name: id, kind: 'read', impl: 'worker-tool', sourceTypes: ['file'], exec: id, params: { path: 'string' },
    }), JSON.stringify({ path: 'package.json', source: 'workspace' }), tools, tools[id].digest, sources, 'workspace')
    await assert.rejects(
      execute(id, { path: 'package.json' }, { [id]: local }, sources),
      /Worker implementation/i,
    )
    process.env.RULITH_WORKSPACE_TOOLS = 'off'
    const manifestTools = workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
      'acme.workspace.write@1': { adapter: 'workspace', sourceTypes: ['file'], entry: 'write_text' },
      'acme.future.run@1': { adapter: 'run', sourceTypes: ['file'], entry: 'future-adapter.mjs' },
    } })
    assert.equal(workspaceWriteEnabled(manifestTools), true,
      'a manifest-declared workspace writer is write capability even when built-ins are off')
    assert.ok(protectedWorkerExecutables(manifestTools).includes(join(ROOT, 'worker', 'future-adapter.mjs')),
      'a declared run Adapter is protected before the file is created')
  } finally {
    if (previous === undefined) delete process.env.RULITH_WORKSPACE_TOOLS
    else process.env.RULITH_WORKSPACE_TOOLS = previous
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
  const { mcpHttpHandler } = await import('./support/mcp-http-fixture.mjs')
  const { closeMcpClients } = await import('../worker/mcp-client.mjs')
  const requests = []
  const server = createServer(mcpHttpHandler(async (request, res) => {
    requests.push(request)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(request.method === 'tools/list'
      ? { jsonrpc: '2.0', id: request.id, result: { tools: [{
          name: 'orders.lookup', description: 'Look up one order', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
        }] } }
      : { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{"rows":[{"exists":true}]}' }] } }))
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const tools = builtinSourceTools()
    const id = 'rulith.mcp.discover@1'
    const sources = { erp: { type: 'mcp', url: `http://127.0.0.1:${server.address().port}` } }
    const local = toolFromSpec(JSON.stringify({
      name: 'discover_erp', kind: 'read', impl: 'worker-tool', sourceTypes: ['mcp'], exec: id, params: {},
      returns: [{ predicate: 'rulith.source.mcp_tool', args: {
        source: '$source', tool_name: '$tool_name', description: '$description', input_schema_json: '$input_schema_json',
      } }],
    }), JSON.stringify({ source: 'erp' }), tools, tools[id].digest, sources, 'erp')
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
    await closeMcpClients()
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
    res.end(JSON.stringify({ ...(req.method === 'GET' ? {} : { status: 'completed' }), rows: req.method === 'GET'
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
      params: { event: 'string' }, fence: { method: 'POST', maxResponseBytes: 4096,
        completion: { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'completed' } } },
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

test('HTTP write acceptance and post-effect errors leave completion unknown', async () => {
  let jobs = 'none'
  let committed = 0
  let followedRedirects = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the complete submitted body */ }
    if (req.url === '/accepted') {
      jobs = 'accepted'
      setTimeout(() => { jobs = 'failed' }, 10)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobId: 'job-1', status: 'accepted' }))
    } else if (req.url === '/accepted-200') {
      jobs = 'accepted'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobId: 'job-3', status: 'accepted' }))
    } else if (req.url === '/accepted-get') {
      jobs = 'accepted'
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobId: 'job-2', status: 'accepted' }))
    } else if (req.url === '/committed-malformed') {
      committed++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'committed' }))
    } else if (req.url === '/completed') {
      committed++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed', rows: [{ id: 'job-4' }] }))
    } else if (req.url === '/redirect') {
      res.writeHead(307, { location: '/redirected' })
      res.end()
    } else if (req.url === '/redirected') {
      followedRedirects++
      res.writeHead(200)
      res.end('unexpected')
    } else if (req.url === '/disconnect') {
      committed++
      req.socket.destroy()
    } else {
      committed++
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'later step failed' }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const sources = { api: { type: 'http', url: `http://127.0.0.1:${server.address().port}/` } }
    const terminal = { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'completed' } }
    const tool = (name, path) => adapterToolFromSpec(JSON.stringify({
      name, kind: 'write', impl: 'http', source: 'api', exec: path,
      params: {}, fence: { method: 'POST', maxResponseBytes: 4096, completion: terminal },
    }), '{}')
    await assert.rejects(
      execute('submit_job', {}, { submit_job: tool('submit.job', '/accepted') }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /202/.test(error.message),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(jobs, 'failed', 'acceptance was not the job completion')
    await assert.rejects(
      execute('accepted_200', {}, { accepted_200: tool('accepted.200', '/accepted-200') }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /terminal evidence absent/.test(error.message),
      'HTTP 200 with only job acceptance cannot settle a terminal Action',
    )
    const getWrite = adapterToolFromSpec(JSON.stringify({
      name: 'submit.get', kind: 'write', impl: 'http', source: 'api', exec: '/accepted-get',
      params: {}, fence: { method: 'GET', completion: terminal },
    }), '{}')
    await assert.rejects(
      execute('submit_get', {}, { submit_get: getWrite }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /202/.test(error.message),
      'a write remains effectful even when its pinned HTTP method is GET',
    )
    const malformed = adapterToolFromSpec(JSON.stringify({
      name: 'commit.malformed', kind: 'write', impl: 'http', source: 'api', exec: '/committed-malformed',
      params: {}, fence: { method: 'POST', completion: { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'committed' } } },
      returns: [{ predicate: 'acme.commit', args: { id: '$id' } }],
    }), '{}')
    await assert.rejects(
      execute('commit_malformed', {}, { commit_malformed: malformed }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /declared facts/.test(error.message),
      'a committed write with an unreadable returns envelope is unknown, not a known failure',
    )
    assert.equal(committed, 1)
    const complete = await execute('completed', {}, { completed: tool('completed', '/completed') }, sources)
    assert.match(complete, /"status":"completed"/)
    assert.equal(committed, 2)
    assert.throws(() => adapterToolFromSpec(JSON.stringify({
      name: 'no.proof', kind: 'write', impl: 'http', source: 'api', exec: '/completed',
      params: {}, fence: { method: 'POST' },
    }), '{}'), /fence\.completion/)
    assert.throws(() => adapterToolFromSpec(JSON.stringify({
      name: 'bad.timeout', kind: 'write', impl: 'http', source: 'api', exec: '/partial',
      params: {}, fence: { method: 'POST', timeoutMs: 'bad' },
    }), '{}'), /timeoutMs/)
    await assert.rejects(
      execute('write_two_steps', {}, { write_two_steps: tool('write.two_steps', '/partial') }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /500/.test(error.message),
    )
    assert.equal(committed, 3, 'the first external effect was already applied before HTTP 500')
    await assert.rejects(
      execute('redirect_write', {}, { redirect_write: tool('redirect.write', '/redirect') }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /307/.test(error.message),
    )
    assert.equal(followedRedirects, 0, 'Worker must not resend a write through a redirect')
    await assert.rejects(
      execute('disconnected_write', {}, { disconnected_write: tool('disconnected.write', '/disconnect') }, sources),
      (error) => error.constructor.name === 'ResultDeliveryError' && /transport error/.test(error.message),
    )
    assert.equal(committed, 4, 'a dropped response did not undo the second external effect')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('HTTP write completion proof comes only from the pinned local Tool', () => {
  const id = 'acme.terminal@1'
  const completion = { stage: 'terminal', statuses: [200], json: { field: 'status', equals: 'completed' } }
  const def = { adapter: 'http', sourceTypes: ['http'], entry: '/jobs', kind: 'write',
    fence: { method: 'POST', completion } }
  const spec = { name: id, kind: 'write', impl: 'worker-tool', exec: id,
    sourceTypes: ['http'], params: {}, returns: [] }
  const sources = { api: { type: 'http', url: 'http://127.0.0.1:1/' } }
  const args = JSON.stringify({ source: 'api' })
  const compiled = toolFromSpec(JSON.stringify(spec), args, { [id]: def }, toolDigest(def), sources, 'api')
  assert.deepEqual(compiled.completion, completion)
  assert.throws(() => toolFromSpec(JSON.stringify({ ...spec, kind: 'read' }), args,
    { [id]: def }, toolDigest(def), sources, 'api'), /kind differs/)
  const spoofed = { ...spec, fence: { completion: { stage: 'submitted' } } }
  assert.deepEqual(toolFromSpec(JSON.stringify(spoofed), args,
    { [id]: def }, toolDigest(def), sources, 'api').completion, completion,
  'the served work item cannot substitute a completion profile for the pinned local manifest')
  assert.throws(() => toolFromSpec(JSON.stringify(spec), args,
    { [id]: def }, toolDigest({ ...def, fence: { method: 'POST' } }), sources, 'api'), /pin/)
  const withoutProof = { ...def, fence: { method: 'POST' } }
  assert.throws(() => toolFromSpec(JSON.stringify(spec), args,
    { [id]: withoutProof }, toolDigest(withoutProof), sources, 'api'), /fence\.completion/)
  assert.throws(() => adapterToolFromSpec(JSON.stringify({
    name: 'read.post', kind: 'read', impl: 'http', source: 'api', exec: '/jobs',
    params: {}, fence: { method: 'POST' },
  }), '{}'), /read Tool.*GET or HEAD/)
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.readpost@1': { adapter: 'http', sourceTypes: ['http'], entry: '/jobs',
      kind: 'read', fence: { method: 'POST' } },
  } }), /read Tool.*GET or HEAD/)
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.badproof@1': { adapter: 'http', sourceTypes: ['http'], entry: '/jobs',
      kind: 'write', fence: { method: 'POST', completion: { stage: 'terminal', statuses: [200] } } },
  } }), /fence\.completion/)
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

test('worker surfaces a non-authenticated poll refusal instead of printing an idle heartbeat', async () => {
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
  // Governance is not refused by prose any more: RegisterPack is simply not a tool this
  // client carries, and the five it does carry are the whole allow-list.
  assert.match(source, /is not a tool this Agent Runtime`\s*\n\s*\+ ` carries/)
  assert.match(source, /package or Board governance belong to the host and to Console/)
})

test('the local Agent sends business values while Cloud mints identity and returns one Board View', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /--business-key <json>/)
  assert.match(source, /options\.businessKey === undefined \? \{\} : \{ businessKey: options\.businessKey \}/)
  // The bounded view is the authority's, carried on every tool result. The client no
  // longer budgets a projection of its own, so there is no second, quieter view to drift.
  assert.match(source, /const boardViewOf = \(result\) =>/)
  assert.doesNotMatch(source, /RULITH_ATTENTION_FACTS/)
  // GetProjection appears once, inside the list of retired surfaces this client refuses.
  assert.equal((source.match(/GetProjection/g) ?? []).length, 1)
  assert.match(source, /const RETIRED_TOOL_NAMES = \[/)
  // Core mints the Case id and its stable acceptance root; the host must not.
  assert.doesNotMatch(source, /nextCaseId|CASE_PREFIX/,
    'Case-id minting belongs to Core, and a locally minted id would name a Case the authority did not')
  assert.match(source, /const nextTaskId = \(\) =>/)
})

test('one system prompt explains reasoning without granting Case-specific authority', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  const prompt = /const SYSTEM_PROMPT = `([\s\S]*?)`\n/.exec(source)?.[1]
  assert.ok(prompt, 'the system prompt could not be found')
  const words = prompt.split(/\s+/).filter(Boolean).length
  assert.ok(words > 100 && words < 300, `the prompt is ${words} words; it is meant to be about 200`)
  for (const shape of ['assert_fact', 'add_axiom', 'declare_hypothesis', 'declare_goal', 'record_result', 'retract_node', 'revise_fact']) {
    assert.ok(prompt.includes(shape), `the prompt does not name the ${shape} shape`)
  }
  assert.match(prompt, /Never assert acceptance_met, test_result, certification or rulith\.exploration\.completed/)
  // No JSON templates: the advertised tool schemas are the templates.
  assert.doesNotMatch(prompt, /"kind":|\{"op"|```/)
  assert.doesNotMatch(source, /EXPLORATION_LINE|are Case-local, and disappear/)
  // The second line was keyed on a Board View field Core never published, so against the
  // real authority it could never fire. A prompt rule from a guessed field is worse than
  // the plain refusal it was trying to pre-empt.
  assert.doesNotMatch(source, /LOCKED_LINE|Legislation is locked/)
  assert.match(prompt, /Case Type alone grants no rule-writing permission/)
})

test('the Action parameter contract is the advertised schema, not a hand-written copy of it', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  // The typed slot contract used to be restated in prose beside the authority's schema.
  // Two statements of one rule drift; the schema the endpoint advertises is now the only one.
  assert.match(source, /projectToolSchema\(name, tool\.inputSchema \?\? tool\.input_schema\)/)
  // The projection is envelope-scoped, and it refuses rather than rewriting a business
  // requirement the server actually declared.
  assert.match(source, /prefer visibly rejecting|cannot be satisfied by any call this client would carry/)
  assert.match(source, /their schemas are the templates/)
  assert.doesNotMatch(source, /Every argument must be declared, present when required/)
})

test('available Actions reach the model through the Board View, not a prompt-side catalogue', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  // The Board View carries the actions the authority computed for the operation, so the
  // Source and frontier catalogues that used to be pasted into the system prompt were a
  // second, staler copy of the Board.
  assert.doesNotMatch(source, /sourceAccessGuide|evidenceChaseGuide|source_access|evidence_chase/)
  assert.doesNotMatch(source, /\/agent\/v1\/evidence-chase/)
  assert.match(source, /Every Board tool result carries the Board View the authority computed for that step/)
  // And reading a *current* view is the model's own tool, not a host poll loop.
  assert.match(source, /call QueryBoard when you need a current view/)
})

test('agent lifecycle events shown to users use the English product vocabulary', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /Closed Case "\$\{caseId\}" with disposition/)
  assert.match(source, /emitOn\(ctx, 'case-closed'/)
  assert.match(source, /Case Context in focus/)
  assert.match(source, /still running on the Board/)
  assert.match(source, /Board View last observed/)
  assert.doesNotMatch(source, /notes\.push\(`\[放电/)
  assert.doesNotMatch(source, /log\(`◎ 案卷/)
})

test('Rulith Local presents a conversation-first Agent workbench with optional Rulith Cases', () => {
  const hostSource = readFileSync(join(ROOT, 'local', 'rulith-local.mjs'), 'utf8')
  const visible = localPage.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(localPage)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script), 'the embedded Local UI script must compile')
  assert.match(localPage, /New conversation/)
  assert.match(localPage, /Rulith Case/)
  assert.match(localPage, /Current frontier/)
  assert.match(localPage, /Worker activity/)
  assert.match(localPage, /Message the Agent/)
  assert.match(localPage, /Rulith available/)
  assert.match(localPage, /Chat normally/)
  assert.match(localPage, /sessionKey:state\.session/,
    'browser follow-ups must stay in one local conversation slot')
  assert.match(localPage, /state\.session=r\.sessionKey/,
    'the first accepted message must retain the host-issued conversation identity')
  assert.match(localPage, /e\.session\|\|e\.sessionKey/,
    'all events from one local session must render in one conversation')
  assert.match(localPage, /state\.active=r\.sessionKey/,
    'the selected sidebar item must be the conversation, not one message id')
  assert.doesNotMatch(localPage, /state\.active=r\.id/,
    'a follow-up message must not split the current conversation into a new sidebar item')
  assert.match(localPage, /if\(key\)state\.session=key/,
    'selecting an earlier conversation must route composer follow-ups back to that session')
  assert.match(localPage, /session-detached/,
    'a reclaimed local conversation must visibly retain the recoverable Rulith Case id')
  assert.match(localPage, /state\.session=''/,
    'New conversation must explicitly leave the prior local transcript slot')
  assert.match(localPage, /receipt committed/)
  // The Worker panel used to promote an Agent verdict carrying `e.invocation` as an
  // "authoritative receipt". That field is not in Core's published Agent Profile result, so
  // it was always absent and the panel simply read empty. It now states the gap instead:
  // a blank invites no investigation, a stated gap does.
  assert.match(localPage, /worker-activity-unavailable/)
  assert.match(localPage, /Invocation reporting unavailable/)
  assert.doesNotMatch(localPage, /e\.invocation/,
    'the Worker panel is reading a result field the authority never published')
  assert.match(localPage, /Rulith MCP/)
  assert.match(localPage, /'not local'/)
  assert.match(localPage, /role="dialog"/)
  assert.match(localPage, /Runtime details/)
  assert.match(localPage, /Read-only projection of the single-Agent Runtime configuration/)
  assert.match(localPage, /Start Agent/)
  assert.match(localPage, /Stop Worker/)
  assert.match(localPage, /id="detailconfig"/)
  assert.match(localPage, /id="caseoptions"/)
  assert.match(localPage, /id="modelbadge"/)
  assert.match(localPage, /data-view="case"/)
  assert.match(localPage, /Export view/)
  assert.doesNotMatch(localPage, /Sign in to Rulith Cloud|Use this Agent|Bind to this Local/)
  assert.doesNotMatch(localPage, /Provider API key|Load models|data-save=/)
  assert.doesNotMatch(hostSource, /\/local\/v1\/account|\/account\/logout|\/auth\/start/)
  assert.doesNotMatch(hostSource, /path === '\/config'/, 'the observer UI has no browser configuration write surface')
  assert.doesNotMatch(localPage, /<details>/, 'settings must open in a visible modal rather than below the inspector fold')
  // The page reloads whenever the gate refuses it. Since `/` is now gated too, a missing
  // or rotated key answers 401 and a rebound Host or foreign Origin answers 403; both
  // must send the tab back through the gate rather than leave it showing stale state.
  assert.match(localPage, /response\?\.status===401\|\|response\?\.status===403\)\{location\.reload\(\)/)
  assert.doesNotMatch(localPage, /__KEY__/, 'the page must not carry a server-substituted key')
  assert.match(localPage, /\.composebox\{position:relative;width:min\(790px,100%\)/)
  assert.doesNotMatch(localPage, /padding:12px max\(/, 'percentage padding collapses the composer inside the center grid column')
  assert.match(hostSource, /'cache-control': 'no-store'/)
  assert.doesNotMatch(visible, /本地站|智能体（脑）|手的流水|核验通过|还没开单/)
})

test('Rulith Local keeps the center stream independently scrollable above the fixed composer', () => {
  const page = readFileSync(join(ROOT, 'local', 'local-ui.mjs'), 'utf8')
  assert.match(page, /\.main\{[^}]*min-height:0[^}]*height:100vh[^}]*overflow:hidden[^}]*\}/)
  assert.match(page, /\.stream\{[^}]*min-height:0[^}]*overflow:auto[^}]*padding:[^}]*130px/)
  assert.match(page, /\.composer\{[^}]*bottom:0/)
  assert.match(page, /stick=forceTail===true\|\|stream\.scrollHeight-stream\.scrollTop-stream\.clientHeight<80/)
  assert.match(page, /stream\.scrollTop=stick\?stream\.scrollHeight:oldTop/,
    'a background refresh must preserve a reader who scrolled away from the tail')
  assert.match(page, /if\(markup!==state\.lastStream\)\{stream\.innerHTML=markup/,
    'an unchanged status poll must not destroy text selection or nested scroll positions')
  assert.match(page, /else if\(stick\)stream\.scrollTop=stream\.scrollHeight/,
    'an explicit send or navigation must follow the tail even when markup has not changed yet')
  assert.match(page, /if\(html===state\.lastCases\)return/,
    'an unchanged status poll must not rebuild and scroll the Activity sidebar')
  assert.match(page, /frontierMarkup!==state\.lastFrontier/)
  assert.match(page, /workerMarkup!==state\.lastWorkers/,
    'an unchanged status poll must not rebuild the inspector and destroy copied text')
  assert.doesNotMatch(page, /\$\('stream'\)\.scrollTop=\$\('stream'\)\.scrollHeight/,
    'every refresh must not force the conversation back to the bottom')
})

test('production-facing runtime text is English-only', () => {
  const files = PRODUCTION_DIRS.flatMap((dir) => productionFiles(join(ROOT, dir)))
  for (const dir of PRODUCTION_DIRS) assert.ok(files.some(file => relative(ROOT, file).replaceAll('\\', '/').startsWith(dir + '/')), `${dir} was not scanned`)
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
    const run = spawnSync(process.execPath, ['setup.mjs', join(dir, 'workspace')], {
      cwd: example,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'RULITH_DOWNLOAD_ORIGIN')),
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    assert.equal(existsSync(join(dir, 'workspace', 'worker-tools.json')), true,
      'local Adapter bindings must be explicit in the Worker Tool Manifest')
    assert.equal(existsSync(join(dir, 'workspace', 'runtime', 'input.json')), true)
    assert.equal(existsSync(join(dir, 'workspace', 'adapters', 'verified-calculation', 'read-input.mjs')), true)
    assert.equal(existsSync(join(dir, 'workspace', 'recipe.json')), false, 'managed capability packages must not be rendered into the client workspace')
    assert.equal(existsSync(join(dir, 'workspace', 'recipe.template.json')), false,
      'the public market source must not be downloaded as a client-owned recipe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verified calculation is one Capability composed of Program and Sources', () => {
  const recipe = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/verified-calculation-recipe.json'), 'utf8'))
  const guide = readFileSync(join(ROOT, 'examples/verified-calculation/README.md'), 'utf8')
  assert.equal(recipe.capability.id, 'verified_calculation')
  assert.equal(recipe.capability.version, '1.0.2')
  assert.equal(recipe.capability.caseContracts[0].acceptance.predicate, 'rulith.verified_calculation.calculation_completed')
  assert.deepEqual(recipe.sources.sources[0].accessModes, [])
  assert.ok(!recipe.sources.sources[0].words.includes('task_seed'))
  assert.equal(recipe.program.acceptance.length, 1)
  assert.match(guide, /one\s+installed Capability with four inspectable sections/i)
  assert.doesNotMatch(guide, /two governed components|install.*Knowledge[\s\S]*install.*source/i,
    'typed protocol components must not leak back into the user installation ritual')
  assert.match(guide, /verified-calc-worker/)
  assert.doesNotMatch(guide, /verified-calculation-worker/)
  assert.match(guide, /generated absolute `RULITH_WORKER_ROOT` and `RULITH_TOOLS_FILE`/,
    'the guide must keep the setup-generated Adapter and manifest paths')
})

// The behaviour this used to assert is now driven end to end in
// `official-example.test.mjs`: the real Worker runs the real Adapter and the task root is
// read off the receipt. What stays here is the one-line shape check that costs nothing —
// the intake Adapter reads its task structure from Source material and takes no identity
// from the environment. It used to require `RULITH_CASE_ID`, a name the Worker hop does
// not set, so it refused every real invocation; where a machine happened to carry that
// variable it rooted governed task structure at an operator's string instead.
test('verified calculation intake roots its task tree in trusted Source material', () => {
  const adapter = readFileSync(join(ROOT, 'examples', 'verified-calculation', 'read-input.mjs'), 'utf8')
  assert.doesNotMatch(adapter, /process\.env\.RULITH_CASE_ID/)
  assert.match(adapter, /task_root: `CALC_BATCH_\$\{input\.batch_id\}`/)
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
//   · every RULITH_* name taught in a committed public file is supported by the code;
//   · every Agent flag taught in an Agent invocation is accepted by the parser.
//
// Extraction failure must be RED, not green: an empty read of either source set
// would make every taught name look supported. The floors below are the assertion
// that the extractors still have hold of the sources.

/**
 * Environment variable names the shipped runtime supports, in both directions.
 *
 * A name it *reads* is the obvious half. The other half is a name it *provides*: the Worker
 * hands `RULITH_INVOCATION_ID`, `RULITH_SOURCE_ACCESS` and `RULITH_SOURCE_TYPE` to every
 * `run` Adapter it starts, and Rulith Local hands its children theirs. Those are published
 * names an Adapter author writes code against, and this runtime never reads them — so a
 * read-only extractor called the documentation wrong about names the documentation is the
 * only place to learn. The failure it exists to catch is unchanged: a taught name that
 * nothing here reads *or* sets is a published instruction to fail.
 */
/**
 * Comments removed, so prose about a name is never mistaken for code that uses it.
 *
 * This file's own commentary names retired and hypothetical variables on purpose. A scan that
 * counted them would report the runtime as supporting whatever its authors had written *about*,
 * which is the opposite of what this guard is for.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function runtimeEnvNamesSupported(root = ROOT) {
  const names = new Set()
  const files = ['agent', 'worker', 'local', 'examples', 'scripts'].flatMap((name) => {
    const dir = join(root, name)
    return existsSync(dir) ? productionFiles(dir, root) : []
  })
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue
    const source = codeOnly(readFileSync(file, 'utf8'))
    for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1])
    for (const m of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) names.add(m[1])
    // A name written into a child's environment as an object key — Rulith Local's spawns.
    for (const m of source.matchAll(/\b(RULITH_[A-Z0-9_]*)\s*:/g)) names.add(m[1])
    // The context the Worker hands a `run` Adapter is one declared map. `handRun`
    // writes computed keys, so a key-shaped scan alone cannot see these names.
    const supplied = source.match(/ADAPTER_CONTEXT\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)
    if (supplied !== null) for (const m of supplied[1].matchAll(/'(RULITH_[A-Z0-9_]+)'/g)) names.add(m[1])
  }
  return names
}

test('runtime source guards exclude generated examples and retain all other source', () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-source-scan-'))
  try {
    const example = join(root, 'examples', 'verified-calculation')
    mkdirSync(join(example, 'runtime'), { recursive: true })
    mkdirSync(join(example, '.runtime-test'))
    const shipped = 'examples/verified-calculation/read-input.mjs'
    writeFileSync(join(root, shipped), 'const input = process.env.RULITH_SOURCE_ACCESS\n')
    const retired = 'const env = { RULITH_CALC_INPUT: "old-input", RULITH_CALC_OUTPUT: "old-output" }\n'
    writeFileSync(join(example, 'runtime', 'e2e-credential-bridge.mjs'), retired)
    writeFileSync(join(example, '.runtime-test', 'old-adapter.mjs'), retired)

    assert.deepEqual(productionFiles(join(root, 'examples'), root), [join(root, shipped)])
    assert.deepEqual([...runtimeEnvNamesSupported(root)], ['RULITH_SOURCE_ACCESS'])

    writeFileSync(join(example, 'new-adapter.mjs'), retired)
    assert.equal(runtimeEnvNamesSupported(root).has('RULITH_CALC_INPUT'), true,
      'new example source must be scanned even before it is listed for packaging')
    mkdirSync(join(root, 'scripts', 'runtime'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'runtime', 'verify.mjs'), 'const repo = process.env.RULITH_CONTRACT_REPO\n')
    assert.equal(runtimeEnvNamesSupported(root).has('RULITH_CONTRACT_REPO'), true,
      'the generated-directory exclusion is limited to examples; scripts stay recursive')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('committed public files only teach environment variables the runtime supports', () => {
  const supported = runtimeEnvNamesSupported()
  assert.ok(supported.size >= 20, `only extracted ${supported.size} environment names from the runtime — the extractor lost the source`)
  // Positive and negative calibration for the extractor itself. The three the Worker supplies
  // are found from their one declared list; a name that exists only in prose is not, however
  // often the prose says it. `RULITH_CASE_ID` is the live example: this repository discusses
  // it at length precisely because it is retired, and it must not read as supported.
  for (const supplied of ['RULITH_INVOCATION_ID', 'RULITH_SOURCE_ACCESS', 'RULITH_SOURCE_TYPE']) {
    assert.ok(supported.has(supplied), `${supplied} is handed to every run Adapter and the extractor lost it`)
  }
  for (const discussed of ['RULITH_CASE_ID', 'RULITH_CALC_INPUT', 'RULITH_CALC_OUTPUT']) {
    assert.equal(supported.has(discussed), false,
      `${discussed} is retired and appears only in commentary; a comment is not support`)
  }

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

  const unread = [...new Set(taught.filter((e) => !supported.has(e.name)).map((e) => `${e.name} (${e.rel})`))].sort()
  assert.deepEqual(unread, [],
    'these names are published as instructions but nothing in the runtime reads or provides them.\n  '
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

test('late Agent readiness is observable after the start confirmation bound, and clears on stop', async () => {
  await localRole({
    source: "setTimeout(() => process.send?.({protocol:'rulith-local-event',event:{type:'start',agentId:'late-ready'}}), 350);setInterval(()=>{},1000)\n",
    startConfirmMs: 100,
  }, async ({host, control, quiesce}) => {
    await quiesce()
    const answer = await control('start')
    assert.equal(answer.body.state, 'unconfirmed')
    assert.equal(host.status().agent, true)
    assert.equal(host.status().ready.agent, false)
    const deadline = Date.now() + 3000
    while (!host.status().ready.agent && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
    assert.equal(host.status().ready.agent, true)
    await control('stop')
    assert.equal(host.status().ready.agent, false)
  })
})
