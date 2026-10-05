#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * A stand-in for the Agent and Worker that reports the environment it was actually given.
 *
 * The host confirms a start from the role's own readiness event — `start` for the Agent,
 * `up` for the Worker — so this sends the right one for the role it was spawned as (the
 * Agent is the one the host launches with `--serve`). Carrying the environment on that same
 * event is what lets an isolation arm assert against what a child really received, rather
 * than against what the host intended to pass.
 *
 * `RULITH_TEST_*` variables come from the instance configuration, so they survive the
 * manager's environment isolation exactly as any other configured value does.
 */
import { readFileSync } from 'node:fs'

const agentRole = process.argv.includes('--serve')
const observed = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => /^(RULITH_|ANTHROPIC_)/.test(name)))
/**
 * Names of variables carrying something shaped like a Rulith credential, whatever they are
 * called. The isolation arms need to see a leak that arrived under an unexpected name too,
 * and reporting every value would put the whole environment into a journal to do it.
 */
const credentialNames = Object.entries(process.env)
  .filter(([, value]) => /^rlt_(dev|agt)_/.test(String(value)))
  .map(([name]) => name)
  .sort()

/**
 * What this Worker was composed from, for the arms about an environment's tools.
 *
 * The two files a Worker is given are read the way it would read them, and reported by name:
 * which tools its manifest holds, which Sources its vault holds, and where its three file
 * variables point. `RULITH_TEST_MARKERS` is a comma-separated list of strings an arm plants in
 * a key or a credential; each one found in this process's environment, or anywhere in the two
 * files, is reported, so "this value never reached the Worker" is something the Worker says.
 * The variable that carries the list is left out of what it searches, or it would find itself.
 */
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
const manifest = readJson(process.env.RULITH_TOOLS_FILE ?? ''), vault = readJson(process.env.RULITH_SECRETS_FILE ?? '')
const markers = String(process.env.RULITH_TEST_MARKERS ?? '').split(',').filter(Boolean)
const found = (text) => markers.filter((marker) => text.includes(marker))
const composed = {
  tools: Object.keys(manifest?.tools ?? {}).sort(),
  vault: Object.keys(vault ?? {}).sort(),
  manifest: manifest?.tools ?? {},
  sources: vault ?? {},
  files: { tools: process.env.RULITH_TOOLS_FILE ?? '', vault: process.env.RULITH_SECRETS_FILE ?? '',
    environmentVault: process.env.RULITH_ENVIRONMENT_SECRETS_FILE ?? '' },
  markersInEnvironment: found(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'RULITH_TEST_MARKERS')))),
  markersInFiles: found(JSON.stringify({ manifest, vault })),
}

if (process.env.RULITH_TEST_EXIT === '1') {
  console.error('echo-role: refusing to start, as this scenario asked')
  process.exit(3)
}

/**
 * `RULITH_TEST_OPEN_HISTORY=1` makes the Agent stand-in open its conversation history before it
 * reports readiness: the same `openConversations` call on the directory and owner the host passed,
 * and the same refusal as the Agent — the message on standard error and exit status 5. An arm about
 * that history's lock then watches the real lock being taken, or refused, by a separate process,
 * which keeps it until it exits and releases it only if it exits on its own.
 */
if (agentRole && process.env.RULITH_TEST_OPEN_HISTORY === '1') {
  const { openConversations } = await import('../../agent/conversation-store.mjs')
  try {
    await openConversations(process.env.RULITH_CONVERSATION_DIR ?? '', JSON.parse(process.env.RULITH_CONVERSATION_OWNER || '{}'))
  } catch (error) {
    // Exit once the line is written: a pipe on Windows may still hold it when `process.exit` runs.
    await new Promise((done) => process.stderr.write(`\n✗ Local conversation history needs attention: ${error.message}\n\n`, done))
    process.exit(5)
  }
}

/**
 * How long this child keeps working after it is asked to stop.
 *
 * A real role finishing a call does not leave the instant it is told to. Advertising
 * `managedStop` makes the host ask over IPC rather than signal, which is the only way a
 * child can outlive a stop request on Windows as well — so an arm about "not stopped until
 * observed" is about the same behaviour on both platforms.
 */
const stopDelay = Number(process.env.RULITH_TEST_STOP_DELAY_MS ?? 0)

process.send?.({
  protocol: 'rulith-local-event',
  event: {
    type: agentRole ? 'start' : 'up',
    t: Date.now(),
    ...(stopDelay > 0 ? { managedStop: true } : {}),
    ...(agentRole ? { agentId: String(process.env.RULITH_TEST_IDENTITY ?? 'unconfigured') } : {}),
    identity: String(process.env.RULITH_TEST_IDENTITY ?? ''),
    observed,
    credentialNames,
    ...(agentRole ? {} : { composed }),
    cwd: process.cwd(),
  },
})
if (!agentRole) process.send?.({ protocol: 'rulith-local-event', event: { type: 'availability', t: Date.now(), state: 'online' } })
const beat = setInterval(() => {}, 1000)
const leave = () => { clearInterval(beat); process.exit(0) }
const drainThenLeave = () => {
  if (stopDelay <= 0) return leave()
  console.log('echo-role: finishing work before stopping')
  setTimeout(leave, stopDelay)
}
process.on('SIGTERM', drainThenLeave)
process.on('SIGINT', drainThenLeave)
process.on('message', (message) => { if (message?.operation === 'stop') drainThenLeave() })
