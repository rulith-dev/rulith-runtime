// Batch 5 (design §1, §2, §3.2; owner 2026-10-25): the app's name, icon and words on dsh's own surfaces, Rulith's tool calls
// as one plain line with 「查看依据」, and the batch 4 leftovers (a deleted conversation's panel, an unconfirmed signature
// across a reload, the panel reads resolving the conversation's own Agent). The page half runs on the shipped browser
// script (browser-page.mjs); the dsh facts it relies on are checked against the installed dsh when DSH_MODULES_DIR is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadPage, nodes, text, plain, flush } from './browser-page.mjs';
import { brandIndex, installBrand, ICON_PATH, MANIFEST_PATH, ICON_SVG, MANIFEST, TITLE } from '../../harness/web/brand.mjs';
import { requestFolder } from '../../harness/web/rulith-runtime.mjs';
import * as PSC from './psc-0.2.32-text.mjs';

const find = (root, test) => nodes(root).find(test);
const attr = (name, value) => (node) => node.props && (value === undefined ? node.props[name] !== undefined : node.props[name] === value);
const until = async (ready, turns = 200) => { for (let i = 0; i < turns && !ready(); i++) await flush(1); assert.ok(ready(), 'settled'); };
const DSH = process.env.DSH_MODULES_DIR ? path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai') : '';
const installed = { skip: !DSH && 'set DSH_MODULES_DIR to the installed dsh node_modules' };
const dshSource = (pkg) => fs.readFileSync(path.join(DSH, pkg, 'lib', 'client.js'), 'utf8');

// ---- The page's title, icon and manifest (design §3.2 页面标题、图标).
const DSH_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>DeepSeek Harness</title>
    <script type="module" crossorigin src="./assets/index-x.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

function assertBranded(html) {
  assert.match(html, /<title>Rulith<\/title>/);
  assert.equal((html.match(/rel="icon"/g) || []).length, 1, 'one icon: Rulith\'s');
  assert.match(html, new RegExp(`<link rel="icon" type="image/svg\\+xml" href="\\.${ICON_PATH}">`));
  assert.match(html, new RegExp(`<link rel="manifest" href="\\.${MANIFEST_PATH}">`));
  assert.doesNotMatch(html, /DeepSeek|favicon|"\.\/manifest\.webmanifest"/);
}

test('the page is served as Rulith: its title, one icon and the manifest are rewritten, and nothing else', async () => {
  const html = brandIndex(DSH_INDEX);
  assertBranded(html);
  assert.equal(html.replace(/<title>[^<]*<\/title>|<link[^>]*>/g, ''), DSH_INDEX.replace(/<title>[^<]*<\/title>|<link[^>]*>/g, ''),
    'the scripts and the body are as dsh serves them');
  assert.equal(brandIndex(html), html, 'rewriting twice changes nothing');
  // The host taps every index response and serves the icon and manifest itself, outside the guarded API.
  const taps = [], routes = new Map(), effects = [];
  installBrand({ webServer: { tapIndex: (fn) => { taps.push(fn); return () => {}; }, register: (route) => { routes.set(route.path, route); return () => {}; } },
    effect: (fn) => effects.push(fn()) });
  assert.deepEqual(taps, [brandIndex]);
  assert.deepEqual([...routes.keys()], [ICON_PATH, MANIFEST_PATH]);
  assert.ok([...routes.values()].every((route) => route.kind === 'exact' && !route.path.startsWith('/rulith/api')));
  const serve = async (route, method) => {
    const out = { code: 0, headers: {}, body: undefined };
    await routes.get(route).handler({ method }, { writeHead(code, headers = {}) { out.code = code; out.headers = headers; }, end(body) { out.body = body; } });
    return out;
  };
  const icon = await serve(ICON_PATH, 'GET');
  assert.deepEqual([icon.code, icon.headers['content-type'], icon.body], [200, 'image/svg+xml', ICON_SVG]);
  assert.equal((await serve(ICON_PATH, 'HEAD')).body, undefined);
  assert.equal((await serve(MANIFEST_PATH, 'POST')).code, 405);
  const manifest = JSON.parse((await serve(MANIFEST_PATH, 'GET')).body);
  assert.deepEqual([manifest.name, manifest.short_name, manifest.icons[0].src, manifest.start_url], [TITLE, TITLE, ICON_PATH, '/']);
  assert.equal(MANIFEST, JSON.stringify(manifest));
  // Without dsh's index taps (an older webserver) nothing is installed and nothing fails.
  installBrand({ webServer: { register() { throw new Error('not reached'); } }, effect() {} });
});

