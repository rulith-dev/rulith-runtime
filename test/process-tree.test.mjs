import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteUnconfinedEnd, noteUnconfinedStart, readUnconfinedRecords, runBounded, sweepUnconfined, unconfinedMembers, UNCONFINED_RECORDS }
  from '../local/process-tree.mjs'
import { UNCONFINED_MARK_ENV } from '../worker/adapter-confinement.mjs'

test('bounded command timeout terminates a spawned child tree', async () => {
  const script = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)']);process.stdout.write(String(c.pid));setTimeout(()=>{},10000)"
  await assert.rejects(() => runBounded(process.execPath, ['-e', script], { timeoutMs: 100, maxBytes: 4096, env: process.env }), /local_authoring_timeout/)
})

// ACC-ISO-14 (PSC 0.2.31 ③): what an Adapter started without isolation left running is ended when isolation is required
// again — the Adapter's own process tree and, after it exited, the children it had started (a detached background job
// is no longer its child to the system: Windows keeps the dead parent's pid on it, Linux re-parents it, so it is found
// by the pid and the time the Adapter held it, or by the start's mark).
const MARK_A = 'a'.repeat(32), MARK_B = 'b'.repeat(32)

test('ACC-ISO-14 the processes an unconfined start accounts for: its live tree, children created while it held its pid, and its mark', () => {
  const records = [{ pid: 100, startedAt: 10_000, endedAt: 12_000 }, { pid: 300, startedAt: 20_000, mark: MARK_A }]
  const table = [
    { pid: 1, ppid: 0, createdAt: 0, name: 'init' },
    { pid: 101, ppid: 100, createdAt: 11_000, name: 'supervisor' }, // started by Adapter 100, which has exited
    { pid: 102, ppid: 101, createdAt: 11_500, name: 'job' }, // and what that started
    { pid: 100, ppid: 5, createdAt: 30_000, name: 'reused' }, // pid 100 held by an unrelated process since
    { pid: 103, ppid: 100, createdAt: 31_000, name: 'reused-child' }, // that process's child
    { pid: 104, ppid: 100, createdAt: 13_000, name: 'after-exit' }, // created after Adapter 100 exited
    { pid: 300, ppid: 7, createdAt: 19_950, name: 'adapter' }, // Adapter 300, still running
    { pid: 301, ppid: 300, createdAt: 19_000, name: 'older' }, // claims it as parent but is older: an earlier pid holder's
    { pid: 400, ppid: 1, createdAt: 25_000, name: 'adopted', mark: MARK_A }, // re-parented (Linux), carries 300's mark
    { pid: 401, ppid: 400, createdAt: 26_000, name: 'grandchild' },
    { pid: 500, ppid: 1, createdAt: 25_000, name: 'other', mark: MARK_B }, // another mark
    { pid: 900, ppid: 100, createdAt: 11_000, name: 'this process' },
  ]
  assert.deepEqual(unconfinedMembers(table, records, { self: [900] }).map((row) => row.pid).sort((a, b) => a - b), [101, 102, 300, 400, 401])
  assert.deepEqual(unconfinedMembers(table, []), [])
})

test('ACC-ISO-14 a sweep says what it stopped and what it could not, and keeps the record until nothing is left', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-unconfined-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, UNCONFINED_RECORDS)
  assert.equal(sweepUnconfined(file), null, 'nothing recorded: nothing to do')
  noteUnconfinedStart(file, { pid: 100, startedAt: 10_000, mark: MARK_A })
  noteUnconfinedStart(file, { pid: 0, startedAt: 1 })
  noteUnconfinedStart(file, { pid: 7, startedAt: 1, mark: '../x' })
  noteUnconfinedEnd(file, { pid: 100, endedAt: 12_000 })
  assert.deepEqual(readUnconfinedRecords(file), [{ pid: 100, startedAt: 10_000, mark: MARK_A, endedAt: 12_000 }], 'malformed reports are not kept')
  const rows = [{ pid: 101, ppid: 100, createdAt: 11_000, name: 'stubborn' }, { pid: 102, ppid: 100, createdAt: 11_100, name: 'job' }]
  let killed = []
  const kept = sweepUnconfined(file, { table: () => rows.filter((row) => !killed.includes(row.pid) || row.name === 'stubborn'),
    kill: (members) => { killed = members.map((row) => row.pid) }, now: () => 5 })
  assert.deepEqual(kept, { at: 5, stopped: [{ pid: 102, name: 'job' }], failed: [{ pid: 101, name: 'stubborn' }] })
  assert.equal(existsSync(file), true, 'kept for the next attempt')
  assert.deepEqual(sweepUnconfined(file, { table: () => { throw new Error('no list') }, now: () => 6 }),
    { at: 6, stopped: [], failed: [], error: 'no list' })
  assert.equal(existsSync(file), true)
  const done = sweepUnconfined(file, { table: () => [], kill: () => { throw new Error('nothing to kill') }, now: () => 7 })
  assert.deepEqual(done, { at: 7, stopped: [], failed: [] })
  assert.equal(existsSync(file), false, 'nothing left: the record goes')
})

test('ACC-ISO-14 a detached child an unconfined Adapter left running is ended', {
  skip: !['win32', 'linux'].includes(process.platform) && 'model commands are isolated only on Windows and Linux',
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-unconfined-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, UNCONFINED_RECORDS)
  const mark = randomUUID().replaceAll('-', '')
  // The "Adapter": starts a detached child that outlives it, says its pid, and exits.
  const script = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],"
    + "{detached:true,stdio:'ignore',windowsHide:true});c.unref();process.stdout.write(String(c.pid))"
  const adapter = spawn(process.execPath, ['-e', script], { env: { ...process.env, [UNCONFINED_MARK_ENV]: mark }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  noteUnconfinedStart(file, { pid: adapter.pid, startedAt: Date.now(), mark })
  let printed = ''
  adapter.stdout.on('data', (chunk) => { printed += chunk })
  await new Promise((done) => adapter.once('close', done))
  noteUnconfinedEnd(file, { pid: adapter.pid, endedAt: Date.now() })
  const child = Number(printed.trim())
  t.after(() => { try { process.kill(child, 'SIGKILL') } catch { /* gone */ } })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
  assert.equal(alive(child), true, 'the detached child outlived its Adapter')
  const result = sweepUnconfined(file)
  assert.deepEqual(result.failed, [], JSON.stringify(result))
  assert.equal(result.stopped.some((row) => row.pid === child), true, JSON.stringify(result))
  for (let i = 0; i < 100 && alive(child); i++) await new Promise((done) => setTimeout(done, 50))
  assert.equal(alive(child), false)
  assert.equal(alive(process.pid), true)
  assert.equal(existsSync(file), false)
})
