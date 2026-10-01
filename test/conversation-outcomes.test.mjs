// SPDX-License-Identifier: Apache-2.0
/**
 * One MCP session, several conversations: each conversation's model is shown the outcomes of its
 * own calls before it can send another write.
 *
 * The Gateway delivers a result to a *session* and gates a write on what that session was shown
 * (AIS §5.2). This Runtime carries every local conversation over its one session, so the
 * Gateway's guarantee alone would let one conversation read — and acknowledge — the outcome of
 * another conversation's write, after which that other conversation's "send it again" runs a
 * second time (Board spec TOOL-06). The arms below serve two conversations through the real
 * Agent against the scripted endpoint and count what reached the Board: an outcome is captured
 * for the conversation whose call it was, and that conversation's next write is not sent until
 * its model has been shown it.
 *
 * The acknowledgement ping is held to the same line: it never acknowledges a result that the
 * model of the conversation it was delivered to has not read. And what a conversation's model has not
 * read survives the transcript that showed it: a slot reclaimed for another conversation, and a
 * process restarted with history beside it (RT-CONV-6 onwards).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TEST_AGENT_ID, callTool, defaultGateway, freePort, runAgent } from './support/agent-harness.mjs'

const confirmed = (core, args) => ({ ...core, result: { action: args.action, done: true, ok: true, status: 'confirmed' } })
const ship = callTool('ApplyAction', { action: 'demo.ship', args: {} })
/** The text of the last user message a model request carried: the user's words and whatever preceded them. */
const lastUserText = (body) => {
  const users = (body.messages ?? []).filter((message) => message.role === 'user')
  return JSON.stringify(users.at(-1) ?? '')
}
const answered = (body) => (body.messages ?? []).at(-1)?.role === 'tool'
/** The raw text of the last user message a model request carried. */
const lastUserContent = (body) => {
  const content = (body.messages ?? []).filter((message) => message.role === 'user').at(-1)?.content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}
/** Every strip a host notice relayed in a message, parsed. */
const relayedStrips = (text) => text.split('Read it before you decide:\n').slice(1)
  .map((part) => JSON.parse(part.split('\n')[0]).operations)
/** The tool results a model request carried, parsed. */
const toolResults = (body) => (body.messages ?? []).filter((message) => message.role === 'tool')
  .map((message) => JSON.parse(message.content))
const serveEnv = (key, extra = {}) => ({ RULITH_SERVE_KEY: key, RULITH_HOST_WAIT_MS: '300', RULITH_HOST_POLL_MS: '50', ...extra })