test('installed dsh: its index has exactly the lines the host rewrites, and its layout names the product in the tab title', installed, () => {
  assertBranded(brandIndex(fs.readFileSync(path.join(DSH, 'dsh-web-frontend', 'dist', 'index.html'), 'utf8')));
  const layout = dshSource('dsh-client-ui-layout');
  assert.match(layout, /const productTitle = "DeepSeek Harness";/);
  assert.match(layout, /document\.title = title === void 0 \? productTitle : `\$\{title\} — \$\{productTitle\}`;/);
  const server = fs.readFileSync(path.join(DSH, 'dsh-host-webserver', 'lib', 'index.js'), 'utf8');
  assert.match(server, /tapIndex\(transform\) \{/);
  assert.match(server, /const table = route\.kind === "exact" \? this\.exact : this\.prefixes;/);
});

test('the tab title stays Rulith\'s when dsh names a conversation in it', () => {
  const { plugin } = loadPage();
  assert.equal(plugin.brandedTitle('写 fizzbuzz.py — DeepSeek Harness'), '写 fizzbuzz.py — Rulith');
  assert.equal(plugin.brandedTitle('DeepSeek Harness'), 'Rulith');
  assert.equal(plugin.brandedTitle('Rulith'), 'Rulith');
});

// ---- dsh's own sentences the app replaces (design §3.2 状态文字, 首次打开; §1 no DeepSeek remnant).
/** dsh's locale service as it ships: its client script run as dsh's module loader runs it, its provided service caught. */
function dshLocale(languages = ['zh-CN']) {
  let plugin;
  const window = { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => (name === '@deepseek-ai/dsh-client-store' ? { defineStore: () => ({}) } : {})); } } };
  vm.runInNewContext(dshSource('dsh-client-locale'), { window, navigator: { languages, language: languages[0] }, console });
  let locale;
  const ctx = { configForms: { get: () => undefined }, effect: (fn) => fn(), on() {}, emit() {}, provide: (name, value) => { if (name === 'locale') locale = value; },
    slots: { installLocale() {}, inject() {} }, fiber: { uid: 1 } };
  plugin.apply(ctx);
  return locale;
}
/** The same contract in a few lines, for runs without the installed dsh. */
function fakeLocale(active = 'zh') {
  return {
    dicts: new Map(), active, listeners: 0,
    getSnapshot() { return { active: this.active }; },
    register(ns, dicts) { if (this.dicts.has(ns)) throw new Error('already'); this.dicts.set(ns, dicts); this.listeners++; return () => this.dicts.delete(ns); },
    translate(ns, key, params) {
      const template = this.dicts.get(ns)?.[this.active]?.[key] ?? this.dicts.get(ns)?.en?.[key] ?? key;
      return params ? template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : template;
    },
    bind(ns) { return (key, params) => this.translate(ns, key, params); },
  };
}

function checkWords(locale, english) {
  const { plugin } = loadPage();
  locale.register('chat', { zh: { 'chat.deepDiving': '深度求索中', 'chat.deepDivingFor': '深度求索中，用时 {duration} ···', 'chat.loadOlder': '加载更早' },
    en: { 'chat.deepDiving': 'Deep diving', 'chat.deepDivingFor': 'Deep diving for {duration} ···', 'chat.loadOlder': 'Load older' } });
  locale.register('conversation', { zh: { 'placeholder.default': '发消息或创建任务, / 调用指令, @ 文件或对话', 'placeholder.hero': '描述你想要构建的内容, / 调用指令, @ 文件或对话' },
    en: { 'placeholder.default': 'Message or run a task, / commands, @ files or sessions', 'placeholder.hero': 'Describe what you want to build' } });
  const chat = locale.bind('chat'), conversation = locale.bind('conversation');
  assert.equal(chat('chat.deepDiving'), english ? 'Deep diving' : '深度求索中', 'dsh\'s words until the app installs its own');
  const undo = plugin.installTextOverrides(locale);
  // English is the contract (PSC 0.2.32); the Chinese rendering is whatever the app's Chinese table says.
  const zh = (key) => plugin.TEXTS.zh.dsh[key];
  assert.equal(chat('chat.deepDiving'), english ? PSC.PAGE.dsh['chat:chat.deepDiving'] : zh('chat:chat.deepDiving'));
  assert.equal(chat('chat.deepDiving'), english ? 'Working…' : zh('chat:chat.deepDiving'));
  assert.equal(chat('chat.deepDivingFor', { duration: '3s' }), english ? 'Working for 3s ···' : zh('chat:chat.deepDivingFor').replace('{duration}', '3s'));
  assert.equal(conversation('placeholder.default'), english ? 'Say what you want done' : zh('conversation:placeholder.default'));
  assert.equal(conversation('placeholder.hero'), '', 'the empty page has only its one line above the input');
  assert.equal(chat('chat.loadOlder'), english ? 'Load older' : '加载更早', 'every other word is dsh\'s');
  assert.deepEqual(plugin.installTextOverrides(locale)(), undefined, 'a second install does nothing');
  undo();
  assert.equal(chat('chat.deepDiving'), english ? 'Deep diving' : '深度求索中', 'undone');
  assert.equal(plugin.installTextOverrides(undefined)(), undefined);
}

test('the running line says Working…, and the placeholders advertise neither / commands nor @ conversations', () => {
  checkWords(fakeLocale('zh'), false);
  checkWords(fakeLocale('en'), true);
  const { plugin } = loadPage();
  for (const [language, words] of Object.entries(plain(plugin.TEXT)))
    for (const [key, value] of Object.entries(words)) assert.doesNotMatch(value, /DeepSeek|深度求索|调用指令|对话|commands|sessions|预览/, language + ' ' + key);
  assert.deepEqual(Object.keys(plugin.TEXT.zh), Object.keys(plugin.TEXT.en));
});

