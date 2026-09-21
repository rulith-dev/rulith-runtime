// SPDX-License-Identifier: Apache-2.0
/**
 * What the transcript gives weight to.
 *
 * A conversation is prose with things that happened alongside it, and the failure this guards
 * is a quiet one: every event drawn as a bordered panel, so that the refusal a person has to
 * act on looks exactly like the nine leases that arrived behind it. The rule is that routine
 * events are lines of text, that wrong/waiting/needs-a-person states keep a visible treatment
 * of their own, and that nothing is dropped to achieve either — a line with more to say opens
 * in place.
 *
 * `card` lives inside the page template, so it is lifted out and run the way
 * `local-case-state.test.mjs` lifts the inspector: the real source, stubbed surroundings.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { localPage, renderToolCall } from '../local/local-ui.mjs'

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The shipped `card`, with only its surroundings replaced. */
const shippedCard = () => {
  const start = localPage.indexOf('const EVENT_LABELS=')
  const end = localPage.indexOf('function renderInspector(', start)
  assert.ok(start >= 0 && end > start, 'the transcript renderer moved; this arm has to follow it')
  const context = vm.createContext({
    esc,
    timeOf: () => '23:36',
    eventBody: (e) => e.body ?? '',
    renderMarkdown: (value) => '<p>' + esc(value) + '</p>',
    renderToolCall,
    state: { toolResults: new Map() },
  })
  vm.runInContext(localPage.slice(start, end), context)
  return (event, trace = false) => vm.runInContext('card(' + JSON.stringify(event) + ',' + String(trace) + ')', context)
}

