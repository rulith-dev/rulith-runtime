import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { consoleGoalsUrl } from '../../harness/web/rulith-runtime.mjs';
import { installProjectContext, projectLine, readSourceBindings, reconcileProjectContext, resolveProject } from '../../harness/web/project-source.mjs';

const windowsSources = [
  { name: 'lab', type: 'file', location: 'D:\\Work\\strixllama' },
  { name: 'rulith-java', type: 'file', location: 'D:\\Work\\rulith-java' },
];

test('project resolution: exact, nested, Windows case/separators, and no match', () => {
  for (const cwd of ['D:\\Work\\rulith-java', 'D:/Work/rulith-java/src/main', 'd:/WORK/RULITH-JAVA/', 'D:\\Work\\rulith-java\\src/../test'])
    assert.deepEqual(resolveProject(cwd, windowsSources, 'win32'), { name: 'rulith-java', directory: 'D:\\Work\\rulith-java' });
  for (const cwd of ['D:/Work/rulith-java-other', 'D:/Work', 'E:/Work/rulith-java', '', undefined])
    assert.equal(resolveProject(cwd, windowsSources, 'win32'), null);
  assert.equal(resolveProject('D:/Work/strixllama', windowsSources, 'win32').name, 'lab');
});

test('deepest approved file directory wins; roots, UNC, POSIX case and non-file Sources', () => {
  const sources = [{ name: 'parent', type: 'file', location: 'D:/Work' }, ...windowsSources,
    { name: 'database', type: 'db', location: 'D:/Work/rulith-java/src' },
    { name: 'relative', type: 'file', location: 'rulith-java/src' }];
  assert.equal(resolveProject('D:/Work/rulith-java/src', sources, 'win32').name, 'rulith-java');
  assert.equal(resolveProject('D:/Work/x', [{ name: 'drive', type: 'file', location: 'D:/' }], 'win32').name, 'drive');
  assert.equal(resolveProject('//SERVER/share/project/src', [{ name: 'unc', type: 'file', location: '\\\\server\\share\\project\\' }], 'win32').name, 'unc');
  const posix = [{ name: 'java', type: 'file', location: '/work/Java/' }];
  assert.equal(resolveProject('/work/Java/src', posix, 'linux').name, 'java');
  assert.equal(resolveProject('/work/java/src', posix, 'linux'), null);
  assert.equal(resolveProject('/work/Java-other', posix, 'linux'), null);
});

test('both model lines and their documentation keep the exact project wording', () => {
  assert.equal(projectLine('D:/Work/rulith-java', { name: 'rulith-java', directory: 'D:\\Work\\rulith-java' }),
    'This conversation\'s project is Source "rulith-java" (D:\\Work\\rulith-java). Use source "rulith-java" for project files unless the user names another approved project.');
  assert.equal(projectLine('D:/Work/other', null),
    'This workspace (D:/Work/other) is not an approved Rulith project; project file Actions cannot reach it until the owner opens it as a project in Deep Rulith (Agents with the official engineering capability) or adds it in Console (other Agents).');
  const doc = fs.readFileSync(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(projectLine('<directory>', { name: '<name>', directory: '<directory>' })));
  assert.ok(doc.includes(projectLine('<directory>', null)));
});

