import { generalKit, kitReady, KIT_SKIP } from '../../harness/runtime-kit.mjs';
// The one host channel, shared by all dsh hands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RulithMcp, TOOLS } from '../../harness/rulith-mcp.mjs';
import { BoardChannel, blockedResult, isWrite, readToolKinds } from '../../harness/board-channel.mjs';
import { ShadowReviewer, decodeBoardResult, deliveryNote } from '../../harness/web/shadow-reviewer.mjs';
import { installGate, ADDENDUM, CHILD_ADDENDUM } from '../../harness/web/rulith-web-gate.mjs';
import { forDeployment } from '../../harness/web-tools.mjs';
import { handOf, DELEGATION_TOOLS } from '../../harness/subagents.mjs';
import { WEB_TOOLS } from '../../harness/web-tools.mjs';
import { cachedBoard } from '../../harness/web/rulith-runtime.mjs';

const result = (answer, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(answer) }], ...(isError ? { isError } : {}) });
const view = { goals: { directory: [{ goal: 'g' }] }, facts: [{ nodeId: 'n', label: 'criterion(n)' }], actions: [
  { action: 'read', description: '[worker tool] demo.inspect@1' },
  { action: 'write', description: '[worker tool] demo.change@1' },
] };
const immediate = () => new Promise((resolve) => setImmediate(resolve));

test('panel reads are empty before the first result and never invoke MCP', () => {
  const channel = new BoardChannel({ invoke() { assert.fail('panel read invoked MCP'); } });
  const holder = { agentName: 'test-agent', channel };
  assert.equal(channel.latestBoard, null);
  for (let i = 0; i < 10; i++) assert.deepEqual(cachedBoard(holder), { available: true, agentName: 'test-agent' });
  assert.deepEqual(cachedBoard(null, { state: 'no_agent' }), { available: false, tools: { state: 'no_agent' } });
});

test('panel reads the latest Board and operations from every tool and hand, including refusals', async () => {
  const sends = [];
  let reply;
  const channel = new BoardChannel({ invoke: async (tool, args) => { sends.push({ tool, args }); return reply; } });
  const holder = { agentName: 'test-agent', channel };
  for (const [tool, hand, isError] of [['Get', 'main', false], ['Set', 'child', false], ['Execute', 'child', true]]) {
    const nextView = { ...view, position: { tool } };
    const operations = [{ tool, label: 'received', at: tool, state: isError ? 'refused' : 'done' }];
    reply = result({ accepted: !isError, view: nextView, operations }, isError);
    const before = Date.now();
    assert.equal(await channel.call(tool, {}, { hand }), reply, 'caching preserves the tool result');
    const after = Date.now();
    for (let i = 0; i < 10; i++) {
      const snapshot = cachedBoard(holder);
      assert.deepEqual(snapshot.view, nextView);
      assert.deepEqual(snapshot.operations, operations);
      assert.ok(Date.parse(snapshot.seenAt) >= before && Date.parse(snapshot.seenAt) <= after);
    }
  }
  assert.deepEqual(sends.map(({ tool }) => tool), ['Get', 'Set', 'Execute']);
  const replacement = new BoardChannel({ invoke() { assert.fail('new channel panel invoked MCP'); } });
  assert.equal(cachedBoard({ ...holder, channel: replacement }).view, undefined, 'another Agent starts with no cached view');
});

test('channel caches internal request results and keeps the snapshot across results without a Board', async () => {
  let reply = result({ accepted: true, view, operations: [{ tool: 'Set', state: 'done' }] });
  const channel = new BoardChannel({ invoke: async () => reply });
  await channel.request('Set', { operations: [] });
  const snapshot = channel.latestBoard;
  for (const next of [result({ accepted: true, result: 'artifact' }), { content: [{ type: 'text', text: 'unreadable' }] }]) {
    reply = next;
    await channel.call('Get', {});
    assert.equal(channel.latestBoard, snapshot);
  }
  reply = result({ accepted: true, view: { goals: {} } });
  await channel.request('Get', {});
  assert.deepEqual(channel.latestBoard.operations, [], 'an absent strip does not keep old operations');
});

