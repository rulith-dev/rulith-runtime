// Test bootstrap (loaded with `node --import` by `npm test` and `npm run test:app`, in the runner and in every test
// process it spawns). Two things, set once here so that no individual test can forget them:
//
// 1. Model-command isolation is OFF by default in the suite, the explicit owner-style disable. Most tests exercise the
//    Worker's run loop and the real adapter in throwaway directories, not the confined product path; the OS sandbox there
//    would need labeled credential roots and a compiled launcher per case. This does NOT weaken the P0 proof: the
//    default is required (worker/adapter-confinement.mjs, asserted by a unit test), and the confined product path is
//    proven end to end, including that a managed-instance Worker (whose isolated environment strips this very variable)
//    defaults to required, by app/test/harness/model-command-isolation.test.mjs (ACC-ISO-07/08). Tests that assert
//    confinement pass `required` explicitly.
//
// 2. Throwaway account homes. Every per-user location the product derives (the ~/.rulith backstop and app home, the
//    work root under %LOCALAPPDATA%\Rulith or $XDG_DATA_HOME/rulith-work, anything under %APPDATA%) points into one
//    temporary directory for the whole run: USERPROFILE, HOME, LOCALAPPDATA, APPDATA and XDG_DATA_HOME are replaced
//    before any test module loads, and child processes inherit them; an inherited DSH_HOME is cleared. A manager a test
//    starts without the isolation switch (for example through an environment that strips RULITH_*) therefore labels and
//    fills throwaway folders, never the account's real ones.
//
//    A guard in the runner process snapshots the real %LOCALAPPDATA%\Rulith, ~/.rulith and $XDG_DATA_HOME/rulith-work
//    before the suite and compares them when it exits; anything created, removed or modified there (contents, size,
//    times, including a security change) fails the run and is listed. The one exception is a Rulith app the owner keeps
//    running from the real app home (~/.rulith/app) while the suite runs: its context-window file (since 0.19.3, written
//    when a detected window changes), only while its manager's lease shows it running the whole time and its device
//    record keeps the same account and device (the decision is test-home-guard.mjs unexplainedChanges). Since batch C the
//    app rewrites nothing on a timer, so an app from before batch C running meanwhile is reported.
//
// 中文说明：测试引导在运行器和它派生的每个测试进程里都会加载。它把隔离默认关掉（理由见上），并把整轮测试的账户目录
// （USERPROFILE、HOME、LOCALAPPDATA、APPDATA、XDG_DATA_HOME）换成一个临时目录，子进程继承；运行器进程里另有守卫，
// 测试前后比对真实的 %LOCALAPPDATA%\Rulith、~/.rulith 与 rulith-work，有任何新建、删除或改动就让整轮失败并列出来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { processRecordRunning } from '../../local/process-identity.mjs'
import { unexplainedChanges } from './test-home-guard.mjs'

if (process.env.RULITH_ADAPTER_SANDBOX === undefined) process.env.RULITH_ADAPTER_SANDBOX = 'off'