// Identified messages, step admission and surface replacement are the dsh interfaces used by the host.
function session(cwd) {
  const log = [], surface = { nodes: [] };
  return { header: { cwd }, log, surface, eventAt: (seq) => log[seq],
    append(type, data, opts = { surfaceOp: 'append' }) {
      const seq = log.length; log.push({ seq, type, data, ...opts });
      if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = seq;
      else surface.nodes.push(seq);
    },
    texts() { return surface.nodes.flatMap((seq) => (log[seq].data.content ?? []).map((block) => block.text ?? '')); },
  };
}
const user = (text) => ({ id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
function contextHarness(read) {
  let beforeStep;
  installProjectContext({ on(name, handler) { assert.equal(name, 'agent/pre-step'); beforeStep = handler; } }, read);
  return async (s, step, messages = []) => {
    const decision = await beforeStep({ agent: { session: s }, step }, async () => ({ kind: 'enter', messages }));
    for (const message of decision.messages) s.append('user/message', message);
    return decision;
  };
}
const work = process.platform === 'win32' ? 'D:/Work' : '/work';
const sources = [{ name: 'lab', type: 'file', location: work + '/strixllama' },
  { name: 'rulith-java', type: 'file', location: work + '/rulith-java' }];
const projectTexts = (s) => s.texts().filter((text) => text.startsWith('This conversation\'s project') || text.startsWith('This workspace'));

test('one correct project line per turn context across tool steps, turns, resume and independent conversations', async () => {
  const run = contextHarness(async () => sources);
  const java = session(work + '/rulith-java/src'), lab = session(work + '/strixllama');
  for (const s of [java, lab]) {
    await run(s, 1, [user('first turn')]);
    await run(s, 2);
    await run(s, 3);
    await run(s, 1, [user('second turn')]);
    await contextHarness(async () => sources)(s, 2); // A fresh hook resumes the retained surface.
    assert.equal(projectTexts(s).length, 1);
    assert.equal(s.log.filter((e) => e.data.source?.kind === 'rulith-project').length, 1);
  }
  assert.deepEqual(projectTexts(java), [projectLine(java.header.cwd, { name: 'rulith-java', directory: sources[1].location })]);
  assert.deepEqual(projectTexts(lab), [projectLine(lab.header.cwd, { name: 'lab', directory: sources[0].location })]);
});

test('no match emits the unapproved-workspace line; a changed Source replaces the context', async () => {
  let bindings = [];
  const run = contextHarness(async () => bindings), s = session(work + '/rulith-java');
  await run(s, 1, [user('work')]);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, null)]);
  bindings = sources;
  await run(s, 1, [user('now approved')]);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, { name: 'rulith-java', directory: sources[1].location })]);
  assert.equal(s.log[1].data.content[0].text, projectLine(s.header.cwd, null), 'the original is still in the log');
  bindings = [];
  await run(s, 2);
  assert.deepEqual(projectTexts(s), [projectLine(s.header.cwd, null)]);
});

test('unreadable Sources clear stale context, emit no project line and log visibly without error secrets', async (t) => {
  const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const s = session(work + '/rulith-java');
  await contextHarness(async () => sources)(s, 1, [user('work')]);
  const unavailable = contextHarness(async () => { throw new Error('private fetch detail'); });
  await unavailable(s, 1, [user('next turn')]);
  assert.deepEqual(projectTexts(s), []);
  const fresh = session(work + '/rulith-java');
  await unavailable(fresh, 1, [user('work')]);
  assert.deepEqual(projectTexts(fresh), []);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((line) => line.includes('[rulith project]') && line.includes('Sources cannot be read')));
  assert.ok(errors.every((line) => !line.includes('private fetch detail')));
  await contextHarness(async () => sources)(s, 2);
  assert.equal(projectTexts(s).length, 1, 'read recovery reuses the cleared context');
});

test('compaction restores context, duplicate retained copies are cleared, and empty/rejected steps add nothing', async () => {
  const s = session(work + '/rulith-java'), run = contextHarness(async () => sources);
  await run(s, 1);
  assert.equal(s.log.length, 0, 'no incoming turn');
  await run(s, 1, [user('work')]);
  const message = s.log[1].data;
  s.surface.nodes = []; // Compaction removed the entire old surface span.
  await run(s, 2);
  assert.equal(projectTexts(s).length, 1);
  s.append('user/message', message);
  reconcileProjectContext(s, message.content[0].text);
  assert.equal(projectTexts(s).length, 1);
  let handler, reads = 0;
  installProjectContext({ on(_name, cb) { handler = cb; } }, async () => { reads++; return sources; });
  assert.deepEqual(await handler({ agent: { session: s }, step: 1 }, async () => ({ kind: 'reject' })), { kind: 'reject' });
  assert.equal(reads, 0);
});

