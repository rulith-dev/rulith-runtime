// Batch 2 (design §3.2 首次打开, 智能体树; PSC 0.2.27 ② ③): the first-run wizard, the Agent tree's 默认 badge and its one-step
// setup with progress, and the empty conversation page. The page is the shipped browser script in a vm with a hook-state
// stand-in for React (browser-page.mjs); every /rulith/api answer is a fixture. No network, no credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPage, nodes, text, plain, flush } from './browser-page.mjs';

const signedIn = { ok: true, signedIn: true, account: 'Owner', computer: 'OWNER-PC', origin: 'https://console.example', agents: [] };
const modelReady = { ok: true, model: { source: 'default', url: 'https://api.deepseek.com/v1', name: 'deepseek-flash', modelId: 'deepseek-flash',
  configured: true, keyConfigured: true, expectedOrigin: 'https://console.example', expectedAccountId: 'acct-1' } };
const agent = (agentId, extra = {}) => ({ agentId, name: agentId === 'a1' ? 'Default agent' : 'Other', attached: true, paired: true,
  directories: [{ path: 'C:\\app\\agents\\' + agentId, label: '工作台', source: null }], ...extra });
const project = { path: 'D:\\Work\\game', label: 'game', source: 'project' };

test('wizard steps are read from the state they name: resumable, per account, and never shown to a returning user', () => {
  const { plugin } = loadPage();
  const steps = (input) => plain(plugin.wizardSteps(input));
  // Nothing is shown before the state that decides the current step has been read.
  assert.equal(steps({ state: null }).show, false);
  assert.equal(steps({ state: { ok: false, teaching: 'manager down' } }).show, false);
  // ① Signed out: the wizard opens at 登录.
  const out = steps({ state: { ok: true, signedIn: false } });
  assert.deepEqual([out.show, out.current, out.account], [true, 'signin', '']);
  // ② Signed in without a usable model: 选模型并填密钥 (waiting until the model was read).
  assert.equal(steps({ state: signedIn, model: null }).show, false);
  const noModel = steps({ state: signedIn, model: { ok: true, model: { configured: false } } });
  assert.deepEqual([noModel.show, noModel.current, noModel.account], [true, 'model', 'Owner']);
  assert.deepEqual(noModel.steps.map((step) => [step.id, step.done]), [['signin', true], ['model', false], ['folder', false]]);
  // ③ A model, no project folder yet: 打开文件夹.
  assert.equal(steps({ state: signedIn, model: modelReady, tree: null }).show, false);
  const noFolder = steps({ state: signedIn, model: modelReady, tree: { ok: true, agents: [agent('a1')] } });
  assert.deepEqual([noFolder.show, noFolder.current], [true, 'folder']);
  // All three: a returning user never sees it.
  const done = steps({ state: signedIn, model: modelReady, tree: { ok: true, agents: [agent('a1', { directories: [project] })] } });
  assert.deepEqual([done.show, done.current], [false, null]);
  assert.ok(done.steps.every((step) => step.done));
  // A project of an Agent not attached here does not count; while an Agent set up here is not attached yet, step ③
  // cannot be told, and the wizard waits instead of asking again.
  assert.equal(steps({ state: signedIn, model: modelReady, tree: { ok: true, agents: [agent('a1', { attached: false, directories: [project] })] } }).show, false);
  assert.equal(steps({ state: signedIn, model: modelReady, tree: { ok: true, agents: [agent('a1', { attached: false, paired: false, directories: [] })] } }).show, true);
  // Per account: another account signed in on this computer is read afresh (its own model and folders).
  const other = steps({ state: { ...signedIn, account: 'Second' }, model: { ok: true, model: { configured: false } } });
  assert.deepEqual([other.current, other.account], ['model', 'Second']);
});

