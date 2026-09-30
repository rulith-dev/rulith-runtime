// SPDX-License-Identifier: Apache-2.0
/**
 * Is a process this workbench wrote down earlier still that same process?
 *
 * The workbench records the processes it runs: its own, in lock tickets and instance markers,
 * and every Agent and Worker it starts. A later run reads those records to refuse opening a
 * second host over children that are still executing, and a sign-out reads them to refuse
 * clearing credentials that a live process still holds. A pid alone answers that badly.
 * Operating systems reuse pids, and Windows does it promptly: after a reboot, the pid recorded
 * for an Agent belonged to an unrelated PowerShell, and the workbench refused to reset its sign-in
 * until the operator found and closed that terminal.
 *
 * So each record carries what identified the process when it was written, and a check asks
 * whether the process holding that pid now is still the recorded one. Every rule here only ever
 * proves that a recorded process is gone:
 *
 *   · **Not running.** The kernel says no process has that pid. Nothing else is asked.
 *   · **This process, or a child it started, holds the pid.** A pid belongs to one process at a
 *     time, so a record of that pid written by any other process names a process that has ended.
 *   · **Recorded before this boot.** No process survives a reboot. Linux names each boot exactly
 *     (`boot_id`). Elsewhere a stamped record is dated by the uptime counter, which no clock
 *     change moves: a counter now lower than when the record was written has restarted.
 *   · **A different program holds the pid now.** Linux names each process's start time in clock
 *     ticks since boot, so another start time is another process. Windows gives no start time
 *     without a heavy call, but `tasklist` names the program that holds a pid, and a recorded Node
 *     process whose pid now runs `powershell.exe` has ended. A Windows shutdown with Fast Startup
 *     does not restart the uptime counter, and this is the evidence that still works there.
 *   · **On Windows, a Node process running another script holds the pid now.** Every process a
 *     workbench records is Node, and so are many unrelated ones on a developer's machine — Claude
 *     Code, MCP servers, dev servers — so after a Fast Startup shutdown the program name alone left
 *     such a record looking alive, and with it a workbench's claim that Windows had ended without
 *     releasing it. A record therefore also names the entry script its process runs (`script`:
 *     `rulith-local.mjs`, `rulith-agent.mjs`, `rulith-worker.mjs`), and a Node process whose
 *     command line does not mention that file name is another process. Only the file name is
 *     compared, never the path: npm's shim reaches the same script through a path with a doubled
 *     backslash, and junctions and 8.3 short names give it other spellings still. A path that
 *     failed to match would declare a live workbench gone, and a second one would take its claim.
 *
 * Records written before 0.9.2 carry no stamp. For them alone, the wall clock stands in: a record
 * older than `Date.now() - os.uptime()` by more than a margin was written before this boot, and on
 * Windows the program they named was this workbench's own Node executable. They name no script,
 * and nor does a stamp written without one — before scripts were recorded, or by a process that was
 * not started from a script file: for those the program name is the last evidence, as it was.
 *
 * Anything else stays "may be running", and callers keep their conservative answer: refusing to
 * sign out, or to open a second host, until somebody looks. The opposite mistake would clear the
 * credentials of a live process, or open a second host over it, so doubt resolves toward running.
 *
 * 中文说明（维护者）：
 *   · 只做"证明已结束"的判断。无法确认时一律按"可能仍在运行"处理，由调用方保持原有的保守拒绝。
 *   · 墙钟会被校时、虚拟机挂起恢复等改写：开机时间 = 现在 − uptime，墙钟向前跳过之后，一条仍在运行的
 *     进程的记录会显得"早于开机"。所以带时间戳的新记录只用不受墙钟影响的证据：Linux 的 boot_id，其他平台
 *     uptime 计数是否倒退，以及 pid 现在属于哪个程序。墙钟规则只用于没有时间戳的旧记录（0.9.1 及更早）；
 *     旧记录在重启之后就不会再挡住操作。
 *   · 本进程自己写下的记录（session 相同）永远不按开机时间判断：本进程在记录时和现在都活着，中间不可能重启。
 *   · 本进程启动的子进程正在使用的 pid，如果出现在别的进程写下的记录里，那条记录的进程必然已经结束。
 *   · Windows 上持有 pid 的同样是 node.exe 时，再读它的命令行：记录里写着该进程运行的入口脚本文件名
 *     （script），命令行里没有这个文件名，就是另一个进程。只比较文件名、不比较完整路径：npm 的 cmd 垫片
 *     会产生双反斜杠的路径，还有 junction 和 8.3 短路径；完整路径对不上会把一个仍在运行的工作台判成已结束，
 *     第二个工作台随即拿走它的租约。命令行读不到（例如提权进程）或为空时，一律按"可能仍在运行"处理。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { uptime as systemUptime } from 'node:os'
import { basename, join, win32 } from 'node:path'

/**
 * How much earlier than this boot, by the wall clock, a record without a stamp must be before it
 * is proven stale. It absorbs the resolution of the uptime counter and ordinary clock corrections.
 */
