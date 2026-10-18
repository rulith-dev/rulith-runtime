// SPDX-License-Identifier: Apache-2.0
/**
 * 实现字节 pin（PSC SYS-TOOL-01“Worker 只执行已核验的同一份实现字节”、ACC-TOOL-09；
 * 0.2.24 在官方编程能力的工具上落实）。
 *
 * 每一条都从外面看结果：pin 是否随字节移动、拒绝时被 pin 的 Tool 的代码是否一行都没跑
 * （Adapter 自己写的标记文件不存在），以及真实 Worker 进程在领取之前是否就拒绝了。
 *
 *   · 字节变化 → 新 digest；没有本地实现文件的 Tool 的 digest 不变；内置 Tool 绑定 Runtime 发布。
 *   · 缺文件、未声明的依赖（静态、动态、CommonJS）在执行前或在该依赖执行前可见拒绝。
 *   · 核验之后才换的字节：启动前被拒（Worker 再核一次），启动之后被拒（装载钩子核验并执行同一份字节）。
 *   · kit 的 eng.* 工具经真实 Worker 端到端；kit 的监督进程在同一道边界下启动。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  builtinLocalAuthoringTools, builtinMaterialTools, builtinSourceTools, builtinWorkspaceTools, execute,
  runImplementation, toolDigest, withImplementationPins, workerToolDescriptor, workerToolsOf,
} from '../worker/rulith-worker.mjs'
import { IMPLEMENTATION_PIN_ENV, IMPLEMENTATION_PIN_FORMAT, implementationPinKey } from '../worker/implementation-hooks.mjs'
import { DONE, HOLD, actionRow, artifactWorkFields, driveWorker, runPin } from './support/worker-harness.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const BOUNDARY = pathToFileURL(path.join(repo, 'worker/implementation-boundary.mjs')).href
const PACKAGE = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const KIT_DIR = path.join(repo, 'kits/general')
const KIT = JSON.parse(fs.readFileSync(path.join(KIT_DIR, 'worker-tools.json'), 'utf8'))
const KIT_PREFIX = 'adapters/engineering-work/'
/** The kit as the installer lays it out in a Worker root: every module except the two installer files. */
const KIT_SOURCES = Object.fromEntries(fs.readdirSync(KIT_DIR)
  .filter((name) => name.endsWith('.mjs') && !['install.mjs', 'installer.mjs'].includes(name))
  .map((name) => [KIT_PREFIX + name, fs.readFileSync(path.join(KIT_DIR, name), 'utf8')]))
const manifestOf = (tools) => ({ format: 'rulith-worker-tools/1', tools })

function workerRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rulith-pin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  return root
}
/** A marker an Adapter writes when — and only when — its code actually runs. */
const mark = (file, text) => `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(file)}, ${JSON.stringify(text + '\n')})\n`
const marked = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

/** A run Tool compiled the way the Worker compiles one and verified now (toolFromSpec does the same). */
function compiledRun(root, definition) {
  const implementation = runImplementation(definition, root)
  return { impl: 'run', entry: implementation.entry, passArgs: true, implementation, returns: [] }
}
/** Start an entry under the boundary directly, with a pin list the caller chose. */
function underBoundary(entry, files, env = {}) {
  const { NODE_OPTIONS: _unused, ...inherited } = process.env
  return new Promise((done) => execFile(process.execPath, ['--import', BOUNDARY, entry, '{}'], {
    env: { ...inherited, ...env, ...(files === undefined ? {} : {
      [IMPLEMENTATION_PIN_ENV]: JSON.stringify({ format: IMPLEMENTATION_PIN_FORMAT, files }),
    }) },
  }, (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })))
}
const pinFiles = (implementation) => Object.fromEntries(implementation.paths.map(({ path: file, sha256 }) => [implementationPinKey(file), sha256]))