test('installed dsh: its locale service takes the app\'s words, and the replaced keys are the ones dsh draws', installed, () => {
  checkWords(dshLocale(['zh-CN']), false);
  checkWords(dshLocale(['en-US']), true);
  const chat = dshSource('dsh-client-ui-chat');
  assert.match(chat, /const NS = "chat";/);
  assert.match(chat, /t\("chat\.deepDiving"\) : t\("chat\.deepDivingFor", \{ duration:/);
  const conversation = dshSource('dsh-client-ui-conversation');
  assert.match(conversation, /const NS = "conversation";/);
  const { plugin } = loadPage();
  for (const key of Object.keys(plugin.TEXT.zh)) {
    const [ns, name] = key.split(':');
    assert.ok((ns === 'chat' ? chat : conversation).includes(`"${name}": `), key + ' is a dsh key');
  }
  // The whale before the running words: the status for screen readers, a divider, then the icon and the words.
  assert.match(chat, /"data-chat-running": true,\s*children: \[[\s\S]*?visuallyHidden[\s\S]*?runningDivider,\s*"aria-hidden": "true"[\s\S]*?runningContent,\s*children: \[\(0, react_jsx_runtime\.jsx\)\(RunningWhaleTail, \{\}\)/);
  assert.match(chat, /function RunningWhaleTail\(\) \{\s*return \(0, react_jsx_runtime\.jsxs\)\("span", \{\s*className: ChatView_module_css_default\.runningIcon,\s*"aria-hidden": "true"/);
  assert.equal(plugin.RUNNING_CSS, '[data-chat-running]>span:last-child>span[aria-hidden="true"]:first-child{display:none!important}');
});

// ---- Rulith's tool calls in the conversation (design §3.2 工具调用行).
const answerText = (answer, notes = '') => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(answer) }] }) + notes;
const settled = (name, args, answer, extra = {}) => ({ phase: 'result', toolName: name,
  block: { kind: 'result', callId: 'c1', call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text: answerText(answer) }], isError: false, ...extra } });
const write = { action: 'worker_c0ffee_eng_write_file_2', args: { source: 'project', path: 'src/fizzbuzz.py', text: 'print(1)', expect_digest: '' } };
const strip = (action, entry) => [{ tool: 'Execute', label: `Execute ${action} → goal-7`, at: '2026-10-25T08:00:00Z', since: '2026-10-25T08:00:00Z', ...entry }];

test('a Rulith call reads as one plain line; Show evidence holds the receipt, the call and the whole answer', () => {
  const { plugin, mount } = loadPage();
  const line = (owner) => { const out = plain(plugin.toolCallLine(owner)); return [out.text, out.tone, out.state]; };
  const view = { goals: { directory: [] }, actions: [{ action: 'x' }] };
  // Written, with the file named by the receipt; the test passed or failed by its exit code.
  const wrote = settled('Execute', write, { accepted: true, view, operations: strip(write.action, { state: 'done', result: { receipt: { path: 'src/fizzbuzz.py', digest: 'ab'.repeat(32) } } }) });
  assert.deepEqual(line(wrote), ['Write fizzbuzz.py', 'ok', 'done']);
  const test = { action: 'worker_c0ffee_eng_test_3', args: { source: 'project', check: 'unit' } };
  assert.deepEqual(line(settled('Execute', test, { accepted: true, view, operations: strip(test.action, { state: 'done', result: { rows: [{ exit_code: 0 }] } }) })),
    ['Run tests: passed', 'ok', 'done']);
  assert.deepEqual(line(settled('Execute', test, { accepted: true, view, operations: strip(test.action, { state: 'done', result: { rows: [{ exit_code: 1 }] } }) })),
    ['Run tests: did not pass', 'warn', 'done']);
  // Refused because the project's grant was withdrawn; the reason's own words stay behind 查看依据.
  const refused = settled('Execute', write, { accepted: false, requestExecuted: false, errorCode: 'source_revoked', teaching: 'The owner withdrew this grant.', operations: [] });
  assert.deepEqual(line(refused), ['Refused: the project\'s grant was withdrawn', 'warn', 'refused']);
  assert.equal(plain(plugin.toolCallLine(refused)).detail, 'Write fizzbuzz.py');
  // Set and Get say what they asked; a result the host waited for names its own state.
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'declare_goal', label: '写 fizzbuzz.py', desired: [{ predicate: 'work.verified', args: { name: 'fizz' } }] }] },
    { accepted: true, view, operations: [] })), ['Start the task “写 fizzbuzz.py”', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'declare_goal', parent: 'goal-7', label: 'unit', desired: [{ predicate: 'eng.check_passed', args: { key: 'k' } }] }] },
    { accepted: true, view, operations: [] })), ['Propose acceptance criteria', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'assert_fact', predicate: 'note', args: {} }] }, { accepted: true, view, operations: [] })), ['Record evidence', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'end_goal', goal: 'goal-7', reason: 'r' }] }, { accepted: true, view, operations: [] })), ['End the task', 'ok', 'done']);
  assert.deepEqual(line(settled('Get', {}, { accepted: true, view, operations: [] })), ['Check progress', 'ok', 'done']);
  assert.deepEqual(line(settled('Get', { artifact: { ref: 'art_' + '0'.repeat(32) } }, { accepted: true, view, operations: [] })), ['Read a result', 'ok', 'done']);
  assert.deepEqual(line(settled('Execute', write, { accepted: true, tool: 'Execute', state: 'done', result: { receipt: { path: 'src/fizzbuzz.py' } }, view, operations: [] })),
    ['Write fizzbuzz.py', 'ok', 'done']);
  // Before the answer: preparing, then running with the file named by the call; a stopped call; a lost outcome.
  assert.deepEqual(line({ phase: 'preparing', toolName: 'Execute', block: { phase: 'preparing', callId: 'c1' } }), ['Preparing an operation…', 'info', 'preparing']);
  assert.deepEqual(line({ phase: 'start', toolName: 'Execute', block: { phase: 'start', callId: 'c1', name: 'Execute', argsRaw: JSON.stringify(write) } }),
    ['Write fizzbuzz.py: in progress', 'info', 'running']);
  assert.deepEqual(line({ ...wrote, block: { ...wrote.block, content: [], isError: true, error: { code: 'interrupted' } } }), ['Write fizzbuzz.py: stopped', 'warn', 'stopped']);
  assert.deepEqual(line({ ...wrote, block: { ...wrote.block, isError: true, content: [{ type: 'text', text: 'The connection to Rulith was interrupted during this call; its outcome is unknown. Do not repeat it: Get shows its outcome in the operations strip.' }] } }),
    ['Write fizzbuzz.py: result unknown, reconcile it in Console', 'error', 'unknown']);
  // The row: one line and 查看依据; no JSON, id, code or digest until it is opened.
  const row = mount(plugin.RulithToolRow, wrote);
  let shown = row.render();
  assert.equal(text(find(shown, attr('data-rulith-call-line'))), 'Write fizzbuzz.py');
  assert.equal(text(find(shown, attr('data-rulith-call-evidence'))), 'Show evidence');
  assert.equal(find(shown, attr('data-rulith-call-detail')), undefined);
  assert.doesNotMatch(text(shown), /[{}]|worker_|eng\.|Execute|goal-7|abab|accepted/);
  find(shown, attr('data-rulith-call-evidence')).props.onClick();
  shown = row.render();
  const detail = text(find(shown, attr('data-rulith-call-detail')));
  assert.match(detail, /^Receipt\{\n {2}"receipt": \{\n {4}"path": "src\/fizzbuzz\.py"/);
  assert.match(detail, /This call\{\n {2}"action": "worker_c0ffee_eng_write_file_2"/);
  assert.match(detail, /Full original text\{"content":\[/);
  assert.equal(text(find(shown, attr('data-rulith-call-evidence'))), 'Hide evidence');
  // dsh's disclosure keeps the row open across redraws when it is given.
  let expanded = false;
  const kept = mount(plugin.RulithToolRow, { ...refused, useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded; } }) });
  find(kept.render(), attr('data-rulith-call-evidence')).props.onClick();
  assert.equal(expanded, true);
  assert.match(text(find(kept.render(), attr('data-rulith-call-detail'))), /^ReasonThe owner withdrew this grant\. source_revoked/);
  // A running call has nothing to show yet.
  assert.equal(find(mount(plugin.RulithToolRow, { phase: 'start', toolName: 'Get', block: { phase: 'start', name: 'Get', argsRaw: '{}' } }).render(),
    attr('data-rulith-call-evidence')), undefined);
});

