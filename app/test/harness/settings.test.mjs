// Batch 2 (design §3.2 设置, 账户面板, 会话的输入行, 打开文件夹; PSC 0.2.27 ① ④): the one Rulith settings page and its entry,
// the composer's two chips, and the folder chooser — the page half on the shipped browser script (browser-page.mjs) and
// the host half on its guarded API with a recording manager stand-in. No network, no manager process, no credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { loadPage, nodes, text, plain, flush } from './browser-page.mjs';
import { folderPicker, PICK_UNAVAILABLE } from '../../harness/web/folder-picker.mjs';
import { conversationView } from '../../harness/web/rulith-runtime.mjs';
// PSC 0.2.29 (D-1025a) fixes the tier chip's words, the widening confirmations and the switch refusals verbatim.
import * as PSC from './psc-0.2.29-text.mjs';

const find = (root, test) => nodes(root).find(test);
const button = (root, words) => find(root, (node) => node.tag === 'button' && text(node).includes(words));
const summary = { ok: true, signedIn: true, account: 'Owner', computer: 'OWNER-PC', origin: 'https://console.example', deviceState: 'linked',
  agents: [{ id: 'a1', name: 'Default agent', isDefault: true, paired: true, worker: { enabled: true, state: 'online', failure: '' } },
    { id: 'a2', name: 'Other', paired: false, worker: null }] };

test('one settings entry in the sidebar foot opens one settings page: 账户, 这台电脑, 模型, 外观与语言, 高级', () => {
  const page = loadPage();
  const { plugin } = page;
  const entry = page.mount(plugin.components.RulithSettingsEntry, { wide: true });
  entry.cells[0] = summary;
  let shown = entry.render();
  assert.equal(text(shown), 'Owner · 这台电脑在线⚙设置', 'the account and this computer at a glance; no Agent, Connection or tool count');
  assert.equal(page.mount(plugin.RulithSettings ?? plugin.components.RulithSettings).render(), null, 'closed until asked');
  shown.props.onClick();
  assert.equal(plugin.settingsView.getSnapshot().open, true);
  const settings = page.mount(plugin.components.RulithSettings).render();
  const pageNode = page.mount(settings.tag, settings.props).render();
  const tabs = nodes(pageNode).filter((node) => node.props.role === 'tab').map(text);
  assert.deepEqual(tabs, ['账户', '这台电脑', '模型', '外观与语言', '高级']);
  assert.deepEqual(plain(plugin.SETTINGS_SECTIONS.map(([, label]) => label)), tabs);
  // Each tab shows its own section, and only that one.
  const sectionOf = { account: 'AccountSection', computer: 'ComputerSection', model: 'ModelForm', appearance: 'AppearanceSection', advanced: 'AdvancedSection' };
  for (const [id, component] of Object.entries(sectionOf)) {
    const drawn = page.mount(plugin.components.SettingsPage, { section: id });
    drawn.cells[0] = summary;
    const body = drawn.render();
    assert.ok(find(body, (node) => node.tag === plugin.components[component]), id);
    for (const other of Object.values(sectionOf).filter((name) => name !== component))
      assert.equal(find(body, (node) => node.tag === plugin.components[other]), undefined, id + ' shows only its section');
  }
  // Signed out, the entry opens the account section; the status says so.
  const out = page.mount(plugin.components.RulithSettingsEntry, { wide: false });
  out.cells[0] = { ok: true, signedIn: false };
  shown = out.render();
  assert.equal(text(shown), '⚙', 'narrow: the dot and the gear');
  shown.props.onClick();
  assert.equal(plugin.settingsView.getSnapshot().section, 'account');
  assert.deepEqual(plain(plugin.computerStatus({ ok: true, signedIn: true, account: 'A', agents: [{ paired: true, worker: { state: 'offline' } }] })),
    { color: '#d29922', text: 'A · 这台电脑离线' });
  assert.equal(plugin.computerStatus({ ok: true, signedIn: true, agents: [] }).text, '这台电脑还没有设置');
  assert.equal(plugin.computerStatus({ ok: false }).text, '本机 Rulith 未连接');
});

test('账户: the signed-in account and 退出登录; signed out, 登录 Rulith', async () => {
  const page = loadPage({ reply: ({ url }) => (url.endsWith('/signout') ? { ok: true, signedIn: false } : { ok: true }) });
  let state = summary;
  const section = page.mount(page.plugin.components.AccountSection, { state, setState: (next) => { state = next; } });
  let shown = section.render();
  assert.match(text(shown), /账户Owner/);
  assert.doesNotMatch(text(shown), /Agent|使用这台电脑的工具和文件|重新接上|新建连接|更多设置|重启|已接入/);
  await button(shown, '退出登录').props.onClick();
  await flush();
  assert.equal(page.posted('signout').length, 1);
  assert.equal(state.signedIn, false);
  shown = page.mount(page.plugin.components.AccountSection, { state: { ok: true, signedIn: false }, setState() {} }).render();
  assert.ok(button(shown, '登录 Rulith'));
});