function fixture(replies = ['allow'], extra = {}) {
  const sends = [], reviews = [], logs = [], visible = [];
  const shadow = new ShadowReviewer({ chat: async (_route, user) => {
    reviews.push(user); const next = replies.shift() ?? 'allow';
    return { text: typeof next === 'object' ? JSON.stringify(next) : next === 'allow' ? '{"verdict":"allow"}' : next };
  }, log: { record: async (row) => logs.push(row) }, visible: (text) => visible.push(text) });
  const channel = new BoardChannel({ shadow, focusedGoals: () => ['g'], toolKinds: () => ({ 'demo.inspect@1': 'read', 'demo.change@1': 'write' }),
    invoke: async (tool, args) => { sends.push({ tool, args }); return result({ accepted: true, view }); }, visible: (text) => visible.push(text), ...extra });
  return { channel, sends, reviews, logs, visible, shadow };
}

test('one FIFO across main and children, a rejected entry does not poison the channel', async () => {
  const order = []; let release; let active = 0; let max = 0;
  const channel = new BoardChannel({ invoke: async (_tool, args) => {
    active++; max = Math.max(max, active); order.push(args.id);
    try {
      if (args.id === 'main') await new Promise((resolve) => { release = resolve; });
      if (args.id === 'bad') throw new Error('refused');
      return result({ accepted: true, id: args.id });
    } finally { active--; }
  } });
  const calls = ['main', 'child-1', 'bad', 'child-2'].map((id) => channel.call('Get', { id }, { hand: id }));
  const settled = Promise.allSettled(calls);
  await immediate(); assert.deepEqual(order, ['main']); release();
  const answers = await settled;
  assert.deepEqual(order, ['main', 'child-1', 'bad', 'child-2']); assert.equal(max, 1);
  assert.equal(answers[2].status, 'rejected'); assert.equal(decodeBoardResult(answers[3].value).id, 'child-2');
});

test('write review reads and dispatch are adjacent even while another hand queues a write', async () => {
  let finish;
  const f = fixture();
  f.shadow.chat = async (_route, user) => { f.reviews.push(user); if (f.reviews.length === 1) await new Promise((resolve) => { finish = resolve; }); return { text: '{"verdict":"allow"}' }; };
  const first = f.channel.call('Set', { operations: [{ id: 'first' }] }, { hand: 'main' });
  await immediate();
  const second = f.channel.call('Set', { operations: [{ id: 'second' }] }, { hand: 'child' });
  await immediate(); assert.equal(f.sends.filter((s) => s.tool === 'Set').length, 0);
  finish(); await Promise.all([first, second]);
  assert.deepEqual(f.sends.map((s) => s.tool), ['Get', 'Get', 'Set', 'Get', 'Get', 'Set']);
  assert.deepEqual(f.sends[1].args, { include: ['nodes'], selector: { goals: ['g'] } });
});

for (const [tool, args] of [['Set', { operations: [] }], ['Execute', { action: 'read' }], ['Get', { artifact: { ref: 'ref' } }]]) {
  test(`held ${tool} owns the operation slot while Board reads and its polls pass`, async () => {
    const entry = { tool, label: 'holder', at: 'one', state: 'running' };
    let held = false, state = 'running', polled;
    const poll = new Promise((resolve) => { polled = resolve; });
    const f = fixture(['allow', 'allow'], { invoke: async (name, request) => {
      f.sends.push({ tool: name, args: request });
      if (request.id === 'holder') { held = true; return result({ accepted: true, operations: [entry] }); }
      if (name === 'Get') {
        if (held && !request.id && !request.include) polled();
        return result({ accepted: true, view, operations: held ? [{ ...entry, state }] : [] });
      }
      assert.equal(state, 'done', 'the next operation cannot dispatch while the holder is running');
      return result({ accepted: true });
    } });
    const holder = f.channel.call(tool, { ...args, id: 'holder' }, { hand: 'child-1', wait: { pollMs: 5 } });
    await immediate();
    const reviewed = f.reviews.length;
    if (tool === 'Execute') assert.equal(reviewed, 0, 'read-only Executes still acquire the slot');
    const next = f.channel.call('Set', { operations: [], id: 'next' }, { hand: 'child-2' });
    const read = await f.channel.call('Get', { id: 'other' });
    assert.equal(decodeBoardResult(read).operations[0].state, 'running');
    await poll;
    assert.equal(f.reviews.length, reviewed, 'the waiting hand has not started review');
    assert.equal(f.sends.some((send) => send.args.id === 'next'), false);
    state = 'done'; await holder; await next;
    assert.equal(f.reviews.length, reviewed + 1); assert.equal(f.channel.operation, null);
  });
}

