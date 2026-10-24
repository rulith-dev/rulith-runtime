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
    'This workspace (D:/Work/other) is not an approved Rulith project; project file Actions cannot reach it until the owner opens it as a project in the Rulith app (Agents with the official engineering capability) or adds it in Console (other Agents).');
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

test('Board panel polls the mounted sidebar session immediately and changes its content key on a session switch', async () => {
  let plugin, column, injected, mounted = 'first?&+#%';
  const subscriptions = [], effects = [], requests = [], timers = [], cleared = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: (initial) => [initial, () => {}], useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
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
  // The 任务 panel polls four reads of this conversation: its cached results, its state, this computer and its Agent's pending call.
  assert.deepEqual(requests.map((url) => url.split('?')[0]).sort(), ['/rulith/api/board', '/rulith/api/conversation', '/rulith/api/health', '/rulith/api/worker']);
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

test('the composer tool row carries this conversation\'s one tier, its model and the review switch, read for that session only', async () => {
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
  const model = { ok: true, model: { source: 'default', modelId: 'deepseek-flash', name: 'deepseek-flash', configured: true, keyConfigured: true } };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, setTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    fetch: async (url) => { requests.push(url); return { json: async () => (url.includes('/model?') ? model : reply) }; },
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
  assert.deepEqual(requests, ['/rulith/api/conversation?session=session-9', '/rulith/api/model?session=session-9']);
  // With the reply in state, the row shows the mode chip and the review chip for this conversation.
  const flatten = (node, out = []) => { if (!node || typeof node !== 'object') return out; out.push(node); for (const child of node.children || []) flatten(child, out); return out; };
  cursor = 0; const rendered = flatten(controls({ sessionId: 'session-9' }));
  const text = (node) => flatten(node).filter((n) => typeof n === 'string').join('');
  const strings = rendered.flatMap((n) => n.children || []).filter((c) => typeof c === 'string');
  assert.ok(strings.some((t) => t.includes('档位：严格')), 'the tier chip names this conversation\'s current tier');
  assert.ok(strings.some((t) => t.includes('模型：deepseek-flash')), 'the model chip names the model in force');
  assert.ok(strings.some((t) => t.includes('审查：开')), 'the review chip shows this conversation\'s switch');
  assert.ok(rendered.some((n) => n.props && n.props['data-rulith-composer'] === 'session-9'));
  void text;
  // A conversation without a Board yet still shows the tier and review chips, reading "默认": a choice will open the Board first.
  reply.found = false; delete reply.conversation;
  cells.length = 0; cursor = 0; assert.equal(controls({ sessionId: 'session-new' }), null);
  for (const fn of effects.splice(0)) await fn();
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0; const freshStrings = flatten(controls({ sessionId: 'session-new' })).flatMap((n) => n.children || []).filter((c) => typeof c === 'string');
  assert.ok(freshStrings.some((t) => t.includes('档位：默认')), 'no Board yet: the tier chip reads 默认');
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
    s6: row('s6', 'D:\\Work\\game', now, { origin: 'subagent', parentId: 's3' }), // historical child: readable
    s7: row('s7', 'D:\\Work\\game', now),                                 // archived: hidden
  } };
  const plain = (value) => JSON.parse(JSON.stringify(value)); // values made in the plugin's realm
  const view = plugin.buildTree({ tree, list, workspaces: { archivedSessionIds: ['s7'], pinnedSessionIds: [] }, current: 's3', filter: '', collapsed: {} });
  assert.deepEqual(plain(view.agents.map((e) => e.agent.name)), ['beta', 'alpha', 'gamma'], 'running first, then recent; not set up last');
  const alpha = view.agents.find((e) => e.agent.agentId === 'a');
  assert.deepEqual(plain(alpha.dirs.map((d) => [d.label, d.sessions.map((s) => s.id)])), [['game', ['s6', 's3', 's1']]]);
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

// Exercise the shipped plain browser script with hook state and captured slot registrations.
function leftoversBrowser(reply = () => ({})) {
  let plugin, cursor = 0;
  const cells = [], effects = [], registrations = new Map(), requests = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (initial) => { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } }, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { const request = { url, body: options.body && JSON.parse(options.body) }; requests.push(request);
      return { json: async () => reply(request) }; },
  });
  const slots = { inject(_name, fn) { fn(); }, register(options, component) { registrations.set(options.name, { options, component }); } };
  let toggles = 0;
  const ctx = { slots, effect() {}, inject(deps, fn) { if (deps.length === 1 && deps[0] === 'layout') fn(ctx); },
    layout: { toggleSidebar() { toggles++; } }, sidebarRight: { mounted: { subscribe() {}, getSnapshot: () => undefined } } };
  plugin.apply(ctx);
  const nodes = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); for (const child of node.children || []) nodes(child, out); } return out; };
  return { plugin, cells, effects, registrations, requests, nodes, toggles: () => toggles,
    render(component, props) { cursor = 0; return component(props); } };
}