test('这台电脑: each Agent\'s state here; 「在本机设置」 runs the one explicit setup, for an Agent already set up as well', async () => {
  // A1 is set up here, but Rulith now refuses this computer's Connection credential: its setup stops at 连接 and asks.
  const rejected = { ok: true, requestId: 'setup-0002', agentId: 'a1', state: 'failed', steps: [{ name: 'instance', state: 'done', reason: 'Done.' },
    { name: 'pair', state: 'failed', reason: 'Rulith refused this computer\'s Connection credential.', errorCode: 'connection_rejected' }] };
  const page = loadPage({ reply: ({ url, method, body }) => (url === '/rulith/api/setup' && method === 'POST'
    ? (body.agentId === 'a1' && !body.replaceAgentToken ? rejected : { ok: true, requestId: 'setup-0001', agentId: body.agentId, state: 'done', steps: [] })
    : { ok: true }) });
  let refreshed = 0;
  const section = page.mount(page.plugin.components.ComputerSection, { state: summary, refresh: () => { refreshed++; } });
  let shown = section.render();
  assert.match(text(shown), /这台电脑OWNER-PC/);
  const row = (id) => find(shown, (node) => node.props['data-rulith-computer-agent'] === id);
  assert.match(text(row('a1')), /Default agent（默认）在线在本机设置/);
  assert.match(text(row('a2')), /Other未设置在本机设置/);
  await button(row('a2'), '在本机设置').props.onClick();
  // Every click is the explicit setup (it checks this computer's Connection; it may start a Worker that stopped itself).
  await button(row('a1'), '在本机设置').props.onClick();
  assert.deepEqual(plain(page.posted('setup').map((r) => r.body)), [{ agentId: 'a2' }, { agentId: 'a1' }]);
  assert.equal(refreshed, 2);
  // Reconnecting this computer replaces the Agent token, so it is asked first, with what that does; confirmed, the same
  // setup runs again with the confirmation.
  shown = section.render();
  const steps = page.expand(find(row('a1'), (node) => node.tag === page.plugin.components.SetupSteps));
  const asking = find(steps, (node) => node.props['data-rulith-replace-token'] !== undefined);
  assert.equal(asking.props['data-rulith-replace-token'], 'connection_rejected');
  assert.match(text(asking), /重新接上这台电脑？.*不再接受这台电脑为这个智能体保存的密钥.*换一把新密钥.*替换这个智能体的密钥.*停止工作/);
  await button(asking, '替换密钥并重新接上').props.onClick();
  await flush();
  assert.deepEqual(plain(page.posted('setup').map((r) => r.body)).at(-1), { agentId: 'a1', replaceAgentToken: true });
  assert.deepEqual(plain(page.plugin.workerWords({ paired: true, worker: { enabled: false, state: 'stopped' } })), { color: '#d29922', text: '这台电脑没有为它开启' });
  assert.match(text(page.mount(page.plugin.components.ComputerSection, { state: { ok: true, signedIn: false }, refresh() {} }).render()), /先在「账户」里登录/);
});

test('模型: the form never shows the key back; saving sends the account guard and the key only when typed, and applies from the next turn', async () => {
  const saved = [];
  const page = loadPage({ reply: ({ url, method, body }) => {
    if (url === '/rulith/api/model' && method === 'POST') { saved.push(body); return { ok: true, applies: 'next_turn',
      model: { ...body, key: undefined, configured: true, keyConfigured: true } }; }
    return { ok: true };
  } });
  const form = page.mount(page.plugin.components.ModelForm, { onSaved() {} });
  form.cells[0] = { ok: true, model: { source: 'default', url: 'https://api.deepseek.com/v1', name: 'deepseek-flash', modelId: 'deepseek-flash',
    configured: true, keyConfigured: true, expectedOrigin: 'https://console.example', expectedAccountId: 'acct-1' } };
  let shown = form.render();
  const inputs = nodes(shown).filter((node) => node.tag === 'input');
  assert.deepEqual(inputs.map((input) => input.props.value), ['https://api.deepseek.com/v1', 'deepseek-flash', '']);
  assert.equal(inputs[2].props.type, 'password');
  assert.equal(inputs[2].props.placeholder, '已保存；留空则不改');
  assert.match(text(shown), /现在用的：deepseek-flash · api\.deepseek\.com\/v1/);
  // Change the model id only: the saved key stays (no key field is sent).
  inputs[1].props.onChange({ target: { value: 'deepseek-pro' } });
  shown = form.render();
  await button(shown, '保存').props.onClick();
  assert.deepEqual(plain(saved), [{ expectedOrigin: 'https://console.example', expectedAccountId: 'acct-1', url: 'https://api.deepseek.com/v1', name: 'deepseek-pro' }]);
  assert.match(text(form.render()), /已保存，从下一轮起生效。/);
  // A typed key is sent once, and the field is emptied again.
  nodes(form.render()).filter((node) => node.tag === 'input')[2].props.onChange({ target: { value: 'sk-test-typed' } });
  await button(form.render(), '保存').props.onClick();
  assert.equal(saved[1].key, 'sk-test-typed');
  assert.equal(nodes(form.render()).filter((node) => node.tag === 'input')[2].props.value, '');
  // A refusal is said as the host said it (in Chinese); an English one follows the page's own sentence, never hidden.
  const refusing = loadPage({ reply: () => ({ ok: false, teaching: '登录的账户刚才变了：请重新打开模型设置再保存。' }) });
  const other = refusing.mount(refusing.plugin.components.ModelForm, {});
  other.cells[0] = { ok: true, model: { url: 'https://x.example/v1', name: 'm', configured: false, keyConfigured: false, expectedOrigin: 'o', expectedAccountId: 'a' } };
  await button(other.render(), '保存').props.onClick();
  assert.match(text(other.render()), /登录的账户刚才变了/);
  const english = loadPage({ reply: () => ({ ok: false, teaching: 'Provide a model name and HTTPS endpoint, or a local HTTP endpoint.' }) });
  const third = english.mount(english.plugin.components.ModelForm, {});
  third.cells[0] = other.cells[0];
  await button(third.render(), '保存').props.onClick();
  assert.match(text(third.render()), /没有保存：Provide a model name and HTTPS endpoint, or a local HTTP endpoint\./);
});