test('all operation kinds wait outside the FIFO, including read-only Execute and artifact Get', async () => {
  let state = 'running'; const sends = [];
  const entry = { tool: 'Execute', label: 'holder', at: 'one', state };
  const channel = new BoardChannel({ invoke: async (tool, args) => {
    sends.push([tool, args]);
    return result({ accepted: true, operations: args.action === 'holder' || tool === 'Get' && !args.artifact ? [{ ...entry, state }] : [] });
  } });
  const holder = channel.call('Execute', { action: 'holder' }, { wait: { pollMs: 20 } });
  await immediate();
  const waiting = [channel.call('Set', { operations: [] }), channel.call('Execute', { action: 'read' }),
    channel.call('Get', { artifact: { ref: 'ref' } })];
  await channel.call('Get', {});
  assert.deepEqual(sends.map(([tool]) => tool), ['Execute', 'Get']);
  state = 'done'; await holder; await Promise.all(waiting);
  assert.deepEqual(sends.filter(([, args]) => args.operations || args.action === 'read' || args.artifact).map(([tool]) => tool), ['Set', 'Execute', 'Get']);
});

for (const state of ['waiting_for_decision', 'needs_person']) {
  test(`${state} releases the slot at return and leaves further refusal to the platform`, async () => {
    const entry = { tool: 'Execute', label: 'held', at: 'one', state };
    const sends = [];
    const channel = new BoardChannel({ invoke: async (tool) => {
      sends.push(tool);
      return tool === 'Execute' ? result({ accepted: true, operations: [entry] })
        : result({ accepted: false, teaching: 'your previous operation', operations: [entry] }, true);
    } });
    const held = channel.call('Execute', { action: 'held' });
    const next = channel.call('Set', { operations: [] }, { hand: 'other' });
    assert.equal(decodeBoardResult(await held).operations[0].state, state);
    assert.equal(decodeBoardResult(await next).teaching, 'your previous operation');
    assert.deepEqual(sends, ['Execute', 'Set']); assert.equal(channel.operation, null);
  });
}

test('the note suggestion finishes inside the holder slot before the next hand reviews', async () => {
  const note = { verdict: 'note', node: 'g', advice: 'Check criterion n.' };
  const f = fixture([note, 'allow']); let finish;
  f.channel.invoke = async (tool, args) => {
    f.sends.push({ tool, args });
    if (args.operations?.[0]?.predicate === 'suggestion') await new Promise((resolve) => { finish = resolve; });
    return result({ accepted: true, view });
  };
  const holder = f.channel.call('Execute', { action: 'write' });
  await immediate();
  const next = f.channel.call('Set', { operations: [] }, { hand: 'other' });
  await immediate(); assert.equal(f.reviews.length, 1);
  assert.equal(f.channel.operationWaiters.length, 1);
  finish(); await holder; await next;
  assert.equal(f.reviews.length, 2); assert.equal(f.channel.operation, null);
});

test('block and thrown dispatch/review/poll errors release the slot for the next hand', async () => {
  const f = fixture([{ verdict: 'block', node: 'g', advice: 'Check n.' }, 'allow']);
  const blocked = f.channel.call('Set', { operations: [] });
  const next = f.channel.call('Set', { operations: [] }, { hand: 'other' });
  assert.equal((await blocked).isError, true); assert.equal(decodeBoardResult(await next).accepted, true);
  assert.equal(f.channel.operation, null);
  for (const failure of ['dispatch', 'review', 'poll']) {
    let fail = true;
    const channel = new BoardChannel({
      shadow: failure === 'review' ? { async review() { if (fail) throw new Error('review failed'); return { verdict: 'allow' }; } } : undefined,
      invoke: async (tool) => {
        if (fail && (failure === 'dispatch' || failure === 'poll' && tool === 'Get')) throw new Error(`${failure} failed`);
        return result({ accepted: true, operations: fail && failure === 'poll'
          ? [{ tool: 'Set', label: 'held', at: 'one', state: 'running' }] : [] });
      },
    });
    await assert.rejects(channel.call('Set', { operations: [] }, { wait: { pollMs: 1 } }), new RegExp(`${failure} failed`));
    assert.equal(channel.operation, null); assert.equal(channel.pending.size, 0);
    fail = false; assert.equal(decodeBoardResult(await channel.call('Set', { operations: [] })).accepted, true);
  }
});

