// SPDX-License-Identifier: Apache-2.0
/**
 * The model surface is six tools called over one `/mcp` endpoint.
 *
 * `OpenCase` / `ApplyBatch` / `ApplyAction` / `CloseCase` / `QueryBoard` dispatch to Board
 * operations, and `ReadArtifact` reads already-generated result data from the Gateway's
 * data plane. That is the whole vocabulary: no host tool split, no `agent_protocol` escape
 * hatch onto the Board operation registry, no second grammar. One loop serves both
 * policies — a conversation returns to the user the moment the model answers with text,
 * and `--task` autopilot keeps going while a focused Case is still running on the Board.
 */
import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectCaseRoots } from '../local/local-ui.mjs'

import {
  MCP_SURFACE, MODEL_TOOLS, HOP_FAILURE, TEST_AGENT_ID,
  advertisedTools, businessNameCollisionTools, callTool, declaredToolsOf, defaultGateway,
  declareGoal, hostFieldTools, requiredHostFieldTools, runAgent, systemTextOf, withMeta,
} from './support/agent-harness.mjs'

const freePort = async () => {
  const server = createServer()
  let port
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => { port = server.address().port; ready() }))
  await new Promise((ready) => server.close(ready))
  return port
}

const committed = view => ({ accepted: true, view, observation: { consistency: 'committed' }, operations: [] })

// ── RT-TOOLS: what the model is offered, and what it may not reach ───────────
//
// Tool membership has one machine source across the three repositories:
// `protocol/mcp-surface.json` (schema `rulith-mcp-surface/v1`), which names each tool and
// whether it dispatches to a Core operation or to the artifact read. This Runtime carries a
// vendored projection of it, because membership must be known before the first `tools/list`
// reply can be judged.
//
// The guard reconciles three readings so that no two of them can drift silently: the list
// written into the Runtime source, the list this harness advertises, and the list the model
// was actually offered. When the machine source is present it outranks all three. When it
// is not, the arm says so — a guard that quietly compares a constant to itself is not a
// guard, and the point of saying it is that the day the file lands, the message stops.

/** The surface the Runtime source itself declares, read out of the vendored constant. */
function vendoredRuntimeSurface() {
  const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
  const block = /const RULITH_MCP_SURFACE = Object\.freeze\(\[(?<body>[\s\S]*?)\]\)/u.exec(source)
  assert.ok(block, 'the Runtime no longer declares a vendored MCP surface list; this guard has lost its subject')
  return [...block.groups.body.matchAll(/name: '(?<name>[A-Za-z]+)', target: '(?<target>core|artifact|operation)'/gu)]
    .map((entry) => ({ name: entry.groups.name, target: entry.groups.target }))
}

test('RT-TOOLS-1 the model-facing tools are exactly the unified MCP surface list', async () => {
  // Three readings, reconciled: the list the Runtime source declares, the list this harness
  // advertises, and the list the model was actually offered. The contract bundle outranks
  // all three when one is vendored — that reconciliation lives in `mcp-contract.test.mjs`,
  // where the consuming mechanism itself is exercised against fixtures on every run.
  const runtime = vendoredRuntimeSurface()
  assert.deepEqual(runtime, MCP_SURFACE, 'the harness surface drifted from the Runtime')
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const offered = declaredToolsOf(run.modelRequests[0]).map((tool) => tool.name)
  assert.deepEqual([...offered].sort(), [...MODEL_TOOLS].sort(),
    `the model was offered a different surface than the list declares: ${offered.join(', ')}`)
  assert.deepEqual(runtime.map((entry) => entry.name), MODEL_TOOLS)
  assert.deepEqual(runtime.filter((entry) => entry.target === 'artifact').map((entry) => entry.name), ['ReadArtifact'],
    'the artifact read is the one tool served by the data plane rather than by a Board operation')
  // No operation-read tool: an outcome reaches the model on the strip every result carries.
  assert.deepEqual(runtime.filter((entry) => entry.target === 'operation'), [])
  assert.equal(offered.includes('ReadOperation'), false, 'the retired operation read was offered to the model')
  // The retired host split, by name. These were reachable from the first-party client
  // alone, which is exactly why they had to go.
  for (const retired of ['GetCompletion', 'agent_protocol', 'RunDischarge', 'GetBoardManifest', 'PauseCase', 'ResumeCase', 'GetProjection']) {
    assert.equal(offered.includes(retired), false, `${retired} is retired and must never be offered to the model`)
  }
  // The handwritten membership fields are gone with the split: membership is read from the
  // one list, not marked per operation in a second place.
  const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /agentVerb|agentRead/, 'the retired agentVerb/agentRead membership fields survived')
})

test('RT-MCP-1 there is one endpoint, and identity comes from its authenticated handshake', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const mcpPaths = new Set(run.paths.filter((path) => !path.startsWith('/v1/')))
  assert.deepEqual([...mcpPaths], ['/mcp'], `the runtime reached a path other than /mcp: ${[...mcpPaths].join(', ')}`)
  assert.deepEqual(run.methods, ['initialize', 'notifications/initialized', 'tools/list'],
    `ordinary conversation crossed more than the MCP handshake: ${run.methods.join(', ')}`)
  assert.deepEqual(run.verbs, [], 'a greeting called a Board tool')
  assert.match(run.stdout, new RegExp(`Agent "${TEST_AGENT_ID}"`), 'the authenticated identity never reached the terminal')
  assert.equal(run.initializes.length, 1)
})

test('RT-MCP-2 an endpoint that authenticates but returns no identity stops startup rather than guessing', async () => {
  const run = await runAgent({ argv: ['do the work'], omitAgentId: true, model: () => 'Nothing further.' })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.match(run.stderr, /returned no Agent identity/)
  assert.match(run.stderr, /will not decode the bearer secret/)
  assert.equal(run.verbs.length, 0, 'the runtime opened a Case merely to learn who it was')
  const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /legacyAgentIdHint|agentIdFromToken/,
    'decoding the bearer secret is not identity and must not survive as a fallback')
})

test('RT-TOOLS-2 the system prompt carries no wire form and no reply protocol', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  const system = systemTextOf(run.modelRequests[0])
  assert.ok(system.length > 200, 'the system prompt was not recovered from the request')
  for (const forbidden of ['"kind":', '{"op"', 'DONE:', 'STOP:', 'VIEW:', '```']) {
    assert.equal(system.includes(forbidden), false, `the system prompt still teaches ${forbidden}`)
  }
  // What it must say instead: facts, rules, goals and corrections.
  for (const shape of ['assert_fact', 'add_axiom', 'declare_goal', 'retract_node', 'revise_fact']) {
    assert.ok(system.includes(shape), `the prompt does not name the ${shape} shape`)
  }
  assert.doesNotMatch(system, /declare_hypothesis|record_result/)
  assert.match(system, /Never assert acceptance_met, test_result or certification\. Acceptance is the Board's decision\./)
  assert.match(system, /call QueryBoard when you need a current view/,
    'reading the Board is now the model\'s own tool, so the prompt must say so')
  // A 包 V50：声明能力目标即种下能力备好的步骤；推进它们而不是重建；被认证的目标自动完成。
  assert.match(system, /When you declare a capability's goal, the Board plants the steps its capability prepared\./)
  assert.match(system, /do not rebuild prepared steps with ApplyBatch/)
  assert.match(system, /A goal the Board certifies ends as completed by itself; end a goal you will not pursue with EndGoal and a reason\./)
  // D-1004b ①：Source 结果、动作回执与备好的任务已由 Board 记下，不再另写断言。
  assert.match(system, /Source results, Action receipts and a prepared task are already recorded by the Board, so do not assert them again; keeping the original basis needs no assertion./)
  assert.doesNotMatch(system, /follow the capability's task structure/)
  assert.doesNotMatch(system, /OpenCase|CloseCase|\bCases?\b/, 'the v3 Case vocabulary survived in the system prompt')
})

test('RT-TOOLS-3 no model-facing schema exposes a retired or host-owned field', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  const tools = declaredToolsOf(run.modelRequests[0])
  assert.equal(tools.length, 5)
  // Top level only, because that is the scope host metadata lives on. The envelope is the
  // boundary; a property one level down inside a business object is business data, and
  // RT-TOOLS-3c asserts that such a property survives.
  const owned = ['case', 'expectedRevision', 'caseRevision', 'expectedBoardSharedEpoch', 'viewToken', 'requestId',
    'kind', 'queryContext', 'audienceProfile', 'requestedRoots', 'interaction', 'admission']
  for (const tool of tools) {
    // A schema states its shape either as one property map or as composition branches, so the
    // assertion is that the model can reach no host-owned name either way, not that some
    // particular carrier is present.
    const branches = ['oneOf', 'anyOf', 'allOf'].flatMap((key) => (Array.isArray(tool.schema?.[key]) ? tool.schema[key] : []))
    const properties = [...Object.keys(tool.schema?.properties ?? {}),
      ...branches.flatMap((branch) => Object.keys(branch?.properties ?? {}))]
    assert.ok(properties.length > 0, `${tool.name} lost its schema entirely rather than one property`)
    for (const field of owned) {
      assert.equal(properties.includes(field), false, `${tool.name} still shows the host-owned ${field} argument`)
    }
  }
  const names = (node, found = []) => {
    if (Array.isArray(node)) { for (const child of node) names(child, found); return found }
    if (node === null || typeof node !== 'object') return found
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') found.push(...Object.keys(value))
      names(value, found)
    }
    return found
  }
  // The conforming fixture is a valid public schema in the first place: Core's contract
  // says host metadata is never in a tool input schema, so an ordinary run must not depend
  // on the client cleaning one up. The strip is proven separately, on a schema that
  // actually carries them.
  assert.doesNotMatch(JSON.stringify(advertisedTools()), /"viewToken"|"queryContext"|"audienceProfile"|"expectedRevision"|"expectedBoardSharedEpoch"/,
    'the conforming fixture advertises host metadata, so ordinary tests are not running against a valid public schema')
  // And the model surface keeps the fields that are genuinely its own: a goal's outcome and its
  // parent (rulith/v4, A-4), and the goal EndGoal names.
  const batch = tools.find((tool) => tool.name === 'ApplyBatch').schema
  assert.ok(names(batch).includes('desired') && names(batch).includes('parent'),
    'declare_goal must keep desired and parent through the projection')
  const endGoal = tools.find((tool) => tool.name === 'EndGoal').schema
  assert.deepEqual(Object.keys(endGoal.properties ?? {}).sort(), ['disposition', 'goal', 'reason'])
})

