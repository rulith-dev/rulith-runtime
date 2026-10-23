import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShadowReviewer, SHADOW_SYSTEM, deliveryNote, blockNote, reviewContext, parseReply, proposedCall,
  reviewWithModel, reviewLog } from '../../harness/web/shadow-reviewer.mjs';
import { classify, plan } from '../../harness/web/board-transcript.mjs';
import { renderChannelResult } from '../../harness/board-channel.mjs';

const fact = (nodeId, value = 1) => ({ nodeId, atom: { predicate: 'criterion', args: { value } }, createdBy: 'agent' });
const view = (...facts) => ({ facts, goals: { directory: [{ goal: 'goal-1' }] } });
const beat = { hand: 'child-1', tool: 'Execute', args: { action: 'write', args: { text: 'proposed body' } },
  route: { provider: 'chosen', model: 'chosen-model', maxTokens: 8000 } };
function fixture(text = '{"verdict":"allow"}', extra = {}) {
  const records = [], visible = [], requests = [];
  const reviewer = new ShadowReviewer({ chat: async (...args) => { requests.push(args); return { text, usage: { inputTokens: 22 } }; },
    log: { record: async (row) => records.push(row) }, visible: (line) => visible.push(line), ...extra });
  const review = (options = {}, read = async () => [view(fact('a'))]) => reviewer.review({ ...beat, ...options }, read);
  return { reviewer, records, visible, requests, review };
}

test('parser accepts exactly the three verdicts, rejects empty, extra keys and wrappers', () => {
  assert.deepEqual(parseReply('{"verdict":"allow"}'), { verdict: 'allow' });
  for (const verdict of ['note', 'block']) assert.deepEqual(parseReply(JSON.stringify({ verdict, node: 'a', advice: 'Check this.' })), { verdict, node: 'a', advice: 'Check this.' });
  for (const text of ['', 'null', '[]', '{}', 'PASS', '```json\n{}\n```', '{"verdict":"allow","advice":"a"}',
    '{"verdict":"block","node":"a","advice":""}', '{"verdict":"note","node":"a","advice":"a\nb"}', '{"node":"a","advice":"a"}'])
    assert.throws(() => parseReply(text), /malformed/);
});

test('every proposed write reviews even on the same snapshot, logs one row with required fields', async () => {
  const f = fixture(); await f.review(); await f.review();
  assert.equal(f.records.length, 2);
  const row = f.records[0];
  for (const field of ['time', 'hand', 'tool', 'action', 'verdict', 'node', 'advice', 'latencyMs', 'tokens', 'error']) assert.ok(Object.hasOwn(row, field));
  assert.equal(row.hand, 'child-1'); assert.equal(row.action, 'write'); assert.equal(row.tokens.inputTokens, 22);
  assert.equal(f.requests[0][0].maxTokens, 8000);
  assert.match(f.requests[0][1], /PROPOSED CALL/); assert.match(f.requests[0][1], /proposed body/);
});

