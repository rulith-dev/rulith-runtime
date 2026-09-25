// SPDX-License-Identifier: Apache-2.0
/**
 * What Local shows about Cases, and what it refuses to infer.
 *
 * A conversation holds a set of acceptance roots with independent lifecycles, so the
 * projection is a list, not one active Case. Every arm here is about the same defect
 * family: local display state — a task finishing, a slot being reclaimed, a root leaving
 * focus — quietly rewriting a lifecycle only the Board can report.
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import * as ui from '../local/local-ui.mjs'

function activityReducer() {
  const lines = ui.localPage.split('\n')
  const identify = lines.find((line) => line.startsWith('const caseOf='))
  const remember = lines.find((line) => line.startsWith('function remember('))
  assert.ok(identify && remember, 'the shipped activity reducer must be readable')
  const state = { cases: new Map() }
  const context = vm.createContext({ state })
  vm.runInContext(`${identify}\n${remember}`, context)
  return { state, send(event) { context.event = event; vm.runInContext('remember(event)', context) } }
}

test('a pending event from one-shot mode never invents a paused Case, even after task-done', () => {
  const page = activityReducer()
  page.send({ src: 'agent', type: 'case-open', session: 'conversation', caseId: 'CASE_1', ok: true })
  page.send({ src: 'agent', type: 'case-pending', session: 'conversation', caseId: 'CASE_1', note: 'Stopped at the round limit.' })
  page.send({ src: 'agent', type: 'task-done', session: 'conversation', activeCaseId: 'CASE_1' })
  const row = page.state.cases.get('conversation')
  assert.equal(row.caseId, 'CASE_1')
  assert.equal(row.status, 'Waiting')
  assert.notEqual(row.status, 'Paused')
})

test('the reducer defensively ignores a rejected case-open display event', () => {
  const page = activityReducer()
  page.send({ src: 'agent', type: 'case-open', session: 'conversation', caseId: 'rejected-case', ok: false })
  assert.equal(page.state.cases.get('conversation').caseId, '')
})

test('a new message does not reactivate a detached Case in the sidebar', () => {
  const page = activityReducer()
  for (const event of [
    { type: 'case-open', caseId: 'CASE_1', ok: true },
    { type: 'session-detached', caseId: 'CASE_1' },
    { type: 'task-start', text: 'hello again' },
    { type: 'task-done', activeCaseId: null },
  ]) page.send({ src: 'agent', session: 'conversation', ...event })
  assert.equal(page.state.cases.get('conversation').status, 'Detached')
})

test('task completion cannot overwrite a lifecycle observation in the sidebar', () => {
  for (const [caseStatus, expected] of [['paused', 'Case paused'], ['unavailable', 'Case state unavailable']]) {
    const page = activityReducer()
    page.send({ src: 'agent', session: 'conversation', type: 'case-state', caseId: 'CASE_1', caseStatus })
    page.send({ src: 'agent', session: 'conversation', type: 'task-done', activeCaseId: 'CASE_1' })
    assert.equal(page.state.cases.get('conversation').status, expected)
  }
})

test('a focus statement does not overwrite the lifecycle the Board reported', () => {
  // The Agent emits per-root observations and then the focus set. Reading focus as a
  // status would relabel a paused root as active on every tool call.
  const page = activityReducer()
  page.send({ src: 'agent', session: 'conversation', type: 'case-state', caseId: 'CASE_1', caseStatus: 'paused' })
  page.send({ src: 'agent', session: 'conversation', type: 'focus', roots: [{ caseId: 'CASE_1', root: 'ROOT_1', status: 'paused' }] })
  assert.equal(page.state.cases.get('conversation').status, 'Case paused')
  assert.equal(page.state.cases.get('conversation').roots, 1)
})

test('an empty focus set releases the conversation without claiming a Case transition', () => {
  const page = activityReducer()
  page.send({ src: 'agent', session: 'conversation', type: 'case-open', caseId: 'CASE_1', ok: true })
  page.send({ src: 'agent', session: 'conversation', type: 'case-unfocused', caseId: 'CASE_1' })
  page.send({ src: 'agent', session: 'conversation', type: 'focus', roots: [] })
  const row = page.state.cases.get('conversation')
  assert.equal(row.caseId, '')
  assert.equal(row.status, 'Ready')
})

test('the inspector uses only explicit Agent observations of Case lifecycle', () => {
  const pending = { src: 'agent', type: 'case-pending', session: 'conversation', caseId: 'CASE_1' }
  assert.equal(ui.projectCaseRoots([pending])[0].lifecycle, 'unavailable')
  const running = { src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'running' }
  assert.equal(ui.projectCaseRoots([running, pending])[0].lifecycle, 'running')
  const paused = { ...running, caseStatus: 'paused' }
  assert.equal(ui.projectCaseRoots([running, pending, paused])[0].lifecycle, 'paused')
  // A Worker event is not an Agent observation of a Case.
  assert.equal(ui.projectCaseRoots([running, { ...paused, src: 'worker' }])[0].lifecycle, 'running')
  assert.equal(ui.projectCaseRoots([running, { ...running, caseStatus: 'closed' }])[0].label, 'Closed')
  // The authority's lifecycle set is running / paused / closed. Anything else is neither
  // labelled nor guessed at — including the words the retired per-Case model used.
  for (const invented of ['invented', 'open', 'archived']) {
    assert.equal(ui.projectCaseRoots([{ ...running, caseStatus: invented }])[0].label, 'Unavailable',
      `${invented} is not a lifecycle this authority reports and must not be displayed as one`)
  }
  // A second Case with no observation of its own is unavailable, not the first one's state.
  const two = ui.projectCaseRoots([running, { src: 'agent', type: 'case-open', caseId: 'CASE_2', ok: true }])
  assert.deepEqual(two.map((row) => [row.caseId, row.label]), [['CASE_1', 'Running'], ['CASE_2', 'Unavailable']])
})

test('the inspector reports several roots with independent lifecycles', () => {
  const rows = ui.projectCaseRoots([
    { src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'running', gaps: 2 },
    { src: 'agent', type: 'case-state', caseId: 'CASE_2', root: 'ROOT_2', caseStatus: 'paused' },
    { src: 'agent', type: 'focus', roots: [{ caseId: 'CASE_1', root: 'ROOT_1' }, { caseId: 'CASE_2', root: 'ROOT_2' }] },
  ])
  assert.deepEqual(rows.map((row) => [row.caseId, row.root, row.label, row.gaps, row.focused]), [
    ['CASE_1', 'ROOT_1', 'Running', 2, true],
    ['CASE_2', 'ROOT_2', 'Paused', null, true],
  ])
})

test('a root released from focus keeps its last observed lifecycle and is marked released', () => {
  const rows = ui.projectCaseRoots([
    { src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'closed' },
    { src: 'agent', type: 'case-state', caseId: 'CASE_2', root: 'ROOT_2', caseStatus: 'running' },
    { src: 'agent', type: 'focus', roots: [{ caseId: 'CASE_2', root: 'ROOT_2' }] },
  ])
  assert.deepEqual(rows.map((row) => [row.caseId, row.label, row.focused]), [
    ['CASE_2', 'Running', true],
    ['CASE_1', 'Closed', false],
  ])
})

test('the shipped inspector separates lifecycle, focus and detached observations', () => {
  const start = ui.localPage.indexOf('function projectCaseRoots(')
  const end = ui.localPage.indexOf('const K=', start)
  assert.ok(start >= 0 && end > start)
  const elements = new Map(['casecount', 'roots', 'recovery', 'frontier', 'workers'].map((id) => [id, { textContent: '', innerHTML: '' }]))
  const context = vm.createContext({ state: {}, $: (id) => elements.get(id), esc: String, timeOf: () => '', eventBody: () => '' })
  vm.runInContext(ui.localPage.slice(start, end), context)
  const recoveryActions = ui.localPage.slice(ui.localPage.indexOf('function recoveryActions('), ui.localPage.indexOf('/* What a person', ui.localPage.indexOf('function recoveryActions(')))
  vm.runInContext(recoveryActions, context)
  const renderer = ui.localPage.split('\n').find((line) => line.startsWith('function renderInspector('))
  assert.ok(renderer)
  vm.runInContext(renderer, context)

  const actual = vm.runInContext("projectCaseRoots([{src:'agent',type:'case-pending',caseId:'CASE_1'}])", context)
  assert.equal(actual[0].lifecycle, 'unavailable')

  context.events = [{ src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'closed' }]
  vm.runInContext('renderInspector(events)', context)
  assert.equal(elements.get('casecount').textContent, '1 in focus')
  assert.match(elements.get('roots').innerHTML, /CASE_1 — Closed/)

  context.events = [
    { src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'running' },
    { src: 'agent', type: 'session-detached', caseId: 'CASE_1' },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('roots').innerHTML, /CASE_1 — Running/, 'detachment is not a Case transition')
  assert.match(elements.get('roots').innerHTML, /Detached · last observed/)

  context.events = [
    { src: 'agent', type: 'case-state', caseId: 'CASE_1', root: 'ROOT_1', caseStatus: 'running', gaps: 3 },
    { src: 'agent', type: 'case-state', caseId: 'CASE_2', root: 'ROOT_2', caseStatus: 'paused' },
    { src: 'agent', type: 'focus', roots: [{ caseId: 'CASE_2', root: 'ROOT_2' }] },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.equal(elements.get('casecount').textContent, '1 in focus · 1 released')
  assert.match(elements.get('roots').innerHTML, /CASE_2 — Paused/)
  assert.match(elements.get('roots').innerHTML, /CASE_1 — Running.*3 open gap\(s\).*released from focus/)

  // An unresolved call is neither an error nor idleness, and the panel says which it is.
  // Shown as idle, a person concludes the Runtime is stuck or that nothing was dispatched.
  assert.match(elements.get('recovery').innerHTML, /No unresolved call/)
  context.events = [{ src: 'agent', type: 'pending-inherited', tool: 'ApplyAction' }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('recovery').innerHTML, /Earlier ApplyAction outcome is unknown/)
  assert.match(elements.get('recovery').innerHTML, /current server state has not been checked/)
  context.events = [{ src: 'agent', type: 'recovery', state: 'waiting', tool: 'ApplyAction', callRef: 'call-9' }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('recovery').innerHTML, /Waiting for an earlier ApplyAction call/)
  assert.match(elements.get('recovery').innerHTML,
    /A new user message may request an independent Board observation when the server supports it/)
  assert.match(elements.get('recovery').innerHTML, /earlier call remains pending/)

  context.events = [
    { src: 'agent', type: 'recovery', state: 'reconciliation_required', tool: 'ApplyAction' },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('recovery').innerHTML, /needs operator reconciliation/)
  assert.match(elements.get('recovery').innerHTML, /cannot settle the earlier effect/)

  context.events = [
    { src: 'agent', type: 'recovery', state: 'result_ready', tool: 'ApplyBatch' },
    { src: 'agent', type: 'operation-read', tool: 'ApplyBatch', callRef: 'call-1' },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('recovery').innerHTML, /No unresolved call/)
  assert.match(elements.get('recovery').innerHTML, /read for the model, which decides again/)

  context.events = [
    { src: 'agent', type: 'recovery', state: 'result_ready', tool: 'ReadArtifact' },
    { src: 'agent', type: 'operation-read', state: 'unavailable', tool: 'ReadArtifact' },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('recovery').innerHTML, /Earlier ReadArtifact content is unavailable/)
  assert.match(elements.get('recovery').innerHTML, /No original result was supplied/)
})