test('RT-TOOLS-3b host metadata offered as a tool argument is kept from the model and reported', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['hello'], model: () => 'Hello.',
    toolSchemas: hostFieldTools(),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const batch = declaredToolsOf(run.modelRequests[0]).find((tool) => tool.name === 'ApplyBatch')
  for (const owned of ['case', 'viewToken', 'requestId']) {
    assert.equal(Object.hasOwn(batch.schema.properties, owned), false, `${owned} was shown to the model`)
  }
  assert.match(run.stderr, /ApplyBatch: the advertised schema offered the host-owned argument\(s\)/,
    'a schema this client had to project was projected silently')
})

test('RT-TOOLS-3c a nested business property that shares a name with envelope metadata survives', async () => {
  // The scope defect this closes: host metadata is an *envelope* concept, and a property of
  // a business object that happens to be called `sessionId` or `case` is business data. A
  // client that stripped by name at any depth deleted an argument Core requires, and the
  // model could then not send it.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Record a fact that carries a business session id.'],
    toolSchemas: businessNameCollisionTools(),
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) {
        return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: { sessionId: 'customer-9', requestId: 'ticket-4', amount: 3 } }] })
      }
      return 'Recorded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const batchSchema = declaredToolsOf(run.modelRequests[0]).find((tool) => tool.name === 'ApplyBatch').schema
  const args = batchSchema.properties.operations.items.properties.args
  assert.deepEqual(Object.keys(args.properties).sort(), ['amount', 'requestId', 'sessionId'],
    'a nested business argument was deleted because it shares a name with envelope metadata')
  assert.deepEqual(args.required, ['sessionId'], 'the advertised business requirement was rewritten')
  const sent = run.toolCalls.find((call) => call.name === 'ApplyBatch' && call.args.operations[0].op === 'assert_fact')
  assert.deepEqual(sent.args.operations[0].args, { sessionId: 'customer-9', requestId: 'ticket-4', amount: 3 },
    'the nested business arguments did not reach the authority')
})

test('RT-TOOLS-3d a schema that makes host metadata required is refused, not quietly rewritten', async () => {
  const run = await runAgent({ argv: ['do the work'], toolSchemas: requiredHostFieldTools(), model: () => 'unreachable' })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.notEqual(run.code, 0)
  assert.match(run.stderr, /advertises tool schemas this Runtime cannot satisfy/)
  assert.match(run.stderr, /ApplyBatch makes the host-owned argument\(s\) viewToken required/)
  assert.equal(run.modelRequests.length, 0, 'the model was asked to work against a contract no call could satisfy')
})

test('RT-TOOLS-4 a tool that is not one of the five is refused locally and never forwarded', async () => {
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

// ── Retired wire fails visibly ───────────────────────────────────────────────

for (const [field, value, code] of [
  ['case', { id: 'CASE_1', expectedRevision: 'c3' }, 'retired_wire_field'],
  ['expectedRevision', 'c3', 'retired_wire_field'],
  ['caseRevision', 'c3', 'retired_wire_field'],
  ['expectedBoardSharedEpoch', 4, 'retired_wire_field'],
  ['viewToken', 'stolen-token', 'retired_wire_field'],
  ['kind', 'ApplyBatch', 'host_owned_field'],
  ['queryContext', { audienceProfile: 'internal' }, 'host_owned_field'],
  ['audienceProfile', 'operator', 'host_owned_field'],
  ['requestedRoots', ['ROOT_1'], 'host_owned_field'],
  ['admission', { caseContractDigest: 'chosen-by-the-model' }, 'host_owned_field'],
  ['interaction', { sessionId: 'someone-else', bootstrap: true }, 'host_owned_field'],
  ['requestId', 'chosen-by-the-model', 'host_owned_field'],
]) {
  test(`RT-WIRE-1 a model turn carrying ${field} is refused visibly rather than executed`, async () => {
    const run = await runAgent({
      argv: [],
      env: { RULITH_MAX_ROUNDS: '4' },
      chatLines: ['Record a fact.'],
      model: (round) => {
        if (round === 1) return callTool('ApplyBatch', declareGoal())
        if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }], [field]: value })
        return 'I will reissue it without that field.'
      },
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(run.verbs, ['ApplyBatch'],
      `${field} reached the authority and may have executed under a guessed contract: ${run.verbs.join(', ')}`)
    assert.equal(run.toolCalls.some((call) => Object.hasOwn(call.args, field)), false)
    assert.match(run.stdout, /Refused locally/)
    assert.match(JSON.stringify(run.modelRequests[2]), new RegExp(code))
  })
}

test('RT-WIRE-2 the same step without the retired field is carried (calibration)', async () => {
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Record a fact.'],
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch'])
})

// ── Host metadata: one channel, filled from what the authority returned ──────

test('RT-META-1 the client sends no protected metadata of its own, in the envelope or in the arguments', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case and record a fact.'],
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  // Metadata travels one way. The Gateway injects the protected query context from the
  // authenticated principal, and the session is a transport header — so a conforming client
  // has nothing to put in `_meta` at all. A client that supplied `audienceProfile` would be
  // asking to be read as an operator, and one that supplied a session id would be naming an
  // identity it cannot hold.
  for (const call of run.toolCalls) {
    assert.equal(call.meta, undefined, `${call.name} attached client metadata: ${JSON.stringify(call.meta)}`)
    for (const owned of ['viewToken', 'sessionId', 'requestId', 'queryContext', 'audienceProfile', 'requestedRoots', 'case', 'expectedRevision']) {
      assert.equal(Object.hasOwn(call.args, owned), false, `${call.name} carried ${owned} as a model argument`)
    }
  }
  // The session that did carry both calls is the one the server issued on its own header.
  const sessions = new Set(run.toolCalls.map((call) => call.sessionId))
  assert.equal(sessions.size, 1, `one conversation crossed more than one authenticated session: ${[...sessions].join(', ')}`)
  assert.doesNotMatch(JSON.stringify(run.modelRequests), /mcp-1|rulith\/v1/,
    'host metadata leaked into the model transcript')
})

test('RT-META-1b the client declares the held-call capability it actually implements', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const [handshake] = run.initializes
  assert.equal(handshake.protocolVersion, '2025-11-25', 'the client offered a protocol version it does not implement')
  assert.deepEqual(handshake.capabilities?.experimental?.['rulith/v4'], { heldCalls: 1 },
    'the declaration says this host sends a progress token and waits past the hold bound;'
    + ' a rulith/v2 declaration would be refused before any session opened')
  assert.equal(handshake.presentedSession, undefined, 'a fresh process presented a session identity it does not hold')
})

test('RT-META-2 the identity, revision and focus the host tracks come only from the authority', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Opened.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const focus = run.localEvents.filter((event) => event.type === 'focus').at(-1)
  assert.deepEqual(focus.goals, [{ goal: 'GOAL_1', status: 'running', contact: 'observed' }],
    'focused goals must be the ones the authority returned (focusedGoals), never derived locally')
  const observed = run.localEvents.filter((event) => event.type === 'case-state').at(-1)
  assert.equal(observed.goal, 'GOAL_1')
  assert.equal(observed.status, 'running')
  // Core mints the identity. A host that minted one would have named the goal itself.
  const declared = run.toolCalls.find((call) => call.name === 'ApplyBatch')
  assert.deepEqual(declared.args, declareGoal(), 'the host added to the model\'s declaration')
})

test('RT-META-3 a session whose focus holds several goals is reported as several goals', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Start two pieces of governed work.'],
    model: (round) => (round <= 2 ? callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b')) : 'Both goals are in focus.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'ApplyBatch').length, 2,
    'a second goal in one session was refused by the host, which no longer owns that rule')
  const focus = run.localEvents.filter((event) => event.type === 'focus').at(-1)
  assert.deepEqual(focus.goals.map((row) => row.goal), ['GOAL_1', 'GOAL_2'])
  const rows = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))
  assert.deepEqual(rows.map((row) => [row.goal, row.label]),
    [['GOAL_1', 'Running'], ['GOAL_2', 'Running']])
})

test('RT-META-4 an independent lifecycle per goal: ending one leaves the other running', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    gateway: defaultGateway({ settleAfterBatch: true }),
    chatLines: ['Start two pieces of work and end the first.'],
    model: (round) => {
      if (round <= 2) return callTool('ApplyBatch', declareGoal(round === 1 ? 'task_a' : 'task_b'))
      if (round === 3) return callTool('EndGoal', { goal: 'GOAL_1', disposition: 'abandoned', reason: 'Not needed.' })
      return 'The second goal is still running.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const rows = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))
  const byId = Object.fromEntries(rows.map((row) => [row.goal, row]))
  assert.equal(byId.GOAL_1.label, 'Ended')
  assert.equal(byId.GOAL_1.focused, false)
  assert.equal(byId.GOAL_2.label, 'Running')
  assert.equal(byId.GOAL_2.focused, true, 'ending one goal removed another goal from focus')
  assert.ok(run.localEvents.some((event) => event.type === 'case-closed' && event.goal === 'GOAL_1' && event.disposition === 'abandoned'))
})

test('RT-META-5 a goal the authority reports as unavailable loses the status it used to have', async () => {
  // Neutral by construction: the Board View says a root is unavailable without saying
  // whether it never existed, was deleted, or is not visible. What must not happen is the
  // display keeping "running" because the last answer that mentioned the root said so —
  // that is inventing a status, only more slowly.
  let calls = 0
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Declare a goal, then read the Board.'],
    tool: (name, args, board, session) => {
      calls += 1
      if (calls < 2) return undefined
      return withMeta(
        committed({ goals: { directory: [], total: 0, unavailableGoals: ['GOAL_1'] }, gaps: [], nodes: [], actions: [] }),
        { agentId: TEST_AGENT_ID, focusedGoals: ['GOAL_1'] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('QueryBoard', { include: ['goals'] })
      return 'The goal is no longer available to me.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state' && event.goal === 'GOAL_1')
  assert.equal(observations.at(0).status, 'running')
  assert.equal(observations.at(-1).status, 'unavailable',
    `an unavailable goal kept a status the authority stopped reporting: ${JSON.stringify(observations)}`)
  assert.equal(projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))[0].label, 'Unavailable')
})

test('RT-META-6 a bounded view that dropped rows says so; a complete one does not', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Read the Board twice.'],
    tool: (name, args, board, session, meta) => {
      if (name !== 'QueryBoard') return undefined
      // The carriers Core published: per-limb `goals.truncated` beside `goals.total`, and
      // the top-level `truncated` for the node limbs. An earlier client read an aggregate
      // `loss` object that a Core draft proposed and the published schema does not contain,
      // so against the real authority it saw no truncation at all.
      const core = board.tool(name, args, session, meta)
      return withMeta(committed({ ...core.payload, goals: { ...core.payload.goals, truncated: true }, total: 9, truncated: true }), board.meta(session))
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('QueryBoard', { include: ['goals'] })
      return 'Some rows were omitted.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /QueryBoard returned a bounded view: goals \(1 total\), nodes \(9 total\) was truncated by the authority/)
  assert.match(run.stdout, /anything it does not mention is unreported, not absent/)
  const losses = run.localEvents.filter((event) => event.type === 'loss')
  assert.equal(losses.length, 1, 'silent truncation reads as "covered everything" when it did not')
  assert.deepEqual([losses[0].cmd, losses[0].limbs], ['QueryBoard', ['goals', 'nodes']])
  // Calibration: the declaring ApplyBatch answer carried no loss record and produced no note.
  assert.equal(run.localEvents.filter((event) => event.type === 'loss' && event.cmd === 'ApplyBatch').length, 0)
})