test('a run Tool pin covers its entry and every declared implementation file: one byte moves it', (t) => {
  const root = workerRoot(t, {
    'adapters/calc/entry.mjs': "import { value } from './lib.mjs'\nprocess.stdout.write(String(value))\n",
    'adapters/calc/lib.mjs': 'export const value = 1\n',
  })
  const definition = { adapter: 'run', sourceTypes: [], entry: 'adapters/calc/entry.mjs', implementation: ['adapters/calc/lib.mjs'] }
  const first = runImplementation(definition, root)
  assert.notEqual(first.digest, toolDigest(definition), 'the pin is still the configuration digest alone')
  assert.equal(runImplementation(definition, root).digest, first.digest, 'the same bytes gave two pins')
  fs.writeFileSync(path.join(root, 'adapters/calc/lib.mjs'), 'export const value = 2\n')
  const libChanged = runImplementation(definition, root).digest
  assert.notEqual(libChanged, first.digest, 'a changed declared file did not move the pin')
  fs.writeFileSync(path.join(root, 'adapters/calc/entry.mjs'), "import { value } from './lib.mjs'\nprocess.stdout.write(String(value + 0))\n")
  assert.notEqual(runImplementation(definition, root).digest, libChanged, 'a changed entry did not move the pin')
  // The advertised digest is that pin, and anyone holding the same bytes computes the same one.
  const tools = withImplementationPins(workerToolsOf(manifestOf({ 'acme.calc@1': definition })), root)
  const advertised = workerToolDescriptor('acme.calc@1', tools['acme.calc@1']).digest
  assert.equal(advertised, runImplementation(definition, root).digest)
  assert.equal(advertised, runPin(definition, {
    'adapters/calc/entry.mjs': fs.readFileSync(path.join(root, 'adapters/calc/entry.mjs'), 'utf8'),
    'adapters/calc/lib.mjs': fs.readFileSync(path.join(root, 'adapters/calc/lib.mjs'), 'utf8'),
  }))
})

test('Tools with no local implementation files keep their digest; built-ins are pinned to the Runtime release', () => {
  const declared = {
    'acme.lookup@1': { adapter: 'http', sourceTypes: ['http'], entry: '/lookup', kind: 'read' },
    'acme.orders@1': { adapter: 'db-query', sourceTypes: ['db'], entry: 'SELECT status FROM orders' },
    'acme.mail@1': { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'send_mail', kind: 'write' },
    'acme.notes@1': { adapter: 'workspace', sourceTypes: ['file'], entry: 'read_text' },
  }
  // No root is read for them: there is nothing local to pin.
  const tools = withImplementationPins(workerToolsOf(manifestOf(declared)), path.join(os.tmpdir(), 'no-such-worker-root'))
  for (const [id, definition] of Object.entries(declared)) assert.equal(tools[id].digest, toolDigest(definition), `${id} moved`)
  const release = `rulith@${PACKAGE.version}`
  const builtins = { ...builtinWorkspaceTools('read-write'), ...builtinSourceTools(), ...builtinMaterialTools('materials') }
  assert.ok(Object.keys(builtins).length >= 10)
  for (const [id, tool] of Object.entries(builtins)) {
    const definition = { adapter: tool.adapter, sourceTypes: tool.sourceTypes, entry: tool.entry }
    assert.equal(tool.digest, toolDigest({ ...definition, runtime: release }), `${id} is not pinned to ${release}`)
    assert.notEqual(tool.digest, toolDigest(definition), `${id} still has a pin no Runtime release moves`)
  }
  for (const [id, tool] of Object.entries(builtinLocalAuthoringTools('materials'))) {
    const definition = { adapter: tool.adapter, sourceTypes: tool.sourceTypes, entry: tool.entry,
      implementationVersion: tool.implementationVersion, release: tool.release }
    assert.equal(tool.digest, toolDigest({ ...definition, runtime: release }), id)
  }
})