// A wizard over stand-in dsh services; `reply` answers the page's requests.
function wizard(reply, { state = signedIn, model = modelReady, tree = { ok: true, agents: [agent('a1')] } } = {}) {
  const page = loadPage({ reply });
  const made = { workspaces: [], sessions: [], opened: [] };
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const services = {
    ui: { selection: store({}), openSession: (id) => made.opened.push(id) },
    sessions: { list: store({ ids: [], byId: {} }), create: async (body) => { made.sessions.push(body); return { value: { sessionId: 's-new' } }; } },
    workspaces: { list: store({ items: [] }), create: async (body) => { made.workspaces.push(body); return { value: { workspace: { workspaceId: 'w-new', path: body.path } } }; } },
  };
  const m = page.mount(page.plugin.makeRulithWizard(services));
  // Hook cells, in call order: the state, model and tree polls, then the wizard's own state.
  m.cells[0] = state; m.cells[1] = model; m.cells[2] = tree;
  return { page, m, made };
}
const find = (root, test) => nodes(root).find(test);
const button = (root, words) => find(root, (node) => node.tag === 'button' && text(node).includes(words));

test('the wizard shows ① sign-in, then ② the model form, then ③ the folder under the account\'s default Agent; 稍后再说 puts it away', async () => {
  // ① Signed out: one button, which opens Rulith's approval page and polls until this computer is signed in.
  let w = wizard(({ url }) => (url.endsWith('/signin') ? { ok: true, url: 'https://console.example/console/#/devices?code=X' }
    : url.endsWith('/signin/poll') ? signedIn : { ok: true }), { state: { ok: true, signedIn: false }, model: null, tree: null });
  let shown = w.m.render();
  assert.equal(find(shown, (node) => node.props['data-rulith-wizard'] !== undefined).props['data-rulith-wizard'], 'signin');
  assert.match(text(shown), /① 登录.*② 选模型并填密钥.*③ 打开文件夹/);
  assert.doesNotMatch(text(shown), /预览版|探索未至之境/);
  await button(shown, '登录 Rulith').props.onClick();
  await flush();
  assert.equal(w.page.opened[0].location.href, 'https://console.example/console/#/devices?code=X', 'the approval opens in the tab made by the click');
  assert.equal(w.m.cells[0].signedIn, true, 'the wizard moves on with the signed-in account');
  // ② The model: the shared form (no key field value is ever filled from the service).
  w = wizard(() => ({ ok: true }), { model: { ok: true, model: { configured: false } } });
  shown = w.m.render();
  assert.equal(find(shown, (node) => node.props['data-rulith-wizard'] !== undefined).props['data-rulith-wizard'], 'model');
  assert.equal(find(shown, (node) => node.tag === w.page.plugin.components.ModelForm) !== undefined, true);
  // ③ The folder: the account's default Agent as the service marks it.
  w = wizard(() => ({ ok: true }), { tree: { ok: true, agents: [agent('a2'), agent('a1', { isDefault: true })] } });
  shown = w.m.render();
  assert.match(text(shown), /智能体：Default agent（默认）/);
  assert.ok(find(shown, (node) => node.tag === w.page.plugin.components.FolderChooser));
  // Without a default named and with several Agents, the owner chooses; with one, it is that one.
  w = wizard(() => ({ ok: true }), { tree: { ok: true, agents: [agent('a1'), agent('a2')] } });
  shown = w.m.render();
  assert.ok(find(shown, (node) => node.tag === 'select'), 'no default is guessed');
  assert.equal(find(shown, (node) => node.tag === w.page.plugin.components.FolderChooser), undefined);
  w = wizard(() => ({ ok: true }), { tree: { ok: true, agents: [agent('a1')] } });
  assert.match(text(w.m.render()), /智能体：Default agent(?!（默认）)/);
  // 稍后再说: put away for this account on this page load.
  shown = w.m.render();
  button(shown, '稍后再说').props.onClick();
  assert.equal(w.m.render(), null);
  // A returning user: nothing.
  w = wizard(() => ({ ok: true }), { tree: { ok: true, agents: [agent('a1', { directories: [project] })] } });
  assert.equal(w.m.render(), null);
});

