// SPDX-License-Identifier: Apache-2.0
/** One entry: `rulith` opens the app; retired entry points must fail before touching credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseLocalCli, CLI_HELP, nodeVersionRefusal } from '../local/rulith-local.mjs'
import { freePort } from '../local/instance-manager.mjs'

const CLI = resolve(import.meta.dirname, '..', 'local', 'rulith-local.mjs')

test('the command line opens the app; the manager and the kit installer are named explicitly', () => {
  // `start` and `setup` opened the English workbench, which is retired: they now open the app, like `rulith` alone.
  for (const argv of [[], ['app'], ['start'], ['setup']]) assert.deepEqual(parseLocalCli(argv, {}), { command: 'app', args: [] })
  assert.deepEqual(parseLocalCli(['start', '--no-open', '--port', '3099'], {}), { command: 'app', args: ['--no-open', '--port', '3099'] })
  assert.deepEqual(parseLocalCli(['--port=0'], {}), { command: 'app', args: ['--port', '0'] })
  assert.deepEqual(parseLocalCli(['manager'], {}), { command: 'manager' })
  for (const args of [['--legacy'], ['--config', 'file.json'], ['--role', 'worker'], ['--roles', 'agent'], ['--unknown'],
    ['--host', '0.0.0.0'], ['settings.json']]) {
    assert.throws(() => parseLocalCli(['start', ...args], {}), /Unknown Rulith option/)
  }
  assert.throws(() => parseLocalCli(['manager', '--no-open'], {}), /Unknown Rulith option/)
  assert.throws(() => parseLocalCli(['--port', 'abc'], {}), /--port must be an integer/)
  assert.throws(() => parseLocalCli(['--port'], {}), /--port needs a port number/)
  assert.throws(() => parseLocalCli(['start'], { RULITH_LOCAL_CONFIG: 'file.json' }), /RULITH_LOCAL_CONFIG.*no longer supported/)
  assert.deepEqual(parseLocalCli(['--help'], {}), { help: true })
  assert.doesNotMatch(CLI_HELP, /--legacy|--config|--role|RULITH_LOCAL_CONFIG/)
})

/** Run the executable until it prints the line that says it is up, then stop it. */
function runCli(args, env, marker, timeoutMs = 20_000) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const finish = (error) => {
      clearTimeout(timer)
      clearTimeout(settle)
      child.kill()
      if (error) fail(new Error(`${error}\nstdout:\n${out}\nstderr:\n${err}`))
      else done({ out, err })
    }
    const timer = setTimeout(() => finish('the executable never printed its startup line'), timeoutMs)
    // The startup line is not always the last one, so let the rest of the banner arrive
    // before the process is stopped; otherwise this reads a truncated answer as a missing one.
    let settle
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (!marker.test(out) || settle !== undefined) return
      settle = setTimeout(() => finish(), 250)
    })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => finish(String(error?.message ?? error)))
    child.on('exit', (code) => { if (!marker.test(out)) finish(`the executable exited with ${code}`) })
  })
}