test('the registered sidebar brand is plain content; collapse and settings slots remain usable', () => {
  const f = leftoversBrowser();
  const { options, component } = f.registrations.get('sidebar');
  assert.deepEqual(Object.keys(options.children).sort(), ['sidebar.footer.action', 'sidebar.settings', 'sidebar.workspaces']);
  for (const collapsed of [false, true]) {
    const slots = [];
    const rendered = f.render(component, { collapsed, ...options.inject(), renderSlot: (name, props) => { slots.push([name, props]); return null; } });
    const brand = f.nodes(rendered).find((node) => 'data-rulith-brand' in node.props);
    assert.equal(brand.tag, 'span'); assert.equal(brand.props.onClick, undefined); assert.equal(brand.props.tabIndex, undefined);
    assert.equal(f.nodes(rendered).filter((node) => node.tag === 'button').length, 1, 'only the collapse control is a button');
    f.nodes(rendered).find((node) => node.tag === 'button').props.onClick();
    assert.ok(slots.some(([name]) => name === 'sidebar.settings'));
    assert.equal(slots.find(([name]) => name === 'sidebar.workspaces')[1].wide, !collapsed);
  }
  assert.equal(f.toggles(), 2); assert.deepEqual(f.requests, [], 'brand and collapse never create a session');
  const childComposer = f.registrations.get('conversation.composer');
  assert.equal(childComposer.options.select({ session: { origin: 'user' } }), null);
  assert.ok(childComposer.options.select({ session: { origin: 'subagent' } }));
  assert.ok(childComposer.options.select({ session: { subagent: { address: { mode: 'continuable' } } } }));
  assert.equal(f.nodes(childComposer.component({})).some((node) => node.tag === 'button' || node.tag === 'textarea'), false);
});

test('conversation rows have only deletion; archive occurs only after confirmation and complete deletion', async () => {
  for (const partial of [true, false]) {
    const f = leftoversBrowser(({ url }) => url.endsWith('end-preview') ? { ok: true, found: true, openGoals: [] }
      : url.endsWith('/end') ? { ok: true, unconfirmedGoals: partial ? ['g'] : [] } : {});
    const tree = { ok: true, defaultAgentId: 'a', assignments: {}, agents: [{ agentId: 'a', name: 'alpha', attached: true,
      directories: [{ path: '/project', label: 'project' }] }] };
    const row = { id: 's', cwd: '/project', title: 'work', updatedAt: Date.now(), running: false, blank: false };
    const store = (value) => ({ getSnapshot: () => value, subscribe() {} });
    const archived = [], opened = [];
    const component = f.plugin.makeRulithTree({ sessions: { list: store({ ids: ['s'], byId: { s: row } }) }, workspaces: { list: store({}) },
      ui: { selection: store({ sessionId: 's' }), openSession: (id) => opened.push(id), archiveSession: (id) => archived.push(id) } });
    f.cells[0] = tree;
    const render = () => f.render(component, { wide: true });
    let rendered = render();
    const session = f.nodes(rendered).find((node) => node.props['data-rulith-session'] === 's');
    const buttons = f.nodes(session).filter((node) => node.tag === 'button');
    assert.equal(buttons.length, 1); assert.equal(buttons[0].children.join(''), '删除');
    session.props.onClick(); assert.deepEqual(opened, ['s']);
    await buttons[0].props.onClick({ stopPropagation() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(archived, []); assert.equal(f.requests.length, 1);
    rendered = render();
    const dialog = f.nodes(rendered).find((node) => node.props.role === 'dialog'); assert.ok(dialog);
    f.nodes(dialog).find((node) => node.tag === 'button' && node.children.join('') === '取消').props.onClick();
    assert.deepEqual(archived, []); assert.equal(f.requests.length, 1, 'cancel does not delete or archive');
    rendered = render();
    await f.nodes(rendered).find((node) => node.props['data-rulith-delete'] === 's').props.onClick({ stopPropagation() {} });
    await new Promise((resolve) => setImmediate(resolve));
    rendered = render();
    const confirm = f.nodes(rendered).find((node) => node.tag === 'button' && node.children.join('') === '删除' && !node.props['data-rulith-delete']);
    assert.ok(confirm); await confirm.props.onClick();
    assert.deepEqual(archived, partial ? [] : ['s']);
    assert.equal(f.requests.filter((request) => request.url.endsWith('/end')).length, 1);
  }
});

test('file-only @ source keeps files, quoted paths, directory drilling and breadcrumbs without querying sessions', async () => {
  const f = leftoversBrowser(), calls = [];
  const signal = new AbortController().signal;
  const source = f.plugin.makeFileReferenceSource({
    sessions: { binding: () => ({}), using: async (_id, _options, fn) => fn({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } }) },
    remote: { fileReferences: { list: async (...args) => { calls.push(args); return { ok: true, value: [
      { path: 'src/main.js', kind: 'file' }, { path: 'my folder', kind: 'directory' }, { path: 'bad"name', kind: 'file' } ] }; } },
      get sessionReferenceResolver() { assert.fail('session references must never be requested'); } },
  });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const candidates = await source.candidates({ sessionId: 's' }, { query: '', signal });
  assert.equal(candidates.length, 2); assert.equal(calls[0][0], 's');
  assert.equal(source.onPick({ candidate: candidates[0] }).insert.ref, '@src/main.js');
  assert.deepEqual(plain(source.onPick({ candidate: candidates[1], action: 'drill' })), { text: '@"my folder/', continue: true });
  assert.equal(source.onPick({ candidate: { value: JSON.stringify({ kind: 'session', mention: '@session' }) } }), undefined);
  const quoted = await source.candidates({ sessionId: 's' }, { query: 'src/', quoted: true, signal });
  assert.equal(source.onPick({ candidate: quoted[0] }).insert.ref, '@"src/main.js"');
  const crumbs = source.header({}, { query: 'a/b/', quoted: true, drilled: true });
  assert.deepEqual(plain(crumbs.map((crumb) => source.onPick({ candidate: crumb, action: 'drill' }).text)), ['@"', '@"a/', '@"a/b/']);
  assert.equal(await source.codec.serialize('@src/main.js'), '@src/main.js');
  assert.equal(source.openReference({}, { ref: '@src/main.js', appearance: 'file' }), false, 'no document preview is opened');
});