// The Gateway's state answer for a folder that is not open yet (shape of open-project.test.mjs).
const notOpen = (directory) => ({ ok: true, state: 'not_open', accountId: 'acct-1', agentId: 'a1', agentName: 'Default agent',
  connectionName: 'Workspace', directory, authorizationVersion: 'sha256:v1', computer: { label: 'OWNER-PC' },
  capability: { id: 'engineering_work', version: '1.0.0' }, tools: [{ id: 'eng.read@2', directUse: true }, { id: 'eng.run@2', directUse: true }],
  mode: { requested: 'non_strict' } });

test('the wizard\'s step ③ sets the Agent up with its steps shown, opens the chosen folder with one confirmation, and starts a conversation under that Agent', async () => {
  const steps = (state) => ['instance', 'pair', 'kit', 'worker', 'reload', 'ready'].map((name, i) => ({ name,
    state: state === 'done' || i === 0 ? 'done' : i === 1 ? 'running' : 'pending', reason: 'Done.' }));
  let attached = false;
  const w = wizard(({ url, method, body }) => {
    if (url === '/rulith/api/setup' && method === 'POST') return { ok: true, requestId: 'setup-0001', agentId: body.agentId, state: 'running', steps: steps('running') };
    if (url.startsWith('/rulith/api/setup?')) { attached = true; return { ok: true, requestId: 'setup-0001', agentId: 'a1', state: 'done', steps: steps('done') }; }
    if (url === '/rulith/api/tree') return { ok: true, agents: [agent('a1', { isDefault: true, attached })] };
    if (url.endsWith('/projects/state')) return notOpen(body.directory);
    if (url.endsWith('/projects/open')) return { ...notOpen(body.directory), state: 'ready', directory: 'D:\\Work\\Game' };
    if (url.endsWith('/sessions/assign')) return { ok: true, session: body.session, agentId: body.agentId };
    return { ok: false, teaching: 'unexpected ' + url };
  }, { tree: { ok: true, agents: [agent('a1', { isDefault: true, attached: false, paired: false, directories: [] })] } });
  const chooser = find(w.m.render(), (node) => node.tag === w.page.plugin.components.FolderChooser);
  const opening = chooser.props.onChosen('D:\\work\\game');
  // The confirmation is asked once; it shows the folder, what may be done, the caution and how to withdraw.
  for (let i = 0; i < 50 && !w.m.cells[8]; i++) await flush(1);
  const dialog = w.page.expand(find(w.m.render(), (node) => node.tag === w.page.plugin.components.ProjectDialog));
  assert.ok(find(dialog, (node) => node.props['data-rulith-project-dialog'] !== undefined));
  assert.match(text(dialog), /文件夹D:\\work\\game智能体Default agent · 这台电脑 .*可以做的事.*档位/);
  // The tools used are listed in view, in plain words, with the capability; only their ids and versions are under 详细.
  const folded = find(dialog, (node) => node.tag === 'details');
  assert.ok(folded, 'tool versions are folded under 详细');
  assert.match(text(dialog), /所用工具读文件、运行命令。来自这个智能体已装的官方编程能力「engineering_work」。档位/);
  assert.match(text(folded), /eng\.read@2、eng\.run@2/);
  assert.doesNotMatch(text(dialog).replace(text(folded), ''), /eng\.|@\d/, 'no id or version outside 详细');
  // The setup ran first, as one operation, and its steps were shown.
  assert.deepEqual(plain(w.page.posted('setup').map((r) => r.body)), [{ agentId: 'a1' }]);
  assert.deepEqual(plain(w.m.cells[10]).view.steps.map((step) => step.state), ['done', 'done', 'done', 'done', 'done', 'done']);
  w.m.cells[8].answer(true);
  assert.equal(await opening, true);
  // A new conversation in the folder as the project names it, recorded for the default Agent, then opened.
  assert.deepEqual(plain(w.made.workspaces), [{ path: 'D:\\Work\\Game' }]);
  assert.deepEqual(plain(w.made.sessions), [{ workspaceId: 'w-new' }]);
  assert.deepEqual(plain(w.page.posted('sessions/assign').map((r) => r.body)), [{ session: 's-new', agentId: 'a1' }]);
  assert.deepEqual(w.made.opened, ['s-new']);
  assert.equal(w.page.posted('projects/open')[0].body.agentId, 'a1');
  assert.equal(w.m.render(), null, 'the wizard is done');
});

