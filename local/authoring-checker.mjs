// SPDX-License-Identifier: Apache-2.0
// Public, pinned executables shared by this computer. No account credential reaches this path.
import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('./authoring-checker.json', import.meta.url))
let installation
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const RANGE_BYTES = 256 * 1024
const RANGE_PARALLELISM = 6
const RANGE_TIMEOUT_MS = 30_000
const FILE_TIMEOUT_MS = 25 * 60_000
const INSTALL_TIMEOUT_MS = 30 * 60_000

function pinnedFile(file) {
  const url = new URL(file.url)
  return url.origin === 'https://console.rulith.ai' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.startsWith('/downloads/authoring/') && /^[0-9a-f]{64}$/.test(file.sha256)
    && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 50 * 1024 * 1024
}

/** The source revision and every executable URL are one immutable release identity. */
export function validateAuthoringCheckerManifest(manifest) {
  if (manifest?.format !== 'rulith-local-authoring-checker/1' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)
      || !Array.isArray(manifest.files) || manifest.files.length !== 2
      || manifest.files.map(f => f.name).sort().join(',') !== 'local-authoring.jar,rule-check.jar') {
    throw new Error('This Rulith release has no valid pinned authoring checker manifest.')
  }
  for (const file of manifest.files) {
    const expectedUrl = `https://console.rulith.ai/downloads/authoring/${manifest.sourceCommit}/${file.name}`
    if (!pinnedFile(file) || file.url !== expectedUrl) {
      throw new Error('The authoring checker manifest has an invalid executable pin.')
    }
  }
  return manifest
}

async function settings() {
  const manifest = validateAuthoringCheckerManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  const fingerprint = sha(Buffer.from(JSON.stringify(manifest)))
  return { manifest, directory: join(homedir(), '.rulith', 'dependencies', 'authoring', fingerprint) }
}

async function valid(directory, manifest) {
  for (const file of manifest.files) {
    try {
      const path = join(directory, file.name)
      if ((await stat(path)).size !== file.bytes || sha(await readFile(path)) !== file.sha256) return false
    } catch { return false }
  }
  return true
}

export async function authoringCheckerStatus() {
  const { manifest, directory } = await settings()
  const installed = await valid(directory, manifest)
  return { installed, sourceCommit: manifest.sourceCommit,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    ...(installed ? { jar: join(directory, 'local-authoring.jar') } : {}) }
}

export async function discoverLocalAuthoringJar() {
  const state = await authoringCheckerStatus()
  if (!state.installed) throw new Error('Install the local rule checker from Document assistant before starting this Worker.')
  return state.jar
}

/** Only an explicit operator preparation installs executables; an Agent tool call never does. */
export async function installAuthoringChecker({ fetchImpl = fetch } = {}) {
  if (installation) return installation
  installation = install(fetchImpl)
  try { return await installation } finally { installation = undefined }
}

