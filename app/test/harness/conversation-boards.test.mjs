import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { conversationKey, depthOf, toolsOf, DELEGATION_TOOLS } from '../../harness/subagents.mjs';
import { RulithMcp, TOOLS } from '../../harness/rulith-mcp.mjs';
import { ConversationBoards } from '../../harness/web/conversation-boards.mjs';
import { ShadowReviewer } from '../../harness/web/shadow-reviewer.mjs';
import { apply, cachedBoard } from '../../harness/web/rulith-runtime.mjs';

const agent = (id, header = {}, options = {}) => ({ session: { id, header }, options });
const main = agent('parent');
const child = agent('child', { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 });
const fork = agent('fork', { parentSession: 'parent', isSeeded: true });

test('conversation keys survive restart; delegated children share the parent, user forks own a new Board', () => {
  assert.equal(conversationKey(main), 'dsh:parent');
  assert.equal(conversationKey(agent('parent')), conversationKey(main));
  assert.equal(conversationKey(child), conversationKey(main));
  assert.equal(conversationKey(agent('cold-child', { parentSession: 'parent', delegationDepth: 1 })), 'dsh:parent');
  assert.equal(conversationKey(agent('origin-child', { parentSession: 'parent', origin: 'subagent' })), 'dsh:parent');
  assert.equal(conversationKey(agent('option-child', { parentSession: 'parent' }, { subagentDepth: 1 })), 'dsh:parent');
  assert.equal(conversationKey(fork), 'dsh:fork');
  assert.equal(conversationKey(agent('fork-child', { parentSession: 'fork', origin: 'subagent', delegationDepth: 1 })), 'dsh:fork');
  assert.equal(depthOf(fork), 0);
  assert.deepEqual(toolsOf(fork), [...TOOLS, ...DELEGATION_TOOLS]);
  for (const invalid of [undefined, 42]) {
    assert.throws(() => conversationKey(agent(invalid)), /session id refused/);
  }
  assert.throws(() => conversationKey(agent('orphan', { origin: 'subagent' })), /session id refused/);
});

test('unusual session ids have stable ASCII digest keys and remain readable through the panel', async (t) => {
  const f = fixture(t);
  for (const id of ['', 'space id', 'trailing\n', '\x00', 'non-ascii-中', 'a'.repeat(197)]) {
    const a = agent(id);
    const key = `dsh:h:${createHash('sha256').update(id).digest('hex')}`;
    assert.equal(conversationKey(a), key);
    assert.equal(conversationKey(agent('child', { parentSession: id, origin: 'subagent' })), key);
    assert.match(key, /^[\x21-\x7e]{1,200}$/);
    const holder = f.boards.holder(a);
    await holder.channel.call('Get', {});
    assert.deepEqual(cachedBoard({ boards: f.boards }, {}, id).view.goals, [key]);
  }
  // The reserved digest namespace must not collide with an ordinary printable id.
  const unusual = conversationKey(agent('space id'));
  assert.notEqual(conversationKey(agent(unusual.slice(4))), unusual);
});