test('setup progress: the steps in the order they run, under the owner\'s words, with a failed step\'s reason', async () => {
  const { plugin, mount } = loadPage();
  const view = (states, extra = {}) => ({ ok: true, requestId: 'setup-0001', state: 'running',
    steps: ['instance', 'pair', 'kit', 'worker', 'reload', 'ready'].map((name, i) => ({ name, state: states[i], reason: 'r-' + name, ...(extra[name] || {}) })) });
  assert.deepEqual(plain(plugin.setupSteps(view(['done', 'running', 'pending', 'pending', 'pending', 'pending']))).map((row) => [row.label, row.state]),
    [['连接', 'running'], ['安装编程工具', 'pending'], ['开启这台电脑', 'pending'], ['重新载入', 'pending'], ['完成', 'pending']]);
  assert.deepEqual(plain(plugin.setupSteps(view(['done', 'done', 'done', 'done', 'done', 'done']))).map((row) => row.state), ['done', 'done', 'done', 'done', 'done']);
  const failed = plain(plugin.setupSteps(view(['done', 'done', 'done', 'failed', 'pending', 'pending'],
    { worker: { reason: 'The Worker could not start.' } })));
  assert.deepEqual(failed[2], { label: '开启这台电脑', state: 'failed', reason: 'The Worker could not start.' });
  // A refusal the page knows is said in plain words; others keep the manager's own reason.
  assert.match(plain(plugin.setupSteps(view(['done', 'failed', 'pending', 'pending', 'pending', 'pending'],
    { pair: { errorCode: 'connection_rejected' } })))[0].reason, /拒绝了这台电脑的连接凭据/);
  // PSC 0.2.27 ②: a Connection in use by a Worker elsewhere is refused and nothing is created; the words say what to wait for.
  assert.match(plain(plugin.setupSteps(view(['done', 'failed', 'pending', 'pending', 'pending', 'pending'],
    { pair: { errorCode: 'local_setup_connection_in_use', reason: 'That Connection is in use by a Worker on another computer.' } })))[0].reason,
  /正被另一台电脑上的 Worker 使用.*没有新建连接.*再点「在本机设置」/);
  // runSetup follows one setup to its end and reports every step list it read.
  const answers = [view(['running', 'pending', 'pending', 'pending', 'pending', 'pending']),
    { ...view(['done', 'done', 'failed', 'pending', 'pending', 'pending'], { kit: { reason: 'The general kit could not be installed.' } }), state: 'failed' }];
  const sent = [], reports = [];
  const result = plain(await plugin.runSetup({ api: async (route, body) => { sent.push([route, body]); return answers.shift(); }, agentId: 'a1', mode: 'repair',
    wait: async () => {}, report: (next) => reports.push(plain(next)) }));
  assert.deepEqual(plain(sent), [['setup', { agentId: 'a1', mode: 'repair' }], ['setup?requestId=setup-0001', null]], 'the read is a GET');
  assert.deepEqual([result.settled, result.ok], [true, false]);
  assert.ok(reports.some((r) => !r.settled && r.view), 'progress is shown while it runs');
  // The rendering names the failed step and why, and never claims success.
  const shown = mount(plugin.components.SetupSteps, { run: { agentId: 'a1', ...result } }).render();
  assert.match(text(shown), /「安装编程工具」没有完成：The general kit could not be installed\./);
  assert.doesNotMatch(text(shown), /已在这台电脑上设置好/);
  const ok = mount(plugin.components.SetupSteps, { run: { agentId: 'a1', settled: true, ok: true, view: { ...view(Array(6).fill('done')), state: 'done' } } }).render();
  assert.match(text(ok), /✓ 连接→ ✓ 安装编程工具→ ✓ 开启这台电脑→ ✓ 重新载入→ ✓ 完成/);
  assert.match(text(ok), /不需要重启/);
  // A refused start (signed out) is said in plain words.
  const refused = plain(await plugin.runSetup({ api: async () => ({ ok: false, errorCode: 'not_signed_in', teaching: 'Sign in first.' }), agentId: 'a1', wait: async () => {} }));
  assert.match(refused.error, /没有登录 Rulith/);
});