test('close fails operation waiters immediately and releases a polling holder', async () => {
  const running = result({ accepted: true, operations: [{ tool: 'Execute', label: 'held', at: 'one', state: 'running' }] });
  const channel = new BoardChannel({ invoke: async () => running });
  const holder = channel.call('Execute', { action: 'held' }, { wait: { pollMs: 60_000 } });
  await immediate();
  const waiters = [channel.call('Set', { operations: [] }), channel.call('Get', { artifact: { ref: 'ref' } })];
  const failed = waiters.map((call) => assert.rejects(call, /MCP connection closed/));
  channel.close(); await Promise.all(failed);
  assert.equal(await holder, running); assert.equal(channel.operation, null); assert.equal(channel.pending.size, 0);
  await assert.rejects(channel.call('Execute', { action: 'later' }), /MCP connection closed/);
});

test('abort returns the last result promptly and releases the slot without another poll', async () => {
  const abort = new AbortController(); const sends = [];
  const running = result({ accepted: true, operations: [{ tool: 'Execute', label: 'held', at: 'one', state: 'running' }] });
  const channel = new BoardChannel({ invoke: async (tool) => { sends.push(tool); return tool === 'Execute' ? running : result({ accepted: true }); } });
  const holder = channel.call('Execute', { action: 'held' }, { signal: abort.signal, wait: { pollMs: 60_000 } });
  await immediate(); const next = channel.call('Set', { operations: [] });
  abort.abort(); assert.equal(await holder, running); await next;
  assert.deepEqual(sends, ['Execute', 'Set']); assert.equal(channel.operation, null);
});

test('abort while a poll is in flight returns the last result and drains through the FIFO', async () => {
  const abort = new AbortController(); let polled, finish;
  const poll = new Promise((resolve) => { polled = resolve; });
  const running = result({ accepted: true, operations: [{ tool: 'Execute', label: 'held', at: 'one', state: 'running' }] });
  const channel = new BoardChannel({ invoke: async (tool) => {
    if (tool === 'Execute') return running;
    if (tool === 'Get') { polled(); return new Promise((resolve) => { finish = resolve; }); }
    return result({ accepted: true });
  } });
  const holder = channel.call('Execute', { action: 'held' }, { signal: abort.signal, wait: { pollMs: 1 } });
  await poll; abort.abort(); assert.equal(await holder, running); assert.equal(channel.operation, null);
  const next = channel.call('Set', { operations: [] });
  finish(result({ accepted: true })); await next; assert.equal(channel.operation, null);
});

test('an aborted operation waiter leaves the slot to the next hand without dispatching', async () => {
  const abort = new AbortController(); const sends = []; let finish;
  const channel = new BoardChannel({ invoke: async (tool, args) => {
    sends.push(args.id);
    if (args.id === 'holder') await new Promise((resolve) => { finish = resolve; });
    return result({ accepted: true });
  } });
  const holder = channel.call('Set', { id: 'holder', operations: [] });
  await immediate();
  const cancelled = channel.call('Execute', { id: 'cancelled', action: 'read' }, { signal: abort.signal });
  const failed = assert.rejects(cancelled, { name: 'AbortError' });
  const next = channel.call('Get', { id: 'next', artifact: { ref: 'ref' } });
  abort.abort(); await failed; finish(); await holder; await next;
  assert.deepEqual(sends, ['holder', 'next']); assert.equal(channel.operation, null);
});