test('RT-META-6b a goal a truncated answer did not reach keeps a labelled observation, not a fresh one', async () => {
  // The subtle half of truncation. The bounded answer simply did not reach this root, so its
  // previous status is all anyone has — but passing that status back through as a new
  // observation republishes stale state as if the authority had just confirmed it. It is
  // retained and labelled instead, and `unavailable` stays a different statement: that one
  // the authority made on purpose.
  let calls = 0
  const run = await runAgent({
    argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Declare a goal, then read a bounded view.'],
    tool: (name, args, board, session, meta) => {
      calls += 1
      if (calls < 2) return undefined
      return withMeta(
        // Truncated, and mentioning no goals at all: GOAL_1 is unreported, not absent.
        committed({ goals: { directory: [], total: 4, truncated: true }, gaps: [], nodes: [], total: 0, truncated: false }),
        { agentId: TEST_AGENT_ID, focusedGoals: ['GOAL_1'] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('QueryBoard', { include: ['goals'] })
      return 'The view was bounded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state' && event.goal === 'GOAL_1')
  assert.equal(observations.at(0).status, 'running')
  assert.equal(observations.at(0).contact, undefined, 'a refreshed observation carries no contact qualifier')
  const last = observations.at(-1)
  assert.equal(last.status, 'running', 'a truncated answer is not evidence the goal changed')
  assert.equal(last.contact, 'not-refreshed',
    `a status the bounded answer never mentioned was republished as freshly observed: ${JSON.stringify(observations)}`)
  // Truncation is not unavailability: one says "I did not reach it", the other says
  // "I looked and it is not there for you".
  assert.notEqual(last.status, 'unavailable')
  const row = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))[0]
  assert.equal(row.label, 'Running')
  assert.equal(row.observation, 'Not refreshed by the last bounded answer')
  // And a per-view gap count is not attached to a goal this answer did not describe.
  assert.equal(Object.hasOwn(last, 'gaps'), false)
})

test('RT-META-7 an empty affectedGoals is reported, because it is a statement', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Record a blind addition, then act.'],
    tool: (name, args, board, session, meta) => {
      const core = board.tool(name, args, session, meta)
      if (name === 'ApplyBatch') return withMeta(core, { ...board.meta(session), affectedGoals: [] })
      if (name === 'ApplyAction') return withMeta(core, { ...board.meta(session), affectedGoals: ['GOAL_1'] })
      return undefined
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('ApplyAction', { action: 'acme.ship' })
      return 'Done.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const affected = run.localEvents.filter((event) => event.type === 'affected')
  assert.deepEqual(affected.map((event) => [event.cmd, event.affectedGoals]),
    [['ApplyBatch', []], ['ApplyBatch', []], ['ApplyAction', ['GOAL_1']]],
    '"no top-level goal advanced" and "the authority did not say" must not read the same')
})

// ── ReadArtifact: bounded data, and nothing else ─────────────────────────────

test('RT-ART-1 an artifact is read in bounded fragments and touches no Board state', async () => {
  const text = 'line-one\nline-two\nline-three'
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '6' }, captureLocalEvents: true,
    chatLines: ['Read the result the Action produced.'],
    gateway: defaultGateway({ artifacts: { 'art-1': { mediaType: 'text/plain', text } } }),
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ReadArtifact', { ref: 'art-1', maxBytes: 8 })
      if (round === 3) return callTool('ReadArtifact', { ref: 'art-1', offset: 8, maxBytes: 64 })
      return 'I have the whole result.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ReadArtifact', 'ReadArtifact'],
    `the host added a Board call around a data read: ${run.verbs.join(', ')}`)
  const reads = run.toolCalls.filter((call) => call.name === 'ReadArtifact')
  assert.deepEqual(reads.map((call) => call.args), [
    { ref: 'art-1', maxBytes: 8 },
    { ref: 'art-1', offset: 8, maxBytes: 64 },
  ], 'the reference and continuation position must travel exactly as the service issued them')

  // The fragments say what they are. A partial read presented as the whole file, or an
  // unreadable one presented as empty, is the defect this shape exists to prevent.
  // The last request carries the whole conversation, so it holds both fragments once.
  const results = run.modelRequests.at(-1).messages.filter((message) => message.role === 'tool')
  const fragments = results.map((message) => JSON.parse(message.content).result).filter((value) => value?.ref === 'art-1')
  assert.equal(fragments.length, 2)
  assert.deepEqual(fragments.map((fragment) => [fragment.complete, fragment.truncated, fragment.nextOffset]),
    [[false, true, 8], [true, false, null]])
  assert.equal(fragments.map((fragment) => fragment.data).join(''), text, 'the fragments did not reconstruct the object')
  assert.equal(fragments[0].totalBytes, Buffer.byteLength(text))

  // A data read decides nothing on the Board: no verdict, no focus change, no view.
  assert.equal(run.localEvents.some((event) => event.type === 'verdict' && event.cmd === 'ReadArtifact'), false,
    'a data read was reported as a Board verdict')
  const artifactEvents = run.localEvents.filter((event) => event.type === 'artifact-read')
  assert.deepEqual(artifactEvents.map((event) => [event.ref, event.complete, event.truncated]),
    [['art-1', false, true], ['art-1', true, false]])
  const focus = run.localEvents.filter((event) => event.type === 'focus').at(-1)
  assert.deepEqual(focus.goals.map((row) => row.goal), ['GOAL_1'], 'the artifact read changed the focused goals')
  assert.match(run.stdout, /Data: ReadArtifact returned a fragment of 28 byte\(s\), truncated at the read limit/)
})

test('RT-ART-2 a reference this Agent cannot read is refused, not answered with empty data', async () => {
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Read that other object.'],
    gateway: defaultGateway({ artifacts: { 'art-1': { text: 'mine' } } }),
    model: (round) => (round === 1
      ? callTool('ReadArtifact', { ref: 'art-someone-else' })
      : 'That object is not readable by this Agent.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const feedback = JSON.stringify(run.modelRequests[1])
  assert.match(feedback, /artifact_unavailable/)
  assert.doesNotMatch(feedback, /"data":""/, 'an unreadable object was presented as an empty one')
  assert.match(run.stdout, /Data read refused for ReadArtifact/)
  assert.doesNotMatch(run.stdout, /Board rejected ReadArtifact/,
    'a data-plane refusal is not a Board decision and must not be reported as one')
})

// ── Authoritative refusals: handed back, never replayed ──────────────────────

test('RT-REFUSE-1 an authoritative refusal reaches the model with its Board View and is never replayed', async () => {
  let served = 0
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '4' },
    captureLocalEvents: true,
    tool: (name, args) => {
      if (name !== 'ApplyBatch' || args.operations?.[0]?.op !== 'assert_fact') return undefined
      served += 1
      if (served > 1) return undefined
      return withMeta(
        { accepted: false, errorCode: 'precondition_not_met',
          teaching: 'The premises this step depends on are not in force. Read the current view and decide again.',
          payload: { goals: { directory: [{ goal: 'GOAL_1', label: 'GOAL_1', status: 'running' }], total: 1 }, gaps: ['acceptance'], nodes: [], actions: [] } },
        { agentId: TEST_AGENT_ID, boardRevision: 'r9', focusedGoals: ['GOAL_1'] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'I will re-read the Board and decide again.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.toolCalls.filter((call) => call.name === 'ApplyBatch' && call.args.operations[0].op === 'assert_fact').length, 1,
    `the host resent the refused step on the model's behalf: ${run.verbs.join(', ')}`)
  const third = JSON.stringify(run.modelRequests[2])
  assert.match(third, /precondition_not_met/, 'the refusal must reach the model as the tool result of its own step')
  assert.match(third, /\\"gaps\\":\[\\"acceptance\\"\]/, 'the view the refusal carried must travel with it')
  assert.doesNotMatch(third, /boardRevision|r9/, 'the audit revision is host metadata and is not model content')
  assert.match(run.stdout, /Board rejected ApplyBatch: The premises/)
})

test('RT-REFUSE-2 the model\'s next choice after a refusal is a new logical request', async () => {
  let served = 0
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    tool: (name, args) => {
      if (name !== 'ApplyBatch' || args.operations?.[0]?.op !== 'assert_fact') return undefined
      served += 1
      if (served > 1) return undefined
      return { accepted: false, errorCode: 'precondition_not_met', teaching: 'not in force', payload: { goals: { directory: [], total: 0 }, gaps: [], nodes: [], actions: [] } }
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'a', args: {} }] })
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F2', predicate: 'b', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const batches = run.toolCalls.filter((call) => call.name === 'ApplyBatch' && call.args.operations[0].op === 'assert_fact')
  assert.equal(batches.length, 2)
  assert.deepEqual(batches.map((call) => call.args.operations[0].id), ['F1', 'F2'],
    'the refused step was resent instead of the model deciding again')
  assert.notEqual(batches[0].id, batches[1].id, 'a new choice is a new logical request')
})

test('RT-WRITE-1 the host inserts no read of its own around a write', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '5' },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch'],
    `the host inserted a read of its own around the write: ${run.verbs.join(', ')}`)
})

