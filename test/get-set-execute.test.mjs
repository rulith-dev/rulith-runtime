// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The Agent is a standalone executable. Read its real boundary functions without starting
// its CLI or opening a model connection; integration coverage remains in the Agent harness.
const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing Agent boundary: ${start}`)
  return source.slice(from, to)
}
const api = new Function(`
  ${between('const RULITH_CONTRACT_SOURCE_COMMIT', '// ── END GENERATED CONTRACT PROJECTION')}
  ${between('const MODEL_TOOLS =', '/**\n * Fields the model never sends')}
  ${between('const RETIRED_V4_TOOL_NAMES', '/**\n * Project the advertised schema')}
  ${between('function toolMembershipConflicts', 'async function requirePublicMcpSurface')}
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const viewIsTruncated = view => view.truncated === true
  const Buffer = globalThis.Buffer
  ${between('const REPLAY_TOOL_NAMES', '/** Shorten only repeated')}
  ${between('function requestEntries', 'function renderMessages')}
  ${between('function renderMessages', '/**\n * Fold adjacent')}
  ${between('function looksAuthoritative', '/**\n * The authority\'s answer')}
  return { toolMembershipConflicts, artifactRead, boardRead, boardCall, operationCall,
    looksAuthoritative, replayEntries, replayOperation, replayToolName, renderMessages, requestEntries }