test('a routine event is a line of text, not a panel', () => {
  const card = shippedCard()
  for (const event of [
    { src: 'agent', type: 'case-open', caseId: 'case-1', body: 'Case Type exploration' },
    { src: 'agent', type: 'task-done', body: 'Response delivered; Rulith Case(s) "case-1" remain in focus.' },
    { src: 'worker', type: 'claimed', body: 'lease · lease-77' },
    { src: 'agent', type: 'verdict', accepted: true, body: 'Accepted by Board · ApplyBatch' },
    { src: 'agent', type: 'case-closed', body: 'Disposition: closed' },
  ]) {
    const html = card(event)
    assert.match(html, /class="message quiet"/, event.type + ' still takes a full message block')
    assert.match(html, /class="note"|class="activity"/, event.type + ' is not a line')
    assert.doesNotMatch(html, /class="alert/, event.type + ' is routine and must not shout')
    assert.doesNotMatch(html, /class="event/, 'the bordered event panel is retired')
  }
  // The label and the body arrive on one line, in that order, with when it happened after it.
  const opened = card({ src: 'agent', type: 'case-open', body: 'Case Type exploration' })
  assert.match(opened, /Rulith Case opened · Case Type exploration/)
  assert.match(opened, /<span class="act-state">agent · 23:36<\/span>/)
})

test('wrong, waiting, or needing a person keeps a treatment of its own', () => {
  const card = shippedCard()
  const bad = [
    { src: 'agent', type: 'blocked', body: 'An earlier ApplyAction call has an unknown outcome.' },
    { src: 'agent', type: 'error', body: 'The Runtime could not reach the Gateway.' },
    { src: 'agent', type: 'verdict', accepted: false, body: 'Rejected by Board' },
    { src: 'worker', type: 'reported', landed: false, body: 'receipt not committed' },
  ]
  for (const event of bad) {
    const html = card(event)
    assert.match(html, /class="alert bad"/, event.type + ' must stay visible')
    assert.match(html, /class="alert-body">/, 'what went wrong is shown, not hidden behind a disclosure')
  }
  for (const event of [
    { src: 'agent', type: 'case-pending', body: 'Waiting for evidence' },
    { src: 'agent', type: 'queue-suspended', body: '2 further call(s) were not sent' },
    { src: 'agent', type: 'session-detached', body: 'The local conversation was reclaimed.' },
    { src: 'agent', type: 'recovery', state: 'waiting', body: 'Waiting for an earlier ApplyAction call' },
  ]) {
    assert.match(card(event), /class="alert wait"/, event.type + ' is a state a person is waiting on')
  }
  // A recovery that says there is nothing outstanding is not a warning about anything.
  assert.match(card({ src: 'agent', type: 'recovery', state: 'none', body: 'No unresolved call' }), /class="note"/)
})

test('a line with more to say opens in place, and stays open across a refresh', () => {
  const card = shippedCard()
  const long = { src: 'agent', type: 'source-plan', at: '2026-09-20T15:36:00.000Z', caseId: 'case-1',
    body: 'read via file:/data/one → order.count\nread via db:ledger → order.total\nread via http:rates → order.rate' }
  const html = card(long)
  assert.match(html, /<details class="activity"/, 'a multi-line body must not be truncated away')
  assert.match(html, /<pre>read via file:/, 'the whole of it is there once opened')
  // render() restores open disclosures by data-call; a quiet line needs a name of its own that
  // is the same on the next render, or it closes itself every time an event arrives.
  assert.match(html, /data-call="note:source-plan:2026-09-20T15:36:00\.000Z:case-1"/)
  assert.equal(card(long), html, 'the same event must produce the same name')
  assert.match(card({ src: 'agent', type: 'handoff', body: 'An earlier call was handed over.' }),
    /class="note"/, 'a line that fits needs no disclosure')
})

test('prose, the person\'s own message, and Trace are unchanged', () => {
  const card = shippedCard()
  assert.match(card({ src: 'agent', type: 'propose', say: 'Verified separate Board.' }),
    /<div class="agent-text"><p>Verified separate Board\.<\/p><\/div>/)
  assert.match(card({ src: 'agent', type: 'task-start', text: '<b>hi</b>' }),
    /<div class="message user"><div class="bubble">&lt;b&gt;hi&lt;\/b&gt;<\/div><\/div>/)
  // Trace shows what the conversation view filters out, in the same quiet form.
  assert.equal(card({ src: 'agent', type: 'case-state', caseId: 'c', body: 'Case lifecycle: running' }), '')
  assert.match(card({ src: 'agent', type: 'case-state', caseId: 'c', body: 'Case lifecycle: running' }, true),
    /class="note">.*Case lifecycle/)
})

test('a tool call is one activity line that opens onto what it actually sent and received', () => {
  const html = renderToolCall({ callId: 'call-1', cmd: 'ApplyBatch', input: { text: '{"op":"assert"}' } },
    { authoritative: true, accepted: true, output: { text: '{"accepted":true}' } })
  assert.match(html, /class="message quiet"/)
  assert.match(html, /<details class="activity tool-call" data-call="call-1">/)
  assert.match(html, /<span class="act-text">ApplyBatch<\/span>/)
  assert.match(html, /<span class="act-state">Accepted<\/span>/)
  assert.doesNotMatch(html, /class="event/, 'a call is an activity line, not a bordered card')
  // Only a refusal spends colour, and the words are still the host's own.
  assert.match(renderToolCall({ cmd: 'ApplyAction' }, { authoritative: true, accepted: false }),
    /<span class="act-state bad">Rejected<\/span>/)
  assert.match(renderToolCall({ cmd: 'ApplyAction' }, { refusedLocally: true }), /act-state bad">Not sent/)
  assert.match(renderToolCall({ cmd: 'ApplyAction' }, undefined), /<span class="act-state">Waiting for result<\/span>/)
})

test('the retired panel styles are gone and the quiet ones are declared', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(localPage)[1]
  assert.doesNotMatch(css, /\.event\{border:1px solid/, 'the bordered event panel is retired')
  assert.doesNotMatch(css, /\.event-head\{|\.event-body\{/)
  for (const rule of ['.note,.activity>summary{', '.act-ico{', '.act-state.bad{', '.alert{', '.alert.bad{', '.alert.wait{', '.call-content{'])
    assert.ok(css.includes(rule), 'the transcript lost ' + rule)
  assert.match(css, /\.act-more::before\{content:'▸'\}/, 'a line that opens has to say it opens')
})
