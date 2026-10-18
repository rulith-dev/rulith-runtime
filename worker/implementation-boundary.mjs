// SPDX-License-Identifier: Apache-2.0
/**
 * `node --preserve-symlinks --preserve-symlinks-main --import <this file> <entry> <args>`：
 * Worker 启动 run Tool 时，子进程里第一段执行的代码（SYS-TOOL-01“Worker 只执行已核验的同一份实现字节”）。
 *
 * 它在 Tool 的任何代码之前做四件事：
 *
 *   1. 读 Worker 交来的 pin 名单（声明路径 → SHA-256）。没有名单就拒绝启动：没有名单的进程
 *      不知道哪份字节是被 pin 的，只能什么都不装。
 *   2. 关掉 ES 模块钩子管不到的装载路：CommonJS（require、createRequire、Module#load、Module#_compile）、
 *      原生扩展与编译缓存——缓存条目只靠 32 位校验和对上源码，换一份字节同样能通过
 *      （Worker 也从不把 NODE_COMPILE_CACHE 交给 Tool，并设 NODE_DISABLE_COMPILE_CACHE）。
 *   3. 注册装载钩子（implementation-hooks.mjs），然后让 Tool 再也注册不了自己的钩子：
 *      后注册的钩子先运行，会排在边界前面。
 *   4. 线程和子 Node 进程带着同一道边界启动：Worker 线程、fork，以及 spawn／exec* 这个 Node
 *      （process.execPath，带不带 .exe），或按名字（node／node.exe）启动、却点名了 pin 里某个文件的 Node，
 *      都被加上边界选项与这份名单；从源码文本起的线程、共享环境的线程、会装载代码的 Node 选项、
 *      没有脚本文件的 Node 进程，以及经 shell 或其他程序启动这个 Node、或（以参数、命令行或环境变量值，
 *      按任何别名）点名 pin 里文件或实现目录里其他文件的命令，
 *      都在启动前拒绝；它们底下的 process.binding('spawn_sync'／'process_wrap') 与 process.execve 也拒绝。
 *      别的程序（kit 运行的项目命令，如 npm test、python、node 跑项目自己的脚本）照常启动：
 *      运行项目命令是产品用途本身，由所有者“打开项目”的确认授权。
 *
 * NODE_OPTIONS 里的 --require/--import 会先于本文件执行，所以 Worker 从不把 NODE_OPTIONS 交给
 * run Tool。本文件属于 Runtime 自己的发布字节，和 Worker 本身同一个信任基础。
 */
import module from 'node:module'
import childProcess from 'node:child_process'
import workerThreads from 'node:worker_threads'
import { realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IMPLEMENTATION_HOOKS_ENV, IMPLEMENTATION_PIN_ENV, ImplementationBoundaryError, boundaryArgv, boundaryEnv,
  boundedNodeArgs, implementationHooks, implementationPinKey, isLoaderEnvName, readImplementationPin,
} from './implementation-hooks.mjs'

const text = process.env[IMPLEMENTATION_PIN_ENV]
const files = readImplementationPin(text)
const hooksVariant = process.env[IMPLEMENTATION_HOOKS_ENV] === 'register' ? 'register' : undefined
const BOUNDARY = Object.freeze(boundaryArgv(import.meta.url))
const refuse = (message) => { throw new ImplementationBoundaryError(message) }

// ── 1. CommonJS, native addons and the compile cache ─────────────────────────
const loadCommonJs = module._load
module._load = function loadWithinImplementationBoundary(request, ...rest) {
  if (typeof request === 'string' && module.isBuiltin(request)) return loadCommonJs.call(this, request, ...rest)
  return refuse(`require(${JSON.stringify(String(request))}) would load CommonJS code, which is outside this Tool's pinned`
    + ' implementation, so it was not loaded. Only the declared .mjs files load, through import.')
}
module.prototype.load = function loadNothing(filename) {
  refuse(`${String(filename)} would load as CommonJS, which is outside this Tool's pinned implementation, so it was not loaded.`)
}
module.prototype._compile = function compileNothing(_content, filename) {
  refuse(`${String(filename)} would compile as CommonJS, which is outside this Tool's pinned implementation, so it was not run.`)
}
process.dlopen = () => refuse('a native addon is outside this Tool\'s pinned implementation, so it was not loaded.')
// A process started with a compile cache already on (NODE_COMPILE_CACHE) is not started by this
// Runtime: the Worker and the boundary never pass it. It is refused rather than trusted.
if (typeof module.getCompileCacheDir === 'function' && module.getCompileCacheDir()) {
  refuse('this process was started with a compile cache, whose entries are not the verified bytes; no local code may load.')
}
if (typeof module.enableCompileCache === 'function') {
  const disabled = module.constants?.compileCacheStatus?.DISABLED
  module.enableCompileCache = () => ({ status: disabled,
    message: 'implementation_boundary: the compile cache stays off for a pinned run Tool; a cached entry is not its verified bytes.' })
}