test('migration documentation names lost default-Board reachability, fork semantics and discovery replacement', () => {
  const readme = fs.readFileSync(new URL('../../harness/README.md', import.meta.url), 'utf8');
  assert.match(readme, /next call[\s\S]*new, empty Board/);
  assert.match(readme, /default Board's goals and pending calls are not reachable/);
  assert.match(readme, /fork is its own conversation[\s\S]*whatever the setting/);
  assert.match(readme, /replaces another host's active session on the default Board/);
});

const refusal = (status, reason, requestExecuted) => new Response(JSON.stringify({ error: {
  code: -32000, message: 'untrusted Gateway text', data: { reason, requestExecuted },
} }), { status, headers: { 'content-type': 'application/json' } });

for (const stage of ['initialize', 'tools/call']) {
  test(`Gateway conversation_limit at ${stage} reaches the model without retries`, async (t) => {
    const f = fixture(t, { transport: (body) => body.method === stage ? refusal(429, 'conversation_limit', false) : undefined });
    const a = f.boards.holder(main);
    await assert.rejects(f.boards.request(a, 'Set', {}), /Agent.*limit.*active conversation Boards.*person.*end.*wait/i);
    assert.equal(f.requests.filter((r) => r.method === stage).length, 1);
    assert.deepEqual(f.delays, []);
  });

  test(`Gateway exploration_control_pending at ${stage} uses only bounded short retries`, async (t) => {
    const f = fixture(t, { transport: (body) => body.method === stage ? refusal(409, 'exploration_control_pending', false) : undefined });
    await assert.rejects(f.boards.request(f.boards.holder(main), 'Set', {}), /pending tier\/mode change.*blocks new conversations.*settles/i);
    assert.ok(f.requests.filter((r) => r.method === stage).length <= 3);
    assert.ok(f.delays.length <= 2 && f.delays.every((ms) => ms <= 1000));
  });
}

for (const stage of ['initialize', 'tools/call'])
for (const [status, reason, executed] of [[404, 'session_unavailable', undefined], [403, 'other_refusal', false], [200, 'rpc_refusal', false]]) {
  test(`Gateway ${reason} at ${stage} reinitializes the same key and replays an unexecuted request once`, async (t) => {
    let calls = 0;
    const f = fixture(t, { transport: (body) => {
      if (body.method === stage && ++calls === 1) return refusal(status, reason, executed);
    } });
    await f.boards.request(f.boards.holder(main), 'Set', { operations: [] });
    assert.equal(calls, 2);
    assert.equal(f.bridges.length, 2);
    assert.ok(f.bridges.every((b) => b.conversationKey === 'dsh:parent'));
    assert.deepEqual(f.delays, []);
  });
}

test('repeated unexecuted refusal is bounded and never reported as outcome unknown', async (t) => {
  const f = fixture(t, { transport: (body) => body.method === 'tools/call' ? refusal(403, 'other_refusal', false) : undefined });
  await assert.rejects(f.boards.request(f.boards.holder(main), 'Execute', {}), (error) => {
    assert.equal(error.reason, 'other_refusal');
    assert.equal(error.requestExecuted, false);
    assert.doesNotMatch(error.message, /outcome.*unknown/);
    return true;
  });
  assert.equal(f.requests.filter((r) => r.method === 'tools/call').length, 2);
});

test('recovery of a later conversation publishes its timestamp alongside an earlier attached one', async (t) => {
  const statuses = [];
  const f = fixture(t, { report: (state, detail) => statuses.push({ state, ...detail }) });
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  await f.boards.liveBridge(a); await f.boards.liveBridge(b);
  b.bridge.close();
  await f.boards.reconnectIdle();
  assert.equal(statuses.at(-1).state, 'attached');
  assert.ok(statuses.at(-1).reconnectedAt);
  assert.equal(statuses.at(-1).reconnectedAt, b.reconnectedAt);
});

test('disposing a child retains an unobserved parent until the parent is disposed', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(child);
  await a.channel.call('Get', {});
  f.boards.disposeSession(child.session);
  assert.equal(f.boards.size, 1);
  assert.equal(a.bridge.closed, false);
  f.boards.disposeSession(main.session);
  assert.equal(f.boards.size, 0);
});

test('a child observed after parent disposal does not resurrect the disposed parent ownership', (t) => {
  const f = fixture(t);
  f.boards.disposeSession(main.session);
  f.boards.holder(child);
  f.boards.disposeSession(child.session);
  assert.equal(f.boards.size, 0);
});

test('aggregate status keeps the worst live state when another conversation attaches or drops', async (t) => {
  const statuses = [];
  let release, waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const f = fixture(t, { report: (state, detail) => statuses.push({ state, ...detail }),
    wait: () => new Promise((resolve) => { release = resolve; waiting(); }) });
  t.after(() => release?.());
  const a = f.boards.holder(main);
  await f.boards.liveBridge(a); a.bridge.close();
  let failed = false;
  f.transport((body, key) => { if (key === 'dsh:parent' && body.method === 'initialize' && !failed) { failed = true; throw new Error('offline'); } });
  const reconnect = f.boards.liveBridge(a);
  await started;
  const b = f.boards.holder(fork);
  await f.boards.liveBridge(b);
  assert.equal(statuses.at(-1).state, 'reconnecting');
  assert.equal(statuses.at(-1).liveConversations, 2);
  f.boards.disposeSession(fork.session);
  assert.equal(statuses.at(-1).state, 'reconnecting');
  assert.equal(statuses.at(-1).liveConversations, 1);
  release(); await reconnect;
  assert.equal(statuses.at(-1).state, 'attached');
  assert.ok(Number.isFinite(Date.parse(statuses.at(-1).reconnectedAt)));
});

test('idle reconnect is per conversation, shares attempts, preserves channels and stops after its budget', async (t) => {
  const statuses = [];
  const f = fixture(t, { patienceMs: 1, report: (state, detail) => statuses.push({ state, ...detail }) });
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  await f.boards.liveBridge(a); await f.boards.liveBridge(b);
  const channel = a.channel;
  a.bridge.close();
  await Promise.all([f.boards.reconnectIdle(), f.boards.reconnectIdle()]);
  assert.equal(f.bridges.length, 3);
  assert.equal(a.channel, channel);
  assert.equal(b.bridge.closed, false);
  assert.ok(statuses.at(-1).reconnectedAt);
  a.bridge.close();
  f.transport((body, key) => { if (key === 'dsh:parent' && body.method === 'initialize') throw new Error('offline'); });
  await f.boards.reconnectIdle();
  const attempts = f.bridges.length;
  await f.boards.reconnectIdle();
  assert.equal(f.bridges.length, attempts, 'idle ticks do not restart an exhausted outage budget');
  assert.equal(statuses.at(-1).state, 'failed');
  assert.equal(statuses.at(-1).liveConversations, 2);
  f.transport(undefined);
  await f.boards.request(a, 'Get', {});
  assert.equal(statuses.at(-1).state, 'attached', 'a new model call can try again');
});

test('a failed write still allows proactive connection recovery without replaying the write', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(main);
  f.transport((body) => { if (body.method === 'tools/call') throw new Error('offline'); });
  await assert.rejects(f.boards.request(a, 'Set', {}), /outcome is unknown/);
  f.transport(undefined);
  await f.boards.reconnectIdle();
  assert.equal(a.bridge.closed, false);
  assert.equal(f.bridges.length, 2);
  assert.equal(f.requests.filter((r) => r.method === 'tools/call').length, 1);
});

