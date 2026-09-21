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

if (process.env.RULITH_TEST_EXIT === '1') {
  console.error('echo-role: refusing to start, as this scenario asked')
  process.exit(3)
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
    cwd: process.cwd(),
  },
})
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