test('外观与语言 sets dsh\'s own theme and language services; 高级 points to Console for the MCP token and opens the Runtime workbench for diagnosis', async () => {
  const page = loadPage({ reply: ({ url }) => (url.endsWith('/workbench') ? { ok: true, url: 'http://127.0.0.1:7790/?k=fixture' } : { ok: true }) });
  const theme = { preference: 'system', getTheme() { return { preference: this.preference }; }, setTheme(id) { this.preference = id; } };
  const locale = { active: 'zh', getSnapshot() { return { active: this.active, locales: [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }] }; },
    setLocale(id) { this.active = id; } };
  const slots = { inject() {}, register() {} };
  page.plugin.apply({ slots, effect() {}, sidebarRight: { mounted: { subscribe() {}, getSnapshot: () => undefined } }, sidebarRightTabs: { register() {} },
    inject(deps, fn) { if (deps[0] === 'theme') fn({ theme, effect() {} }); if (deps[0] === 'locale') fn({ locale, effect() {} }); } });
  const appearance = page.mount(page.plugin.components.AppearanceSection);
  let shown = appearance.render();
  const selects = nodes(shown).filter((node) => node.tag === 'select');
  assert.deepEqual(selects.map((select) => select.props.value), ['system', 'zh']);
  assert.deepEqual(selects[0].children.map(text), ['跟随系统', '浅色', '深色']);
  selects[0].props.onChange({ target: { value: 'dark' } });
  selects[1].props.onChange({ target: { value: 'en' } });
  assert.deepEqual([theme.preference, locale.active], ['dark', 'en']);
  shown = appearance.render();
  assert.deepEqual(nodes(shown).filter((node) => node.tag === 'select').map((select) => select.props.value), ['dark', 'en']);
  const advanced = page.mount(page.plugin.components.AdvancedSection, { state: summary }).render();
  assert.equal(find(advanced, (node) => node.tag === 'a').props.href, 'https://console.example/console/#/agents');
  assert.match(text(advanced), /MCP 令牌[\s\S]*Agent MCP token/);
  await button(advanced, '打开 Runtime 工作台').props.onClick();
  assert.equal(page.opened[0].location.href, 'http://127.0.0.1:7790/?k=fixture');
  assert.equal(page.opened[0].opener, null);
  assert.equal(page.posted('workbench').length, 1, 'the workbench address is fetched on demand, never stored in the page');
  // A missing or odd origin gives no link.
  assert.equal(find(page.mount(page.plugin.components.AdvancedSection, { state: { ok: true, origin: 'javascript:alert(1)' } }).render(), (node) => node.tag === 'a'), undefined);
});

test('one tier per conversation: the strictest the Gateway reports, never a wider one, and "不一致" when they differ', () => {
  const { plugin } = loadPage();
  const tier = (conversation) => { const shown = plugin.conversationTier(conversation); return { mode: shown.mode ?? null, mixed: shown.mixed }; };
  assert.deepEqual(tier({ explorationMode: 'non_strict', explorationModesMixed: false, explorationModes: { c1: 'non_strict' } }), { mode: 'non_strict', mixed: false });
  assert.deepEqual(tier({ explorationMode: 'strict', explorationModesMixed: true, explorationModes: null }), { mode: 'strict', mixed: true }, 'unreadable: strict, marked');
  // An older Gateway: per Connection only.
  assert.deepEqual(tier({ explorationModes: { c1: 'non_strict', c2: 'derived' } }), { mode: 'derived', mixed: true });
  assert.deepEqual(tier({ explorationModes: { c1: 'derived' } }), { mode: 'derived', mixed: false });
  // Never wider than any value reported; an unknown value is not guessed.
  assert.deepEqual(tier({ explorationMode: 'non_strict', explorationModes: { c1: 'strict' } }), { mode: 'strict', mixed: false });
  assert.deepEqual(tier({ explorationModes: { c1: 'strict', c2: 'wide_open' } }), { mode: null, mixed: true });
  assert.deepEqual(tier({}), { mode: null, mixed: false });
});

