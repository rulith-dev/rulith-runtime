// SPDX-License-Identifier: Apache-2.0
/**
 * 实现字节 pin（PSC SYS-TOOL-01“Worker 只执行已核验的同一份实现字节”、ACC-TOOL-09；
 * 0.2.24 在官方编程能力的工具上落实）。
 *
 * 每一条都从外面看结果：pin 是否随字节移动、拒绝时被 pin 的 Tool 的代码是否一行都没跑
 * （Adapter 自己写的标记文件不存在），以及真实 Worker 进程在领取之前是否就拒绝了。
 *
 *   · 字节变化 → 新 digest（与独立算出的期望值比对）；没有本地实现文件的 Tool 的 digest 不变；
 *     内置 Tool 绑定 Runtime 发布。
 *   · 缺文件、未声明的依赖（静态、动态、CommonJS、经 package.json 的包名与 `#` 映射）在执行前或在该依赖执行前可见拒绝。
 *   · 核验之后才换的字节或链接：启动前被拒（Worker 再核一次），启动之后被拒（装载钩子按声明路径核验并执行同一份字节）。
 *   · 编译缓存、线程与子 Node 进程、Tool 自己注册的钩子都绕不过边界；别的程序（项目命令）照常启动。
 *   · kit 的 eng.* 工具经真实安装器与真实 Worker 端到端；kit 的监督进程在同一道边界下启动。
 *   · 整套在 module.register 钩子（Node 20.6–22.14 那条路）下再跑一遍。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

import { installGeneral, parseKitInstall } from '../kits/general/installer.mjs'
import {
  builtinLocalAuthoringTools, builtinMaterialTools, builtinSourceTools, builtinWorkspaceTools, execute,
  runImplementation, toolDigest, withImplementationPins, workerToolDescriptor, workerToolsOf,
} from '../worker/rulith-worker.mjs'
import {
  IMPLEMENTATION_HOOKS_ENV, IMPLEMENTATION_PIN_ENV, IMPLEMENTATION_PIN_FORMAT, boundaryArgv, boundaryEnv, implementationPinKey,
} from '../worker/implementation-hooks.mjs'
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
/** The hooks this run holds a Tool with: the module.register variant when asked for, or when Node has no other. */
const HOOKS = process.env[IMPLEMENTATION_HOOKS_ENV] === 'register' || typeof module.registerHooks !== 'function' ? 'register' : 'registerHooks'

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
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A run Tool compiled the way the Worker compiles one and verified now (toolFromSpec does the same). */
function compiledRun(root, definition) {
  const implementation = runImplementation(definition, root)
  return { impl: 'run', entry: implementation.entry, passArgs: true, implementation, returns: [] }
}
/** Run one entry the way the Worker runs a pinned Tool, and give back its stdout or its refusal. */
async function runTool(root, entry, implementation = []) {
  try {
    return { out: await execute('probe', {}, { probe: compiledRun(root, { adapter: 'run', sourceTypes: [], entry, implementation }) }, {}) }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}
const pinText = (files) => JSON.stringify({ format: IMPLEMENTATION_PIN_FORMAT, files })
/**
 * Start an entry under the boundary exactly as the Worker starts one — its Node options and its
 * environment — with a pin list the caller chose. `adjust` edits the environment last, for the arms
 * about a process the Worker would never start.
 */
function underBoundary(entry, files, { adjust = (env) => env, argv = ['{}'] } = {}) {
  const base = { ...process.env }
  const env = files === undefined
    ? Object.fromEntries(Object.entries(base).filter(([name]) => name.toUpperCase() !== IMPLEMENTATION_PIN_ENV))
    : boundaryEnv(base, pinText(files), process.env[IMPLEMENTATION_HOOKS_ENV])
  return new Promise((done) => execFile(process.execPath, [...boundaryArgv(BOUNDARY), entry, ...argv], { env: adjust(env) },
    (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })))
}
const pinFiles = (implementation) => Object.fromEntries(implementation.paths.map(({ path: file, sha256: digest }) => [implementationPinKey(file), digest]))

