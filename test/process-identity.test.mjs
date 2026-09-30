// SPDX-License-Identifier: Apache-2.0
/**
 * A recorded process is judged by what identified it, not by whether its pid is taken.
 *
 * The owner's first real run of 0.9.1 met the failure these arms pin: after a reboot, the
 * workbench refused to reset its sign-in because the pid it had recorded for an Agent was alive
 * — Windows had given it to an unrelated PowerShell. The verdicts below are driven twice: with a
 * scripted probe, so every rule is exercised on every platform with exact inputs, and against
 * real processes on this machine, so the platform readings themselves (Linux `/proc`, Windows
 * `tasklist` and the command line PowerShell reports) are what decides.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'

import {
  BOOT_MARGIN_MS, PROCESS_SESSION, instanceRecordedAt, processAlive, processRecordVerdict, processStamp,
} from '../local/process-identity.mjs'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const UPTIME_SECONDS = 20 * 60
const BOOT = NOW - UPTIME_SECONDS * 1000
const iso = (ms) => new Date(ms).toISOString()

/**
 * What PowerShell reports for an Agent a workbench installed through npm started: npm's shim
 * reaches the package through a path with a doubled backslash, which is why only the file name of
 * a recorded script is ever compared.
 */
const AGENT_COMMAND_LINE = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\op\\AppData\\Roaming\\npm\\\\node_modules\\rulith\\agent\\rulith-agent.mjs --serve'

/**
 * A machine that booted twenty minutes ago, on which pid 4242 is running `node.exe` with start
 * tick 777 — an Agent, by its command line — and pid 4343 is a child this process started.
 */
const probe = (overrides = {}) => ({
  platform: 'win32', pid: 1000, session: 'this-process',
  now: () => NOW, uptimeSeconds: () => UPTIME_SECONDS,
  alive: (pid) => [4242, 4343, 1000].includes(pid), startedChildren: () => new Set([4343]),
  bootId: () => 'boot-now', startTicks: (pid) => (pid === 4242 ? '777' : ''),
  image: (pid) => (pid === 4242 || pid === 4343 ? 'node.exe' : ''), execImage: () => 'node.exe',
  commandLine: (pid) => (pid === 4242 ? AGENT_COMMAND_LINE : ''),
  ...overrides,
})
const verdict = (record, options = {}) => processRecordVerdict(record, { probe: probe(options.probe), recordedAt: options.recordedAt })
/** Written this boot by another workbench process, as 0.9.2 writes every record. */
const stamped = (extra = {}) => ({ pid: 4242, startedAt: iso(NOW - 5 * 60_000), uptime: UPTIME_SECONDS - 300,
  session: 'another-workbench', image: 'node.exe', ...extra })

test('a recorded process whose pid nothing holds has ended, and nothing else is asked', () => {
  assert.deepEqual(verdict({ pid: 5555, startedAt: iso(NOW) }), { running: false, reason: 'not_running' })
  assert.deepEqual(verdict({ pid: 0 }), { running: false, reason: 'not_running' })
})

test('a record with nothing to go on stays running: doubt resolves toward the conservative answer', () => {
  assert.deepEqual(verdict({ pid: 4242 }), { running: true, reason: '' })
  assert.deepEqual(verdict({ pid: 4242, startedAt: 'not a time' }), { running: true, reason: '' })
  assert.deepEqual(verdict(stamped()), { running: true, reason: '' })
})

test('a record 0.9.1 wrote before this boot has ended, with a margin for clock corrections', () => {
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(BOOT - HOUR) }), { running: false, reason: 'previous_boot' })
  // Inside the margin, the wall clock alone proves nothing.
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(BOOT - BOOT_MARGIN_MS + 60_000) }), { running: true, reason: '' })
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(BOOT + 60_000) }), { running: true, reason: '' })
})

test('a clock set forward cannot make a stamped record of a live process look older than the boot', () => {
  // A virtual machine resumed after eight hours: its clock was corrected forward, and its uptime
  // counter did not run while it was paused. The process recorded before the pause still runs.
  const resumed = { now: () => NOW + 8 * HOUR, uptimeSeconds: () => UPTIME_SECONDS }
  assert.deepEqual(verdict(stamped(), { probe: resumed }), { running: true, reason: '' })
  // A record from before 0.9.2 has only the wall clock to go on, and is judged by it: the limit
  // that the stamps exist to remove.
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(NOW - 5 * 60_000) }, { probe: resumed }), { running: false, reason: 'previous_boot' })
})