// The composer row over a scripted conversation reply.
function composer(conversation, { reviewer = 'conn-r', found = true } = {}) {
  const settings = { ok: true, found, reviewer, connections: [{ connectionId: 'c1' }, { connectionId: 'c2' }], ...(found ? { conversation } : {}) };
  const page = loadPage({ reply: ({ url }) => (url.includes('exploration-mode') ? { ok: true, state: 'complete' }
    : url.startsWith('/rulith/api/conversation?') ? settings : { ok: true }) });
  const m = page.mount(page.plugin.components.RulithComposerControls, { sessionId: 's1' });
  m.cells[0] = settings;
  m.cells[2] = { ok: true, model: { source: 'default', modelId: 'deepseek-flash', name: 'deepseek-flash', configured: true } };
  return { page, m };
}
const chips = (shown) => nodes(shown).filter((node) => node.tag === 'button' && node.props['aria-haspopup'] === 'menu' || node.props?.['data-rulith-model'] !== undefined).map(text);

test('the composer has exactly two chips, 档位 and 模型; narrowing applies at once, widening shows the approved confirmation first', async () => {
  let { page, m } = composer({ postCallReview: true, explorationMode: 'derived', explorationModesMixed: false, explorationModes: { c1: 'derived', c2: 'derived' } },
    { reviewer: null });
  let shown = m.render();
  assert.deepEqual(chips(shown), ['档位：推导▾', '模型：deepseek-flash'], 'one tier chip for two Connections; no review chip without a reviewer');
  // Narrowing: immediate, one request for the conversation, naming no Connection.
  find(shown, (node) => node.props['data-rulith-tier'] === 'derived').children[0].props.onClick();
  shown = m.render();
  const items = nodes(shown).filter((node) => node.props.role === 'menuitemradio');
  assert.deepEqual(items.map((node) => text(node).split(' · ')[0]), ['○ 严格', '● 推导', '○ 宽松']);
  assert.equal(items[1].props.disabled, true, 'the current tier is not offered again');
  items[0].props.onClick();
  await flush();
  assert.deepEqual(plain(page.posted('conversation/exploration-mode').map((r) => r.body)), [{ session: 's1', mode: 'strict' }]);
  // Widening: the approved confirmation text, and nothing is sent until it is accepted.
  ({ page, m } = composer({ postCallReview: true, explorationMode: 'strict', explorationModes: { c1: 'strict' } }));
  find(m.render(), (node) => node.props['data-rulith-tier'] === 'strict').children[0].props.onClick();
  nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[2].props.onClick();
  shown = m.render();
  assert.equal(text(find(shown, (node) => node.props.role === 'dialog')),
    PSC.WIDEN_TEXT.non_strict.title + PSC.WIDEN_TEXT.non_strict.body + PSC.WIDEN_TEXT.non_strict.accept + PSC.WIDEN_TEXT.non_strict.cancel);
  assert.doesNotMatch(PSC.WIDEN_TEXT.non_strict.body, /「/, 'no Console-only mark is named');
  assert.equal(page.posted('conversation/exploration-mode').length, 0);
  button(shown, PSC.WIDEN_TEXT.non_strict.cancel).props.onClick();
  assert.equal(page.posted('conversation/exploration-mode').length, 0, 'cancelled: nothing changes');
  nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[1].props.onClick();
  button(m.render(), PSC.WIDEN_TEXT.derived.accept).props.onClick();
  await flush();
  assert.deepEqual(plain(page.posted('conversation/exploration-mode').map((r) => r.body)), [{ session: 's1', mode: 'derived' }]);
  // Mixed: the strictest is shown and marked; choosing it again unifies (narrowing for the others, immediate).
  ({ page, m } = composer({ explorationModes: { c1: 'non_strict', c2: 'strict' } }));
  shown = m.render();
  assert.equal(chips(shown)[0], '档位：严格（不一致）▾');
  find(shown, (node) => node.props['data-rulith-tier'] === 'strict').children[0].props.onClick();
  const again = nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[0];
  assert.equal(again.props.disabled, false);
  again.props.onClick();
  await flush();
  assert.deepEqual(plain(page.posted('conversation/exploration-mode').map((r) => r.body)), [{ session: 's1', mode: 'strict' }]);
  // With a reviewer designated, 审查 appears; the model chip opens the settings page's model section.
  shown = m.render();
  assert.deepEqual(chips(shown), ['档位：严格（不一致）▾', '模型：deepseek-flash', '审查：关▾']);
  find(shown, (node) => node.props['data-rulith-model'] !== undefined).props.onClick();
  assert.deepEqual(plain(page.plugin.settingsView.getSnapshot()), { open: true, section: 'model' });
  // A conversation without a Board yet: 默认, and widening from it is confirmed too.
  ({ page, m } = composer(undefined, { found: false }));
  shown = m.render();
  assert.equal(chips(shown)[0], '档位：默认▾');
  find(shown, (node) => node.props['data-rulith-tier'] === 'default').children[0].props.onClick();
  nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[2].props.onClick();
  assert.ok(find(m.render(), (node) => node.props.role === 'dialog'));
  assert.equal(page.posted('conversation/exploration-mode').length, 0);
  // Every word of the chip, its menu and its confirmations is the one PSC 0.2.29 fixes.
  assert.deepEqual(plain(page.plugin.TIER), PSC.TIER);
  assert.deepEqual(plain(page.plugin.MODE_WORDS), PSC.MODE_WORDS);
  assert.deepEqual(plain(page.plugin.MODE_HINTS), PSC.MODE_HINTS);
  assert.deepEqual(plain(page.plugin.WIDEN_TEXT), PSC.WIDEN_TEXT);
});

