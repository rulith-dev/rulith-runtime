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
 *      没有脚本文件的 Node 进程，以及经 shell 或其他程序启动这个 Node、或点名 pin 里文件的命令，
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
import { realpathSync } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
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
const fullNodePaths = [...new Set([process.execPath, (() => { try { return realpathSync(process.execPath) } catch { return process.execPath } })()])]
/** This Node by path: its executable (and real path), with or without the `.exe` a Windows start may leave out. */
const nodePaths = new Set(fullNodePaths.flatMap((path) => [path, path.replace(/\.exe$/i, '')]).map(comparable))
const isThisNode = (file) => typeof file === 'string' && nodePaths.has(comparable(file))
/** A Node by name: `node` through PATH, or another Node binary. It may run a project script; see namesPinnedFile. */
const NODE_NAMES = new Set(['node', 'node.exe', 'nodejs'])
const isNodeByName = (file) => typeof file === 'string'
  && NODE_NAMES.has(process.platform === 'win32' ? basename(file).toLowerCase() : basename(file))
/** The words of an argument or a command line, quotes removed: enough to see which files a command names. */
const words = (value) => (String(value).match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ''))
const pinnedPaths = Object.keys(files)
/**
 * Whether a start names a file of this pinned implementation: an absolute pinned path anywhere in an
 * argument or command line, or a word (also the value of a `--option=value`, or a file: URL) that resolves
 * against the start's working directory to a pinned path. Such a start would run pinned code outside the
 * boundary, under bytes nobody checked; a Node gets the boundary, any other program is refused.
 */
function namesPinnedFile(values, cwd) {
  const base = cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    const text = comparable(value)
    if (pinnedPaths.some((path) => text.includes(path))) return true
    for (const word of words(value)) {
      for (const candidate of new Set([word, word.replace(/^-{1,2}[^=\s]+=/, '')])) {
        try {
          const file = /^file:/i.test(candidate) ? fileURLToPath(candidate) : candidate
          if (files[implementationPinKey(resolvePath(base, file))] !== undefined) return true
        } catch { /* not a path */ }
      }
    }
  }
  return false
}
const mentionsThisNode = (values) => values.some((value) => typeof value === 'string'
  && (fullNodePaths.some((path) => comparable(value).includes(comparable(path))) || words(value).some((word) => isThisNode(word))))
/** A Node gets the boundary when it is this Node, or a Node by name started on a pinned file. */
const heldNode = (file, args, cwd) => isThisNode(file) || (isNodeByName(file) && namesPinnedFile(args, cwd))
/** Any other start may not reach this Node or a pinned file around the boundary. */
function refuseUnheld(values, cwd) {
  if (mentionsThisNode(values)) {
    refuse('a command that starts this Node through a shell or another program would run code outside this Tool\'s pinned'
      + ' implementation, so it was not started. Start it with fork, or spawn process.execPath with a script file.')
  }
  if (namesPinnedFile(values, cwd)) {
    refuse('a command that names a file of this Tool\'s pinned implementation would run it outside the implementation boundary,'
      + ' so it was not started. Start it with fork, or spawn process.execPath with the script file.')
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
      refuseUnheld(args, options.cwd)
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
      refuseUnheld([file, ...list], settings.cwd)
      return start.apply(this, arguments)
    }
    if (heldNode(file, list, settings?.cwd)) {
      return start.call(this, file, boundedNodeArgs(list, BOUNDARY, { script: true, label: 'A Node child process' }),
        { ...settings, env: boundaryEnv(settings?.env ?? process.env, text, hooksVariant) })
    }
    refuseUnheld(list, settings?.cwd)
    return start.apply(this, arguments)
  }
}
const execSync = childProcess.execSync
childProcess.execSync = function execSyncWithinImplementationBoundary(command, options) {
  refuseUnheld([command], options?.cwd)
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
