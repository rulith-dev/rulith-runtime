// SPDX-License-Identifier: Apache-2.0
/**
 * 实现边界的装载钩子与共用规则（PSC SYS-TOOL-01、ACC-TOOL-09；0.2.24 在官方编程能力的工具上落实）。
 *
 * 一个 `run` Tool 的 pin 覆盖它的实现字节：入口文件和它声明的实现文件（`implementation`），
 * 每个文件的 SHA-256 都进 Tool digest。Worker 在领取前、启动前各核验一次磁盘上的字节；
 * 但只核验磁盘还不够——“检查旧文件、执行新文件”正是合同点名禁止的那一种。所以子进程里
 * 每一次装载代码都在这里再核验一次，而且执行的就是被核验的那一份内存字节：
 *
 *   · resolve：经 package.json 解析的说明符（包名、`#` 开头的 imports 映射）直接拒绝——那份映射不在
 *     pin 里，它能决定哪个文件被装载；解析出的地址不是 `node:` 内置、也不是 pin 名单上的文件，也拒绝。
 *     遗漏的依赖不是“已声明部分已核验”，而是实现边界不成立（Worker 细则 §1）。
 *   · load：读文件一次、算一次摘要、与 pin 比对，相同才把**这一份字节**交给 Node 编译。
 *     核验和使用是同一个 Buffer，中间没有第二次读盘，所以没有窗口可换文件。
 *
 * 名单按声明路径记（不解析链接），子进程以 --preserve-symlinks / --preserve-symlinks-main 启动：
 * 核验之后把目录换成链接，装载地址仍是声明的那个路径，读到的字节与 pin 不符就拒绝，
 * 而不是顺着链接去装另一个也被 pin 过的文件。
 *
 * 静态 import 图在任何模块求值之前整体装载，所以静态依赖的任何变化都在副作用之前被拒绝；
 * 运行中才动态 import 的文件，在它执行之前被拒绝（之前已经发生的效果如实保留，不伪造零副作用）。
 *
 * 只认 ES 模块（`.mjs`）：它的格式由扩展名决定，不受旁边 package.json 的 `type` 影响。
 * CommonJS、原生扩展、编译缓存、别人的装载钩子，以及线程和子 Node 进程，由
 * implementation-boundary.mjs 处理：钩子只管当前线程的 import，那些路要么拒绝，要么带着同一道边界启动。
 *
 * 这不是沙箱，也不是对机器的认证：它只保证这个进程装载的本地实现代码就是操作员 pin 的那一份字节。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Worker 交给子进程的 pin 名单所在的环境变量；kit 的工具不会把它传给自己运行的项目命令（RULITH_ 前缀被剥掉）。 */
export const IMPLEMENTATION_PIN_ENV = 'RULITH_IMPLEMENTATION_PIN'
export const IMPLEMENTATION_PIN_FORMAT = 'rulith-implementation-pin/1'
/**
 * `register` 让边界改用 `module.register` 的异步钩子——没有 registerHooks 的 Node 20.6–22.14 用的那一套。
 * 同一道边界、同样执法，只用于在新版 Node 上验证那条路（测试与诊断）；Worker 只把这个值原样传下去。
 */
export const IMPLEMENTATION_HOOKS_ENV = 'RULITH_IMPLEMENTATION_HOOKS'
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * 名单的键：声明路径（绝对，不解析链接）。Windows 的文件系统不分大小写，所以那里统一成小写比较；
 * 这只决定“查哪一个期望摘要”，摘要本身仍按读到的字节算。
 */