export const BOOT_MARGIN_MS = 10 * 60_000
/**
 * How far the uptime counter must have gone backwards to prove a reboot.
 *
 * Windows (`GetTickCount64`) and Linux (`CLOCK_BOOTTIME`) count monotonically from boot, sleep
 * included, whatever the wall clock does, so a small allowance is enough there. Elsewhere the
 * counter may be derived from the wall clock, and the full margin applies.
 */
const uptimeMarginMs = (platform) => (platform === 'win32' || platform === 'linux' ? 60_000 : BOOT_MARGIN_MS)

/** Who wrote a record: fresh for every process, so a record written by this one is recognised. */
export const PROCESS_SESSION = randomUUID()

/**
 * Is there any process with this pid right now?
 *
 * `kill(pid, 0)` sends no signal and only asks the kernel. `EPERM` means the process exists and
 * belongs to somebody else, which is still "alive" — answering `false` there would let one
 * account's manager steal another's instance directory.
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * The pids of the children this process started and has not yet seen exit.
 *
 * Kept by the host that spawns the roles (`noteChildStarted` / `noteChildExited`). While one of
 * them runs, no other process can hold its pid, so a record of that pid written by any other
 * process is proven to name a process that has ended: after a reboot, the workbench's own new
 * Agent or Worker is the likeliest holder of a pid an old record names.
 */
const startedChildren = new Set()
export const noteChildStarted = (pid) => { if (Number.isInteger(pid) && pid > 0) startedChildren.add(pid) }
export const noteChildExited = (pid) => { startedChildren.delete(pid) }

const text = (value) => (typeof value === 'string' ? value : '')
/**
 * Plain printable ASCII: the only names compared with what another program reported, because a
 * name with other characters could not be told apart from its own mis-decoding.
 */
const PLAIN_ASCII = /^[\x20-\x7e]+$/

function linuxBootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return '' }
}

/**
 * Field 22 of `/proc/<pid>/stat`: when the process started, in clock ticks since boot.
 *
 * The command name (field 2) is in parentheses and may itself contain spaces and parentheses,
 * so the fields are counted from the last `)`. Kept as a decimal string: it is compared, never
 * converted.
 */
function linuxStartTicks(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
    return /^\d+$/.test(value) ? value : ''
  } catch { return '' }
}

/**
 * The program holding `pid` on Windows, lower-cased, or '' when that cannot be told.
 *
 * One `tasklist` call, about a quarter of a second, reached only when every cheaper test left a
 * record looking alive.
 */
function windowsImage(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  try {
    const output = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
      ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
      { encoding: 'latin1', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    // One CSV row per match: "image","pid","session name","session#","memory". When nothing
    // matches, tasklist prints a localized sentence instead, which parses as no row: unknown.
    for (const line of output.split(/\r?\n/)) {
      const row = /^"((?:[^"]|"")*)","(\d+)",/.exec(line)
      if (row !== null && Number(row[2]) === pid) return row[1].replaceAll('""', '"').toLowerCase()
    }
  } catch { /* unknown */ }
  return ''
}

/**
 * What `tasklist` said about one record's pid, kept for a few seconds.
 *
 * Keyed by the record as well as the pid, so an answer about one record is never read as one
 * about another: a pid can be recycled to a newer process within seconds, and an answer taken
 * before that newer process started would say nothing about it. For the same record, a "different
 * program" answer stays true for ever (that process had ended), and a "same program" one is at
 * worst a few seconds too conservative. A lock being waited on is asked about repeatedly, which is
 * what this is for.
 */
const IMAGE_CACHE_MS = 5_000
const imageAnswers = new Map()
/** Which record an answer about `pid` was asked for: the pid, and what dates the record. */
const recordKey = (pid, record) => `${pid}|${text(record?.session)}|${text(record?.startedAt)}|${text(String(record?.at ?? ''))}`
function cachedWindowsImage(pid, record) {
  const key = recordKey(pid, record)
  const cached = imageAnswers.get(key)
  if (cached !== undefined && performance.now() - cached.at < IMAGE_CACHE_MS) return cached.image
  const image = windowsImage(pid)
  if (imageAnswers.size >= 256) imageAnswers.clear()
  imageAnswers.set(key, { image, at: performance.now() })
  return image
}