for (const interleave of [true, false]) {
  test(`RT-CONV-1 a held write that settles ${interleave ? 'while another conversation reads the Board' : 'with no other conversation'}`
    + ' is shown to its own conversation before that conversation can send it again', async () => {
    // Conversation A's ApplyAction is still running when the host bound answers A's model, and
    // it settles once the position has been read. In the interleaved arm conversation B reads the
    // Board next: its strip carries A's result in full, B's model reads it, and B's turn ending in
    // text acknowledges it. A's user then says "ship it now", and A's model — which acts on tool
    // answers, not on prose — proposes the write again.
    const port = await freePort()
    let applyActions = 0
    let lookSeen = false
    const run = await runAgent({
      argv: ['--serve'],
      env: { RULITH_SERVE_PORT: String(port), ...serveEnv(`conversations-tool06-${interleave}`) },
      serveTasks: [
        { text: 'Ship order 7.', sessionKey: 'client-a' },
        ...(interleave ? [{ text: 'What is going on?', sessionKey: 'client-b' }] : []),
        { text: 'Ship order 7 now.', sessionKey: 'client-a' },
      ],
      waitForServeCompletion: true, stopAfterServe: true,
      hold: (name) => {
        if (name !== 'ApplyAction' || ++applyActions > 1) return undefined
        return { answer: 'running', holdMs: 50, settle: (now) => {
          if (lookSeen) return { state: 'done' }
          if (now.tool === 'QueryBoard') lookSeen = true
          return undefined
        } }
      },
      tool: (name, args, board, session) => (name === 'ApplyAction' ? confirmed(board.tool('OpenCase', {}, session), args) : undefined),
      model: (round, body) => {
        const said = lastUserText(body)
        if (said.includes('What is going on?')) return answered(body) ? 'Something else happened.' : callTool('QueryBoard', {})
        if (said.includes('Ship order 7 now.')) return answered(body) ? 'Done.' : ship
        return answered(body) ? 'It is still running.' : ship
      },
      timeoutMs: 15_000,
    })
    assert.deepEqual(run.serveStatuses, interleave ? [202, 202, 202] : [202, 202], `${run.stdout}\n${run.stderr}`)
    const executed = run.operations.filter((op) => op.tool === 'ApplyAction')
    assert.equal(executed.length, 1, `the write ran ${executed.length} times: ${run.verbs.join(', ')}`)
    const shipped = run.modelRequests.filter((body) => lastUserText(body).includes('Ship order 7 now.'))
    const refusal = toolResults(shipped.at(-1)).at(-1)
    assert.equal(refusal.errorCode, 'previous_result_undelivered')
    assert.equal(refusal.requestExecuted, false)
    const outcome = refusal.operations.find((entry) => entry.label === 'ApplyAction demo.ship')
    assert.equal(JSON.parse(outcome.result.content[0].text).result.status, 'confirmed',
      'the refusal did not show the outcome in full, as the authority first showed it')
    if (interleave) {
      // B's QueryBoard was the strip that carried A's result; B's turn then acknowledged it, so the
      // authority would have let A's write run. This host did not send it.
      assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard', 'QueryBoard'],
        'conversation A\'s write was sent again although its model had not seen how the first one ended')
      const read = run.modelRequests.find((body) => lastUserText(body).includes('What is going on?') && answered(body))
      assert.ok(toolResults(read)[0].operations.some((entry) => entry.label === 'ApplyAction demo.ship' && entry.result),
        'the other conversation\'s read did not carry the result in full, so the arm proves nothing')
      // A's next message names what is waiting, without the outcome itself: that comes, once, with
      // the answer to its next call.
      assert.match(lastUserText(shipped[0]), /Outcomes you have not been shown yet: ApplyAction demo\.ship\./)
      assert.doesNotMatch(lastUserText(shipped[0]), /confirmed/)
      assert.equal(refusal.teaching.includes('this Runtime did not send it'), true)
    } else {
      // On its own, conversation A is protected by the authority's gate: the write reached it and
      // was refused there, carrying the outcome.
      assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard', 'ApplyAction'])
      assert.doesNotMatch(refusal.teaching, /this Runtime did not send it/)
    }
  })
}

test('RT-CONV-2 an acknowledgement ping never acknowledges a result the conversation it went to has not read', async () => {
  // Conversation A's turn ends at its round limit right after a write, so A's model has not read
  // that result. Conversation B's turn ends in text; the ping that would follow must not count A's
  // result as read. A's own next turn reads it, and only then is it acknowledged.
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), ...serveEnv('conversations-ack'), RULITH_MAX_ROUNDS: '1' },
    serveTasks: [
      { text: 'Open a Case.', sessionKey: 'client-a' },
      { text: 'Hello.', sessionKey: 'client-b' },
      { text: 'Carry on.', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    model: (round, body) => (lastUserText(body).includes('Open a Case.') ? callTool('OpenCase', {}) : 'Noted.'),
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  const pingAt = run.order.findIndex((step) => step.kind === 'mcp' && step.method === 'ping')
  const aRead = run.order.findIndex((step) => step.kind === 'model' && step.n === 3)
  assert.ok(pingAt === -1 || pingAt > aRead,
    `a ping acknowledged conversation A's result before A's model had read it: ${JSON.stringify(run.order)}`)
  assert.equal(run.pings, 1, 'the result was never acknowledged once conversation A had read it')
  assert.equal(run.operations.find((op) => op.tool === 'OpenCase').acked, true)
})

const PROOF = 'ab'.repeat(32)
const ATTACHMENT = { id: 'mat_' + 'a'.repeat(32), name: 'notes.txt',
  mediaType: 'text/plain', totalBytes: 5, digest: 'sha256:' + 'b'.repeat(64) }