// ── 2. The loader hooks, and nobody else's ───────────────────────────────────
const useRegisterHooks = typeof module.registerHooks === 'function' && hooksVariant !== 'register'
if (useRegisterHooks) module.registerHooks(implementationHooks(files))
else if (typeof module.register === 'function') module.register('./implementation-hooks.mjs', import.meta.url, { data: text })
else refuse(`Node ${process.version} has no module hooks, so the pinned implementation cannot be held.`)
const noHooks = () => refuse('a Tool cannot install module hooks: they would run ahead of the implementation boundary.')
module.register = noHooks
module.registerHooks = noHooks

// ── 3. Threads and Node children start under the same boundary ──────────────
const comparable = (value) => (process.platform === 'win32' ? String(value).toLowerCase().replaceAll('/', '\\') : String(value))
/** The long, real name of an existing path (8.3 aliases, `\\?\` prefixes and links resolved), or undefined. */
const nativeReal = (path) => { try { return realpathSync.native(path) } catch { return undefined } }
const fullNodePaths = [...new Set([process.execPath, nativeReal(process.execPath) ?? process.execPath])]
/** This Node by path: its executable (and real path), with or without the `.exe` a Windows start may leave out. */
const nodePaths = new Set(fullNodePaths.flatMap((path) => [path, path.replace(/\.exe$/i, '')]).map(comparable))
const nodeReal = implementationPinKey(nativeReal(process.execPath) ?? process.execPath)
const isThisNode = (file) => typeof file === 'string' && (nodePaths.has(comparable(file))
  || (/[\\/]/.test(file) && implementationPinKey(nativeReal(file) ?? file) === nodeReal))
/** A Node by name: `node` through PATH, or another Node binary. It may run a project script; see namedImplementation. */
const NODE_NAMES = new Set(['node', 'node.exe', 'nodejs'])
const isNodeByName = (file) => typeof file === 'string'
  && NODE_NAMES.has(process.platform === 'win32' ? basename(file).toLowerCase() : basename(file))
/** The words of an argument or a command line, quotes removed: enough to see which files a command names. */
const words = (value) => (String(value).match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ''))

/**
 * The implementation area: the pinned files and every directory (with its subdirectories) that holds one,
 * by the declared name and by the long, real name. A project Source lies outside it.
 */
const pinnedPaths = Object.keys(files)
const pinnedReal = new Set(pinnedPaths.map((path) => implementationPinKey(nativeReal(path) ?? path)))
const areaDirs = [...new Set(pinnedPaths.flatMap((path) => [dirname(path), nativeReal(dirname(path)) ?? dirname(path)])
  .map((dir) => implementationPinKey(dir)))]
const insideArea = (key) => areaDirs.some((dir) => key.startsWith(dir.endsWith(sep) ? dir : dir + sep))
/** What an existing path is to this implementation: 'pinned', another file of the area ('area'), or undefined. */
function implementationFile(path) {
  const real = nativeReal(path)
  if (real === undefined) return undefined
  const key = implementationPinKey(real)
  if (pinnedReal.has(key)) return 'pinned'
  if (!insideArea(key)) return undefined
  try { return statSync(real).isFile() ? 'area' : undefined } catch { return undefined }
}
const decoded = (text) => { try { return decodeURIComponent(text) } catch { return text } }
/** The pinned files as text, declared and real, in the form `comparable` gives a command line. */
const pinnedNames = [...new Set(pinnedPaths.flatMap((path) => [path, nativeReal(path) ?? path]).map(comparable))]
/**
 * A command line as cmd.exe receives it from a shell start: Node wraps it in one more pair of quotes
 * (`/d /s /c "node "C:\a b\x.mjs""`). Without that pair its own quoting, and so a path with a space, reads again.
 */
const unwrapped = (value) => (value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)
/**
 * The implementation file written out from `at` onwards, if there is one. A path may hold spaces, so the
 * text runs to the next quote or separator, and the longest stretch of it ending before a space (or at
 * its end) that is an existing file is the one named.
 */
