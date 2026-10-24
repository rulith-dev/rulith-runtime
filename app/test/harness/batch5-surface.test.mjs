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
import * as PSC from './psc-0.2.29-text.mjs';

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
  assert.equal(chat('chat.deepDiving'), english ? 'Working…' : '正在处理…');
  assert.equal(chat('chat.deepDivingFor', { duration: '3秒' }), english ? 'Working for 3秒 ···' : '正在处理，用时 3秒 ···');
  assert.equal(conversation('placeholder.default'), english ? 'Say what you want done' : '说出你要做的事');
  assert.equal(conversation('placeholder.hero'), '', 'the empty page has only its one line above the input');
  assert.equal(chat('chat.loadOlder'), english ? 'Load older' : '加载更早', 'every other word is dsh\'s');
  assert.deepEqual(plugin.installTextOverrides(locale)(), undefined, 'a second install does nothing');
  undo();
  assert.equal(chat('chat.deepDiving'), english ? 'Deep diving' : '深度求索中', 'undone');
  assert.equal(plugin.installTextOverrides(undefined)(), undefined);
}

test('the running line says 正在处理…, and the placeholders advertise neither / commands nor @ conversations', () => {
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

test('a Rulith call reads as one plain line; 查看依据 holds the receipt, the call and the whole answer', () => {
  const { plugin, mount } = loadPage();
  const line = (owner) => { const out = plain(plugin.toolCallLine(owner)); return [out.text, out.tone, out.state]; };
  const view = { goals: { directory: [] }, actions: [{ action: 'x' }] };
  // Written, with the file named by the receipt; the test passed or failed by its exit code.
  const wrote = settled('Execute', write, { accepted: true, view, operations: strip(write.action, { state: 'done', result: { receipt: { path: 'src/fizzbuzz.py', digest: 'ab'.repeat(32) } } }) });
  assert.deepEqual(line(wrote), ['写入 fizzbuzz.py', 'ok', 'done']);
  const test = { action: 'worker_c0ffee_eng_test_3', args: { source: 'project', check: 'unit' } };
  assert.deepEqual(line(settled('Execute', test, { accepted: true, view, operations: strip(test.action, { state: 'done', result: { rows: [{ exit_code: 0 }] } }) })),
    ['运行测试：通过', 'ok', 'done']);
  assert.deepEqual(line(settled('Execute', test, { accepted: true, view, operations: strip(test.action, { state: 'done', result: { rows: [{ exit_code: 1 }] } }) })),
    ['运行测试：没有通过', 'warn', 'done']);
  // Refused because the project's grant was withdrawn; the reason's own words stay behind 查看依据.
  const refused = settled('Execute', write, { accepted: false, requestExecuted: false, errorCode: 'source_revoked', teaching: 'The owner withdrew this grant.', operations: [] });
  assert.deepEqual(line(refused), ['被拒绝：项目授权已收回', 'warn', 'refused']);
  assert.equal(plain(plugin.toolCallLine(refused)).detail, '写入 fizzbuzz.py');
  // Set and Get say what they asked; a result the host waited for names its own state.
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'declare_goal', label: '写 fizzbuzz.py', desired: [{ predicate: 'work.verified', args: { name: 'fizz' } }] }] },
    { accepted: true, view, operations: [] })), ['开始任务「写 fizzbuzz.py」', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'declare_goal', parent: 'goal-7', label: 'unit', desired: [{ predicate: 'eng.check_passed', args: { key: 'k' } }] }] },
    { accepted: true, view, operations: [] })), ['提出验收标准', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'assert_fact', predicate: 'note', args: {} }] }, { accepted: true, view, operations: [] })), ['记下依据', 'ok', 'done']);
  assert.deepEqual(line(settled('Set', { operations: [{ op: 'end_goal', goal: 'goal-7', reason: 'r' }] }, { accepted: true, view, operations: [] })), ['结束任务', 'ok', 'done']);
  assert.deepEqual(line(settled('Get', {}, { accepted: true, view, operations: [] })), ['查看进展', 'ok', 'done']);
  assert.deepEqual(line(settled('Get', { artifact: { ref: 'art_' + '0'.repeat(32) } }, { accepted: true, view, operations: [] })), ['读取结果', 'ok', 'done']);
  assert.deepEqual(line(settled('Execute', write, { accepted: true, tool: 'Execute', state: 'done', result: { receipt: { path: 'src/fizzbuzz.py' } }, view, operations: [] })),
    ['写入 fizzbuzz.py', 'ok', 'done']);
  // Before the answer: preparing, then running with the file named by the call; a stopped call; a lost outcome.
  assert.deepEqual(line({ phase: 'preparing', toolName: 'Execute', block: { phase: 'preparing', callId: 'c1' } }), ['正在准备一次操作…', 'info', 'preparing']);
  assert.deepEqual(line({ phase: 'start', toolName: 'Execute', block: { phase: 'start', callId: 'c1', name: 'Execute', argsRaw: JSON.stringify(write) } }),
    ['写入 fizzbuzz.py：进行中', 'info', 'running']);
  assert.deepEqual(line({ ...wrote, block: { ...wrote.block, content: [], isError: true, error: { code: 'interrupted' } } }), ['写入 fizzbuzz.py：已停止', 'warn', 'stopped']);
  assert.deepEqual(line({ ...wrote, block: { ...wrote.block, isError: true, content: [{ type: 'text', text: 'The connection to Rulith was interrupted during this call; its outcome is unknown. Do not repeat it: Get shows its outcome in the operations strip.' }] } }),
    ['写入 fizzbuzz.py：结果未知，请在 Console 核对', 'error', 'unknown']);
  // The row: one line and 查看依据; no JSON, id, code or digest until it is opened.
  const row = mount(plugin.RulithToolRow, wrote);
  let shown = row.render();
  assert.equal(text(find(shown, attr('data-rulith-call-line'))), '写入 fizzbuzz.py');
  assert.equal(text(find(shown, attr('data-rulith-call-evidence'))), '查看依据');
  assert.equal(find(shown, attr('data-rulith-call-detail')), undefined);
  assert.doesNotMatch(text(shown), /[{}]|worker_|eng\.|Execute|goal-7|abab|accepted/);
  find(shown, attr('data-rulith-call-evidence')).props.onClick();
  shown = row.render();
  const detail = text(find(shown, attr('data-rulith-call-detail')));
  assert.match(detail, /^回执\{\n {2}"receipt": \{\n {4}"path": "src\/fizzbuzz\.py"/);
  assert.match(detail, /这次调用\{\n {2}"action": "worker_c0ffee_eng_write_file_2"/);
  assert.match(detail, /完整原文\{"content":\[/);
  assert.equal(text(find(shown, attr('data-rulith-call-evidence'))), '收起依据');
  // dsh's disclosure keeps the row open across redraws when it is given.
  let expanded = false;
  const kept = mount(plugin.RulithToolRow, { ...refused, useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded; } }) });
  find(kept.render(), attr('data-rulith-call-evidence')).props.onClick();
  assert.equal(expanded, true);
  assert.match(text(find(kept.render(), attr('data-rulith-call-detail'))), /^原因The owner withdrew this grant\. source_revoked/);
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
  assert.equal(plain(plugin.toolCallLine(blocked)).text, '被拒绝：审查没有通过');
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
test('a deleted conversation\'s 任务 panel says it is deleted instead of waiting for its next result', () => {
  const page = loadPage();
  const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId: 's1' });
  m.cells[0] = { ok: true, available: true, view: null };
  m.cells[1] = { ok: true, found: true, conversation: { boardId: 'b', endedAt: '2026-10-25T08:00:00Z', awaitingSignature: [] } };
  m.cells[2] = { ok: true, available: true, state: 'online', computer: 'PC' };
  const shown = m.render();
  assert.equal(text(find(shown, attr('data-rulith-panel-message'))), '这个会话已删除，不能再继续。它的回执和记录仍保留，可在 Console 的任务记录里查看。');
  assert.doesNotMatch(text(shown), /下一个结果/);
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

// ---- One name per thing, one language (design §1, §2).
test('the page\'s Chinese sentences use the vocabulary: no Board, Worker, Agent token, Connection words, 非严格 or DeepSeek', () => {
  const source = fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
  const sentences = (source.match(/"(?:[^"\\\n]|\\.)*"/g) || []).filter((literal) => /[一-鿿]/.test(literal));
  assert.ok(sentences.length > 200, 'the page\'s sentences were found');
  // The signing texts say 任务 too (PSC 0.2.29): no sentence is exempt.
  for (const literal of sentences)
    assert.doesNotMatch(literal, /Board|Worker|Agent token|Connection|租约|连接凭据|本机连接「|非严格|DeepSeek|深度求索|预览版|验收合同|目标|Deep Rulith/, literal);
  const host = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  // The host's answers to the page are in Chinese (its startup errors and the model's tool errors are not the page's).
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

test('every local-client string PSC 0.2.29 fixes is written verbatim under its heading in the batch 5 document', () => {
  const doc = fs.readFileSync(new URL('../../../docs/model-visible-changes-batch5.md', import.meta.url), 'utf8');
  const heading = doc.indexOf('## PSC 0.2.29 本机客户端文字（逐字）');
  assert.ok(heading > 0, 'the heading');
  const section = doc.slice(heading);
  for (const words of PSC.ALL) assert.ok(section.includes(words), words);
  // The page ships exactly those strings.
  const { plugin } = loadPage();
  assert.deepEqual(plain(plugin.SIGN), PSC.SIGNING);
  assert.deepEqual(plain(plugin.SIGN_REASONS), PSC.SIGN_REASONS);
  assert.deepEqual(plain(plugin.TIER), PSC.TIER);
  assert.deepEqual(plain(plugin.MODE_WORDS), PSC.MODE_WORDS);
  assert.deepEqual(plain(plugin.MODE_HINTS), PSC.MODE_HINTS);
  assert.deepEqual(plain(plugin.WIDEN_TEXT), PSC.WIDEN_TEXT);
  assert.deepEqual(plain(plugin.TIER_REFUSALS), PSC.TIER_REFUSALS);
  assert.deepEqual(plain(plugin.REVIEW_REFUSALS), PSC.REVIEW_REFUSALS);
});

test('a refused call never borrows another call\'s receipt or file from the operations strip', () => {
  const { plugin, mount } = loadPage();
  // The strip still shows an earlier call of the same Action, done, with its receipt naming another file.
  const earlier = strip(write.action, { state: 'done', result: { receipt: { path: 'src/other.py', digest: 'cd'.repeat(32) } } });
  const refused = settled('Execute', write, { accepted: false, requestExecuted: false, errorCode: 'source_revoked', teaching: 'The owner withdrew this grant.',
    view: { actions: [] }, operations: earlier });
  const line = plain(plugin.toolCallLine(refused));
  assert.deepEqual([line.text, line.detail, line.state], ['被拒绝：项目授权已收回', '写入 fizzbuzz.py', 'refused'], 'its own call\'s file, not other.py');
  assert.equal(line.evidence.receipt, undefined, 'no foreign receipt');
  assert.equal(line.evidence.summary, '');
  assert.equal(line.evidence.reason, 'The owner withdrew this grant. source_revoked');
  assert.deepEqual(line.evidence.call, { action: write.action, args: write.args });
  const row = mount(plugin.RulithToolRow, refused);
  find(row.render(), attr('data-rulith-call-evidence')).props.onClick();
  // Only the whole answer (完整原文, folded) still carries the strip as the service sent it.
  const shown = text(row.render());
  assert.doesNotMatch(shown.slice(0, shown.indexOf('完整原文')), /other\.py|cdcd|回执/);
  // An outcome the host waited for names its own state: its receipt is its own.
  const delivered = settled('Execute', write, { accepted: false, tool: 'Execute', state: 'refused', teaching: 'A person refused this call.', view: {}, operations: earlier });
  assert.deepEqual([plain(plugin.toolCallLine(delivered)).text, plain(plugin.toolCallLine(delivered)).evidence.receipt], ['被拒绝：你拒绝了这次操作', undefined]);
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
