// Stands for `rulith`: this file is the process's entry script, as local/rulith-local.mjs is when the app is started with
// `rulith`, and it runs a launcher in this process exactly as rulith-local.mjs does (startApp). The launcher is a stand-in
// that only takes the app home's lock, the first thing start-deep-rulith.mjs does; the app home is the one argument.
// 中文说明：代表 `rulith` 启动路径：本文件是进程的入口脚本，用 rulith-local.mjs 同一个 startApp 在本进程里跑启动器。
import { startApp } from '../../../../local/rulith-local.mjs';

await startApp([process.argv[2]], new URL('./launcher-stand-in.mjs', import.meta.url));