/**
 * Does this command line run the entry script a record names? By file name alone, ignoring case.
 *
 * Contained anywhere in the line, not parsed out of it: a line that merely mentions the name is
 * read as running it, which only ever keeps a record alive.
 */
const runsScript = (commandLine, script) => commandLine.toLowerCase().includes(script.toLowerCase())

/**
 * Printed before the command line, so that nothing else PowerShell may write to standard output —
 * a warning, a notice about loading a module — is ever read as a command line. Only the text after
 * this mark counts; without the mark the answer is unknown.
 */
const COMMAND_LINE_MARK = 'rulith-command-line:'

/**
 * The command line of the process holding `pid` on Windows, or '' when that cannot be told.
 *
 * One PowerShell call, about a third of a second (0.32 s warm and 0.45 s cold on the machine this
 * was written on), reached only when `tasklist` has already named the recorded program, Node, as
 * the holder of a pid that neither this process nor a child it started holds. The pid reaches the
 * filter only as a checked positive integer. A process this account may not inspect, such as an
 * elevated one, reports no command line, and a process that exited meanwhile reports nothing: both
 * are '' — unknown.
 */
function windowsCommandLine(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return ''
  try {
    const output = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
          + ` if ($p) { '${COMMAND_LINE_MARK}' + $p.CommandLine }`],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const at = output.indexOf(COMMAND_LINE_MARK)
    return at < 0 ? '' : output.slice(at + COMMAND_LINE_MARK.length).trim()
  } catch { return '' }
}

/**
 * What PowerShell said about one record's pid, kept as `tasklist`'s answer is and for the same
 * reason: a lock being waited on is asked about repeatedly.
 *
 * Keyed by the record like the image answer, and by the script the record names, because what
 * decides how long an answer is kept is whether that script is in it. A command line that does not
 * run the recorded script stays the answer for that record for good — the recorded process had
 * ended when it was read, and an ended process does not come back. Any other answer, the same
 * script or nothing readable, is asked again after a few seconds.
 */
const COMMAND_LINE_CACHE_MS = 5_000
const commandLineAnswers = new Map()
function cachedWindowsCommandLine(pid, record) {
  const script = text(record?.script)
  const key = `${recordKey(pid, record)}|${script}`
  const cached = commandLineAnswers.get(key)
  if (cached !== undefined && (cached.final || performance.now() - cached.at < COMMAND_LINE_CACHE_MS)) return cached.commandLine
  const commandLine = windowsCommandLine(pid)
  if (commandLineAnswers.size >= 256) commandLineAnswers.clear()
  commandLineAnswers.set(key, { commandLine, at: performance.now(),
    final: commandLine !== '' && script !== '' && !runsScript(commandLine, script) })
  return commandLine
}

/** The platform facts a verdict reads. Tests substitute their own; the product uses these. */
export const systemProcessProbe = Object.freeze({
  platform: process.platform,
  pid: process.pid,
  session: PROCESS_SESSION,
  now: () => Date.now(),
  uptimeSeconds: () => systemUptime(),
  alive: processAlive,
  startedChildren: () => startedChildren,
  bootId: linuxBootId,
  startTicks: linuxStartTicks,
  image: cachedWindowsImage,
  execImage: () => basename(process.execPath).toLowerCase(),
  commandLine: cachedWindowsCommandLine,
})

/**
 * What identifies process `pid` now, to be written down beside it.
 *
 * Called by the process that knows `pid` is the process it means: the host, right after it
 * spawned a role with this same Node executable, and a process about itself. `startedAt` is when
 * the record was made, which is after the process started and therefore after this boot.
 *
 * `script` is the entry script that process runs: the path the host spawned the role with, or a
 * process's own `process.argv[1]`. Only its file name is written down, and only on Windows, the one
 * platform that reads it back (see `processRecordVerdict`).
 */
export function processStamp(pid, { script } = {}, probe = systemProcessProbe) {
  const stamp = { startedAt: new Date(probe.now()).toISOString(), uptime: Math.floor(probe.uptimeSeconds()), session: probe.session }
  if (probe.platform === 'linux') {
    const bootId = probe.bootId(), startTicks = probe.startTicks(pid)
    if (bootId !== '') stamp.bootId = bootId
    if (startTicks !== '') stamp.startTicks = startTicks
  }
  if (probe.platform === 'win32') {
    stamp.image = probe.execImage()
    // `win32.basename` splits on both separators, whichever the path was written with.
    const name = win32.basename(text(script))
    if (name !== '') stamp.script = name
  }
  return stamp
}