test('the reviewer\'s notes after the answer and an answer carried in an error both read', () => {
  const { plugin } = loadPage();
  const answer = { accepted: true, view: {}, operations: [] };
  assert.deepEqual(plain(plugin.rulithAnswer(answerText(answer, '\n[Rulith shadow] note'))), answer);
  assert.deepEqual(plain(plugin.rulithAnswer('Error: ' + JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify({ accepted: false, errorCode: 'review_blocked', operations: [] }) }] }))),
    { accepted: false, errorCode: 'review_blocked', operations: [] });
  assert.equal(plugin.rulithAnswer('not json'), null);
  const blocked = settled('Execute', write, { accepted: false, requestExecuted: false, errorCode: 'review_blocked', teaching: 'blocked', operations: [] });
  assert.equal(plain(plugin.toolCallLine(blocked)).text, 'Refused: the review did not pass');
});

test('the app registers its row for exactly Rulith\'s three tools, in dsh\'s keyed tool view', () => {
  const { plugin } = loadPage();
  const registered = [];
  const ctx = { inject() {}, effect() {}, on() {}, sidebarRightTabs: { register() {} }, sidebarRight: { mounted: { subscribe() {}, getSnapshot() {} } },
    slots: { inject: (name, factory) => { const out = factory(); if (name === 'tool.call.toolview') registered.push(out); }, register: (options, component) => ({ options, component }) } };
  plugin.apply(ctx);
  assert.deepEqual(registered.map((entry) => [entry.options.name, entry.options.key]), [['tool.call.toolview', 'Get'], ['tool.call.toolview', 'Set'], ['tool.call.toolview', 'Execute']]);
  assert.ok(registered.every((entry) => entry.component === plugin.RulithToolRow));
});