test('context has full Board, changes and removals, prior suggestions, and bounded proposed body', () => {
  const old = reviewContext([view(fact('old'), fact('a'))], null);
  const assembled = reviewContext([view(fact('a', 2), fact('new'))], old.current, [{ node: 'a', advice: 'Prior advice.' }],
    proposedCall('Execute', { action: 'write', args: { text: 'x'.repeat(10_000), path: 'target', command: 'exact command' } }));
  assert.match(assembled.user, /"changed":\[\{"nodeId":"a"/);
  assert.match(assembled.user, /"removed":\["old"\]/); assert.match(assembled.user, /Prior advice/);
  assert.match(assembled.user, /"characters":10000,"truncated":true/);
  assert.ok(!assembled.user.includes('x'.repeat(4097))); assert.match(assembled.user, /exact command/);
});

test('note and block must anchor to a real fact or goal directory node', async () => {
  for (const verdict of ['note', 'block']) {
    const f = fixture(JSON.stringify({ verdict, node: 'goal-1', advice: 'Concrete criterion.' }));
    assert.equal((await f.review()).verdict, verdict);
    assert.equal(f.reviewer.prior.length, verdict === 'note' ? 1 : 0);
    const bad = fixture(JSON.stringify({ verdict, node: 'invented', advice: 'Concrete criterion.' }));
    assert.deepEqual(await bad.review(), { verdict: 'allow' }); assert.match(bad.visible[0], /fail open/);
    assert.match(bad.records[0].error, /absent/);
  }
});

test('parse, read, model failure and timeout fail open visibly; usage on error retained', async () => {
  const cases = [
    { text: 'broken' }, { read: async () => { throw new Error('read refused'); } },
    { extra: { chat: async () => { const e = new Error('model failed'); e.usage = { outputTokens: 7 }; throw e; } } },
    { extra: { chat: async () => new Promise(() => {}) }, options: { timeoutMs: 5 } },
  ];
  for (const c of cases) {
    const f = fixture(c.text, c.extra); assert.deepEqual(await f.review(c.options, c.read), { verdict: 'allow' });
    assert.equal(f.records.length, 1); assert.ok(f.records[0].error); assert.match(f.visible[0], /fail open/);
    if (f.records[0].error === 'model failed') assert.equal(f.records[0].tokens.outputTokens, 7);
  }
});

test('disabled reviewer makes no reads or model calls', async () => {
  const f = fixture(undefined, { enabled: false });
  assert.deepEqual(await f.review({}, () => { throw new Error('must not read'); }), { verdict: 'allow' });
  assert.equal(f.requests.length, 0); assert.equal(f.records.length, 0);
});

test('adapter sees only Board input and shadow system, no hand history or tools', async () => {
  let request;
  const llm = { async *stream(input) {
    request = input;
    yield { type: 'text-delta', index: 0, text: '{"verdict":"allow"}' };
    yield { type: 'reasoning-delta', index: 1, text: 'private reasoning' };
    yield { type: 'usage', usage: { inputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const user = reviewContext([view(fact('a'))], null, [], proposedCall(beat.tool, beat.args)).user;
  const reply = await reviewWithModel(llm, beat.route, user, new AbortController().signal);
  assert.equal(request.system, SHADOW_SYSTEM); assert.deepEqual(request.tools, []);
  assert.equal(request.provider, 'chosen'); assert.equal(request.model, 'chosen-model');
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: user }] }]);
  assert.doesNotMatch(JSON.stringify(request), /private reasoning|conversation-1|child-1/);
  assert.equal(reply.usage.inputTokens, 20); assert.equal(parseReply(reply.text).verdict, 'allow');
  for (const reason of ['max-tokens', 'error', 'tool-calls', null]) await assert.rejects(reviewWithModel({
    async *stream() { if (reason) yield { type: 'finish', reason: { kind: reason } }; },
  }, beat.route, user, new AbortController().signal), /shadow model/);
});

test('note renderer preserves advisory text through transcript layout and aging once', () => {
  const note = deliveryNote({ node: 'goal-1', advice: 'Check the criterion.' });
  const result = { content: [{ type: 'text', text: JSON.stringify({ accepted: true, view: view(fact('a')) }) }, { type: 'text', text: note }] };
  const raw = renderChannelResult({}, result)[0].text;
  const rewritten = plan([classify(raw), classify(raw.slice(0, raw.indexOf('\n')))]);
  assert.equal(rewritten.join('\n').split(note).length - 1, 1); assert.ok(rewritten[0].endsWith(note));
  assert.deepEqual(plan(rewritten.map(classify)), [null, null]);
});

test('inventory contains the exact prompt and note/block templates', async () => {
  const doc = await fs.readFile(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('```text\n' + SHADOW_SYSTEM + '\n```'));
  assert.ok(doc.includes(deliveryNote({ node: '<node>', advice: '<advice>' })));
  assert.ok(doc.includes(blockNote({ node: '<node>', advice: '<advice>' })));
  assert.ok(doc.includes(blockNote({ node: '<node>', advice: '<advice>' }, true)));
});

test('review log appends exactly one JSON line per review without rewriting previous rows', async (t) => {
  const scratch = new URL('../../.scratch/', import.meta.url); await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fileURLToPath(scratch), 'shadow-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = reviewLog(directory); await log.record({ hand: 'main', verdict: 'allow' });
  await log.record({ hand: 'child', verdict: 'note' });
  const rows = (await fs.readFile(log.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [{ hand: 'main', verdict: 'allow' }, { hand: 'child', verdict: 'note' }]);
});