`)()

const current = ['Get', 'Set', 'Execute']
test('D-1012g accepts exactly three public tools and refuses missing, duplicate and extra tools', () => {
  const conflicts = names => api.toolMembershipConflicts(names.map(name => ({ name }))).conflicts
  assert.deepEqual(conflicts(current), [])
  for (const missing of current) assert.match(conflicts(current.filter(name => name !== missing)).join('; '),
    new RegExp(`does not advertise ${missing}`))
  assert.match(conflicts([...current, 'Get']).join('; '), /Get more than once/)
  assert.match(conflicts([...current, '']).join('; '), /tool without a name/)
  assert.match(conflicts([...current, 'ReadOperation']).join('; '), /not part of the approved surface/)
  for (const old of ['QueryBoard', 'ApplyBatch', 'ApplyAction', 'ReadArtifact']) {
    assert.match(conflicts([...current, old]).join('; '), new RegExp(`still advertises ${old}`))
  }
  const old = conflicts(['QueryBoard', 'ApplyBatch', 'ApplyAction', 'ReadArtifact']).join('; ')
  assert.match(old, /does not advertise Get, Set, Execute/)
  assert.match(old, /has not been cut over to Get, Set and Execute/)
})

test('D-1012g Get with artifact is a held data read; Board Get is an independent observation', () => {
  const artifact = { artifact: { ref: 'art-returned', offset: 8 } }
  assert.equal(api.artifactRead('Get', artifact), true)
  assert.equal(api.boardRead('Get', artifact), false)
  assert.equal(api.boardCall('Get', artifact), false)
  assert.equal(api.operationCall('Get', artifact), true)
  assert.equal(api.boardRead('Get', {}), true)
  assert.equal(api.boardCall('Get', {}), true)
  assert.equal(api.operationCall('Get', {}), false)
  for (const name of ['Set', 'Execute']) {
    assert.equal(api.boardCall(name, {}), true)
    assert.equal(api.operationCall(name, {}), true)
  }
  assert.equal(api.looksAuthoritative('Get', { accepted: true }, artifact), false,
    'an Artifact success without a data reference must not be treated as a Board verdict')
  assert.equal(api.looksAuthoritative('Get', { accepted: true, result: { ref: 'art-returned' } }, artifact), true)
  assert.equal(api.looksAuthoritative('Get', { accepted: true }, {}), true)
})

const retained = () => [{ role: 'user', text: 'Please discuss QueryBoard and ReadArtifact.' }, {
  role: 'assistant', text: 'ApplyAction is the name in this quoted document.', reasoningContent: 'opaque continuation',
  toolCalls: [
    { id: 'q', name: 'QueryBoard', input: { include: ['history'] } },
    { id: 's', name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', predicate: 'ApplyBatch', args: { name: 'QueryBoard' } }] } },
    { id: 'e', name: 'ApplyAction', input: { action: 'ReadArtifact', args: { name: 'ApplyAction' } } },
    { id: 'a', name: 'ReadArtifact', input: { ref: 'ReadArtifact', offset: 8, maxBytes: 64 } },
    { id: 'a0', name: 'ReadArtifact', input: { ref: 'art-start' } },
  ],
}, { role: 'tool_results', results: [{ id: 'a', name: 'ReadArtifact', text: JSON.stringify({ accepted: true,
  result: { ref: 'ReadArtifact', data: 'QueryBoard ApplyBatch ApplyAction ReadArtifact', nextOffset: 16 },
  operations: [{ tool: 'ApplyAction', label: 'ApplyAction QueryBoard', state: 'done',
    result: { content: [{ type: 'text', text: JSON.stringify({ tool: 'ApplyAction', accepted: false,
      teaching: 'No Action has this name; use a name from QueryBoard. No work was dispatched.' }) }], isError: true } },
  { tool: 'ReadArtifact', label: 'ReadArtifact art-start', summary: 'data read; a new ReadArtifact reads it again' }] }) }] }]

for (const style of ['openai', 'anthropic', 'emulated']) {
  test(`D-1012g maps retained calls and result headings on ${style} replay without mutating history or data`, () => {
    const entries = retained(), before = JSON.stringify(entries)
    const replayed = api.replayEntries(entries)
    assert.equal(JSON.stringify(entries), before)
    assert.deepEqual(replayed[1].toolCalls.map(call => call.name), ['Get', 'Set', 'Execute', 'Get', 'Get'])
    assert.deepEqual(replayed[1].toolCalls[3].input, { artifact: { ref: 'ReadArtifact', offset: 8 } })
    assert.deepEqual(replayed[1].toolCalls[4].input, { artifact: { ref: 'art-start' } })
    assert.deepEqual(replayed[1].toolCalls[2].input, entries[1].toolCalls[2].input)
    assert.equal(replayed[0].text, entries[0].text)
    assert.equal(replayed[1].text, entries[1].text)
    const result = JSON.parse(replayed[2].results[0].text)
    assert.equal(result.operations[0].tool, 'Execute')
    assert.equal(result.operations[0].label, 'Execute QueryBoard', 'the Action name is business data')
    assert.equal(result.operations[1].label, 'Get artifact art-start')
    assert.equal(result.operations[1].summary, 'data read; a new Get with artifact reads it again')
    const receipt = JSON.parse(result.operations[0].result.content[0].text)
    assert.equal(receipt.tool, 'Execute')
    assert.equal(receipt.teaching, 'No Action has this name; use a name from Get. No work was dispatched.')
    assert.deepEqual(result.result, JSON.parse(entries[2].results[0].text).result)
    const wire = api.renderMessages(replayed, style)
    if (style === 'openai') assert.deepEqual(wire[1].tool_calls.map(call => call.function.name), ['Get', 'Set', 'Execute', 'Get', 'Get'])
    if (style === 'anthropic') assert.deepEqual(wire[1].content.filter(item => item.type === 'tool_use').map(item => item.name), ['Get', 'Set', 'Execute', 'Get', 'Get'])
    if (style === 'emulated') {
      assert.match(wire[2].content, /^\[Get result\]/)
      assert.match(wire[1].content, /"tool":"Get","input":\{"artifact":/)
    }
  })
}

test('D-1012g maps restored unread identities, preserves unknown names and keeps unchanged result bytes', () => {
  const old = { tool: 'ApplyBatch', label: 'ApplyBatch end_goal GOAL_1', at: '2026-10-12T00:00:00Z' }
  assert.deepEqual(api.replayOperation(old), { ...old, tool: 'Set', label: 'Set end_goal GOAL_1' })
  assert.equal(old.tool, 'ApplyBatch')
  assert.equal(api.replayToolName('toString'), 'toString')
  const text = '{ "accepted": true, "result": {"data": "QueryBoard"} }'
  assert.equal(api.replayEntries([{ role: 'tool_results', results: [{ name: 'Get', text }] }])[0].results[0].text, text)
  const business = { reason: 'Action QueryBoard failed; data mentions ApplyBatch and ReadArtifact.',
    tool: 'Execute', label: 'Execute QueryBoard' }
  assert.deepEqual(api.replayOperation(business), business)
})

test('D-1012g compacts repeated Board Get views while retaining every Artifact result', () => {
  const view = { goals: [], padding: 'x'.repeat(40_000) }
  const snapshot = JSON.stringify({ accepted: true, view })
  const entries = [{ role: 'assistant', text: '', toolCalls: [
    { id: 'q1', name: 'QueryBoard', input: {} }, { id: 'q2', name: 'Get', input: {} },
    { id: 'a', name: 'ReadArtifact', input: { ref: 'art-returned' } },
  ] }, { role: 'tool_results', results: [
    { id: 'q1', name: 'QueryBoard', text: snapshot }, { id: 'q2', name: 'Get', text: snapshot },
    { id: 'a', name: 'ReadArtifact', text: snapshot },
  ] }]
  const before = JSON.stringify(entries)
  const prepared = api.requestEntries(entries)
  assert.equal(prepared.compactedViews, 1)
  assert.match(JSON.parse(prepared.entries[1].results[0].text).earlierBoardView.note, /identical Get snapshot/)
  assert.equal(prepared.entries[1].results[1].text, snapshot)
  assert.equal(prepared.entries[1].results[2].text, snapshot, 'an Artifact result was compacted as a Board snapshot')
  assert.equal(JSON.stringify(entries), before)
})

for (const [boardName, artifactName] of [['Get', 'Get'], ['QueryBoard', 'ReadArtifact']]) {
  test(`D-1012g compaction distinguishes reused call IDs across ${boardName}/${artifactName} rounds`, () => {
    const snapshot = JSON.stringify({ accepted: true, view: { goals: [], padding: 'x'.repeat(40_000) } })
    const entries = [true, false, true, false, false].flatMap(artifact => {
      const name = artifact ? artifactName : boardName
      const input = !artifact ? {} : artifactName === 'ReadArtifact'
        ? { ref: 'art-returned' } : { artifact: { ref: 'art-returned' } }
      return [{ role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name, input }] },
        { role: 'tool_results', results: [{ id: 'call_1', name, text: snapshot }] }]
    })
    const before = JSON.stringify(entries)
    const prepared = api.requestEntries(entries)
    assert.equal(prepared.compactedViews, 2, 'Artifact calls excluded later Board reads with the same ID')
    assert.ok(prepared.compactedTranscriptBytes > 0)
    for (const index of [1, 5, 9]) assert.equal(prepared.entries[index].results[0].text, snapshot,
      'Artifact evidence or the latest Board snapshot was shortened')
    for (const index of [3, 7]) {
      const result = JSON.parse(prepared.entries[index].results[0].text)
      assert.equal(result.view, undefined)
      assert.equal(result.earlierBoardView.identicalToToolCall, 'call_1')
    }
    assert.equal(JSON.stringify(entries), before, 'request preparation mutated stored history')
  })
}