test('long operation releases channel; another hand can deliver its full outcome back to the requester', async () => {
  const entry = { tool: 'Execute', label: 'slow', at: 'one', state: 'running' };
  const sends = []; let state = 'running';
  const channel = new BoardChannel({ invoke: async (tool, args) => {
    sends.push([tool, args]);
    if (tool === 'Execute') return result({ accepted: true, operations: [entry] });
    if (args.from === 'other') { state = 'done'; return result({ accepted: true, view, operations: [{ ...entry, state, result: { receipt: 'own receipt' } }] }); }
    return result({ accepted: true, view, operations: [] });
  } });
  const slow = channel.call('Execute', { action: 'slow' }, { hand: 'child-1', wait: { pollMs: 25, waitSeconds: 1 } });
  await immediate();
  const read = await channel.call('Get', { from: 'other' }, { hand: 'child-2' });
  assert.equal(state, 'done'); assert.equal(decodeBoardResult(read).accepted, true);
  const answer = await slow;
  assert.equal(decodeBoardResult(answer).result.receipt, 'own receipt'); assert.equal(decodeBoardResult(answer).tool, 'Execute');
  assert.deepEqual(sends.map(([tool]) => tool), ['Execute', 'Get']); assert.equal(channel.pending.size, 0);
});

test('a refused later hand call can carry another hand outcome without transferring its refusal', async () => {
  const entry = { tool: 'Execute', label: 'slow', at: 'one', state: 'running' };
  const channel = new BoardChannel({ invoke: async (tool) => tool === 'Execute' ? result({ operations: [entry] })
    : result({ accepted: false, teaching: 'other request refused', operations: [{ ...entry, state: 'done', result: { receipt: 'settled' },
      contentWithheld: true, decision: { kind: 'allow' } }] }, true) });
  const slow = channel.call('Execute', { action: 'slow' }, { wait: { pollMs: 15, waitSeconds: 1 } });
  await immediate(); const refused = await channel.call('Get', {}, { hand: 'another' });
  assert.equal(refused.isError, true);
  const own = await slow; assert.equal(own.isError, undefined); assert.equal(decodeBoardResult(own).accepted, true);
  assert.equal(decodeBoardResult(own).result.receipt, 'settled');
  assert.equal(decodeBoardResult(own).contentWithheld, true); assert.deepEqual(decodeBoardResult(own).decision, { kind: 'allow' });
});

test('Board reads never wait on or recursively poll another hand held Artifact Get', async () => {
  const entry = { tool: 'Get', label: 'artifact', at: 'one', state: 'running' };
  let state = 'running'; let calls = 0;
  const channel = new BoardChannel({ invoke: async (_tool, args) => {
    calls++;
    if (args.artifact) return result({ accepted: true, operations: [entry] });
    return result({ accepted: true, operations: [{ ...entry, state, ...(state === 'done' ? { result: { chunk: 'artifact bytes' } } : {}) }] });
  } });
  const artifact = channel.call('Get', { artifact: { ref: 'ref' } }, { hand: 'child', wait: { pollMs: 20, waitSeconds: 1 } });
  await immediate();
  const board = await channel.call('Get', {}, { hand: 'main' });
  assert.equal(decodeBoardResult(board).operations[0].state, 'running');
  state = 'done'; await channel.call('Get', {});
  assert.equal(decodeBoardResult(await artifact).result.chunk, 'artifact bytes'); assert.equal(calls, 3);
});

test('second Set block is keyed by goal across changed fact IDs and operation order', async () => {
  const block = { verdict: 'block', node: 'g', advice: 'Criterion n is contradicted.' };
  const f = fixture([block, block]);
  const first = await f.channel.call('Set', { operations: [{ op: 'assert_fact', id: 'a', args: { goal: 'g', value: 1 } }] }, { hand: 'child' });
  const second = await f.channel.call('Set', { operations: [{ op: 'assert_fact', id: 'b', args: { goal: 'g', value: 2 } }] }, { hand: 'child' });
  assert.doesNotMatch(first.content[0].text, /again/); assert.match(second.content[0].text, /blocked this again/);
  assert.equal(f.sends.filter((s) => s.tool === 'Set').length, 0);
});

