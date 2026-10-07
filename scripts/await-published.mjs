// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const POLL_INTERVAL_MS = 15_000
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const TAG_PATTERN = /^[A-Za-z0-9._-]+$/

const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds))

export async function awaitPublished({
  version,
  tag = 'next',
  view,
  sleep = pause,
  now = Date.now,
  timeoutMs = 900_000,
  onProgress = message => console.log(message),
}) {
  if (!VERSION_PATTERN.test(version ?? '')) throw new Error('version must be a major.minor.patch number')
  if (!TAG_PATTERN.test(tag ?? '')) throw new Error('tag must contain only letters, numbers, dots, underscores, or hyphens')
  if (typeof view !== 'function') throw new TypeError('view must be a function')

  const deadline = now() + timeoutMs
  let poll = 0
  while (now() < deadline) {
    poll += 1

    let publishedVersion
    try { publishedVersion = await view(['view', `rulith@${version}`, 'version', '--json', '--prefer-online']) } catch { /* registry may not have the version yet */ }
    if (publishedVersion === version) {
      let tags
      try { tags = await view(['view', 'rulith', 'dist-tags', '--json', '--prefer-online']) } catch { /* retry after the registry catches up */ }
      if (tags?.[tag] === version) {
        onProgress(`npm registry poll ${poll}: rulith@${version} and tag ${tag} are visible`)
        return
      }
      onProgress(`npm registry poll ${poll}: rulith@${version} is visible; waiting for tag ${tag}`)
    } else {
      onProgress(`npm registry poll ${poll}: waiting for rulith@${version}`)
    }

    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(POLL_INTERVAL_MS, remaining))
  }

  throw new Error(`Timed out waiting for rulith@${version} and the ${tag} tag to appear on npm.`)
}

function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) return spawnSync(process.execPath, [npmExecPath, ...args], options)
  if (process.platform === 'win32')
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], options)
  return spawnSync('npm', args, options)
}

function npmView(args) {
  const options = { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }
  const result = runNpm(args, options)

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `npm ${args.join(' ')} failed`)
  try { return JSON.parse(result.stdout.trim()) } catch (error) {
    throw new Error(`npm view returned invalid JSON: ${error.message}`)
  }
}

function parseArguments(args) {
  const usage = 'Usage: node scripts/await-published.mjs <version> [--tag next] [--timeout-seconds 900]'
  const version = args.shift()
  if (!VERSION_PATTERN.test(version ?? '')) throw new Error(usage)
  let tag = 'next'
  let timeoutSeconds = 900
  while (args.length > 0) {
    const option = args.shift()
    if (option === '--tag' && args.length > 0) tag = args.shift()
    else if (option === '--timeout-seconds' && args.length > 0) timeoutSeconds = Number(args.shift())
    else throw new Error(usage)
  }
  if (!TAG_PATTERN.test(tag) || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(usage)
  return { version, tag, timeoutMs: timeoutSeconds * 1000 }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  await awaitPublished({ ...options, view: npmView })

  const verifyArgs = ['run', 'release:verify-published', '--', options.version]
  const verifyOptions = { cwd: ROOT, stdio: 'inherit', windowsHide: true }
  const verified = process.env.npm_execpath
    ? spawnSync(process.execPath, [resolve(ROOT, 'scripts/verify-published.mjs'), options.version], verifyOptions)
    : runNpm(verifyArgs, verifyOptions)
  if (verified.error) throw verified.error
  process.exitCode = verified.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
