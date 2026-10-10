// SPDX-License-Identifier: Apache-2.0
/**
 * What Local shows about goals (the Cases Console names), and what it refuses to infer.
 *
 * A conversation holds a set of top-level goals with independent lifecycles, so the
 * projection is a list, not one active Case. Every arm here is about the same defect
 * family: local display state — a task finishing, a slot being reclaimed, a goal leaving
 * focus — quietly rewriting a lifecycle only the Board can report. Under rulith/v4 the
 * Agent's events carry goal IDs (a top-level goal's ID is its contract's root) and the goal
 * directory's lifecycle words: running, paused, completed, ended.
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
  page.send({ src: 'agent', type: 'case-open', session: 'conversation', goal: 'GOAL_1', ok: true })
  page.send({ src: 'agent', type: 'case-pending', session: 'conversation', goal: 'GOAL_1', note: 'Stopped at the round limit.' })
  page.send({ src: 'agent', type: 'task-done', session: 'conversation', activeGoal: 'GOAL_1' })
  const row = page.state.cases.get('conversation')
  assert.equal(row.goal, 'GOAL_1')
  assert.equal(row.status, 'Waiting')
  assert.notEqual(row.status, 'Paused')
})

test('the reducer defensively ignores a rejected case-open display event', () => {
  const page = activityReducer()
  page.send({ src: 'agent', type: 'case-open', session: 'conversation', goal: 'rejected-goal', ok: false })
  assert.equal(page.state.cases.get('conversation').goal, '')
})

test('a new message does not reactivate a detached Case in the sidebar', () => {
  const page = activityReducer()
  for (const event of [
    { type: 'case-open', goal: 'GOAL_1', ok: true },
    { type: 'session-detached', goal: 'GOAL_1' },
    { type: 'task-start', text: 'hello again' },
    { type: 'task-done', activeGoal: null },
  ]) page.send({ src: 'agent', session: 'conversation', ...event })
  assert.equal(page.state.cases.get('conversation').status, 'Detached')
})

test('task completion cannot overwrite a lifecycle observation in the sidebar', () => {
  for (const [status, expected] of [['paused', 'Case paused'], ['unavailable', 'Case state unavailable']]) {
    const page = activityReducer()
    page.send({ src: 'agent', session: 'conversation', type: 'case-state', goal: 'GOAL_1', status })
    page.send({ src: 'agent', session: 'conversation', type: 'task-done', activeGoal: 'GOAL_1' })
    assert.equal(page.state.cases.get('conversation').status, expected)
  }
})

test('a goal the Board completed or ended releases the conversation in the sidebar', () => {
  for (const status of ['completed', 'ended']) {
    const page = activityReducer()
    page.send({ src: 'agent', session: 'conversation', type: 'case-open', goal: 'GOAL_1', ok: true })
    page.send({ src: 'agent', session: 'conversation', type: 'case-state', goal: 'GOAL_1', status })
    const row = page.state.cases.get('conversation')
    assert.equal(row.goal, '', status)
    assert.equal(row.status, 'Ready', status)
  }
})

test('a focus statement does not overwrite the lifecycle the Board reported', () => {
  // The Agent emits per-root observations and then the focus set. Reading focus as a
  // status would relabel a paused root as active on every tool call.
  const page = activityReducer()
  page.send({ src: 'agent', session: 'conversation', type: 'case-state', goal: 'GOAL_1', status: 'paused' })
  page.send({ src: 'agent', session: 'conversation', type: 'focus', goals: [{ goal: 'GOAL_1', status: 'paused' }] })
  assert.equal(page.state.cases.get('conversation').status, 'Case paused')
  assert.equal(page.state.cases.get('conversation').roots, 1)
})

test('an empty focus set releases the conversation without claiming a Case transition', () => {
  const page = activityReducer()
  page.send({ src: 'agent', session: 'conversation', type: 'case-open', goal: 'GOAL_1', ok: true })
  page.send({ src: 'agent', session: 'conversation', type: 'case-unfocused', goal: 'GOAL_1' })
  page.send({ src: 'agent', session: 'conversation', type: 'focus', goals: [] })
  const row = page.state.cases.get('conversation')
  assert.equal(row.goal, '')
  assert.equal(row.status, 'Ready')
})

test('the inspector uses only explicit Agent observations of Case lifecycle', () => {
  const pending = { src: 'agent', type: 'case-pending', session: 'conversation', goal: 'GOAL_1' }
  assert.equal(ui.projectCaseRoots([pending])[0].lifecycle, 'unavailable')
  const running = { src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'running' }
  assert.equal(ui.projectCaseRoots([running, pending])[0].lifecycle, 'running')
  const paused = { ...running, status: 'paused' }
  assert.equal(ui.projectCaseRoots([running, pending, paused])[0].lifecycle, 'paused')
  // A Worker event is not an Agent observation of a goal.
  assert.equal(ui.projectCaseRoots([running, { ...paused, src: 'worker' }])[0].lifecycle, 'running')
  assert.equal(ui.projectCaseRoots([running, { ...running, status: 'completed' }])[0].label, 'Completed')
  assert.equal(ui.projectCaseRoots([running, { ...running, status: 'ended' }])[0].label, 'Ended')
  // The authority's lifecycle set is running / paused / completed / ended. Anything else is
  // neither labelled nor guessed at — including the words the retired models used.
  for (const invented of ['invented', 'open', 'archived', 'closed']) {
    assert.equal(ui.projectCaseRoots([{ ...running, status: invented }])[0].label, 'Unavailable',
      `${invented} is not a lifecycle this authority reports and must not be displayed as one`)
  }
  // A v3 event naming a Case, not a goal, describes nothing here.
  assert.deepEqual(ui.projectCaseRoots([{ src: 'agent', type: 'case-state', caseId: 'CASE_1', caseStatus: 'running' }]), [])
  // A second goal with no observation of its own is unavailable, not the first one's state.
  const two = ui.projectCaseRoots([running, { src: 'agent', type: 'case-open', goal: 'GOAL_2', ok: true }])
  assert.deepEqual(two.map((row) => [row.goal, row.label]), [['GOAL_1', 'Running'], ['GOAL_2', 'Unavailable']])
})

test('the inspector reports several goals with independent lifecycles', () => {
  const rows = ui.projectCaseRoots([
    { src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'running', gaps: 2 },
    { src: 'agent', type: 'case-state', goal: 'GOAL_2', status: 'paused' },
    { src: 'agent', type: 'focus', goals: [{ goal: 'GOAL_1' }, { goal: 'GOAL_2' }] },
  ])
  assert.deepEqual(rows.map((row) => [row.goal, row.label, row.gaps, row.focused]), [
    ['GOAL_1', 'Running', 2, true],
    ['GOAL_2', 'Paused', null, true],
  ])
})

test('a goal released from focus keeps its last observed lifecycle and is marked released', () => {
  const rows = ui.projectCaseRoots([
    { src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'completed' },
    { src: 'agent', type: 'case-state', goal: 'GOAL_2', status: 'running' },
    { src: 'agent', type: 'focus', goals: [{ goal: 'GOAL_2' }] },
  ])
  assert.deepEqual(rows.map((row) => [row.goal, row.label, row.focused]), [
    ['GOAL_2', 'Running', true],
    ['GOAL_1', 'Completed', false],
  ])
})

test('the shipped inspector separates lifecycle, focus and detached observations', () => {
  const start = ui.localPage.indexOf('function projectCaseRoots(')
  const end = ui.localPage.indexOf('const K=', start)
  assert.ok(start >= 0 && end > start)
  const elements = new Map(['casecount', 'roots', 'operations', 'frontier', 'workers'].map((id) => [id, { textContent: '', innerHTML: '' }]))
  const context = vm.createContext({ state: {}, $: (id) => elements.get(id), esc: String, timeOf: () => '', eventBody: () => '', URL })
  vm.runInContext(ui.localPage.slice(start, end), context)
  const operationsPanel = ui.localPage.slice(ui.localPage.indexOf('function operationsConsoleLink('),
    ui.localPage.indexOf('/* What a person', ui.localPage.indexOf('function operationsConsoleLink(')))
  vm.runInContext(operationsPanel, context)
  const renderer = ui.localPage.split('\n').find((line) => line.startsWith('function renderInspector('))
  assert.ok(renderer)
  vm.runInContext(renderer, context)

  const actual = vm.runInContext("projectCaseRoots([{src:'agent',type:'case-pending',goal:'GOAL_1'}])", context)
  assert.equal(actual[0].lifecycle, 'unavailable')

  context.events = [{ src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'completed' }]
  vm.runInContext('renderInspector(events)', context)
  assert.equal(elements.get('casecount').textContent, '1 in focus')
  assert.match(elements.get('roots').innerHTML, /GOAL_1 — Completed/)

  context.events = [
    { src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'running' },
    { src: 'agent', type: 'session-detached', goal: 'GOAL_1' },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('roots').innerHTML, /GOAL_1 — Running/, 'detachment is not a goal transition')
  assert.match(elements.get('roots').innerHTML, /Detached · last observed/)

  context.events = [
    { src: 'agent', type: 'case-state', goal: 'GOAL_1', status: 'running', gaps: 3 },
    { src: 'agent', type: 'case-state', goal: 'GOAL_2', status: 'paused' },
    { src: 'agent', type: 'focus', goals: [{ goal: 'GOAL_2' }] },
  ]
  vm.runInContext('renderInspector(events)', context)
  assert.equal(elements.get('casecount').textContent, '1 in focus · 1 released')
  assert.match(elements.get('roots').innerHTML, /GOAL_2 — Paused/)
  assert.match(elements.get('roots').innerHTML, /GOAL_1 — Running.*3 open gap\(s\).*released from focus/)

  // A running operation is neither an error nor idleness, and the panel says which it is.
  // Shown as idle, a person concludes the Runtime is stuck or that nothing was dispatched.
  assert.match(elements.get('operations').innerHTML, /No operations reported yet/)
  const running = { tool: 'ApplyAction', label: 'ApplyAction demo.ship', state: 'running', stage: 'at_worker',
    at: '2026-10-01T08:00:00Z', since: '2026-10-01T08:00:01Z' }
  context.events = [{ src: 'agent', type: 'operations', operations: [running] },
    { src: 'agent', type: 'held-call', phase: 'waiting', tool: 'ApplyAction', label: 'ApplyAction demo.ship' }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('operations').innerHTML, /Waiting for ApplyAction demo\.ship/)
  assert.match(elements.get('operations').innerHTML, /asks it nothing meanwhile/)
  assert.match(elements.get('operations').innerHTML, /ApplyAction demo\.ship<small>Running · at the Worker/)

  // Waiting for a person: the link to Console is offered only for the account and Agent the
  // report was made under.
  context.state.status = { runtime: { agent: { id: 'agent-1' },
    console: { origin: 'https://console.example', accountId: 'acct-1', agentId: 'agent-1' } } }
  context.events = [{ src: 'agent', type: 'operations', accountId: 'acct-1', agentId: 'agent-1',
    operations: [{ ...running, state: 'needs_person', stage: undefined }] }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('operations').innerHTML, /Needs reconciliation in Console/)
  assert.match(elements.get('operations').innerHTML, /href="https:\/\/console\.example\/console\/#\/agents\/agent-1\?tab=runtime"/)
  context.events = [{ src: 'agent', type: 'operations', accountId: 'acct-other', agentId: 'agent-1',
    operations: [{ ...running, state: 'waiting_for_decision', stage: undefined }] }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('operations').innerHTML, /Waiting for a decision in Console/)
  assert.match(elements.get('operations').innerHTML, /Console destination unavailable until this account and Agent are confirmed/)
  assert.doesNotMatch(elements.get('operations').innerHTML, /href=/)
  context.state.status = undefined

  context.events = [{ src: 'agent', type: 'operations', operations: [
    { tool: 'ApplyBatch', label: 'ApplyBatch', state: 'done', at: 'a', since: 'b' },
    { tool: 'EndGoal', label: 'EndGoal GOAL_1', state: 'unknown', contentWithheld: true, at: 'c', since: 'd' },
  ] }, { src: 'agent', type: 'exit' }]
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('operations').innerHTML, /Reported before the Agent process changed/)
  assert.match(elements.get('operations').innerHTML, /ApplyBatch<small>Done/)
  assert.match(elements.get('operations').innerHTML, /Reconciled, external effect unknown · content withheld/)

  // Looking at an ended goal is an observation, not focus or a new lifecycle transition.
  context.events = [{ src: 'agent', type: 'tool-result', cmd: 'QueryBoard', authoritative: true,
    accepted: true, boardRead: { observed: true, history: { goal: 'GOAL<OLD>',
      status: 'available', disposition: 'completed', certified: true, factsOnPage: 7, morePages: true } } }]
  vm.runInContext('renderInspector(events)', context)
  assert.equal(elements.get('casecount').textContent, '0 in focus · 1 histories read')
  assert.match(elements.get('roots').innerHTML, /History viewed/)
  assert.match(elements.get('roots').innerHTML, /GOAL&lt;OLD&gt; — completed/)
  assert.match(elements.get('roots').innerHTML, /At closure · certified/)
  assert.match(elements.get('roots').innerHTML, /Last page: 7 fact\(s\) · more pages available/)
  assert.doesNotMatch(elements.get('roots').innerHTML, /released from focus|has not been used/)
  assert.match(elements.get('frontier').innerHTML, /No current Case frontier was reported by this read/)
  assert.equal(vm.runInContext('projectCaseRoots(events).length', context), 0)

  context.events.push({ ...context.events[0], boardRead: { observed: true,
    history: { goal: 'GOAL<OLD>', status: 'unavailable' } } })
  vm.runInContext('renderInspector(events)', context)
  assert.match(elements.get('roots').innerHTML, /History unavailable/)
  assert.doesNotMatch(elements.get('roots').innerHTML, /certified|completed/)
})
