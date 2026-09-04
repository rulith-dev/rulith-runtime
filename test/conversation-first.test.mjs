// SPDX-License-Identifier: Apache-2.0
/**
 * The model surface is four protocol verbs called as ordinary MCP tools.
 *
 * `OpenCase` / `ApplyBatch` / `ApplyAction` / `CloseCase` are the whole vocabulary
 * (board-protocol-spec §6.0b). There is no second grammar: no fenced JSON, no `DONE:`,
 * no host-invented tool names. One loop serves both policies — a conversation returns to
 * the user the moment the model answers with text, and `--task` autopilot keeps going
 * while the Board still has something to say.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  MODEL_VERBS, HOP_FAILURE, advertisedTools, callTool, declaredToolsOf, defaultGateway, emptyView, runAgent, systemTextOf,
} from './support/agent-harness.mjs'

const freePort = async () => {
  const server = createServer()
  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))
  await new Promise((ready) => server.close(ready))
  return port
}

// ── RT-TOOLS: what the model is offered, and what it may not reach ───────────
//
// The machine authority for the model surface is `agentVerb: true` in the core repo's
// protocol/operations.json. This repo ships without it, so the arm reads it when the
// checkout is present and falls back to a vendored copy otherwise — announcing the
// fallback, because a guard that silently compares a constant to itself is not a guard.

const CORE_OPERATIONS = 'D:/Work/rulith/.claude/worktrees/rulith-release-review-f2c0ed/protocol/operations.json'
const VENDORED_AGENT_VERBS = ['OpenCase', 'ApplyBatch', 'ApplyAction', 'CloseCase']

function authoritativeAgentVerbs() {
  if (!existsSync(CORE_OPERATIONS)) {
    console.log(`skip: ${CORE_OPERATIONS} is not present; comparing against the vendored four-name constant instead`)
    return VENDORED_AGENT_VERBS
  }
  const registry = JSON.parse(readFileSync(CORE_OPERATIONS, 'utf8'))
  const operations = Array.isArray(registry.operations) ? registry.operations : []
  assert.ok(operations.length >= 20, `only ${operations.length} operations were read; the registry scan lost its source`)
  return operations.filter((operation) => operation.agentVerb === true).map((operation) => String(operation.kind))
}

test('RT-TOOLS-1 the model-facing tools are exactly the protocol agentVerb set', async () => {
  const expected = authoritativeAgentVerbs()
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const offered = declaredToolsOf(run.modelRequests[0]).map((tool) => tool.name)
  assert.deepEqual([...offered].sort(), [...expected].sort(),
    `the model was offered a different surface than the protocol declares: ${offered.join(', ')}`)
  assert.deepEqual([...MODEL_VERBS].sort(), [...expected].sort(),
    'the harness constant drifted from the protocol registry')
  for (const hostOnly of ['GetCompletion', 'agent_protocol', 'RunDischarge', 'PauseCase', 'ResumeCase', 'GetProjection']) {
    assert.equal(offered.includes(hostOnly), false, `${hostOnly} is a host tool and must never be offered to the model`)
  }
})

test('RT-TOOLS-2 the system prompt carries no wire form and no reply protocol', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  const system = systemTextOf(run.modelRequests[0])
  assert.ok(system.length > 200, 'the system prompt was not recovered from the request')
  for (const forbidden of ['"kind":', '{"op"', 'DONE:', 'STOP:', 'VIEW:', '```']) {
    assert.equal(system.includes(forbidden), false, `the system prompt still teaches ${forbidden}`)
  }
  // What it must say instead: the five shapes a step of reasoning may take.
  for (const shape of ['assert_fact', 'add_axiom', 'declare_hypothesis', 'record_result', 'record_conflict']) {
    assert.ok(system.includes(shape), `the prompt does not name the ${shape} shape`)
  }
  assert.match(system, /Never assert acceptance_met, test_result, certification or rulith\.exploration\.completed/)
})

test('RT-TOOLS-3 no model-facing schema exposes a host-owned field', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  const tools = declaredToolsOf(run.modelRequests[0])
  assert.equal(tools.length, 4)
  const names = (node, found = []) => {
    if (Array.isArray(node)) { for (const child of node) names(child, found) ; return found }
    if (node === null || typeof node !== 'object') return found
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') found.push(...Object.keys(value))
      names(value, found)
    }
    return found
  }
  for (const tool of tools) {
    const properties = names(tool.schema)
    assert.ok(properties.length > 0, `${tool.name} lost its schema entirely rather than one property`)
    for (const owned of ['case', 'requestId', 'expectedRevision']) {
      assert.equal(properties.includes(owned), false, `${tool.name} still shows the host-owned ${owned} property`)
    }
  }
  // Calibration: the endpoint really does advertise the host-owned fields, so the strip
  // above is removing something rather than describing a surface that never had them.
  const advertised = JSON.stringify(advertisedTools())
  assert.match(advertised, /"case"/)
  assert.match(advertised, /"requestId"/)
})

test('the host attaches the Case envelope and request identity the model never sees', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case and record a fact.'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const opened = run.toolCalls.find((call) => call.name === 'OpenCase')
  // OpenCase carries no Case envelope: the Case it asks for does not exist yet, and the
  // previous one would bind the new work to the wrong context.
  assert.equal(opened.args.case, undefined, `OpenCase carried a Case envelope: ${JSON.stringify(opened.args)}`)
  assert.match(String(opened.args.requestId), /^[0-9a-f-]{36}$/)
  const batch = run.toolCalls.find((call) => call.name === 'ApplyBatch')
  assert.equal(typeof batch.args.case?.id, 'string')
  assert.equal(batch.args.case.expectedRevision, 'c0', 'the host did not present the revision the Board last reported')
  assert.notEqual(batch.args.requestId, opened.args.requestId, 'distinct submissions must not share one request identity')
  // None of it came back through the model.
  assert.doesNotMatch(JSON.stringify(run.modelRequests[1].messages.filter((message) => message.role === 'assistant')), /requestId|expectedRevision/)
})

test('RT-TOOLS-4 a tool that is not one of the four is refused locally and never forwarded', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['remove the pack'],
    model: (round) => (round === 1
      ? callTool('RemovePack', { packType: 'domain', name: 'verified-calculation' })
      : 'I did not have that ability, so I did nothing.'),
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('RemovePack'), false,
    `RemovePack reached the authority under the Agent's own credential: ${run.verbs.join(', ')}`)
  assert.match(run.stdout, /Refused locally/)
  assert.match(run.stdout, /RemovePack is not a tool this Agent Runtime carries/)
  assert.match(JSON.stringify(run.modelRequests[1]), /tool_not_carried/,
    'the refusal must come back as a tool result, not vanish')
})

// ── The scenario the surface exists for ──────────────────────────────────────

test('open, batch, act, and close: the Board refuses an uncertified completion and accepts a certified one', async () => {
  const gateway = defaultGateway({ certifyAfterBatch: false })
  const run = await runAgent({
    // The autopilot policy, because this is the scenario in which the host waits for a
    // dispatched Action instead of spending a model round asking whether it landed.
    argv: ['investigate this and finish when the Board permits it'],
    env: { RULITH_MAX_ROUNDS: '8', RULITH_SETTLE_WAIT_MS: '5000' },
    gateway,
    tool: (name, args, board) => {
      // The batch adds a derived fact; certification arrives only after the Action settles.
      if (name === 'ApplyBatch') {
        const answer = board.tool(name, args)
        board.state.view = emptyView({ ...board.state.view, frontier: ['derived:total'], goal: board.state.caseId })
        return { ...answer, view: board.state.view }
      }
      if (name === 'GetCompletion' && board.state.pending > 0) {
        board.state.pending = 0
        board.state.view = emptyView({ ...board.state.view, inFlight: [], certified: true, floor: 'attested', state: 'done' })
        return board.tool(name, args)
      }
      return undefined
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }] })
      if (round === 3) return callTool('CloseCase', { disposition: 'completed' })
      if (round === 4) return callTool('ApplyAction', { action: 'compute_total', target: 'L1' })
      if (round === 5) return callTool('CloseCase', { disposition: 'completed' })
      return 'The Case is closed.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs.filter((verb) => verb !== 'GetCompletion'),
    ['OpenCase', 'ApplyBatch', 'CloseCase', 'ApplyAction', 'CloseCase'])
  // The derived fact reached the model through the tool result, not a second Board read.
  assert.match(JSON.stringify(run.modelRequests[2]), /derived:total/,
    'the Case View in the tool result did not carry what the Board derived')
  assert.match(JSON.stringify(run.modelRequests[3]), /case_not_certified/,
    'an uncertified completion was not refused with the Board teaching')
  // The dispatched Action was reported as pending with its invocation, not as done.
  assert.match(JSON.stringify(run.modelRequests[4]), /inv_1/)
  assert.match(run.stdout, /Closed Case .* with disposition "completed"/)
})

test('the Board decides completion: an uncertified Case is not closed by the host', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith, but finish only if the Board permits it.'],
    gateway: defaultGateway({ certifyAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('CloseCase', { disposition: 'completed' })
      return 'The Board refused completion, so the Case remains open.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(JSON.stringify(run.modelRequests[2]), /case_not_certified/)
  assert.match(run.stdout, /Board rejected CloseCase/)
  assert.doesNotMatch(run.stdout, /Closed Case/)
})

test('a greeting is answered normally with no Case and no Board call', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['你好'],
    model: () => '你好！有什么想一起处理的吗？',
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'a plain conversational reply must return control to the user')
  assert.deepEqual(run.verbs, [], `a greeting unexpectedly touched the Board: ${run.verbs.join(', ')}`)
  assert.deepEqual(run.kinds, [], `a greeting read Board governance: ${run.kinds.join(', ')}`)
  assert.match(run.stdout, /你好！有什么想一起处理的吗？/)
  assert.doesNotMatch(run.stdout, /Case Context opened|pending_case_id/)
})

test('a selected Case persists across messages and is never advanced implicitly', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start a governed investigation.', 'Before the next step, explain what you know.'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return 'The Case is open. I will wait for your next instruction.'
      return 'The same Case is still open; I took no further step.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1,
    `a follow-up message opened another Case: ${run.verbs.join(', ')}`)
  assert.equal(run.verbs.includes('CloseCase'), false, 'the host closed a Case the model did not close')
  assert.equal(run.kinds.includes('RunDischarge'), false,
    'the host advanced verification during an ordinary conversational turn')
  assert.match(JSON.stringify(run.modelRequests[2]), /Case View/,
    'the next conversational turn must receive the selected Case state')
})

test('the model may not open a second Case over an active one', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case, then open another.'],
    model: (round) => {
      if (round <= 2) return callTool('OpenCase', {})
      return 'One Case at a time.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1,
    `a second OpenCase reached the authority: ${run.verbs.join(', ')}`)
  assert.match(JSON.stringify(run.modelRequests[2]), /case_already_selected/)
})

test('a Case-scoped verb without a Case is refused before the wire', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record a fact.'],
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'I will open a Case first.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), false, `an unscoped batch reached the authority: ${run.verbs.join(', ')}`)
  assert.match(JSON.stringify(run.modelRequests[1]), /case_context_required/)
})

test('only the first tool call in a turn is executed, and the rest still receive a result', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Do both steps at once.'],
    model: (round) => (round === 1
      ? {
          text: '',
          toolCalls: [
            { name: 'OpenCase', input: {} },
            { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
          ],
        }
      : 'I will take one step at a time.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), false,
    `the second call in one turn was executed against a Board state it never saw: ${run.verbs.join(', ')}`)
  const results = JSON.stringify(run.modelRequests[1])
  assert.match(results, /one_step_per_turn/)
  // Every tool_use must be answered, or the next Anthropic request is malformed.
  assert.match(results, /OpenCase/)
})

test('the configured Case Type cannot be overridden by model output', async () => {
  const run = await runAgent({
    argv: ['--case-type', 'verified_calculation'],
    chatLines: ['Use Rulith for this governed calculation.'],
    model: (round) => (round === 1
      ? callTool('OpenCase', { caseType: 'exploration' })
      : 'The configured Case Type is now active.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const opened = run.toolCalls.find((call) => call.name === 'OpenCase')
  assert.equal(opened?.args?.caseType, 'verified_calculation',
    'the host-selected governance contract must remain authoritative')
})

test('with no Case Type pinned, the model may select one from its own catalogue', async () => {
  // The other half of the rule. A host that always overwrote `caseType` would pass the
  // arm above while removing a field the protocol puts on the model surface.
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a research Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', { caseType: 'research' }) : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.find((call) => call.name === 'OpenCase')?.args?.caseType, 'research')
})

test('a locked Board never gives the model an add_axiom handle', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith under the installed governance.'],
    gateway: defaultGateway({ lawLocked: true }),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The locked Case exposes installed capabilities only.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const beforeOpen = systemTextOf(run.modelRequests[0])
  const afterOpen = systemTextOf(run.modelRequests[1])
  assert.doesNotMatch(beforeOpen, /permitted inside this Case/,
    'the unscoped first turn exposed a provisional-law permission before lock state was known')
  assert.match(afterOpen, /Legislation is locked on this Board/)
  assert.doesNotMatch(afterOpen, /add_axiom and define_action are permitted/)
})

test('an exploration Case says so in one line, and only after the Case exists', async () => {
  const run = await runAgent({
    argv: ['--case-type', 'exploration'],
    chatLines: ['Explore this.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Exploring.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(systemTextOf(run.modelRequests[0]), /permitted inside this Case/)
  assert.match(systemTextOf(run.modelRequests[1]), /add_axiom and define_action are permitted inside this Case/)
})

// ── Transport ────────────────────────────────────────────────────────────────

test('the Anthropic wire carries tool definitions, tool_use blocks, and tool_result replies', async () => {
  const run = await runAgent({
    argv: [],
    provider: 'anthropic',
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const first = run.modelRequests[0]
  assert.ok(Array.isArray(first.tools) && first.tools.every((tool) => tool.input_schema !== undefined),
    `Anthropic tools must carry input_schema: ${JSON.stringify(first.tools)}`)
  assert.equal(typeof first.system, 'string', 'Anthropic carries the system prompt as a top-level field')
  const second = run.modelRequests[1]
  const assistant = second.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant.content.some((block) => block.type === 'tool_use' && block.name === 'OpenCase'),
    `the assistant turn was not replayed as a tool_use block: ${JSON.stringify(assistant)}`)
  const results = second.messages.filter((message) => message.role === 'user')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
  assert.equal(results.length, 1, 'the tool result was not replayed as a tool_result block')
  assert.equal(results[0].tool_use_id, assistant.content.find((block) => block.type === 'tool_use').id)
  assert.equal(run.verbs.includes('OpenCase'), true)
})

test('the OpenAI wire carries function tools, tool_calls, and role tool replies', async () => {
  const run = await runAgent({
    argv: [],
    provider: 'openai',
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}, { id: 'call_abc' }) : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const first = run.modelRequests[0]
  assert.ok(Array.isArray(first.tools) && first.tools.every((tool) => tool.type === 'function' && tool.function.parameters !== undefined),
    `OpenAI tools must be function definitions with parameters: ${JSON.stringify(first.tools)}`)
  assert.equal(first.messages[0].role, 'system')
  const second = run.modelRequests[1]
  const assistant = second.messages.find((message) => message.role === 'assistant' && message.tool_calls)
  assert.equal(assistant.tool_calls[0].function.name, 'OpenCase')
  const toolMessage = second.messages.find((message) => message.role === 'tool')
  assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id)
  assert.match(String(toolMessage.content), /"accepted":true/)
})

test('an endpoint that rejects tool definitions gets the same tools described in the prompt', async () => {
  const run = await runAgent({
    argv: [],
    refuseTools: true,
    chatLines: ['Open a Case.'],
    model: (round, body) => {
      // The first request carried tools and was refused; the retry must not.
      if (body.tools !== undefined) return 'unreachable'
      const spoken = JSON.stringify(body.messages).includes('OpenCase result') ? 'Opened.' : ''
      return spoken === '' ? '{"tool":"OpenCase","input":{}}' : spoken
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /refused a request carrying tool definitions/)
  assert.equal(run.verbs.includes('OpenCase'), true,
    `the fallback lost the model's ability to reach the Board: ${run.verbs.join(', ')}`)
  const emulated = run.modelRequests.filter((request) => request.tools === undefined)
  assert.ok(emulated.length >= 1)
  const system = systemTextOf(emulated[0])
  for (const verb of MODEL_VERBS) assert.ok(system.includes(verb), `${verb} is missing from the emulated tool guide`)
  assert.match(system, /reply with exactly one JSON object/)
})

test('RULITH_MODEL_TOOLS=emulated selects the fallback transport without a failed request', async () => {
  const run = await runAgent({
    argv: [],
    env: { RULITH_MODEL_TOOLS: 'emulated' },
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? '{"tool":"OpenCase","input":{}}' : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.modelRequests.every((request) => request.tools === undefined),
    'the forced fallback still sent tool definitions')
  assert.equal(run.verbs.includes('OpenCase'), true)
  assert.doesNotMatch(run.stdout, /refused a request carrying tool definitions/,
    'no request failed, so nothing should be reported as a fallback')
})

test('a transport failure keeps the same requestId and is reported as an unknown outcome', async () => {
  let attempts = 0
  const batch = { operations: [{ op: 'assert_fact', id: 'F_AMBIG', predicate: 'scratch.demo.value', args: { value: 'one' } }] }
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Record this despite a transient network failure.'],
    tool: (name) => {
      if (name !== 'ApplyBatch') return undefined
      attempts += 1
      return attempts === 1 ? HOP_FAILURE : undefined
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round <= 3) return callTool('ApplyBatch', batch)
      return 'The retry landed.'
    },
  })

  const sent = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
  assert.equal(sent.length, 2, `expected the original submission and one unchanged retry: ${JSON.stringify(run.verbs)}`)
  assert.equal(sent[0].args.requestId, sent[1].args.requestId,
    'an unchanged retry after an unknown outcome must reach the same idempotency slot'
    + ` and may otherwise be applied twice: ${sent[0].args.requestId} vs ${sent[1].args.requestId}`)
  const feedback = JSON.stringify(run.modelRequests[2])
  assert.match(feedback, /the outcome of this step is unknown/)
  assert.match(feedback, /Retry the identical step/)
  assert.doesNotMatch(feedback, /The Board refused|Correct the request/,
    'transport uncertainty was misreported as a semantic refusal that invites a new body')
  assert.match(run.stdout, /Board outcome unknown for ApplyBatch/)
})

test('an empty arguments string is an empty object, not a malformed call', async () => {
  // Several OpenAI-compatible endpoints send `""` for a tool that takes no arguments.
  // Refusing it locally would refuse every no-argument verb on those endpoints, and the
  // symptom — "the model kept trying to open a Case and nothing happened" — points at
  // the model rather than at the client that dropped the call.
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1
      ? { text: '', toolCalls: [{ name: 'OpenCase', input: {}, rawArguments: '' }] }
      : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('OpenCase'), true, `an empty argument string was refused: ${run.verbs.join(', ')}`)
})

test('the Anthropic transcript alternates roles even when the host adds its own settlement turn', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    provider: 'anthropic',
    env: { RULITH_MAX_ROUNDS: '4', RULITH_AUTO_DISCHARGE: 'on' },
    gateway: defaultGateway({ certifyAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Finished.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const last = run.modelRequests.at(-1).messages
  assert.equal(last[0].role, 'user', 'an Anthropic conversation must begin with a user turn')
  for (let index = 1; index < last.length; index++) {
    assert.notEqual(last[index].role, last[index - 1].role,
      `two ${last[index].role} turns in a row: the host's settlement message was appended without folding.\n${JSON.stringify(last.map((message) => message.role))}`)
  }
  // Calibration: the settlement turn really is in there, folded into the tool result.
  assert.match(JSON.stringify(last), /Verification/)
})

test('tool arguments that are not a JSON object are refused locally', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1
      ? { text: '', toolCalls: [{ name: 'OpenCase', input: {}, rawArguments: 'not json' }] }
      : 'I will send a JSON object.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('OpenCase'), false, 'malformed arguments reached the authority')
  assert.match(JSON.stringify(run.modelRequests[1]), /bad_tool_arguments/)
})

// ── Host features the model has no verb for ──────────────────────────────────

test('--case selects an already-running Case and still delivers the user message', async () => {
  const run = await runAgent({
    argv: ['--case', 'case-running', '--case-type', 'exploration'],
    chatLines: ['Continue our discussion without changing the Board.'],
    gateway: defaultGateway({
      cases: [{
        id: 'case-running', root: 'case-running', status: 'running', caseType: 'exploration', revision: 'c7',
        capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
      }],
    }),
    model: () => 'The existing Case is selected. I have not taken another step.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'selecting a running Case must not swallow the user message')
  assert.equal(run.kinds.includes('ResumeCase'), false, 'a running Case does not need a lifecycle transition')
  assert.equal(run.verbs.includes('OpenCase'), false, 'an existing Case must not be opened again')
  assert.match(JSON.stringify(run.modelRequests[0]), /Case View/)
})

test('--case resumes a paused Case, which the model has no verb to do', async () => {
  let resumed = false
  const paused = {
    id: 'case-paused-1', root: 'case-paused-1', status: 'paused', caseType: 'exploration', revision: 'c7',
    capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
  }
  const run = await runAgent({
    argv: ['--case', 'case-paused-1'],
    chatLines: ['Continue the paused work.'],
    protocol: (args) => {
      const operation = args.operation ?? {}
      if (operation.kind === 'GetBoardManifest') {
        return { accepted: true, revision: 'r1', payload: { status: 'open', cases: [resumed ? { ...paused, status: 'running', revision: 'c8' } : paused] } }
      }
      if (operation.kind === 'ResumeCase') { resumed = true; return { accepted: true, revision: 'r2', payload: {} } }
      return undefined
    },
    model: () => 'The paused Case is back.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const resumes = run.boardCalls.filter((call) => call.operation?.kind === 'ResumeCase')
  assert.equal(resumes.length, 1, `expected exactly one ResumeCase; kinds seen: ${run.kinds.join(', ')}`)
  // ResumeCase is caseContext:"boardOnly" in protocol/operations.json: the Case is its
  // subject, not its execution scope, so a `case` binding on it is a protocol error.
  assert.equal(resumes[0].case, undefined, `ResumeCase is boardOnly and must carry no case binding: ${JSON.stringify(resumes[0])}`)
  assert.equal(run.verbs.includes('OpenCase'), false, 'a paused Case must not be reopened')
  assert.match(run.stdout, /Resumed paused Case "case-paused-1"/)
})

test('--serve survives a model-provider failure and keeps taking work', async () => {
  const port = await freePort()
  let modelCalls = 0
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'serve-survives-key' },
    serveTasks: ['this task hits the broken provider', 'this task should still be served'],
    waitForServeCompletion: true,
    model: () => {
      modelCalls += 1
      return modelCalls === 1 ? { status: 500, body: { error: 'model provider unavailable' } } : 'Answered normally.'
    },
    timeoutMs: 4000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const runs = run.serveSnapshot?.runs ?? []
  assert.equal(runs.length, 2, `the queue did not survive the first failure: ${JSON.stringify(runs)}`)
  assert.match(String(runs[0].note), /Model service error \(500\)/,
    `the failed task must be recorded with its reason: ${JSON.stringify(runs[0])}`)
  assert.match(String(runs[1].note), /Response delivered/)
})

test('--serve assigns independent conversation keys when callers omit sessionKey', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'conversation-key-test' },
    serveTasks: ['hello from client A', 'hello from client B'],
    waitForServeCompletion: true,
    model: () => 'Hello. No governed Case is needed.',
    timeoutMs: 4000,
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
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'slot-capacity-test', RULITH_SERVE_SLOTS_MAX: '1' },
    serveTasks: [
      { text: 'Open a governed Case.', sessionKey: 'client-a' },
      { text: 'Start an unrelated conversation.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The Case remains active.'),
    timeoutMs: 5000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1)
  assert.equal(run.kinds.includes('PauseCase'), false, 'local memory pressure must not change the Board Case lifecycle')
  const detached = (run.serveSnapshot?.runs ?? []).find((record) => record.sessionKey === 'client-a' && record.pendingCaseId)
  assert.ok(detached, `the reclaimed Case was not exposed for explicit recovery: ${JSON.stringify(run.serveSnapshot)}`)
  assert.match(detached.note, /remains unchanged on the Board/)
})

test('an explicit caseId cannot silently replace another active Case in the same session', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'case-switch-test' },
    gateway: defaultGateway({
      cases: [{
        id: 'case-other', root: 'case-other', status: 'running', caseType: 'exploration', revision: 'c9',
        capabilityReleaseDigest: 'sha256:cap', caseContractDigest: 'sha256:contract',
      }],
    }),
    serveTasks: [
      { text: 'Open this conversation Case.', sessionKey: 'client-a' },
      { text: 'Continue here.', sessionKey: 'client-a', caseId: 'case-other' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Continuing without changing the selected Case.'),
    timeoutMs: 5000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.match(JSON.stringify(run.modelRequests[2]), /was not selected because this conversation already owns active Case/)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1)
})

test('conversation mode emits Board verdict and completion events for Local observability', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record one governed observation.'],
    captureLocalEvents: true,
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F_EVENT', predicate: 'scratch.demo.observation', args: { value: 'visible' } }] })
      return 'The explicit step was accepted and is visible in the Case trace.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.localEvents.some((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch' && event.accepted === true),
    `Local received no Board verdict: ${JSON.stringify(run.localEvents)}`)
  assert.ok(run.localEvents.some((event) => event.type === 'case-open' && event.ok === true),
    `Local received no Case lifecycle event: ${JSON.stringify(run.localEvents)}`)
  assert.ok(run.localEvents.some((event) => event.type === 'board' && event.floor === 'attested'),
    `Local received no acceptance state, so its Case panel stays blank: ${JSON.stringify(run.localEvents)}`)
})

test('conversation trail remains bounded when transcript compaction runs repeatedly', async () => {
  const chatLines = Array.from({ length: 55 }, (_, index) => `ordinary message ${index + 1}`)
  const run = await runAgent({
    argv: [],
    env: { RULITH_KEEP_MESSAGES: '4' },
    chatLines,
    model: () => 'Ordinary response with no tool call.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, chatLines.length)
  const latest = JSON.stringify(run.modelRequests.at(-1))
  assert.ok((latest.match(/\[conversation/g) ?? []).length <= 40,
    'bounded transcript compaction reintroduced an unbounded conversation trail')
  assert.match(latest, /Transcript compacted/)
})