function pathAt(text, at) {
  const run = /^[^"'`()<>|;,\r\n]*/.exec(text.slice(at))[0]
  const ends = [run.length, ...[...run.matchAll(/\s/g)].map((space) => space.index).reverse()]
  for (const end of ends) {
    const kind = implementationFile(run.slice(0, end).trimEnd())
    if (kind !== undefined) return kind
  }
  return undefined
}
/**
 * Which implementation file, if any, a start names: 'pinned' before 'area'. A name is a pinned path written
 * anywhere in an argument, a command line or an environment value (declared or real, any case on Windows);
 * a word of one (also unwrapped from cmd.exe's extra quotes, the value of a `--option=value`, a file: URL,
 * and — in the environment — each entry of a path list), resolved against the start's working directory;
 * or a path of the area written anywhere in the text, spaces included.
 * Every name is compared by its long, real name, so aliases of the same file are the same file.
 */
function namedImplementation(values, cwd, { environment = false } = {}) {
  const base = cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  let found
  const note = (kind) => { if (kind === 'pinned' || (kind === 'area' && found === undefined)) found = kind }
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    const texts = new Set([comparable(value), comparable(decoded(value))])
    for (const text of texts) if (pinnedNames.some((name) => text.includes(name))) return 'pinned'
    const lines = [...new Set([value, unwrapped(value)])]
    const pieces = environment ? lines.flatMap((line) => [line, ...line.split(delimiter)]) : lines
    const candidates = new Set(pieces.flatMap((piece) => [piece, ...words(piece)])
      .flatMap((word) => [word, word.replace(/^-{1,2}[^=\s]+=/, '')]))
    for (const candidate of candidates) {
      try { note(implementationFile(resolvePath(base, /^file:/i.test(candidate) ? fileURLToPath(candidate) : candidate))) } catch { /* not a path */ }
      if (found === 'pinned') return found
    }
    for (const text of texts) {
      for (const dir of areaDirs) {
        for (let at = text.indexOf(dir); at !== -1; at = text.indexOf(dir, at + 1)) note(pathAt(text, at))
      }
    }
    if (found === 'pinned') return found
  }
  return found
}
const mentionsThisNode = (values) => values.some((value) => typeof value === 'string'
  && (fullNodePaths.some((path) => comparable(value).includes(comparable(path)))
    || [value, unwrapped(value)].some((line) => words(line).some((word) => isThisNode(word)))))
/** A Node gets the boundary when it is this Node, or a Node by name started on an implementation file. */
const heldNode = (file, args, cwd) => isThisNode(file) || (isNodeByName(file) && namedImplementation(args, cwd) !== undefined)
/** The values of an environment a start passes, but this boundary's own two. */
const environmentValues = (env) => Object.entries(env ?? {})
  .filter(([name]) => ![IMPLEMENTATION_PIN_ENV, IMPLEMENTATION_HOOKS_ENV].includes(name.toUpperCase()))
  .map(([, value]) => String(value ?? ''))
/** Any other start may not reach this Node or an implementation file around the boundary, by argument or by environment. */
function refuseUnheld(values, cwd, environment) {
  if (mentionsThisNode(values)) {
    refuse('a command that starts this Node through a shell or another program would run code outside this Tool\'s pinned'
      + ' implementation, so it was not started. Start it with fork, or spawn process.execPath with a script file.')
  }
  const named = namedImplementation(values, cwd)
  if (named === 'pinned') {
    refuse('a command that names a file of this Tool\'s pinned implementation would run it outside the implementation boundary,'
      + ' so it was not started. Start it with fork, or spawn process.execPath with the script file.')
  }
  if (named === 'area') {
    refuse('a command that names a file in this Tool\'s implementation directories that is not declared would run it outside the'
      + ' implementation boundary, so it was not started. Declare it in the Tool\'s "implementation" list, or keep it out of those directories.')
  }
  if (environment !== undefined && namedImplementation(environment, cwd, { environment: true }) !== undefined) {
    refuse('the environment of a command names a file of this Tool\'s implementation (for example NODE_OPTIONS=--import=…),'
      + ' which would run it outside the implementation boundary, so it was not started.')
  }
}

// The original class is never reachable from the replacement: not as its prototype, not as a constructor.
const BaseWorker = workerThreads.Worker
function Worker(filename, options = {}) {
  if (new.target === undefined) throw new TypeError('Class constructor Worker cannot be invoked without \'new\'')
  if (options?.eval) refuse('a Worker thread started from source text runs code that is not a pinned file, so it was not started.')
  if (options?.env === workerThreads.SHARE_ENV) {
    refuse('a Worker thread sharing this process\'s environment could be handed another implementation list, so it was not started.')
  }
  return Reflect.construct(BaseWorker, [filename, {
    ...options,
    execArgv: boundedNodeArgs(options?.execArgv ?? [], BOUNDARY, { script: false, label: 'A Worker thread' }),
    env: boundaryEnv(options?.env ?? process.env, text, hooksVariant),
  }], new.target)
}
Worker.prototype = BaseWorker.prototype
Object.defineProperty(BaseWorker.prototype, 'constructor', { value: Worker, writable: true, configurable: true })
workerThreads.Worker = Worker

/**
 * `KEY=value` pairs of a Node child: the same rule as boundaryEnv, on the form spawn hands to libuv.
 * fork and cluster set their own IPC names here (the channel, its serialization, a cluster member's id);
 * they carry no code, and without them a forked child would lose its channel or a cluster member would
 * take itself for the primary and fork again.
 */