test('the folder chooser: the OS chooser\'s folder is opened, a cancel does nothing, and where none can open the full path is typed', async () => {
  for (const [answer, expectOpened, expectManual] of [[{ ok: true, state: 'chosen', path: 'D:\\Work\\game' }, ['D:\\Work\\game'], false],
    [{ ok: true, state: 'cancelled' }, [], false], [{ ok: true, state: 'unavailable', teaching: PICK_UNAVAILABLE }, [], true]]) {
    const page = loadPage({ reply: ({ url }) => (url.endsWith('/pick-folder') ? answer : { ok: true }) });
    const chosen = [];
    const chooser = page.mount(page.plugin.components.FolderChooser, { disabled: false, onChosen: async (dir) => { chosen.push(dir); return true; } });
    await find(chooser.render(), (node) => node.props['data-rulith-pick-folder'] !== undefined).props.onClick();
    await flush();
    assert.deepEqual(chosen, expectOpened, answer.state);
    const shown = chooser.render();
    assert.equal(!!find(shown, (node) => node.tag === 'input'), expectManual, answer.state);
    if (expectManual) assert.match(text(shown), /手动输入文件夹的完整路径/);
  }
  // 手动输入路径 is always there; the typed folder is opened like a chosen one.
  const page = loadPage();
  const chosen = [];
  const chooser = page.mount(page.plugin.components.FolderChooser, { disabled: false, onChosen: async (dir) => { chosen.push(dir); return true; } });
  find(chooser.render(), (node) => node.props['data-rulith-type-folder'] !== undefined).props.onClick();
  const input = find(chooser.render(), (node) => node.tag === 'input');
  input.props.onChange({ target: { value: '  /home/you/game ' } });
  find(chooser.render(), (node) => node.tag === 'input').props.onKeyDown({ key: 'Enter' });
  await flush();
  assert.deepEqual(chosen, ['/home/you/game']);
  assert.equal(page.requests.length, 0, 'typing asks the host for no chooser');
});

test('the host\'s folder chooser: dsh\'s native chooser only; chosen, cancelled, unavailable, one at a time, closed when the page goes away', async () => {
  const logged = [];
  let pick = async () => 'D:\\Work\\game';
  const service = { capability: () => ({ kind: 'native', pick: (signal) => pick(signal) }) };
  const picker = folderPicker({ service: () => service, log: (line) => logged.push(line) });
  assert.deepEqual(picker.available(), { available: true });
  assert.deepEqual(await picker.pick(), { state: 'chosen', path: 'D:\\Work\\game' });
  pick = async () => null;
  assert.deepEqual(await picker.pick(), { state: 'cancelled' });
  // One chooser at a time.
  let release;
  pick = () => new Promise((resolve) => { release = resolve; });
  const first = picker.pick();
  await assert.rejects(picker.pick(), (error) => error.errorCode === 'picker_open');
  release('/home/you/game');
  assert.deepEqual(await first, { state: 'chosen', path: '/home/you/game' });
  // The page went away: the chooser's own abort, reported as a cancel.
  const gone = new AbortController();
  pick = (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('native directory picker aborted'))));
  const waiting = picker.pick({ signal: gone.signal });
  gone.abort();
  assert.deepEqual(await waiting, { state: 'cancelled' });
  // A chooser that cannot open: the typed path, said plainly (the failure is logged without a path).
  pick = async () => { throw new Error('win32 folder dialog failed: COM error'); };
  assert.deepEqual(await picker.pick(), { state: 'unavailable', teaching: PICK_UNAVAILABLE });
  assert.match(logged[0], /folder chooser could not be opened/);
  // No native backend (a remote page, SSH, no display): dsh's browse backend, or none at all.
  for (const other of [undefined, { capability: () => ({ kind: 'browse' }) }, { capability: () => { throw new Error('x'); } }]) {
    const none = folderPicker({ service: () => other });
    assert.deepEqual(none.available(), { available: false });
    assert.deepEqual(await none.pick(), { state: 'unavailable', teaching: PICK_UNAVAILABLE });
  }
});