function fixture(t, options = {}) {
  const requests = [], bridges = [], delays = [];
  let transport = options.transport;
  const connect = async (key) => {
    const bridge = new RulithMcp({ url: 'http://127.0.0.1:9/mcp', token: 'fixture', conversationKey: key,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ ...body, headers: init.headers, bridge });
        const refusal = await transport?.(body, key, bridge);
        if (refusal) return refusal;
        const headers = { 'content-type': 'application/json', 'mcp-session-id': `mcp-${bridges.indexOf(bridge)}` };
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-11-25', tools: TOOLS.map((name) => ({ name })),
          content: [{ type: 'text', text: JSON.stringify({ accepted: true, view: { goals: [key ?? 'default'] }, operations: [] }) }],
          _meta: { 'rulith/v4': { agentId: 'fixture', focusedGoals: [key ?? 'default'] } },
        } }), { headers });
      } });
    bridges.push(bridge);
    try { await bridge.initialize(); const listed = await bridge.list(); return { bridge, listed }; }
    catch (error) { bridge.close(); throw error; }
  };
  const boards = new ConversationBoards({ connect, shadow: () => new ShadowReviewer({ enabled: false }),
    wait: async (ms, signal) => {
      assert.equal(signal.aborted, false); delays.push(ms);
      assert.ok(delays.length <= 4, 'stub retry budget exceeded');
    }, ...options });
  t.after(() => boards.close());
  return { boards, requests, bridges, delays, transport: (fn) => { transport = fn; } };
}