test('the tree: 默认 marks only the account\'s default Agent (never guessed), the open conversation\'s Agent is highlighted, and 在本机设置 shows its steps', async () => {
  const page = loadPage({ reply: ({ url, method }) => (url === '/rulith/api/setup' && method === 'POST'
    ? { ok: true, requestId: 'setup-0009', state: 'failed', steps: [{ name: 'instance', state: 'done', reason: 'Done.' },
      { name: 'pair', state: 'failed', reason: 'That Connection is in use by a Worker on another computer.' }] } : { ok: true }) });
  const { plugin } = page;
  const list = { ids: ['s1'], byId: { s1: { id: 's1', cwd: 'D:\\Work\\game', title: 'work', updatedAt: Date.now(), running: false, blank: false } } };
  // The app's fallback Agent (defaultAgentId) is not the account's default: no badge for it.
  const tree = { ok: true, defaultAgentId: 'a2', assignments: { s1: 'a1' }, agents: [
    agent('a1', { isDefault: true, directories: [project] }), agent('a2'), agent('a3', { attached: false, paired: false, directories: [] })] };
  const built = plugin.buildTree({ tree, list, workspaces: {}, current: 's1', filter: '', collapsed: {} });
  assert.deepEqual(plain(built.agents.map((entry) => [entry.agent.agentId, entry.isDefault, entry.hasCurrent])),
    [['a1', true, true], ['a2', false, false], ['a3', false, false]]);
  assert.ok(plugin.buildTree({ tree: { ...tree, agents: tree.agents.map(({ isDefault, ...rest }) => rest) }, list, workspaces: {}, current: 's1', filter: '', collapsed: {} })
    .agents.every((entry) => entry.isDefault === false), 'without isDefault from the service there is no badge');
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const component = plugin.makeRulithTree({ sessions: { list: store(list) }, workspaces: { list: store({}) },
    ui: { selection: store({ sessionId: 's1' }), openSession() {}, archiveSession() {} } });
  const m = page.mount(component, { wide: true });
  m.cells[0] = tree;
  let shown = m.render();
  const badges = nodes(shown).filter((node) => node.props['data-rulith-default'] !== undefined);
  assert.equal(badges.length, 1);
  assert.equal(find(shown, (node) => node.props['data-rulith-agent'] === 'a1').children.some((child) => nodes(child).includes(badges[0])), true);
  const highlighted = nodes(shown).filter((node) => node.props['data-rulith-agent-current'] !== undefined);
  assert.equal(highlighted.length, 1);
  assert.ok(nodes(find(shown, (node) => node.props['data-rulith-agent'] === 'a1')).includes(highlighted[0]));
  // 「在本机设置」: one operation; its failed step and reason are shown under the Agent; no restart, no choice.
  await find(shown, (node) => node.props['data-rulith-setup-agent'] === 'a3').props.onClick();
  shown = m.render();
  assert.deepEqual(plain(page.posted('setup').map((r) => r.body)), [{ agentId: 'a3' }]);
  const progress = page.expand(find(find(shown, (node) => node.props['data-rulith-agent'] === 'a3'), (node) => node.tag === plugin.components.SetupSteps));
  assert.match(text(progress), /「连接」没有完成：That Connection is in use by a Worker on another computer\./);
  assert.doesNotMatch(text(shown), /重启|重新接上|新建连接/);
  // Attached Agents end with the folder chooser.
  assert.ok(find(find(shown, (node) => node.props['data-rulith-agent'] === 'a1'), (node) => node.tag === plugin.components.FolderChooser));
});