test('RT-WRITE-2 a first write is carried as it stands and judged by the authority', async () => {
  // There is no bootstrap exception and no view to obtain first: the write goes as the
  // model wrote it, and the authority judges it against the state in force. What comes back
  // is the authority's refusal, in the model's own tool result.
  const run = await runAgent({
    argv: ['do the work'],
    env: { RULITH_MAX_ROUNDS: '4' },
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'The Board refused it, so I will declare a goal first.'),
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const batch = run.toolCalls.find((call) => call.name === 'ApplyBatch')
  assert.ok(batch, 'the step was never forwarded, so the authority never got to refuse it')
  assert.equal(batch.meta, undefined)
  assert.match(JSON.stringify(run.modelRequests[1]), /no_acceptance_root/)
})

// ── Sessions: per conversation, server-issued, never restored from disk ──────

test('RT-SESSION-1 a restarted Runtime takes over as a new client rather than restoring a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rulith-session-restore-'))
  const store = join(dir, 'agent-sessions.json')
  // The store is keyed on the endpoint, so both runs must address the same one.
  const listenPort = await freePort()
  try {
    const first = await runAgent({
      argv: ['do the work'], sessionFile: store, listenPort, env: { RULITH_MAX_ROUNDS: '3' },
      model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Opened.'),
    })
    assert.notEqual(first.code, 'timeout', `${first.stdout}\n${first.stderr}`)
    // A run that resolved everything writes nothing at all: the store exists to remember
    // an unknown, and there was none.
    if (existsSync(store)) {
      const text = readFileSync(store, 'utf8')
      const record = JSON.parse(text)
      const endpoint = Object.values(record.endpoints)[0] ?? {}
      assert.equal(record.schema, 'rulith-agent-sessions/1')
      assert.doesNotMatch(text, /rlt_agt_/, 'the Agent token must never be written to the store')
      // What the store may hold is the one call whose outcome is unknown, and nothing else.
      // A view or a focus set written here would be a client able to present an observation
      // it does not hold, and a *reusable* session id would be a client able to present an
      // identity it no longer has.
      assert.deepEqual(Object.keys(endpoint).filter((key) => key !== 'unresolved'), [],
        `the durable store kept transport or view state: ${JSON.stringify(endpoint)}`)
      assert.doesNotMatch(text, /viewToken|boardRevision|focusedRoots|focusedGoals/)
    }

    const second = await runAgent({
      argv: [], sessionFile: store, listenPort, chatLines: ['hello again'], model: () => 'Hello again.',
    })
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`)
    assert.equal(second.initializes.length, 1)
    assert.equal(second.initializes[0].presentedSession, undefined,
      'the restarted process presented a session identity from disk; a new process is a new client and takes over as one')
    assert.equal(second.initializes[0].meta?.sessionId, undefined,
      'the session must not travel in the body either — the response header is its only carrier')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RT-SESSION-3 every local conversation speaks over the one authenticated connection', async () => {
  // Two conversations are two transcripts, not two clients. The retired shape gave each
  // slot its own `initialize`, which did not isolate them — it made the second one *take
  // the Agent over*, so the first one's next call came back `connection_replaced` and the
  // whole process stopped. One Agent has one effective client; conversations queue behind it.
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'one-connection' },
    serveTasks: [
      { text: 'Open a governed Case.', sessionKey: 'client-a' },
      { text: 'Open another governed Case.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 || round === 3 ? callTool('ApplyBatch', declareGoal()) : 'Opened.'),
    timeoutMs: 12_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const opens = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
  assert.equal(opens.length, 2)
  assert.equal(run.initializes.length, 1,
    `the Agent authenticated ${run.initializes.length} times; a second connection would have taken the first one over`)
  const sessions = new Set(run.toolCalls.map((call) => call.sessionId))
  assert.equal(sessions.size, 1, `conversations were carried on ${sessions.size} sessions: ${[...sessions].join(', ')}`)
  assert.doesNotMatch(run.stdout, /connection was replaced/, 'the process replaced itself')
  assert.doesNotMatch(run.stderr, /connection was replaced/)
})

test('RT-SESSION-3b conversations are served one segment at a time, never woven together', async () => {
  // Serial is Agent-wide. Two segments running at once would put two model turns behind one
  // connection and one Board, which is the concurrency the product does not offer — and the
  // observable is simple: a segment starts only after the previous one has finished.
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'], captureLocalEvents: true,
    env: {
      RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'one-at-a-time',
      RULITH_MAX_ROUNDS: '4',
    },
    serveTasks: [
      { text: 'Open and write for client A.', sessionKey: 'client-a' },
      { text: 'Open and write for client B.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (_round, body) => {
      const transcript = JSON.stringify(body)
      const steps = (transcript.match(/tool_call_id|tool_use_id/g) ?? []).length
      if (steps === 0) return callTool('ApplyBatch', declareGoal())
      if (steps === 1) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const batches = run.toolCalls.filter((call) => call.name === 'ApplyBatch' && call.args.operations[0].op === 'assert_fact')
  assert.equal(batches.length, 2, `both conversations must have been served: ${run.verbs.join(', ')}`)
  // The segment boundary, from the host's own events: no second start before the first end.
  const flow = run.localEvents.filter((event) => event.type === 'task-start' || event.type === 'task-done')
  let running = 0
  for (const event of flow) {
    if (event.type === 'task-start') running += 1
    else running -= 1
    assert.ok(running <= 1, `two segments ran at once: ${flow.map((entry) => entry.type).join(' → ')}`)
  }
  assert.equal(new Set(run.toolCalls.map((call) => call.sessionId)).size, 1,
    'the two conversations were carried on more than one authenticated session')
})

test('RT-SESSION-4 results delivered as an SSE stream are read like any other', async () => {
  const run = await runAgent({
    argv: [], sseResults: true, chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Opened.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), true,
    'a Streamable HTTP server that answers with text/event-stream must not be unreachable')
  assert.match(run.stdout, /Goal in focus/)
})

// ── The scenario the surface exists for ──────────────────────────────────────

test('declare, act, read and write: the goal completes in the commit the Board certifies, with no closing call', async () => {
  const run = await runAgent({
    // The autopilot policy, because this is the scenario in which a dispatched Action
    // settles on the Board's own schedule rather than the host's.
    argv: ['investigate this and finish when the Board certifies it'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ certifyAfterBatch: true }),
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyAction', { action: 'compute_total', target: 'GOAL_1' })
      if (round === 3) return callTool('QueryBoard', { include: ['goals'] })
      if (round === 4) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }] })
      return 'unreachable: the Board completed the goal'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyAction', 'QueryBoard', 'ApplyBatch'])
  // The dispatched Action was reported as pending with its invocation, not as done.
  assert.match(JSON.stringify(run.modelRequests[2]), /inv_1/)
  // Before the certifying commit, the directory said running; nothing asked to finish it.
  assert.match(JSON.stringify(run.modelRequests[3]), /\\"status\\":\\"running\\"/)
  assert.equal(run.verbs.includes('EndGoal'), false)
  assert.equal(run.modelRequests.length, 4, 'the run went on after the Board completed the goal')
  assert.match(run.stdout, /Goal "GOAL_1" completed: the Board certified it/)
  assert.match(run.stdout, /The Board certified the goal and it is completed\./)
})

test('the Board decides completion: an uncertified goal stays open, and the host ends nothing', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith, but finish only if the Board certifies it.'],
    gateway: defaultGateway({ settleAfterBatch: false, certifyAfterBatch: true }),
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'The Board has not certified it, so the goal remains open.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch'])
  assert.doesNotMatch(run.stdout, /completed: the Board certified it|ended as/)
  assert.match(run.stdout, /Response delivered; Rulith goal\(s\) "GOAL_1" remain in focus\./)
})

test('a greeting is answered normally with no Case and no Board call', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Good morning.'],
    model: () => 'Good morning. What would you like to work on?',
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'a plain conversational reply must return control to the user')
  assert.deepEqual(run.verbs, [], `a greeting unexpectedly touched the Board: ${run.verbs.join(', ')}`)
  assert.match(run.stdout, /What would you like to work on\?/)
  assert.doesNotMatch(run.stdout, /Goal in focus|pending_goal|Case Context in focus|pending_case_id/)
})

test('a focused goal persists across messages and is never advanced implicitly', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start a governed investigation.', 'Before the next step, explain what you know.'],
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return 'The goal is declared. I will wait for your next instruction.'
      return 'The same goal is still in focus; I took no further step.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch'], 'the host advanced or re-read the Board during an ordinary conversational turn')
  const followUp = run.modelRequests[2].messages.at(-1).content
  assert.match(followUp, /Goals in focus: GOAL_1 \(running\)/,
    'the next conversational turn must receive the focus the authority reported')
  assert.doesNotMatch(followUp, /\bCases?\b|root /, 'the v3 Case vocabulary reached the model')
  const notice = 'The Board may have changed since your last tool result; QueryBoard reads its current position.'
  assert.equal(followUp.split(notice).length - 1, 1,
    'a follow-up user entry must carry exactly one current-position notice')
  assert.doesNotMatch(followUp, /"directory"|Board View last observed/,
    'the follow-up user entry must not repeat a previous Board View')
})

test('only a transcript that holds a tool result is told the Board may have changed, and no view is repeated', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Hello.', 'Open a Case and look at it.', 'Thanks, that is all.'],
    model: (round) => {
      if (round === 1) return 'Hello! What would you like to work on?'
      if (round === 2) return callTool('ApplyBatch', declareGoal())
      if (round === 3) return callTool('QueryBoard', {})
      if (round === 4) return 'The Case is open and I have looked at it.'
      return 'You are welcome.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const entries = run.modelRequests.at(-1).messages
    .map((entry) => entry.content)
    .filter((content) => typeof content === 'string' && /^(User message|Task): /u.test(content))
  assert.equal(entries.length, 3, 'each chat line enters the transcript once')
  const notice = 'The Board may have changed since your last tool result; QueryBoard reads its current position.'
  const count = (entry) => entry.split(notice).length - 1
  // 前两条进入记录时还没有任何工具结果：模型上下文里没有旧局面，就不必提醒。
  assert.deepEqual(entries.map(count), [0, 0, 1],
    'the notice belongs only to entries after this transcript holds a tool result, exactly once')
  for (const entry of entries)
    assert.doesNotMatch(entry, /"directory"|"position"|Board View last observed/,
      'a user entry must never repeat a previous Board View')
})

test('an unscoped write is carried and refused by the authority, not guessed at by the host', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record a fact.'],
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'I will declare a goal first.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), true,
    'the host refused on the authority\'s behalf; focus lives in the authenticated session, which only the authority can read')
  // `case_context_required` is retired by name (Core 1.2). Under one shared graph a write
  // is not scoped by focus, and it presents no view: the authority judges it against the
  // state in force, and says plainly what was missing.
  assert.match(JSON.stringify(run.modelRequests[1]), /no_acceptance_root/)
  assert.doesNotMatch(JSON.stringify(run.modelRequests[1]), /case_context_required/)
})

test('RT-SERIAL-1 several calls in one turn are executed one after another, in order', async () => {
  // Serial means one at a time, each finishing before the next is sent. It does not mean
  // "carry the first and drop the rest": dropping them looked serial on the wire and quietly
  // declined work the model had proposed, leaving the model to discover the loss by
  // re-reading the Board. Both calls go, in the order chosen, and the second is judged by
  // the authority against the closure the first produced.
  const arrivals = []
  const run = await runAgent({
    argv: [],
    chatLines: ['Do both steps.'],
    tool: (name, args, board, session) => {
      arrivals.push({ name, focus: session.focus.size })
      return undefined
    },
    model: (round) => (round === 1
      ? {
          text: '',
          toolCalls: [
            { name: 'ApplyBatch', input: declareGoal() },
            { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
          ],
        }
      : 'Both steps are recorded.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch', 'ApplyBatch'],
    `both calls of the turn must be carried, in order: ${run.verbs.join(', ')}`)
  // The proof that they were serial rather than concurrent: the write arrived at a Board
  // that already held the goal the first call declared.
  assert.deepEqual(arrivals, [{ name: 'ApplyBatch', focus: 0 }, { name: 'ApplyBatch', focus: 1 }],
    'the second call did not observe the first call\'s effect, so they were not serialised')
  const results = JSON.stringify(run.modelRequests[1])
  assert.doesNotMatch(results, /one_step_per_turn|call_queue_suspended/,
    'a call was declined by the host although nothing was unresolved')
  // Every tool_use must be answered, or the next Anthropic request is malformed.
  assert.equal(run.modelRequests[1].messages.filter((message) => message.role === 'tool').length, 2)
})

test('RT-SERIAL-2 a call the authority is still holding suspends the rest of the turn', async () => {
  // The queue stops at the first answer the model has to read before anything else makes
  // sense. What must not happen is the second call going out anyway: it was chosen before the
  // model knew that the first one waits for a person.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3' },
    chatLines: ['Do all three steps.'], captureLocalEvents: true,
    hold: (name, args) => (name === 'ApplyBatch' && args.operations?.[0]?.op === 'declare_goal' ? { answer: 'needs_person' } : undefined),
    model: (round) => (round === 1 ? {
      text: '',
      toolCalls: [
        { name: 'ApplyBatch', input: declareGoal() },
        { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
        { name: 'QueryBoard', input: {} },
      ],
    } : 'A person has to reconcile it first.'),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['ApplyBatch'],
    `calls chosen before the model saw the first answer were sent: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 2, 'the model was not given the held answer and the unsent calls')
  const suspension = run.localEvents.find((event) => event.type === 'queue-suspended')
  assert.equal(suspension?.notSent, 2, 'the two unsent calls were not reported as unsent')
  assert.match(run.stdout, /were not sent/)
  assert.match(run.stdout, /ApplyBatch is waiting for a person to reconcile it in Console/)
})