/** A home directory with an existing single-instance installation in it. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'rulith-home-'))
  mkdirSync(join(home, '.rulith'), { recursive: true })
  const configFile = join(home, '.rulith', 'local.json')
  writeFileSync(configFile, JSON.stringify({ roles: ['agent', 'worker'],
    agent: { args: [], env: { RULITH_URL: 'https://console.example', RULITH_TOKEN: 'rlt_agt_existing' } },
    worker: { env: { RULITH_CONNECTION: 'conn-existing', RULITH_CONNECTION_KEY: 'existing-key' } },
    paths: {}, operatorNote: 'do not touch' }, null, 2))
  return { home, configFile, env: { HOME: home, USERPROFILE: home } }
}

test('opening the manager reads, moves and rewrites nothing in an existing installation', async (t) => {
  const { home, configFile, env } = fakeHome()
  const managerHome = join(home, 'manager-root')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const before = readFileSync(configFile, 'utf8')
  const port = await freePort()

  const run = await runCli(['manager'], { ...env, RULITH_MANAGER_HOME: managerHome, RULITH_MANAGER_PORT: String(port),
    RULITH_LOCAL_CONFIG: '' }, /Rulith manager: /)

  assert.match(run.out, new RegExp(`Rulith manager: http://127\\.0\\.0\\.1:${port} `))
  assert.doesNotMatch(run.out, /\?k=/, 'the manager has no page, so its key is never printed')
  assert.doesNotMatch(run.out, /--legacy|import a copy/)
  assert.equal(run.out.includes('existing-key'), false, 'the manager must not read an installation\'s credentials')

  assert.equal(readFileSync(configFile, 'utf8'), before, 'the existing configuration was modified')
  assert.deepEqual(readdirSync(join(home, '.rulith')).sort(), ['local.json'],
    'the manager created no state beside an unrelated configuration')
  assert.equal(existsSync(join(managerHome, 'registry.json')) || existsSync(managerHome), true)
})

test('a manager key outside the agreed shape is refused at startup', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rulith-keyshape-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const port = await freePort()
  const base = { HOME: home, USERPROFILE: home, RULITH_LOCAL_CONFIG: '',
    RULITH_MANAGER_HOME: join(home, 'manager'), RULITH_MANAGER_PORT: String(port) }

  const refused = await new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'manager'], { env: { ...process.env, ...base, RULITH_MANAGER_KEY: 'short' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => done({ code, err }))
  })
  assert.equal(refused.code, 1)
  assert.match(refused.err, /16–128 characters/)
  assert.match(refused.err, /A–Z, a–z, 0–9/)

  // A key of the agreed shape starts normally, and is never printed.
  const accepted = await runCli(['manager'], { ...base, RULITH_MANAGER_KEY: 'Abcd-1234_efgh5678' }, /Rulith manager: /)
  assert.match(accepted.out, new RegExp(`Rulith manager: http://127\\.0\\.0\\.1:${port} `))
  assert.equal(accepted.out.includes('Abcd-1234_efgh5678'), false)
  assert.match(CLI_HELP, /RULITH_MANAGER_KEY/)
})

test('retired launch options refuse before creating files or starting a host', async (t) => {
  const { home, configFile, env } = fakeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const before = readFileSync(configFile, 'utf8')
  const managerHome = join(home, 'manager')
  for (const args of [['start', '--legacy'], ['start', '--config', configFile], ['start', '--role', 'worker'], []]) {
    const inherited = args.length === 0 ? configFile : ''
    const run = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env,
        RULITH_MANAGER_HOME: managerHome, RULITH_MANAGER_PORT: '0', RULITH_LOCAL_CONFIG: inherited },
        stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      const timer = setTimeout(() => { child.kill(); fail(new Error('retired invocation did not exit')) }, 10000)
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      child.on('error', fail)
      child.on('close', code => { clearTimeout(timer); done({ code, out, err }) })
    })
    assert.equal(run.code, 1, run.err)
    assert.match(run.err, inherited ? /RULITH_LOCAL_CONFIG.*no longer supported/ : /Unknown Rulith option/)
    assert.doesNotMatch(run.out, /Workbench:|Local UI:|Rulith manager:|keeps its files/)
    assert.equal(existsSync(managerHome), false)
    assert.equal(readFileSync(configFile, 'utf8'), before)
  }
})

test('rulith app runs the app launcher in the same process, with the checked options', async (t) => {
  // A settings file the launcher refuses proves the hand-over without starting dsh: the launcher's own refusal is printed.
  const dir = mkdtempSync(join(tmpdir(), 'rulith-app-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const settings = join(dir, 'settings.json')
  writeFileSync(settings, JSON.stringify({ managerHome: join(dir, 'manager'), dshHome: join(dir, 'dsh'), reliefRatio: 2 }))
  const run = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, 'app', '--no-open'], { env: { ...process.env, DEEP_RULITH_SETTINGS: settings,
      RULITH_LOCAL_CONFIG: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); fail(new Error('the app entry did not exit')) }, 20_000)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', fail)
    child.on('close', code => { clearTimeout(timer); done({ code, out, err }) })
  })
  assert.equal(run.code, 1, run.out + run.err)
  assert.match(run.err, /reliefRatio in the settings must be a number between 0 and 1/)
  assert.equal(existsSync(join(dir, 'manager')), false, 'nothing was started or created before the launcher refused')
})

test('the installed command works through a link to it, as npm installs it on Linux and macOS', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-bin-link-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = join(dir, 'rulith')
  try { symlinkSync(CLI, link) } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('this system does not let this user make a link')
    throw error
  }
  const run = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [link, '--help'], { env: { ...process.env, RULITH_LOCAL_CONFIG: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', fail)
    child.on('close', code => done({ code, out }))
  })
  assert.equal(run.code, 0)
  assert.match(run.out, /rulith app/, 'run through a link, the command printed nothing: it did not know it was the main module')
})

test('an app launcher before 0.19.0, which starts the Runtime with no command and the manager key, gets the manager', async (t) => {
  assert.deepEqual(parseLocalCli([], { RULITH_MANAGER_KEY: 'Abcd-1234_efgh5678' }), { command: 'manager', startedByEarlierLauncher: true })
  assert.deepEqual(parseLocalCli(['app'], { RULITH_MANAGER_KEY: 'Abcd-1234_efgh5678' }), { command: 'app', args: [] })
  const home = mkdtempSync(join(tmpdir(), 'rulith-old-launcher-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const port = await freePort()
  const run = await runCli([], { HOME: home, USERPROFILE: home, RULITH_LOCAL_CONFIG: '', RULITH_MANAGER_HOME: join(home, 'manager'),
    RULITH_MANAGER_PORT: String(port), RULITH_MANAGER_KEY: 'Abcd-1234_efgh5678' }, /Rulith manager: /)
  assert.match(run.out, new RegExp(`Rulith manager: http://127\.0\.0\.1:${port} `))
  assert.match(run.err, /started as the local Runtime manager because RULITH_MANAGER_KEY is set/)
})

test('the command refuses a Node.js older than 22.19 in plain words', () => {
  assert.match(nodeVersionRefusal('20.11.1'), /^Rulith needs Node\.js 22\.19 or later; this is Node\.js 20\.11\.1\./)
  assert.match(nodeVersionRefusal('22.18.0'), /22\.19 or later/)
  for (const version of ['22.19.0', '22.20.1', '24.12.0', '25.0.0']) assert.equal(nodeVersionRefusal(version), null, version)
})