test('read/write classification uses authoritative kind or exact Worker id and manifest, never names or args', () => {
  assert.equal(isWrite('Get', { artifact: { ref: 'x' } }), false); assert.equal(isWrite('Set', {}), true);
  assert.equal(isWrite('Execute', { action: 'read', args: { kind: 'read' } }, [view]), true, 'missing manifest is uncertain');
  assert.equal(isWrite('Execute', { action: 'read' }, [view], { 'demo.inspect@1': 'read' }), false);
  assert.equal(isWrite('Execute', { action: 'write' }, [view], { 'demo.change@1': 'write' }), true);
  assert.equal(isWrite('Execute', { action: 'unknown', kind: 'read' }, [view]), true);
  assert.equal(isWrite('Execute', { action: 'x' }, [{ actions: [{ action: 'x', kind: 'read' }] }]), false);
  assert.equal(isWrite('Execute', { action: 'x' }, [{ actions: [{ action: 'x', kind: 'write', description: '[worker tool] demo.inspect@1' }] }], { 'demo.inspect@1': 'read' }), true);
  assert.equal(isWrite('Execute', { action: 'read' }, [{ actions: [...view.actions, { action: 'other_carrier', description: view.actions[0].description }] }], { 'demo.inspect@1': 'read' }), true);
  assert.equal(isWrite('Execute', { action: 'read' }, [{ ...view, actionsTruncated: true }], { 'demo.inspect@1': 'read' }), true);
});

test('Kernel actionsTruncated keeps a Worker-id lookalike Execute reviewed', async () => {
  const truncated = { ...view, actionsTruncated: true, actionsTotal: 100 };
  const f = fixture(['allow'], { invoke: async (tool, args) => {
    f.sends.push({ tool, args }); return result({ accepted: true, view: truncated });
  } });
  assert.equal(isWrite('Execute', { action: 'read' }, [truncated], { 'demo.inspect@1': 'read' }), true);
  await f.channel.call('Execute', { action: 'read' });
  assert.equal(f.reviews.length, 1); assert.equal(f.sends.at(-1).tool, 'Execute');
});

test('block matches pre-execution refusal key order and Action readiness fields exactly', () => {
  const reviewed = { ...view, actionsTruncated: true, actionsTotal: 99, actions: [
    { action: 'blocked', description: 'strip this', kind: 'write', parameters: {}, status: 'waiting', reason: 'r', why: ['w'], waits: ['n'],
      available: false, unavailableReason: 'Worker offline' },
    { action: 'ready', description: 'strip this', status: 'ready', available: true, unavailableReason: 'strip this' },
    { action: 'unknown', available: false },
  ] };
  const meta = { 'rulith/v4': { focusedGoals: ['g'] } };
  for (const tool of ['Set', 'Execute']) {
    for (const operations of [undefined, [{ tool: 'Execute', label: 'prior', at: 'one', state: 'done' }]]) {
      const position = { ...result({ accepted: true, view: reviewed, ...(operations ? { operations } : {}) }), _meta: meta };
      const blocked = blockedResult(position, 'teaching', tool);
      const answer = decodeBoardResult(blocked);
      assert.deepEqual(Object.keys(answer), ['accepted', 'requestExecuted', 'tool', 'errorCode', 'teaching', 'view', 'operations']);
      assert.deepEqual(answer, { accepted: false, requestExecuted: false, tool, errorCode: 'review_blocked', teaching: 'teaching',
        view: { ...reviewed, actions: [
          { action: 'blocked', status: 'waiting', reason: 'r', why: ['w'], waits: ['n'], available: false, unavailableReason: 'Worker offline' },
          { action: 'ready', status: 'ready' }, { action: 'unknown', available: false },
        ] }, operations: operations ?? [] });
      assert.equal(blocked.isError, true); assert.equal(blocked._meta, meta);
      assert.deepEqual(blocked.content, [{ type: 'text', text: JSON.stringify(answer) }]);
    }
  }
});

test('Get and read-only Execute are not reviewed; Set and unknown or effectful Execute are reviewed', async () => {
  const f = fixture(); await f.channel.call('Get', {}); await f.channel.call('Execute', { action: 'read' });
  assert.equal(f.logs.length, 0);
  await f.channel.call('Set', { operations: [] }); await f.channel.call('Execute', { action: 'write' });
  await f.channel.call('Execute', { action: 'unknown' }); assert.equal(f.logs.length, 3);
});

test('shipped general manifest exempts declared reads and reviews writes, commands and measurements', { skip: !kitReady() && KIT_SKIP }, () => {
  const kinds = readToolKinds(`${generalKit()}/worker-tools.json`);
  for (const [id, kind] of Object.entries(kinds)) {
    const current = { actions: [{ action: 'worker_action', description: `[worker tool] ${id}` }] };
    assert.equal(isWrite('Execute', { action: 'worker_action' }, [current], kinds), kind !== 'read', id);
  }
  assert.equal(kinds['eng.read@1'], 'read'); assert.equal(kinds['eng.run@1'], 'run');
  assert.deepEqual(readToolKinds(new URL('../../package.json', import.meta.url)), {});
  assert.deepEqual(readToolKinds(undefined), {});
});