test('two conversations lazily open distinct bridges and channels; one pending call does not block the other', async (t) => {
  const f = fixture(t);
  f.boards.observe(main); f.boards.observe(child); f.boards.observe(fork);
  assert.equal(f.boards.size, 0);
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  assert.equal(f.bridges.length, 0);
  assert.equal(f.boards.holder(child), a);
  assert.notEqual(a.channel, b.channel);
  assert.notEqual(a.channel.shadow, b.channel.shadow);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.transport(async (body, key) => { if (body.method === 'tools/call' && key === 'dsh:parent') await gate; });
  const pending = a.channel.call('Get', {});
  t.after(release);
  await setImmediate();
  await b.channel.call('Get', {});
  assert.equal(a.channel.latestBoard, null);
  assert.deepEqual(b.channel.latestBoard.view.goals, ['dsh:fork']);
  release(); await pending;
  assert.deepEqual(a.bridge.focusedGoals, ['dsh:parent']);
  assert.deepEqual(b.bridge.focusedGoals, ['dsh:fork']);
  assert.deepEqual(a.channel.latestBoard.view.goals, ['dsh:parent']);
  assert.equal(f.bridges.length, 2);
  for (const key of ['dsh:parent', 'dsh:fork']) {
    const calls = f.requests.filter((r) => r.headers['X-Rulith-Conversation'] === key);
    assert.deepEqual(calls.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.ok(calls.slice(1).every((r) => r.headers['mcp-session-id']));
  }
  assert.deepEqual(cachedBoard({ agentName: 'fixture', boards: f.boards }),
    { available: true, agentName: 'fixture', liveConversations: 2 });
});

test('header is immutable and validated; absent key preserves legacy MCP requests', async (t) => {
  for (const key of ['', 'a b', 'trailing\n', '\x7f', '中', 'a'.repeat(201), 7]) {
    assert.throws(() => new RulithMcp({ url: 'http://localhost/mcp', token: 't', conversationKey: key }), /conversation key refused/);
  }
  const f = fixture(t, { enabled: false });
  const a = f.boards.holder(main);
  assert.equal(f.boards.holder(fork), a); assert.equal(f.boards.holder(child), a);
  await a.channel.call('Get', {});
  assert.equal(f.bridges.length, 1);
  assert.ok(f.requests.every((r) => !Object.hasOwn(r.headers, 'X-Rulith-Conversation')));
  assert.throws(() => { a.bridge.conversationKey = 'changed'; }, TypeError);
  f.boards.disposeSession(main.session); f.boards.disposeSession(child.session); f.boards.disposeSession(fork.session);
  assert.equal(a.bridge.closed, false, 'legacy connection lives until Agent detach');
});

test('patient reconnect retains the key and channel state; a write with unknown outcome is never replayed', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(main);
  await a.channel.call('Get', {});
  const channel = a.channel;
  let failed = false;
  f.transport((body) => { if (body.method === 'initialize' && !failed) { failed = true; throw new Error('offline'); } });
  a.bridge.close();
  await a.channel.call('Get', {});
  assert.deepEqual(f.delays, [2000]);
  assert.equal(a.channel, channel);
  assert.equal(f.bridges.length, 3);
  assert.ok(f.requests.every((r) => r.headers['X-Rulith-Conversation'] === 'dsh:parent'));
  const writeCount = () => f.requests.filter((r) => r.method === 'tools/call' && r.params.name === 'Set').length;
  f.transport((body) => { if (body.method === 'tools/call' && body.params.name === 'Set') throw new Error('offline'); });
  await assert.rejects(f.boards.request(a, 'Set', { operations: [] }), /outcome is unknown/);
  assert.equal(writeCount(), 1);
  await a.channel.call('Get', {});
  assert.equal(writeCount(), 1);
});

