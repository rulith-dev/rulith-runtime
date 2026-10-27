// The test-home guard's one decision (test/support/no-sandbox.mjs): which changes to the account's real Rulith folders
// the suite is blamed for. Pure apart from `appRanThroughout`, so it is tested on its own (test/test-home-guard.test.mjs).
//
// A Rulith app the owner keeps running from the real app home (~/.rulith/app) while the suite runs changes a few of its
// own files. Exactly these are its own, and only while the app was provably live for the whole run (`appRanThroughout`:
// the manager lease held by the same live holder from start to end, the device record's identity fields unchanged):
//   - modified: dsh/rulith-runtime-status.json (the host's status, every 3 s), manager/device.json and the manager
//     directory itself (the manager's Agent-list refresh, every 30 s, written atomically);
//   - created or removed: the manager's atomic-write temporary file manager/device.json.<uuid>.tmp;
//   - created or modified: dsh/rulith-context-windows.json (0.19.3: the context windows of model routes, written when a
//     detected window changes, so it may first appear during a run); any change of its atomic-write temporary file
//     dsh/rulith-context-windows.json.tmp; and the dsh directory itself, only when that file was written in this run
//     (the rename changes the directory).
// Everything else is the suite's change, as is any of these when the app was not live throughout, or the windows file
// being removed (the app never removes it).
//
// 中文说明：测试守卫的判断：真实 Rulith 目录里哪些改动算测试做的。只有在应用全程确实活着时，才放过它自己按时改写的几处，
// 以及 0.19.3 的上下文窗口文件（可能在测试期间第一次出现）、它的临时文件，和因它改名而变的 dsh 目录本身；其余一律算测试的改动。
import path from 'node:path'

/**
 * The changes between two snapshots (path → state) the live app does not explain, as `"<kind> <path>"` lines, kind one of
 * created | modified | removed. `appRanThroughout()` is asked only when some change could be the app's own.
 */
export function unexplainedChanges(before, after, { appHome, appRanThroughout }) {
  const managerHome = path.join(appHome, 'manager')
  const dshHome = path.join(appHome, 'dsh')
  const periodicRewrites = new Set([path.join(dshHome, 'rulith-runtime-status.json'), path.join(managerHome, 'device.json'), managerHome])
  const deviceTemporary = (p) => path.dirname(p) === managerHome && /^device\.json\.[0-9a-f-]{36}\.tmp$/.test(path.basename(p))
  const windowsFile = path.join(dshHome, 'rulith-context-windows.json')
  const windowsTemporary = `${windowsFile}.tmp`
  const changes = []
  for (const [p, state] of after) if (!before.has(p)) changes.push(['created', p]); else if (before.get(p) !== state) changes.push(['modified', p])
  for (const p of before.keys()) if (!after.has(p)) changes.push(['removed', p])
  const windowsWritten = changes.some(([kind, p]) => (p === windowsFile && kind !== 'removed') || p === windowsTemporary)
  const appsOwn = (kind, p) => (kind === 'modified' ? periodicRewrites.has(p) : deviceTemporary(p))
    || (p === windowsFile && kind !== 'removed') || p === windowsTemporary
    || (p === dshHome && kind === 'modified' && windowsWritten)
  return changes.filter(([kind, p]) => !(appsOwn(kind, p) && appRanThroughout())).map(([kind, p]) => `${kind} ${p}`)
}