/** The Tool pin, computed here without the Worker's code: canonical JSON (sorted keys) of definition and file digests. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
const independentPin = (definition, files) => sha256(JSON.stringify(canonical({ definition, implementation: files })))

test('a run Tool pin covers its entry and every declared implementation file: one byte moves it', (t) => {
  // An expected value written out by hand: the definition and the entry's SHA-256 in canonical JSON.
  const golden = workerRoot(t, { 'a.mjs': 'export default 1\n' })
  assert.equal(sha256('export default 1\n'), '7f91f377ddf291164013ac18d6e2098b2a9f02bacc02cfb6fc191cc205474858')
  assert.equal(sha256('{"definition":{"adapter":"run","entry":"a.mjs","sourceTypes":[]},"implementation":'
    + '{"a.mjs":"7f91f377ddf291164013ac18d6e2098b2a9f02bacc02cfb6fc191cc205474858"}}'),
  'da63c880b3b7c776445f7de5c5217c855589789448ecefa516f3eda43e46c0ba')
  assert.equal(runImplementation({ adapter: 'run', sourceTypes: [], entry: 'a.mjs' }, golden).digest,
    'da63c880b3b7c776445f7de5c5217c855589789448ecefa516f3eda43e46c0ba')

  const root = workerRoot(t, {
    'adapters/calc/entry.mjs': "import { value } from './lib.mjs'\nprocess.stdout.write(String(value))\n",
    'adapters/calc/lib.mjs': 'export const value = 1\n',
  })
  const definition = { adapter: 'run', sourceTypes: [], entry: 'adapters/calc/entry.mjs', implementation: ['adapters/calc/lib.mjs'] }
  const bytes = () => ({
    'adapters/calc/entry.mjs': sha256(fs.readFileSync(path.join(root, 'adapters/calc/entry.mjs'))),
    'adapters/calc/lib.mjs': sha256(fs.readFileSync(path.join(root, 'adapters/calc/lib.mjs'))),
  })
  const first = runImplementation(definition, root)
  assert.equal(first.digest, independentPin(definition, bytes()))
  assert.notEqual(first.digest, toolDigest(definition), 'the pin is still the configuration digest alone')
  fs.writeFileSync(path.join(root, 'adapters/calc/lib.mjs'), 'export const value = 2\n')
  const libChanged = runImplementation(definition, root).digest
  assert.notEqual(libChanged, first.digest, 'a changed declared file did not move the pin')
  assert.equal(libChanged, independentPin(definition, bytes()))
  fs.writeFileSync(path.join(root, 'adapters/calc/entry.mjs'), "import { value } from './lib.mjs'\nprocess.stdout.write(String(value + 0))\n")
  assert.notEqual(runImplementation(definition, root).digest, libChanged, 'a changed entry did not move the pin')
  // The advertised digest is that pin.
  const tools = withImplementationPins(workerToolsOf(manifestOf({ 'acme.calc@1': definition })), root)
  assert.equal(workerToolDescriptor('acme.calc@1', tools['acme.calc@1']).digest, independentPin(definition, bytes()))
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
  for (const [id, definition] of Object.entries(declared)) assert.equal(tools[id].digest, sha256(JSON.stringify(canonical(definition))), `${id} moved`)
  const release = `rulith@${PACKAGE.version}`
  const builtins = { ...builtinWorkspaceTools('read-write'), ...builtinSourceTools(), ...builtinMaterialTools('materials') }
  assert.ok(Object.keys(builtins).length >= 10)
  for (const [id, tool] of Object.entries(builtins)) {
    const definition = { adapter: tool.adapter, sourceTypes: tool.sourceTypes, entry: tool.entry }
    assert.equal(tool.digest, sha256(JSON.stringify(canonical({ ...definition, runtime: release }))), `${id} is not pinned to ${release}`)
    assert.notEqual(tool.digest, sha256(JSON.stringify(canonical(definition))), `${id} still has a pin no Runtime release moves`)
  }
  for (const [id, tool] of Object.entries(builtinLocalAuthoringTools('materials'))) {
    const definition = { adapter: tool.adapter, sourceTypes: tool.sourceTypes, entry: tool.entry,
      implementationVersion: tool.implementationVersion, release: tool.release }
    assert.equal(tool.digest, sha256(JSON.stringify(canonical({ ...definition, runtime: release }))), id)
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
  const statically = await runTool(root, 'static.mjs')
  assert.match(statically.error, /implementation_boundary: .*undeclared\.mjs is not declared in this Tool's implementation, so it was not loaded/)
  assert.equal(marked(entryRan), '', 'the entry ran although its static dependency was undeclared')
  // A refusal after the process started says what was refused and, honestly, that what ran before it may
  // have had effects — never that the whole call had none.
  const dynamically = await runTool(root, 'dynamic.mjs')
  assert.match(dynamically.error, /implementation_boundary: .*undeclared\.mjs is not declared/)
  assert.match(dynamically.error, /anything this Tool did before that point may already have taken effect/)
  assert.doesNotMatch(dynamically.error, /nothing ran|nothing from it ran|no effect/i)
  assert.equal(marked(entryRan), 'dynamic entry\n', 'what ran before the undeclared import is a real effect and stays')
  assert.match((await runTool(root, 'commonjs.mjs')).error, /implementation_boundary: .*helper\.cjs/)
  assert.equal(marked(dependencyRan), '', 'an undeclared dependency ran')
})

test('imports that resolve through a package.json are refused: that file is not part of the pin', async (t) => {
  const root = workerRoot(t, {
    'package.json': JSON.stringify({ imports: { '#op': './safe.mjs' }, exports: { '.': './safe.mjs' }, name: 'self' }),
    'safe.mjs': "export const op = () => process.stdout.write('safe')\n",
    'mapped.mjs': "import { op } from '#op'\nop()\n",
    'package.mjs': "import { op } from 'self'\nop()\n",
    'builtin.mjs': "import { sep } from 'path'\nimport { readFileSync } from 'node:fs'\nprocess.stdout.write(typeof sep + typeof readFileSync)\n",
    'inline.mjs': "await import('data:text/javascript,process.stdout.write(1)')\n",
  })
  assert.match((await runTool(root, 'mapped.mjs', ['safe.mjs'])).error,
    /implementation_boundary: import "#op" goes through a package\.json "imports" map/)
  assert.match((await runTool(root, 'package.mjs', ['safe.mjs'])).error, /implementation_boundary: import "self" names a package/)
  assert.equal((await runTool(root, 'builtin.mjs')).out, 'stringfunction')
  // Source text in a URL is not a file of the implementation either.
  assert.match((await runTool(root, 'inline.mjs')).error, /implementation_boundary: data:text\/javascript,.* is not a file of the pinned implementation/)
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
    /no longer matches its pin: lib\.mjs changed after it was verified\. The Adapter was not started; nothing ran/)
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
  const replaced = await runTool(own, 'entry.mjs', ['late.mjs'])
  assert.match(replaced.error, /implementation_boundary: .*late\.mjs is not the verified implementation/)
  assert.equal(marked(entryRan), 'before\n')
  assert.equal(marked(lateRan), '', 'a dependency replaced after verification ran under the old digest')
})

test('a link swapped in after the checks is read at the declared path and refused, never followed to another pinned file', async (t) => {
  const root = workerRoot(t, {
    'entry.mjs': "import { op } from './safe/op.mjs'\nop()\n",
    'safe/op.mjs': "export const op = () => process.stdout.write('safe')\n",
    'danger/op.mjs': "export const op = () => process.stdout.write('DANGER')\n",
  })
  const definition = { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', implementation: ['safe/op.mjs', 'danger/op.mjs'] }
  assert.equal(await execute('probe', {}, { probe: compiledRun(root, definition) }, {}), 'safe')
  const pin = pinFiles(runImplementation(definition, root))
  fs.renameSync(path.join(root, 'safe'), path.join(root, 'safe-before'))
  try {
    fs.symlinkSync(path.join(root, 'danger'), path.join(root, 'safe'), 'junction')
  } catch (error) {
    return t.skip(`this account cannot create a directory link here (${error.code})`)
  }
  const swapped = await underBoundary(path.join(root, 'entry.mjs'), pin)
  assert.doesNotMatch(swapped.stdout, /DANGER/, 'a link swapped in after the checks ran another pinned file')
  assert.notEqual(swapped.code, 0)
  assert.match(swapped.stderr, /implementation_boundary: .*safe[\\/]op\.mjs is not the verified implementation/)
})

test('a planted compile-cache entry never runs under the pin: not inherited, not enabled by the Tool, not at start', async (t) => {
  if (typeof module.enableCompileCache !== 'function' || typeof zlib.crc32 !== 'function') return t.skip('this Node has no compile cache')
  // Same length, so the planted entry can claim the pinned source's size and 32-bit checksum.
  const P = 'process.stdout.write("lib-good")\n', M = 'process.stdout.write("PWNED!!!")\n'
  const root = workerRoot(t, { 'entry.mjs': "import './lib.mjs'\n", 'lib.mjs': M })
  const cache = path.join(root, 'cache')
  fs.writeFileSync(path.join(root, 'enabling.mjs'), "import module from 'node:module'\ndelete process.env.NODE_DISABLE_COMPILE_CACHE\n"
    + `module.enableCompileCache(${JSON.stringify(cache)})\nawait import('./lib.mjs')\n`)
  const { NODE_DISABLE_COMPILE_CACHE: _disabled, NODE_OPTIONS: _options, ...plain } = process.env
  const unbounded = () => execFileSync(process.execPath, [path.join(root, 'entry.mjs')], { env: { ...plain, NODE_COMPILE_CACHE: cache }, encoding: 'utf8' })
  // Without the boundary Node fills the cache while lib.mjs holds M; then lib.mjs gets P and the entry is
  // rewritten to claim P's checksum. A plain Node now runs M's code for P's bytes: the attack is real here.
  unbounded()
  fs.writeFileSync(path.join(root, 'lib.mjs'), P)
  let planted = 0
  for (const name of fs.readdirSync(cache, { recursive: true })) {
    const file = path.join(cache, String(name))
    if (!fs.statSync(file).isFile()) continue
    const bytes = fs.readFileSync(file)
    for (let at = 0; at + 4 <= Math.min(64, bytes.length); at += 4) {
      if (bytes.readUInt32LE(at) === zlib.crc32(Buffer.from(M))) { bytes.writeUInt32LE(zlib.crc32(Buffer.from(P)), at); fs.writeFileSync(file, bytes); planted++ }
    }
  }
  if (planted === 0 || unbounded() !== 'PWNED!!!') return t.skip('a planted entry is not accepted by this Node')

  // 1. The Worker's environment carries NODE_COMPILE_CACHE and the Tool declares no env.pass.
  const before = process.env.NODE_COMPILE_CACHE
  process.env.NODE_COMPILE_CACHE = cache
  try {
    assert.equal((await runTool(root, 'entry.mjs', ['lib.mjs'])).out, 'lib-good', 'a planted compile-cache entry ran under the pin')
  } finally {
    if (before === undefined) delete process.env.NODE_COMPILE_CACHE
    else process.env.NODE_COMPILE_CACHE = before
  }
  // 2. The pinned code turns the cache on itself, after removing the switch that keeps it off.
  assert.equal((await runTool(root, 'enabling.mjs', ['lib.mjs'])).out, 'lib-good', 'a Tool enabled the compile cache under the boundary')
  // 3. A process started with the cache on is not one this Runtime starts; it is refused, not trusted.
  const started = await underBoundary(path.join(root, 'entry.mjs'), pinFiles(runImplementation(
    { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', implementation: ['lib.mjs'] }, root)),
  { adjust: ({ NODE_DISABLE_COMPILE_CACHE: _off, ...env }) => ({ ...env, NODE_COMPILE_CACHE: cache }) })
  assert.doesNotMatch(started.stdout, /PWNED/)
  assert.match(started.stderr, /implementation_boundary: this process was started with a compile cache/)
  // 4. Nor can a Tool ask for these names through env.pass.
  for (const name of ['NODE_COMPILE_CACHE', 'NODE_ICU_DATA', 'node_path', 'OPENSSL_CONF']) {
    assert.throws(() => workerToolsOf(manifestOf({ 'acme.calc@1': { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', env: { pass: [name] } } })),
      new RegExp(`env\\.pass names ${name}`), name)
  }
  assert.doesNotThrow(() => workerToolsOf(manifestOf({ 'acme.calc@1': { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', env: { pass: ['NODE_EXTRA_CA_CERTS'] } } })))
})

test('Worker threads start under the same boundary; source-text and shared-environment threads are refused', async (t) => {
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const root = workerRoot(t, {
    'entry.mjs': [
      "import { Worker, SHARE_ENV } from 'node:worker_threads'",
      "import { writeFileSync } from 'node:fs'",
      "const here = (name) => new URL('./' + name, import.meta.url)",
      "const settle = (worker) => new Promise((done) => { worker.once('error', (e) => done('error: ' + e.message)); worker.once('exit', (code) => done('exit ' + code)) })",
      'const results = {}',
      "const attempt = async (name, start) => { try { results[name] = await start() } catch (e) { results[name] = 'thrown: ' + e.message } }",
      "await attempt('emptyExecArgv', () => settle(new Worker(here('undeclared.mjs'), { execArgv: [] })))",
      "await attempt('sourceText', () => settle(new Worker('process.exit(0)', { eval: true })))",
      "await attempt('sharedEnv', () => settle(new Worker(here('helper.mjs'), { env: SHARE_ENV })))",
      "await attempt('loaderOption', () => settle(new Worker(here('helper.mjs'), { execArgv: ['--import', here('undeclared.mjs').href] })))",
      "await attempt('declared', () => settle(new Worker(here('helper.mjs'), { execArgv: ['--no-warnings'] })))",
      `writeFileSync(here('changed.mjs'), ${JSON.stringify(mark(marks, 'changed'))})`,
      "await attempt('changedAfterVerification', () => settle(new Worker(here('changed.mjs'), { execArgv: [] })))",
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'helper.mjs': mark(marks, 'helper'),
    'changed.mjs': 'export {}\n',
    'undeclared.mjs': mark(marks, 'undeclared'),
  })
  const { out, error } = await runTool(root, 'entry.mjs', ['helper.mjs', 'changed.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  assert.match(results.emptyExecArgv, /^error: implementation_boundary: .*undeclared\.mjs is not declared/)
  assert.match(results.sourceText, /^thrown: implementation_boundary: a Worker thread started from source text/)
  assert.match(results.sharedEnv, /^thrown: implementation_boundary: a Worker thread sharing/)
  assert.match(results.loaderOption, /^thrown: implementation_boundary: A Worker thread passes the Node option --import/)
  assert.equal(results.declared, 'exit 0')
  assert.match(results.changedAfterVerification, /^error: implementation_boundary: .*changed\.mjs is not the verified implementation/)
  assert.equal(marked(marks), 'helper\n', 'a thread ran code outside the pinned implementation')
})

test('Node child processes start under the same boundary; other programs, such as project commands, start as usual', async (t) => {
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const projectCommand = process.platform === 'win32'
    ? "spawnSync('cmd.exe', ['/d', '/c', 'echo project-command'])" : "spawnSync('sh', ['-c', 'echo project-command'])"
  const root = workerRoot(t, {
    'entry.mjs': [
      "import { execFile, execSync, fork, spawn, spawnSync } from 'node:child_process'",
      "import { fileURLToPath } from 'node:url'",
      "const here = (name) => new URL('./' + name, import.meta.url)",
      'const file = (name) => fileURLToPath(here(name))',
      'const NODE = process.execPath',
      'const quote = (text) => String.fromCharCode(34) + text + String.fromCharCode(34)',
      "const settle = (child) => new Promise((done) => { let err = ''; child.stderr?.on('data', (d) => { err += d });"
        + " child.once('error', (e) => done('error: ' + e.message));"
        + " child.once('close', (code) => done('exit ' + code + ' ' + (/implementation_boundary: .*/.exec(err)?.[0] ?? ''))) })",
      'const results = {}',
      "const attempt = async (name, start) => { try { results[name] = await start() } catch (e) { results[name] = 'thrown: ' + e.message } }",
      "await attempt('forkEmptyExecArgv', () => settle(fork(here('undeclared.mjs'), [], { execArgv: [], silent: true })))",
      "await attempt('forkDeclared', () => settle(fork(here('helper.mjs'), [], { silent: true })))",
      "await attempt('forkAnotherNode', () => settle(fork(here('helper.mjs'), [], { execPath: file('elsewhere/node'), silent: true })))",
      "await attempt('spawnSourceText', () => settle(spawn(NODE, ['-e', 'process.exit(0)'])))",
      "await attempt('spawnSyncLoader', () => 'status ' + spawnSync(NODE, ['--require', file('helper.cjs'), file('helper.mjs')]).status)",
      "await attempt('execFileUndeclared', () => settle(execFile(NODE, [file('undeclared.mjs')])))",
      "await attempt('throughShell', () => { execSync(quote(NODE) + ' ' + quote(file('undeclared.mjs'))); return 'ran' })",
      `await attempt('projectCommand', () => String(${projectCommand}.stdout).trim())`,
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'helper.mjs': mark(marks, 'helper'),
    'helper.cjs': `require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'preloaded\\n')\n`,
    'undeclared.mjs': mark(marks, 'undeclared'),
  })
  const { out, error } = await runTool(root, 'entry.mjs', ['helper.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  assert.match(results.forkEmptyExecArgv, /^exit 1 implementation_boundary: .*undeclared\.mjs is not declared/)
  assert.match(results.forkDeclared, /^exit 0/)
  assert.match(results.forkAnotherNode, /^thrown: implementation_boundary: fork with another Node executable/)
  assert.match(results.spawnSourceText, /^thrown: implementation_boundary: A Node child process passes the Node option -e/)
  assert.match(results.spawnSyncLoader, /^thrown: implementation_boundary: A Node child process passes the Node option --require/)
  assert.match(results.execFileUndeclared, /^exit 1 implementation_boundary: .*undeclared\.mjs is not declared/)
  assert.match(results.throughShell, /^thrown: implementation_boundary: a command that starts this Node through a shell/)
  assert.equal(results.projectCommand, 'project-command', 'a program other than this Node was refused')
  assert.equal(marked(marks), 'helper\n', 'a child process ran code outside the pinned implementation')
})