test('a failed Get retries on the same conversation; initial connection attempts are shared', async (t) => {
  const f = fixture(t);
  const a = f.boards.holder(main);
  await Promise.all([f.boards.liveBridge(a), f.boards.liveBridge(a)]);
  assert.equal(f.bridges.length, 1);
  let failed = false;
  f.transport((body) => { if (body.method === 'tools/call' && !failed) { failed = true; throw new Error('offline'); } });
  await a.channel.call('Get', {});
  assert.equal(f.bridges.length, 2);
  assert.ok(f.bridges.every((b) => b.conversationKey === 'dsh:parent'));
});

test('session disposal keeps a parent Board while its child lives, then closes and recreates it with the same key', async (t) => {
  const f = fixture(t);
  f.boards.observe(main); f.boards.observe(child);
  const a = f.boards.holder(child);
  await a.channel.call('Get', {});
  f.boards.disposeSession(main.session);
  assert.equal(a.bridge.closed, false);
  f.boards.disposeSession(child.session);
  assert.equal(f.boards.size, 0); assert.equal(a.bridge.closed, true);
  assert.equal(a.channel.closed, true); assert.equal(a.channel.shadow.stopped, true);
  const reopened = f.boards.holder(agent('parent'));
  assert.notEqual(reopened, a);
  await reopened.channel.call('Get', {});
  assert.equal(reopened.bridge.conversationKey, 'dsh:parent');
});

test('disposal during an unfinished connection closes its late bridge and cannot resurrect the holder', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { transport: async (body) => { if (body.method === 'initialize') await gate; } });
  t.after(release);
  const a = f.boards.holder(main);
  const opening = f.boards.liveBridge(a);
  f.boards.disposeSession(main.session);
  release();
  await assert.rejects(opening, /Agent detached/);
  assert.equal(f.boards.size, 0); assert.ok(f.bridges.every((b) => b.closed));
});

test('a conversation waiting to reconnect cannot block another; disposal cancels its backoff', async (t) => {
  let waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const f = fixture(t, { wait: (_ms, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); waiting();
  }) });
  const a = f.boards.holder(main), b = f.boards.holder(fork);
  await a.channel.call('Get', {});
  a.bridge.close();
  f.transport((body, key) => { if (key === 'dsh:parent' && body.method === 'initialize') throw new Error('offline'); });
  const reconnect = assert.rejects(a.channel.call('Get', {}), /abort/i);
  await started;
  await b.channel.call('Get', {});
  assert.deepEqual(b.channel.latestBoard.view.goals, ['dsh:fork']);
  f.boards.disposeSession(main.session);
  await reconnect;
  assert.equal(f.boards.size, 1);
});