/** Bounded, independent ranges avoid long-lived cross-region streams; the full pin still decides acceptance. */
export async function downloadPinnedAuthoringFile(file, fetchImpl = fetch, { signal } = {}) {
  if (!pinnedFile(file)) throw new Error('The authoring checker has an invalid executable pin.')
  const count = Math.ceil(file.bytes / RANGE_BYTES)
  const pieces = new Array(count)
  const stop = new AbortController()
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]) : AbortSignal.timeout(FILE_TIMEOUT_MS)
  const abort = () => stop.abort(deadline.reason)
  if (deadline.aborted) abort()
  else deadline.addEventListener('abort', abort, { once: true })
  let next = 1
  const permanent = message => Object.assign(new Error(message), { permanent: true })
  const rangeUnsupported = () => Object.assign(new Error('The authoring checker server did not honor byte ranges.'), { rangeUnsupported: true })
  async function readBoundedBody(response, expected) {
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > expected) throw permanent('The authoring checker response exceeds its declared size.')
      chunks.push(chunk)
    }
    if (size !== expected) throw new Error('The authoring checker response is incomplete.')
    return Buffer.concat(chunks, expected)
  }
  async function part(index) {
    const start = index * RANGE_BYTES
    const end = Math.min(file.bytes - 1, start + RANGE_BYTES - 1)
    const expected = end - start + 1
    let lastError
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stop.signal.aborted) throw stop.signal.reason
      const request = new AbortController()
      const cancel = () => request.abort(stop.signal.reason)
      stop.signal.addEventListener('abort', cancel, { once: true })
      if (stop.signal.aborted) cancel()
      let timer
      try {
        const transfer = async () => {
          const response = await fetchImpl(file.url, {
            redirect: 'error', headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }, signal: request.signal,
          })
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel().catch(() => {})
            throw new Error('The authoring checker server is temporarily unavailable.')
          }
          if (response.status === 200 || (response.status === 206 && (!response.body
              || ![`bytes ${start}-${end}/${file.bytes}`, `bytes ${start}-${end}/*`].includes(response.headers.get('content-range'))
              || (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== expected)
              || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')))) {
            await response.body?.cancel().catch(() => {})
            throw rangeUnsupported()
          }
          if (response.status !== 206 || !response.body) {
            await response.body?.cancel().catch(() => {})
            throw permanent('The authoring checker server refused the requested byte range.')
          }
          return await readBoundedBody(response, expected)
        }
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            request.abort()
            reject(new Error('The authoring checker byte range timed out.'))
          }, RANGE_TIMEOUT_MS)
        })
        return await Promise.race([transfer(), timeout])
      } catch (error) {
        if (stop.signal.aborted) throw stop.signal.reason
        if (error?.permanent || error?.rangeUnsupported || attempt === 2) throw error
        lastError = error
      } finally {
        clearTimeout(timer)
        stop.signal.removeEventListener('abort', cancel)
      }
      await sleep(150 * 2 ** attempt + Math.floor(Math.random() * 100), undefined, { signal: stop.signal })
    }
    throw lastError ?? new Error('The authoring checker range could not be downloaded.')
  }
  async function wholeFile() {
    const request = new AbortController()
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    const onAbort = () => { request.abort(deadline.reason); rejectAbort(deadline.reason) }
    if (deadline.aborted) onAbort()
    else deadline.addEventListener('abort', onAbort, { once: true })
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          request.abort()
          reject(new Error('The authoring checker whole-file fallback timed out.'))
        }, FILE_TIMEOUT_MS)
      })
      const transfer = async () => {
        const response = await fetchImpl(file.url, {
          redirect: 'error', headers: { 'Accept-Encoding': 'identity' }, signal: request.signal,
        })
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel().catch(() => {})
          throw new Error('The authoring checker whole-file fallback could not be downloaded.')
        }
        const bytes = await readBoundedBody(response, file.bytes)
        if (sha(bytes) !== file.sha256) throw permanent('The authoring checker download does not match its release digest.')
        return bytes
      }
      return await Promise.race([transfer(), aborted, timeout])
    } finally {
      clearTimeout(timer)
      deadline.removeEventListener('abort', onAbort)
    }
  }
  try {
    pieces[0] = await part(0)
    const workers = Array.from({ length: Math.min(RANGE_PARALLELISM, count - 1) }, async () => {
      while (next < count && !stop.signal.aborted) {
        const index = next++
        try { pieces[index] = await part(index) }
        catch (error) { stop.abort(error); throw error }
      }
    })
    const outcomes = await Promise.allSettled(workers)
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (stop.signal.aborted || failure) throw stop.signal.reason ?? failure.reason
    const bytes = Buffer.concat(pieces, file.bytes)
    if (sha(bytes) !== file.sha256) throw new Error('The authoring checker download does not match its release digest.')
    return bytes
  } catch (error) {
    if (error?.rangeUnsupported && !deadline.aborted) return await wholeFile()
    throw error
  } finally {
    deadline.removeEventListener('abort', abort)
  }
}

async function install(fetchImpl) {
  const { manifest, directory } = await settings()
  if (await valid(directory, manifest)) return { installed: true, jar: join(directory, 'local-authoring.jar') }
  // Never overwrite an existing, modified dependency. Keep it reviewable and fail explicitly.
  try { await stat(directory); throw new Error('The installed authoring checker differs from its release pins. Remove that dependency directory and prepare again.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(directory), '.install-'))
  const signal = AbortSignal.timeout(INSTALL_TIMEOUT_MS)
  try {
    for (const file of manifest.files) {
      const bytes = await downloadPinnedAuthoringFile(file, fetchImpl, { signal })
      await writeFile(join(temporary, file.name), bytes, { flag: 'wx', mode: 0o600 })
    }
    try { await rename(temporary, directory) }
    catch (error) { if (!(await valid(directory, manifest))) throw error }
    return { installed: true, jar: join(directory, 'local-authoring.jar') }
  } finally {
    const target = resolve(temporary), parent = resolve(dirname(directory))
    if (dirname(target) !== parent || !target.startsWith(parent)) throw new Error('Invalid dependency cleanup target.')
    await rm(target, { recursive: true, force: true })
  }
}
