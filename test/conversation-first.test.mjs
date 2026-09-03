// SPDX-License-Identifier: Apache-2.0
/**
 * The Local Agent is a conversational Agent first. Rulith is an optional tool:
 * no Case exists until the model asks for one, and an open Case advances only
 * when the model explicitly chooses another tool step.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { defaultBoard, fenced, runAgent } from './support/agent-harness.mjs'

const rulith = (action, extra = {}) => fenced({ tool: 'rulith', action, ...extra })

const freePort = async () => {
  const server = createServer()
  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))
  await new Promise((ready) => server.close(ready))
  return port
}

test('a greeting is answered normally with no Case or Board operation', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['你好'],
    model: () => '你好！有什么想一起处理的吗？',
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'a plain conversational reply must return control to the user')
  assert.deepEqual(run.kinds, [], `a greeting unexpectedly touched the Board: ${run.kinds.join(', ')}`)
  assert.equal(run.calls.filter((call) => call.mode === 'source_access').length, 0,
    'ordinary conversation must not read the Source catalog before the Agent selects Rulith')
  assert.match(run.stdout, /你好！有什么想一起处理的吗？/)
  assert.doesNotMatch(run.stdout, /Case Context opened|pending_case_id|Stopped at the .*round limit/)
})

test('Rulith advances only through model-selected tool steps and does not auto-close', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Please investigate this with Rulith.'],
    model: (round) => {
      if (round === 1) return rulith('start_case', { caseType: 'exploration' })
      if (round === 2) return rulith('apply_batch', { operations: [
        { op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.observation', args: { value: 'one' } },
      ] })
      return 'I recorded the first observation. The Case remains open while I wait for your direction.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3, 'each continuation must follow an explicit model tool choice')
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 1)
  assert.equal(run.kinds.filter((kind) => kind === 'ApplyBatch').length, 1)
  assert.equal(run.kinds.includes('CloseCase'), false,
    `the host closed a Case the model did not ask to finish: ${run.kinds.join(', ')}`)
  assert.equal(run.kinds.includes('RunDischarge'), false,
    `the host advanced verification without a model-selected step: ${run.kinds.join(', ')}`)
})

test('conversation mode emits Board verdict and completion events for Local observability', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record one governed observation.'],
    captureLocalEvents: true,
    model: (round) => {
      if (round === 1) return rulith('start_case')
      if (round === 2) return rulith('apply_batch', { operations: [
        { op: 'assert_fact', id: 'F_EVENT', predicate: 'scratch.demo.observation', args: { value: 'visible' } },
      ] })
      return 'The explicit step was accepted and is visible in the Case trace.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.localEvents.some((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch' && event.accepted === true),
    `Local received no Board verdict: ${JSON.stringify(run.localEvents)}`)
  assert.ok(run.localEvents.some((event) => event.type === 'board' && event.floor === 'attested'),
    `Local received no Case completion state: ${JSON.stringify(run.localEvents)}`)
})

test('only an explicit Rulith tool envelope can turn JSON into a Board write', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Show me how a fact operation looks.'],
    model: (round) => {
      if (round === 1) return rulith('start_case')
      return 'For example, a JSON payload can look like this:\n\n```json\n[{"op":"assert_fact","id":"EXAMPLE","predicate":"scratch.demo.example","args":{"value":"not a real submission"}}]\n```'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 2, 'an example in a normal answer must return control immediately')
  assert.equal(run.kinds.includes('ApplyBatch'), false,
    `a conversational JSON example was written to the Board: ${run.kinds.join(', ')}`)
})

test('a Rulith envelope quoted alongside explanatory content is never executed', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith after showing the illustrative shape.'],
    model: (round) => round === 1
      ? 'This first block is only an example:\n```json\n{"example":true}\n```\nHere is a Rulith example too:\n' + rulith('start_case')
      : 'Those blocks were explanatory examples; I did not execute either one.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 2)
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 0,
    'a tool-shaped example embedded in ordinary prose became an authority-bearing call')
  assert.match(JSON.stringify(run.modelRequests[1]), /tool-shaped JSON was not executed/,
    'a malformed tool attempt was silently swallowed instead of receiving corrective teaching')
})

test('a locked Board never gives the conversational Agent an add_axiom handle', async () => {
  const normal = defaultBoard()
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith under the installed governance.'],
    board: (args) => args.operation?.kind === 'GetBoardManifest'
      ? { accepted: true, revision: 'r1', payload: { status: 'open', lawLocked: true, cases: [] } }
      : normal(args),
    model: (round) => round === 1 ? rulith('start_case') : 'The locked Case exposes installed capabilities only.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const beforeOpen = JSON.stringify(run.modelRequests[0])
  const afterOpen = JSON.stringify(run.modelRequests[1])
  assert.doesNotMatch(beforeOpen, /AX_EXPLORATION_COMPLETE|\\"op\\":\\"add_axiom\\"/,
    'the unscoped first turn exposed an exploration-law handle before lock state was known')
  assert.match(afterOpen, /Board legislation is locked/)
  assert.match(afterOpen, /Never assert acceptance_met/)
  assert.doesNotMatch(afterOpen, /AX_EXPLORATION_COMPLETE|\\"op\\":\\"add_axiom\\"/,
    'the locked prompt exposed a copyable provisional-law tool')
})

test('the configured Case Type cannot be overridden by model output', async () => {
  const run = await runAgent({
    argv: ['--case-type', 'verified_calculation'],
    chatLines: ['Use Rulith for this governed calculation.'],
    model: (round) => round === 1
      ? rulith('start_case', { caseType: 'exploration' })
      : 'The configured Case Type is now active.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const opened = run.operations.find((operation) => operation.kind === 'OpenCase')
  assert.equal(opened?.caseType, 'verified_calculation',
    'the host-selected governance contract must remain authoritative')
})

test('a model-selected finish asks the host to enforce the close gate', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith and finish when the Board permits it.'],
    model: (round) => {
      if (round === 1) return rulith('start_case', { caseType: 'exploration' })
      if (round === 2) return rulith('finish_case', { disposition: 'completed' })
      return 'The Board accepted the completion and the Case is closed.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 3)
  assert.equal(run.kinds.filter((kind) => kind === 'CloseCase').length, 1,
    `finish_case did not cross the host-controlled lifecycle gate: ${run.kinds.join(', ')}`)
  assert.match(run.stdout, /Case .*closed|Closed Case/)
})

test('finish_case cannot close a Case that the Board has not certified', async () => {
  const normal = defaultBoard()
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith, but finish only if the Board permits it.'],
    board: (args) => args.operation?.kind === 'GetCompletion'
      ? { accepted: true, revision: 'r3', payload: { state: 'running', certified: false, floor: 'asserted', leaves: [], gaps: [] } }
      : normal(args),
    model: (round) => {
      if (round === 1) return rulith('start_case')
      if (round === 2) return rulith('finish_case', { disposition: 'completed' })
      return 'The Board refused completion, so the Case remains open.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.kinds.includes('CloseCase'), false,
    `an uncertified Case was closed: ${run.kinds.join(', ')}`)
  assert.match(JSON.stringify(run.modelRequests.at(-1)), /did not permit completed closure/,
    'the refusal must be returned to the model as the result of its explicit finish request')
})

test('--case selects an already-running Case and still delivers the user message', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-running', '--case-type', 'exploration'],
    chatLines: ['Continue our discussion without changing the Board.'],
    board: defaultBoard({ cases: [{
      id: 'case-running', root: 'case-running', status: 'running', caseType: 'exploration', revision: 'c7',
      capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
    }] }),
    model: () => 'The existing Case is selected. I have not taken another Rulith step.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'selecting a running Case must not swallow the user message')
  assert.equal(run.kinds.includes('ResumeCase'), false, 'a running Case does not need a lifecycle transition')
  assert.equal(run.kinds.includes('OpenCase'), false, 'an existing Case must not be opened again')
})

test('a selected Case persists across conversational messages without being advanced implicitly', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start a governed investigation.', 'Before the next step, explain what you know.'],
    model: (round) => {
      if (round === 1) return rulith('start_case', { caseType: 'exploration' })
      if (round === 2) return 'The Case is open. I will wait for your next instruction before changing it.'
      return 'The same Case is still open; no additional Rulith step was selected.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 1,
    `a follow-up message opened another Case: ${run.kinds.join(', ')}`)
  assert.equal(run.kinds.includes('CloseCase'), false)
  assert.match(JSON.stringify(run.modelRequests[2]), /Current Rulith Case View/,
    'the next conversational turn must receive the selected Case state as guidance')
})

test('an active conversation refreshes Source Access so newly configured read tools do not require restart', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open an exploration Case.', 'Check whether a new Source is available now.'],
    model: (round) => round === 1 ? rulith('start_case') : 'I will use the currently advertised Source tools when they are useful.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const reads = run.calls.filter((call) => call.mode === 'source_access')
  assert.ok(reads.length >= 2,
    `Source Access was cached for the process lifetime (${reads.length} read); runtime additions would remain invisible`)
})

test('one user message reads Source Access at most once even across several Rulith tool rounds', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Inspect the governed Source catalogue.'],
    model: (round) => {
      if (round === 1) return rulith('start_case')
      if (round === 2) return rulith('read_case')
      return 'I inspected the current Case and Source catalogue once for this message.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.calls.filter((call) => call.mode === 'source_access').length, 1,
    'one user message multiplied Source Access reads across tool rounds')
})

test('a rejected Source Access credential stops the Agent instead of becoming model prompt text', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start governed work.'],
    rejectSourceCredential: true,
    model: () => rulith('start_case'),
  })

  assert.equal(run.code, 3, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'the rejected credential was sent to the model instead of stopping the host')
  assert.match(run.stderr, /Agent MCP token rejected \(401\)/)
})

test('a non-auth Source Access failure is visible to the operator and the model', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start governed work.'],
    captureLocalEvents: true,
    sourceAccessResult: { ok: false, errorCode: 'catalogue_unavailable', teaching: 'Source registry is temporarily unavailable.' },
    model: (round) => round === 1 ? rulith('start_case') : 'The Source catalogue is unavailable, so I will not invent an access Action.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Source Access catalogue is unavailable/)
  assert.ok(run.localEvents.some((event) => event.type === 'error' && event.scope === 'source-access'))
  assert.match(JSON.stringify(run.modelRequests.at(-1)), /Source registry is temporarily unavailable/)
})

test('conversation trail remains bounded when transcript compaction runs repeatedly', async () => {
  const chatLines = Array.from({ length: 55 }, (_, index) => `ordinary message ${index + 1}`)
  const run = await runAgent({
    argv: [],
    env: { RULITH_KEEP_MESSAGES: '4' },
    chatLines,
    model: () => 'Ordinary response with no Rulith tool call.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, chatLines.length)
  const latest = JSON.stringify(run.modelRequests.at(-1))
  assert.ok((latest.match(/\[conversation/g) ?? []).length <= 40,
    'bounded transcript compaction reintroduced an unbounded conversation trail')
})

test('--serve assigns independent conversation keys when callers omit sessionKey', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'conversation-key-test' },
    serveTasks: ['hello from client A', 'hello from client B'],
    waitForServeCompletion: true,
    model: () => 'Hello. No governed Case is needed.',
    timeoutMs: 750,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const keys = run.serveResponses.map((response) => response.body.sessionKey)
  assert.ok(keys.every((key) => typeof key === 'string' && key !== ''), `missing generated session keys: ${JSON.stringify(keys)}`)
  assert.notEqual(keys[0], keys[1], 'unrelated no-key clients must not share the default conversation slot')
})

test('--serve records a recoverable Case id before reclaiming an abandoned conversation slot', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: {
      RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'slot-capacity-test', RULITH_SERVE_SLOTS_MAX: '1',
    },
    serveTasks: [
      { text: 'Open a governed Case.', sessionKey: 'client-a' },
      { text: 'Start an unrelated conversation.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (round) => round === 1 ? rulith('start_case') : 'The Case remains active.',
    timeoutMs: 750,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 1)
  assert.equal(run.kinds.includes('PauseCase'), false, 'local memory pressure must not change the Board Case lifecycle')
  const detached = (run.serveSnapshot?.runs ?? []).find((record) => record.sessionKey === 'client-a' && record.pendingCaseId)
  assert.ok(detached, `the reclaimed Case was not exposed for explicit recovery: ${JSON.stringify(run.serveSnapshot)}`)
  assert.match(detached.note, /remains unchanged on the Board/)
})

test('a reclaimed session receives its detached Case id and may explicitly select it again', async () => {
  const port = await freePort()
  const normal = defaultBoard()
  let runningCase
  const run = await runAgent({
    argv: ['--serve'],
    env: {
      RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'slot-recovery-test', RULITH_SERVE_SLOTS_MAX: '1',
    },
    board: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') {
        return { accepted: true, revision: 'r3', payload: { status: 'open', cases: runningCase ? [runningCase] : [] } }
      }
      const result = normal(args)
      if (operation.kind === 'OpenCase' && result.accepted === true) {
        runningCase = {
          id: operation.caseId, root: operation.caseId, status: 'running', caseType: operation.caseType,
          revision: result.payload.caseRevision, capabilityReleaseDigest: result.payload.capabilityReleaseDigest,
          caseContractDigest: result.payload.caseContractDigest,
        }
      }
      return result
    },
    serveTasks: [
      { text: 'Open a governed Case.', sessionKey: 'client-a' },
      { text: 'Use a separate ordinary conversation.', sessionKey: 'client-b' },
      { text: 'Continue the earlier governed work.', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true,
    model: (round) => {
      if (round === 1) return rulith('start_case')
      if (round === 4) return rulith('resume_case', { caseId: runningCase.id })
      if (round === 5) return 'The prior Case is selected again without a lifecycle write.'
      return 'No Rulith step is needed in this reply.'
    },
    timeoutMs: 900,
  })

  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  assert.match(JSON.stringify(run.modelRequests[3]), new RegExp(runningCase.id),
    'the returning session was not told which Case its reclaimed transcript had selected')
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 1,
    `recovery opened a replacement Case: ${run.kinds.join(', ')}`)
  assert.equal(run.kinds.includes('ResumeCase'), false,
    'selecting a still-running Case must not change its Board lifecycle')
})

test('an explicit caseId cannot silently replace another active Case in the same session', async () => {
  const port = await freePort()
  const other = {
    id: 'case-other', root: 'case-other', status: 'running', caseType: 'exploration', revision: 'c9',
    capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
  }
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'case-switch-test' },
    board: defaultBoard({ cases: [other] }),
    serveTasks: [
      { text: 'Open this conversation Case.', sessionKey: 'client-a' },
      { text: 'Continue here.', sessionKey: 'client-a', caseId: 'case-other' },
    ],
    waitForServeCompletion: true,
    model: (round) => round === 1 ? rulith('start_case') : 'Continue without changing the selected Case.',
    timeoutMs: 850,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.match(JSON.stringify(run.modelRequests[2]), /was not selected because this conversation already owns active Case/)
  assert.equal(run.kinds.filter((kind) => kind === 'OpenCase').length, 1)
})