export function implementationPinKey(path) {
  const absolute = resolvePath(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export class ImplementationBoundaryError extends Error {
  constructor(message) {
    super(`implementation_boundary: ${message}`)
    this.code = 'RULITH_IMPLEMENTATION_BOUNDARY'
  }
}

/** The Node options that start a process or thread under the boundary at `boundaryUrl`, in this order. */
export function boundaryArgv(boundaryUrl) {
  return ['--preserve-symlinks', '--preserve-symlinks-main', '--import', boundaryUrl]
}

/**
 * NODE_* variables that carry only data a Tool may need: extra TLS roots and the switch to use the
 * HTTP(S)_PROXY settings. Every other NODE_* name — NODE_OPTIONS (preloads), NODE_COMPILE_CACHE (a code
 * cache that is trusted by a 32-bit checksum), NODE_ICU_DATA, NODE_PATH, NODE_PRESERVE_SYMLINKS and any
 * name a later Node adds — and every OPENSSL_* name (OPENSSL_CONF can load engines) is withheld.
 */
export const NODE_ENV_ALLOWED = Object.freeze(['NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY'])
export function isLoaderEnvName(name) {
  const upper = String(name).toUpperCase()
  return (upper.startsWith('NODE_') && !NODE_ENV_ALLOWED.includes(upper)) || upper.startsWith('OPENSSL_')
}

/**
 * The environment of a process held by the boundary: `base` without the names that can load or select
 * code, with this implementation list, the compile cache disabled and, when chosen, the hooks variant.
 */
export function boundaryEnv(base, pinText, hooks) {
  const out = {}
  for (const [name, value] of Object.entries(base ?? {})) {
    const upper = name.toUpperCase()
    if (isLoaderEnvName(name) || upper === IMPLEMENTATION_PIN_ENV || upper === IMPLEMENTATION_HOOKS_ENV) continue
    out[name] = value
  }
  out[IMPLEMENTATION_PIN_ENV] = pinText
  out.NODE_DISABLE_COMPILE_CACHE = '1'
  if (hooks === 'register') out[IMPLEMENTATION_HOOKS_ENV] = 'register'
  return out
}

/** Node options a pinned Tool may pass to another Node it starts: none of them loads or selects code. */
const SAFE_NODE_OPTION = /^(?:--(?:max-old-space-size|max-semi-space-size|stack-size)=\d+|--(?:no-warnings|no-deprecation|trace-warnings|trace-deprecation|throw-deprecation|trace-uncaught|enable-source-maps|preserve-symlinks|preserve-symlinks-main)|--unhandled-rejections=(?:strict|warn|none|throw|warn-with-error-code))$/

/**
 * The arguments of a Node process or thread a pinned Tool starts, with the boundary first.
 *
 * `args` is what the Tool asked for (Node options, then the script and its arguments). The boundary the
 * Tool inherited (`process.execArgv`) is accepted in front; any other option must be one that loads
 * nothing (`SAFE_NODE_OPTION`). A process needs a script file — without one Node would run source text
 * from stdin or an option, which is not a pinned file. A thread's options carry no script at all.
 */
export function boundedNodeArgs(args, boundary, { script, label }) {
  const list = (Array.isArray(args) ? args : []).map(String)
  let index = boundary.every((value, at) => list[at] === value) ? boundary.length : 0
  const options = []
  for (; index < list.length && list[index].startsWith('-'); index++) {
    if (!SAFE_NODE_OPTION.test(list[index])) {
      throw new ImplementationBoundaryError(`${label} passes the Node option ${list[index]}, which can load or select code outside`
        + ' this Tool\'s pinned implementation, so it was not started.')
    }
    options.push(list[index])
  }
  if (script && index >= list.length) {
    throw new ImplementationBoundaryError(`${label} names no script file, so it would run code that is not a pinned file; it was not started.`)
  }
  if (!script && index < list.length) {
    throw new ImplementationBoundaryError(`${label} passes ${list[index]}, which is not a Node option, so it was not started.`)
  }
  return [...boundary, ...options, ...list.slice(index)]
}

/** 解析 Worker 交来的名单。缺失或畸形就是边界不成立：拒绝，而不是放行一个没有名单的进程。 */
export function readImplementationPin(text) {
  if (typeof text !== 'string' || text === '') {
    throw new ImplementationBoundaryError('this process was started without the pinned implementation list, so no local code may load.')
  }
  let pin
  try { pin = JSON.parse(text) } catch { throw new ImplementationBoundaryError('the pinned implementation list is not JSON.') }
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) || pin.format !== IMPLEMENTATION_PIN_FORMAT
      || !pin.files || typeof pin.files !== 'object' || Array.isArray(pin.files)
      || Object.keys(pin).some((key) => !['format', 'files'].includes(key))) {
    throw new ImplementationBoundaryError(`the pinned implementation list is not ${IMPLEMENTATION_PIN_FORMAT}.`)
  }
  const files = Object.create(null)
  for (const [key, digest] of Object.entries(pin.files)) {
    if (!key.endsWith('.mjs') || typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      throw new ImplementationBoundaryError('the pinned implementation list names a file that is not an ES module with a sha256.')
    }
    files[implementationPinKey(key)] = digest
  }
  if (Object.keys(files).length === 0) throw new ImplementationBoundaryError('the pinned implementation list is empty.')
  return files
}

