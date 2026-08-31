import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

import { builtinWorkspaceTools, execute, orderWork, toolFromSpec } from '../worker/rulith-worker.mjs'
import { applyEnvEdit, maskEnv, stationPage } from '../station/rulith-station.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const PRODUCTION_DIRS = ['agent', 'worker', 'station', 'examples', 'config']
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

test('station masks secrets and never persists the mask as a credential', () => {
  const prior = { RULITH_TOKEN: 'token-123456', RULITH_URL: 'https://api.rulith.ai' }
  const view = maskEnv(prior)
  assert.equal(view.RULITH_TOKEN, '••••3456')
  assert.deepEqual(applyEnvEdit(prior, view), prior)
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
})

test('built-in workspace Tools stay inside their Source root and return bounded machine-readable results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-workspace-'))
  try {
    writeFileSync(join(root, 'input.json'), JSON.stringify({ amount: 7 }))
    writeFileSync(join(root, 'notes.txt'), 'alpha\nbeta\nalpha again\n')
    const tools = builtinWorkspaceTools('read-write')
    const sources = { workspace: { access: root, type: 'file' } }
    const call = (id, args) => {
      const local = toolFromSpec(JSON.stringify({
        name: id, kind: id.includes('write_') ? 'write' : 'read', impl: 'worker-tool',
        source: 'workspace', exec: id, params: {},
      }), JSON.stringify(args), tools, tools[id].digest, sources)
      return execute(id, args, { [id]: local }, sources)
    }

    const read = JSON.parse(String(await call('rulith.workspace.read_json@1', { path: 'input.json' })))
    assert.deepEqual(read, { amount: 7 })
    const search = JSON.parse(String(await call('rulith.workspace.search@1', { query: 'alpha', path: '.' })))
    assert.equal(search.matches.length, 2)
    assert.ok(search.matches.every((row) => row.path === 'notes.txt'))
    const count = JSON.parse(String(await call('rulith.workspace.count@1', { path: '.', recursive: false })))
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
    const counted = await execute('count_source', { path: '.', recursive: false }, { count_source: countTool }, sources)
    assert.deepEqual(counted.facts, [{ predicate: 'acme.files.directory_count', args: {
      source: 'workspace', path: '.', file_count: 2, digest: count.rows[0].digest,
    } }], 'workspace returns must cross the same structured result membrane as run adapters')
    const digest = String(await call('rulith.workspace.hash@1', { path: 'input.json' }))
    assert.match(digest, /^[a-f0-9]{64}$/)

    await call('rulith.workspace.write_json@1', { path: 'out/result.json', value: { ok: true } })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'out', 'result.json'), 'utf8')), { ok: true })
    await assert.rejects(
      call('rulith.workspace.read_text@1', { path: '../outside.txt' }),
      /outside the configured Source root/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent help is available before credentials and documents the UI port', () => {
  const run = spawnSync(process.execPath, ['agent/rulith-agent.mjs', '--help'], {
    cwd: ROOT,
    env: { ...process.env, RULITH_TOKEN: '', RULITH_MODEL_KEY: '', ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RULITH_UI_PORT/)
  assert.match(run.stdout, /--case <id>/)
  assert.doesNotMatch(run.stdout, /--case-boards|--recipe/)
  assert.doesNotMatch(run.stderr, /missing/i)
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

test('agent lifecycle events shown to users use the English product vocabulary', () => {
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.match(source, /\[Verification\]/)
  assert.match(source, /Closed Case "\$\{bound\.root\}" with disposition/)
  assert.match(source, /emitOn\(ctx, 'case-closed'/)
  assert.match(source, /Board certified the case as deliverable/)
  assert.doesNotMatch(source, /notes\.push\(`\[放电/)
  assert.doesNotMatch(source, /log\(`◎ 案卷/)
})

test('station presents the public local workflow in English', () => {
  const visible = stationPage.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(stationPage, /Local control room/)
  assert.match(stationPage, /Maximum concurrent cases/)
  assert.match(stationPage, /Worker activity/)
  assert.match(stationPage, /Board: action/)
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
    'station/rulith-station.mjs',
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
  const roots = ['agent', 'worker', 'station', 'examples', 'scripts']
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
  'config/rulith-station.example.json',
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
  assert.ok(accepted.has('--agent') && accepted.has('--ui'), 'the flag extractor is not reading the real parser')

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
  // The Station example launches the Agent through `paths.repl`, so its argument
  // array is an Agent invocation even though the binary name is on another line.
  const station = JSON.parse(readFileSync(join(ROOT, 'config', 'rulith-station.example.json'), 'utf8'))
  for (const arg of station.repl?.args ?? []) {
    if (/^--/.test(arg)) taught.push({ flag: arg, rel: 'config/rulith-station.example.json' })
  }
  assert.ok(taught.length >= 3, `only found ${taught.length} taught Agent flags — the invocation scan is not matching`)

  const rejected = [...new Set(taught.filter((e) => !accepted.has(e.flag)).map((e) => `${e.flag} (${e.rel})`))].sort()
  assert.deepEqual(rejected, [],
    'these flags are published but the Agent rejects them and exits 1.\n  '
    + rejected.join('\n  '))
})