test('allow sends exact call; note sends exact call, appends advice once and records only suggestion', async () => {
  const finding = { verdict: 'note', node: 'g', advice: 'Check the concrete criterion.' };
  const f = fixture(['allow', finding]); const args = { action: 'write', target: 'g', args: { text: 'x'.repeat(5000) } };
  await f.channel.call('Execute', args); const noted = await f.channel.call('Execute', args, { hand: 'child' });
  assert.equal(noted.content.filter((part) => part.text === deliveryNote(finding)).length, 1);
  const writes = f.sends.filter((s) => s.tool === 'Execute'); assert.ok(writes.every((s) => s.args === args));
  const suggestions = f.sends.filter((s) => s.tool === 'Set'); assert.equal(suggestions.length, 1);
  const [op] = suggestions[0].args.operations;
  assert.equal(op.op, 'assert_fact'); assert.equal(op.predicate, 'suggestion');
  assert.deepEqual(op.args, { id: op.id, node: 'g', advice: finding.advice });
  assert.equal(f.logs.length, 2, 'suggestion bypasses review');
  const later = await f.channel.call('Get', {}); assert.equal(later.content.length, 1);
});

test('block does not send or suggest; second same target for same hand escalates despite changed content', async () => {
  const block = { verdict: 'block', node: 'g', advice: 'The proposed step violates criterion n.' };
  const f = fixture([block, block, block, block]);
  const args = { action: 'write', target: 'g', args: { text: 'one' } };
  const first = await f.channel.call('Execute', args, { hand: 'child' });
  assert.equal(first.isError, true); const refused = JSON.parse(first.content[0].text);
  assert.deepEqual(Object.keys(refused), ['accepted', 'requestExecuted', 'tool', 'errorCode', 'teaching', 'view', 'operations']);
  assert.equal(refused.tool, 'Execute'); assert.deepEqual(refused.operations, []);
  assert.deepEqual(refused.view.actions, [{ action: 'read' }, { action: 'write' }]);
  assert.equal(refused.accepted, false); assert.equal(refused.errorCode, 'review_blocked'); assert.equal(refused.requestExecuted, false);
  assert.match(refused.teaching, /^Board review: /); assert.ok(refused.view.actions.every((row) => !Object.hasOwn(row, 'description')));
  const second = await f.channel.call('Execute', { ...args, args: { text: 'two' } }, { hand: 'child' });
  assert.match(second.content[0].text, /blocked this again/); assert.match(second.content[0].text, /do not retry it/);
  const other = await f.channel.call('Execute', args, { hand: 'other' }); assert.doesNotMatch(other.content[0].text, /again/);
  const target = await f.channel.call('Execute', { ...args, target: 'different' }, { hand: 'child' }); assert.doesNotMatch(target.content[0].text, /again/);
  assert.equal(f.sends.filter((s) => s.tool !== 'Get').length, 0);
});

test('failed review allows original write visibly; a refused suggestion still delivers the note once', async () => {
  const f = fixture(['bad JSON']); await f.channel.call('Set', { operations: [] });
  assert.equal(f.sends.filter((s) => s.tool === 'Set').length, 1); assert.match(f.visible[0], /fail open/);
  const note = { verdict: 'note', node: 'g', advice: 'Check criterion n.' };
  const refused = fixture([note], { invoke: async (tool) => tool === 'Set' ? result({ accepted: false }, true) : result({ accepted: true, view }) });
  const output = await refused.channel.call('Execute', { action: 'write' });
  assert.equal(output.content.filter((p) => p.text === deliveryNote(note)).length, 1); assert.match(refused.visible.at(-1), /suggestion write FAILED/);
});

