// SPDX-License-Identifier: Apache-2.0
/**
 * The model surface is seven tools called over one `/mcp` endpoint.
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
  hostFieldTools, requiredHostFieldTools, runAgent, systemTextOf, withMeta,
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
  assert.deepEqual(runtime.filter((entry) => entry.target === 'operation').map((entry) => entry.name), ['ReadOperation'])
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
  // What it must say instead: the five shapes a step of reasoning may take.
  for (const shape of ['assert_fact', 'add_axiom', 'declare_hypothesis', 'record_result', 'retract_node', 'revise_fact']) {
    assert.ok(system.includes(shape), `the prompt does not name the ${shape} shape`)
  }
  assert.match(system, /Never assert acceptance_met, test_result, certification or rulith\.exploration\.completed/)
  assert.match(system, /call QueryBoard when you need a current view/,
    'reading the Board is now the model\'s own tool, so the prompt must say so')
})

test('RT-TOOLS-3 no model-facing schema exposes a retired or host-owned field', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  const tools = declaredToolsOf(run.modelRequests[0])
  assert.equal(tools.length, 7)
  // Top level only, because that is the scope host metadata lives on. The envelope is the
  // boundary; a property one level down inside a business object is business data, and
  // RT-TOOLS-3c asserts that such a property survives.
  const owned = ['case', 'expectedRevision', 'caseRevision', 'expectedBoardSharedEpoch', 'viewToken', 'requestId',
    'kind', 'queryContext', 'audienceProfile', 'requestedRoots', 'interaction', 'admission']
  for (const tool of tools) {
    // A schema states its shape either as one property map or as composition branches — the
    // contract's `OpenCase` is a `oneOf` of the create form and the focus form — so the
    // assertion is that the model can reach no host-owned name either way, not that some
    // particular carrier is present.
    const branches = ['oneOf', 'anyOf', 'allOf'].flatMap((key) => (Array.isArray(tool.schema?.[key]) ? tool.schema[key] : []))
    const properties = [...Object.keys(tool.schema?.properties ?? {}),
      ...branches.flatMap((branch) => Object.keys(branch?.properties ?? {}))]
    if (tool.name === 'ReadOperation') {
      assert.equal(tool.schema?.type, 'object')
      assert.equal(tool.schema?.additionalProperties, false)
      assert.deepEqual(properties, [], 'ReadOperation must take exactly {}')
    } else assert.ok(properties.length > 0, `${tool.name} lost its schema entirely rather than one property`)
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
  // And the model surface keeps the fields that are genuinely its own.
  const openCase = tools.find((tool) => tool.name === 'OpenCase').schema
  assert.ok(names(openCase).includes('caseId'), 'OpenCase({caseId}) is the public focus form and must survive the projection')
  assert.ok(names(openCase).includes('businessKey'), 'businessKey is the model own object of named business-key values')
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
      if (round === 1) return callTool('OpenCase', {})
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
  const sent = run.toolCalls.find((call) => call.name === 'ApplyBatch')
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

test('RT-TOOLS-4 a tool that is not one of the seven is refused locally and never forwarded', async () => {
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
        if (round === 1) return callTool('OpenCase', {})
        if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }], [field]: value })
        return 'I will reissue it without that field.'
      },
    })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(run.verbs.includes('ApplyBatch'), false,
      `${field} reached the authority and may have executed under a guessed contract: ${run.verbs.join(', ')}`)
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
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('ApplyBatch'), true)
})

// ── Host metadata: one channel, filled from what the authority returned ──────

test('RT-META-1 the client sends no protected metadata of its own, in the envelope or in the arguments', async () => {
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

test('RT-META-1b the client declares the recovery capability it actually implements', async () => {
  const run = await runAgent({ argv: [], chatLines: ['hello'], model: () => 'Hello.' })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const [handshake] = run.initializes
  assert.equal(handshake.protocolVersion, '2025-11-25', 'the client offered a protocol version it does not implement')
  assert.deepEqual(handshake.capabilities?.experimental?.['rulith/v2'], { operationRecovery: 1 },
    'the operation-recovery declaration is how a Gateway knows this host waits on one call and collects the result;'
    + ' without it the Gateway must refuse the host before any business runs')
  assert.equal(handshake.presentedSession, undefined, 'a fresh process presented a session identity it does not hold')
})

test('RT-META-2 the identity, revision and focus the host tracks come only from the authority', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    chatLines: ['Open a Case.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const focus = run.localEvents.filter((event) => event.type === 'focus').at(-1)
  assert.deepEqual(focus.roots, [{ caseId: 'CASE_1', root: 'ROOT_1', status: 'running', contact: 'observed' }],
    'focus pairs must be the ones Core returned, never derived locally')
  const observed = run.localEvents.filter((event) => event.type === 'case-state').at(-1)
  assert.equal(observed.caseId, 'CASE_1')
  assert.equal(observed.root, 'ROOT_1')
  assert.equal(observed.caseStatus, 'running')
  // Core mints the identity. A host that minted one would have named the Case itself.
  const opened = run.toolCalls.find((call) => call.name === 'OpenCase')
  assert.equal(opened.args.caseId, undefined, 'the host minted a Case id that belongs to Core')
})

test('RT-META-3 a session whose focus holds several roots is reported as several roots', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Open two governed Cases.'],
    model: (round) => (round <= 2 ? callTool('OpenCase', {}) : 'Both Cases are in focus.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 2,
    'a second Case in one session was refused by the host, which no longer owns that rule')
  const focus = run.localEvents.filter((event) => event.type === 'focus').at(-1)
  assert.deepEqual(focus.roots.map((row) => row.caseId), ['CASE_1', 'CASE_2'])
  const rows = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))
  assert.deepEqual(rows.map((row) => [row.caseId, row.root, row.label]),
    [['CASE_1', 'ROOT_1', 'Running'], ['CASE_2', 'ROOT_2', 'Running']])
})

test('RT-META-4 an independent lifecycle per root: closing one leaves the other running', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '6' },
    gateway: defaultGateway({ settleAfterBatch: true }),
    chatLines: ['Open two Cases and close the first.'],
    model: (round) => {
      if (round <= 2) return callTool('OpenCase', {})
      if (round === 3) return callTool('CloseCase', { root: 'ROOT_1', disposition: 'abandoned' })
      return 'The second Case is still running.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const rows = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))
  const byId = Object.fromEntries(rows.map((row) => [row.caseId, row]))
  assert.equal(byId.CASE_1.label, 'Closed')
  assert.equal(byId.CASE_1.focused, false)
  assert.equal(byId.CASE_2.label, 'Running')
  assert.equal(byId.CASE_2.focused, true, 'closing one root removed another root from focus')
  assert.ok(run.localEvents.some((event) => event.type === 'case-closed' && event.caseId === 'CASE_1'))
})

test('RT-META-5 a root the authority reports as unavailable loses the status it used to have', async () => {
  // Neutral by construction: the Board View says a root is unavailable without saying
  // whether it never existed, was deleted, or is not visible. What must not happen is the
  // display keeping "running" because the last answer that mentioned the root said so —
  // that is inventing a status, only more slowly.
  let calls = 0
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Open a Case, then read the Board.'],
    tool: (name, args, board, session) => {
      calls += 1
      if (calls < 2) return undefined
      return withMeta(
        { accepted: true, revision: 'r7',
          payload: { roots: [], unavailableRoots: ['ROOT_1'], cases: { directory: [], total: 0 }, gaps: [], nodes: [], actions: [] } },
        { agentId: TEST_AGENT_ID, focusedRoots: [{ caseId: 'CASE_1', root: 'ROOT_1' }] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('QueryBoard', { include: ['cases'] })
      return 'The root is no longer available to me.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state' && event.caseId === 'CASE_1')
  assert.equal(observations.at(0).caseStatus, 'running')
  assert.equal(observations.at(-1).caseStatus, 'unavailable',
    `an unavailable root kept a status the authority stopped reporting: ${JSON.stringify(observations)}`)
  assert.equal(projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))[0].label, 'Unavailable')
})

test('RT-META-6 a bounded view that dropped rows says so; a complete one does not', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Read the Board twice.'],
    tool: (name, args, board, session, meta) => {
      if (name !== 'QueryBoard') return undefined
      // The carriers Core published: per-limb `cases.truncated` beside `cases.total`, and
      // the top-level `truncated` for the node limbs. An earlier client read an aggregate
      // `loss` object that a Core draft proposed and the published schema does not contain,
      // so against the real authority it saw no truncation at all.
      const core = board.tool(name, args, session, meta)
      return withMeta({ ...core, payload: { ...core.payload, cases: { ...core.payload.cases, truncated: true }, total: 9, truncated: true } }, board.meta(session))
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('QueryBoard', { include: ['cases'] })
      return 'Some rows were omitted.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /QueryBoard returned a bounded view: cases \(1 total\), nodes \(9 total\) was truncated by the authority/)
  assert.match(run.stdout, /anything it does not mention is unreported, not absent/)
  const losses = run.localEvents.filter((event) => event.type === 'loss')
  assert.equal(losses.length, 1, 'silent truncation reads as "covered everything" when it did not')
  assert.deepEqual([losses[0].cmd, losses[0].limbs], ['QueryBoard', ['cases', 'nodes']])
  // Calibration: the OpenCase answer carried no loss record and produced no note.
  assert.equal(run.localEvents.filter((event) => event.type === 'loss' && event.cmd === 'OpenCase').length, 0)
})

test('RT-META-6b a root a truncated answer did not reach keeps a labelled observation, not a fresh one', async () => {
  // The subtle half of truncation. The bounded answer simply did not reach this root, so its
  // previous status is all anyone has — but passing that status back through as a new
  // observation republishes stale state as if the authority had just confirmed it. It is
  // retained and labelled instead, and `unavailable` stays a different statement: that one
  // the authority made on purpose.
  let calls = 0
  const run = await runAgent({
    argv: [], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Open a Case, then read a bounded view.'],
    tool: (name, args, board, session, meta) => {
      calls += 1
      if (calls < 2) return undefined
      return withMeta(
        { accepted: true, revision: 'r7',
          // Truncated, and mentioning no roots at all: CASE_1 is unreported, not absent.
          payload: { roots: [], cases: { directory: [], total: 4, truncated: true }, gaps: [], nodes: [], total: 0, truncated: false } },
        { agentId: TEST_AGENT_ID, focusedRoots: [{ caseId: 'CASE_1', root: 'ROOT_1' }] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('QueryBoard', { include: ['cases'] })
      return 'The view was bounded.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state' && event.caseId === 'CASE_1')
  assert.equal(observations.at(0).caseStatus, 'running')
  assert.equal(observations.at(0).contact, undefined, 'a refreshed observation carries no contact qualifier')
  const last = observations.at(-1)
  assert.equal(last.caseStatus, 'running', 'a truncated answer is not evidence the root changed')
  assert.equal(last.contact, 'not-refreshed',
    `a status the bounded answer never mentioned was republished as freshly observed: ${JSON.stringify(observations)}`)
  // Truncation is not unavailability: one says "I did not reach it", the other says
  // "I looked and it is not there for you".
  assert.notEqual(last.caseStatus, 'unavailable')
  const row = projectCaseRoots(run.localEvents.map((event) => ({ ...event, src: 'agent' })))[0]
  assert.equal(row.label, 'Running')
  assert.equal(row.observation, 'Not refreshed by the last bounded answer')
  // And a per-view gap count is not attached to a root this answer did not describe.
  assert.equal(Object.hasOwn(last, 'gaps'), false)
})

test('RT-META-7 an empty affectedCases is reported, because it is a statement', async () => {
  const run = await runAgent({
    argv: [], captureLocalEvents: true,
    env: { RULITH_MAX_ROUNDS: '5' },
    chatLines: ['Record a blind addition, then act.'],
    tool: (name, args, board, session, meta) => {
      const core = board.tool(name, args, session, meta)
      if (name === 'ApplyBatch') return withMeta(core, { ...board.meta(session), affectedCases: [] })
      if (name === 'ApplyAction') return withMeta(core, { ...board.meta(session), affectedCases: ['CASE_1'] })
      return undefined
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      if (round === 3) return callTool('ApplyAction', { action: 'acme.ship' })
      return 'Done.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const affected = run.localEvents.filter((event) => event.type === 'affected')
  assert.deepEqual(affected.map((event) => [event.cmd, event.affectedCases]),
    [['ApplyBatch', []], ['ApplyAction', ['CASE_1']]],
    '"no live root advanced" and "the authority did not say" must not read the same')
})

// ── ReadArtifact: bounded data, and nothing else ─────────────────────────────

test('RT-ART-1 an artifact is read in bounded fragments and touches no Board state', async () => {
  const text = 'line-one\nline-two\nline-three'
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '6' }, captureLocalEvents: true,
    chatLines: ['Read the result the Action produced.'],
    gateway: defaultGateway({ artifacts: { 'art-1': { mediaType: 'text/plain', text } } }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ReadArtifact', { ref: 'art-1', maxBytes: 8 })
      if (round === 3) return callTool('ReadArtifact', { ref: 'art-1', offset: 8, maxBytes: 64 })
      return 'I have the whole result.'
    },
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'ReadArtifact', 'ReadArtifact'],
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
  assert.deepEqual(focus.roots.map((row) => row.caseId), ['CASE_1'], 'the artifact read changed the focused roots')
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
    tool: (name) => {
      if (name !== 'ApplyBatch') return undefined
      served += 1
      if (served > 1) return undefined
      return withMeta(
        { accepted: false, errorCode: 'precondition_not_met',
          teaching: 'The premises this step depends on are not in force. Read the current view and decide again.',
          payload: { roots: [{ caseId: 'CASE_1', root: 'ROOT_1', status: 'running' }], gaps: ['acceptance'], nodes: [], actions: [] } },
        { agentId: TEST_AGENT_ID, boardRevision: 'r9', focusedRoots: [{ caseId: 'CASE_1', root: 'ROOT_1' }] },
      )
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'I will re-read the Board and decide again.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'ApplyBatch').length, 1,
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
    tool: (name) => {
      if (name !== 'ApplyBatch') return undefined
      served += 1
      if (served > 1) return undefined
      return { accepted: false, errorCode: 'precondition_not_met', teaching: 'not in force', payload: { roots: [], gaps: [], nodes: [], actions: [] } }
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'a', args: {} }] })
      if (round === 3) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F2', predicate: 'b', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  const batches = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
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
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'ApplyBatch'],
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
      : 'The Board refused it, so I will open a Case first.'),
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
      model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
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
      assert.doesNotMatch(text, /viewToken|boardRevision|focusedRoots/)
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
    model: (round) => (round === 1 || round === 3 ? callTool('OpenCase', {}) : 'Opened.'),
    timeoutMs: 12_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const opens = run.toolCalls.filter((call) => call.name === 'OpenCase')
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
      if (steps === 0) return callTool('OpenCase', {})
      if (steps === 1) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      return 'Recorded.'
    },
    timeoutMs: 15_000,
  })
  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const batches = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
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
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opened.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.includes('OpenCase'), true,
    'a Streamable HTTP server that answers with text/event-stream must not be unreachable')
  assert.match(run.stdout, /Case Context in focus/)
})

// ── The scenario the surface exists for ──────────────────────────────────────

test('open, batch, act, and close: the Board refuses an uncertified completion and accepts a certified one', async () => {
  const run = await runAgent({
    // The autopilot policy, because this is the scenario in which a dispatched Action
    // settles on the Board's own schedule rather than the host's.
    argv: ['investigate this and finish when the Board permits it'],
    env: { RULITH_MAX_ROUNDS: '8' },
    gateway: defaultGateway({ settleAfterBatch: false }),
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'scratch.demo.value', args: { n: 1 } }] })
      if (round === 3) return callTool('CloseCase', { disposition: 'completed' })
      if (round === 4) return callTool('ApplyAction', { action: 'compute_total', target: 'L1' })
      if (round === 5) return callTool('QueryBoard', { include: ['cases'] })
      if (round === 6) return callTool('CloseCase', { disposition: 'completed' })
      return 'The Case is closed.'
    },
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'ApplyBatch', 'CloseCase', 'ApplyAction', 'QueryBoard', 'CloseCase'])
  assert.match(JSON.stringify(run.modelRequests[3]), /case_not_certified/,
    'an uncertified completion was not refused with the Board teaching')
  // The dispatched Action was reported as pending with its invocation, not as done.
  assert.match(JSON.stringify(run.modelRequests[4]), /inv_1/)
  // Waiting is the model's own read, not a host poll loop.
  assert.match(run.stdout, /Closed Case .* with disposition "completed"/)
})

test('the Board decides completion: an uncertified Case is not closed by the host', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Use Rulith, but finish only if the Board permits it.'],
    gateway: defaultGateway({ settleAfterBatch: false }),
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
    chatLines: ['Good morning.'],
    model: () => 'Good morning. What would you like to work on?',
  })

  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'a plain conversational reply must return control to the user')
  assert.deepEqual(run.verbs, [], `a greeting unexpectedly touched the Board: ${run.verbs.join(', ')}`)
  assert.match(run.stdout, /What would you like to work on\?/)
  assert.doesNotMatch(run.stdout, /Case Context in focus|pending_case_id/)
})

test('a focused Case persists across messages and is never advanced implicitly', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Start a governed investigation.', 'Before the next step, explain what you know.'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round === 2) return 'The Case is open. I will wait for your next instruction.'
      return 'The same Case is still in focus; I took no further step.'
    },
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1,
    `a follow-up message opened another Case: ${run.verbs.join(', ')}`)
  assert.deepEqual(run.verbs, ['OpenCase'], 'the host advanced or re-read the Board during an ordinary conversational turn')
  const followUp = JSON.stringify(run.modelRequests[2])
  assert.match(followUp, /Cases in focus: CASE_1 \(root ROOT_1, running\)/,
    'the next conversational turn must receive the focus the authority reported')
  assert.match(followUp, /last observed \(not refreshed/,
    'a remembered view must be labelled as remembered, not presented as current')
})

test('an unscoped write is carried and refused by the authority, not guessed at by the host', async () => {
  const run = await runAgent({
    argv: [],
    chatLines: ['Record a fact.'],
    model: (round) => (round === 1
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] })
      : 'I will open a Case first.'),
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
            { name: 'OpenCase', input: {} },
            { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
          ],
        }
      : 'Both steps are recorded.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase', 'ApplyBatch'],
    `both calls of the turn must be carried, in order: ${run.verbs.join(', ')}`)
  // The proof that they were serial rather than concurrent: the write arrived at a Board
  // that already held the root the first call created.
  assert.deepEqual(arrivals, [{ name: 'OpenCase', focus: 0 }, { name: 'ApplyBatch', focus: 1 }],
    'the second call did not observe the first call\'s effect, so they were not serialised')
  const results = JSON.stringify(run.modelRequests[1])
  assert.doesNotMatch(results, /one_step_per_turn|call_queue_suspended/,
    'a call was declined by the host although nothing was unresolved')
  // Every tool_use must be answered, or the next Anthropic request is malformed.
  assert.match(results, /OpenCase/)
})

test('RT-SERIAL-2 an unresolved call suspends the rest of the turn instead of continuing it', async () => {
  // The queue stops at the first unknown outcome. What must not happen is the second call
  // going out anyway: with one call unresolved this Agent may send nothing at all, and a
  // write issued past that point could be the second half of a command that already ran.
  const run = await runAgent({
    argv: [], env: { RULITH_MAX_ROUNDS: '3', RULITH_RECOVERY_WAIT_MS: '1500' },
    chatLines: ['Do all three steps.'], captureLocalEvents: true,
    tool: (name) => (name === 'OpenCase' ? HOP_FAILURE : undefined),
    // Nothing is outstanding until the first call goes out; after it, the authority says
    // that call is still executing.
    recovery: ({ toolCalls }) => (toolCalls === 0
      ? { state: 'none' }
      : { state: 'waiting', callRef: 'call-1', tool: 'OpenCase', retryAfterMs: 250 }),
    model: () => ({
      text: '',
      toolCalls: [
        { name: 'OpenCase', input: {} },
        { name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', id: 'F1', predicate: 'x', args: {} }] } },
        { name: 'QueryBoard', input: {} },
      ],
    }),
    timeoutMs: 25_000,
  })
  assert.notEqual(run.code, 'timeout', `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase'],
    `calls were sent while an earlier one was unresolved: ${run.verbs.join(', ')}`)
  assert.equal(run.modelRequests.length, 1,
    'the model was asked again while a call was unresolved, so it could have proposed work that cannot be carried')
  const suspension = run.localEvents.find((event) => event.type === 'queue-suspended')
  assert.equal(suspension?.notSent, 2, 'the two unsent calls were not reported as unsent')
  assert.match(run.stdout, /were not sent/)
  assert.match(run.stdout, /still executing at the authority/)
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

test('the focus form of OpenCase is never turned into a mixed form by the host', async () => {
  // {caseId} focuses, {caseType, businessKey?} creates, and a mixed form is refused. A
  // host that stamped its pinned Case Type onto a focus request would manufacture the
  // rejected shape out of a legal one.
  const run = await runAgent({
    argv: ['--case-type', 'verified_calculation', '--business-key', '{"job_id":"calc-001"}'],
    chatLines: ['Continue the existing Case.'],
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_EXISTING', root: 'ROOT_EXISTING', status: 'running' }] }),
    model: (round) => (round === 1 ? callTool('OpenCase', { caseId: 'CASE_EXISTING' }) : 'Focused.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const opened = run.toolCalls.find((call) => call.name === 'OpenCase')
  assert.deepEqual(opened.args, { caseId: 'CASE_EXISTING' },
    `the host added creation fields to a focus request: ${JSON.stringify(opened.args)}`)
  assert.doesNotMatch(run.stdout, /Board rejected OpenCase/)
})

test('RT-GUESS-1 no prompt line is driven by a field the authority never published', async () => {
  // There used to be a second conditional line here, telling the model that Board
  // legislation was locked, keyed on a `lawLocked` field in the Board View. Core's published
  // Board View has no such field, so against the real authority the condition was
  // permanently false and the line was a guess wearing the shape of a rule. Whether
  // `add_axiom` is permitted is the Board's judgement and the Board refuses it plainly.
  //
  // The arm asserts the *absence* on both sides: a server that sends the invented field must
  // not resurrect the line, and the one surviving conditional must be driven by the Case Type
  // this host itself sent.
  const run = await runAgent({
    argv: ['--case-type', 'exploration'],
    chatLines: ['Use Rulith under the installed governance.'],
    tool: (name, args, board, session, meta) => {
      if (name !== 'OpenCase') return undefined
      const core = board.tool(name, args, session, meta)
      return withMeta({ ...core, payload: { ...core.payload, lawLocked: true } }, board.meta(session))
    },
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The Case is open.'),
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const beforeOpen = systemTextOf(run.modelRequests[0])
  const afterOpen = systemTextOf(run.modelRequests[1])
  assert.doesNotMatch(beforeOpen, /permitted inside this Case/,
    'the unscoped first turn exposed a provisional-law permission before any Case existed')
  assert.doesNotMatch(`${beforeOpen}\n${afterOpen}`, /Legislation is locked/,
    'an unpublished Board View field is driving a prompt line again')
  // A known Case Type still does not let the host decide the current writing permission.
  assert.match(afterOpen, /Case Type alone grants no rule-writing permission/)
  assert.doesNotMatch(afterOpen, /are permitted inside this Case|are Case-local/)
  assert.deepEqual(run.verbs, ['OpenCase'], 'the Board was probed for governance state')
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
      if (round === 1) return callTool('OpenCase', {})
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

test('opening exploration does not invent a permission grant or Case-local lifetime', async () => {
  const run = await runAgent({
    argv: ['--case-type', 'exploration'],
    chatLines: ['Explore this.'],
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Exploring.'),
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
  const opening = first.tools.find(tool => tool.function.name === 'OpenCase').function.parameters
  assert.deepEqual(Object.keys(opening.properties ?? {}).sort(), ['businessKey', 'caseId', 'caseType'],
    'object-only model interfaces need the top-level field catalogue for both OpenCase alternatives')
  const sourceOpening = advertisedTools().find(tool => tool.name === 'OpenCase').inputSchema
  assert.deepEqual(opening.oneOf, sourceOpening.oneOf, 'the creation/resume alternatives must retain their exact validation constraints')
  assert.equal(sourceOpening.properties, undefined, 'the source fixture must actually use the composite form')
  const query = first.tools.find(tool => tool.function.name === 'QueryBoard').function.parameters
  assert.equal(query.properties.selector.properties.roots.type, 'array')
  assert.equal(query.properties.selector.properties.roots.items.type, 'string')
  assert.equal(query.properties.selector.properties.roots.minItems, 1)
  assert.equal(query.properties.selector.properties.roots.maxItems, 1000)
  assert.equal(query.properties.selector.properties.roots.items.minLength, 1)
  const batch = first.tools.find(tool => tool.function.name === 'ApplyBatch').function.parameters
  assert.equal(batch.properties.operations.items.type, 'object')
  assert.ok(batch.properties.operations.items.properties.op.enum.includes('assert_fact'))
  const validator = new Ajv({ strict: false })
  const samples = {
    OpenCase: [{ caseType: 'verified_calculation', businessKey: { job_id: 'calc-001' } }, { caseId: 'case-1' }, {}, { caseType: 'verified_calculation', caseId: 'case-1' }],
    QueryBoard: [{}, { include: ['nodes'], selector: { roots: ['root-1'] } }, { include: ['nodes'] }, { include: ['nodes'], selector: { roots: [] } }, { include: ['nodes'], selector: { roots: [{}] } }],
    ApplyBatch: [{ operations: [{ op: 'assert_fact', predicate: 'subgoal_of', args: { child: 'CALC_calc-001', parent: 'root-1' } }] }, { operations: [{}] }, { operations: [{ op: 'unknown' }] }],
  }
  for (const [name, values] of Object.entries(samples)) {
    const original = validator.compile(advertisedTools().find(tool => tool.name === name).inputSchema)
    const adapted = validator.compile(first.tools.find(tool => tool.function.name === name).function.parameters)
    for (const value of values) assert.equal(adapted(value), original(value), `${name} changed accepted inputs: ${JSON.stringify(value)}`)
  }
  assert.equal(first.messages[0].role, 'system')
  const second = run.modelRequests[1]
  const assistant = second.messages.find((message) => message.role === 'assistant' && message.tool_calls)
  assert.equal(assistant.tool_calls[0].function.name, 'OpenCase')
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

test('a Case closed in the last conversational round is reported as completed', async () => {
  const run = await runAgent({ argv: [], env: { RULITH_MAX_ROUNDS: '3' }, captureLocalEvents: true,
    gateway: defaultGateway({ settleAfterBatch: true }), chatLines: ['Finish the Case.'],
    model: round => round === 1 ? callTool('OpenCase', {}) : round === 2
      ? callTool('ApplyBatch', { operations: [{ op: 'assert_fact', predicate: 'ready', args: {} }] })
      : callTool('CloseCase', { root: 'ROOT_1', disposition: 'completed' }),
  })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /The Board accepted closure and the Case is completed/)
  assert.doesNotMatch(run.stdout, /Stopped at the 3-round limit/)
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
  for (const tool of MODEL_TOOLS) assert.ok(system.includes(tool), `${tool} is missing from the emulated tool guide`)
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

for (const failure of [HOP_FAILURE, { accepted: false, errorCode: 'upstream_unavailable', teaching: 'The Board response was lost.' }]) {
test(`a ${failure === HOP_FAILURE ? 'transport' : 'gateway upstream'} failure the authority has no record of is an unreconciled conflict, not a retry`, async () => {
  // The old behaviour was to tell the model "retry the identical step, it keeps the same
  // request identity". That promise cannot be kept: the transport key includes the MCP
  // session, so a re-send under any later session is a *different* logical call, and a
  // write that already landed could land twice. When the authority then reports nothing
  // outstanding, the two views disagree — and an empty recovery record is a statement about
  // the Gateway's records, not about the world. So it stops and names the call.
  let attempts = 0
  const batch = { operations: [{ op: 'assert_fact', id: 'F_AMBIG', predicate: 'scratch.demo.value', args: { value: 'one' } }] }
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '5', RULITH_RECOVERY_WAIT_MS: '800' },
    chatLines: ['Record this despite a transient network failure.'],
    captureLocalEvents: true,
    tool: (name) => {
      if (name !== 'ApplyBatch') return undefined
      attempts += 1
      return attempts === 1 ? failure : undefined
    },
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
      if (round <= 3) return callTool('ApplyBatch', batch)
      return 'The retry landed.'
    },
    timeoutMs: 25_000,
  })

  const sent = run.toolCalls.filter((call) => call.name === 'ApplyBatch')
  assert.equal(sent.length, 1, `the unresolved write was sent again: ${JSON.stringify(run.verbs)}`)
  assert.equal(run.modelRequests.length, 2,
    'the model was asked again while a call of its own was unresolved and unreconciled')
  // The classification still travels — as the verdict a person and the local view can read.
  const verdict = run.localEvents.filter((event) => event.type === 'verdict' && event.cmd === 'ApplyBatch').at(-1)
  assert.equal(verdict.transportAmbiguous, true)
  assert.match(verdict.teaching, /outcome of this step is unknown/)
  assert.doesNotMatch(verdict.teaching, /Retry the identical step/,
    'transport uncertainty was reported as something the model may simply re-issue')
  assert.match(run.stdout, /Board outcome unknown for ApplyBatch/)
  // And the conflict is named, with the request, rather than resolved by guessing.
  assert.match(run.stdout, /holding a ApplyBatch call \(request /)
  assert.match(run.stdout, /does not prove the command had no effect/)
  assert.match(run.stdout, /will not re-send it under a new transport identity/)
  assert.ok(run.localEvents.some((event) => event.type === 'blocked' && event.reason === 'unreconciled'))
  assert.ok(run.localEvents.some((event) => event.type === 'case-state' && event.contact === 'unknown'),
    'after an ambiguous mutation, the inspector must not continue presenting an earlier observation as confirmed')
})
}

test('distinct submissions carry distinct request identities, and an answered one is not reused', async () => {
  // The other half of the retry ledger. An id that never got released would make every
  // repeated write share one identity, which is the same defect wearing the opposite sign.
  const run = await runAgent({
    argv: [],
    env: { RULITH_MAX_ROUNDS: '6' },
    chatLines: ['record two facts'],
    model: (round) => {
      if (round === 1) return callTool('OpenCase', {})
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

test('the Anthropic transcript alternates roles even when the host adds its own nudge', async () => {
  const run = await runAgent({
    argv: ['do the work'],
    provider: 'anthropic',
    env: { RULITH_MAX_ROUNDS: '4' },
    gateway: defaultGateway({ settleAfterBatch: false }),
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
      `two ${last[index].role} turns in a row: the host's nudge was appended without folding.\n${JSON.stringify(last.map((message) => message.role))}`)
  }
  // Calibration: the nudge really is in there, folded into the tool result turn.
  assert.match(JSON.stringify(last), /still running on the Board/)
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

test('--case brings a running Case into focus through the same public tool and still delivers the message', async () => {
  const run = await runAgent({
    argv: ['--case', 'CASE_RUNNING'],
    captureLocalEvents: true,
    chatLines: ['Continue our discussion without changing the Board.'],
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_RUNNING', root: 'ROOT_RUNNING', status: 'running' }] }),
    model: () => 'The existing Case is in focus. I have not taken another step.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.modelRequests.length, 1, 'focusing a running Case must not swallow the user message')
  assert.deepEqual(run.verbs, ['OpenCase'], 'a host lifecycle route survived beside the public tool')
  assert.deepEqual(run.toolCalls[0].args, { caseId: 'CASE_RUNNING' })
  assert.match(JSON.stringify(run.modelRequests[0]), /Cases in focus: CASE_RUNNING \(root ROOT_RUNNING, running\)/)
  assert.ok(run.localEvents.some((event) => event.type === 'case-state' && event.caseId === 'CASE_RUNNING' && event.caseStatus === 'running'))
})

test('--case resumes a paused Case, which the model has no separate verb to do', async () => {
  const run = await runAgent({
    argv: ['--case', 'CASE_PAUSED'],
    chatLines: ['Continue the paused work.'],
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_PAUSED', root: 'ROOT_PAUSED', status: 'paused' }] }),
    model: () => 'The paused Case is back.',
  })

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.deepEqual(run.verbs, ['OpenCase'], `a retired lifecycle operation was issued: ${run.verbs.join(', ')}`)
  assert.match(run.stdout, /Case "CASE_PAUSED" is in focus for this conversation \(acceptance root "ROOT_PAUSED", running\)/)
})

test('--case on a Case the authority refuses says so and does not claim the Case is active', async () => {
  const run = await runAgent({
    argv: ['--case', 'CASE_GONE'],
    captureLocalEvents: true,
    chatLines: ['Continue that work.'],
    model: () => 'That Case is not available, so I answered normally.',
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /could not be brought into focus/)
  assert.match(JSON.stringify(run.modelRequests[0]), /do not claim that Case is active/)
  assert.equal(run.localEvents.some((event) => event.type === 'case-state'), false,
    'a refused focus must not create a Local lifecycle observation')
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
          ? { content: 'A partial answer', tool_calls: [{ id: 'partial', type: 'function', function: { name: 'OpenCase', arguments: '{"title":"must not run"}' } }] }
          : { content: null, reasoning_content: 'Reasoning alone is not a response.' } }] }
        : { stop_reason: truncated ? 'max_tokens' : 'end_turn', content: truncated
          ? [{ type: 'text', text: 'A partial answer' }, { type: 'tool_use', id: 'partial', name: 'OpenCase', input: { title: 'must not run' } }]
          : [{ type: 'thinking', thinking: 'Reasoning alone is not a response.' }] }
      const run = await runAgent({
        argv: ['--serve'], provider,
        env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'provider-response-test' },
        serveTasks: ['first turn', 'continue'], waitForServeCompletion: true,
        model: n => n === 1 ? { status: 200, body } : 'The next turn works.',
        timeoutMs: 6000,
      })
      assert.equal(run.modelRequests.length, 2, 'there must be no automatic paid retry')
      assert.equal(run.verbs.includes('OpenCase'), false, 'a truncated tool call must never execute')
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
    model: n => n === 1 ? callTool('OpenCase', {}) : n === 2 ? '' : 'The conversation continued.' })
  assert.equal(run.code, 0, run.stderr)
  assert.match(run.stdout, /no answer or tool call/)
  assert.match(run.stdout, /The conversation continued/)
  assert.equal(run.verbs.filter(verb => verb === 'OpenCase').length, 1)
  assert.match(JSON.stringify(run.modelRequests.at(-1)), /CASE_1/)
})

test('one-shot reports a recoverable model failure with its open Case', async () => {
  const run = await runAgent({ argv: ['Open a Case.'], captureLocalEvents: true,
    model: n => n === 1 ? callTool('OpenCase', {}) : '' })
  assert.equal(run.code, 1)
  const end = run.localEvents.find(event => event.type === 'end')
  assert.equal(end.outcome, 'model-error')
  assert.equal(end.pendingCaseId, 'CASE_1')
  assert.match(run.stdout, /Resume with --case CASE_1/)
})

test('an empty shadow review is unavailable and preserves the Case report', async () => {
  const run = await runAgent({ argv: ['Open a Case.', '--shadow'], captureLocalEvents: true,
    env: { RULITH_MODEL_THINKING: 'disabled' },
    model: (n, request) => systemTextOf(request).includes('adversarial shadow reviewer') ? ''
      : n === 1 ? callTool('OpenCase', {}) : 'Waiting for more information.' })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.equal(run.localEvents.find(event => event.type === 'end').pendingCaseId, 'CASE_1')
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

test('--serve records a recoverable Case id before reclaiming an abandoned conversation slot', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'slot-capacity-test', RULITH_SERVE_SLOTS_MAX: '1' },
    serveTasks: [
      { text: 'Open a governed Case.', sessionKey: 'client-a' },
      { text: 'Start an unrelated conversation.', sessionKey: 'client-b' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The Case remains active.'),
    timeoutMs: 8000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  assert.equal(run.verbs.filter((verb) => verb === 'OpenCase').length, 1)
  const detached = (run.serveSnapshot?.runs ?? []).find((record) => record.sessionKey === 'client-a' && record.pendingCaseId)
  assert.ok(detached, `the reclaimed Case was not exposed for explicit recovery: ${JSON.stringify(run.serveSnapshot)}`)
  assert.match(detached.note, /remains unchanged on the Board/)
  const localEvents = run.localEvents.filter((event) => (event.session || event.sessionKey) === 'client-a').map((event) => ({ ...event, src: 'agent' }))
  assert.ok(localEvents.some((event) => event.type === 'case-state'), 'the --serve publisher feeds the real Local inspector')
  assert.equal(localEvents.some((event) => event.type === 'case-pending'), false, 'normal Local --serve is not the one-shot pending path')
  const displayed = projectCaseRoots(localEvents)
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0].lifecycle, 'running', 'a reclaimed local conversation is not a Case transition')
  assert.equal(displayed[0].observation, 'Detached · last observed')
})

test('an explicit caseId adds a root to a conversation rather than replacing the one it has', async () => {
  const port = await freePort()
  const run = await runAgent({
    argv: ['--serve'],
    captureLocalEvents: true,
    env: { RULITH_SERVE_PORT: String(port), RULITH_SERVE_KEY: 'case-focus-test' },
    gateway: defaultGateway({ cases: [{ caseId: 'CASE_OTHER', root: 'ROOT_OTHER', status: 'running' }] }),
    serveTasks: [
      { text: 'Open this conversation Case.', sessionKey: 'client-a' },
      { text: 'Continue here, with the other Case too.', sessionKey: 'client-a', caseId: 'CASE_OTHER' },
    ],
    waitForServeCompletion: true,
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Both roots are in focus.'),
    timeoutMs: 8000,
  })

  assert.deepEqual(run.serveStatuses, [202, 202], `${run.stdout}\n${run.stderr}`)
  const focus = run.localEvents.filter((event) => event.type === 'focus' && event.session === 'client-a').at(-1)
  assert.deepEqual(focus.roots.map((row) => row.caseId).sort(), ['CASE_1', 'CASE_OTHER'],
    'the existing root was silently replaced instead of joined')
})

test('conversation mode emits Board verdicts and per-root observations for Local', async () => {
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
  const observations = run.localEvents.filter((event) => event.type === 'case-state')
  assert.ok(observations.length > 0, 'the actual Agent publisher must emit lifecycle observations')
  assert.ok(observations.every((event) => !Object.hasOwn(event, 'revision')), 'Local observations do not carry protocol cursors')
  for (let index = 1; index < observations.length; index += 1) {
    const value = ({ caseId, root, caseStatus, gaps, contact }) => ({ caseId, root, caseStatus, gaps, contact })
    assert.notDeepEqual(value(observations[index]), value(observations[index - 1]), 'unchanged observations are not repeated per tool call')
  }
})

test('a refused OpenCase never creates a conversation focus binding', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Try to open a Case.'], captureLocalEvents: true,
    tool: (name) => (name === 'OpenCase'
      ? withMeta(
          { accepted: false, errorCode: 'case_admission_refused', teaching: 'Opening was refused.',
            payload: { roots: [], cases: { directory: [{ caseId: 'CASE_NOT_OPENED', root: 'ROOT_X', status: 'running' }], total: 1 }, gaps: [], nodes: [], actions: [] } },
          { agentId: TEST_AGENT_ID, focusedRoots: [] },
        )
      : undefined),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'Opening was refused.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(run.localEvents.some((event) => event.type === 'case-state'), false,
    'a Case named in the directory but not in focus must not become this conversation\'s Case')
  assert.equal(run.localEvents.some((event) => event.type === 'case-open'), false)
})

test('a focused root the Board View never described is unavailable, never invented as running', async () => {
  const run = await runAgent({
    argv: [], chatLines: ['Open a Case.'], captureLocalEvents: true,
    tool: (name) => (name === 'OpenCase'
      ? withMeta(
          { accepted: true, revision: 'r1', payload: { roots: [], cases: { directory: [], total: 0 }, gaps: [], nodes: [], actions: [] } },
          { agentId: TEST_AGENT_ID, focusedRoots: [{ caseId: 'CASE_Q', root: 'ROOT_Q' }] },
        )
      : undefined),
    model: (round) => (round === 1 ? callTool('OpenCase', {}) : 'The lifecycle status was not returned.'),
  })
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  const observations = run.localEvents.filter((event) => event.type === 'case-state')
  assert.equal(observations.length, 1)
  assert.equal(observations[0].caseStatus, 'unavailable')
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
  const ref = 'art_' + 'a'.repeat(32)
  const gateway = defaultGateway({
    cases: Array.from({ length: 90 }, (_, index) => ({ caseId: `ARCHIVED_${index}`, root: `ROOT_${index}`, status: 'closed' })),
    artifacts: { [ref]: { text: 'immutable document marker for authoring' } },
  })
  let queries = 0
  const originalTool = gateway.tool.bind(gateway)
  gateway.tool = (name, args, session) => {
    const answer = originalTool(name, args, session)
    if (name === 'QueryBoard') {
      queries += 1
      if (queries % 3 === 0) return { ...answer, accepted: false, errorCode: 'query_refused_for_fixture', teaching: 'The Board refused this query.' }
      return { ...answer, observationReceipt: `UNIQUE_RECEIPT_${queries}` }
    }
    return answer
  }
  const run = await runAgent({
    argv: [], chatLines: ['Read the attached material and inspect the Board.'],
    gateway, captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '12' },
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
  for (const query of [1, 2, 4, 5, 7, 8]) assert.match(transcript, new RegExp(`UNIQUE_RECEIPT_${query}`),
    'identical snapshots lost their distinct non-view metadata')
  assert.equal((transcript.match(/ARCHIVED_89/g) ?? []).length, 4,
    'all three refused snapshots and the latest accepted snapshot must remain complete')
  assert.match(transcript, /identicalToToolCall/)
  assert.ok(run.localEvents.some((event) => event.type === 'model-usage'
    && event.compactedViews > 0 && event.compactedTranscriptBytes > 0))
})

test('context compression retains distinct Board observations and partial or refused snapshots', async () => {
  let queries = 0
  const cases = Array.from({ length: 350 }, (_, index) => ({ caseId: `C_${index}`, root: `R_${index}`, status: 'closed' }))
  const run = await runAgent({
    argv: [], chatLines: ['Compare these observations without dropping their evidence.'], captureLocalEvents: true, env: { RULITH_MAX_ROUNDS: '6' },
    tool: name => {
      if (name !== 'QueryBoard') return undefined
      queries += 1
      const marker = ['FIRST_SCOPE_ONLY', 'PARTIAL_SCOPE_ONLY', 'REFUSED_SCOPE_ONLY', 'LAST_SCOPE_ONLY'][queries - 1]
      return { accepted: queries !== 3, ...(queries === 3 ? { errorCode: 'refused_but_retained', teaching: 'Use the earlier complete result.' } : {}),
        payload: { cases: { directory: [{ caseId: marker, root: marker, status: 'closed' }, ...cases], total: cases.length + 1, truncated: queries === 2 },
          roots: [], gaps: [], nodes: [], actions: [] } }
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