test('a goal declaration is carried exactly as the model wrote it: the host pins no contract on it', async () => {
  // rulith/v4: a capability's goal is chosen by the goal the model declares (A-5). The host used
  // to write the operator's Case Type into OpenCase; it has nothing left to write, and it must
  // not edit the declaration either.
  const declaration = { operations: [{ op: 'declare_goal', label: 'Calculation calc-001',
    desired: [{ predicate: 'rulith.verified_calculation.calculation_completed', args: { job_id: 'calc-001' } }] }] }
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith for this governed calculation.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declaration) : 'Declared.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.toolCalls.map((call) => call.args), [declaration])
})

for (const retired of ['OpenCase', 'CloseCase']) {
  test(`a model that still calls ${retired} is refused locally, and nothing reaches the authority`, async () => {
    // rulith/v4 took OpenCase and CloseCase off the model surface with no alias (V1, V2). A model
    // formed against the old surface is told which five tools exist; its call is never carried.
    const run = await runAgent({
      argv: [],
      chatLines: ['Open a Case.'],
      model: (round) => (round === 1 ? callTool(retired, retired === 'OpenCase' ? { caseType: 'exploration' }
        : { root: 'ROOT_1', disposition: 'completed' }) : 'I will declare a goal instead.'),
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.deepEqual(run.verbs, [], `${retired} reached the authority`)
    const answered = JSON.stringify(run.modelRequests[1])
    assert.match(answered, /tool_not_carried/)
    assert.match(answered, /This Agent may call: QueryBoard, ApplyBatch, ApplyAction, ReadArtifact, EndGoal\./)
  })
}

test('RT-GUESS-1 no prompt line is driven by a field the authority never published', async () => {
  // There used to be a second conditional line here, telling the model that Board
  // legislation was locked, keyed on a `lawLocked` field in the Board View. Core's published
  // Board View has no such field, so against the real authority the condition was
  // permanently false and the line was a guess wearing the shape of a rule. Whether
  // `add_axiom` is permitted is the Board's judgement and the Board refuses it plainly.
  //
  // The arm asserts the *absence* on both sides: a server that sends the invented field must
  // not resurrect the line, and no line may be driven by anything this host itself sent.
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith under the installed governance.'],
    tool: (name, args, board, session, meta) => {
      if (name !== 'ApplyBatch') return undefined
      const core = board.tool(name, args, session, meta)
      return withMeta({ ...core, payload: { ...core.payload, lawLocked: true } }, board.meta(session))
    },
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'The goal is declared.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const beforeOpen = systemTextOf(run.modelRequests[0])
  const afterOpen = systemTextOf(run.modelRequests[1])
  assert.doesNotMatch(beforeOpen, /permitted inside this Case/,
    'the unscoped first turn exposed a provisional-law permission before any Case existed')
  assert.doesNotMatch(`${beforeOpen}\n${afterOpen}`, /Legislation is locked/,
    'an unpublished Board View field is driving a prompt line again')
  // A known goal type still does not let the host decide the current writing permission (V47).
  assert.match(afterOpen, /A goal type alone grants no rule-writing permission/)
  assert.doesNotMatch(afterOpen, /are permitted inside this Case|are Case-local/)
  assert.deepEqual(run.verbs, ['ApplyBatch'], 'the Board was probed for governance state')
  const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ctx\.lawLocked|LOCKED_LINE/, 'the guessed lock state survived in the runtime')
})

test('RT-GUESS-2 an accepted Action reports the invocation gap instead of a false idle', async () => {
  // `receipt.invocation`, `payload.done` and `payload.ok` are not in Core's published result
  // envelope or Board View — receipts are an operator/internal include — so reading them
  // printed the same word for every dispatched Action and left the Worker panel looking idle.
  // A stated gap is worth more than a confident blank: nobody investigates a blank.
  const run = await runAgent({
    argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Dispatch the action twice.'],
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyAction', { action: 'acme.ship', target: 'L1' })
      if (round === 3) return callTool('ApplyAction', { action: 'acme.ship', target: 'L2' })
      return 'Dispatched.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const gaps = run.localEvents.filter((event) => event.type === 'worker-activity-unavailable')
  assert.equal(gaps.length, 1, 'the gap must be stated, once per conversation rather than per Action')
  assert.match(gaps[0].note, /no published field carrying it/)
  assert.match(run.stdout, /An Action was dispatched\. This Runtime cannot yet report its invocation identity/)
  // And no verdict claims a completion state the authority did not report.
  const verdicts = run.localEvents.filter((event) => event.type === 'verdict' && event.accepted === true)
  assert.ok(verdicts.length >= 2)
  assert.ok(verdicts.every((event) => !Object.hasOwn(event, 'done') && !Object.hasOwn(event, 'ok') && !Object.hasOwn(event, 'invocation')),
    `a verdict carried a guessed completion field: ${JSON.stringify(verdicts)}`)
  assert.doesNotMatch(run.stdout, /completed with failure|ApplyAction completed/)
})

test('a bounded public Action result reports its own terminal state without inventing an invocation', async () => {
  const shapes = [
    { status: 'confirmed', ok: true },
    { status: 'failed', ok: false },
    { status: 'refused', ok: false },
    { status: 'unknown' },
  ]
  for (const shape of shapes) {
    const run = await runAgent({
      argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '4' },
      chatLines: ['Try the declared Action.'],
      tool: (name, args, board, session, meta) => {
        if (name !== 'ApplyAction') return undefined
        const core = board.tool(name, args, session, meta)
        return withMeta({ ...core, result: { action: args.action, done: true, ...shape } }, board.meta(session))
      },
      model: (round) => round === 1 ? callTool('ApplyBatch', declareGoal())
        : round === 2 ? callTool('ApplyAction', { action: 'acme.ship', target: 'L1' }) : 'Result noted.',
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    const outcomes = run.localEvents.filter(event => event.type === 'action-outcome')
    assert.equal(outcomes.length, 1, `${shape.status}: no public terminal event`)
    assert.equal(outcomes[0].action, 'acme.ship')
    assert.equal(outcomes[0].status, shape.status)
    assert.equal(outcomes[0].ok, shape.ok)
    assert.equal(Object.hasOwn(outcomes[0], 'invocation'), false)
    assert.equal(run.localEvents.some(event => event.type === 'worker-activity-unavailable'), false)
  }
  const mismatched = await runAgent({
    argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Try the declared Action.'],
    tool: (name, args, board, session, meta) => name !== 'ApplyAction' ? undefined
      : withMeta({ ...board.tool(name, args, session, meta),
        result: { action: 'another.action', done: true, status: 'confirmed', ok: true } }, board.meta(session)),
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : round === 2 ? callTool('ApplyAction', { action: 'acme.ship', target: 'L1' }) : 'Result noted.',
  })
  assert.equal(mismatched.code, 0, `${mismatched.stdout}\n${mismatched.stderr}`)
  assert.equal(mismatched.localEvents.some(event => event.type === 'action-outcome'), false)
  assert.equal(mismatched.localEvents.filter(event => event.type === 'worker-activity-unavailable').length, 1)
})

test('a contradictory Action envelope is not taken as the outcome', async () => {
  for (const contradiction of ['ambiguous-code', 'mcp-error']) {
    const run = await runAgent({
      argv: [], captureLocalEvents: true,
      env: { RULITH_MAX_ROUNDS: '4' },
      chatLines: ['Try the declared Action.'],
      tool: (name, args, board, session, meta) => {
        if (name !== 'ApplyAction') return undefined
        const result = { ...board.tool(name, args, session, meta),
          result: { action: args.action, done: true, ok: true, status: 'confirmed' },
          ...(contradiction === 'ambiguous-code' ? { errorCode: 'upstream_unavailable' } : {}) }
        return { ...withMeta(result, board.meta(session)),
          ...(contradiction === 'mcp-error' ? { __isError: true } : {}) }
      },
      model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
        : round === 2 ? callTool('ApplyAction', { action: 'acme.ship', target: 'L1' }) : 'Result noted.',
      timeoutMs: 8_000,
    })
    assert.notEqual(run.code, 'timeout', `${contradiction}: ${run.stdout}\n${run.stderr}`)
    assert.equal(run.localEvents.some(event => event.type === 'action-outcome'), false,
      `${contradiction}: a contradictory envelope was shown as confirmed`)
    assert.equal(run.localEvents.some(event => event.type === 'verdict'
      && event.cmd === 'ApplyAction' && event.accepted === true), false,
    `${contradiction}: the contradictory reply was shown as accepted by Board`)
  }
})

test('a normal MCP envelope can carry an authoritative business refusal', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '4' },
    chatLines: ['Try the declared Action.'],
    tool: (name, args, board, session, meta) => name !== 'ApplyAction' ? undefined
      : withMeta({ accepted: false, errorCode: 'not_authorized', teaching: 'Action refused by policy.' },
        board.meta(session)),
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : round === 2 ? callTool('ApplyAction', { action: 'acme.ship', target: 'L1' }) : 'The action was refused.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.localEvents.some(event => event.type === 'verdict' && event.cmd === 'ApplyAction'
    && event.accepted === false && event.transportFailed !== true), true)
  assert.equal(run.localEvents.some(event => event.type === 'action-outcome'), false)
})

