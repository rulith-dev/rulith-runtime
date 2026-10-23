// Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01, D-1018b batch 3): the host routes and the page's flow.
// No network: the manager is a stand-in function, the Gateway's answers are fixtures shaped like
// rulith-java LocalProjectService (state not_open / pending / ready, 202 retry, 409 confirm_again, refusals by code).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { localFolder, projectPlatform, projectRoutes, projectTarget, projectView, sourceAttention, PROJECT_SOURCE }
  from '../../harness/web/open-project.mjs';

const TOOLS = ['eng.acceptance@2', 'eng.apply_patch@2', 'eng.glob@1', 'eng.job_poll@2', 'eng.job_start@2', 'eng.job_stop@2',
  'eng.list@1', 'eng.patch_file@2', 'eng.read@2', 'eng.read_image@1', 'eng.run@2', 'eng.search@1', 'eng.test@3',
  'eng.tree_state@1', 'eng.write_file@2'].map((id) => ({ id, digest: 'f'.repeat(64), directUse: true }));
// The Gateway's state answer for a folder that is not open yet (LocalProjectService.base).
const notOpen = (directory = 'D:\\Work\\game', extra = {}) => ({ state: 'not_open', accountId: 'acct-1', agentId: 'agent-1',
  agentName: 'Default agent', connectionId: 'conn-1', connectionName: 'Workspace', directory, authorizationVersion: 'sha256:v1',
  computer: { deviceId: 'dev-1', label: 'OWNER-PC' }, capability: { releaseDigest: 'sha256:r', id: 'engineering_work', version: '1.0.0' },
  tools: TOOLS, mode: { requested: 'non_strict' }, ...extra });
const managerState = { device: { state: 'linked', account: { id: 'acct-1', name: 'Owner' }, agents: [{ id: 'agent-1', name: 'Default agent' }] },
  instances: [{ id: 'inst-1', mode: 'local_agent', agentId: 'agent-1', paired: true, connectionId: 'conn-1', signedOutAt: '' }] };

test('the platform comes from this computer, and a folder must be an existing absolute folder of its system', () => {
  assert.equal(projectPlatform('win32'), 'windows');
  for (const p of ['linux', 'darwin', 'freebsd']) assert.equal(projectPlatform(p), 'posix');
  const dirs = new Set(['D:\\Work\\game', 'D:\\Work\\link', 'Z:\\proj', '\\\\server\\share\\game', '/home/owner/game', '/mnt/share/game']);
  // The real path: a junction names its target, a mapped drive its share, and letter case is the folder's own.
  const real = { 'D:\\Work\\link': 'E:\\Data\\Game', 'Z:\\proj': '\\\\server\\share\\proj' };
  const files = { statSync: (p) => { if (!dirs.has(p)) throw new Error('absent'); return { isDirectory: () => true }; },
    realpathSync: (p) => real[p] ?? p };
  assert.equal(localFolder('  D:/Work/game/ ', 'win32', files), 'D:\\Work\\game');
  assert.equal(localFolder('D:\\Work\\x\\..\\game', 'win32', files), 'D:\\Work\\game');
  assert.equal(localFolder('D:\\Work\\link', 'win32', files), 'E:\\Data\\Game', 'the grant names the folder commands will run in');
  assert.equal(localFolder('/home/owner/./game/', 'linux', files), '/home/owner/game');
  assert.equal(localFolder('/mnt/share/game', 'linux', files), '/mnt/share/game', 'a mounted share is an ordinary directory elsewhere');
  // Windows: a network folder, typed as a share or reached through a mapped drive, cannot be a working directory of cmd.exe.
  for (const raw of ['\\\\server\\share\\game', '//server/share/game', 'Z:\\proj'])
    assert.throws(() => localFolder(raw, 'win32', files), (error) => error.errorCode === 'folder_network' && /网络上的文件夹/.test(error.message), raw);
  for (const [raw, platform] of [['', 'win32'], ['game', 'win32'], ['D:game', 'win32'], ['\\game', 'win32'], ['/home/owner/game', 'win32'],
    ['home/owner', 'linux'], ['D:\\Work\\absent', 'win32'], ['/home/owner/absent', 'linux']])
    assert.throws(() => localFolder(raw, platform, files), (error) => error.errorCode === 'folder_invalid' && /[\u4e00-\u9fff]/.test(error.message), raw);
  const file = { statSync: () => ({ isDirectory: () => false }), realpathSync: (p) => p };
  assert.throws(() => localFolder('/home/owner/game', 'linux', file), /没有这个文件夹/);
  // On this computer, with the real file system.
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-folder-'));
  try { assert.equal(localFolder(here), fs.realpathSync.native(here)); } finally { fs.rmSync(here, { recursive: true, force: true }); }
});