// ACC-LOCAL-09 (PSC 0.2.27 ②, SYS-LOCAL-01): another computer uses the Agent and holds its Agent token. Setting it up
// here stops at 连接 and says what replacing the token does (the other computer's client stops working); only the
// owner's confirmation runs the setup again with the replacement. The same question is asked before reconnecting this
// computer when Rulith refuses its Connection credential, because that re-pairing replaces the token too.
test('setup asks before replacing an Agent token another computer holds, and only the confirmation replaces it', async () => {
  const failed = (errorCode) => ({ ok: true, requestId: 'setup-0010', agentId: 'a3', state: 'failed', steps: [{ name: 'instance', state: 'done', reason: 'Done.' },
    { name: 'pair', state: 'failed', reason: 'This Agent already has a token. Replacing it must be explicit.', errorCode },
    ...['kit', 'worker', 'reload', 'ready'].map((name) => ({ name, state: 'pending', reason: '' }))] });
  const done = { ok: true, requestId: 'setup-0011', agentId: 'a3', state: 'done', connectionDisposition: 'created',
    steps: ['instance', 'pair', 'kit', 'worker', 'reload', 'ready'].map((name) => ({ name, state: 'done', reason: 'Done.' })) };
  const page = loadPage({ reply: ({ url, method, body }) => (url === '/rulith/api/setup' && method === 'POST'
    ? (body.replaceAgentToken === true ? done : failed('runtime_credential_exists')) : { ok: true }) });
  const { plugin } = page;
  // What is asked, and when: only for a setup that stopped on a refusal only the owner can lift.
  const asked = plain(plugin.replaceConfirmation({ settled: true, ok: false, view: failed('runtime_credential_exists') }));
  assert.equal(asked.code, 'runtime_credential_exists');
  assert.match(asked.lines.join(''), /另一台电脑（或另一个客户端）上使用/);
  assert.match(asked.lines.join(''), /另一台电脑上的）会停止工作/, 'the other computer\'s client stops working');
  assert.match(asked.lines.join(''), /那台电脑的连接不会被接走/);
  assert.match(asked.lines.join(''), /不授予任何文件夹或工具的权限/);
  const reconnect = plain(plugin.replaceConfirmation({ settled: true, ok: false, view: failed('connection_missing') }));
  assert.match(reconnect.title, /重新接上这台电脑/);
  assert.match(reconnect.lines.join(''), /同时替换这个智能体的 Agent token.*停止工作/);
  for (const run of [{ settled: true, ok: false, view: failed('local_setup_connection_in_use') }, { settled: false, ok: false, view: failed('runtime_credential_exists') },
    { settled: true, ok: true, view: done }, null]) assert.equal(plugin.replaceConfirmation(run), null);
  // In the tree: 「在本机设置」 stops at 连接 with the reason and the question; nothing is replaced yet.
  const tree = { ok: true, defaultAgentId: 'a1', assignments: {}, agents: [agent('a1', { isDefault: true }), agent('a3', { attached: false, paired: false, directories: [] })] };
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const m = page.mount(plugin.makeRulithTree({ sessions: { list: store({ ids: [], byId: {} }) }, workspaces: { list: store({}) },
    ui: { selection: store({}), openSession() {}, archiveSession() {} } }), { wide: true });
  m.cells[0] = tree;
  await find(m.render(), (node) => node.props['data-rulith-setup-agent'] === 'a3').props.onClick();
  const steps = () => page.expand(find(find(m.render(), (node) => node.props['data-rulith-agent'] === 'a3'), (node) => node.tag === plugin.components.SetupSteps));
  let shown = steps();
  assert.match(text(shown), /「连接」没有完成：这个智能体的 Agent token 正在别处使用/);
  const asking = find(shown, (node) => node.props['data-rulith-replace-token'] === 'runtime_credential_exists');
  assert.match(text(asking), /替换这个智能体的 Agent token？/);
  assert.deepEqual(plain(page.posted('setup').map((r) => r.body)), [{ agentId: 'a3' }]);
  // 「不替换」 puts the question away and sends nothing.
  const declined = page.mount(plugin.components.SetupSteps, find(find(m.render(), (node) => node.props['data-rulith-agent'] === 'a3'),
    (node) => node.tag === plugin.components.SetupSteps).props);
  button(declined.render(), '不替换').props.onClick();
  assert.equal(find(declined.render(), (node) => node.props['data-rulith-replace-token'] !== undefined), undefined);
  assert.equal(page.posted('setup').length, 1);
  // Confirmed: the setup runs again with the replacement, and finishes.
  shown = steps();
  await button(shown, '替换 Agent token 并继续设置').props.onClick();
  await flush();
  assert.deepEqual(plain(page.posted('setup').map((r) => r.body)), [{ agentId: 'a3' }, { agentId: 'a3', replaceAgentToken: true }]);
  m.cells[0] = tree;   // the tree as before (this stand-in answers the tree's refresh with nothing)
  assert.match(text(steps()), /已在这台电脑上设置好/);
});