test('declaring an exploration goal does not invent a permission grant or Case-local lifetime', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Explore this.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Exploring.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(systemTextOf(run.modelRequests[0]), /permitted inside this Case/)
  assert.equal(systemTextOf(run.modelRequests[1]), systemTextOf(run.modelRequests[0]))
  assert.doesNotMatch(systemTextOf(run.modelRequests[1]), /are permitted inside this Case|disappear when the Case closes/)
})

// ── Transport ────────────────────────────────────────────────────────────────

test('the Anthropic wire carries tool definitions, tool_use blocks, and tool_result replies', async () => {
  const run = await runAgent({
    argv: [],
    provider: 'anthropic',
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Opened.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const first = run.modelRequests[0]
  assert.ok(Array.isArray(first.tools) && first.tools.every((tool) => tool.input_schema !== undefined),
    `Anthropic tools must carry input_schema: ${JSON.stringify(first.tools)}`)
  assert.equal(typeof first.system, 'string', 'Anthropic carries the system prompt as a top-level field')
  const second = run.modelRequests[1]
  const assistant = second.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant.content.some((block) => block.type === 'tool_use' && block.name === 'ApplyBatch'),
    `the assistant turn was not replayed as a tool_use block: ${JSON.stringify(assistant)}`)
  const results = second.messages.filter((message) => message.role === 'user')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
  assert.equal(results.length, 1, 'the tool result was not replayed as a tool_result block')
  assert.equal(results[0].tool_use_id, assistant.content.find((block) => block.type === 'tool_use').id)
  assert.equal(run.verbs.includes('ApplyBatch'), true)
})

test('the OpenAI wire carries function tools, tool_calls, and role tool replies', async () => {
  const run = await runAgent({
    argv: [],
    provider: 'openai',
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal(), { id: 'call_abc' }) : 'Declared.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const first = run.modelRequests[0]
  assert.ok(Array.isArray(first.tools) && first.tools.every((tool) => tool.type === 'function' && tool.function.parameters !== undefined),
    `OpenAI tools must be function definitions with parameters: ${JSON.stringify(first.tools)}`)
  const query = first.tools.find(tool => tool.function.name === 'QueryBoard').function.parameters
  assert.equal(query.properties.selector.properties.goals.type, 'array')
  assert.equal(query.properties.selector.properties.goals.items.type, 'string')
  assert.equal(query.properties.selector.properties.goals.minItems, 1)
  assert.equal(query.properties.selector.properties.goals.maxItems, 1000)
  assert.equal(query.properties.selector.properties.goals.items.minLength, 1)
  assert.deepEqual(query.properties.include.items.enum, ['goals', 'nodes', 'gaps', 'taskStatus', 'history'])
  const batch = first.tools.find(tool => tool.function.name === 'ApplyBatch').function.parameters
  assert.equal(batch.properties.operations.items.type, 'object')
  assert.ok(batch.properties.operations.items.properties.op.enum.includes('assert_fact'))
  assert.ok(batch.properties.operations.items.properties.op.enum.includes('declare_goal'))
  // Object-only model interfaces need the top-level field catalogue of every batch operation,
  // a goal's parent included (A-4), while the alternatives keep their exact constraints.
  assert.ok(Object.hasOwn(batch.properties.operations.items.properties, 'parent'))
  const ending = first.tools.find(tool => tool.function.name === 'EndGoal').function.parameters
  assert.deepEqual(ending.properties.disposition.enum, ['cancelled', 'failed', 'abandoned', 'superseded'])
  const validator = new Ajv({ strict: false })
  const samples = {
    EndGoal: [{ goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' }, { goal: 'GOAL_1', disposition: 'completed', reason: 'Done.' },
      { goal: 'GOAL_1', disposition: 'cancelled' }, {}],
    QueryBoard: [{}, { include: ['nodes'], selector: { goals: ['goal-1'] } }, { include: ['nodes'] }, { include: ['nodes'], selector: { goals: [] } },
      { include: ['nodes'], selector: { goals: [{}] } }, { include: ['history'], selector: { goals: ['goal-1'] } }, { include: ['cases'] },
      { include: ['nodes'], selector: { roots: ['root-1'] } }],
    ApplyBatch: [{ operations: [{ op: 'assert_fact', predicate: 'x', args: { n: 1 } }] }, { operations: [{}] }, { operations: [{ op: 'unknown' }] },
      { operations: [{ op: 'declare_goal', desired: [{ predicate: 'task_done', args: {} }] }] },
      { operations: [{ op: 'declare_goal', desired: [{ predicate: 'step_done', args: {} }], parent: 'GOAL_1' }] },
      { operations: [{ op: 'declare_goal', desired: [] }] }, { operations: [{ op: 'sign_off', goal: 'GOAL_1' }] }],
  }
  for (const [name, values] of Object.entries(samples)) {
    const original = validator.compile(advertisedTools().find(tool => tool.name === name).inputSchema)
    const adapted = validator.compile(first.tools.find(tool => tool.function.name === name).function.parameters)
    for (const value of values) assert.equal(adapted(value), original(value), `${name} changed accepted inputs: ${JSON.stringify(value)}`)
  }
  assert.equal(first.messages[0].role, 'system')
  const second = run.modelRequests[1]
  const assistant = second.messages.find((message) => message.role === 'assistant' && message.tool_calls)
  assert.equal(assistant.tool_calls[0].function.name, 'ApplyBatch')
  const toolMessage = second.messages.find((message) => message.role === 'tool')
  assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id)
  assert.match(String(toolMessage.content), /"accepted":true/)
})

test('provider schema shaping preserves recursive refs and unsatisfiable constant alternatives', async () => {
  const original = { type: 'object', properties: {
    chain: { $ref: '#/$defs/Node' },
    choice: { anyOf: [{ const: 'a', type: 'number' }, { const: 'b', type: 'string' }] },
  }, $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } } }
  const toolSchemas = advertisedTools().map(tool => tool.name === 'QueryBoard' ? { ...tool, inputSchema: original } : tool)
  const run = await runAgent({ argv: [], provider: 'openai', toolSchemas, chatLines: ['Hello'], model: () => 'Hello' })
  assert.equal(run.code, 0, run.stderr)
  const shaped = run.modelRequests[0].tools.find(tool => tool.function.name === 'QueryBoard').function.parameters
  const ajv = new Ajv({ strict: false })
  const before = ajv.compile(original), after = ajv.compile(shaped)
  for (const value of [{ chain: { next: { next: {} } }, choice: 'b' }, { chain: { next: 1 } }, { choice: 'a' }]) {
    assert.equal(after(value), before(value), JSON.stringify(value))
  }
  assert.equal(after({ choice: 'a' }), false)
})

test('a goal the Board completed in the last conversational round is reported as completed', async () => {
  const run = await runAgent({ argv: [], env: { RULITH_MAX_ROUNDS: '2' }, captureLocalEvents: true,
    gateway: defaultGateway({ settleAfterBatch: true, certifyAfterBatch: true }), chatLines: ['Finish the work.'],
    model: round => round === 1 ? callTool('ApplyBatch', declareGoal())
      : callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'ready', args: {} }] }),
  })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /The Board certified the goal and it is completed\./)
  assert.doesNotMatch(run.stdout, /Stopped at the 2-round limit/)
})

test('an endpoint that rejects tool definitions gets the same tools described in the prompt', async () => {
  const run = await runAgent({
    argv: [],
    refuseTools: true,
    chatLines: ['Open a Case.'],
    model: (round, body) => {
      // The first request carried tools and was refused; the retry must not.
      if (body.tools !== undefined) return 'unreachable'
      const spoken = JSON.stringify(body.messages).includes('ApplyBatch result') ? 'Declared.' : ''
      return spoken === '' ? `{"tool":"ApplyBatch","input":${JSON.stringify(declareGoal())}}` : spoken
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /refused a request carrying tool definitions/)
  assert.equal(run.verbs.includes('ApplyBatch'), true,
    `the fallback lost the model's ability to reach the Board: ${run.verbs.join(', ')}`)
  const emulated = run.modelRequests.filter((request) => request.tools === undefined)
  assert.ok(emulated.length >= 1)
  const system = systemTextOf(emulated[0])
  for (const tool of MODEL_TOOLS) assert.ok(system.includes(tool), `${tool} is missing from the emulated tool guide`)
  assert.match(system, /reply with exactly one JSON object/)
})

test('RULITH_MODEL_TOOLS=emulated selects the fallback transport without a failed request', async () => {
  const run = await runAgent({
    argv: [],
    env: { RULITH_MODEL_TOOLS: 'emulated' },
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? `{"tool":"ApplyBatch","input":${JSON.stringify(declareGoal())}}` : 'Declared.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.modelRequests.every((request) => request.tools === undefined),
    'the forced fallback still sent tool definitions')
  assert.equal(run.verbs.includes('ApplyBatch'), true)
  assert.doesNotMatch(run.stdout, /refused a request carrying tool definitions/,
    'no request failed, so nothing should be reported as a fallback')
})

for (const failure of [HOP_FAILURE, { accepted: false, errorCode: 'upstream_unavailable', teaching: 'The Board response was lost.' }]) {
test(`a ${failure === HOP_FAILURE ? 'transport' : 'gateway upstream'} failure is said as one, and the host never re-sends the call`, async () => {
  // The old behaviour was to tell the model "retry the identical step, it keeps the same
  // request identity". That promise cannot be kept: the transport key includes the MCP
  // session, so a re-send under any later session is a *different* logical call. The host
  // re-sends nothing; the model is told the answer did not arrive, and whatever it chooses
  // next is a new call that the authority's write gate judges.
  let attempts = 0
  const batch = { operations: [{ op: 'assert_fact', id: 'F_AMBIG', predicate: 'scratch.demo.value', args: { value: 'one' } }] }
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Record this despite a transient network failure.'],
    captureLocalEvents: true,
    tool: (name, args) => {
      if (name !== 'ApplyBatch' || args.operations?.[0]?.op !== 'assert_fact') return undefined
      attempts += 1
      return attempts === 1 ? failure : undefined
    },
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', batch)
      return 'I will look at operations before trying again.'
    },
    timeoutMs: 25_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const sent = run.toolCalls.filter((call) => call.name === 'ApplyBatch' && call.args.operations[0].op === 'assert_fact')
  assert.equal(sent.length, 1, `the host re-sent a write whose answer was lost: ${JSON.stringify(run.verbs)}`)
  assert.equal(run.modelRequests.length, 3, 'the model was not told that the answer was lost')
  // The classification still travels — as the verdict a person and the local view can read.
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch').at(-1)
  assert.equal(verdict.transportFailed, true)
  assert.match(verdict.teaching, /transport failure, not the Board's answer: the call may or may not have run/)
  assert.doesNotMatch(verdict.teaching, /Retry the identical step|reaches that same identity/,
    'transport uncertainty was reported as something the model may simply re-issue')
  assert.match(run.stdout, /No answer arrived for ApplyBatch/)
  assert.ok(run.localEvents.some((event) => event.type === 'case-state' && event.contact === 'unknown'),
    'after a lost answer, the inspector must not continue presenting an earlier observation as confirmed')
})
}

test('a write whose answer was lost after it ran cannot run again blind: the next write is refused with its result', async () => {
  // The lost-in-transit window. The authority executed the batch and wrote its answer, and the
  // stream broke before it arrived, with no way to resume it. The host opens a new session
  // rather than going on with this one, so the lost result stays unacknowledged; when the
  // model proposes the same write again, the authority does not run it, and hands the model
  // the earlier outcome instead.
  const batch = { operations: [{ op: 'assert_fact', id: 'F_ONCE', predicate: 'x', args: {} }] }
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '5' }, chatLines: ['Record it once.'],
    sseResults: true, breakStreamOnCall: 2, refuseResume: true,
    model: (round) => round === 1 ? callTool('ApplyBatch', declareGoal()) : round <= 3 ? callTool('ApplyBatch', batch) : 'Recorded once.',
    timeoutMs: 25_000,
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  // The declaration and the write, once each.
  assert.equal(run.operations.filter((op) => op.tool === 'ApplyBatch').length, 2, 'the write ran twice')
  assert.ok(run.initializes.length >= 2, 'the host kept using the session whose answer it lost')
  const second = JSON.parse(run.modelRequests.at(-1).messages.filter((message) => message.role === 'tool').at(-1).content)
  assert.equal(second.errorCode, 'previous_result_undelivered')
  assert.equal(second.requestExecuted, false)
  assert.equal(second.operations.find((entry) => entry.tool === 'ApplyBatch').result.isError, false,
    'the refusal did not hand over the earlier outcome')
})

test('distinct submissions carry distinct request identities, and an answered one is not reused', async () => {
  // The other half of the retry ledger. An id that never got released would make every
  // repeated write share one identity, which is the same defect wearing the opposite sign.
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '6' },
    chatLines: ['record two facts'],
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F2', predicate: 'x', args: {} }] })
      return 'Both recorded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const ids = run.toolCalls.map((call) => call.id)
  assert.ok(ids.length >= 3, `only ${ids.length} tool calls were observed`)
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(String(id))), `every submission must carry a UUID request identity: ${ids.join(', ')}`)
  assert.equal(new Set(ids).size, ids.length, `distinct submissions shared one request identity: ${ids.join(', ')}`)
})

