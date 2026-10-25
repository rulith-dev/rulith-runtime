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
//    before any test module loads, and child processes inherit them. A manager a test starts without the isolation
//    switch (for example through an environment that strips RULITH_*) therefore labels and fills throwaway folders,
//    never the account's real ones.
//
//    A guard in the runner process snapshots the real %LOCALAPPDATA%\Rulith, ~/.rulith and $XDG_DATA_HOME/rulith-work
//    before the suite and compares them when it exits; anything created, removed or modified there (contents, size,
//    times, including a security change) fails the run and is listed.
//
// 中文说明：测试引导在运行器和它派生的每个测试进程里都会加载。它把隔离默认关掉（理由见上），并把整轮测试的账户目录
// （USERPROFILE、HOME、LOCALAPPDATA、APPDATA、XDG_DATA_HOME）换成一个临时目录，子进程继承；运行器进程里另有守卫，
// 测试前后比对真实的 %LOCALAPPDATA%\Rulith、~/.rulith 与 rulith-work，有任何新建、删除或改动就让整轮失败并列出来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const before = snapshot()
  process.on('exit', () => {
    const after = snapshot(), changed = []
    for (const [p, state] of after) if (!before.has(p)) changed.push(`created ${p}`); else if (before.get(p) !== state) changed.push(`modified ${p}`)
    for (const p of before.keys()) if (!after.has(p)) changed.push(`removed ${p}`)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* a process still holding a file there */ }
    if (changed.length) {
      console.error(`\nTest-home guard: the suite changed the account's real Rulith folders (${changed.length}):\n  `
        + changed.slice(0, 40).join('\n  ') + (changed.length > 40 ? `\n  … ${changed.length - 40} more` : ''))
      process.exitCode = 1
    }
  })
}