/** The earliest parsable time among several, as epoch milliseconds, or NaN. */
export function earliestTime(...values) {
  const times = values.map((value) => (typeof value === 'number' ? value : Date.parse(text(value)))).filter(Number.isFinite)
  return times.length === 0 ? NaN : Math.min(...times)
}

const running = { running: true, reason: '' }
const gone = (reason) => ({ running: false, reason })

/**
 * May the process a record names still be running — and if not, which evidence says so.
 *
 * `recordedAt` dates a record written before stamps existed: the time the marker it sits in was
 * written (epoch milliseconds or an ISO string). The process existed then, so a time before this
 * boot proves it has ended. It is not used for a stamped record.
 *
 * Returns `{ running, reason }`, where `reason` is `not_running`, `pid_reused` or
 * `previous_boot` when `running` is false, and '' otherwise.
 */
export function processRecordVerdict(record, { recordedAt, probe = systemProcessProbe } = {}) {
  const pid = record?.pid
  if (!probe.alive(pid)) return gone('not_running')
  const own = text(record.session) !== '' && record.session === probe.session
  if (pid === probe.pid) return own ? running : gone('pid_reused')
  if (!own && probe.startedChildren().has(pid)) return gone('pid_reused')
  // A record written before 0.9.2: no stamp of its own, only the date of its marker.
  const stamped = text(record.session) !== ''
  if (!own) {
    const bootId = text(record.bootId), currentBoot = bootId === '' ? '' : probe.bootId()
    const uptimeMs = probe.uptimeSeconds() * 1000
    if (bootId !== '' && currentBoot !== '') {
      // Exact, and independent of any clock: a different boot, or this very one.
      if (bootId !== currentBoot) return gone('previous_boot')
    } else if (stamped) {
      // The uptime counter only grows within one boot, whatever the wall clock does. A clock set
      // forward, or a virtual machine resumed after a pause, moves `Date.now() - os.uptime()` and
      // would make a live process's record look older than the boot; this counter does not move.
      const recordedUptime = Number(record.uptime)
      if (Number.isFinite(recordedUptime) && uptimeMs < recordedUptime * 1000 - uptimeMarginMs(probe.platform)) {
        return gone('previous_boot')
      }
    } else {
      const written = earliestTime(record.startedAt ?? recordedAt)
      if (Number.isFinite(written) && written < probe.now() - uptimeMs - BOOT_MARGIN_MS) return gone('previous_boot')
    }
  }
  if (probe.platform === 'linux' && text(record.startTicks) !== '') {
    const current = probe.startTicks(pid)
    if (current !== '' && current !== record.startTicks) return gone('pid_reused')
  }
  if (probe.platform === 'win32') {
    // Every process a workbench records was started from its own Node executable, and a record
    // from before 0.9.2 did not say which: the one running this workbench is what it was.
    const expected = (stamped ? text(record.image) : probe.execImage()).toLowerCase()
    // `tasklist` output is read as Latin-1, so only a name in plain ASCII is compared: one with
    // other characters could not be told apart from its own mis-decoding.
    if (PLAIN_ASCII.test(expected)) {
      const current = probe.image(pid, record)
      if (current !== '' && current !== expected) return gone('pid_reused')
      // The recorded program holds the pid: Node, like much else on a developer's machine. A
      // stamped record that names its entry script is then asked which script the holder runs,
      // by file name (see the header); a command line that cannot be read, or is empty, proves
      // nothing. Not asked when the program could not be told, when the record names no script
      // or one outside plain ASCII, or when a child this process started holds the pid. A record
      // another process wrote of that pid was answered above; one this process wrote stays
      // running as it always did — the host rewrites its records whenever a child starts or
      // exits, so its record of that pid is its record of that child.
      const script = text(record.script)
      if (stamped && current === expected && PLAIN_ASCII.test(script) && !probe.startedChildren().has(pid)) {
        const commandLine = probe.commandLine(pid, record)
        if (commandLine !== '' && !runsScript(commandLine, script)) return gone('pid_reused')
      }
    }
  }
  return running
}

/** `processRecordVerdict(...).running`, for callers that only need the answer. */
export const processRecordRunning = (record, options) => processRecordVerdict(record, options).running

/**
 * When the processes listed under an instance marker were known to exist, for children recorded
 * without a stamp of their own.
 *
 * `runtime.startedAt` is written together with the `runtime.children` it lists, and an `orphaned`
 * marker only ever copies children out of that same `runtime`, so it dates both lists. A row-level
 * `unobservedAt` is not used: it can outlive the marker it was written with.
 */
export const instanceRecordedAt = (row) => {
  const recorded = earliestTime(row?.runtime?.startedAt)
  return Number.isFinite(recorded) ? recorded : earliestTime(row?.orphaned?.observedAt)
}
