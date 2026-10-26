// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './manager-registry.mjs'
import { UNCONFINED_MARK_ENV } from '../worker/adapter-confinement.mjs'

/** End a bounded local command and every child it created. */
export async function stopProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    await new Promise(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => resolve()))
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
}
export function runBounded(command, args, { timeoutMs, maxBytes, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let bytes = 0, output = '', timedOut = false
    const append = chunk => { bytes += chunk.length; if (bytes <= maxBytes) output += chunk.toString('utf8') }
    child.stdout.on('data', append); child.stderr.on('data', append)
    const timer = setTimeout(() => { timedOut = true; void stopProcessTree(child) }, timeoutMs)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (timedOut) reject(new Error(`local_authoring_timeout: checker exceeded ${timeoutMs}ms.`)); else if (bytes > maxBytes) reject(new Error('local_authoring_output_too_large')); else if (code !== 0) reject(new Error(`local_authoring_checker_failed: exit ${code}. ${output.slice(0, 500)}`)); else resolve(output) })
  })
}

// ── What model commands left running while isolation was off (PSC 0.2.31 ③, ACC-ISO-14) ─────────────────────────
//
// 中文说明：负责人关掉隔离期间，Worker 每次不隔离地启动适配器都报给宿主（pid、启动与结束时间、本次启动的标记），记在
// 实例目录（凭据根内，受限命令读写不到）。重新要求隔离时，在受限的 Worker 启动之前，宿主据此结束这些适配器留下的整棵
// 进程树——包括脱离了父进程、在适配器退出后还在跑的后台作业：Windows 上按父进程号与创建时间追到底（父进程已退出也行，
// 只认在它持有那个 pid 期间创建的子进程），Linux 上另按环境变量里的标记在 /proc 里找（脱离的进程会被别的进程收养）。
// 结束不了的如实报告。

/** The record of unconfined Adapter starts, in an instance's directory (a credential root). */
export const UNCONFINED_RECORDS = 'unconfined-processes.json'
const MAX_UNCONFINED_RECORDS = 2000
const positive = (value) => Number.isSafeInteger(value) && value > 0
const MARK = /^[0-9a-f]{32}$/