test('a missing, escaping or non-module implementation file is not advertised and cannot run', (t) => {
  const root = workerRoot(t, { 'adapters/calc/entry.mjs': 'process.stdout.write("ran")\n' })
  const definition = { adapter: 'run', sourceTypes: [], entry: 'adapters/calc/entry.mjs', implementation: ['adapters/calc/lib.mjs'] }
  assert.throws(() => runImplementation(definition, root), /adapters\/calc\/lib\.mjs is missing from the Worker root/)
  const refused = []
  const tools = withImplementationPins(workerToolsOf(manifestOf({
    'acme.calc@1': definition, 'acme.lookup@1': { adapter: 'http', sourceTypes: ['http'], entry: '/lookup', kind: 'read' },
  })), root, (id) => refused.push(id))
  assert.deepEqual(refused, ['acme.calc@1'])
  assert.equal(tools['acme.calc@1'], undefined, 'a Tool whose implementation cannot be pinned was still advertised')
  assert.ok(tools['acme.lookup@1'], 'one unpinnable Tool took the others down with it')
  for (const implementation of [['../outside.mjs'], ['adapters/calc/lib.js'], ['adapters/calc/entry.mjs'], ['a.mjs', 'a.mjs']]) {
    assert.throws(() => workerToolsOf(manifestOf({ 'acme.calc@1': { ...definition, implementation } })), /implementation/, JSON.stringify(implementation))
  }
  assert.throws(() => workerToolsOf(manifestOf({ 'acme.lookup@1': { adapter: 'http', sourceTypes: ['http'], entry: '/x', implementation: ['a.mjs'] } })),
    /applies only to a run Adapter/)
  assert.throws(() => runImplementation({ adapter: 'run', sourceTypes: [], entry: 'adapters/calc/entry.js' }, root), /not an ES module file/)
  assert.throws(() => runImplementation({ adapter: 'run', sourceTypes: [], entry: '../entry.mjs' }, root), /outside the Worker root/)
})