/** Lines every child-starting entry below shares: where it is, how a start ends, and how a result is kept. */
const ENTRY_PRELUDE = [
  "import { dirname } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  "const here = (name) => new URL('./' + name, import.meta.url)",
  'const file = (name) => fileURLToPath(here(name))',
  "const root = dirname(file('entry.mjs'))",
  'const quote = (text) => String.fromCharCode(34) + text + String.fromCharCode(34)',
  "const settle = (child) => new Promise((done) => { let err = ''; child.stderr?.on('data', (d) => { err += d });"
    + " child.once('error', (e) => done('error: ' + e.message));"
    + " child.once('exit', (code) => setTimeout(() => done('exit ' + code + ' ' + (/implementation_boundary: .*/.exec(err)?.[0] ?? '')), 50)) })",
  'const results = {}',
  "const attempt = async (name, start) => { try { results[name] = await start() } catch (e) { results[name] = 'thrown: ' + e.message } }",
]

test('a pinned file replaced after verification never runs outside the boundary: not by a Node by name, not by a command naming it', async (t) => {
  const dir = workerRoot(t, { 'project.mjs': "process.stdout.write('project')\n" })
  const marks = path.join(dir, 'marks')
  const win = process.platform === 'win32'
  const root = workerRoot(t, {
    'entry.mjs': [
      "import { exec, execFileSync, spawn, spawnSync } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      ...ENTRY_PRELUDE,
      // The declared helper is replaced after the Worker verified it: whatever runs it now runs bytes nobody checked.
      `writeFileSync(here('helper.mjs'), ${JSON.stringify(mark(marks, 'replaced helper'))})`,
      "await attempt('nodeByName', () => settle(spawn('node', [file('helper.mjs')])))",
      "await attempt('nodeByNameInItsDirectory', () => settle(spawn('node', ['helper.mjs'], { cwd: root })))",
      "await attempt('nodeByNameSync', () => { try { execFileSync('node', [file('helper.mjs')], { stdio: 'pipe' }); return 'ran' }"
        + " catch (e) { return 'failed ' + (/implementation_boundary: .*/.exec(String(e.stderr))?.[0] ?? e.message) } })",
      "await attempt('shellNamingIt', () => settle(exec('node ' + quote(file('helper.mjs')))))",
      "await attempt('shellNamingItRelative', () => 'status ' + spawnSync('node helper.mjs', { shell: true, cwd: root }).status)",
      `await attempt('otherProgramNamingIt', () => settle(spawn(${win ? "'cmd.exe', ['/d', '/c', 'type', file('helper.mjs')]" : "'sh', ['-c', 'cat ' + quote(file('helper.mjs'))]"})))`,
      "await attempt('thisNodeWithoutExtension', () => settle(spawn(process.execPath.replace(/\\.exe$/i, ''), [file('helper.mjs')])))",
      `await attempt('thisNodeWithoutExtensionSource', () => settle(spawn(process.execPath.replace(/\\.exe$/i, ''), ['-e', ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'source text\\n')`)}])))`,
      // A Node running the project's own script is a project command, and starts as usual.
      `await attempt('projectScript', () => String(spawnSync('node', [${JSON.stringify(path.join(dir, 'project.mjs'))}]).stdout))`,
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'helper.mjs': 'export const helper = true\n',
  })
  const { out, error } = await runTool(root, 'entry.mjs', ['helper.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  const notVerified = /implementation_boundary: .*helper\.mjs is not the verified implementation/
  assert.match(results.nodeByName, /^exit 1 /)
  assert.match(results.nodeByName, notVerified)
  assert.match(results.nodeByNameInItsDirectory, notVerified)
  assert.match(results.nodeByNameSync, /^failed /)
  assert.match(results.nodeByNameSync, notVerified)
  assert.match(results.shellNamingIt, /^thrown: implementation_boundary: a command that names a file of this Tool's pinned implementation/)
  assert.match(results.shellNamingItRelative, /^thrown: implementation_boundary: a command that names a file/)
  assert.match(results.otherProgramNamingIt, /^thrown: implementation_boundary: a command that names a file/)
  assert.match(results.thisNodeWithoutExtension, notVerified)
  assert.match(results.thisNodeWithoutExtensionSource, /^thrown: implementation_boundary: A Node child process passes the Node option -e/)
  assert.equal(results.projectScript, 'project', 'a Node running a project script was held as if it were the pinned implementation')
  assert.equal(marked(marks), '', 'a replaced pinned file or source text ran outside the boundary')
})

/** A program other than Node that only reads or prints its argument, per platform. */
const otherProgram = (argument) => (process.platform === 'win32'
  ? `spawnSync('cmd.exe', ['/d', '/c', 'type', ${argument}])` : `spawnSync('sh', ['-c', 'cat ' + quote(${argument})])`)
const ranStatus = "(r) => 'status ' + r.status + ' ' + (/implementation_boundary: .*/.exec(String(r.stderr))?.[0] ?? String(r.stdout).trim())"

test('an undeclared file in the implementation directories never runs as a child, while project scripts outside them do', async (t) => {
  const project = workerRoot(t, { 'project.mjs': "process.stdout.write('project')\n" })
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const root = workerRoot(t, {
    'adapters/tool/entry.mjs': [
      "import { spawnSync, execSync } from 'node:child_process'",
      ...ENTRY_PRELUDE,
      `const ran = ${ranStatus}`,
      "await attempt('nodeOnUndeclared', () => ran(spawnSync('node', [file('undeclared.mjs')])))",
      "await attempt('nodeOnUndeclaredInItsDirectory', () => ran(spawnSync('node', ['undeclared.mjs'], { cwd: root })))",
      "await attempt('nodeOnUndeclaredDeeper', () => ran(spawnSync('node', [file('vendor/deeper.mjs')])))",
      `await attempt('otherProgramOnUndeclared', () => ran(${otherProgram("file('undeclared.mjs')")}))`,
      "await attempt('shellOnUndeclared', () => execSync('node ' + quote(file('undeclared.mjs'))).toString())",
      // Naming a path in the directories that does not exist names no code: an output file, say.
      `await attempt('notYetWritten', () => ran(${process.platform === 'win32'
        ? "spawnSync('cmd.exe', ['/d', '/c', 'echo', file('not-yet-written.txt')])" : "spawnSync('sh', ['-c', 'echo ' + quote(file('not-yet-written.txt'))])"}))`,
      `await attempt('projectScript', () => ran(spawnSync('node', [${JSON.stringify(path.join(project, 'project.mjs'))}])))`,
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'adapters/tool/helper.mjs': 'export const helper = true\n',
    'adapters/tool/undeclared.mjs': mark(marks, 'undeclared'),
    'adapters/tool/vendor/deeper.mjs': mark(marks, 'deeper'),
  })
  const { out, error } = await runTool(root, 'adapters/tool/entry.mjs', ['adapters/tool/helper.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  // A Node by name on such a file starts under the boundary, which refuses it just as an import of it is refused.
  for (const name of ['nodeOnUndeclared', 'nodeOnUndeclaredInItsDirectory']) {
    assert.match(results[name], /^status 1 implementation_boundary: .*undeclared\.mjs is not declared in this Tool's implementation/, name)
  }
  assert.match(results.nodeOnUndeclaredDeeper, /^status 1 implementation_boundary: .*deeper\.mjs is not declared/)
  const areaRefusal = /^thrown: implementation_boundary: a command that names a file in this Tool's implementation directories that is not declared/
  assert.match(results.otherProgramOnUndeclared, areaRefusal)
  assert.match(results.shellOnUndeclared, areaRefusal)
  assert.match(results.notYetWritten, /^status 0 .*not-yet-written\.txt/)
  assert.equal(results.projectScript, 'status 0 project', 'a project script outside the implementation directories was held')
  assert.equal(marked(marks), '', 'an undeclared implementation file ran as a child')
})

test('a child\'s environment cannot name an implementation file for its program to load, and aliases name the same file', async (t) => {
  const project = workerRoot(t, { 'project.mjs': "process.stdout.write('project')\n" })
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const root = workerRoot(t, { 'adapters/tool/helper.mjs': 'export const helper = true\n', 'adapters/tool/undeclared.cjs': '\n' })
  const helper = path.join(root, 'adapters/tool/helper.mjs')
  // Other names of the declared helper: its long real name (the temporary directory may be an 8.3 alias), its
  // 8.3 short name, and the \\?\ long-path form on Windows; a link elsewhere.
  const aliases = new Set([fs.realpathSync.native(helper)])
  if (process.platform === 'win32') {
    aliases.add(execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${helper}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim())
    aliases.add(String.fromCharCode(92, 92, 63, 92) + fs.realpathSync.native(helper))
  }
  try {
    fs.symlinkSync(helper, path.join(dir, 'link.mjs'), 'file')
    aliases.add(path.join(dir, 'link.mjs'))
  } catch { /* this account cannot create file links */ }
  aliases.delete(helper)
  fs.writeFileSync(path.join(root, 'adapters/tool/entry.mjs'), [
    "import { exec, spawnSync } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    ...ENTRY_PRELUDE,
    `const ran = ${ranStatus}`,
    `const project = ${JSON.stringify(path.join(project, 'project.mjs'))}`,
    `const aliases = ${JSON.stringify([...aliases])}`,
    `writeFileSync(here('helper.mjs'), ${JSON.stringify(mark(marks, 'replaced helper'))})`,
    "await attempt('nodeOptionsImport', () => ran(spawnSync('node', [project], { env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(file('helper.mjs')).href } })))",
    "await attempt('nodeOptionsRequire', () => ran(spawnSync('node', [project], { env: { ...process.env, NODE_OPTIONS: '--require ' + quote(file('undeclared.cjs')) } })))",
    `await attempt('otherProgramEnvironment', () => ran(${process.platform === 'win32'
      ? "spawnSync('cmd.exe', ['/d', '/c', 'echo', 'ok'], { env: { ...process.env, BASH_ENV: file('helper.mjs') } })"
      : "spawnSync('sh', ['-c', 'echo ok'], { env: { ...process.env, BASH_ENV: file('helper.mjs') } })"}))`,
    "await attempt('execEnvironmentUrl', () => new Promise((done) => { try { exec('echo ok', { env: { ...process.env, LOADER: pathToFileURL(file('helper.mjs')).href } }, (e, o) => done('ran ' + String(o).trim())) }"
      + " catch (e) { done('thrown: ' + e.message) } }))",
    "await attempt('projectInEnvironment', () => ran(spawnSync('node', [project], { env: { ...process.env, PROJECT_FILE: project } })))",
    "for (const [at, alias] of aliases.entries()) {",
    "  await attempt('nodeOnAlias' + at, () => ran(spawnSync('node', [alias])))",
    `  await attempt('otherProgramOnAlias' + at, () => ran(${otherProgram('alias')}))`,
    '}',
    'process.stdout.write(JSON.stringify(results))',
  ].join('\n'))
  const { out, error } = await runTool(root, 'adapters/tool/entry.mjs', ['adapters/tool/helper.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  const environmentRefusal = /^thrown: implementation_boundary: the environment of a command names a file of this Tool's implementation/
  for (const name of ['nodeOptionsImport', 'nodeOptionsRequire', 'otherProgramEnvironment', 'execEnvironmentUrl']) {
    assert.match(results[name], environmentRefusal, name)
  }
  assert.equal(results.projectInEnvironment, 'status 0 project', 'an environment naming a project file was refused')
  assert.ok(aliases.size >= 1)
  for (const [at, alias] of [...aliases].entries()) {
    assert.match(results[`nodeOnAlias${at}`], /^status 1 implementation_boundary: /, `${alias} ran outside the boundary`)
    assert.match(results[`otherProgramOnAlias${at}`], /^thrown: implementation_boundary: a command that names a file of this Tool's pinned implementation/, alias)
  }
  assert.equal(marked(marks), '', 'a replaced pinned file ran through a child\'s environment or an alias')
})

test('pinned code cannot reach the original Worker class, the process bindings or process.execve around the boundary', async (t) => {
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const evaluated = `require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'evaluated thread\\n')`
  const root = workerRoot(t, {
    'entry.mjs': [
      "import { Worker } from 'node:worker_threads'",
      ...ENTRY_PRELUDE,
      `const code = ${JSON.stringify(evaluated)}`,
      "const settleThread = (worker) => new Promise((done) => { worker.once('error', (e) => done('error: ' + e.message)); worker.once('exit', (c) => done('exit ' + c)) })",
      "await attempt('prototypeOfWorker', () => { const W = Object.getPrototypeOf(Worker); return settleThread(new W(code, { eval: true })) })",
      "await attempt('constructorOnPrototype', () => settleThread(new Worker.prototype.constructor(code, { eval: true })))",
      "await attempt('constructorOfInstance', async () => { const w = new Worker(here('benign.mjs')); const ended = await settleThread(w);"
        + " let next; try { next = await settleThread(new w.constructor(code, { eval: true })) } catch (e) { next = 'thrown: ' + e.message }"
        + " return ended + ' ' + (w instanceof Worker) + ' ' + next })",
      "await attempt('subclass', () => { class Mine extends Worker {} return settleThread(new Mine(code, { eval: true })) })",
      "await attempt('spawnSyncBinding', () => typeof process.binding('spawn_sync').spawn)",
      "await attempt('processWrapBinding', () => typeof process.binding('process_wrap').Process)",
      "await attempt('execve', () => { process.execve(process.execPath, [process.execPath, file('benign.mjs')]); return 'replaced' })",
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'benign.mjs': 'export {}\n',
  })
  const { out, error } = await runTool(root, 'entry.mjs', ['benign.mjs'])
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  assert.match(results.prototypeOfWorker, /^thrown: .*not a constructor/, 'the original Worker class was reachable as the prototype')
  assert.match(results.constructorOnPrototype, /^thrown: implementation_boundary: a Worker thread started from source text/)
  assert.match(results.constructorOfInstance, /^exit 0 true thrown: implementation_boundary: a Worker thread started from source text/)
  assert.match(results.subclass, /^thrown: implementation_boundary: a Worker thread started from source text/)
  assert.match(results.spawnSyncBinding, /^thrown: implementation_boundary: process\.binding\('spawn_sync'\)/)
  assert.match(results.processWrapBinding, /^thrown: implementation_boundary: process\.binding\('process_wrap'\)/)
  assert.match(results.execve, /^thrown: implementation_boundary: process\.execve/)
  assert.equal(marked(marks), '', 'source text ran in a thread outside the boundary')
})

test('a Tool cannot add module hooks or reach CommonJS through Module#load and #_compile, in either hooks variant', async (t) => {
  const dir = workerRoot(t, {})
  const marks = path.join(dir, 'marks')
  const root = workerRoot(t, {
    'entry.mjs': [
      "import module from 'node:module'",
      "import { fileURLToPath } from 'node:url'",
      'const results = {}',
      'for (const [name, run] of [',
      "  ['registerHooks', () => module.registerHooks({})],",
      "  ['register', () => module.register('data:text/javascript,export%20{}')],",
      "  ['moduleLoad', () => new module.Module('x').load(fileURLToPath(new URL('./x.js', import.meta.url)))],",
      `  ['moduleCompile', () => new module.Module('y')._compile(${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'compiled\\n')`)}, 'y.js')],`,
      ']) { try { run(); results[name] = \'ran\' } catch (e) { results[name] = e.message } }',
      "results.hooks = globalThis[Symbol.for('rulith.implementationBoundary')]?.hooks",
      'process.stdout.write(JSON.stringify(results))',
    ].join('\n'),
    'x.js': `require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'loaded\\n')\n`,
  })
  const { out, error } = await runTool(root, 'entry.mjs')
  assert.equal(error, undefined, error)
  const results = JSON.parse(out)
  for (const name of ['registerHooks', 'register']) assert.match(results[name], /^implementation_boundary: a Tool cannot install module hooks/, name)
  assert.match(results.moduleLoad, /^implementation_boundary: .*x\.js would load as CommonJS/)
  assert.match(results.moduleCompile, /^implementation_boundary: .*would compile as CommonJS/)
  assert.equal(results.hooks, HOOKS, 'the boundary held this Tool with other hooks than this run asked for')
  assert.equal(marked(marks), '', 'CommonJS code ran under the boundary')
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
    assert.equal((await runTool(root, 'entry.mjs')).out, 'ok')
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = before
  }
  assert.equal(marked(preloaded), '', 'NODE_OPTIONS preloaded code into a run Tool')
  assert.throws(() => workerToolsOf(manifestOf({ 'acme.calc@1': { adapter: 'run', sourceTypes: [], entry: 'entry.mjs', env: { pass: ['NODE_OPTIONS'] } } })),
    /NODE_OPTIONS/)
})