test('an empty arguments string is an empty object, not a malformed call', async () => {
  // Several OpenAI-compatible endpoints send `""` for a tool that takes no arguments.
  // Refusing it locally would refuse every no-argument verb on those endpoints, and the
  // symptom — "the model kept trying to read the Board and nothing happened" — points at
  // the model rather than at the client that dropped the call.
  const run = await runAgent({
    argv: [],
    chatLines: ['Look at the Board.'],
    model: (round) => (round === 1
      ? { text: '', toolCalls: [{ name: 'QueryBoard', input: {}, rawArguments: '' }] }
      : 'Read.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('QueryBoard'), true, `an empty argument string was refused: ${run.verbs.join(', ')}`)
})

test('the Anthropic transcript alternates roles even when the host adds its own nudge', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    provider: 'anthropic',
    env: { RULITH_MAX_ROUNDS: '4' },
    gateway: defaultGateway({ settleAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Finished.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const last = run.modelRequests.at(-1).messages
  assert.equal(last[0].role, 'user', 'an Anthropic conversation must begin with a user turn')
  for (let index = 1; index < last.length; index++) {
    assert.notEqual(last[index].role, last[index - 1].role,
      `two ${last[index].role} turns in a row: the host's nudge was appended without folding.\n${JSON.stringify(last.map((message) => message.role))}`)
  }
  // Calibration: the nudge really is in there, folded into the tool result turn.
  assert.match(JSON.stringify(last), /These goals are still open on the Board/)
  const nudgeText = last.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.doesNotMatch(nudgeText, /"directory"|Board View last observed/,
    'the nudge must not repeat a previous Board View')
})

test('tool arguments that are not a JSON object are refused locally', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1
      ? { text: '', toolCalls: [{ name: 'ApplyBatch', input: {}, rawArguments: 'not json' }] }
      : 'I will send a JSON object.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), false, 'malformed arguments reached the authority')
  assert.match(JSON.stringify(run.modelRequests[1]), /bad_tool_arguments/)
})

// ── Host features the model has no verb for ──────────────────────────────────

// `--case` and the other OpenCase-steering options were retired with rulith/v4; that they stop
// the run before anything is sent is asserted in serial-calls.test.mjs (RT-REC-10).

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
    timeoutMs: 6000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const runs = run.serveSnapshot?.runs ?? []
  assert.equal(runs.length, 2, `the queue did not survive the first failure: ${JSON.stringify(runs)}`)
  assert.match(String(runs[0].note), /Model service error \(500\)/,
    `the failed task must be recorded with its reason: ${JSON.stringify(runs[0])}`)
  assert.match(String(runs[1].note), /Response delivered/)
})

for (const provider of ['openai', 'anthropic']) {
  for (const truncated of [false, true]) {
    test(`--serve reports ${provider} ${truncated ? 'truncation' : 'empty output'} and allows a later conversation turn`, async () => {
      const port = await freePort()
      const body = provider === 'openai'
        ? { choices: [{ finish_reason: truncated ? 'length' : 'stop', message: truncated
          ? { content: 'A partial answer', tool_calls: [{ id: 'partial', type: 'function', function: { name: 'ApplyBatch', arguments: '{"operations":[]}' } }] }
          : { content: null, reasoning_content: 'Reasoning alone is not a response.' } }] }
        : { stop_reason: truncated ? 'max_tokens' : 'end_turn', content: truncated
          ? [{ type: 'text', text: 'A partial answer' }, { type: 'tool_use', id: 'partial', name: 'ApplyBatch', input: { operations: [] } }]
          : [{ type: 'thinking', thinking: 'Reasoning alone is not a response.' }] }
      const run = await runAgent({
        argv: ['--serve'], provider,
        env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'provider-response-test',
          RULITH_MODEL_MAX_OUTPUT_TOKENS: truncated ? '12000' : '' },
        serveTasks: ['first turn', 'continue'], waitForServeCompletion: true,
        model: n => n === 1 ? { status: 200, body } : 'The next turn works.',
        timeoutMs: 6000,
      })
      assert.equal(run.modelRequests.length, 2, 'there must be no automatic paid retry')
      assert.equal(run.modelRequests[0].max_tokens, truncated ? 12000 : 6000)
      assert.equal(run.verbs.includes('ApplyBatch'), false, 'a truncated tool call must never execute')
      assert.equal(run.serveSnapshot.runs[0].outcome, 'model-error')
      assert.match(run.serveSnapshot.runs[0].note, truncated ? /output token limit/ : /no answer or tool call/)
      assert.doesNotMatch(run.serveSnapshot.runs[0].note, /Response delivered/)
      assert.match(run.serveSnapshot.runs[1].note, /Response delivered/)
      assert.equal(run.serveSnapshot.runs[1].outcome, 'conversation')
    })
  }
}

test('interactive chat survives empty model output and preserves prior tool results', async () => {
  const run = await runAgent({ argv: [], chatLines: ['Open a Case.', 'Continue.'],
    model: n => n === 1 ? callTool('ApplyBatch', declareGoal()) : n === 2 ? '' : 'The conversation continued.' })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /no answer or tool call/)
  assert.match(run.stdout, /The conversation continued/)
  assert.equal(run.verbs.filter(verb => verb === 'ApplyBatch').length, 1)
  assert.match(JSON.stringify(run.modelRequests.at(-1)), /GOAL_1/)
})

test('one-shot reports a recoverable model failure with its open goal', async () => {
  const run = await runAgent({ argv: ['Open a Case.'], captureLocalEvents: true,
    model: n => n === 1 ? callTool('ApplyBatch', declareGoal()) : '' })
  assert.equal(run.code, 1)
  const end = run.localEvents.find(event => event.type === 'end')
  assert.equal(end.outcome, 'model-error')
  assert.equal(end.pendingGoal, 'GOAL_1')
  assert.match(run.stdout, /This goal remains open: pending_goal=GOAL_1\. Continue it in a later run, or resolve it in Console\./)
  assert.doesNotMatch(run.stdout, /--case/)
})

test('an empty shadow review is unavailable and preserves the goal report', async () => {
  const run = await runAgent({ argv: ['Open a Case.', '--shadow'], captureLocalEvents: true,
    env: { RULITH_MODEL_THINKING: 'disabled', RULITH_MODEL_MAX_OUTPUT_TOKENS: '12000' },
    model: (n, request) => systemTextOf(request).includes('adversarial shadow reviewer') ? ''
      : n === 1 ? callTool('ApplyBatch', declareGoal()) : 'Waiting for more information.' })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.equal(run.localEvents.find(event => event.type === 'end').pendingGoal, 'GOAL_1')
  assert.equal(run.modelRequests[0].max_tokens, 12000)
  assert.equal(run.modelRequests.at(-1).max_tokens, 6000, 'the shadow has its own output budget')
  assert.equal(run.localEvents.find(event => event.type === 'shadow').unavailable, true)
  assert.equal(run.modelRequests.at(-1).thinking, undefined, 'main model settings must not leak to a separately configured shadow')
  assert.doesNotMatch(run.stdout, /Shadow review: PASS/)
})

test('--serve assigns independent conversation keys when callers omit sessionKey', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'conversation-key-test' },
    serveTasks: ['hello from client A', 'hello from client B'],
    waitForServeCompletion: true,
    model: () => 'Hello. No governed Case is needed.',
    timeoutMs: 6000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const keys = run.serveResponses.map((response) => response.body.sessionKey)
  assert.ok(keys.every((key) => typeof key === 'string' && key !== ''), `missing generated session keys: ${JSON.stringify(keys)}`)
  assert.notEqual(keys[0], keys[1], 'unrelated no-key clients must not share the default conversation slot')
})