test('installed dsh: a keyed tool view replaces the generic row and gets the call\'s stage, block and disclosure', installed, () => {
  const tool = dshSource('dsh-client-ui-tool');
  assert.match(tool, /renderSlot\("tool\.call\.toolview", owner, \{\s*entryKey: toolName,\s*fallback:/);
  assert.match(tool, /const owner = \(0, react\.useMemo\)\(\(\) => \(\{\s*callId,\s*toolName,\s*\.\.\.call,\s*openFile,\s*cwd,\s*home,\s*loadImage,\s*useDisclosure,/);
  assert.match(tool, /if \("kind" in block\) return \{\s*phase: "result",\s*block\s*\};/);
});

// ---- Batch 4 leftovers (P3).
test('a deleted conversation\'s Tasks panel says it is deleted instead of waiting for its next result', () => {
  const page = loadPage();
  const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId: 's1' });
  m.cells[0] = { ok: true, available: true, view: null };
  m.cells[1] = { ok: true, found: true, conversation: { boardId: 'b', endedAt: '2026-10-25T08:00:00Z', awaitingSignature: [] } };
  m.cells[2] = { ok: true, available: true, state: 'online', computer: 'PC' };
  const shown = m.render();
  assert.equal(text(find(shown, attr('data-rulith-panel-message'))), 'This conversation is deleted and cannot continue. Its receipts and records are kept and can be read in Console\'s task records.');
  assert.doesNotMatch(text(shown), /next result/);
});

test('an unconfirmed signature keeps its request id across a reload of the page, until a state read settles it', async () => {
  const saved = new Map();
  const sessionStorage = { getItem: (key) => (saved.has(key) ? saved.get(key) : null), setItem: (key, value) => saved.set(key, String(value)), removeItem: (key) => saved.delete(key) };
  const leaves = [{ node: 'leaf-a', label: 'unittest 通过', criterion: '[]', signed: false, eligible: true }];
  const state = (list) => ({ ok: true, found: true, conversation: { boardId: 'board-1', awaitingSignature: list } });
  const awaiting = [{ goal: 'goal-7', label: '写 fizzbuzz.py', signable: true, leaves }];
  const board = { ok: true, available: true, view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running', awaiting: 'acceptance' }] } } };
  const open = (answer) => {
    const page = loadPage({ windowExtra: { sessionStorage }, reply: ({ url }) => (url === '/rulith/api/conversation/sign-acceptance' ? answer() : { ok: true }) });
    const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId: 's1' });
    m.cells[0] = board; m.cells[1] = state(awaiting); m.cells[2] = { ok: true, available: true, state: 'online' };
    return { page, m };
  };
  const signed = (page) => page.posted('conversation/sign-acceptance');
  const confirm = (page, m) => {
    find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
    find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  };
  // The first page: the signature goes out and its outcome is not confirmed.
  const first = open(() => ({ ok: false, errorCode: 'signature_unconfirmed' }));
  confirm(first.page, first.m);
  await until(() => first.m.cells[4] === '' && first.m.cells[5]?.state === 'pending', 2000);
  const requestId = signed(first.page)[0].body.requestId;
  assert.deepEqual(Object.keys(JSON.parse(saved.get('rulith.sign.unconfirmed'))), ['s1\ngoal-7']);
  assert.doesNotMatch(saved.get('rulith.sign.unconfirmed'), /token|key|secret/i);
  // Reloaded (the same tab): the next confirmation of the same goal resends that request.
  const second = open(() => ({ ok: true, state: 'complete', result: { accepted: true } }));
  assert.equal(second.page.plugin.unconfirmedSignatures.size, 1);
  confirm(second.page, second.m);
  await until(() => second.m.cells[5]?.state === 'signed', 2000);
  assert.deepEqual(plain(signed(second.page)[0].body), { session: 's1', goal: 'goal-7', leaves: ['leaf-a'], requestId });
  assert.equal(saved.has('rulith.sign.unconfirmed'), false, 'answered: dropped from the tab too');
  // A state read that shows it settled drops it as well; a damaged entry is not trusted.
  saved.set('rulith.sign.unconfirmed', JSON.stringify({ 's1\ngoal-7': { goal: 'goal-7', label: 'x', requestId, toSign: ['leaf-a'], leaves }, 'bad': { goal: 1 } }));
  const third = open(() => ({ ok: true }));
  assert.equal(third.page.plugin.unconfirmedSignatures.size, 1);
  third.m.cells[1] = state([{ ...awaiting[0], leaves: [{ ...leaves[0], signed: true }] }]);
  third.m.render();
  assert.equal(saved.has('rulith.sign.unconfirmed'), false);
});

test('the panel\'s health and worker reads resolve the Agent from the conversation\'s own folder, as the board read does', () => {
  const sessions = new Map([['s1', { session: { id: 's1', header: { cwd: 'D:\\work\\game' } } }]]);
  assert.equal(requestFolder({ session: 's1', workspace: null }, sessions), 'D:\\work\\game');
  assert.equal(requestFolder({ session: 's1', workspace: 'D:\\other' }, sessions), 'D:\\other', 'a folder the page names wins');
  assert.equal(requestFolder({ session: 'unknown', workspace: null }, sessions), undefined);
  assert.equal(requestFolder({}, sessions), undefined);
  const host = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  assert.match(host, /const agentForRequest = \(query = \{\}\) => resolveHolder\(query\.session, requestFolder\(query, sessions\)\) \?\? null;/);
  for (const route of ['health', 'worker']) assert.match(host, new RegExp(`'GET /rulith/api/${route}': \\(query\\) => \\w+\\(query\\)`));
  assert.match(host, /const health = async \(query = \{\}\) => \{\s*const agent = agentForRequest\(query\);/);
  assert.match(host, /const workerTrace = async \(query = \{\}\) => \{\s*const agent = agentForRequest\(query\);/);
});

// ---- One name per thing, one table per language (design §1, §2; D-1025b).
test('the page\'s words use the vocabulary: no Board, Worker, Agent token or Connection words in Chinese, no DeepSeek or Deep Rulith in either', () => {
  const { plugin } = loadPage();
  const leaves = (value, at = '') => (typeof value === 'string' ? [[at, value]]
    : Object.entries(value).flatMap(([key, item]) => leaves(item, at ? at + '.' + key : key)));
  // Diagnosis names the versions it runs (DeepSeek Harness is the conversation engine); dsh's own keys are dsh's.
  const exempt = (at) => at === 'diagnosis.versions' || at.startsWith('dsh.');
  const zh = leaves(plain(plugin.TEXTS.zh)).filter(([at]) => !exempt(at));
  assert.ok(zh.length > 300, 'the page\'s sentences were found');
  // The signing texts say 任务 too: no Chinese sentence is exempt.
  for (const [at, words] of zh)
    assert.doesNotMatch(words, /Board|Worker|Agent token|Connection|租约|连接凭据|本机连接「|非严格|DeepSeek|深度求索|预览版|验收合同|目标|Deep Rulith/, at);
  // English uses Console's words, Board included where Console's approved sentences say it.
  for (const [at, words] of leaves(plain(plugin.TEXTS.en)).filter(([key]) => !exempt(key)))
    assert.doesNotMatch(words, /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|DeepSeek|Deep Rulith|lease|\bgoal-\d/, at);
  // The host speaks through its tables too: no sentence for the person is written into its route modules.
  for (const file of ['rulith-runtime.mjs', 'open-project.mjs', 'local-setup.mjs', 'folder-picker.mjs', 'model-runtime.mjs', 'diagnosis.mjs']) {
    const code = fs.readFileSync(new URL('../../harness/web/' + file, import.meta.url), 'utf8').split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(code, /[\u4e00-\u9fff]/, file);
  }
  const host = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /Choose an Agent first|Invalid session id|Name the conversation|That Agent is not set up|another Agent's Board|Name the goal|Same-origin Deep Rulith|No such Deep Rulith|Rulith answered/);
});

test('the model-visible changes of batch 5 are listed verbatim in their document', async () => {
  const doc = fs.readFileSync(new URL('../../../docs/model-visible-changes-batch5.md', import.meta.url), 'utf8');
  const { ADDENDUM } = await import('../../harness/rulith-gate.mjs');
  const { projectLine } = await import('../../harness/web/project-source.mjs');
  assert.ok(doc.includes('Reply in the language the user writes in, even when tool results are in English.'));
  const tail = ADDENDUM.slice(ADDENDUM.indexOf('Early, propose the acceptance'), ADDENDUM.indexOf(' the Board certifies the goal'));
  assert.ok(doc.includes(tail), 'the new acceptance sentences');
  assert.ok(doc.includes(projectLine('<directory>', null)));
});

test('every normative English string of PSC 0.2.32 is listed in docs/ui-texts-english.md, and the app ships exactly them', async () => {
  const doc = fs.readFileSync(new URL('../../../docs/ui-texts-english.md', import.meta.url), 'utf8');
  for (const words of PSC.ALL) assert.ok(doc.includes('`' + words + '`'), words);
  // The page and the host ship exactly those strings.
  const { plugin } = loadPage();
  assert.equal(plugin.LOCALE, 'en', 'English unless the browser\'s language is Chinese');
  assert.deepEqual(plain(plugin.TEXTS.en), PSC.PAGE);
  const { HOST_TEXTS } = await import('../../harness/web/ui-texts.mjs');
  assert.deepEqual(HOST_TEXTS.en, PSC.HOST);
  assert.deepEqual(plain(plugin.SIGN), PSC.SIGNING);
  assert.deepEqual(plain(plugin.SIGN_REASONS), PSC.SIGN_REASONS);
  assert.deepEqual(plain(plugin.TIER), PSC.TIER);
  assert.deepEqual(plain(plugin.MODE_WORDS), PSC.MODE_WORDS);
  assert.deepEqual(plain(plugin.MODE_HINTS), PSC.MODE_HINTS);
  assert.deepEqual(plain(plugin.WIDEN_TEXT), PSC.WIDEN_TEXT);
  assert.deepEqual(plain(plugin.TIER_REFUSALS), PSC.TIER_REFUSALS);
  assert.deepEqual(plain(plugin.REVIEW_REFUSALS), PSC.REVIEW_REFUSALS);
  // Console's approved English is reused verbatim where the meaning is the same (Text A, Text 9, the non-strict
  // confirmation, PSC 0.2.20 ③, Console's Conversations texts).
  assert.equal(PSC.SIGNING.body, 'You are signing these criteria as the acceptance for this goal. The Agent proposed them; from now on it cannot end or change them, and the goal completes only when every criterion holds on the current state. This is your decision under your account.');
  assert.deepEqual([PSC.SIGNING.title, PSC.SIGNING.button, PSC.SIGNING.accept, PSC.SIGNING.cancel, PSC.SIGNING.signed, PSC.SIGNING.refused],
    ['Proposed acceptance criteria', 'Sign these criteria', 'Sign', 'Not yet', 'Signed.', 'Nothing was signed: {teaching}.']);
  assert.deepEqual([PSC.WIDEN_TEXT.derived.title, PSC.WIDEN_TEXT.derived.accept, PSC.WIDEN_TEXT.derived.cancel],
    ['Switch to derived exploration mode?', 'Switch to derived', 'Keep strict']);
  assert.deepEqual([PSC.WIDEN_TEXT.non_strict.title, PSC.WIDEN_TEXT.non_strict.accept, PSC.WIDEN_TEXT.non_strict.cancel],
    ['Switch to non-strict exploration mode?', 'Switch to non-strict', 'Keep strict']);
  assert.equal(PSC.TIER_REFUSALS.review_required_by_derived_mode, 'Turn post-call review back on for this conversation before switching it to derived mode.');
  assert.equal(PSC.REVIEW_REFUSALS.derived_requires_review, 'Switch this conversation out of derived mode before turning its review off.');
  assert.deepEqual([PSC.PAGE.tree.dialogTitle, PSC.PAGE.tree.delete, PSC.PAGE.tree.keep, PSC.PAGE.tree.finish],
    ['Delete this conversation?', 'Delete', 'Keep', 'Finish deleting']);
});

test('the page\'s language is chosen once from the browser\'s: Chinese for zh, else English; every request names it', async () => {
  for (const [language, locale] of [[undefined, 'en'], ['en-US', 'en'], ['en-GB', 'en'], ['fr-FR', 'en'], ['zh-CN', 'zh'], ['zh-TW', 'zh'], ['zh', 'zh']]) {
    const page = loadPage(language ? { windowExtra: { navigator: { language } } } : {});
    assert.equal(page.plugin.LOCALE, locale, String(language));
    // The words shown are that language's table.
    assert.deepEqual(plain(page.plugin.SIGN), plain(page.plugin.TEXTS[locale].sign));
    const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId: 's1' });
    m.cells[0] = { ok: true, available: true, agentName: 'A', view: { goals: { directory: [] } }, operations: [] };
    m.cells[1] = { ok: true, found: true, conversation: { boardId: 'b', awaitingSignature: [] } };
    m.cells[2] = { ok: true, available: true, state: 'online', computer: 'PC' };
    assert.match(text(m.render()), new RegExp(page.plugin.TEXTS[locale].panel.recent));
    // Every request to the host names the page's language, so the host answers in it.
    const diagnosis = page.mount(page.plugin.components.DiagnosisSection, { state: null });
    diagnosis.render();
    await diagnosis.runEffects();
    assert.ok(page.requests.length > 0);
    for (const request of page.requests) assert.equal(request.headers['x-rulith-locale'], locale, request.url);
  }
  // The host's own sentences (marked `own`) are shown as they are; any other reason follows the page's own sentence.
  const en = loadPage().plugin, zh = loadPage({ windowExtra: { navigator: { language: 'zh-CN' } } }).plugin;
  assert.equal(en.plain({ teaching: 'This Agent is not set up on this computer yet.', own: true }, 'Could not read Rulith'), 'This Agent is not set up on this computer yet.');
  assert.equal(en.plain({ teaching: 'Endpoint not found.' }, 'Could not read Rulith'), 'Could not read Rulith: Endpoint not found.');
  assert.equal(en.plain('fetch failed', 'Not saved.'), 'Not saved: fetch failed');
  assert.equal(zh.plain({ teaching: '这个智能体还没有在这台电脑上设置好。' }, '读不到 Rulith'), '这个智能体还没有在这台电脑上设置好。');
  assert.equal(zh.plain({ teaching: 'Endpoint not found.' }, '读不到 Rulith'), '读不到 Rulith：Endpoint not found.');
  // The page's own sentences are its own too: an unfinished sign-in is said once, not after "Sign-in did not succeed".
  const unfinished = await en.signInFlow({ api: async (route) => (route === 'signin' ? { ok: true, url: 'https://rulith.example/approve' } : { ok: true }),
    openTab: () => null, wait: async () => {}, tries: 1 });
  assert.equal(en.plain(unfinished, en.TEXTS.en.signIn.failed), en.TEXTS.en.signIn.notFinished);
});

test('the Chinese tables are a complete rendering: every English key has Chinese words with the same placeholders', async () => {
  const { plugin } = loadPage();
  const { HOST_TEXTS } = await import('../../harness/web/ui-texts.mjs');
  const holes = (words) => (words.match(/\{\w+\}/g) || []).sort().join();
  const same = (en, zh, at) => {
    if (typeof en === 'string') {
      assert.equal(typeof zh, 'string', at + ' has a Chinese rendering');
      if (en !== '' && !/^[\s\p{P}·]*$/u.test(en)) assert.ok(zh.trim() !== '', at + ' is not empty');
      assert.equal(holes(zh), holes(en), at + ' fills the same values');
      return;
    }
    assert.ok(zh && typeof zh === 'object', at);
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), at + ' has the same keys');
    for (const key of Object.keys(en)) same(en[key], zh[key], at ? at + '.' + key : key);
  };
  same(plain(plugin.TEXTS.en), plain(plugin.TEXTS.zh), '');
  same(HOST_TEXTS.en, HOST_TEXTS.zh, '');
});