test('a record 0.9.1 wrote without a stamp is dated by the marker it sits in', () => {
  // The owner's registry: host and children recorded as bare pids, the marker dated before the reboot.
  const row = { runtime: { pid: 32600, startedAt: iso(BOOT - 3 * HOUR), children: [{ role: 'agent', pid: 4242 }] },
    orphaned: { managerPid: 32600, children: [{ role: 'agent', pid: 4242 }], observedAt: iso(NOW - 60_000) } }
  assert.equal(instanceRecordedAt(row), BOOT - 3 * HOUR, 'the marker is dated by runtime.startedAt, not by a later observation')
  assert.deepEqual(verdict(row.runtime.children[0], { recordedAt: instanceRecordedAt(row) }), { running: false, reason: 'previous_boot' })
  // An orphan marker is only ever copied out of runtime, so it falls back to its own date alone.
  assert.equal(instanceRecordedAt({ orphaned: { observedAt: iso(BOOT - HOUR) } }), BOOT - HOUR)
  assert.ok(Number.isNaN(instanceRecordedAt({ runtime: { pid: 1 } })))
  // Its own stamp wins over the marker's date.
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(NOW - 60_000) }, { recordedAt: BOOT - HOUR }), { running: true, reason: '' })
})

test('an uptime counter that went backwards proves a reboot, whatever the wall clock says', () => {
  // Written when the machine had been up five hours; it has been up twenty minutes now. The
  // record's own time looks recent because the clock was set back since.
  assert.deepEqual(verdict(stamped({ uptime: 5 * 3600 })), { running: false, reason: 'previous_boot' })
  assert.deepEqual(verdict(stamped({ uptime: 15 * 60 })), { running: true, reason: '' })
  // Started soon after the previous boot, checked sooner after this one. Windows' counter is
  // monotonic, so five minutes backwards is a reboot there; where the counter may follow the
  // wall clock, the full margin applies.
  assert.deepEqual(verdict(stamped({ uptime: 25 * 60 })), { running: false, reason: 'previous_boot' })
  assert.deepEqual(verdict(stamped({ uptime: 25 * 60 }), { probe: { platform: 'darwin' } }), { running: true, reason: '' })
  // A stamped record written long before this boot by the clock, with the counter not gone
  // backwards, is not condemned by the clock: the program holding the pid decides instead.
  assert.deepEqual(verdict(stamped({ startedAt: iso(BOOT - 5 * HOUR), uptime: 60 })), { running: true, reason: '' })
  assert.deepEqual(verdict(stamped({ startedAt: iso(BOOT - 5 * HOUR), uptime: 60 }), { probe: { image: () => 'powershell.exe' } }),
    { running: false, reason: 'pid_reused' })
})

test('a pid held by a child this process started is not the process another workbench recorded', () => {
  // After a reboot, the workbench's own new Worker is the likeliest holder of a pid an old record
  // names, and it runs the same Node program, so the program name cannot tell them apart.
  assert.deepEqual(verdict(stamped({ pid: 4343 })), { running: false, reason: 'pid_reused' })
  assert.deepEqual(verdict({ role: 'agent', pid: 4343 }), { running: false, reason: 'pid_reused' })
  assert.deepEqual(verdict({ role: 'worker', pid: 4343, ...stamped({ session: 'this-process' }) }), { running: true, reason: '' })
})

test('Linux decides the boot by boot_id and the process by its start time, not by the clock', () => {
  const linux = { platform: 'linux' }
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(NOW), bootId: 'boot-before' }, { probe: linux }),
    { running: false, reason: 'previous_boot' })
  // Same boot: a wall clock moved forward since the record cannot make it look older than the boot.
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(BOOT - HOUR), bootId: 'boot-now', startTicks: '777' }, { probe: linux }),
    { running: true, reason: '' })
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(NOW), bootId: 'boot-now', startTicks: '12' }, { probe: linux }),
    { running: false, reason: 'pid_reused' })
  // A start time that cannot be read now is not evidence of anything.
  assert.deepEqual(verdict({ pid: 4242, startedAt: iso(NOW), bootId: 'boot-now', startTicks: '12' },
    { probe: { ...linux, startTicks: () => '' } }), { running: true, reason: '' })
})

test('Windows tells a reused pid by the program that holds it now', () => {
  assert.deepEqual(verdict(stamped()), { running: true, reason: '' })
  assert.deepEqual(verdict(stamped({ image: 'Node.EXE' })), { running: true, reason: '' })
  assert.deepEqual(verdict(stamped(), { probe: { image: () => 'powershell.exe' } }), { running: false, reason: 'pid_reused' })
  // `tasklist` unavailable or silent: unknown, so still running.
  assert.deepEqual(verdict(stamped(), { probe: { image: () => '' } }), { running: true, reason: '' })
  // A name outside plain ASCII could not be told from its own mis-decoding, so it is not compared.
  assert.deepEqual(verdict(stamped({ image: 'nöde.exe' }), { probe: { image: () => 'nÃ¶de.exe' } }), { running: true, reason: '' })
})