test('Source reader reuses the existing Worker channel and projects only binding metadata (mock fetch, no network)', async () => {
  const env = { RULITH_WORK_URL: 'https://example.invalid/work', RULITH_CONNECTION: 'fixture-id', RULITH_CONNECTION_KEY: 'fixture-key' };
  const seen = [];
  const rows = await readSourceBindings(env, async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ sources: [{ name: 'rulith-java', type: 'file', access: 'D:/Work/rulith-java', private: 'excluded' }] }) };
  });
  assert.deepEqual(rows, [{ name: 'rulith-java', type: 'file', location: 'D:/Work/rulith-java' }]);
  assert.equal(seen[0].url, env.RULITH_WORK_URL + '/sources');
  assert.deepEqual(seen[0].init.headers, { 'x-rulith-connection': 'fixture-id', 'x-rulith-connection-key': 'fixture-key' });
  assert.equal(seen[0].init.redirect, 'error');
  await assert.rejects(readSourceBindings({}, () => { throw new Error('must not fetch'); }), /not configured/);
  await assert.rejects(readSourceBindings(env, async () => ({ ok: false, status: 403 })), /answered 403/);
  await assert.rejects(readSourceBindings(env, async () => ({ ok: true, json: async () => ({}) })), /unreadable/);
  assert.deepEqual(await readSourceBindings(env, async () => ({ ok: true, json: async () => ({ sources: [] }) })), []);
});

test('Board panel renders cached goals and acceptance attention with an on-demand workbench link', async () => {
  let plugin, column, columnProps;
  const requests = [], opened = [];
  const win = { location: { replace: url => opened.push(url) }, close() {} };
  const cwd = work + '/rulith-java';
  let values, index;
  const React = { createElement: (tag, props, ...children) => typeof tag === 'function' ? tag(props) : ({ tag, props, children }),
    useState: (initial) => [index < values.length ? values[index++] : initial, () => {}], useEffect() {}, useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { open: () => win, __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, setTimeout() {},
    fetch: async (url, init) => { requests.push({ url, init }); return { json: async () => ({ ok: true, url: 'http://workbench.fixture/' }) }; },
  });
  plugin.apply({ effect() {}, inject() {}, sidebarRight: { mounted: { subscribe() {}, getSnapshot: () => 'java-conversation' } },
    slots: { inject(_name, fn) { if (fn.constructor.name !== 'GeneratorFunction') fn(); },
      register(opts, component) { if (opts.name === 'sidebar.right.pane.tab') { column = component; columnProps = opts.inject(); } } } });
  const seenAt = '2026-10-13T08:09:10.000Z';
  const boardData = { ok: true, available: true, view: {}, operations: [{ label: 'cached operation', state: 'done' }], seenAt };
  const render = (workspace, data = boardData, health = null) => {
    index = 0;
    values = [{ ok: true, workspace, project: { name: 'rulith-java' } },
      data, { ok: true, available: true, state: 'online' }, health];
    return column({ ...columnProps, useSessions: (selector) => selector({ byId: { 'java-conversation': { cwd } } }) });
  };
  const workerBlock = render(cwd).children.find((node) => node?.children?.[0]?.children?.[0]?.children?.[0] === '本机执行（Worker）');
  assert.equal(workerBlock.children[0].children[1].children[0], 'rulith-java');
  const stale = render(work + '/strixllama').children.find((node) => node?.children?.[0]?.children?.[0]?.children?.[0] === '本机执行（Worker）');
  assert.equal(stale.children[0].children[1], null);
  const texts = (node) => typeof node === 'string' ? [node] : (node?.children ?? []).flat(Infinity).flatMap(texts);
  const received = texts(render(cwd));
  assert.ok(received.includes('cached operation'));
  assert.ok(received.includes('最近收到 Board：' + new Date(seenAt).toLocaleString()));
  assert.deepEqual(texts(render(cwd, { ok: true, available: true })), ['还没有 Board 视图。']);
  assert.deepEqual(texts(render(cwd, { ok: true, available: true, agentName: 'fixture', liveConversations: 2 })),
    ['还没有 Board 视图。']);
  const attention = render(cwd, { ...boardData, view: { goals: { directory: [
    { goal: 'root', label: '完成请求', status: 'running', awaiting: 'acceptance' },
    { goal: 'other', label: '等决定的请求', status: 'running', awaiting: 'decision' },
    { goal: 'unnamed', status: 'running', awaiting: 'acceptance' },
  ] } } });
  // Without a consoleUrl the row says it can only open the local workbench.
  const local = '（未设置 consoleUrl：这里只能打开本机 Rulith）';
  assert.ok(texts(attention).includes('验收待签字／待确认：完成请求 — 在 Console 的目标页签字或验收' + local));
  assert.ok(texts(attention).includes('验收待签字／待确认：unnamed — 在 Console 的目标页签字或验收' + local));
  assert.ok(!texts(attention).some(text => text.startsWith('验收待签字／待确认：等决定')));
  assert.equal(requests.length, 0, 'rendering acceptance never requests a key or another Board view');
  const nodes = node => typeof node !== 'object' || node === null ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(nodes)];
  const link = nodes(attention).find(node => node.tag === 'button' && node.children[0] === '打开本机 Rulith');
  await link.props.onClick();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/rulith/api/workbench');
  assert.equal(requests[0].init.method, 'POST'); assert.deepEqual(opened, ['http://workbench.fixture/']);
  assert.equal(win.opener, null);
  assert.ok(!texts(render(cwd)).some(text => text.startsWith('验收待签字／待确认：')), 'a later view clears stale attention');
  // With a consoleUrl the row links to the Agent's cases in Console, where the person signs; no workbench button.
  const goalsUrl = 'https://console.fixture/console/#/cases?agentId=agent-1';
  const signed = render(cwd, { ...boardData, view: { goals: { directory: [{ goal: 'root', label: '完成请求', awaiting: 'acceptance' }] } } },
    { ok: true, available: true, items: [], goalsUrl });
  assert.ok(texts(signed).includes('验收待签字／待确认：完成请求 — 在 Console 的目标页签字或验收'));
  const anchor = nodes(signed).find(node => node.tag === 'a');
  assert.equal(anchor.props.href, goalsUrl); assert.equal(anchor.children[0], '在 Console 处理');
  assert.ok(!nodes(signed).some(node => node.tag === 'button' && node.children[0] === '打开本机 Rulith'));
  const unsafe = render(cwd, { ...boardData, view: { goals: { directory: [{ goal: 'root', awaiting: 'acceptance' }] } } },
    { ok: true, available: true, items: [], goalsUrl: 'javascript:alert(1)' });
  assert.ok(!nodes(unsafe).some(node => node.tag === 'a'), 'only an http(s) Console address becomes a link');
});