test('host routes: the folder chooser, the account default Agent passed on only as the service marks it, the model of a conversation, and one tier read', async (t) => {
  const { apply } = await import('../../harness/web/rulith-runtime.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulith-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'fixture-key.txt');
  fs.writeFileSync(keyFile, 'fixture-manager-key');
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(net, 'connect', (_options, callback) => { const socket = new EventEmitter(); socket.destroy = () => {}; queueMicrotask(callback); return socket; });
  const state = { device: { state: 'linked', origin: 'https://console.example', account: { id: 'acct-1', name: 'Owner' },
    agents: [{ id: 'a1', name: 'Default agent', isDefault: true }, { id: 'a2', name: 'Other', isDefault: 'yes' }, { id: 'a3', name: 'Third' }] },
    instances: [] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/manager/state') return new Response(JSON.stringify({ ok: true, ...state }));
    return new Response(JSON.stringify({ ok: false, teaching: 'unexpected' }), { status: 404 });
  });
  let picks = 0;
  const directoryPicker = { capability: () => ({ kind: 'native', pick: async () => { picks++; return 'D:\\Work\\game'; } }) };
  let server;
  const effects = [];
  await apply({ on() {}, effect(fn) { effects.push(fn()); }, get: (name) => (name === 'directoryPicker' ? directoryPicker : undefined),
    tools: { register: () => () => {} }, webServer: { register(route) { server = route; return () => {}; } }, connection: { admit: () => ({ peer: {} }) } },
    { managerHome: dir, runtimeEntry: 'fixture-runtime', keyFile, shadow: { enabled: false } });
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  const call = async (method, route, body) => {
    const req = new EventEmitter();
    Object.assign(req, { method, url: '/rulith/api/' + route, headers: { host: '127.0.0.1:3080', 'x-deep-rulith': '1' } });
    const res = new EventEmitter();
    let reply;
    res.writeHead = () => {}; res.end = (data) => { res.writableEnded = true; reply = JSON.parse(data); };
    const done = server.handler(req, res);
    queueMicrotask(() => { if (body) req.emit('data', JSON.stringify(body)); req.emit('end'); });
    await done;
    return reply;
  };
  assert.deepEqual(await call('GET', 'pick-folder'), { ok: true, available: true });
  assert.deepEqual(await call('POST', 'pick-folder', {}), { ok: true, state: 'chosen', path: 'D:\\Work\\game' });
  assert.equal(picks, 1);
  // The tree and the account entry carry isDefault only as a boolean from the service; nothing is derived.
  const tree = await call('GET', 'tree');
  assert.deepEqual(tree.agents.map((agent) => [agent.agentId, agent.isDefault]), [['a1', true], ['a2', undefined], ['a3', undefined]]);
  const entry = await call('GET', 'state');
  assert.deepEqual(entry.agents.map((agent) => [agent.id, agent.isDefault]), [['a1', true], ['a2', undefined], ['a3', undefined]]);
  assert.equal(entry.computer, os.hostname());
  // A conversation's model: its Agent's (none attached here: the account default), never a key.
  const model = await call('GET', 'model?session=s1');
  assert.equal(model.ok, true);
  assert.equal(model.model.source, 'default');
  assert.equal(Object.hasOwn(model.model, 'key'), false);
  // The conversation read passes the one tier and its "mixed" mark through, besides the per-Connection detail.
  const view = conversationView({ found: true, conversation: { explorationMode: 'strict', explorationModesMixed: true, explorationModes: null },
    explorationMode: 'strict', explorationModesMixed: true, device: { token: 'never' } });
  assert.deepEqual(view, { found: true, conversation: { explorationMode: 'strict', explorationModesMixed: true, explorationModes: null },
    explorationMode: 'strict', explorationModesMixed: true });
  // And a deletion's outcome (PSC 0.2.27 ⑤): finished or not, why not, and the closings Core refused.
  const ended = conversationView({ agentId: 'a1', boardId: 'b', ended: true, endedAt: 't', settled: false, closedGoals: [], refusedGoals: [{ caseId: 'c', code: 'x' }],
    unconfirmedGoals: ['g'], goalsUnread: true, found: true, deletion: { settled: false, reasons: [{ code: 'goals_unread' }] }, instances: [{ id: 'never' }] });
  assert.deepEqual(Object.keys(ended).sort(), ['boardId', 'closedGoals', 'deletion', 'ended', 'endedAt', 'found', 'goalsUnread', 'refusedGoals', 'settled', 'unconfirmedGoals']);
});

