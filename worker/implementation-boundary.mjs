// SPDX-License-Identifier: Apache-2.0
/**
 * `node --import <this file> <entry> <args>`：Worker 启动 run Tool 时，子进程里第一段执行的代码。
 *
 * 它在 Tool 的任何代码之前做三件事（SYS-TOOL-01“Worker 只执行已核验的同一份实现字节”）：
 *
 *   1. 读 Worker 交来的 pin 名单（真实路径 → SHA-256）。没有名单就拒绝启动：没有名单的进程
 *      不知道哪份字节是被 pin 的，只能什么都不装。
 *   2. 拒绝 CommonJS 的 require（含 createRequire）与原生扩展：这两条装载路不经过 ES 模块钩子，
 *      在 Node 20/22 早期版本上也约束不住，所以统一可见拒绝（`node:` 内置模块照常可用）。
 *   3. 注册装载钩子（implementation-hooks.mjs）：每个模块装载前核验，执行被核验的那一份字节。
 *
 * NODE_OPTIONS 里的 --require/--import 会先于本文件执行，所以 Worker 从不把 NODE_OPTIONS 交给
 * run Tool。本文件属于 Runtime 自己的发布字节，和 Worker 本身同一个信任基础。
 */
import module from 'node:module'
import {
  IMPLEMENTATION_PIN_ENV, ImplementationBoundaryError, implementationHooks, readImplementationPin,
} from './implementation-hooks.mjs'

const text = process.env[IMPLEMENTATION_PIN_ENV]
const files = readImplementationPin(text)

const loadCommonJs = module._load
module._load = function loadWithinImplementationBoundary(request, ...rest) {
  if (typeof request === 'string' && module.isBuiltin(request)) return loadCommonJs.call(this, request, ...rest)
  throw new ImplementationBoundaryError(`require(${JSON.stringify(String(request))}) would load CommonJS code, which is outside`
    + ' this Tool\'s pinned implementation. Only the declared .mjs files load, through import.')
}
process.dlopen = () => {
  throw new ImplementationBoundaryError('a native addon is outside this Tool\'s pinned implementation and does not load.')
}

if (typeof module.registerHooks === 'function') module.registerHooks(implementationHooks(files))
else if (typeof module.register === 'function') module.register('./implementation-hooks.mjs', import.meta.url, { data: text })
else throw new ImplementationBoundaryError(`Node ${process.version} has no module hooks, so the pinned implementation cannot be held.`)