test('who opens: the signed-in account, an Agent of it, and that Agent\'s Connection paired on this computer', () => {
  assert.deepEqual(projectTarget(managerState, 'agent-1'), { accountId: 'acct-1', accountName: 'Owner', agentId: 'agent-1', connectionId: 'conn-1',
    instanceId: 'inst-1' });
  const codeOf = (state, agent) => { try { projectTarget(state, agent); } catch (error) { return error.errorCode; } };
  assert.equal(codeOf({ device: { state: 'revoked' } }, 'agent-1'), 'not_signed_in');
  assert.equal(codeOf(managerState, 'agent-2'), 'agent_not_in_account');
  assert.equal(codeOf({ ...managerState, instances: [] }, 'agent-1'), 'agent_not_set_up');
  assert.equal(codeOf({ ...managerState, instances: [{ ...managerState.instances[0], paired: false }] }, 'agent-1'), 'agent_not_set_up');
  assert.equal(codeOf({ ...managerState, instances: [{ ...managerState.instances[0], signedOutAt: '2026-10-18' }] }, 'agent-1'), 'agent_not_set_up');
});

test('the page sees the confirmation content and the outcome, never the manager\'s state, digests or ids of the device', () => {
  const reply = { ok: true, ...notOpen(), stateServerId: 'x', instances: [{ id: 'inst-1' }], device: { token: 'never' }, root: 'C:\\manager',
    project: { openRequestId: 'open.1' }, openRequestId: 'open.1' };
  const view = projectView(reply);
  assert.deepEqual(Object.keys(view).sort(), ['accountId', 'agentId', 'agentName', 'authorizationVersion', 'capability', 'computer',
    'connectionName', 'directory', 'mode', 'state', 'tools'].sort());
  assert.deepEqual(view.computer, { label: 'OWNER-PC' });
  assert.deepEqual(view.capability, { id: 'engineering_work', version: '1.0.0' });
  assert.deepEqual(view.tools[0], { id: 'eng.acceptance@2', directUse: true });
  assert.doesNotMatch(JSON.stringify(view), /never|ffff|dev-1|inst-1|manager|sha256:r/);
});