/**
 * A specifier that resolves through a package.json is refused before it is resolved: a package name
 * (its `exports`) or a `#` name (the `imports` map). That file is not part of the pin, and it would
 * choose which file loads. Relative and absolute paths, URLs and built-in names resolve without one.
 */
function refuseIndirect(specifier) {
  if (specifier.startsWith('#')) {
    throw new ImplementationBoundaryError(`import "${specifier}" goes through a package.json "imports" map, which is not part of`
      + ' this Tool\'s pinned implementation, so it was not loaded. Import the declared file by its relative path.')
  }
  if (/^(?:\.{0,2}\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(specifier) || isBuiltin(specifier)) return
  throw new ImplementationBoundaryError(`import "${specifier}" names a package, which resolves through package.json files outside`
    + ' this Tool\'s pinned implementation, so it was not loaded. Declare the files it needs and import them by relative path.')
}

/** 这个地址是否允许装载：内置返回 undefined；pin 名单上的文件返回路径与期望摘要；其余拒绝。 */
function pinnedFile(files, url) {
  if (url.startsWith('node:')) return undefined
  if (!url.startsWith('file:')) {
    throw new ImplementationBoundaryError(`${url} is not a file of the pinned implementation, so it was not loaded;`
      + ' only the declared .mjs files and node: built-ins load.')
  }
  const path = fileURLToPath(url)
  const expected = files[implementationPinKey(path)]
  if (expected === undefined) {
    throw new ImplementationBoundaryError(`${path} is not declared in this Tool's implementation, so it was not loaded.`
      + ' Declare it in the Tool\'s "implementation" list, restart the Worker and lock the new digest.')
  }
  return { path, expected }
}

/** 读一次、核一次、交出同一份字节。 */
function verifiedSource(file) {
  let bytes
  try { bytes = readFileSync(file.path) } catch (error) {
    throw new ImplementationBoundaryError(`${file.path} cannot be read (${error?.code ?? 'unreadable'}), so it was not loaded;`
      + ' the pinned implementation is incomplete.')
  }
  if (sha256Hex(bytes) !== file.expected) {
    throw new ImplementationBoundaryError(`${file.path} is not the verified implementation (its bytes changed after the Worker`
      + ' checked them), so it was not loaded. Restart the Worker and lock the new digest to use a changed implementation.')
  }
  return { format: 'module', source: bytes, shortCircuit: true }
}

/**
 * 同步钩子（`module.registerHooks`，Node 22.15+）：覆盖本线程的 import 与 require 解析。
 * 别的线程和子进程不归这里管：implementation-boundary.mjs 让它们带着同一道边界启动，或者拒绝。
 */
export function implementationHooks(files) {
  return {
    resolve(specifier, context, nextResolve) {
      refuseIndirect(specifier)
      const resolved = nextResolve(specifier, context)
      pinnedFile(files, resolved.url)
      return resolved
    },
    load(url, context, nextLoad) {
      const file = pinnedFile(files, url)
      return file === undefined ? nextLoad(url, context) : verifiedSource(file)
    },
  }
}

// ── `module.register` 的异步钩子（没有 registerHooks 的 Node 20.6–22.14）。同一套判断，只是包成 async。
let registered
export async function initialize(text) {
  registered = readImplementationPin(text)
}
export async function resolve(specifier, context, nextResolve) {
  refuseIndirect(specifier)
  const resolved = await nextResolve(specifier, context)
  pinnedFile(registered, resolved.url)
  return resolved
}
export async function load(url, context, nextLoad) {
  const file = pinnedFile(registered, url)
  return file === undefined ? nextLoad(url, context) : verifiedSource(file)
}