test('RT-CONV-3 a strip kept for a conversation whose turn stopped holds back the ping, and the next conversation is shown it', async () => {
  // An earlier write's result never reached this client. Conversation C's operator focus — with
  // files bound through it — is refused with that result, which delivers it to the session, and
  // C's turn stops before its model is asked. Conversation D's turn comes next: every request it
  // sends would acknowledge that result, so D's model is shown it first, and no acknowledgement
  // ping follows D's text. C's own next message shows it to C's model as well.
  const earlier = { accepted: true, result: { action: 'demo.ship', done: true, ok: true, status: 'confirmed' } }
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), ...serveEnv('conversations-kept') },
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_X', root: 'ROOT_X' }], queryIndependent: true }),
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'done', core: earlier }],
    serveTaskHeaders: (index) => (index === 0 ? { 'x-rulith-material-task-proof': PROOF } : {}),
    serveTasks: [
      { text: 'Add these notes to that Case.', sessionKey: 'client-c', caseId: 'CASE_X', attachments: [ATTACHMENT] },
      { text: 'Hello.', sessionKey: 'client-d' },
      { text: 'What happened with my notes?', sessionKey: 'client-c' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    model: () => 'Noted.',
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase'], 'the turn whose files could not be bound went on')
  assert.equal(run.modelRequests.length, 2, 'conversation C\'s first turn asked its model')
  const [d, c] = run.modelRequests.map(lastUserContent)
  assert.match(d, /while it brought Case "CASE_X" into focus for the operator for another conversation of this Agent/)
  const shown = relayedStrips(d).flat().find((entry) => entry.label === 'ApplyAction demo.ship')
  assert.equal(JSON.parse(shown.result.content[0].text).result.status, 'confirmed',
    'conversation D was not shown the outcome its requests would acknowledge')
  assert.match(c, /while it brought Case "CASE_X" into focus for the operator\. This is the Board's own record/)
  const firstPing = run.order.findIndex((step) => step.kind === 'mcp' && step.method === 'ping')
  const cRead = run.order.findIndex((step) => step.kind === 'model' && step.n === 2)
  assert.ok(firstPing === -1 || firstPing > cRead, 'a ping was sent while the strip kept for conversation C was unread by C')
  assert.equal(run.pings, 1, 'conversation C\'s model read the strip, and the result was still not acknowledged')
})

for (const interleave of [true, false]) {
  test(`RT-CONV-4 a write whose answer was lost before any sign of admission is found again${interleave
    ? ', and its outcome read by another conversation is shown to its own' : ''}`, async () => {
    // The stream carrying A's ApplyAction answer is cut before any progress, and cannot be resumed:
    // the model is told the call may or may not have run. The strip the new session starts with
    // shows one ApplyAction the strip before the call did not — that call, admitted after all.
    const port = await freePort()
    const run = await runAgent({
      argv: ['--serve'],
      env: { RULITH_SERVE_PORT: String(port), ...serveEnv(`conversations-lost-${interleave}`) },
      breakStreamOnCall: 1, refuseResume: true,
      serveTasks: [
        { text: 'Ship order 7.', sessionKey: 'client-a' },
        ...(interleave ? [{ text: 'What is going on?', sessionKey: 'client-b' }] : []),
        { text: 'Ship order 7 now.', sessionKey: 'client-a' },
      ],
      waitForServeCompletion: true, stopAfterServe: true,
      tool: (name, args, board, session) => (name === 'ApplyAction' ? confirmed(board.tool('OpenCase', {}, session), args) : undefined),
      model: (round, body) => {
        const said = lastUserText(body)
        if (said.includes('What is going on?')) return answered(body) ? 'Something else happened.' : callTool('QueryBoard', {})
        if (said.includes('Ship order 7 now.')) return answered(body) ? 'Done.' : ship
        return answered(body) ? 'The answer was lost.' : ship
      },
      timeoutMs: 15_000,
    })
    const executed = run.operations.filter((op) => op.tool === 'ApplyAction')
    assert.equal(executed.length, 1, `the write ran ${executed.length} times: ${run.verbs.join(', ')}`)
    const [lost] = toolResults(run.modelRequests.find((body) => lastUserText(body).includes('Ship order 7.') && answered(body)))
    assert.equal(lost.errorCode, 'response_lost')
    const shipped = run.modelRequests.filter((body) => lastUserText(body).includes('Ship order 7 now.'))
    const refusal = toolResults(shipped.at(-1)).at(-1)
    assert.equal(refusal.errorCode, 'previous_result_undelivered')
    assert.equal(JSON.parse(refusal.operations.find((entry) => entry.label === 'ApplyAction demo.ship').result.content[0].text)
      .result.status, 'confirmed')
    assert.deepEqual(run.verbs, interleave ? ['ApplyAction', 'QueryBoard'] : ['ApplyAction', 'ApplyAction'])
  })
}

test('RT-CONV-5 an outcome captured for a conversation is shown once, in the strip of its next read', async () => {
  // As RT-CONV-1, but conversation A's model reads the Board when its user comes back. By then the
  // authority carries A's result as a summary only — B's turn acknowledged it — so the captured
  // entry, with the result in full, takes that entry's place in A's read. Shown there, it is not
  // shown again, and a write A's model sends after reading it goes to the authority.
  const port = await freePort()
  let applyActions = 0
  let lookSeen = false
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), ...serveEnv('conversations-read'), RULITH_MAX_ROUNDS: '4' },
    serveTasks: [
      { text: 'Ship order 7.', sessionKey: 'client-a' },
      { text: 'What is going on?', sessionKey: 'client-b' },
      { text: 'Did it ship?', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    hold: (name) => {
      if (name !== 'ApplyAction' || ++applyActions > 1) return undefined
      return { answer: 'running', holdMs: 50, settle: (now) => {
        if (lookSeen) return { state: 'done' }
        if (now.tool === 'QueryBoard') lookSeen = true
        return undefined
      } }
    },
    tool: (name, args, board, session) => (name === 'ApplyAction' ? confirmed(board.tool('OpenCase', {}, session), args) : undefined),
    model: (round, body) => {
      const said = lastUserText(body)
      if (said.includes('What is going on?')) return answered(body) ? 'Something else happened.' : callTool('QueryBoard', {})
      if (said.includes('Did it ship?')) {
        const results = (body.messages ?? []).filter((message) => message.role === 'tool').length
        return results === 1 ? callTool('QueryBoard', {}) : results === 2 ? callTool('ApplyBatch',
          { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] }) : 'It shipped.'
      }
      return answered(body) ? 'It is still running.' : ship
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard', 'QueryBoard', 'QueryBoard', 'ApplyBatch'],
    'the write A proposed after reading the outcome was not sent, or something was sent twice')
  const asked = run.modelRequests.filter((body) => lastUserText(body).includes('Did it ship?'))
  const [read] = toolResults(asked[1]).slice(-1)
  const entry = read.operations.find((row) => row.label === 'ApplyAction demo.ship')
  assert.equal(JSON.parse(entry.result.content[0].text).result.status, 'confirmed',
    'conversation A\'s read did not carry the outcome it had not been shown')
  assert.equal(read.operations.filter((row) => row.label === 'ApplyAction demo.ship').length, 1)
  const [batch] = toolResults(asked[2]).slice(-1)
  assert.equal(batch.accepted, true)
  assert.equal(Object.hasOwn(batch.operations.find((row) => row.label === 'ApplyAction demo.ship'), 'result'), false,
    'the captured outcome was shown a second time')
})