test('--serve records a recoverable goal before reclaiming an abandoned conversation slot', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'slot-capacity-test', RULITH_SERVE_SLOTS_MAX: '1' },
    serveTasks: [
      { text: 'Start governed work.', sessionKey: 'client-a' },
      { text: 'Start an unrelated conversation.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'The goal remains active.'),
    timeoutMs: 8000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'ApplyBatch').length, 1)
  const detached = (run.serveSnapshot?.runs ?? []).find((record) => record.sessionKey === 'client-a' && record.pendingGoal)
  assert.ok(detached, `the reclaimed goal was not exposed for recovery: ${JSON.stringify(run.serveSnapshot)}`)
  assert.equal(detached.pendingGoal, 'GOAL_1')
  assert.match(detached.note, /Rulith goal "GOAL_1" remains unchanged on the Board\./)
  const localEvents = run.localEvents.filter((event) => (event.session || event.sessionKey) === 'client-a').map((event) => ({ ...event, src: 'agent' }))
  assert.ok(localEvents.some((event) => event.type === 'case-state'), 'the --serve publisher feeds the real Local inspector')
  assert.equal(localEvents.some((event) => event.type === 'case-pending'), false, 'normal Local --serve is not the one-shot pending path')
  const displayed = projectCaseRoots(localEvents)
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0].lifecycle, 'running', 'a reclaimed local conversation is not a goal transition')
  assert.equal(displayed[0].observation, 'Detached · last observed')
})

test('a goal declared in a later message joins the conversation focus rather than replacing the one it has', async () => {
  // Focus is additive (AIS §4): declaring a goal adds it, and no branch clears the others. With no
  // focus operation left, a second goal reaches a conversation only by being declared.
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'goal-focus-test' },
    serveTasks: [
      { text: 'Start this conversation\'s work.', sessionKey: 'client-a' },
      { text: 'Start the other work too.', sessionKey: 'client-a' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal('task_a'))
      : round === 3 ? callTool('ApplyBatch', declareGoal('task_b')) : 'Both goals are in focus.'),
    timeoutMs: 8000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const focus = run.localEvents.filter((event) => event.type === 'focus' && event.session === 'client-a').at(-1)
  assert.deepEqual(focus.goals.map((row) => row.goal).sort(), ['GOAL_1', 'GOAL_2'],
    'the existing goal was silently replaced instead of joined')
})

test('conversation mode emits Board verdicts and per-goal observations for Local', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record one governed observation.'],
    captureLocalEvents: true,
    model: (round) => {
      if (round === 1) return callTool('ApplyBatch', declareGoal())
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F_EVENT', predicate: 'scratch.demo.observation', args: { value: 'visible' } }] })
      return 'The explicit step was accepted and is visible in the goal trace.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.ok(run.localEvents.some((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch' && event.accepted === true),
    `Local received no Board verdict: ${JSON.stringify(run.localEvents)}`)
  assert.ok(run.localEvents.some((event) => event.type === 'case-open' && event.ok === true),
    `Local received no goal lifecycle event: ${JSON.stringify(run.localEvents)}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state')
  assert.ok(observations.length > 0, 'the actual Agent publisher must emit lifecycle observations')
  assert.ok(observations.every((event) => !Object.hasOwn(event, 'revision')), 'Local observations do not carry protocol cursors')
  for (let index = 1; index < observations.length; index += 1) {
    const value = ({ goal, status, gaps, contact }) => ({ goal, status, gaps, contact })
    assert.notDeepEqual(value(observations[index]), value(observations[index - 1]), 'unchanged observations are not repeated per tool call')
  }
})

test('a refused declaration never creates a conversation focus binding', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Try to start governed work.'], captureLocalEvents: true,
    tool: (name) => (name === 'ApplyBatch'
      ? withMeta(
          { accepted: false, errorCode: 'commercial_admission_rejected', teaching: 'Declaring was refused.',
            payload: { goals: { directory: [{ goal: 'GOAL_NOT_DECLARED', label: 'x', status: 'running' }], total: 1 }, gaps: [], nodes: [], actions: [] } },
          { agentId: TEST_AGENT_ID, focusedGoals: [] },
        )
      : undefined),
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'Declaring was refused.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.localEvents.some((event) => event.type === 'case-state'), false,
    'a goal named in the directory but not in focus must not become this conversation\'s goal')
  assert.equal(run.localEvents.some((event) => event.type === 'case-open'), false)
})

test('a focused goal the Board View never described is unavailable, never invented as running', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Start governed work.'], captureLocalEvents: true,
    tool: (name) => (name === 'ApplyBatch'
      ? withMeta(
          { accepted: true, revision: 'r1', payload: { goals: { directory: [], total: 0 }, gaps: [], nodes: [], actions: [] } },
          { agentId: TEST_AGENT_ID, focusedGoals: ['GOAL_Q'] },
        )
      : undefined),
    model: (round) => (round === 1 ? callTool('ApplyBatch', declareGoal()) : 'The lifecycle status was not returned.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state')
  assert.equal(observations.length, 1)
  assert.equal(observations[0].goal, 'GOAL_Q')
  assert.equal(observations[0].status, 'unavailable')
  assert.equal(projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))[0].label, 'Unavailable')
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

test('model usage reports bounded request sizes without copying prompt content into the event', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['unique private-sized prompt marker'], captureLocalEvents: true,
    model: () => ({ text: 'A short answer.', usage: {
      prompt_tokens: 120, completion_tokens: 9, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40,
    } }),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const usage = run.localEvents.find((event) => event.type === 'model-usage')
  assert.ok(usage, 'the model call emitted no usage event')
  assert.ok(Number.isSafeInteger(usage.requestBytes) && usage.requestBytes > 0)
  assert.ok(Number.isSafeInteger(usage.transcriptBytes) && usage.transcriptBytes > 0)
  assert.ok(usage.requestBytes >= usage.transcriptBytes)
  assert.equal(usage.messageCount, 1)
  assert.equal(usage.cachedInputTokens, 80)
  assert.equal(usage.uncachedInputTokens, 40)
  assert.doesNotMatch(JSON.stringify(usage), /unique private-sized prompt marker/)
})

test('inconsistent provider cache counts remain unknown, not a fabricated discount', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['check cache accounting'], captureLocalEvents: true,
    model: () => ({ text: 'Done.', usage: {
      prompt_tokens: 120, completion_tokens: 9, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 39,
    } }),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const usage = run.localEvents.find(event => event.type === 'model-usage')
  assert.equal(usage.inputTokens, 120)
  assert.equal(usage.cachedInputTokens, null)
  assert.equal(usage.uncachedInputTokens, null)
})

test('long turns retain Artifact evidence and the latest Board View while shortening older views', async () => {
  const strips = ['running', 'waiting_for_decision', 'needs_person'].flatMap(state =>
    ['ApplyAction', 'ApplyBatch'].map(tool => [{ tool, label: tool, state, at: '2026-10-01T08:00:00Z', since: '2026-10-01T08:00:01Z',
      ...(state === 'running' ? { stage: 'at_worker' } : {}),
      ...(state === 'waiting_for_decision' ? { decision: 'a person\'s decision in Console' } : {}) }]))
  let acceptedQueries = 0
  const ref = 'art_' + 'a'.repeat(32)
  const gateway = defaultGateway({
    goals: Array.from({ length: 90 }, (_, index) => ({ goal: `ARCHIVED_${index}`, status: 'completed' })),
    artifacts: { [ref]: { text: 'immutable document marker for authoring' } },
  })
  let queries = 0
  const run = await runAgent({
    argv: [], chatLines: ['Read the attached material and inspect the Board.'],
    gateway, captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '12' },
    tool: (name, args, board, session) => {
      if (name !== 'QueryBoard') return undefined
      queries += 1
      if (queries % 3 === 0) return { accepted: false, errorCode: 'query_refused_for_fixture', requestExecuted: false,
        teaching: 'The Board refused this query.', operations: [], view: {} }
      const result = committed(board.tool(name, args, session).payload)
      result.operations = strips[acceptedQueries++]
      return result
    },
    model: (round) => round === 1 ? callTool('ReadArtifact', { ref })
      : round < 11 ? callTool('QueryBoard', {}) : 'The inspection is complete.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 11, 'the long-turn fixture did not reach the intended number of model calls')
  const last = run.modelRequests.at(-1)
  const transcript = JSON.stringify(last.messages)
  assert.match(transcript, /immutable document marker for authoring/,
    'view compaction discarded material evidence needed later in the same turn')
  assert.match(transcript, /earlierBoardView/,
    'the older full Board snapshots were repeated in an expensive request')
  assert.match(transcript, /ARCHIVED_89/,
    'the latest authoritative Board View was removed')
  assert.match(transcript, /query_refused_for_fixture/,
    'a refused tool result lost its reason when its older Board View was shortened')
  const retainedStrips = last.messages.filter(message => message.role === 'tool')
    .map(message => JSON.parse(message.content)).filter(result => result.observation !== undefined).map(result => result.operations)
  assert.deepEqual(retainedStrips, strips, 'identical snapshots lost their distinct operations strips')
  assert.equal((transcript.match(/ARCHIVED_89/g) ?? []).length, 1,
    'only the latest identical accepted snapshot is needed; refused reads carry no snapshot')
  assert.match(transcript, /identicalToToolCall/)
  assert.ok(run.localEvents.some((event) => event.type === 'model-usage'
    && event.compactedViews > 0 && event.compactedTranscriptBytes > 0))
})

test('context compression retains distinct Board observations and partial or refused snapshots', async () => {
  let queries = 0
  const goals = Array.from({ length: 350 }, (_, index) => ({ goal: `G_${index}`, label: `G_${index}`, status: 'completed' }))
  const run = await runAgent({
    argv: [], chatLines: ['Compare these observations without dropping their evidence.'], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '6' },
    tool: name => {
      if (name !== 'QueryBoard') return undefined
      queries += 1
      const marker = ['FIRST_SCOPE_ONLY', 'PARTIAL_SCOPE_ONLY', 'REFUSED_SCOPE_ONLY', 'LAST_SCOPE_ONLY'][queries - 1]
      if (queries === 3) return { accepted: false, errorCode: 'refused_but_retained', requestExecuted: false,
        teaching: `${marker}: Use the earlier complete result.`, operations: [], view: {} }
      return committed({ goals: { directory: [{ goal: marker, label: marker, status: 'completed' }, ...goals], total: goals.length + 1,
        ...(queries === 2 ? { truncated: true } : {}) }, gaps: [], nodes: [], actions: [] })
    },
    model: round => round <= 4 ? callTool('QueryBoard', {}) : 'Compared all observations.',
  })
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.modelRequests.length, 5)
  const transcript = JSON.stringify(run.modelRequests.at(-1).messages)
  for (const marker of ['FIRST_SCOPE_ONLY', 'PARTIAL_SCOPE_ONLY', 'REFUSED_SCOPE_ONLY', 'LAST_SCOPE_ONLY'])
    assert.ok(transcript.includes(marker), 'lost observation: ' + marker)
  assert.match(transcript, /refused_but_retained/)
})