test('a refused call never borrows another call\'s receipt or file from the operations strip', () => {
  const { plugin, mount } = loadPage();
  // The strip still shows an earlier call of the same Action, done, with its receipt naming another file.
  const earlier = strip(write.action, { state: 'done', result: { receipt: { path: 'src/other.py', digest: 'cd'.repeat(32) } } });
  const refused = settled('Execute', write, { accepted: false, requestExecuted: false, errorCode: 'source_revoked', teaching: 'The owner withdrew this grant.',
    view: { actions: [] }, operations: earlier });
  const line = plain(plugin.toolCallLine(refused));
  assert.deepEqual([line.text, line.detail, line.state], ['Refused: the project\'s grant was withdrawn', 'Write fizzbuzz.py', 'refused'], 'its own call\'s file, not other.py');
  assert.equal(line.evidence.receipt, undefined, 'no foreign receipt');
  assert.equal(line.evidence.summary, '');
  assert.equal(line.evidence.reason, 'The owner withdrew this grant. source_revoked');
  assert.deepEqual(line.evidence.call, { action: write.action, args: write.args });
  const row = mount(plugin.RulithToolRow, refused);
  find(row.render(), attr('data-rulith-call-evidence')).props.onClick();
  // Only the whole answer (完整原文, folded) still carries the strip as the service sent it.
  const shown = text(row.render());
  assert.doesNotMatch(shown.slice(0, shown.indexOf('Full original text')), /other\.py|cdcd|Receipt/);
  // An outcome the host waited for names its own state: its receipt is its own.
  const delivered = settled('Execute', write, { accepted: false, tool: 'Execute', state: 'refused', teaching: 'A person refused this call.', view: {}, operations: earlier });
  assert.deepEqual([plain(plugin.toolCallLine(delivered)).text, plain(plugin.toolCallLine(delivered)).evidence.receipt], ['Refused: you refused this operation', undefined]);
});