test('after a Windows shutdown with Fast Startup, a 0.9.1 record whose pid another program holds has ended', () => {
  // Fast Startup does not restart the uptime counter, so no boot rule can fire: the machine has
  // been "up" since before the record. Every process a workbench recorded ran its own Node.
  const fastStartup = { uptimeSeconds: () => 3 * 24 * 3600 }
  const record = { role: 'agent', pid: 4242 }
  const recordedAt = iso(NOW - 2 * HOUR)
  assert.deepEqual(verdict(record, { recordedAt, probe: { ...fastStartup, image: () => 'powershell.exe' } }),
    { running: false, reason: 'pid_reused' })
  assert.deepEqual(verdict(record, { recordedAt, probe: fastStartup }), { running: true, reason: '' },
    'a Node process under the pid may still be the recorded one')
})

test('what this process wrote is never dated by the wall clock: only a clock change could make it look older than the boot', () => {
  const own = { pid: 4242, startedAt: iso(BOOT - 5 * HOUR), uptime: 99_999, session: 'this-process', image: 'node.exe' }
  assert.deepEqual(verdict(own), { running: true, reason: '' })
  // Identity is still checked: a child of this process can exit and its pid be reused.
  assert.deepEqual(verdict(own, { probe: { image: () => 'code.exe' } }), { running: false, reason: 'pid_reused' })
})

test('a record naming this process\'s own pid is this process only if this process wrote it', () => {
  assert.deepEqual(verdict({ pid: 1000, session: 'this-process' }), { running: true, reason: '' })
  // A previous workbench that held the same pid before this one: it has ended, because this one holds it.
  assert.deepEqual(verdict({ pid: 1000, session: 'a-previous-workbench', startedAt: iso(NOW) }), { running: false, reason: 'pid_reused' })
  assert.deepEqual(verdict({ pid: 1000 }), { running: false, reason: 'pid_reused' })
})

test('a stamp names what this platform can check, and who wrote it', () => {
  const windows = processStamp(4242, {}, probe())
  assert.deepEqual(windows, { startedAt: iso(NOW), uptime: UPTIME_SECONDS, session: 'this-process', image: 'node.exe' })
  const linux = processStamp(4242, {}, probe({ platform: 'linux' }))
  assert.deepEqual(linux, { startedAt: iso(NOW), uptime: UPTIME_SECONDS, session: 'this-process', bootId: 'boot-now', startTicks: '777' })
  const other = processStamp(4242, {}, probe({ platform: 'darwin' }))
  assert.deepEqual(other, { startedAt: iso(NOW), uptime: UPTIME_SECONDS, session: 'this-process' })
  // Nothing a stamp says is invented for a process that cannot be read.
  assert.equal(processStamp(5555, {}, probe({ platform: 'linux', bootId: () => '' })).startTicks, undefined)
})

test('a Windows stamp names the entry script by its file name alone', () => {
  // The path the host spawned, or a process's own argv[1]; either separator.
  const spawned = 'C:\\Users\\op\\AppData\\Roaming\\npm\\\\node_modules\\rulith\\worker\\rulith-worker.mjs'
  assert.equal(processStamp(4242, { script: spawned }, probe()).script, 'rulith-worker.mjs')
  assert.equal(processStamp(4242, { script: 'D:/Work/rulith-runtime/local/rulith-local.mjs' }, probe()).script, 'rulith-local.mjs')
  // A process started without a script file names none.
  assert.equal('script' in processStamp(4242, { script: undefined }, probe()), false)
  assert.equal('script' in processStamp(4242, {}, probe()), false)
  // Only Windows reads it back, so only Windows writes it down.
  for (const platform of ['linux', 'darwin']) {
    assert.equal('script' in processStamp(4242, { script: spawned }, probe({ platform })), false, platform)
  }
})

// ── A Node process running another script (Windows) ─────────────────────────

/** A probe whose command-line reading is watched, for the arms that must not ask it at all. */
function watched(commandLine, overrides = {}) {
  const asked = []
  return { asked, probe: { ...overrides, commandLine: (pid, record) => { asked.push({ pid, record }); return commandLine } } }
}
/** Written this boot by a workbench that has since ended, naming the script its Agent ran. */
const agentRecord = (extra = {}) => stamped({ script: 'rulith-agent.mjs', ...extra })