test('an undeclared dependency does not load: static ones before any code runs, dynamic ones before they run', async (t) => {
  const dir = workerRoot(t, {})
  const entryRan = path.join(dir, 'entry-ran'), dependencyRan = path.join(dir, 'dependency-ran')
  const root = workerRoot(t, {
    'static.mjs': `import './undeclared.mjs'\n${mark(entryRan, 'static entry')}`,
    'dynamic.mjs': `${mark(entryRan, 'dynamic entry')}await import('./undeclared.mjs')\n`,
    'commonjs.mjs': "import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n"
      + "require('node:path')\nrequire('./helper.cjs')\n",
    'undeclared.mjs': mark(dependencyRan, 'undeclared'),
    'helper.cjs': `require('node:fs').appendFileSync(${JSON.stringify(dependencyRan)}, 'commonjs\\n')\n`,
  })
  const run = (entry) => execute('probe', {}, { probe: compiledRun(root, { adapter: 'run', sourceTypes: [], entry }) }, {})
  await assert.rejects(run('static.mjs'), /implementation_boundary: .*undeclared\.mjs is not declared in this Tool's implementation/)
  assert.equal(marked(entryRan), '', 'the entry ran although its static dependency was undeclared')
  await assert.rejects(run('dynamic.mjs'), /implementation_boundary: .*undeclared\.mjs is not declared/)
  assert.equal(marked(entryRan), 'dynamic entry\n', 'what ran before the undeclared import is a real effect and stays')
  await assert.rejects(run('commonjs.mjs'), /implementation_boundary: .*helper\.cjs/)
  assert.equal(marked(dependencyRan), '', 'an undeclared dependency ran')
})

test('bytes changed after verification never run: refused before the start, and at load after it', async (t) => {
  const dir = workerRoot(t, {})
  const entryRan = path.join(dir, 'entry-ran'), lateRan = path.join(dir, 'late-ran')
  const root = workerRoot(t, {
    'entry.mjs': `import { value } from './lib.mjs'\n${mark(entryRan, 'entry')}process.stdout.write(String(value))\n`,
    'lib.mjs': 'export const value = 42\n',
  })
  const definition = { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', implementation: ['lib.mjs'] }
  assert.equal(await execute('probe', {}, { probe: compiledRun(root, definition) }, {}), '42')
  fs.rmSync(entryRan)

  // Changed between the pre-claim check and the start: the Worker checks again and does not start it.
  const verified = compiledRun(root, definition)
  fs.writeFileSync(path.join(root, 'lib.mjs'), 'export const value = 666\n')
  await assert.rejects(execute('probe', {}, { probe: verified }, {}),
    /no longer matches its pin: lib\.mjs changed after it was verified\. The Adapter was not started/)
  // Removed after verification: the same.
  fs.rmSync(path.join(root, 'lib.mjs'))
  await assert.rejects(execute('probe', {}, { probe: verified }, {}), /lib\.mjs is missing/)
  assert.equal(marked(entryRan), '')

  // Changed after the Worker's last check, before the process loads it: the loader hashes the bytes it
  // is about to compile and compiles exactly those, so the stale pin refuses before any module runs.
  fs.writeFileSync(path.join(root, 'lib.mjs'), 'export const value = 42\n')
  const stale = pinFiles(runImplementation(definition, root))
  fs.writeFileSync(path.join(root, 'lib.mjs'), `${mark(lateRan, 'replaced lib')}export const value = 666\n`)
  const late = await underBoundary(path.join(root, 'entry.mjs'), stale)
  assert.notEqual(late.code, 0)
  assert.match(late.stderr, /implementation_boundary: .*lib\.mjs is not the verified implementation/)
  assert.equal(marked(entryRan) + marked(lateRan), '', 'a replaced dependency ran under the old pin')

  // The same through execute: a Tool that replaces its own declared dependency before loading it.
  const own = workerRoot(t, {
    'entry.mjs': `${mark(entryRan, 'before')}import { writeFileSync } from 'node:fs'\n`
      + `writeFileSync(new URL('./late.mjs', import.meta.url), ${JSON.stringify(mark(lateRan, 'replaced'))})\n`
      + "await import('./late.mjs')\n",
    'late.mjs': 'export const late = true\n',
  })
  await assert.rejects(execute('probe', {}, { probe: compiledRun(own, { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', implementation: ['late.mjs'] }) }, {}),
    /implementation_boundary: .*late\.mjs is not the verified implementation/)
  assert.equal(marked(entryRan), 'before\n')
  assert.equal(marked(lateRan), '', 'a dependency replaced after verification ran under the old digest')
})

test('the boundary refuses a process started without a pin list, and a run Tool never receives NODE_OPTIONS', async (t) => {
  const dir = workerRoot(t, {})
  const ran = path.join(dir, 'ran'), preloaded = path.join(dir, 'preloaded')
  const root = workerRoot(t, { 'entry.mjs': `${mark(ran, 'entry')}process.stdout.write('ok')\n`, 'preload.mjs': mark(preloaded, 'preload') })
  const unlisted = await underBoundary(path.join(root, 'entry.mjs'), undefined)
  assert.notEqual(unlisted.code, 0)
  assert.match(unlisted.stderr, /implementation_boundary: this process was started without the pinned implementation list/)
  assert.equal(marked(ran), '')
  // An inherited NODE_OPTIONS would preload code ahead of the boundary; the Worker drops it.
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(root, 'preload.mjs')).href}`
  try {
    assert.equal(await execute('probe', {}, { probe: compiledRun(root, { adapter: 'run', sourceTypes: [], entry: 'entry.mjs' }) }, {}), 'ok')
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = before
  }
  assert.equal(marked(preloaded), '', 'NODE_OPTIONS preloaded code into a run Tool')
  assert.throws(() => workerToolsOf(manifestOf({ 'acme.calc@1': { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', env: { pass: ['NODE_OPTIONS'] } } })),
    /NODE_OPTIONS/)
})

test('every kit Tool declares the kit library it may load, and the installer ships exactly those files', () => {
  const library = Object.keys(KIT_SOURCES).filter((name) => !Object.values(KIT.tools).some((tool) => tool.entry === name))
  // What an entry can load: its static import closure inside the kit, plus the supervisor it starts.
  const closure = (name, seen = new Set()) => {
    if (seen.has(name)) return seen
    seen.add(name)
    for (const [, relative] of KIT_SOURCES[name].matchAll(/from '\.\/([^']+\.mjs)'/g)) closure(KIT_PREFIX + relative, seen)
    return seen
  }
  for (const [id, tool] of Object.entries(KIT.tools)) {
    assert.ok(tool.entry.startsWith(KIT_PREFIX), id)
    assert.deepEqual([...tool.implementation].sort(), [...library].sort(), `${id} does not declare the kit library`)
    for (const name of [...closure(tool.entry), KIT_PREFIX + 'supervisor.mjs']) {
      assert.ok(name === tool.entry || tool.implementation.includes(name), `${id} can load ${name}, which it does not declare`)
    }
  }
})

/** The general kit installed in a fresh Worker root, with its home and one project Source `lab`. */
function kitFixture(t) {
  const dir = workerRoot(t, {})
  const project = path.join(dir, 'project'), home = path.join(dir, 'kit-home')
  fs.mkdirSync(project); fs.mkdirSync(path.join(home, 'specs'), { recursive: true })
  fs.writeFileSync(path.join(project, 'notes.txt'), 'pinned\n')
  return { project, home }
}
const kitRow = (id, args = {}) => actionRow({
  work: `inv_${id.replace(/[^a-z0-9]/gi, '_')}`,
  tool: id.split('@')[0],
  toolContractId: id,
  sourceRecordId: 'lab',
  args: JSON.stringify({ source: 'lab', ...args }),
  toolSpec: JSON.stringify({ impl: 'worker-tool', exec: id, kind: KIT.tools[id].kind, params: KIT.tools[id].params, sourceTypes: ['file'] }),
  toolDigest: runPin(KIT.tools[id], KIT_SOURCES),
  ...artifactWorkFields('lab'),
})

test('kit tools run end to end through the real Worker under the pin of their implementation bytes', async (t) => {
  const { project, home } = kitFixture(t)
  const id = 'eng.read@1'
  let polls = 0
  const run = await driveWorker({
    extraAdapters: KIT_SOURCES,
    extraTools: { [id]: KIT.tools[id], 'eng.tree_state@1': KIT.tools['eng.tree_state@1'] },
    env: { ENG_KIT_HOME: home },
    sources: () => [{ name: 'lab', type: 'file', access: project }],
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      return ++polls === 1 ? { body: { accepted: true, payload: { work: [kitRow(id, { path: 'notes.txt' })] } } } : HOLD
    },
    done: (seen, output) => DONE.action.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  const advertised = run.of('Poll')[0].operation.tools.find((tool) => tool.id === id)
  assert.equal(advertised.digest, runPin(KIT.tools[id], KIT_SOURCES), 'the Worker advertised a pin other than its implementation bytes')
  assert.notEqual(advertised.digest, toolDigest(KIT.tools[id]))
  assert.equal(run.of('ClaimWork').length, 1, run.output)
  const [report] = run.of('ReportWork')
  assert.equal(report?.operation.ok, true, run.output)
  assert.match(String(report.operation.result), /pinned/)
})

test('a kit file changed after the Worker advertised it is refused before the claim, and nothing runs', async (t) => {
  const { project, home } = kitFixture(t)
  const id = 'eng.write_file@1'
  let polls = 0, installedRoot
  const run = await driveWorker({
    extraAdapters: KIT_SOURCES,
    extraTools: { [id]: KIT.tools[id] },
    env: { ENG_KIT_HOME: home },
    sources: (root) => { installedRoot = root; return [{ name: 'lab', type: 'file', access: project }] },
    reply: (operation) => {
      if (operation.kind !== 'Poll') return { body: { accepted: true, revision: 'b12' } }
      if (++polls !== 1) return HOLD
      // The Worker has started and advertised its pins; now one library byte changes on disk.
      fs.appendFileSync(path.join(installedRoot, KIT_PREFIX + 'lib.mjs'), '\n')
      return { body: { accepted: true, payload: { work: [kitRow(id, { path: 'written.txt', text: 'x', expect_digest: '' })] } } }
    },
    done: (seen, output) => /implementation is not the one pinned/.test(output),
    timeoutMs: 20_000,
  })
  assert.equal(run.timedOut, false, run.output)
  assert.match(run.output, /Skipping eng\.write_file: Worker Tool eng\.write_file@1 implementation is not the one pinned \(adapters\/engineering-work\/lib\.mjs differs\)/)
  assert.equal(run.of('ClaimWork').length, 0, 'a changed implementation was claimed under the old pin')
  assert.equal(run.of('ReportWork').length, 0)
  assert.equal(fs.existsSync(path.join(project, 'written.txt')), false, 'the changed implementation ran')
})

test('the kit starts its job supervisor under the same boundary: a supervisor replaced after verification does not run', async (t) => {
  const { project, home } = kitFixture(t)
  const root = workerRoot(t, KIT_SOURCES)
  fs.writeFileSync(path.join(project, 'job.mjs'), "import fs from 'node:fs'; fs.writeFileSync('job-output', 'done')\n")
  const env = { ENG_KIT_HOME: home, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: project }
  const start = async () => {
    const pin = pinFiles(runImplementation(KIT.tools['eng.job_start@1'], root))
    return { pin, start: () => new Promise((done) => execFile(process.execPath,
      ['--import', BOUNDARY, path.join(root, KIT_PREFIX + 'job_start.mjs'), JSON.stringify({ command: ['node', 'job.mjs'], cwd: '.' })],
      { env: { ...process.env, ...env, [IMPLEMENTATION_PIN_ENV]: JSON.stringify({ format: IMPLEMENTATION_PIN_FORMAT, files: pin }) } },
      // A kit refusal writes `{rows: [], verdict}` and exits 2; either way the receipt is stdout.
      (error, stdout, stderr) => done(stdout ? JSON.parse(stdout) : { verdict: String(stderr || error?.message) }))) }
  }
  // Replaced after the Worker verified the implementation, before the adapter starts the supervisor.
  const replaced = await start()
  fs.appendFileSync(path.join(root, KIT_PREFIX + 'supervisor.mjs'), '\n// replaced\n')
  const refused = await replaced.start()
  assert.equal(refused.verdict, 'job unavailable', JSON.stringify(refused))
  assert.equal(fs.existsSync(path.join(project, 'job-output')), false, 'a replaced supervisor ran the job')

  // With the verified supervisor the job runs, in a fresh kit home (the refused one stays recorded as starting).
  fs.writeFileSync(path.join(root, KIT_PREFIX + 'supervisor.mjs'), KIT_SOURCES[KIT_PREFIX + 'supervisor.mjs'])
  const freshHome = path.join(path.dirname(home), 'kit-home-2')
  fs.mkdirSync(path.join(freshHome, 'specs'), { recursive: true })
  env.ENG_KIT_HOME = freshHome
  const started = await (await start()).start()
  assert.ok(Array.isArray(started.rows) && started.rows[0]?.job_id, JSON.stringify(started))
  for (let i = 0; i < 800 && !fs.existsSync(path.join(project, 'job-output')); i++) await new Promise((done) => setTimeout(done, 25))
  assert.equal(fs.readFileSync(path.join(project, 'job-output'), 'utf8'), 'done')
  // Let the supervisor record the end of the job before the directories are removed.
  const jobFile = () => fs.readdirSync(freshHome).find((name) => /^job-.*\.json$/.test(name))
  for (let i = 0; i < 800; i++) {
    const name = jobFile()
    if (name && ['done', 'failed', 'stopped'].includes(JSON.parse(fs.readFileSync(path.join(freshHome, name), 'utf8')).status)) break
    await new Promise((done) => setTimeout(done, 25))
  }
})

test('the kit digests a Runtime release ships are a function of the release files alone', () => {
  // What an operator (or the Gateway) pins for the official tools can be computed from the published
  // kit files: the definition plus each declared file's SHA-256, keyed by its installed path.
  for (const [id, tool] of Object.entries(KIT.tools)) {
    const files = Object.fromEntries([tool.entry, ...tool.implementation]
      .map((name) => [name, createHash('sha256').update(KIT_SOURCES[name]).digest('hex')]))
    assert.equal(runPin(tool, KIT_SOURCES), toolDigest(tool, files), id)
  }
})