const IPC_NAMES = Object.freeze(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'])
function boundedPairs(pairs) {
  const kept = (Array.isArray(pairs) ? pairs : []).filter((pair) => {
    const name = String(pair).slice(0, Math.max(String(pair).indexOf('=', 1), 0)).toUpperCase()
    if (IPC_NAMES.includes(name)) return true
    return !(isLoaderEnvName(name) || name === IMPLEMENTATION_PIN_ENV || name === IMPLEMENTATION_HOOKS_ENV)
  })
  return [...kept, `${IMPLEMENTATION_PIN_ENV}=${text}`, 'NODE_DISABLE_COMPILE_CACHE=1',
    ...(hooksVariant ? [`${IMPLEMENTATION_HOOKS_ENV}=${hooksVariant}`] : [])]
}

// Every asynchronous start (spawn, fork, exec, execFile) reaches ChildProcess#spawn with the final file,
// argv (argv0 first), working directory and environment pairs: one place to hold them all.
const { ChildProcess } = childProcess
const spawnChild = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function spawnWithinImplementationBoundary(options) {
  if (options && typeof options === 'object') {
    const [argv0, ...args] = Array.isArray(options.args) ? options.args : []
    if (heldNode(options.file, args, options.cwd)) {
      options.args = [argv0 ?? options.file, ...boundedNodeArgs(args, BOUNDARY, { script: true, label: 'A Node child process' })]
      options.envPairs = boundedPairs(options.envPairs)
    } else {
      const pairs = Array.isArray(options.envPairs) ? options.envPairs.map(String) : []
      refuseUnheld(args, options.cwd, environmentValues(Object.fromEntries(pairs.map((pair) => {
        const at = pair.indexOf('=', 1)
        return at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)]
      }))))
    }
  }
  return spawnChild.call(this, options)
}
const fork = childProcess.fork
childProcess.fork = function forkWithinImplementationBoundary(modulePath, args, options) {
  const settings = Array.isArray(args) ? options : args
  if (settings?.execPath !== undefined && !isThisNode(settings.execPath)) {
    refuse('fork with another Node executable would run outside this Tool\'s pinned implementation, so it was not started.')
  }
  return fork.apply(this, arguments)
}
// The synchronous starts reach libuv without ChildProcess, so each is held at its own entry.
for (const name of ['spawnSync', 'execFileSync']) {
  const start = childProcess[name]
  childProcess[name] = function startWithinImplementationBoundary(file, args, options) {
    const list = Array.isArray(args) ? args : []
    const settings = Array.isArray(args) ? options : args
    if (settings?.shell) {
      refuseUnheld([file, ...list], settings.cwd, environmentValues(settings.env ?? process.env))
      return start.apply(this, arguments)
    }
    if (heldNode(file, list, settings?.cwd)) {
      return start.call(this, file, boundedNodeArgs(list, BOUNDARY, { script: true, label: 'A Node child process' }),
        { ...settings, env: boundaryEnv(settings?.env ?? process.env, text, hooksVariant) })
    }
    refuseUnheld(list, settings?.cwd, environmentValues(settings?.env ?? process.env))
    return start.apply(this, arguments)
  }
}
const execSync = childProcess.execSync
childProcess.execSync = function execSyncWithinImplementationBoundary(command, options) {
  refuseUnheld([command], options?.cwd, environmentValues(options?.env ?? process.env))
  return execSync.apply(this, arguments)
}
// `import { spawn } from 'node:child_process'` and friends read the replaced functions.
module.syncBuiltinESMExports()

// Below child_process: the bindings it is built on, and replacing this process outright.
const binding = process.binding
const STARTING_BINDINGS = new Set(['spawn_sync', 'process_wrap'])
const refuseBinding = (name) => refuse(`process.binding('${String(name)}') would start a process outside the implementation boundary, so it was not given.`)
process.binding = function bindingWithinImplementationBoundary(name) {
  if (STARTING_BINDINGS.has(String(name))) refuseBinding(name)
  return binding.apply(this, arguments)
}
if (typeof process._linkedBinding === 'function') {
  const linkedBinding = process._linkedBinding
  process._linkedBinding = function linkedBindingWithinImplementationBoundary(name) {
    if (STARTING_BINDINGS.has(String(name))) refuseBinding(name)
    return linkedBinding.apply(this, arguments)
  }
}
process.execve = () => refuse('process.execve would replace this process outside the implementation boundary, so it was not run.')

/** Which hooks hold this process: read by tests that run the boundary in both variants. */
Object.defineProperty(globalThis, Symbol.for('rulith.implementationBoundary'), {
  value: Object.freeze({ hooks: useRegisterHooks ? 'registerHooks' : 'register' }),
})