/** The recorded starts, `[{ pid, startedAt, endedAt?, mark? }]`; anything malformed is left out. */
export function readUnconfinedRecords(file) {
  let rows
  try { rows = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  return (Array.isArray(rows) ? rows : []).filter((row) => row && positive(row.pid) && Number.isFinite(row.startedAt)
    && (row.endedAt === undefined || Number.isFinite(row.endedAt)) && (row.mark === undefined || MARK.test(row.mark)))
}
/** Record one Adapter the Worker started without isolation (its own report, over IPC). */
export function noteUnconfinedStart(file, { pid, startedAt, mark } = {}) {
  if (!positive(pid) || !Number.isFinite(startedAt) || (mark !== undefined && !MARK.test(mark))) return
  const rows = [...readUnconfinedRecords(file), { pid, startedAt, ...(mark ? { mark } : {}) }].slice(-MAX_UNCONFINED_RECORDS)
  writeJsonAtomic(file, rows)
}
/** Record when that Adapter exited: its children are the processes it started while it held that pid. */
export function noteUnconfinedEnd(file, { pid, endedAt } = {}) {
  if (!positive(pid) || !Number.isFinite(endedAt)) return
  const rows = readUnconfinedRecords(file)
  const row = rows.findLast((entry) => entry.pid === pid && entry.endedAt === undefined && entry.startedAt <= endedAt)
  if (!row) return
  row.endedAt = endedAt
  writeJsonAtomic(file, rows)
}

/**
 * The live processes the recorded starts account for. `table` is `[{ pid, ppid, createdAt, name, mark? }]` (createdAt
 * in epoch ms). A process is one when it is a recorded Adapter still running (same pid, created when it was started),
 * a child created while a recorded Adapter held its pid (that Adapter may have exited since; a pid taken over by an
 * unrelated process later closes the window), a process carrying a recorded start's mark (Linux), or a descendant of
 * one of these created after it. This process and its parent never are. Pure.
 */
export function unconfinedMembers(table, records, { self = [process.pid, process.ppid] } = {}) {
  const byPid = new Map(table.map((row) => [row.pid, row]))
  const marks = new Set(records.map((record) => record.mark).filter(Boolean))
  const isAdapter = (row, record) => row.pid === record.pid && row.createdAt >= record.startedAt - 2000 && row.createdAt <= record.startedAt + 1000
  const members = new Map()
  const add = (row) => {
    if (self.includes(row.pid) || members.has(row.pid)) return false
    members.set(row.pid, row)
    return true
  }
  for (const record of records) {
    const holder = byPid.get(record.pid)
    const until = Math.min(record.endedAt ?? Infinity, holder && !isAdapter(holder, record) ? holder.createdAt : Infinity)
    for (const row of table) {
      if (isAdapter(row, record)) add(row)
      else if (row.ppid === record.pid && row.createdAt >= record.startedAt - 500 && row.createdAt <= until) add(row)
    }
  }
  for (const row of table) if (row.mark && marks.has(row.mark)) add(row)
  for (let grew = true; grew;) {
    grew = false
    for (const row of table) {
      const parent = members.get(row.ppid)
      if (parent && row.createdAt >= parent.createdAt && add(row)) grew = true
    }
  }
  return [...members.values()]
}

const PROCESS_LINE = 'rulith-process:'
const WINDOWS_PROCESSES = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object {`
  + ` if ($_.CreationDate) { '${PROCESS_LINE}' + $_.ProcessId + ' ' + $_.ParentProcessId + ' '`
  + ` + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + ' ' + $_.Name } }`
/** This computer's processes: `[{ pid, ppid, createdAt, name, mark? }]`. Windows and Linux; elsewhere none. Throws when they cannot be read. */
export function processTable({ platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'win32') {
    const output = String(run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESSES],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
    const rows = []
    for (const line of output.split(/\r?\n/)) {
      const match = /^rulith-process:(\d+) (\d+) (-?\d+) (.*)$/.exec(line.trim())
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), createdAt: Number(match[3]), name: match[4].slice(0, 100) })
    }
    if (!rows.length) throw new Error('the process list could not be read')
    return rows
  }
  if (platform === 'linux') {
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    if (!Number.isFinite(boot)) throw new Error('the process list could not be read')
    const ticks = 100
    const rows = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (fields[0] === 'Z' || fields[0] === 'X') continue
        let mark
        try {
          const found = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').find((pair) => pair.startsWith(UNCONFINED_MARK_ENV + '='))
          const value = found?.slice(UNCONFINED_MARK_ENV.length + 1)
          if (value && MARK.test(value)) mark = value
        } catch { /* another account's process */ }
        let name = ''
        try { name = readFileSync(`/proc/${entry}/comm`, 'utf8').trim().slice(0, 100) } catch { /* exited meanwhile */ }
        rows.push({ pid: Number(entry), ppid: Number(fields[1]), createdAt: boot * 1000 + Math.round(Number(fields[19]) * 1000 / ticks), name,
          ...(mark ? { mark } : {}) })
      } catch { /* exited meanwhile */ }
    }
    return rows
  }
  return []
}

/** End these processes and everything they started: Windows `taskkill /T /F` from each topmost one, elsewhere SIGKILL each. */
export function killProcesses(members, { platform = process.platform, run = execFileSync } = {}) {
  const pids = new Set(members.map((row) => row.pid))
  if (platform === 'win32') {
    for (const row of members.filter((member) => !pids.has(member.ppid))) {
      try {
        run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(row.pid), '/T', '/F'],
          { windowsHide: true, timeout: 30_000, stdio: 'ignore' })
      } catch { /* what is left is found below */ }
    }
    return
  }
  for (const row of members) { try { process.kill(row.pid, 'SIGKILL') } catch { /* what is left is found below */ } }
}

/**
 * End what the recorded unconfined starts left running, then say what was stopped and what was not: `{ at, stopped,
 * failed, error? }` with `{ pid, name }` rows, or `null` when nothing was recorded. The record is removed once nothing
 * it accounts for is left; it is kept, for the next attempt, when something could not be stopped or the process list
 * could not be read.
 */
export function sweepUnconfined(file, { table = processTable, kill = killProcesses, now = Date.now } = {}) {
  const records = readUnconfinedRecords(file)
  if (!records.length) return null
  const view = (row) => ({ pid: row.pid, name: row.name ?? '' })
  let members, left
  try {
    members = unconfinedMembers(table(), records)
    if (members.length) kill(members)
    const after = members.length ? table() : []
    left = members.filter((row) => after.some((other) => other.pid === row.pid && other.createdAt === row.createdAt))
  } catch (error) {
    return { at: now(), stopped: [], failed: [], error: String(error?.message ?? error).slice(0, 200) }
  }
  if (!left.length) rmSync(file, { force: true })
  return { at: now(), stopped: members.filter((row) => !left.includes(row)).map(view), failed: left.map(view) }
}
