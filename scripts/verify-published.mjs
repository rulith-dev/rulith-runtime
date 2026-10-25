// SPDX-License-Identifier: Apache-2.0
/** Verify the public npm artifact, not the source tree that was meant to be published. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateAuthoringCheckerManifest } from '../local/authoring-checker.mjs'
import { publishedArtifactPath } from './published-artifact-path.mjs'
import { downloadAndProbePublishedAuthoring, verifyPublishedAuthoringManifest } from './published-authoring-verifier.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const localPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const inputs = process.argv.slice(2)
const fullAuthoring = inputs.includes('--full-authoring')
const unknown = inputs.filter(value => value.startsWith('--') && value !== '--full-authoring')
const versions = inputs.filter(value => !value.startsWith('--'))
if (unknown.length || versions.length > 1) throw new Error('Usage: npm run release:verify-published -- [major.minor.patch] [--full-authoring]')
const version = versions[0] ?? localPackage.version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: npm run release:verify-published -- [major.minor.patch] [--full-authoring]')
const packageName = `rulith@${version}`
const registry = 'https://registry.npmjs.org/'

function command(name, args, { cwd = ROOT } = {}) {
  const npmCli = process.env.npm_execpath
  if (name === 'npm' && (!npmCli || !existsSync(npmCli)))
    throw new Error('Run this verifier through npm run so the npm CLI is pinned to this invocation.')
  const executable = name === 'npm' ? process.execPath : name
  const actualArgs = name === 'npm' ? [npmCli, ...args] : args
  const run = spawnSync(executable, actualArgs, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`${name} ${args[0]} failed: ${(run.stderr || run.stdout).slice(0, 600)}`)
  return run.stdout
}

async function unusedPort() {
  const server = createServer()
  await new Promise((accept, reject) => server.once('error', reject).listen(0, '127.0.0.1', accept))
  const port = server.address().port
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
  return port
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  let killResult
  if (process.platform === 'win32') {
    killResult = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, encoding: 'utf8' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
  await new Promise(accept => {
    if (child.exitCode !== null || child.signalCode !== null) return accept()
    const onClose = () => { clearTimeout(timer); accept() }
    const timer = setTimeout(() => { child.off('close', onClose); accept() }, 3_000)
    child.once('close', onClose)
  })
  let alive = false
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(child.pid, 0); alive = true } catch { /* gone */ }
  }
  if (alive) throw new Error(`A published command did not stop after verification: ${killResult?.stderr?.slice(0, 300) ?? ''}`)
}