/** Install the general kit with the real installer into a fresh Agent, as `rulith kit install general` does. */
function installedKit(t) {
  const dir = workerRoot(t, {})
  const manager = path.join(dir, 'manager'), agent = path.join(dir, 'agent'), worker = path.join(dir, 'worker'), home = path.join(dir, 'kit-home')
  for (const directory of [manager, agent, worker, path.join(home, 'specs')]) fs.mkdirSync(directory, { recursive: true })
  const toolsFile = path.join(worker, 'worker-tools.json')
  fs.writeFileSync(path.join(manager, 'registry.json'), JSON.stringify({ instances: [{ mode: 'local_agent', agentName: 'Fixture', directory: agent }] }))
  fs.writeFileSync(path.join(agent, 'local.json'), JSON.stringify({ worker: { env: { RULITH_WORKER_ROOT: worker, RULITH_TOOLS_FILE: toolsFile } } }))
  assert.match(installGeneral(parseKitInstall(['--agent', 'Fixture', '--kit-home', home, '--manager-home', manager])), /Installed 29/)
  return { worker, tools: JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools }
}

test('the real installer lays down exactly the declared kit files, and every installed kit Tool pins cleanly', (t) => {
  const { worker, tools } = installedKit(t)
  const installedDir = path.join(worker, KIT_PREFIX)
  const installed = fs.readdirSync(installedDir).map((name) => KIT_PREFIX + name).sort()
  const declared = [...new Set(Object.values(tools).flatMap((tool) => [tool.entry, ...tool.implementation]))].sort()
  assert.deepEqual(installed, declared, 'the installer and the declarations disagree about what the kit is')
  const source = (name) => fs.readFileSync(path.join(worker, name), 'utf8')
  // What an entry can load: its static import closure inside the kit, plus the supervisor it starts.
  const closure = (name, seen = new Set()) => {
    if (seen.has(name)) return seen
    seen.add(name)
    for (const [, relative] of source(name).matchAll(/from '\.\/([^']+\.mjs)'/g)) closure(KIT_PREFIX + relative, seen)
    return seen
  }
  const refused = []
  const pinned = withImplementationPins(workerToolsOf(manifestOf(tools)), worker, (id, error) => refused.push(`${id}: ${error.message}`))
  assert.deepEqual(refused, [])
  for (const [id, tool] of Object.entries(tools)) {
    for (const name of [...closure(tool.entry), KIT_PREFIX + 'supervisor.mjs']) {
      assert.ok(name === tool.entry || tool.implementation.includes(name), `${id} can load ${name}, which it does not declare`)
    }
    const files = Object.fromEntries([tool.entry, ...tool.implementation].map((name) => [name, sha256(fs.readFileSync(path.join(worker, name)))]))
    assert.equal(pinned[id].digest, independentPin(tool, files), `${id}: the installed pin is not a function of the installed files`)
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
  const files = Object.fromEntries([KIT.tools[id].entry, ...KIT.tools[id].implementation].map((name) => [name, sha256(KIT_SOURCES[name])]))
  assert.equal(advertised.digest, independentPin(KIT.tools[id], files), 'the Worker advertised a pin other than its implementation bytes')
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
  const start = () => {
    const pin = pinFiles(runImplementation(KIT.tools['eng.job_start@1'], root))
    // Started as the Worker starts it; job_start then starts the supervisor with a plain spawn of this Node.
    return () => new Promise((done) => execFile(process.execPath,
      [...boundaryArgv(BOUNDARY), path.join(root, KIT_PREFIX + 'job_start.mjs'), JSON.stringify({ command: ['node', 'job.mjs'], cwd: '.' })],
      { env: boundaryEnv({ ...process.env, ...env }, pinText(pin), process.env[IMPLEMENTATION_HOOKS_ENV]) },
      // A kit refusal writes `{rows: [], verdict}` and exits 2; either way the receipt is stdout.
      (error, stdout, stderr) => done(stdout ? JSON.parse(stdout) : { verdict: String(stderr || error?.message) })))
  }
  // Replaced after the Worker verified the implementation, before the adapter starts the supervisor.
  const replaced = start()
  fs.appendFileSync(path.join(root, KIT_PREFIX + 'supervisor.mjs'), '\n// replaced\n')
  const refused = await replaced()
  assert.equal(refused.verdict, 'job unavailable', JSON.stringify(refused))
  assert.equal(fs.existsSync(path.join(project, 'job-output')), false, 'a replaced supervisor ran the job')

  // With the verified supervisor the job runs, in a fresh kit home (the refused one stays recorded as starting).
  fs.writeFileSync(path.join(root, KIT_PREFIX + 'supervisor.mjs'), KIT_SOURCES[KIT_PREFIX + 'supervisor.mjs'])
  const freshHome = path.join(path.dirname(home), 'kit-home-2')
  fs.mkdirSync(path.join(freshHome, 'specs'), { recursive: true })
  env.ENG_KIT_HOME = freshHome
  const started = await start()()
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

test('the whole suite holds under the module.register hooks too (the Node 20.6–22.14 path)', {
  skip: process.env[IMPLEMENTATION_HOOKS_ENV] === 'register' ? 'this is that run' : false,
}, async () => {
  // Every arm above runs again with the boundary on module.register; the hooks arm checks it really was.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  const run = await new Promise((done) => execFile(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(import.meta.url)],
    { env: { ...env, [IMPLEMENTATION_HOOKS_ENV]: 'register' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
    (error, stdout) => done(String(stdout))))
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(run)?.[1])
  assert.equal(count('fail'), 0, run.slice(-6000))
  assert.ok(count('pass') >= 14, `only ${count('pass')} arms passed under module.register:\n${run.slice(-3000)}`)
})