test('deleting: only a finished deletion takes the row away; otherwise its reasons and 补完删除, the same deletion continued', async () => {
  const { plugin } = loadPage();
  const outcome = (reply) => plain(plugin.deletionOutcome(reply));
  assert.deepEqual(outcome({ settled: true, refusedGoals: [] }), { settled: true, reasons: [], refused: 0 });
  assert.deepEqual(outcome({ settled: true, refusedGoals: [{ caseId: 'c1', code: 'refused' }] }), { settled: true, reasons: [], refused: 1 });
  assert.deepEqual(outcome({ settled: false, unconfirmedGoals: ['g1', 'g2'], goalsUnread: true }),
    { settled: false, reasons: ['2 个任务的结案还没有确认', '读不到它还开着的任务'], refused: 0 });
  assert.deepEqual(outcome({ deletion: { settled: false, reasons: [{ code: 'closings_unconfirmed', count: 3 }, { code: 'deleted_before_recording' }] } }),
    { settled: false, reasons: ['3 个任务的结案还没有确认', '它是在开始记录删除结果之前删除的'], refused: 0 });
  assert.deepEqual(outcome({ deletion: { settled: true, refusedGoals: [{ caseId: 'c' }] } }), { settled: true, reasons: [], refused: 1 });
  // PSC 0.2.28 erratum: every closing answered and the goals read, only the finished record missing (补完删除 records it).
  assert.deepEqual(outcome({ deletion: { settled: false, reasons: [{ code: 'settlement_unrecorded' }] } }),
    { settled: false, reasons: ['删除已办完，还没记下'], refused: 0 });
  // A code this page has no words for is named as it is, never read from the object's prototype.
  assert.deepEqual(outcome({ deletion: { settled: false, reasons: [{ code: 'constructor' }] } }).reasons, ['constructor']);
  // An older Gateway without `settled`: finished only when nothing is unconfirmed or unread.
  assert.equal(outcome({ unconfirmedGoals: [] }).settled, true);
  assert.equal(outcome({ goalsUnread: true }).settled, false);
  // In the sidebar.
  const treeReply = { ok: true, defaultAgentId: 'a1', assignments: { s1: 'a1' }, agents: [{ agentId: 'a1', name: 'alpha', attached: true,
    directories: [{ path: '/project', label: 'project', source: 'project' }] }] };
  const answers = [{ ok: true, settled: false, unconfirmedGoals: ['g1', 'g2'], goalsUnread: false, refusedGoals: [] },
    { ok: true, settled: true, unconfirmedGoals: [], refusedGoals: [{ caseId: 'c1', code: 'refused' }] }];
  const page = loadPage({ reply: ({ url }) => (url.endsWith('/end-preview') ? { ok: true, found: true, openGoals: ['g1', 'g2'] }
    : url.endsWith('/conversation/end') ? answers.shift() : url === '/rulith/api/tree' ? treeReply : { ok: true }) });
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const archived = [];
  const list = { ids: ['s1'], byId: { s1: { id: 's1', cwd: '/project', title: 'work', updatedAt: Date.now(), running: false, blank: false } } };
  const tree = page.mount(page.plugin.makeRulithTree({ sessions: { list: store(list) }, workspaces: { list: store({}) },
    ui: { selection: store({ sessionId: 's1' }), openSession() {}, archiveSession: (id) => archived.push(id) } }), { wide: true });
  tree.cells[0] = treeReply;
  await find(tree.render(), (node) => node.props['data-rulith-delete'] === 's1').props.onClick({ stopPropagation() {} });
  await flush();
  const dialog = find(tree.render(), (node) => node.props['data-rulith-delete-dialog'] === 's1');
  await find(dialog, (node) => node.tag === 'button' && text(node) === '删除').props.onClick();
  await flush();
  let shown = tree.render();
  assert.deepEqual(archived, [], 'not finished: the row stays');
  assert.equal(text(find(shown, (node) => node.props['data-rulith-unsettled'] === 's1')), '没删完：2 个任务的结案还没有确认');
  assert.equal(find(shown, (node) => node.props['data-rulith-delete'] === 's1'), undefined);
  // 补完删除: the same deletion, without asking again; finished, the row goes, and refused closings are said.
  await find(shown, (node) => node.props['data-rulith-finish-delete'] === 's1').props.onClick({ stopPropagation() {} });
  await flush();
  shown = tree.render();
  assert.deepEqual(archived, ['s1']);
  assert.equal(page.posted('conversation/end').length, 2);
  assert.equal(page.posted('conversation/end-preview').length, 1, 'finishing asks nothing again');
  assert.match(text(shown), /已删除。其中 1 个任务没能结案/);
});

test('a deleted conversation\'s composer offers nothing to set', () => {
  const { page, m } = composer({ endedAt: '2026-10-23T10:00:00Z', deletion: { settled: false, reasons: [{ code: 'goals_unread' }] } });
  const shown = m.render();
  assert.equal(text(shown), '这个会话已删除，不能再继续');
  assert.equal(chips(shown).length, 0);
  void page;
});