test('host routes forward exactly the Gateway contract through the manager and refuse locally before sending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-project-'));
  try {
    const calls = [], ready = [];
    let answer = (route) => (route === '/manager/projects/state' ? { ok: true, ...notOpen(dir) } : { ok: true, ...notOpen(dir, { state: 'ready' }) });
    const manager = async (route, body) => { calls.push([route, body]); return route === '/manager/state' ? managerState : answer(route, body); };
    const routes = projectRoutes({ manager, platform: process.platform, onReady: (id) => ready.push(id) });
    const shown = await routes.state({ agentId: 'agent-1', directory: dir });
    assert.equal(shown.state, 'not_open');
    assert.equal(shown.accountName, 'Owner', 'the account the authorization belongs to, by the name this computer shows');
    assert.deepEqual(calls[1], ['/manager/projects/state', { expectedAccountId: 'acct-1', agentId: 'agent-1', connectionId: 'conn-1',
      directory: fs.realpathSync.native(dir), platform: projectPlatform() }]);
    assert.deepEqual(ready, []);
    const opened = await routes.open({ agentId: 'agent-1', directory: dir, requestId: 'b3c1d0a2-0000-4000-8000-000000000001',
      authorizationVersion: 'sha256:v1', expectedAccountId: 'acct-1' });
    assert.equal(opened.state, 'ready');
    assert.deepEqual(calls[3], ['/manager/projects/open', { requestId: 'b3c1d0a2-0000-4000-8000-000000000001', expectedAccountId: 'acct-1',
      agentId: 'agent-1', connectionId: 'conn-1', directory: fs.realpathSync.native(dir), platform: projectPlatform(), authorizationVersion: 'sha256:v1' }]);
    assert.deepEqual(ready, ['inst-1'], 'a ready project drops the cached Sources so the folder shows under the Agent');
    // Refused here, before the manager hears of it.
    const before = calls.filter(([route]) => route.startsWith('/manager/projects/')).length;
    for (const body of [{ agentId: 'agent-1', directory: dir, requestId: 'short', authorizationVersion: 'sha256:v1' },
      { agentId: 'agent-1', directory: dir, requestId: 'b3c1d0a2-0000-4000-8000-000000000002', authorizationVersion: '' },
      { agentId: 'agent-1', directory: path.join(dir, 'absent'), requestId: 'b3c1d0a2-0000-4000-8000-000000000003', authorizationVersion: 'v' },
      { agentId: 'agent-9', directory: dir, requestId: 'b3c1d0a2-0000-4000-8000-000000000004', authorizationVersion: 'v' }])
      await assert.rejects(routes.open(body), (error) => typeof error.errorCode === 'string');
    assert.equal(calls.filter(([route]) => route.startsWith('/manager/projects/')).length, before);
    // A mapped network drive on Windows is refused here too: its real path is a share.
    const mapped = projectRoutes({ manager, platform: 'win32', files: { statSync: () => ({ isDirectory: () => true }),
      realpathSync: () => '\\\\server\\share\\proj' } });
    await assert.rejects(mapped.state({ agentId: 'agent-1', directory: 'Z:\\proj' }), (error) => error.errorCode === 'folder_network');
    assert.equal(calls.filter(([route]) => route.startsWith('/manager/projects/')).length, before);
    // A reply about another account carries no name of this one.
    answer = () => ({ ok: true, ...notOpen(dir, { accountId: 'acct-2' }) });
    assert.equal((await routes.state({ agentId: 'agent-1', directory: dir })).accountName, undefined);
    // A Gateway refusal keeps its code on the way to the page.
    answer = () => { throw Object.assign(new Error('nested'), { errorCode: 'project_nested' }); };
    await assert.rejects(routes.state({ agentId: 'agent-1', directory: dir }), (error) => error.errorCode === 'project_nested');
    // A Runtime manager without the project routes (0.17.2 and earlier) says so in plain words.
    answer = () => { throw Object.assign(new Error('Endpoint not found.'), { status: 404 }); };
    await assert.rejects(routes.state({ agentId: 'agent-1', directory: dir }),
      (error) => error.errorCode === 'runtime_unsupported' && /版本太旧/.test(error.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Source attention: an official project Source is opened from the sidebar, every other Source stays Console\'s', () => {
  for (const name of ['project', 'project-0a1b2c3d']) assert.ok(PROJECT_SOURCE.test(name));
  for (const name of ['projects', 'project-0A1B2C3D', 'project-0a1b2c3', 'lab', 'my-project']) assert.ok(!PROJECT_SOURCE.test(name));
  assert.deepEqual(sourceAttention({ name: 'project', state: 'needs_binding' }, 'https://console/x'),
    { text: '还没有打开项目文件夹：在左侧智能体下点「打开文件夹…」', source: 'project' });
  assert.equal(sourceAttention({ name: 'project-0a1b2c3d', state: 'needs_relock' }, 'https://console/x').url, undefined);
  assert.deepEqual(sourceAttention({ name: 'lab', state: 'needs_binding' }, 'https://console/x'),
    { text: 'Source lab 未就绪（needs_binding）', url: 'https://console/x', source: 'lab' });
  assert.equal(sourceAttention({ name: 'project', state: 'publication_pending' }, 'u').url, 'u');
});

// ---- The page half (client.js), loaded as dsh's module loader would.
function loadClient() {
  let plugin;
  const React = { createElement: () => null, useState: (v) => [v, () => {}], useCallback: (f) => f, useEffect() {}, useRef: (v) => ({ current: v }),
    useSyncExternalStore: (_s, g) => g() };
  vm.runInNewContext(fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } }, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout() {}, setInterval() { return 1; }, clearInterval() {}, fetch: async () => ({ json: async () => ({}) }),
  });
  return plugin;
}
const client = loadClient();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the confirmation lists every item PSC 0.2.24 requires, from the Gateway\'s answer, in plain words', () => {
  const shown = plain(client.projectConfirmation(notOpen()));
  const text = [shown.title, ...shown.rows.flat(), shown.footer].join('\n');
  const row = (label) => shown.rows.find(([name]) => name === label)?.[1];
  assert.equal(row('文件夹'), 'D:\\Work\\game');
  assert.equal(row('账户'), 'acct-1', 'without a name the account shows by its id');
  assert.equal(plain(client.projectConfirmation(notOpen(undefined, { accountName: 'Owner' }))).rows.find(([name]) => name === '账户')[1], 'Owner');
  assert.equal(row('智能体'), 'Default agent');
  assert.equal(row('这台电脑'), 'OWNER-PC（本机连接「Workspace」）');
  assert.match(row('可以做的事'), /读文件.*写文件.*运行命令/);
  for (const tool of TOOLS) assert.ok(row('所用工具').includes(tool.id), tool.id);
  assert.match(row('所用工具'), /读文件（eng\.read@2）.*运行命令（eng\.run@2）/);
  assert.match(row('所用工具'), /engineering_work 1\.0\.0/);
  assert.match(row('档位'), /非严格/);
  assert.match(row('档位'), /命令和参数不再需要事先有依据/);
  assert.match(row('档位'), /只由你签字的验收合同认定/);
  assert.match(row('请注意'), /不是操作系统级的隔离/);
  assert.match(row('怎么撤销'), /Console 里解除这个项目的锁定/);
  assert.match(row('怎么撤销'), /停用这台电脑的登录/);
  assert.match(shown.footer, /已有的会话不受影响/);
  assert.doesNotMatch(text, /Board|Action|程序|program|治理|Release|Source|摘要|digest/i, 'no internal terms');
  // The server's list is the truth: other tools, another folder, another computer show as they are.
  const other = plain(client.projectConfirmation(notOpen('/home/o/x', { tools: [{ id: 'eng.new_tool@1' }], computer: { label: '' } })));
  assert.equal(other.rows.find(([name]) => name === '所用工具')[1].split('。')[0], 'eng.new_tool@1');
  assert.equal(other.rows.find(([name]) => name === '这台电脑')[1], '未命名的电脑（本机连接「Workspace」）');
  // Nothing to confirm when the answer is incomplete or the mode cannot be explained.
  for (const broken of [notOpen('', {}), notOpen(undefined, { tools: [] }), notOpen(undefined, { authorizationVersion: '' }),
    notOpen(undefined, { computer: undefined }), notOpen(undefined, { accountId: '' }), notOpen(undefined, { accountId: undefined })])
    assert.ok(client.projectConfirmation(broken).error);
  assert.match(client.projectConfirmation(notOpen(undefined, { mode: { requested: 'strict_plus' } })).error, /说明不了要设置的档位/);
});

