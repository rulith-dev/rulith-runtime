// SPDX-License-Identifier: Apache-2.0
/** One workbench entry; retired entry points must fail before touching credentials. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseLocalCli, CLI_HELP } from '../local/rulith-local.mjs'
import { freePort } from '../local/instance-manager.mjs'

const CLI = resolve(import.meta.dirname, '..', 'local', 'rulith-local.mjs')

test('the command line opens only the workbench', () => {
  for (const command of ['start', 'setup', 'manager']) assert.deepEqual(parseLocalCli([command], {}), { command })
  assert.deepEqual(parseLocalCli([], {}), { command: 'start' })
  for (const args of [['--legacy'], ['--config', 'file.json'], ['--role', 'worker'], ['--roles', 'agent'], ['--unknown']]) {
    assert.throws(() => parseLocalCli(['start', ...args], {}), /Unknown Rulith option/)
  }
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

  const run = await runCli([], { ...env, RULITH_MANAGER_HOME: managerHome, RULITH_MANAGER_PORT: String(port),
    RULITH_LOCAL_CONFIG: '' }, /Workbench: /)

  assert.match(run.out, /Rulith/)
  assert.match(run.out, new RegExp(`Workbench: http://127\\.0\\.0\\.1:${port}/\\?k=[0-9a-f]{16,}`))
  assert.doesNotMatch(run.out, /--legacy|import a copy/)
  assert.equal(run.out.includes('existing-key'), false, 'the manager must not read an installation\'s credentials')

  assert.equal(readFileSync(configFile, 'utf8'), before, 'the existing configuration was modified')
  assert.deepEqual(readdirSync(join(home, '.rulith')).sort(), ['local.json'],
    'the manager created no state beside an unrelated configuration')
  assert.equal(existsSync(join(managerHome, 'registry.json')) || existsSync(managerHome), true)
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
    assert.doesNotMatch(run.out, /Workbench:|Local UI:/)
    assert.equal(existsSync(managerHome), false)
    assert.equal(readFileSync(configFile, 'utf8'), before)
  }
})