// ── What a conversation's model has not read outlives its transcript ─────────

const OWNER = { origin: 'https://console.example.test', accountId: 'account-a', agentId: TEST_AGENT_ID }
const historyDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-outcomes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const historyEnv = (dir) => ({ RULITH_CONVERSATION_DIR: dir, RULITH_CONVERSATION_OWNER: JSON.stringify(OWNER) })
/** The unread-outcome record kept beside the history in `dir`, as written. */
const keptBeside = (dir) => {
  const folder = readdirSync(dir).find((name) => name.endsWith('.json.d'))
  const path = folder === undefined ? undefined : join(dir, folder, '_unread-outcomes.json')
  return path !== undefined && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).conversations : {}
}
/** A model that acts on what it was given: it ships unless something in front of it shows how demo.ship ended. */
const sawShipOutcome = (body) => /confirmed|demo\.ship: done|\\"state\\":\\"done\\"|"state":"done"/.test(JSON.stringify(body.messages ?? []))
const shipUnlessSeen = (body) => (answered(body) ? 'Done.' : sawShipOutcome(body) ? 'It already shipped.' : ship)
const shipping = (name, args, board, session) => (name === 'ApplyAction' ? confirmed(board.tool('OpenCase', {}, session), args) : undefined)

for (const [slots, other] of [['1', 'reads'], ['1', 'chats'], ['64', 'reads']]) {
  test(`RT-CONV-6 a result whose turn ended before its model read it is shown again after its slot was reclaimed (slots ${slots},`
    + ` the other conversation ${other})`, async (t) => {
    // A's write settles in its own answer, but A's turn ends at its round limit before A's model reads
    // it. B is served next; with one slot, A's transcript is dropped to make room, and comes back as
    // text. When B reads the Board its strip captures A's outcome; when B only chats, nothing does, and
    // A's next write reads the position first. Either way A's write is not sent before its model has
    // been shown how the first one ended.
    const dir = historyDir(t)
    const run = await runAgent({
      argv: ['--serve'],
      env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv(`conversations-evict-${slots}-${other}`),
        RULITH_MAX_ROUNDS: '1', RULITH_SERVE_SLOTS_MAX: slots, ...historyEnv(dir) },
      serveTasks: [
        { text: 'Ship order 7.', sessionKey: 'client-a' },
        { text: 'What is going on?', sessionKey: 'client-b' },
        { text: 'Ship order 7 now.', sessionKey: 'client-a' },
      ],
      waitForServeCompletion: true, stopAfterServe: true, captureLocalEvents: true,
      tool: shipping,
      model: (round, body) => {
        const said = lastUserText(body)
        if (said.includes('What is going on?')) return other === 'reads' ? callTool('QueryBoard', {}) : 'Nothing much.'
        if (said.includes('Ship order 7 now.')) return shipUnlessSeen(body)
        return ship
      },
      timeoutMs: 15_000,
    })
    assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
    const executed = run.operations.filter((op) => op.tool === 'ApplyAction')
    assert.equal(executed.length, 1, `the write ran ${executed.length} times: ${run.verbs.join(', ')}`)
    if (slots === '1') {
      // The second write never left this host: it was refused here, with the outcome. (The round
      // limit ends that turn too, so the refusal is seen in what this host reported, not in a later
      // model request.)
      assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard'], 'the write was sent, or the position was read twice')
      const refusal = run.localEvents.find((event) => event.type === 'verdict' && event.cmd === 'ApplyAction'
        && event.refusedLocally === true)
      assert.equal(refusal?.notExecuted, true, 'the second write was not refused here')
      assert.match(String(refusal.teaching), /did not send it/)
    } else {
      // With room to spare the transcript is kept, and A's model reads the result in it.
      assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard'])
      assert.match(JSON.stringify(run.modelRequests.at(-1).messages), /confirmed/)
    }
  })
}

