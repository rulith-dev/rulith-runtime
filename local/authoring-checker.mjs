// SPDX-License-Identifier: Apache-2.0
// Public, pinned executables shared by this computer. No account credential reaches this path.
import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('./authoring-checker.json', import.meta.url))
let installation
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

async function settings() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.format !== 'rulith-local-authoring-checker/1' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)
      || !Array.isArray(manifest.files) || manifest.files.length !== 2
      || manifest.files.map(f => f.name).sort().join(',') !== 'local-authoring.jar,rule-check.jar') {
    throw new Error('This Rulith release has no valid pinned authoring checker manifest.')
  }
  for (const file of manifest.files) {
    const url = new URL(file.url)
    if (url.origin !== 'https://console.rulith.ai' || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith('/downloads/authoring/') || !/^[0-9a-f]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 50 * 1024 * 1024) {
      throw new Error('The authoring checker manifest has an invalid executable pin.')
    }
  }
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

async function install(fetchImpl) {
  const { manifest, directory } = await settings()
  if (await valid(directory, manifest)) return { installed: true, jar: join(directory, 'local-authoring.jar') }
  // Never overwrite an existing, modified dependency. Keep it reviewable and fail explicitly.
  try { await stat(directory); throw new Error('The installed authoring checker differs from its release pins. Remove that dependency directory and prepare again.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(directory), '.install-'))
  try {
    for (const file of manifest.files) {
      const response = await fetchImpl(file.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error('The pinned local authoring checker could not be downloaded. Retry preparation.')
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > file.bytes) throw new Error('The authoring checker download exceeds its release size.')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      if (size !== file.bytes || sha(bytes) !== file.sha256) throw new Error('The authoring checker download does not match its release digest.')
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