test('a tier switch reports its outcome: pending says why it waits, a refusal says why and what to do', async () => {
  // The codes the tier route returns (GatewayConversationController, GatewayControlService, AgentControlStore): a refused
  // request (ok:false with its code) or a complete control the Kernel refused. A code the page has no words for shows the
  // generic sentence followed by the service's own text.
  const turnOnReview = 'Turn post-call review back on for this conversation before switching it to derived mode.';
  const cases = [[{ ok: true, state: 'pending', teaching: 'The switch is committed between calls.' }, PSC.TIER.betweenCalls],
    [{ ok: true, state: 'pending' }, PSC.TIER.later],
    [{ ok: true, state: 'pending', teaching: 'Waiting for the Kernel.' }, PSC.TIER.accepted + '：Waiting for the Kernel.'],
    [{ ok: false, errorCode: 'review_required_by_derived_mode', teaching: turnOnReview }, '先为这个会话打开事后审查，再切到推导档。'],
    [{ ok: true, state: 'complete', result: { accepted: false, errorCode: 'review_required_by_derived_mode', teaching: turnOnReview } }, PSC.TIER_REFUSALS.review_required_by_derived_mode],
    [{ ok: false, errorCode: 'something_new', teaching: 'A new reason.' }, PSC.TIER.notSwitched + '：A new reason.'],
    [{ ok: false, errorCode: 'something_new' }, PSC.TIER.notSwitched + '：something_new'],
    [{ ok: true, state: 'complete', result: { accepted: false, errorCode: 'kernel_new', teaching: 'Kernel words.' } }, PSC.TIER.notAccepted + '：Kernel words.'],
    [{ ok: true, state: 'complete', result: { accepted: true } }, null],
    ...Object.entries(PSC.TIER_REFUSALS).map(([code, words]) => [{ ok: false, errorCode: code, teaching: 'English teaching' }, words])];
  for (const [answer, words] of cases) {
    const settings = { ok: true, found: true, reviewer: null, conversation: { explorationMode: 'non_strict', explorationModes: { c1: 'non_strict' } } };
    const page = loadPage({ reply: ({ url }) => (url.includes('exploration-mode') ? answer : url.startsWith('/rulith/api/conversation?') ? settings : { ok: true }) });
    const m = page.mount(page.plugin.components.RulithComposerControls, { sessionId: 's1' });
    m.cells[0] = settings;
    find(m.render(), (node) => node.props['data-rulith-tier'] === 'non_strict').children[0].props.onClick();
    nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[0].props.onClick();
    await flush();
    const note = find(m.render(), (node) => node.props.role === 'alert');
    if (words) assert.equal(text(note), words, JSON.stringify(answer)); else assert.equal(note, undefined);
  }
  assert.deepEqual(plain(loadPage().plugin.TIER_REFUSALS), PSC.TIER_REFUSALS);
});

test('a review switch refused says why and what to do, with the codes the review route returns', async () => {
  const cases = [[{ ok: false, errorCode: 'derived_requires_review', teaching: 'Switch this conversation out of derived mode before turning its review off.' },
    '先把这个会话切出推导档，再关闭事后审查。'],
  [{ ok: false, errorCode: 'something_new', teaching: 'A new reason.' }, PSC.TIER.notSwitched + '：A new reason.'],
  [{ ok: true, found: true }, null],
  ...Object.entries(PSC.REVIEW_REFUSALS).map(([code, words]) => [{ ok: false, errorCode: code, teaching: 'English teaching' }, words])];
  for (const [answer, words] of cases) {
    const settings = { ok: true, found: true, reviewer: 'c9', conversation: { explorationMode: 'derived', explorationModes: { c1: 'derived' }, postCallReview: true } };
    const page = loadPage({ reply: ({ url }) => (url.endsWith('/conversation/review') ? answer : url.startsWith('/rulith/api/conversation?') ? settings : { ok: true }) });
    const m = page.mount(page.plugin.components.RulithComposerControls, { sessionId: 's1' });
    m.cells[0] = settings;
    find(m.render(), (node) => node.props['data-rulith-review'] === 'on').children[0].props.onClick();
    nodes(m.render()).filter((node) => node.props.role === 'menuitemradio')[1].props.onClick();
    await flush();
    assert.deepEqual(plain(page.posted('conversation/review').map((r) => r.body)), [{ session: 's1', enabled: false }]);
    const note = find(m.render(), (node) => node.props.role === 'alert');
    if (words) assert.equal(text(note), words, JSON.stringify(answer)); else assert.equal(note, undefined);
  }
  assert.deepEqual(plain(loadPage().plugin.REVIEW_REFUSALS), PSC.REVIEW_REFUSALS);
});

test('the exploration-mode route names no Connection: one request per conversation', () => {
  const host = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  const route = host.slice(host.indexOf("'POST /rulith/api/conversation/exploration-mode'"), host.indexOf("'POST /rulith/api/conversation/review'"));
  assert.match(route, /manager\('\/manager\/conversations\/exploration-mode',\s*\{ agentId: target\.agentId, conversationKey: target\.conversationKey, mode, requestId \}\)/);
  assert.doesNotMatch(route, /connectionId/);
});