if (!process.env.RULITH_TEST_HOMES) {
  const realHome = os.homedir()
  const watched = [
    path.join(process.env.LOCALAPPDATA || path.join(realHome, 'AppData', 'Local'), 'Rulith'),
    path.join(realHome, '.rulith'),
    path.join(process.env.XDG_DATA_HOME || path.join(realHome, '.local', 'share'), 'rulith-work'),
  ]
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rulith-test-homes-')))
  const home = path.join(base, 'home')
  const homes = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_DATA_HOME: path.join(home, '.local', 'share') }
  for (const dir of Object.values(homes)) fs.mkdirSync(dir, { recursive: true })
  Object.assign(process.env, homes, { RULITH_TEST_HOMES: base })
  // A DSH_HOME inherited from the shell (a developer's or the owner's dsh home) is not the suite's: the app host keeps its
  // state there when it is set (rulith-runtime.mjs), so it is cleared here; tests that need one set their own.
  delete process.env.DSH_HOME

  /** path → what identifies its state: kind, size, modification and change times. */
  const snapshot = () => {
    const seen = new Map()
    const walk = (p) => {
      let stat
      try { stat = fs.lstatSync(p) } catch { return }
      seen.set(p, `${stat.isDirectory() ? 'd' : 'f'}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      let names = []
      try { names = fs.readdirSync(p) } catch { return }
      for (const name of names) walk(path.join(p, name))
    }
    for (const root of watched) walk(root)
    return seen
  }
  // 中文说明：负责人常常一边开着本机应用（真实的 ~/.rulith/app）一边跑测试。批次 C 起应用不再按时改写任何文件（宿主的
  // 状态文件删了，manager/device.json 只在智能体目录真的变了时才写），只剩 0.19.3 起的上下文窗口文件：读到的窗口变了时
  // 原子改写 dsh/rulith-context-windows.json（先写同名 .tmp 再改名，所以 dsh 目录本身的时间也跟着变），第一次读到窗口时
  // 它可能在测试期间新建。守卫只放过它的新建与改写、它的临时文件，以及只在它被写过时 dsh 目录本身的改动，而且只在应用
  // 确实一直活着时：看 manager 目录里管理器的租约 workbench.lock——测试开始与结束时是同一张票据（同一个 id，即同一个持有
  // 进程），且按 Runtime 自己判断锁持有者是否还在的规则（process-identity.mjs processRecordRunning：pid 在、同一次开机、
  // 同一个程序与入口脚本，防 pid 复用）判定为仍在运行；另外要求真实 manager/device.json 里几个不含机密的身份字段（state、
  // origin、deviceId、account.id）在测试前后不变。只读这四个字段，文件里的其它内容既不保留也不打印。应用没在跑、跑到一半
  // 才启动或换了一个、身份字段变了，或者被改的是别的文件，一律算作测试的改动、整轮失败；窗口文件被删除也算（应用从不删它）。
  // 批次 C 之前的应用若在测试期间开着，它的按时改写会被报出来。判断写在 test-home-guard.mjs，有单独的测试。
  const appHome = path.join(realHome, '.rulith', 'app')
  const managerHome = path.join(appHome, 'manager')
  const managerLease = path.join(managerHome, 'workbench.lock')
  const leaseTicket = () => {
    try {
      const ticket = JSON.parse(fs.readFileSync(managerLease, 'utf8'))
      return Number.isInteger(ticket?.pid) && typeof ticket.id === 'string' ? ticket : null
    } catch { return null }
  }
  const leaseBefore = leaseTicket()
  /** The device record's identity from its non-secret fields alone; nothing else of the file is kept or printed. */
  const deviceIdentity = () => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(managerHome, 'device.json'), 'utf8'))
      return JSON.stringify([record?.state ?? null, record?.origin ?? null, record?.deviceId ?? null, record?.account?.id ?? null])
    } catch { return 'unreadable' }
  }
  const identityBefore = deviceIdentity()
  let appLive
  /** Was the app that owns the real app home running for the whole suite? Asked only when a change could be its own. */
  const appRanThroughout = () => {
    if (appLive === undefined) {
      const now = leaseTicket()
      appLive = leaseBefore !== null && now !== null && now.id === leaseBefore.id && deviceIdentity() === identityBefore
        && processRecordRunning(now, { recordedAt: now.at })
    }
    return appLive
  }
  const before = snapshot()
  process.on('exit', () => {
    const changed = unexplainedChanges(before, snapshot(), { appHome, appRanThroughout })
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* a process still holding a file there */ }
    if (changed.length) {
      console.error(`\nTest-home guard: the suite changed the account's real Rulith folders (${changed.length}):\n  `
        + changed.slice(0, 40).join('\n  ') + (changed.length > 40 ? `\n  … ${changed.length - 40} more` : ''))
      process.exitCode = 1
    }
  })
}