test('Board panel polls the mounted sidebar session immediately and changes its content key on a session switch', async () => {
  let plugin, column, injected, mounted = 'first?&+#%';
  const subscriptions = [], effects = [], requests = [], timers = [], cleared = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: (initial) => [initial, () => {}], useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
    useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => {}); return snapshot(); },
  };
  const store = { subscribe(fn) { subscriptions.push(fn); return () => {}; }, getSnapshot: () => mounted };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, setTimeout() {},
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval: (id) => cleared.push(id),
    fetch: async (url) => { requests.push(url); return { json: async () => ({ ok: true, available: true, view: null }) }; },
  });
  plugin.apply({ effect() {}, inject() {}, sidebarRight: { mounted: store },
    slots: { inject(_name, fn) { if (fn.constructor.name !== 'GeneratorFunction') fn(); },
      register(opts, component) {
        if (opts.name === 'sidebar.right.pane.tab') { column = component; injected = opts.inject(); }
      } } });
  const render = () => column({ ...injected, sessionId: 'unrelated-page-session', useSessions: (selector) => selector({ byId: {} }) });
  const first = render();
  assert.equal(first.props.sessionId, mounted, 'the sidebar mounted session takes precedence over a generic page prop');
  assert.equal(first.props.key, mounted);
  first.tag(first.props);
  const cleanups = effects.splice(0).map((fn) => fn());
  assert.ok(requests.includes('/rulith/api/board?session=' + encodeURIComponent(mounted)));
  assert.equal(subscriptions.length, 1, 'the panel subscribes to sidebar session changes');
  for (const dispose of cleanups) dispose(); // React unmounts the old keyed content.
  assert.equal(cleared.length, 4, 'all old session polling timers are cleaned up');
  mounted = 'second-session';
  subscriptions[0]();
  const second = render();
  assert.equal(second.props.sessionId, mounted);
  assert.notEqual(second.props.key, first.props.key, 'changing the session resets cached state and pending poll ownership');
  second.tag(second.props);
  for (const fn of effects.splice(0)) fn();
  assert.ok(requests.includes('/rulith/api/board?session=second-session'), 'session switches fetch immediately without waiting for a timer');
  assert.ok(requests.every((url) => url !== '/rulith/api/board'), 'no unscoped Board request');
  mounted = undefined;
  assert.equal(render(), null, 'an unmounted sidebar does not poll a default Board');
});