test('RT-CONV-7 after a restart, a conversation is shown an outcome its model never read before its next write', async (t) => {
  // RT-CONV-1's sequence, then the process stops before A's next message. A's history comes back as
  // text; the authority already counts A's result acknowledged — B read it — and would run A's write
  // again. The outcome's identity was kept beside the history, so A's write is refused once more, with
  // the outcome as a fresh strip shows it.
  const dir = historyDir(t)
  const listenPort = await freePort()
  let applyActions = 0
  let lookSeen = false
  const first = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-restart-1'), ...historyEnv(dir) },
    serveTasks: [
      { text: 'Ship order 7.', sessionKey: 'client-a' },
      { text: 'What is going on?', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    hold: (name) => {
      if (name !== 'ApplyAction' || ++applyActions > 1) return undefined
      return { answer: 'running', holdMs: 50, settle: (now) => {
        if (lookSeen) return { state: 'done' }
        if (now.tool === 'QueryBoard') lookSeen = true
        return undefined
      } }
    },
    tool: shipping,
    model: (round, body) => {
      const said = lastUserText(body)
      if (said.includes('What is going on?')) return answered(body) ? 'Something else happened.' : callTool('QueryBoard', {})
      return answered(body) ? 'It is still running.' : ship
    },
    timeoutMs: 15_000,
  })
  const w1 = first.operations.find((op) => op.tool === 'ApplyAction')
  assert.equal(w1.state, 'done')
  assert.equal(w1.acked, true, 'the arm needs the authority to count the result acknowledged before the restart')
  assert.deepEqual(keptBeside(dir)['client-a']?.map(({ label, at, state, unread }) => ({ label, at, state, unread })),
    [{ label: 'ApplyAction demo.ship', at: w1.at, state: 'done', unread: true }])
  // The authority keeps W1 as it was; this process starts with nothing but the history.
  const second = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-restart-2'), ...historyEnv(dir) },
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'done', acked: true, at: w1.at, since: w1.since,
      core: { accepted: true, result: { action: 'demo.ship', done: true, ok: true, status: 'confirmed' } } }],
    serveTasks: [{ text: 'Ship order 7 now.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => shipUnlessSeen(body),
    timeoutMs: 15_000,
  })
  assert.deepEqual(second.serveStatuses, [202], `${second.stdout}\n${second.stderr}`)
  assert.deepEqual(second.verbs, ['QueryBoard'], 'the write was sent after the restart, or the position was not read for it')
  const refusal = toolResults(second.modelRequests.at(-1)).at(-1)
  assert.equal(refusal.errorCode, 'previous_result_undelivered')
  assert.equal(refusal.requestExecuted, false)
  const shown = refusal.operations.find((entry) => entry.label === 'ApplyAction demo.ship')
  assert.equal(shown.state, 'done', 'the outcome was not shown as the fresh strip shows it')
  assert.ok(refusal.view, 'the refusal does not carry the position it was read with')
  assert.match(lastUserText(second.modelRequests[0]), /Outcomes you have not been shown yet: ApplyAction demo\.ship\./)
  // Read now: nothing is kept for A any more.
  assert.equal(keptBeside(dir)['client-a'], undefined)
})