test('after a Fast Startup shutdown, a recorded Agent whose pid an unrelated Node process holds has ended', () => {
  // The uptime counter did not restart and the program is Node either way: only the command line
  // can tell this Agent from Claude Code, an MCP server or a dev server.
  const fastStartup = { uptimeSeconds: () => 3 * 24 * 3600 }
  const record = agentRecord({ uptime: 2 * 24 * 3600 })
  const { asked, probe: claudeCode } = watched('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', fastStartup)
  assert.deepEqual(verdict(record, { probe: claudeCode }), { running: false, reason: 'pid_reused' })
  assert.deepEqual(asked.map((call) => [call.pid, call.record.script]), [[4242, 'rulith-agent.mjs']])
  assert.deepEqual(verdict(record, { probe: { ...fastStartup, commandLine: () => 'node.exe D:\\projects\\site\\node_modules\\vite\\bin\\vite.js' } }),
    { running: false, reason: 'pid_reused' })
})

test('the same script under the pid is still the recorded process, however its path is spelled', () => {
  // npm's shim doubles a backslash; a junction or an 8.3 name spells the directories otherwise.
  // Only the file name is compared, and without regard to case.
  assert.deepEqual(verdict(agentRecord()), { running: true, reason: '' })
  for (const line of [
    'node C:\\PROGRA~1\\rulith\\agent\\rulith-agent.mjs --serve',
    '"C:\\Program Files\\nodejs\\node.exe" D:\\links\\rulith\\agent\\Rulith-Agent.MJS --serve',
    'node.exe D:/Work/rulith-runtime/agent/rulith-agent.mjs',
  ]) {
    assert.deepEqual(verdict(agentRecord(), { probe: { commandLine: () => line } }), { running: true, reason: '' }, line)
  }
})

test('a command line that cannot be read proves nothing', () => {
  // An elevated process, a process that exited meanwhile, PowerShell unavailable: all are ''.
  assert.deepEqual(verdict(agentRecord(), { probe: { commandLine: () => '' } }), { running: true, reason: '' })
})

test('a record that names no script, or one outside plain ASCII, is not asked about its command line', () => {
  const unrelated = '"C:\\Program Files\\nodejs\\node.exe" C:\\tools\\mcp-server\\index.js'
  // A stamp from before scripts were recorded, a record as 0.9.1 wrote it, and a stamp whose
  // script is empty or not a name at all.
  for (const record of [stamped(), { role: 'agent', pid: 4242 }, agentRecord({ script: '' }), agentRecord({ script: 42 })]) {
    const { asked, probe: seen } = watched(unrelated)
    assert.deepEqual(verdict(record, { probe: seen, recordedAt: iso(NOW - 60_000) }), { running: true, reason: '' }, JSON.stringify(record))
    assert.equal(asked.length, 0, JSON.stringify(record))
  }
  // A name PowerShell's output could spell differently is not compared.
  const { asked, probe: seen } = watched(unrelated)
  assert.deepEqual(verdict(agentRecord({ script: 'rulith-ägent.mjs' }), { probe: seen }), { running: true, reason: '' })
  assert.equal(asked.length, 0)
})

test('the command line is asked only when the recorded program holds the pid, and only on Windows', () => {
  const unrelated = 'node.exe C:\\tools\\dev-server.js'
  // A different program already proves the record gone, and an unknown one proves nothing: in
  // neither case is the command line read.
  for (const [image, expected] of [['powershell.exe', { running: false, reason: 'pid_reused' }], ['', { running: true, reason: '' }]]) {
    const { asked, probe: seen } = watched(unrelated, { image: () => image })
    assert.deepEqual(verdict(agentRecord(), { probe: seen }), expected, image)
    assert.equal(asked.length, 0, image)
  }
  // Linux decides by start time, and macOS has no program check at all: a reused pid there still
  // counts as running.
  for (const platform of ['linux', 'darwin']) {
    const { asked, probe: seen } = watched(unrelated, { platform })
    assert.deepEqual(verdict(agentRecord(), { probe: seen }), { running: true, reason: '' }, platform)
    assert.equal(asked.length, 0, platform)
  }
})

