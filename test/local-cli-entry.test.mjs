// SPDX-License-Identifier: Apache-2.0
/**
 * Which of the two entry points a command line asks for, and what each one leaves behind.
 *
 * The manager is the normal entry now. That is only safe if the command an existing
 * deployment already runs still reaches the deployment it always reached, and if opening the
 * manager never touches the configuration file that deployment lives in. Both halves are
 * asserted here against the real executable, including the files on disk afterwards.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseLocalCli, CLI_HELP, defaultConfigPath } from '../local/rulith-local.mjs'
import { freePort } from '../local/instance-manager.mjs'

const CLI = resolve(import.meta.dirname, '..', 'local', 'rulith-local.mjs')

test('the command line selects the manager by default and the single-instance mode explicitly', () => {
  assert.deepEqual(parseLocalCli([], {}), { command: 'start', legacy: false, roleArgs: [] })
  assert.deepEqual(parseLocalCli(['start'], {}), { command: 'start', legacy: false, roleArgs: [] })
  assert.deepEqual(parseLocalCli(['setup'], {}), { command: 'setup', legacy: false, roleArgs: [] })
  assert.deepEqual(parseLocalCli(['manager'], {}), { command: 'manager', legacy: false, roleArgs: [] })

  // Three explicit statements that this invocation is about one configuration file.
  assert.equal(parseLocalCli(['start', '--legacy'], {}).legacy, true)
  assert.equal(parseLocalCli(['start', '--legacy'], {}).configFile, defaultConfigPath())
  assert.equal(parseLocalCli(['start', '--config', 'D:/deploy/local.json'], {}).configFile, 'D:/deploy/local.json')
  assert.equal(parseLocalCli(['start'], { RULITH_LOCAL_CONFIG: 'D:/deploy/local.json' }).configFile, 'D:/deploy/local.json')

  // Roles belong to one instance, so a command that names them is the deployment command.
  const roles = parseLocalCli(['start', '--role', 'worker'], {})
  assert.equal(roles.legacy, true)
  assert.deepEqual(roles.roleArgs, ['--role', 'worker'])

  // An explicit file wins over the inherited one rather than being silently merged with it.
  assert.equal(parseLocalCli(['start', '--config', 'D:/a.json'], { RULITH_LOCAL_CONFIG: 'D:/b.json' }).configFile, 'D:/a.json')

  assert.throws(() => parseLocalCli(['start', '--config'], {}), /--config needs a configuration file path/)
  assert.throws(() => parseLocalCli(['manager', '--legacy'], {}), /rulith manager runs the multi-instance manager/)
  assert.throws(() => parseLocalCli(['start', '--unknown'], {}), /Unknown Rulith option: --unknown/)
  assert.deepEqual(parseLocalCli(['--help'], {}), { help: true })
  assert.match(CLI_HELP, /rulith start --legacy/)
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

  const run = await runCli([], { ...env, RULITH_MANAGER_HOME: managerHome, RULITH_MANAGER_PORT: String(port),
    RULITH_LOCAL_CONFIG: '' }, /Workbench: /)

  assert.match(run.out, /Rulith/)
  assert.match(run.out, new RegExp(`Workbench: http://127\\.0\\.0\\.1:${port}/\\?k=[0-9a-f]{16,}`))
  assert.match(run.out, /has not been read or changed/)
  assert.match(run.out, /rulith start --legacy/, 'the way back to the existing deployment is printed, not implied')
  assert.equal(run.out.includes('existing-key'), false, 'the manager must not read an installation\'s credentials')

  assert.equal(readFileSync(configFile, 'utf8'), before, 'the existing configuration was modified')
  assert.deepEqual(readdirSync(join(home, '.rulith')).sort(), ['local.json'],
    'the manager created no state beside an installation it was only offering to import')
  assert.equal(existsSync(join(managerHome, 'registry.json')) || existsSync(managerHome), true)
})

test('the single-instance mode still answers the command an existing deployment already runs', async (t) => {
  const { home, configFile, env } = fakeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const port = await freePort()

  for (const args of [['start', '--legacy'], ['start', '--config', configFile]]) {
    const run = await runCli(args, { ...env, RULITH_LOCAL_PORT: String(port), RULITH_LOCAL_CONFIG: '',
      RULITH_TOKEN: '', RULITH_CONNECTION_KEY: '' }, /Local UI: /)
    assert.match(run.out, /Rulith · mode agent\+worker/, args.join(' '))
    assert.match(run.out, new RegExp(`Local UI: http://127\\.0\\.0\\.1:${port}/\\?k=`))
    assert.match(run.out, /credentials are stored here, and are sent only to the services they authenticate to/)
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).operatorNote, 'do not touch')
  }
})

test('a manager key the Local pages could not carry back is refused at startup', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rulith-keyshape-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const port = await freePort()
  const base = { HOME: home, USERPROFILE: home, RULITH_LOCAL_CONFIG: '',
    RULITH_MANAGER_HOME: join(home, 'manager'), RULITH_MANAGER_PORT: String(port) }

  const refused = await new Promise((done) => {
    const child = spawn(process.execPath, [CLI], { env: { ...process.env, ...base, RULITH_MANAGER_KEY: 'short' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => done({ code, err }))
  })
  assert.equal(refused.code, 1)
  assert.match(refused.err, /16–128 characters/)
  assert.match(refused.err, /A–Z, a–z, 0–9/)

  // A key of the agreed shape starts normally and appears in the printed address.
  const accepted = await runCli([], { ...base, RULITH_MANAGER_KEY: 'Abcd-1234_efgh5678' }, /Workbench: /)
  assert.match(accepted.out, new RegExp(`Workbench: http://127\\.0\\.0\\.1:${port}/\\?k=Abcd-1234_efgh5678`))
  assert.match(CLI_HELP, /RULITH_MANAGER_KEY/)
})

test('RULITH_LOCAL_CONFIG alone still means the single-instance mode', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rulith-explicit-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const configFile = join(home, 'deployment.json')
  const port = await freePort()

  const run = await runCli(['start'], { HOME: home, USERPROFILE: home, RULITH_LOCAL_CONFIG: configFile,
    RULITH_LOCAL_PORT: String(port), RULITH_TOKEN: '', RULITH_CONNECTION_KEY: '' }, /Local UI: /)
  assert.match(run.out, /Rulith · mode/)
  assert.match(run.out, new RegExp('Configuration: ' + configFile.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')))
  assert.equal(existsSync(configFile), true, 'the deployment file this mode was pointed at is still created on first run')
})