test('RT-CONV-8 a write whose turn ended in a model error is shown again after its slot was reclaimed', async (t) => {
  const dir = historyDir(t)
  let aRounds = 0
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-model-error'), RULITH_SERVE_SLOTS_MAX: '1',
      ...historyEnv(dir) },
    serveTasks: [
      { text: 'Ship order 7.', sessionKey: 'client-a' },
      { text: 'What is going on?', sessionKey: 'client-b' },
      { text: 'Ship order 7 now.', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => {
      const said = lastUserText(body)
      if (said.includes('What is going on?')) return answered(body) ? 'Something else happened.' : callTool('QueryBoard', {})
      if (said.includes('Ship order 7 now.')) return shipUnlessSeen(body)
      aRounds += 1
      return aRounds === 1 ? ship : { status: 503, body: { error: 'model provider unavailable' } }
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  const executed = run.operations.filter((op) => op.tool === 'ApplyAction')
  assert.equal(executed.length, 1, `the write ran ${executed.length} times: ${run.verbs.join(', ')}`)
  assert.equal(run.verbs.filter((verb) => verb === 'ApplyAction').length, 1, 'the second write left this host')
})

test('RT-CONV-9 a conversation restored without unread outcomes is not refused, and costs no extra read', async (t) => {
  const dir = historyDir(t)
  const listenPort = await freePort()
  const first = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-clean-1'), ...historyEnv(dir) },
    serveTasks: [{ text: 'Ship order 7.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => (answered(body) ? 'Shipped.' : ship),
    timeoutMs: 15_000,
  })
  const w1 = first.operations.find((op) => op.tool === 'ApplyAction')
  assert.deepEqual(keptBeside(dir), {}, 'a result the model read was still kept')
  const second = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-clean-2'), ...historyEnv(dir) },
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'done', acked: true, at: w1.at, since: w1.since,
      core: { accepted: true, result: { action: 'demo.ship', done: true, ok: true, status: 'confirmed' } } }],
    serveTasks: [{ text: 'Ship order 8 too.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => (answered(body) ? 'Shipped.' : ship),
    timeoutMs: 15_000,
  })
  assert.deepEqual(second.serveStatuses, [202], `${second.stdout}\n${second.stderr}`)
  assert.deepEqual(second.verbs, ['ApplyAction'], 'a conversation with nothing unread was refused or made to read first')
  assert.equal(toolResults(second.modelRequests.at(-1)).at(-1).accepted, true)
})

