// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from 'node:child_process'

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
