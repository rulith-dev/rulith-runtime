// The test-home guard's one decision (test/support/no-sandbox.mjs): which changes to the account's real Rulith folders
// the suite is blamed for. Pure apart from `appRanThroughout`, so it is tested on its own (test/test-home-guard.test.mjs).
//
// A Rulith app the owner keeps running from the real app home (~/.rulith/app) while the suite runs may change one file of
// its own. Exactly these changes are its own, and only while the app was provably live for the whole run
// (`appRanThroughout`: the manager lease held by the same live holder from start to end, the device record's identity
// fields unchanged). Since batch C (D-1031a) the app rewrites nothing on a timer (the host's status file is gone, and the
// manager writes device.json only when the account's Agent directory changes), so these are all:
//   - created or modified: dsh/rulith-context-windows.json (0.19.3: the context windows of model routes, written when a
//     detected window changes, so it may first appear during a run); any change of its atomic-write temporary file
//     dsh/rulith-context-windows.json.tmp; and the dsh directory itself, only when that file was written in this run
//     (the rename changes the directory).
// Everything else is the suite's change, as is any of these when the app was not live throughout, or the windows file
// being removed (the app never removes it).
//
// 中文说明：测试守卫的判断：真实 Rulith 目录里哪些改动算测试做的。批次 C 起应用不再按时改写任何文件（状态文件删了，
// device.json 只在智能体目录真的变了时才写），所以只在应用全程确实活着时放过 0.19.3 的上下文窗口文件（可能在测试期间第一次
// 出现）、它的临时文件，和因它改名而变的 dsh 目录本身；其余一律算测试的改动。
import path from 'node:path'

/**
 * The changes between two snapshots (path → state) the live app does not explain, as `"<kind> <path>"` lines, kind one of
 * created | modified | removed. `appRanThroughout()` is asked only when some change could be the app's own.
 */
export function unexplainedChanges(before, after, { appHome, appRanThroughout }) {
  const dshHome = path.join(appHome, 'dsh')
  const windowsFile = path.join(dshHome, 'rulith-context-windows.json')
  const windowsTemporary = `${windowsFile}.tmp`
  const changes = []
  for (const [p, state] of after) if (!before.has(p)) changes.push(['created', p]); else if (before.get(p) !== state) changes.push(['modified', p])
  for (const p of before.keys()) if (!after.has(p)) changes.push(['removed', p])
  const windowsWritten = changes.some(([kind, p]) => (p === windowsFile && kind !== 'removed') || p === windowsTemporary)
  const appsOwn = (kind, p) => (p === windowsFile && kind !== 'removed') || p === windowsTemporary
    || (p === dshHome && kind === 'modified' && windowsWritten)
  return changes.filter(([kind, p]) => !(appsOwn(kind, p) && appRanThroughout())).map(([kind, p]) => `${kind} ${p}`)
}