test('the empty conversation page shows one line above the input, without brand animation or preview badge', () => {
  const registrations = new Map();
  const page = loadPage();
  const selection = { value: { sessionId: 's1' }, getSnapshot() { return this.value; }, subscribe() { return () => {}; } };
  const slots = { inject(_name, fn) { fn(); }, register(options, component) { registrations.set(options.name + '|' + (options.id || ''), { options, component }); } };
  const ctx = { slots, effect() {}, sidebarRight: { mounted: { subscribe() {}, getSnapshot: () => undefined } }, sidebarRightTabs: { register() {} },
    inject(deps, fn) { if (deps[0] === 'uiWorkspace') fn({ slots, uiWorkspace: selectionOwner(selection), sessions: {}, workspaces: {} }); } };
  function selectionOwner(store) { return { selection: store }; }
  page.plugin.apply(ctx);
  const line = registrations.get('conversation.hero.brand.mark|').component;
  assert.equal(text(page.mount(line).render()), '说出你要做的事');
  selection.value = {};
  assert.equal(text(page.mount(line).render()), '在左侧的智能体下开一个新会话');
  // dsh's own headline (title and 预览版 badge) and its workspace chip row are hidden; the mark slot carries the line.
  assert.match(page.plugin.EMPTY_PAGE_CSS, /span:has\(> \[data-slot="conversation\.hero\.brand\.mark"\]\) \+ span/);
  assert.match(page.plugin.EMPTY_PAGE_CSS, /div:has\(> \[data-slot="conversation\.hero\.workspace"\]\)/);
  assert.match(page.plugin.EMPTY_PAGE_CSS, /display:none/);
});

test('installed dsh: the hero draws the brand-mark slot right before its title group, and the workspace slot inside its own row', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, () => {
  const file = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js');
  const source = fs.readFileSync(file, 'utf8');
  const hero = source.slice(source.indexOf('function HeroShell('), source.indexOf('function ConversationSessionView('));
  // headline = [span(fishHitbox) > slot "conversation.hero.brand.mark", span(titleGroup) > headline text + preview badge]
  assert.match(hero, /className: HeroShell_module_css_default\.fishHitbox,[\s\S]*renderSlot\("conversation\.hero\.brand\.mark"[\s\S]*\}\), \(0, react_jsx_runtime\.jsxs\)\("span", \{\s*className: HeroShell_module_css_default\.titleGroup/);
  assert.match(hero, /t\("hero\.headline"\)[\s\S]*t\("hero\.preview"\)/);
  const content = source.slice(source.indexOf('function ConversationContent('));
  assert.match(content, /className: ConversationRoot_module_css_default\.heroWorkspaceRow,\s*children: \[[\s\S]*?renderSlot\("conversation\.hero\.workspace"/);
  // Every slot outlet is a display:contents element carrying data-slot (dsh-client-ui-renderer), which the CSS selects.
  const renderer = fs.readFileSync(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'dsh-client-ui-renderer', 'lib', 'client.js'), 'utf8');
  assert.match(renderer, /"data-slot": slotKey,\s*style: ANCHOR_STYLE/);
});
