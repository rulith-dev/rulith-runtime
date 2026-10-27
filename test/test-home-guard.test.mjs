// The test-home guard's decision (test/support/test-home-guard.mjs, used by test/support/no-sandbox.mjs): which changes to
// the account's real Rulith folders a live app explains. Snapshots are made up here (path → state); no real folder is read.
// 中文说明：测试守卫的判断：只在应用全程活着时放过它自己的几处改动（0.19.3 起含上下文窗口文件），其余都算测试的改动。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { unexplainedChanges } from './support/test-home-guard.mjs'

const appHome = path.join(path.sep === '\\' ? 'C:\\Users\\someone' : '/home/someone', '.rulith', 'app')
const at = (...parts) => path.join(appHome, ...parts)
const dsh = at('dsh'), manager = at('manager')
const windows = at('dsh', 'rulith-context-windows.json')
const before = new Map([[appHome, 'd:0:1:1'], [dsh, 'd:0:1:1'], [manager, 'd:0:1:1'], [at('dsh', 'rulith-runtime-status.json'), 'f:10:1:1'],
  [at('manager', 'device.json'), 'f:20:1:1'], [at('manager', 'workbench.lock'), 'f:30:1:1'], [at('dsh', 'rulith-selected.json'), 'f:5:1:1']])
/** `before` with these paths set to a new state (`null` removes one). */
const changed = (edits, from = before) => {
  const after = new Map(from)
  for (const [p, state] of Object.entries(edits)) if (state === null) after.delete(p); else after.set(p, state)
  return after
}
const guard = (after, live, from = before) => {
  let asked = 0
  const lines = unexplainedChanges(from, after, { appHome, appRanThroughout: () => { asked += 1; return live } })
  return { lines, asked }
}

test('a live app\'s context-window file may appear or change, with its temporary file and the dsh folder it is renamed in', () => {
  // The first window detected during the run: the file appears, the dsh folder changes with the rename.
  const first = changed({ [windows]: 'f:200:2:2', [dsh]: 'd:0:2:2' })
  assert.deepEqual(guard(first, true).lines, [])
  // A later change of the file, with its temporary file caught at the snapshot (or caught before and gone after).
  const withFile = changed({ [windows]: 'f:200:1:1' })
  assert.deepEqual(guard(changed({ [windows]: 'f:210:3:3', [`${windows}.tmp`]: 'f:210:3:3', [dsh]: 'd:0:3:3' }, withFile), true, withFile).lines, [])
  const withTemporary = changed({ [`${windows}.tmp`]: 'f:210:1:1' }, withFile)
  assert.deepEqual(guard(changed({ [`${windows}.tmp`]: null, [windows]: 'f:210:3:3', [dsh]: 'd:0:3:3' }, withTemporary), true, withTemporary).lines, [])
  // The live app's periodic rewrites are still its own.
  const deviceTemporary = at('manager', 'device.json.0b0e3f9c-1d2e-4f50-8a6b-7c8d9e0f1a2b.tmp')
  assert.deepEqual(guard(changed({ [at('dsh', 'rulith-runtime-status.json')]: 'f:11:2:2', [at('manager', 'device.json')]: 'f:20:2:2',
    [manager]: 'd:0:2:2', [deviceTemporary]: 'f:20:2:2', [windows]: 'f:200:2:2', [dsh]: 'd:0:2:2' }), true).lines, [])
});

test('everything else stays flagged: the same changes without a live app, a removed window file, other files, the dsh folder alone', () => {
  // Not live for the whole run (no lease, another holder, a changed device identity): the suite changed them.
  assert.deepEqual(guard(changed({ [windows]: 'f:200:2:2', [dsh]: 'd:0:2:2' }), false).lines.sort(),
    [`created ${windows}`, `modified ${dsh}`].sort())
  assert.deepEqual(guard(changed({ [at('dsh', 'rulith-runtime-status.json')]: 'f:11:2:2' }), false).lines,
    [`modified ${at('dsh', 'rulith-runtime-status.json')}`])
  // The app never removes the window file.
  const withFile = changed({ [windows]: 'f:200:1:1' })
  assert.deepEqual(guard(changed({ [windows]: null, [dsh]: 'd:0:2:2' }, withFile), true, withFile).lines.sort(),
    [`modified ${dsh}`, `removed ${windows}`].sort())
  // The dsh folder changing when the window file was not written; other files of the dsh folder; other names.
  assert.deepEqual(guard(changed({ [dsh]: 'd:0:2:2' }), true).lines, [`modified ${dsh}`])
  for (const other of [at('dsh', 'rulith-selected.json'), at('dsh', 'rulith-context-windows.json.bak'), at('dsh', 'rulith-session-agents.json'),
    at('manager', 'rulith-context-windows.json'), at('rulith-context-windows.json'), at('manager', 'workbench.lock')]) {
    const lines = guard(changed({ [other]: 'f:99:2:2', [windows]: 'f:200:2:2', [dsh]: 'd:0:2:2' }), true).lines
    assert.equal(lines.length, 1, `${other}: ${lines.join('; ')}`)
    assert.match(lines[0], /^(created|modified) /)
    assert.ok(lines[0].endsWith(other), lines[0])
  }
  // The status file and device record are periodic rewrites only, never created or removed by the app.
  assert.deepEqual(guard(changed({ [at('dsh', 'rulith-runtime-status.json')]: null }), true).lines, [`removed ${at('dsh', 'rulith-runtime-status.json')}`])
});

test('nothing changed is nothing to report, and whether the app was live is asked only when a change could be its own', () => {
  assert.deepEqual(guard(new Map(before), false), { lines: [], asked: 0 })
  assert.equal(guard(changed({ [at('dsh', 'rulith-selected.json')]: 'f:6:2:2' }), true).asked, 0)
  assert.ok(guard(changed({ [windows]: 'f:200:2:2' }), true).asked > 0)
});