test('what this process wrote about itself, or about a child it still runs, is not asked about', () => {
  const unrelated = 'node.exe C:\\tools\\dev-server.js'
  const { asked, probe: seen } = watched(unrelated)
  // Its own record: this process holds its own pid.
  assert.deepEqual(verdict(agentRecord({ pid: 1000, session: 'this-process', script: 'rulith-local.mjs' }), { probe: seen }),
    { running: true, reason: '' })
  // Its record of a child it started and has not seen exit: that child holds the pid.
  assert.deepEqual(verdict(agentRecord({ pid: 4343, session: 'this-process', script: 'rulith-worker.mjs' }), { probe: seen }),
    { running: true, reason: '' })
  assert.equal(asked.length, 0)
  // Another process's record of either pid was never about them, and is answered before any of this.
  assert.deepEqual(verdict(agentRecord({ pid: 1000 }), { probe: seen }), { running: false, reason: 'pid_reused' })
  assert.deepEqual(verdict(agentRecord({ pid: 4343 }), { probe: seen }), { running: false, reason: 'pid_reused' })
  assert.equal(asked.length, 0)
  // A record this process wrote of a pid no child of its holds any more is asked like any other.
  assert.deepEqual(verdict(agentRecord({ session: 'this-process' }), { probe: seen }), { running: false, reason: 'pid_reused' })
  assert.equal(asked.length, 1)
})

// ── Real processes on this machine ───────────────────────────────────────────

const identitySupported = process.platform === 'linux' || process.platform === 'win32'

async function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  t.after(() => child.kill())
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail) })
  return child
}

test('a genuinely running child, stamped as the host stamps it, is running', async (t) => {
  const child = await sleeper(t)
  const stamp = processStamp(child.pid)
  assert.equal(stamp.session, PROCESS_SESSION)
  // As another workbench would read it after this one crashed: a foreign writer.
  const record = { role: 'worker', pid: child.pid, ...stamp, session: 'a-crashed-workbench' }
  assert.deepEqual(processRecordVerdict(record), { running: true, reason: '' })
  const exited = new Promise((done) => child.once('exit', done))
  child.kill()
  await exited
  assert.equal(processAlive(child.pid), false)
  assert.deepEqual(processRecordVerdict(record), { running: false, reason: 'not_running' })
})

test('a live pid recorded before this boot is not the recorded process', async (t) => {
  const child = await sleeper(t)
  const beforeBoot = iso(Date.now() - uptime() * 1000 - BOOT_MARGIN_MS - HOUR)
  assert.deepEqual(processRecordVerdict({ role: 'agent', pid: child.pid, startedAt: beforeBoot }),
    { running: false, reason: 'previous_boot' })
  assert.deepEqual(processRecordVerdict({ role: 'agent', pid: child.pid }, { recordedAt: beforeBoot }),
    { running: false, reason: 'previous_boot' })
})

test('a live pid now held by a different process is not the recorded process', { skip: !identitySupported && 'no cheap process identity on this platform' }, async (t) => {
  const child = await sleeper(t)
  const stamp = { ...processStamp(child.pid), session: 'a-crashed-workbench' }
  // What the record would say had the pid belonged to another program when it was written.
  const other = process.platform === 'linux'
    ? { ...stamp, startTicks: String(BigInt(stamp.startTicks ?? '0') + 1n) }
    : { ...stamp, image: 'rulith-recorded-agent.exe' }
  assert.deepEqual(processRecordVerdict({ role: 'agent', pid: child.pid, ...other }), { running: false, reason: 'pid_reused' })
  assert.deepEqual(processRecordVerdict({ role: 'agent', pid: child.pid, ...stamp }), { running: true, reason: '' })
})

test('on Windows, a Node process running another script under a recorded pid is not the recorded process',
  { skip: process.platform !== 'win32' && 'the command-line rule is Windows only' }, async (t) => {
  // A real Node process with a script of its own, standing for the dev server that was given the pid.
  const directory = mkdtempSync(join(tmpdir(), 'rulith-identity-'))
  const script = join(directory, 'unrelated-dev-server.mjs')
  writeFileSync(script, 'setInterval(() => {}, 1000)\n')
  const child = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise((done) => child.once('exit', done))
  t.after(async () => { child.kill(); await exited; rmSync(directory, { recursive: true, force: true }) })
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail) })
  // Stamped as a host stamps the role it spawns, by a workbench that has since ended; the image
  // check alone cannot tell these two apart, since both are Node.
  const stamp = { ...processStamp(child.pid, { script }), session: 'a-crashed-workbench' }
  assert.equal(stamp.script, 'unrelated-dev-server.mjs')
  assert.deepEqual(processRecordVerdict({ role: 'worker', pid: child.pid, ...stamp, script: 'rulith-worker.mjs' }),
    { running: false, reason: 'pid_reused' })
  assert.deepEqual(processRecordVerdict({ role: 'worker', pid: child.pid, ...stamp }), { running: true, reason: '' })
})