// A scripted Gateway behind the page's api(): each call takes the next answer, recorded with what was sent.
function scripted(answers) {
  const sent = [];
  const api = async (route, body) => {
    sent.push([route, plain(body)]);
    const next = answers.shift();
    if (next === undefined) throw new Error('unexpected call ' + route);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(route, body) : next;
  };
  return { api, sent };
}
const flowUi = (decisions = []) => {
  const asked = [], progress = [], waits = [];
  return { asked, progress, waits, ui: { confirm: async (view, note) => { asked.push({ view: plain(view), note }); return decisions.shift() ?? true; },
    progress: (text) => progress.push(text), wait: async (ms) => { waits.push(ms); } } };
};
const ids = () => { let n = 0; return () => 'req-' + String(++n).padStart(4, '0'); };

test('flow: confirm, open with a fresh request id and the confirmed version, follow progress, ready', async () => {
  const pending = (stage, extra = {}) => ({ ok: true, ...notOpen(undefined, { state: 'pending', stage, recovery: 'retry', ...extra }) });
  const { api, sent } = scripted([{ ok: true, ...notOpen() },
    pending('configuration', { waitingFor: 'agent_call_pending', requestId: 'req-0001' }),  // the open itself: first step waits
    { ok: true, ...notOpen() },                                                              // read first: still the same content
    pending('program'),                                                                       // so the same request again
    pending('mode', { waitingFor: 'kernel_confirmation' }),                                   // then state reads
    { ok: true, ...notOpen(undefined, { state: 'ready', directory: 'D:\\Work\\Game' }) }]);
  const f = flowUi();
  const result = plain(await client.openProjectFlow({ api, agentId: 'agent-1', directory: 'd:/work/game', ui: f.ui, newRequestId: ids() }));
  assert.deepEqual(result, { outcome: 'ready', directory: 'D:\\Work\\Game' }, 'the conversation starts in the folder as the project names it');
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].note, '');
  const open = { agentId: 'agent-1', directory: 'd:/work/game', requestId: 'req-0001', authorizationVersion: 'sha256:v1', expectedAccountId: 'acct-1' };
  const state = ['projects/state', { agentId: 'agent-1', directory: 'd:/work/game' }];
  assert.deepEqual(sent, [state, ['projects/open', open], state, ['projects/open', open], state, state]);
  assert.ok(f.progress.some((text) => text.includes('第 1 步') && text.includes('调用没有结束')));
  assert.ok(f.progress.some((text) => text.includes('第 2 步')));
  assert.ok(f.progress.some((text) => text.includes('第 3 步') && text.includes('非严格')));
  assert.ok(f.waits.every((ms) => ms > 0 && ms <= 2000), 'short pauses only');
});