async function runtimeFixture(t, enabled = true, initialAgents = [], instances = null) {
  // All I/O is mocked: no manager, credentials, socket, status file or Gateway is accessed.
  const previousFlag = process.env.RULITH_DSH_CONVERSATION_BOARDS;
  process.env.RULITH_DSH_CONVERSATION_BOARDS = enabled ? '1' : '0';
  t.after(() => {
    if (previousFlag === undefined) delete process.env.RULITH_DSH_CONVERSATION_BOARDS;
    else process.env.RULITH_DSH_CONVERSATION_BOARDS = previousFlag;
  });
  const requests = [], statuses = [], definitions = [], effects = [], listeners = new Map();
  let server, tick, transport;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { assert.equal(ms, 3000); tick = fn; return 0; });
  t.mock.method(net, 'connect', (_options, callback) => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    queueMicrotask(callback); return socket;
  });
  t.mock.method(fs, 'readFileSync', (file) => {
    if (String(file).endsWith('fixture-key.txt')) return 'fixture-manager-key';
    if (String(file).endsWith('registry.json')) return JSON.stringify({ instances: instances ?? [
      { id: 'instance', mode: 'local_agent', agentId: 'fixture-agent', agentName: 'fixture', directory: 'fixture-instance' },
    ] });
    if (String(file).endsWith('local.json')) {
      const owner = (instances ?? []).find((row) => String(file).includes(row.directory));
      return JSON.stringify({ agent: { env: { RULITH_TOKEN: owner ? `token-${owner.agentId}` : 'fixture-token' } } });
    }
    throw new Error('fixture file absent');
  });
  t.mock.method(fs, 'writeFileSync', (_file, value) => statuses.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push({ ...body, headers: init.headers });
    await transport?.(body);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'fixture-mcp-session' };
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: '2025-11-25', tools: TOOLS.map((name) => ({ name, description: `fixture ${name}`, inputSchema: { type: 'object' } })),
      content: [{ type: 'text', text: JSON.stringify({ accepted: true,
        view: { goals: { directory: [{ goal: 'fixture goal', label: init.headers['X-Rulith-Conversation'] === 'dsh:fork' ? 'fork' : 'parent' }] } },
        operations: [{ label: 'fixture operation', state: 'done' }] }) }],
      _meta: { 'rulith/v4': { agentId: 'fixture' } },
    } }), { headers });
  });
  const ctx = {
    on(event, fn) {
      const handlers = listeners.get(event) ?? []; handlers.push(fn); listeners.set(event, handlers);
      if (event === 'agent/created') for (const agent of initialAgents) fn({ agent });
    },
    effect(fn) { effects.push(fn()); },
    tools: { register(def) { definitions.push(def); return () => {}; } },
    webServer: { register(route) { server = route; return () => {}; } },
  };
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  await apply(ctx, { managerHome: 'fixture-manager', runtimeEntry: 'fixture-runtime', keyFile: 'fixture-key.txt',
    conversationBoards: enabled, shadow: { enabled: false } });
  const emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
  const panel = async (query = '') => {
    let reply;
    await server.handler({ method: 'GET', url: '/rulith/api/board' + query, headers: { host: 'localhost', 'x-deep-rulith': '1' } },
      { writeHead(code) { assert.equal(code, 200); }, end(body) { reply = JSON.parse(body); } });
    return reply;
  };
  const post = async (route, body) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/rulith/api/' + route, headers: { host: 'localhost', 'x-deep-rulith': '1' } });
    let reply;
    const done = server.handler(req, { writeHead() {}, end(text) { reply = JSON.parse(text); } });
    queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
    await done;
    return reply;
  };
  return { requests, statuses, definitions, emit, panel, post, tick: () => tick(), transport: (fn) => { transport = fn; } };
}

test('runtime tick proactively recovers a failed conversation without another model call', async (t) => {
  const f = await runtimeFixture(t);
  f.emit('agent/created', { agent: main });
  f.transport((body) => { if (body.method === 'tools/call' && body.params.name === 'Set') throw new Error('offline'); });
  await assert.rejects(f.definitions.find((d) => d.name === 'Set').execute({}, { agent: main }), /outcome is unknown/);
  f.transport(undefined);
  const calls = f.requests.filter((r) => r.method === 'tools/call').length;
  await f.tick(); await setImmediate();
  assert.equal(f.statuses.at(-1).state, 'attached');
  assert.ok(f.statuses.at(-1).reconnectedAt);
  assert.equal(f.statuses.at(-1).liveConversations, 1);
  assert.equal(f.requests.filter((r) => r.method === 'tools/call').length, calls);
});