test('RT-CONV-10 a restored outcome the strip no longer lists is named, and the write still waits for the model', async (t) => {
  // A's result was never read, and by the time A comes back six later writes have pushed it out of
  // the strip: the latest five and the latest settled write. The refusal says so, and where to look.
  const dir = historyDir(t)
  const listenPort = await freePort()
  const first = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-gone-1'), RULITH_MAX_ROUNDS: '1',
      ...historyEnv(dir) },
    serveTasks: [{ text: 'Ship order 7.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: () => ship,
    timeoutMs: 15_000,
  })
  const w1 = first.operations.find((op) => op.tool === 'ApplyAction')
  assert.equal(keptBeside(dir)['client-a']?.[0]?.unread, true)
  const later = Array.from({ length: 6 }, () => ({ tool: 'ApplyBatch', label: 'ApplyBatch', state: 'done', acked: true,
    core: { accepted: true } }))
  const second = await runAgent({
    argv: ['--serve'], listenPort,
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-gone-2'), ...historyEnv(dir) },
    priorOperations: [{ tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'done', acked: true, at: w1.at, since: w1.since,
      core: { accepted: true, result: { action: 'demo.ship', done: true, ok: true, status: 'confirmed' } } }, ...later],
    serveTasks: [{ text: 'Ship order 7 now.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => (answered(body) ? 'I will check it in Console.' : ship),
    timeoutMs: 15_000,
  })
  assert.deepEqual(second.verbs, ['QueryBoard'], 'the write was sent although its conversation had not read the earlier outcome')
  const refusal = toolResults(second.modelRequests.at(-1)).at(-1)
  assert.equal(refusal.requestExecuted, false)
  assert.equal(refusal.operations.some((entry) => entry.label === 'ApplyAction demo.ship'), false, 'the arm needs it out of the strip')
  assert.match(refusal.teaching, /ApplyAction demo\.ship \(admitted [^)]+\) was last shown to this Runtime as done, and is no longer among the recent operations/)
  assert.match(refusal.teaching, /a person can check it in Console/)
})

test('RT-CONV-11 a write whose answer was lost stays findable through a later call the authority refused before running it', async () => {
  // A's write is admitted, but its answer is cut before any progress and the new session's state form
  // shows nothing. B's write is then refused before execution — no operation — and its strip is the
  // first to show A's call: the one new ApplyAction since A sent it. That is still A's, so the outcome
  // it carries is captured for A, and A's own write is not sent again.
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), ...serveEnv('conversations-lost-refused'), RULITH_MAX_ROUNDS: '4' },
    breakStreamOnCall: 2, refuseResume: true, omitStrip: (method) => method === 'initialize',
    serveTasks: [
      { text: 'Look, then ship order 7.', sessionKey: 'client-a' },
      { text: 'Record a fact.', sessionKey: 'client-b' },
      { text: 'Ship order 7 now.', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true, stopAfterServe: true,
    tool: shipping,
    model: (round, body) => {
      const said = lastUserText(body)
      const results = toolResults(body).length
      if (said.includes('Record a fact.')) return answered(body) ? 'Not recorded yet.'
        : callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (said.includes('Ship order 7 now.')) return answered(body) ? 'Done.' : ship
      return results === 0 ? callTool('QueryBoard', {}) : results === 1 ? ship : 'The answer was lost.'
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202, 202], `${run.stdout}\n${run.stderr}`)
  const [, , refused] = run.toolCalls
  assert.equal(refused?.name, 'ApplyBatch')
  const executed = run.operations.filter((op) => op.tool === 'ApplyAction')
  assert.equal(executed.length, 1, `the write ran ${executed.length} times: ${run.verbs.join(', ')}`)
  assert.deepEqual(run.verbs, ['QueryBoard', 'ApplyAction', 'ApplyBatch'], 'A\'s second write left this host')
})

test('RT-CONV-12 a call no strip lists any more is not kept for ever', async (t) => {
  // The authority stops listing a call that was still running: the wait answers `unlisted`, and the
  // conversation keeps the call — until the next whole strip that does not list it either. Nothing
  // more can be shown of it, and a memory of such calls, one conversation per message, would only grow.
  const dir = historyDir(t)
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(await freePort()), ...serveEnv('conversations-unlisted'), RULITH_MAX_ROUNDS: '4',
      ...historyEnv(dir) },
    serveTasks: [{ text: 'Ship order 7.', sessionKey: 'client-a' }],
    waitForServeCompletion: true, stopAfterServe: true,
    hold: (name) => (name === 'ApplyAction' ? { answer: 'running', holdMs: 50 } : undefined),
    hideOperation: (op, seen) => op.tool === 'ApplyAction' && seen.pings >= 1,
    model: (round, body) => {
      const results = toolResults(body)
      return results.length === 0 ? ship : results.length === 1 ? callTool('QueryBoard', {}) : 'It is no longer listed.'
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202], `${run.stdout}\n${run.stderr}`)
  const [, unlisted] = run.modelRequests.map((body) => toolResults(body).at(-1))
  assert.match(String(unlisted?.teaching), /no longer appears among your recent operations/, 'the arm did not produce an unlisted answer')
  assert.deepEqual(run.verbs, ['ApplyAction', 'QueryBoard', 'QueryBoard'])
  assert.equal(keptBeside(dir)['client-a'], undefined, 'a call no strip lists was still kept for its conversation')
})
