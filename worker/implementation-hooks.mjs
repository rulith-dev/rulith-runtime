// SPDX-License-Identifier: Apache-2.0
/**
 * 实现边界的装载钩子（PSC SYS-TOOL-01、ACC-TOOL-09；0.2.24 在官方编程能力的工具上落实）。
 *
 * 一个 `run` Tool 的 pin 覆盖它的实现字节：入口文件和它声明的实现文件（`implementation`），
 * 每个文件的 SHA-256 都进 Tool digest。Worker 在领取前、启动前各核验一次磁盘上的字节；
 * 但只核验磁盘还不够——“检查旧文件、执行新文件”正是合同点名禁止的那一种。所以子进程里
 * 每一次装载代码都在这里再核验一次，而且执行的就是被核验的那一份内存字节：
 *
 *   · resolve：Node 解析出的地址不是 `node:` 内置、也不是 pin 名单上的文件，就在装载之前拒绝。
 *     遗漏的依赖不是“已声明部分已核验”，而是实现边界不成立（Worker 细则 §1）。
 *   · load：读文件一次、算一次摘要、与 pin 比对，相同才把**这一份字节**交给 Node 编译。
 *     核验和使用是同一个 Buffer，中间没有第二次读盘，所以没有窗口可换文件。
 *
 * 静态 import 图在任何模块求值之前整体装载，所以静态依赖的任何变化都在副作用之前被拒绝；
 * 运行中才动态 import 的文件，在它执行之前被拒绝（之前已经发生的效果如实保留，不伪造零副作用）。
 *
 * 只认 ES 模块（`.mjs`）：它的格式由扩展名决定，不受旁边 package.json 的 `type` 影响。
 * CommonJS 的 require、原生扩展这两条装载路在 implementation-boundary.mjs 里直接拒绝——
 * 无法约束的机制可见拒绝，不留兼容开关。
 *
 * 这不是沙箱，也不是对机器的认证：它只保证这个进程装载的本地实现代码就是操作员 pin 的那一份字节。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Worker 交给子进程的 pin 名单所在的环境变量；kit 的工具不会把它传给自己运行的项目命令（RULITH_ 前缀被剥掉）。 */
export const IMPLEMENTATION_PIN_ENV = 'RULITH_IMPLEMENTATION_PIN'
export const IMPLEMENTATION_PIN_FORMAT = 'rulith-implementation-pin/1'
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * 名单的键：真实路径。Windows 的文件系统不分大小写，所以那里统一成小写比较；
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

/** 这个地址是否允许装载：内置返回 undefined；pin 名单上的文件返回路径与期望摘要；其余拒绝。 */
function pinnedFile(files, url) {
  if (url.startsWith('node:')) return undefined
  if (!url.startsWith('file:')) {
    throw new ImplementationBoundaryError(`${url} is not a file of the pinned implementation; only its declared .mjs files and node: built-ins load.`)
  }
  const path = fileURLToPath(url)
  const expected = files[implementationPinKey(path)]
  if (expected === undefined) {
    throw new ImplementationBoundaryError(`${path} is not declared in this Tool's implementation, so it does not load.`
      + ' Declare it in the Tool\'s "implementation" list, restart the Worker and pin the new digest.')
  }
  return { path, expected }
}

/** 读一次、核一次、交出同一份字节。 */
function verifiedSource(file) {
  let bytes
  try { bytes = readFileSync(file.path) } catch (error) {
    throw new ImplementationBoundaryError(`${file.path} cannot be read (${error?.code ?? 'unreadable'}); the pinned implementation is incomplete.`)
  }
  if (sha256Hex(bytes) !== file.expected) {
    throw new ImplementationBoundaryError(`${file.path} is not the verified implementation: its bytes changed after the Worker checked them.`
      + ' Nothing from it ran. Restart the Worker and pin the new digest to use the changed implementation.')
  }
  return { format: 'module', source: bytes, shortCircuit: true }
}

/** 同步钩子（`module.registerHooks`，Node 22.15+）：同时覆盖 import、require 与 worker 线程里的装载。 */
export function implementationHooks(files) {
  return {
    resolve(specifier, context, nextResolve) {
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
  const resolved = await nextResolve(specifier, context)
  pinnedFile(registered, resolved.url)
  return resolved
}
export async function load(url, context, nextLoad) {
  const file = pinnedFile(registered, url)
  return file === undefined ? nextLoad(url, context) : verifiedSource(file)
}