test('flow: an open folder needs no dialog; cancelling sends nothing; a Console-only conflict says so', async () => {
  let s = scripted([{ ok: true, ...notOpen(undefined, { state: 'ready' }) }]), f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'ready');
  assert.equal(f.asked.length, 0);
  s = scripted([{ ok: true, ...notOpen() }]); f = flowUi([false]);
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'cancelled');
  assert.equal(s.sent.filter(([route]) => route === 'projects/open').length, 0);
  s = scripted([{ ok: true, ...notOpen(undefined, { state: 'unavailable', recovery: 'console' }) }]); f = flowUi();
  const conflict = plain(await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() }));
  assert.equal(conflict.outcome, 'refused');
  assert.match(conflict.text, /另一项授权占用/);
});

test('flow: a terminal state asks again, and only a new confirmation (new request id) opens again', async () => {
  const s = scripted([{ ok: true, ...notOpen() },
    { ok: true, ...notOpen(undefined, { state: 'mode_changed', recovery: 'confirm_again', authorizationVersion: 'sha256:v2' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  const f = flowUi();
  const result = await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() });
  assert.equal(result.outcome, 'ready');
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[1].note, /档位又被改回去了/);
  const opens = s.sent.filter(([route]) => route === 'projects/open').map(([, body]) => [body.requestId, body.authorizationVersion]);
  assert.deepEqual(opens, [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2']]);
  // Each terminal state says why the owner is asked again; a state read that finds one asks again the same way.
  for (const [state, words] of [['opened_elsewhere', /不是在这台电脑上确认的/], ['mode_refused', /多次没有成功/], ['revoked', /授权已经收回/]]) {
    const again = scripted([{ ok: true, ...notOpen(undefined, { state, recovery: 'confirm_again' }) }, { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
    const g = flowUi();
    assert.equal((await client.openProjectFlow({ api: again.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: g.ui, newRequestId: ids() })).outcome, 'ready');
    assert.match(g.asked[0].note, words, state);
  }
  // A still-retryable refusal of the mode is progress, not a new question.
  const retry = scripted([{ ok: true, ...notOpen() }, { ok: true, ...notOpen(undefined, { state: 'mode_refused', stage: 'mode', recovery: 'retry' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  const h = flowUi();
  assert.equal((await client.openProjectFlow({ api: retry.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: h.ui, newRequestId: ids() })).outcome, 'ready');
  assert.equal(h.asked.length, 1);
  assert.ok(h.progress.some((text) => text.includes('正在重试')));
});

const opensOf = (s) => s.sent.filter(([route]) => route === 'projects/open').map(([, body]) => [body.requestId, body.authorizationVersion]);
const routesOf = (s) => s.sent.map(([route]) => route.replace('projects/', ''));

test('flow: content changed after the confirmation is shown again; a lost reply is resent only after reading the state', async () => {
  const s = scripted([{ ok: true, ...notOpen() },
    { ok: false, errorCode: 'authorization_changed', teaching: 'What this computer showed for confirmation no longer matches' },
    { ok: true, ...notOpen(undefined, { authorizationVersion: 'sha256:v3' }) },
    new TypeError('fetch failed'),                                                   // the open's reply is lost
    { ok: true, ...notOpen(undefined, { authorizationVersion: 'sha256:v3' }) },      // read: nothing recorded, same content
    { ok: false, errorCode: 'project_unavailable', teaching: 'Retry the original request.' },
    { ok: true, ...notOpen(undefined, { authorizationVersion: 'sha256:v3' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  const f = flowUi();
  const result = await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() });
  assert.equal(result.outcome, 'ready');
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[1].note, /变了/);
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v3'], ['req-0002', 'sha256:v3'], ['req-0002', 'sha256:v3']],
    'after the content changed a new confirmation; after a lost reply the same request');
  assert.deepEqual(routesOf(s), ['state', 'open', 'state', 'open', 'state', 'open', 'state', 'open'], 'every resend follows a state read');
});

test('flow: a withdrawal, other content or a recorded opening found before a resend is never overridden by the old request', async () => {
  const pending = (stage) => ({ ok: true, ...notOpen(undefined, { state: 'pending', stage, recovery: 'retry' }) });
  // The first step waited; meanwhile the project was withdrawn (the lock is part of the version): ask again, new request.
  let s = scripted([{ ok: true, ...notOpen() }, pending('configuration'),
    { ok: true, ...notOpen(undefined, { state: 'revoked', recovery: 'confirm_again', authorizationVersion: 'sha256:v9' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  let f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'ready');
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v9']]);
  assert.match(f.asked[1].note, /授权已经收回/);
  // The open's reply was lost and the content is now different: ask again rather than resend.
  s = scripted([{ ok: true, ...notOpen() }, new TypeError('fetch failed'), { ok: true, ...notOpen(undefined, { authorizationVersion: 'sha256:v2' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'ready');
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2']]);
  assert.match(f.asked[1].note, /变了/);
  // The open's reply was lost but the opening was recorded: follow it, nothing is resent.
  s = scripted([{ ok: true, ...notOpen() }, new TypeError('fetch failed'), pending('program'), { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'ready');
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1']]);
  assert.equal(f.asked.length, 1);
});

test('flow: at most three confirmations, three failed calls in a row, three changed contents', async () => {
  const terminal = () => ({ ok: true, ...notOpen(undefined, { state: 'mode_changed', recovery: 'confirm_again' }) });
  let s = scripted([{ ok: true, ...notOpen() }, terminal(), terminal(), terminal()]);
  let f = flowUi();
  let result = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() }));
  assert.equal(result.outcome, 'refused');
  assert.match(result.text, /多次没有打开成功/);
  assert.equal(f.asked.length, 3);
  assert.equal(opensOf(s).length, 3);
  const lost = () => new TypeError('fetch failed');
  s = scripted([{ ok: true, ...notOpen() }, lost(), lost(), lost(), lost()]);
  f = flowUi();
  result = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() }));
  assert.deepEqual(result, { outcome: 'refused', text: '没有打开项目：fetch failed' });
  assert.deepEqual(routesOf(s), ['state', 'open', 'state', 'state', 'state'], 'three retries, all state reads, then it stops');
  assert.deepEqual(f.waits, [1000, 1000, 1000]);
  const changed = (v) => [{ ok: false, errorCode: 'authorization_changed', teaching: 'changed' }, { ok: true, ...notOpen(undefined, { authorizationVersion: v }) }];
  s = scripted([{ ok: true, ...notOpen() }, ...changed('sha256:v2'), ...changed('sha256:v3'),
    { ok: false, errorCode: 'authorization_changed', teaching: 'changed' }]);
  f = flowUi();
  result = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() }));
  assert.equal(result.outcome, 'refused');
  assert.match(result.text, /确认之后又变了/);
  assert.equal(f.asked.length, 3);
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2'], ['req-0003', 'sha256:v3']]);
});

test('flow: refusals read in plain Chinese and are not retried', async () => {
  const cases = {
    not_authorized: /没有被授权使用这个智能体/, account_changed: /账户和刚才显示的不一样/,
    connection_not_of_this_device: /不是这台电脑设置的/, client_authority_refused: /只能由服务端决定/,
    device_revoked: /重新登录/, official_capability_not_installed: /没有装官方编程能力/,
    project_directory_in_use: /另一项授权占用/, project_nested: /重叠/, platform_mismatch: /写法/,
    worker_tools_unavailable: /本机执行/, not_signed_in: /没有登录 Rulith/, manager_signing_out: /正在退出/, manager_closing: /正在关闭/,
  };
  for (const [code, words] of Object.entries(cases)) {
    const s = scripted([{ ok: true, ...notOpen() }, { ok: false, errorCode: code, teaching: 'English teaching' }]);
    const result = plain(await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: flowUi().ui, newRequestId: ids() }));
    assert.equal(result.outcome, 'refused', code);
    assert.match(result.text, words, code);
    assert.equal(s.sent.length, 2, code + ' is not retried');
  }
  // A refusal made before anything was sent shows its own words; a path the Gateway rejects shows the Gateway's reason.
  let s = scripted([{ ok: false, errorCode: 'folder_invalid', teaching: '这台电脑上没有这个文件夹：D:\\x' }]);
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: flowUi().ui, newRequestId: ids() })).text,
    '没有打开项目：这台电脑上没有这个文件夹：D:\\x');
  assert.match(client.refusalText({ errorCode: 'bad_command', teaching: 'A whole drive cannot be opened as a project.' }), /^这个文件夹不能作为项目打开：A whole drive/);
  // The mode cannot be explained: no dialog, nothing opened.
  s = scripted([{ ok: true, ...notOpen(undefined, { mode: { requested: 'unknown_mode' } }) }]);
  const f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() })).outcome, 'refused');
  assert.equal(f.asked.length, 0);
});

test('flow: waiting is bounded and the owner can stop during a wait; the words claim only what is true', async () => {
  const pending = () => ({ ok: true, ...notOpen(undefined, { state: 'pending', stage: 'program', recovery: 'retry' }) });
  const s = scripted([{ ok: true, ...notOpen() }, ...Array.from({ length: 10 }, pending)]);
  const f = flowUi();
  const waited = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids(), maxWaitMs: 4000 }));
  assert.equal(waited.outcome, 'waiting');
  assert.match(waited.text, /会从当前进度继续，或重新请你确认/);
  assert.doesNotMatch(waited.text, /不会丢|服务端接着/);
  assert.ok(f.waits.reduce((a, b) => a + b, 0) >= 4000);
  // Stopped while waiting between reads, and while waiting after a lost reply: nothing more is sent.
  for (const second of [pending(), new TypeError('fetch failed')]) {
    let stop = false;
    const t = scripted([{ ok: true, ...notOpen() }, second, pending()]);
    const g = flowUi();
    g.ui.wait = async () => { stop = true; };
    g.ui.stopped = () => stop;
    const stopped = plain(await client.openProjectFlow({ api: t.api, agentId: 'a', directory: 'D:\\x', ui: g.ui, newRequestId: ids() }));
    assert.deepEqual(stopped, { outcome: 'stopped', text: '已停止等待。之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。' });
    assert.deepEqual(routesOf(t), ['state', 'open'], 'no call after the owner stopped');
  }
  assert.doesNotMatch(client.refusalText({ errorCode: 'project_unavailable' }), /接着刚才那次/);
});

test('the conversation panel no longer proposes folders for Console approval', () => {
  const source = fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /在 Console 确认一次|api\("folder"|使用这个文件夹/);
  const host = fs.readFileSync(new URL('../../harness/web/rulith-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /\/rulith\/api\/folder|setup\/resources/);
});

test('the host serves the project routes on its guarded same-origin API, with the refusal code', async (t) => {
  // All I/O is mocked: no manager process, no socket, no credential; the manager answers below.
  const { apply } = await import('../../harness/web/rulith-runtime.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).endsWith('fixture-key.txt')) return 'fixture-manager-key';
    if (String(file).endsWith('registry.json')) return JSON.stringify({ instances: [] });
    return readFileSync(file, ...rest);
  });
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(net, 'connect', (_options, callback) => { const socket = new EventEmitter(); socket.destroy = () => {}; queueMicrotask(callback); return socket; });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname;
    seen.push([route, init?.headers?.['x-rulith-manager']]);
    if (route === '/manager/state') return new Response(JSON.stringify({ ok: true, ...managerState }));
    if (route === '/manager/projects/state') return new Response(JSON.stringify({ ok: false, errorCode: 'project_nested', teaching: 'nested' }), { status: 400 });
    return new Response(JSON.stringify({ ok: false, teaching: 'unexpected' }), { status: 404 });
  });
  let server;
  const effects = [];
  await apply({ on() {}, effect(fn) { effects.push(fn()); }, tools: { register: () => () => {} }, webServer: { register(route) { server = route; return () => {}; } } },
    { managerHome: 'fixture-manager', runtimeEntry: 'fixture-runtime', keyFile: 'fixture-key.txt', shadow: { enabled: false } });
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  const post = async (route, body) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/rulith/api/' + route, headers: { host: '127.0.0.1:3080', 'x-deep-rulith': '1' } });
    let reply, code;
    const done = server.handler(req, { writeHead(status) { code = status; }, end(text) { reply = JSON.parse(text); } });
    queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
    await done;
    return { code, reply };
  };
  const refused = await post('projects/state', { agentId: 'agent-1', directory: dir });
  assert.deepEqual(refused, { code: 200, reply: { ok: false, teaching: 'nested', errorCode: 'project_nested' } });
  assert.deepEqual(seen.map(([route]) => route), ['/manager/state', '/manager/projects/state']);
  assert.ok(seen.every(([, key]) => key === 'fixture-manager-key'));
  assert.equal((await post('folder', { source: 'lab', path: dir })).code, 404, 'the Console proposal route is gone');
});