test('the Console goal link comes only from a configured http(s) consoleUrl and the selected Agent', () => {
  assert.equal(consoleGoalsUrl('https://rulith.ai/anything?x=1', 'agent 1'), 'https://rulith.ai/console/#/cases?agentId=agent%201');
  assert.equal(consoleGoalsUrl('http://127.0.0.1:5173', 'a'), 'http://127.0.0.1:5173/console/#/cases?agentId=a');
  for (const [url, agent] of [[undefined, 'a'], ['', 'a'], ['https://rulith.ai', ''], ['not a url', 'a'], ['javascript:alert(1)', 'a']])
    assert.equal(consoleGoalsUrl(url, agent), '');
});

test('the composer tool row carries this conversation\'s exploration mode and review controls, read for that session only', async () => {
  let plugin, controls, injectControls;
  const requests = [], effects = [];
  // Hook state by call order, as React keeps it: a setter's value is what the next render reads.
  const cells = []; let cursor = 0;
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children: children.flat(Infinity).filter(Boolean) }),
    useState: (initial) => { const i = cursor++; if (!(i in cells)) cells[i] = initial;
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn),
    useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => {}); return snapshot(); },
  };
  const reply = { ok: true, found: true, reviewer: 'conn-1', connections: [{ connectionId: 'conn-1', name: 'Workspace' }],
    conversation: { boardId: 'b', postCallReview: true, explorationModes: { 'conn-1': 'strict' } } };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, setTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    fetch: async (url) => { requests.push(url); return { json: async () => reply }; },
  });
  plugin.apply({ effect() {}, inject() {}, sidebarRight: { mounted: { subscribe() { return () => {}; }, getSnapshot: () => undefined } },
    slots: { inject(_name, fn) { if (fn.constructor.name !== 'GeneratorFunction') fn(); },
      register(opts, component) { if (opts.name === 'conversation.input.left') { controls = component; injectControls = opts.inject; } } } });
  assert.ok(controls, 'the plugin registers a composer-row control');
  assert.equal(injectControls('session-9').sessionId, 'session-9', 'a session-scoped slot receives the session id positionally');
  // First render: nothing is known yet, so nothing is drawn; the poll for THIS session starts.
  cursor = 0; assert.equal(controls({ sessionId: 'session-9' }), null);
  for (const fn of effects.splice(0)) await fn();
  await new Promise((resolve) => setImmediate(resolve)); // the poll's fetch settles and its setter runs
  assert.deepEqual(requests, ['/rulith/api/conversation?session=session-9']);
  // With the reply in state, the row shows the mode chip and the review chip for this conversation.
  const flatten = (node, out = []) => { if (!node || typeof node !== 'object') return out; out.push(node); for (const child of node.children || []) flatten(child, out); return out; };
  cursor = 0; const rendered = flatten(controls({ sessionId: 'session-9' }));
  const text = (node) => flatten(node).filter((n) => typeof n === 'string').join('');
  const strings = rendered.flatMap((n) => n.children || []).filter((c) => typeof c === 'string');
  assert.ok(strings.some((t) => t.includes('探索：严格')), 'the exploration chip names this conversation\'s current tier');
  assert.ok(strings.some((t) => t.includes('审查：开')), 'the review chip shows this conversation\'s switch');
  assert.ok(rendered.some((n) => n.props && n.props['data-rulith-composer'] === 'session-9'));
  void text;
  // A conversation without a Board yet still shows both chips, reading "默认": a choice will open the Board first.
  reply.found = false; delete reply.conversation;
  cells.length = 0; cursor = 0; assert.equal(controls({ sessionId: 'session-new' }), null);
  for (const fn of effects.splice(0)) await fn();
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0; const freshStrings = flatten(controls({ sessionId: 'session-new' })).flatMap((n) => n.children || []).filter((c) => typeof c === 'string');
  assert.ok(freshStrings.some((t) => t.includes('探索：默认')), 'no Board yet: the exploration chip reads 默认');
  assert.ok(freshStrings.some((t) => t.includes('审查：默认')), 'no Board yet: the review chip reads 默认');
});