test('an unconfirmed signature made on earlier criteria says so on the card, and only that request is ever resent', async () => {
  const leaves = [{ node: 'leaf-a', label: 'unittest 通过', criterion: '[]', signed: false, eligible: true },
    { node: 'leaf-b', label: '输出 1 到 100', criterion: '[]', signed: false, eligible: true }];
  const page = loadPage({ reply: ({ url }) => (url === '/rulith/api/conversation/sign-acceptance' ? { ok: false, errorCode: 'signature_unconfirmed' } : { ok: true }) });
  const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId: 's1' });
  const state = (list) => ({ ok: true, found: true, conversation: { boardId: 'b', awaitingSignature: [{ goal: 'goal-7', label: '写 fizzbuzz.py', signable: true, leaves: list }] } });
  m.cells[0] = { ok: true, available: true, view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running' }] } } };
  m.cells[1] = state([leaves[0]]); m.cells[2] = { ok: true, available: true, state: 'online' };
  assert.equal(find(m.render(), attr('data-rulith-sign-stale')), undefined, 'nothing unconfirmed yet');
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[4] === '' && m.cells[5]?.state === 'pending', 2000);
  const first = page.posted('conversation/sign-acceptance')[0].body;
  assert.equal(find(m.render(), attr('data-rulith-sign-stale')), undefined, 'the same criteria: no line');
  // The agent proposed another criterion meanwhile: the card says the unconfirmed signature was on the earlier ones.
  m.cells[1] = state(leaves);
  assert.equal(text(find(m.render(), attr('data-rulith-sign-stale'))), PSC.SIGNING.stale);
  // 签下这些标准 shows and resends that earlier request only, never the new criteria under its id.
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  const again = page.mount(page.plugin.components.SignDialog).render();
  assert.deepEqual(nodes(again).filter(attr('data-rulith-leaf')).map((node) => node.props['data-rulith-leaf']), ['leaf-a']);
  find(again, attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[4] === '', 2000);
  const sent = page.posted('conversation/sign-acceptance');
  assert.ok(sent.slice(1).every((request) => request.body.requestId === first.requestId && JSON.stringify(request.body.leaves) === '["leaf-a"]'));
});