test('attachment discovers tools on the first known conversation and reuses its connection', async (t) => {
  const f = await runtimeFixture(t, true, [main]);
  assert.ok(f.requests.every((r) => r.headers['X-Rulith-Conversation'] === 'dsh:parent'));
  await f.definitions.find((d) => d.name === 'Get').execute({}, { agent: main });
  assert.equal(f.requests.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(f.statuses.at(-1).liveConversations, 1);
});

test('runtime routes registered tools by conversation, publishes only aggregate status, and disposes on dsh events', async (t) => {
  const { requests, statuses, definitions, emit, panel } = await runtimeFixture(t);
  assert.deepEqual(definitions.map((d) => [d.name, d.description]), TOOLS.map((name) => [name, `fixture ${name}`]));
  assert.deepEqual(requests.map((r) => r.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(requests.every((r) => r.headers['X-Rulith-Conversation'] === undefined), 'attachment only discovers tools');
  emit('agent/created', { agent: main }); emit('agent/created', { agent: child }); emit('agent/created', { agent: fork });
  const get = definitions.find((d) => d.name === 'Get');
  for (const agent of [main, child, fork]) await get.execute({}, { agent });
  assert.deepEqual(requests.filter((r) => r.method === 'tools/call').map((r) => r.headers['X-Rulith-Conversation']),
    ['dsh:parent', 'dsh:parent', 'dsh:fork']);
  assert.equal(requests.filter((r) => r.method === 'initialize').length, 3, 'discovery plus two conversations');
  assert.equal(statuses.at(-1).liveConversations, 2);
  assert.deepEqual(await panel(), { ok: true, available: true, agentName: 'fixture', liveConversations: 2 });
  emit('session/disposed', main.session); assert.equal(statuses.at(-1).liveConversations, 2);
  emit('session/disposed', child.session); assert.equal(statuses.at(-1).liveConversations, 1);
  emit('session/disposed', fork.session); assert.equal(statuses.at(-1).liveConversations, 0);
  assert.doesNotMatch(JSON.stringify(statuses), /dsh:|fixture-token|fixture-manager-key|fixture-mcp-session/);
});

test('Board endpoint reads only the requested session cache, including children and cold sessions', async (t) => {
  const { requests, definitions, emit, panel } = await runtimeFixture(t);
  for (const a of [main, child, fork, agent('unused')]) emit('agent/created', { agent: a });
  const empty = { ok: true, available: true, agentName: 'fixture', view: null };
  const discoveryCount = requests.length;
  for (const id of ['parent', 'child', 'fork', 'unused', 'unknown', 'dsh:parent', 'a'.repeat(196), 'punctuation!~?#&=+%'])
    assert.deepEqual(await panel('?session=' + encodeURIComponent(id)), empty);
  assert.equal(requests.length, discoveryCount, 'empty panel reads do not call MCP');
  assert.equal((await panel()).liveConversations, 0, 'panel reads do not create holders');
  const get = definitions.find((d) => d.name === 'Get');
  await get.execute({}, { agent: main }); await get.execute({}, { agent: fork });
  const before = requests.length;
  const parent = await panel('?session=parent');
  assert.equal(parent.view.goals.directory[0].label, 'parent');
  assert.deepEqual(parent.operations, [{ label: 'fixture operation', state: 'done' }]);
  assert.ok(Number.isFinite(Date.parse(parent.seenAt)));
  assert.deepEqual(Object.keys(parent).sort(), ['ok', 'available', 'agentName', 'view', 'operations', 'seenAt'].sort());
  assert.deepEqual(await panel('?session=child'), parent);
  const other = await panel('?session=fork');
  assert.equal(other.view.goals.directory[0].label, 'fork');
  assert.deepEqual(await panel('?session=unused'), empty);
  assert.deepEqual(await panel('?session=unknown'), empty);
  assert.deepEqual(await panel(), { ok: true, available: true, agentName: 'fixture', liveConversations: 2 });
  for (const id of ['', 'space id', 'trailing\n', '\x00', '\x7f', '中文', 'a'.repeat(197)])
    assert.deepEqual(await panel('?session=' + encodeURIComponent(id)), empty);
  assert.equal(requests.length, before, 'panel reads with opaque session ids never call MCP');
  assert.equal((await panel()).liveConversations, 2, 'panel reads do not create holders');
  assert.doesNotMatch(JSON.stringify([parent, other, empty]), /dsh:|fixture-token|fixture-manager-key|fixture-mcp-session/);
  emit('session/disposed', main.session);
  assert.deepEqual(await panel('?session=parent'), empty);
  assert.deepEqual(await panel('?session=child'), parent, 'child still maps to the retained parent Board');
});

test('Board endpoint preserves the shared cached Board with the feature off, regardless of session', async (t) => {
  const { requests, definitions, emit, panel } = await runtimeFixture(t, false);
  const empty = { ok: true, available: true, agentName: 'fixture' };
  assert.deepEqual(await panel(), empty);
  assert.deepEqual(await panel('?session=unknown'), empty);
  emit('agent/created', { agent: main }); emit('agent/created', { agent: child });
  await definitions.find((d) => d.name === 'Get').execute({}, { agent: main });
  const before = requests.length;
  const shared = await panel();
  assert.equal(shared.view.goals.directory[0].label, 'parent');
  for (const id of ['parent', 'child', 'unknown']) assert.deepEqual(await panel('?session=' + id), shared);
  assert.deepEqual(await panel('?session='), shared);
  assert.equal(requests.length, before);
  assert.ok(requests.every((r) => r.headers['X-Rulith-Conversation'] === undefined));
});

test('every paired Agent is attached at once; tool calls go to the Agent the conversation belongs to, which then stays fixed', async (t) => {
  const f = await runtimeFixture(t, true, [], [
    { id: 'instance-a', mode: 'local_agent', agentId: 'agent-a', agentName: 'alpha', directory: 'dir-a' },
    { id: 'instance-b', mode: 'local_agent', agentId: 'agent-b', agentName: 'beta', directory: 'dir-b' },
    { id: 'instance-c', mode: 'local_agent', agentId: 'agent-c', agentName: 'gone', directory: 'dir-c', signedOutAt: '2026-10-17' },
  ]);
  assert.deepEqual(f.definitions.map((d) => d.name), TOOLS, 'the three tools are registered once for all Agents');
  assert.deepEqual([...new Set(f.requests.map((r) => r.headers.authorization))].sort(), ['Bearer token-agent-a', 'Bearer token-agent-b'],
    'both paired Agents were discovered; the signed-out instance was not');
  const other = agent('other');
  assert.deepEqual((await f.post('sessions/assign', { session: 'other', agentId: 'agent-b' })).agentId, 'agent-b');
  f.emit('agent/created', { agent: main }); f.emit('agent/created', { agent: other });
  const get = f.definitions.find((d) => d.name === 'Get');
  const before = f.requests.length;
  await get.execute({}, { agent: other }); await get.execute({}, { agent: main });
  const calls = f.requests.slice(before).filter((r) => r.method === 'tools/call');
  assert.deepEqual(calls.map((r) => [r.headers['X-Rulith-Conversation'], r.headers.authorization]),
    [['dsh:other', 'Bearer token-agent-b'], ['dsh:parent', 'Bearer token-agent-a']],
    'the assigned conversation uses beta; the unassigned one uses the default (first attached) Agent');
  const moved = await f.post('sessions/assign', { session: 'parent', agentId: 'agent-b' });
  assert.equal(moved.ok, false, 'a conversation that has a Board keeps its Agent');
  assert.match(moved.teaching, /already works on another Agent/);
  assert.equal((await f.post('sessions/assign', { session: 'x', agentId: 'agent-c' })).ok, false, 'an Agent not set up here cannot take a conversation');
  assert.equal((await f.panel('?session=other')).agentName, 'beta', 'the panel reads the conversation\'s own Agent');
  assert.equal(f.statuses.at(-1).liveConversations, 2);
});