/** Start one of the package's commands and wait for a line of its output; the child is returned running. */
async function startUntil(packageRoot, args, env, pattern, what) {
  const child = spawn(process.execPath, [join(packageRoot, 'local/rulith-local.mjs'), ...args], {
    cwd: packageRoot, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let output = ''
  const line = chunk => { output += chunk.toString('utf8'); if (output.length > 8_000) output = output.slice(-8_000) }
  child.stdout.on('data', line); child.stderr.on('data', line)
  const deadline = Date.now() + 60_000
  while (!pattern.test(output) && child.exitCode === null && Date.now() < deadline)
    await new Promise(accept => setTimeout(accept, 100))
  if (!pattern.test(output)) {
    await stop(child)
    throw new Error(`published ${what} did not start: ${output.slice(0, 800)}`)
  }
  return { child, output: () => output }
}

/**
 * The published command, isolated in a temporary home: the Runtime manager answers its key and serves no page (the
 * English workbench is retired), and `rulith app` starts the app (dsh with Rulith's overlay, and the manager beside it)
 * whose page and host routes answer.
 */
async function smokeStart(packageRoot, temp) {
  const port = await unusedPort()
  const key = `release-smoke-${randomUUID().replaceAll('-', '')}`
  const manager = await startUntil(packageRoot, ['manager'], { RULITH_MANAGER_HOME: join(temp, 'manager'),
    RULITH_MANAGER_PORT: String(port), RULITH_MANAGER_KEY: key }, /Rulith manager: /, 'manager')
  try {
    assert.equal(manager.output().includes(key), false, 'the published manager printed its key')
    const page = await fetch(`http://127.0.0.1:${port}/?k=${key}`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(page.status, 404, 'the published manager still serves a page')
    const state = await fetch(`http://127.0.0.1:${port}/manager/state`, {
      headers: { 'x-rulith-manager': key }, signal: AbortSignal.timeout(5_000),
    })
    assert.equal(state.status, 200, 'published manager status was unavailable')
    assert.equal((await state.json()).ok, true)
  } finally { await stop(manager.child) }
  const home = join(temp, 'home')
  const app = await startUntil(packageRoot, ['app', '--no-open', '--port', String(await unusedPort())],
    { RULITH_APP_HOME: join(temp, 'app-home'), HOME: home, USERPROFILE: home }, /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/, 'app')
  try {
    const url = new URL(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(app.output())[1])
    // dsh trades the printed token for a cookie on a redirect to its page, as a browser follows it.
    const entry = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(entry.status === 303 && cookie, `the published app did not accept its printed address (${entry.status})`)
    const index = await fetch(new URL(entry.headers.get('location') ?? './', url), { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
    assert.equal(index.status, 200, 'the published app did not serve its page')
    assert.match(await index.text(), /<title>Rulith<\/title>/)
    // The app host's routes take the page's dsh session (model-command isolation, D-1024a): refused without it, answered
    // with the cookie the printed address gave this check, exactly as for the page itself.
    const api = new URL('/rulith/api/state', url)
    const refused = await fetch(api, { headers: { 'x-deep-rulith': '1' }, signal: AbortSignal.timeout(20_000) })
    assert.equal(refused.status, 401, 'the published app host answered without the page session')
    const state = await fetch(api, { headers: { 'x-deep-rulith': '1', cookie }, signal: AbortSignal.timeout(20_000) })
    assert.equal(state.status, 200, 'the published app host did not answer its page session')
    assert.equal(typeof (await state.json()).ok, 'boolean')
    console.log(`published ${packageName}: isolated manager answered without a page, and the app served its page and host routes`)
  } finally { await stop(app.child) }
}

const temp = await mkdtemp(join(tmpdir(), 'rulith-published-'))
try {
  const metadata = JSON.parse(command('npm', ['view', packageName, 'dist.integrity', 'dist.shasum', '--json', `--registry=${registry}`]))
  assert.ok(typeof metadata['dist.integrity'] === 'string' && metadata['dist.integrity'].startsWith('sha512-'))
  assert.match(metadata['dist.shasum'], /^[0-9a-f]{40}$/)
  const [packed] = JSON.parse(command('npm', ['pack', packageName, '--ignore-scripts', '--json', '--pack-destination', temp, `--registry=${registry}`]))
  assert.equal(packed.name, 'rulith')
  assert.equal(packed.version, version)
  assert.equal(packed.integrity, metadata['dist.integrity'])
  assert.equal(packed.shasum, metadata['dist.shasum'])
  const archive = join(temp, packed.filename)
  assert.equal(existsSync(archive), true)
  const members = command('tar', ['-tzf', archive]).trim().split(/\r?\n/)
  const types = command('tar', ['-tvzf', archive]).trim().split(/\r?\n/)
  assert.ok(members.length > 20)
  assert.equal(types.length, members.length)
  assert.ok(types.every(row => /^[-d]/.test(row)), 'published tarball contains a link or special file')
  for (const member of members) {
    const pieces = member.replace(/\/$/, '').split('/')
    assert.equal(pieces[0], 'package', `unexpected archive member: ${member}`)
    assert.ok(pieces.every(piece => piece !== '..' && piece !== '' && !piece.includes('\\')), `unsafe archive member: ${member}`)
  }
  const extract = join(temp, 'extract')
  await mkdir(extract)
  command('tar', ['-xzf', archive, '-C', extract])
  const packageRoot = join(extract, 'package')
  const publishedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(publishedPackage.version, version)
  assert.equal(publishedPackage.bin?.rulith, 'local/rulith-local.mjs')
  const manifestBytes = await readFile(join(packageRoot, 'artifact-manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.schema, 'rulith-local-runtime-artifacts/v1')
  for (const [file, expected] of Object.entries(manifest.files)) {
    const target = publishedArtifactPath(packageRoot, file)
    assert.match(expected.sha256, /^[0-9a-f]{64}$/)
    const actual = createHash('sha256').update(await readFile(target)).digest('hex')
    assert.equal(actual, expected.sha256, `${file} differs from the published artifact manifest`)
  }
  const checkerModule = await import(pathToFileURL(join(packageRoot, 'local/authoring-checker.mjs')).href
    + `?published=${encodeURIComponent(version)}`)
  if (version === localPackage.version)
    assert.equal(typeof checkerModule.validateAuthoringCheckerManifest, 'function',
      'the current published checker does not export its manifest validator')
  const checkerManifest = JSON.parse(await readFile(join(packageRoot, 'local/authoring-checker.json'), 'utf8'))
  const checkerValidator = checkerModule.validateAuthoringCheckerManifest ?? validateAuthoringCheckerManifest
  const checkerPublic = await verifyPublishedAuthoringManifest(checkerManifest, { validate: checkerValidator })
  console.log(`published ${packageName}: authoring manifest matches ${checkerPublic.sourceCommit} and ${checkerPublic.files} executable pins`)
  if (version === localPackage.version) {
    assert.deepEqual(manifestBytes, await readFile(join(ROOT, 'artifact-manifest.json')),
      'npm published an artifact manifest different from this verified release')
    for (const file of ['CHANGELOG.md', 'README.md', 'CONTRIBUTING.md', 'app/README.md', 'app/NOTICE']) {
      assert.deepEqual(await readFile(join(packageRoot, file)), await readFile(join(ROOT, file)),
        `npm published different release documentation: ${file}`)
    }
  }
  console.log(`published ${packageName}: registry integrity, ${members.length} archive members and ${Object.keys(manifest.files).length} artifact hashes verified`)
  const install = join(temp, 'install')
  await mkdir(install)
  command('npm', ['install', '--prefix', install, packageName, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', `--registry=${registry}`])
  await smokeStart(join(install, 'node_modules', 'rulith'), temp)
  if (fullAuthoring) {
    const probe = await downloadAndProbePublishedAuthoring(checkerManifest, join(temp, 'authoring'), {
      downloadFile: checkerModule.downloadPinnedAuthoringFile,
      validate: checkerValidator,
    })
    console.log(`published ${packageName}: downloaded ${probe.transferred} pinned authoring bytes and passed the constructor CLI probe on Java ${probe.javaMajor}`)
  }
} finally {
  const target = resolve(temp), parent = resolve(tmpdir())
  if (dirname(target) !== parent || !target.startsWith(join(parent, 'rulith-published-')))
    throw new Error('Refusing to remove an unexpected verification directory')
  await rm(target, { recursive: true, force: true })
}