test('a conversation that never called Rulith is addressed by the key of its session id, and a holder can be made for it', async () => {
  const { ConversationBoards } = await import('../../harness/web/conversation-boards.mjs');
  const { conversationKey } = await import('../../harness/subagents.mjs');
  let connected = [];
  const boards = new ConversationBoards({ enabled: true, shadow: () => null, toolKinds: {}, report() {},
    connect: async (key) => { connected.push(key); return { bridge: { closed: false, focusedGoals: [], close() {}, call: async () => ({}) } }; } });
  const key = conversationKey({ session: { id: 'session-never' } });
  assert.equal(key, 'dsh:session-never');
  assert.equal(boards.holders.size, 0);
  await boards.ensureBoard(key);
  assert.deepEqual(connected, ['dsh:session-never'], 'ensureBoard opens exactly this conversation, once');
  await boards.ensureBoard(key);
  assert.equal(connected.length, 1, 'an open Board is not reopened');
  boards.close();
});

test('the sidebar groups conversations Agent -> directory -> conversation, active Agents first, idle ones folded', () => {
  let plugin;
  const React = { createElement: () => null, useState: (v) => [v, () => {}], useCallback: (f) => f, useEffect() {}, useSyncExternalStore: (_s, g) => g() };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } }, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout() {}, setInterval() { return 1; }, clearInterval() {}, fetch: async () => ({ json: async () => ({}) }),
  });
  const now = Date.now();
  const tree = { defaultAgentId: 'a', assignments: { s4: 'b' }, agents: [
    { agentId: 'a', name: 'alpha', attached: true, directories: [{ path: 'D:\\Work\\game', label: 'game', source: 'game' }] },
    { agentId: 'b', name: 'beta', attached: true, directories: [{ path: 'D:\\run\\agents\\beta', label: '工作台', source: null }] },
    { agentId: 'c', name: 'gamma', attached: false, directories: [] },
  ] };
  const row = (id, cwd, updatedAt, extra = {}) => ({ id, cwd, updatedAt, running: false, blank: false, title: 'T' + id, ...extra });
  const list = { ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], byId: {
    s1: row('s1', 'd:/work/game/', now - 10 * 86400000),                 // alpha by directory (path compared loosely)
    s2: row('s2', 'C:\\elsewhere', now - 20 * 86400000),                 // unassigned, unknown dir: unowned, folded
    s3: row('s3', 'D:\\Work\\game', now - 1000, { running: false }),     // alpha
    s4: row('s4', 'D:\\Work\\game', now - 2000, { running: true }),      // assigned to beta although it runs in alpha's dir
    s5: row('s5', 'D:\\Work\\game', now, { blank: true }),               // blank and not current: hidden
    s6: row('s6', 'D:\\Work\\game', now, { origin: 'subagent' }),       // a hand: hidden
    s7: row('s7', 'D:\\Work\\game', now),                                 // archived: hidden
  } };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // values made in the plugin's realm
  const view = plugin.buildTree({ tree, list, workspaces: { archivedSessionIds: ['s7'], pinnedSessionIds: [] }, current: 's3', filter: '', collapsed: {} });
  assert.deepEqual(plain(view.agents.map((e) => e.agent.name)), ['beta', 'alpha', 'gamma'], 'running first, then recent; not set up last');
  const alpha = view.agents.find((e) => e.agent.agentId === 'a');
  assert.deepEqual(plain(alpha.dirs.map((d) => [d.label, d.sessions.map((s) => s.id)])), [['game', ['s3', 's1']]]);
  assert.deepEqual(plain(view.others.dirs.map((d) => [d.label, d.sessions.map((s) => s.id)])), [['elsewhere', ['s2']]]);
  assert.equal(view.others.open, false, 'conversations no Agent owns wait folded');
  assert.equal(alpha.open, true, 'the Agent holding the current conversation is open');
  const beta = view.agents.find((e) => e.agent.agentId === 'b');
  assert.deepEqual(plain(beta.dirs.map((d) => [d.label, d.sessions.map((s) => s.id)])), [['工作台', []], ['game', ['s4']]]);
  assert.equal(view.agents.find((e) => e.agent.agentId === 'c').open, false, 'an idle Agent is folded');
  const stored = plugin.buildTree({ tree, list, workspaces: {}, current: 's3', filter: '', collapsed: { a: true } });
  assert.equal(stored.agents.find((e) => e.agent.agentId === 'a').open, false, 'the person\'s fold is remembered');
  const filtered = plugin.buildTree({ tree, list, workspaces: {}, current: null, filter: 'ts4', collapsed: {} });
  assert.deepEqual(plain(filtered.agents.map((e) => [e.agent.name, e.count])), [['beta', 1]]);
});