function gateFixture() {
  const handlers = new Map(); const globalSections = [];
  const ctx = { on: (event, fn) => handlers.set(event, fn), systemPrompt: { section: (value) => globalSections.push(value) } };
  const children = installGate(ctx, 'approved persona');
  const agent = (id, header = {}, options = {}) => {
    const filters = [], sections = [], cleanup = [];
    return { id, options, session: { id, header }, filters, sections, cleanup,
      // dsh's registry as the gate reads it: the web tools are registered (D-1015c) beside dsh's other tools.
      ctx: { tools: { get: (name) => ['web_search', 'web_fetch', 'read', 'write', 'bash'].includes(name) ? {} : undefined,
        restrict: (filter) => filters.push(filter) }, systemPrompt: { section: (section) => sections.push(section) },
        effect: (fn) => cleanup.push(fn()) }, dispose() { for (const fn of cleanup) fn(); } };
  };
  return { children, agent, create: (agent, source = 'fresh') => handlers.get('agent/created')({ agent, source }), globalSections };
}

test('main delegates; spawn/fork/resumed children get exactly three tools and the web tools, and no further delegation', () => {
  const f = gateFixture(); const main = f.agent('main'); f.create(main);
  assert.deepEqual(main.filters[0].allow, [...TOOLS, ...DELEGATION_TOOLS, ...WEB_TOOLS]); assert.equal(handOf(main), 'main');
  assert.equal(f.globalSections[0].text, 'approved persona\n\n' + forDeployment(ADDENDUM));
  for (const [source, header] of [['fresh', { parentSession: 'main', delegationDepth: 1 }],
    ['fork', { parentSession: 'main', delegationDepth: 1, isSeeded: true }], ['resume', { parentSession: 'main', delegationDepth: 1 }]]) {
    const child = f.agent(source, header, { subagentDepth: 0 }); f.create(child, source);
    assert.deepEqual(child.filters[0].allow, [...TOOLS, ...WEB_TOOLS]); assert.equal(handOf(child), source);
    assert.equal(child.sections[0].text, 'approved persona\n\n' + forDeployment(CHILD_ADDENDUM)); assert.equal(child.sections[0].complete, true);
  }
  assert.throws(() => f.create(f.agent('grandchild', { delegationDepth: 2 }, { subagentDepth: 0 })), /depth 1/);
});

test('cap four across one-shot, continuable, fork and cold resume; teardown and rollback return capacity', () => {
  const f = gateFixture(); const live = [];
  for (const mode of ['one-shot', 'continuable', 'fork', 'resume']) {
    const child = f.agent(mode, { delegationDepth: 1, parentSession: 'main' }); f.create(child, mode); live.push(child);
  }
  assert.equal(f.children.size, 4);
  const fifth = f.agent('fifth', { delegationDepth: 1 }); assert.throws(() => f.create(fifth), /at most 4/); assert.equal(fifth.filters.length, 0);
  live[0].dispose(); f.create(fifth); assert.equal(f.children.size, 4);
  live[1].dispose();
  const broken = f.agent('rollback', { delegationDepth: 1 }); broken.ctx.systemPrompt.section = () => { throw new Error('later setup failed'); };
  assert.throws(() => f.create(broken), /later setup failed/); broken.dispose();
  assert.equal(f.children.size, 3); f.create(f.agent('replacement', { delegationDepth: 1 })); assert.equal(f.children.size, 4);
});

test('all hands use one MCP initialization, with no seat declaration or shadow connection', async () => {
  const requests = [];
  const bridge = new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 'fixture', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'single-main-session' };
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25',
      ...result({ accepted: true, view }), _meta: { 'rulith/v4': { agentId: 'fixture', focusedGoals: ['g'] } } } }), { headers });
  } });
  await bridge.initialize();
  const f = fixture(['allow'], { invoke: (tool, args) => bridge.call(tool, args) });
  await Promise.all([f.channel.call('Get', {}, { hand: 'main' }), f.channel.call('Set', { operations: [] }, { hand: 'child' })]);
  const inits = requests.filter((r) => r.method === 'initialize'); assert.equal(inits.length, 1);
  assert.deepEqual(inits[0].params.capabilities, { experimental: { 'rulith/v4': { heldCalls: 1 } } }); bridge.close();
  const source = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /seatOf|shadowBridge|holder\.seats|liveBridge\('shadow'\)/);
  const launcher = fs.readFileSync(new URL('../../harness/web/start-deep-rulith.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /s\.seats|rulith-seat-|seatArgs/);
});
