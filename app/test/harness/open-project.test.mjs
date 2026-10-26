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
import { localFolder, projectPlatform, projectRoutes, projectTarget, projectView, PROJECT_SOURCE }
  from '../../harness/web/open-project.mjs';
import { inRequestLanguage } from '../../harness/web/ui-texts.mjs';

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
    assert.throws(() => localFolder(raw, 'win32', files), (error) => error.errorCode === 'folder_network' && /This is a network folder/.test(error.message), raw);
  for (const [raw, platform] of [['', 'win32'], ['game', 'win32'], ['D:game', 'win32'], ['\\game', 'win32'], ['/home/owner/game', 'win32'],
    ['home/owner', 'linux'], ['D:\\Work\\absent', 'win32'], ['/home/owner/absent', 'linux']])
    assert.throws(() => localFolder(raw, platform, files), (error) => error.errorCode === 'folder_invalid' && /^(Enter|This computer has no such folder)/.test(error.message), raw);
  // A page in Chinese gets the host's Chinese rendering of the same sentences (the language it names on its requests).
  inRequestLanguage('zh', () => assert.throws(() => localFolder('game', 'win32', files),
    (error) => error.errorCode === 'folder_invalid' && /[\u4e00-\u9fff]/.test(error.message)));
  assert.throws(() => localFolder('game', 'win32', files), (error) => /^Enter the full path/.test(error.message), 'outside that request: English');
  const file = { statSync: () => ({ isDirectory: () => false }), realpathSync: (p) => p };
  assert.throws(() => localFolder('/home/owner/game', 'linux', file), /This computer has no such folder: \/home\/owner\/game/);
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
    // PSC 0.2.27 ③: the host's "set up on this computer" in repair mode runs first, before the Gateway is asked anything.
    const repairs = [];
    const routes = projectRoutes({ manager, labelOpen: () => ({ ok: true }), repair: async (agentId) => { repairs.push([agentId, calls.length]); },
      platform: process.platform, onReady: (id) => ready.push(id) });
    const shown = await routes.state({ agentId: 'agent-1', directory: dir });
    assert.equal(shown.state, 'not_open');
    assert.equal(shown.accountName, 'Owner', 'the account the authorization belongs to, by the name this computer shows');
    assert.deepEqual(calls[1], ['/manager/projects/state', { expectedAccountId: 'acct-1', agentId: 'agent-1', connectionId: 'conn-1',
      directory: fs.realpathSync.native(dir), platform: projectPlatform() }]);
    assert.deepEqual(repairs, [['agent-1', 0]], 'repaired before the manager was asked anything');
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
    const mapped = projectRoutes({ manager, labelOpen: () => ({ ok: true }), platform: 'win32', files: { statSync: () => ({ isDirectory: () => true }),
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
      (error) => error.errorCode === 'runtime_unsupported' && /too old to open projects/.test(error.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Model-command isolation (D-1024a): the folder is labelled before the Gateway hears of the open. A folder that cannot be
// made writable for isolated commands is refused (fail-closed) with an English reason and nothing is sent; when the
// Gateway refuses the open, the label just applied is released again; a folder seen ready is kept labelled.
test('ACC-ISO-13 an open labels first: an unlabellable folder is refused unsent, a refused open is released', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-unprotectable-')));
  try {
    const calls = [], labelled = [], released = [];
    let answer = () => ({ ok: true, ...notOpen(dir, { state: 'ready' }) });
    const manager = async (route, body) => { calls.push(route); return route === '/manager/state' ? managerState : answer(route, body); };
    let labelResult = { ok: false, reason: 'it is owned by another account (S-1-5-32-544), not by you, so Rulith leaves its access settings alone' };
    const routes = projectRoutes({ manager, platform: process.platform, managerHome: 'fixture-manager',
      labelOpen: (input) => { labelled.push(input); return labelResult; }, labelRelease: (input) => { released.push(input); return { ok: true }; } });
    const open = (n) => routes.open({ agentId: 'agent-1', directory: dir, requestId: `b3c1d0a2-0000-4000-8000-00000000001${n}`,
      authorizationVersion: 'sha256:v1', expectedAccountId: 'acct-1' });
    await assert.rejects(open(1), (error) => error.errorCode === 'project_folder_unprotectable'
      && /owned by another account/.test(error.message) && !/[一-鿿]/.test(error.message));
    assert.deepEqual(calls.filter((route) => route === '/manager/projects/open'), [], 'nothing was sent to the Gateway');
    assert.deepEqual(labelled.map((row) => row.holder), ['inst-1']);
    // Labelled, then the Gateway refuses: the label is released again.
    labelResult = { ok: true };
    answer = (route) => { if (route === '/manager/projects/open') throw Object.assign(new Error('nested'), { errorCode: 'project_nested' }); return { ok: true, ...notOpen(dir) }; };
    await assert.rejects(open(2), (error) => error.errorCode === 'project_nested');
    assert.deepEqual(released.map((row) => [row.directory, row.holder]), [[dir, 'inst-1']]);
    // Seen ready by a state read: kept labelled.
    answer = () => ({ ok: true, ...notOpen(dir, { state: 'ready' }) });
    labelled.length = 0;
    assert.equal((await routes.state({ agentId: 'agent-1', directory: dir })).state, 'ready');
    assert.deepEqual(labelled.map((row) => row.directory), [dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Model-command isolation (D-1024a): a folder that contains, or lies inside, one of Rulith's own credential or work roots
// is refused before the manager hears of it (and before any label is applied); an unrelated folder goes on as before.
test('ACC-ISO-09 a project folder overlapping a Rulith credential or work root is refused before anything is sent', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-protected-')));
  try {
    const root = path.join(dir, 'rulith-home'), other = path.join(dir, 'other');
    for (const d of [path.join(root, 'inner'), other]) fs.mkdirSync(d, { recursive: true });
    const calls = [], labelled = [];
    const manager = async (route) => { calls.push(route); return route === '/manager/state' ? managerState : { ok: true, ...notOpen(other) }; };
    const routes = projectRoutes({ manager, platform: process.platform, protectedRoots: () => [root],
      labelOpen: (input) => { labelled.push(input); return { ok: true }; } });
    for (const directory of [dir, root, path.join(root, 'inner')]) {
      await assert.rejects(routes.state({ agentId: 'agent-1', directory }), (error) => error.errorCode === 'project_folder_protected', directory);
      await assert.rejects(routes.open({ agentId: 'agent-1', directory, requestId: 'b3c1d0a2-0000-4000-8000-000000000009',
        authorizationVersion: 'sha256:v1', expectedAccountId: 'acct-1' }), (error) => error.errorCode === 'project_folder_protected', directory);
    }
    assert.deepEqual(calls, [], 'nothing reached the manager');
    assert.deepEqual(labelled, [], 'nothing was labelled');
    assert.equal((await routes.state({ agentId: 'agent-1', directory: other })).state, 'not_open', 'an unrelated folder proceeds');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the official capability names its project Sources project and project-<8 hex>', () => {
  for (const name of ['project', 'project-0a1b2c3d']) assert.ok(PROJECT_SOURCE.test(name));
  for (const name of ['projects', 'project-0A1B2C3D', 'project-0a1b2c3', 'lab', 'my-project']) assert.ok(!PROJECT_SOURCE.test(name));
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

test('the confirmation lists in view the folder, the Agent on this computer, what may be done, the tools in plain words, the tier, the caution and how to withdraw; only tool ids with versions and the account are under Details', () => {
  const shown = plain(client.projectConfirmation(notOpen()));
  // Every item SYS-LOCAL-01 (PSC 0.2.24) requires the confirmation to list is in view, in this order, the tools used
  // included; design §3.2 folds only the ids with their versions and the account.
  assert.deepEqual(shown.rows.map(([name]) => name), ['Folder', 'Agent', 'What it may do', 'Tools used', 'Exploration mode', 'Note', 'How to withdraw']);
  // The caution is PSC 0.2.31 ④'s own text, checked exactly below; every other word is the page's.
  const text = [shown.title, ...shown.rows.filter(([name]) => name !== 'Note').flat(), ...shown.details.flat(), shown.footer].join('\n');
  const row = (label) => shown.rows.find(([name]) => name === label)?.[1];
  const detail = (label) => shown.details.find(([name]) => name === label)?.[1];
  assert.equal(row('Folder'), 'D:\\Work\\game');
  assert.match(row('What it may do'), /Read files, write files and run commands/);
  // PSC 0.2.31 ④ (in force) fixes this text, replacing 0.2.24's sentence that the folder is not OS-level isolation.
  assert.equal(row('Note'), 'On this computer, reading, writing and running commands in this project folder are carried out by the Agent\'s engineering capability. Commands run without this computer\'s keys or tokens in their environment, and tool access to loopback and private network addresses (including this computer\'s manager and app ports) is refused. By system: on Windows, commands run at low integrity and cannot read the folders where Rulith keeps its credentials; this folder is writable for commands while it is open, and its previous setting is restored when it is revoked or this computer is deactivated. On Linux, commands can write only this project folder and their tool folder, the system is read-only, Rulith\'s credential folders are hidden, the network stays available, and background jobs end with the tool call that started them. On macOS, commands are not yet isolated on this computer. If isolation cannot be set up, commands do not run (unless you chose "Run without isolation (not recommended)" in Settings). The non-strict tier means the commands and arguments the model gives no longer need grounds on the Board; whether the work is done is still certified only by the acceptance contract you sign. To revoke: unlock this project in Console, or deactivate this computer.');
  assert.match(row('How to withdraw'), /withdraw the grant on this project's row of this Agent's page in Console/);
  assert.match(row('How to withdraw'), /revoke this computer's sign-in/);
  assert.doesNotMatch(shown.rows.flat().join('\n'), /eng\.|@\d|1\.0\.0/, 'tool ids and versions stay folded');
  // The tools, in plain words, each once, with the capability they come from (by its name, without its version).
  const words = row('Tools used').split('. ')[0].split(', ');
  assert.deepEqual(words, ['Run acceptance checks', 'edit files by patch', 'find files by name', 'check background commands', 'run commands in the background', 'stop background commands', 'list files', 'edit files',
    'read files', 'read images', 'run commands', 'search file contents', 'run tests', 'see the folder\'s changes', 'write files'], 'one entry per tool, in the order the service lists them');
  assert.match(row('Tools used'), /From this Agent's installed official engineering capability\.$/);
  // Batch 5 (design §2): the capability's id and the Connection's name are internal words, so they are under Details.
  assert.deepEqual(shown.details.map(([name]) => name), ['Account', 'Tools and versions', 'Local connection']);
  assert.equal(detail('Local connection'), 'Workspace');
  assert.equal(detail('Account'), 'acct-1', 'without a name the account shows by its id');
  assert.equal(plain(client.projectConfirmation(notOpen(undefined, { accountName: 'Owner' }))).details.find(([name]) => name === 'Account')[1], 'Owner');
  assert.equal(row('Agent'), 'Default agent · this computer OWNER-PC');
  for (const tool of TOOLS) assert.ok(detail('Tools and versions').includes(tool.id), tool.id);
  assert.match(detail('Tools and versions'), /engineering_work 1\.0\.0/);
  assert.match(row('Exploration mode'), /use Non-strict mode by default/);
  assert.match(row('Exploration mode'), /commands and inputs run without needing evidence first/);
  assert.match(row('Exploration mode'), /decided only by the acceptance criteria you sign/);
  assert.doesNotMatch(shown.rows.flat().join('\n'), /engineering_work|Local connection|non_strict/, 'no internal word in view');
  assert.match(shown.footer, /Existing conversations are not affected/);
  assert.doesNotMatch(text, /\bBoard\b|\bAction\b|程序|\bprogram\b|治理|Release|Source|摘要|digest/i, 'no internal terms');
  // The server's list is the truth: other tools, another folder, another computer show as they are.
  // A tool this page has no words for is still listed, by its name without the version; two versions of one tool are one entry.
  const other = plain(client.projectConfirmation(notOpen('/home/o/x', { tools: [{ id: 'eng.new_tool@1' }, { id: 'eng.read@1' }, { id: 'eng.read@2' }],
    computer: { label: '' }, capability: undefined })));
  assert.equal(other.rows.find(([name]) => name === 'Tools used')[1], 'eng.new_tool, read files.');
  assert.equal(other.details.find(([name]) => name === 'Tools and versions')[1], 'eng.new_tool@1, eng.read@1, eng.read@2.');
  assert.equal(other.rows.find(([name]) => name === 'Agent')[1], 'Default agent · this computer unnamed computer');
  // Nothing to confirm when the answer is incomplete or the mode cannot be explained.
  for (const broken of [notOpen('', {}), notOpen(undefined, { tools: [] }), notOpen(undefined, { authorizationVersion: '' }),
    notOpen(undefined, { computer: undefined }), notOpen(undefined, { accountId: '' }), notOpen(undefined, { accountId: undefined })])
    assert.ok(client.projectConfirmation(broken).error);
  assert.match(client.projectConfirmation(notOpen(undefined, { mode: { requested: 'strict_plus' } })).error, /cannot explain the mode it would set/);
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
  assert.ok(f.progress.some((text) => text.includes('(step 1 of 3)') && text.includes('a call that has not ended')));
  assert.ok(f.progress.some((text) => text.includes('(step 2 of 3)')));
  assert.ok(f.progress.some((text) => text.includes('(step 3 of 3)') && text.includes('Non-strict')));
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
  assert.match(conflict.text, /already held by another grant/);
});

test('flow: a terminal state asks again, and only a new confirmation (new request id) opens again', async () => {
  const s = scripted([{ ok: true, ...notOpen() },
    { ok: true, ...notOpen(undefined, { state: 'mode_changed', recovery: 'confirm_again', authorizationVersion: 'sha256:v2' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  const f = flowUi();
  const result = await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() });
  assert.equal(result.outcome, 'ready');
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[1].note, /exploration mode was changed back/);
  const opens = s.sent.filter(([route]) => route === 'projects/open').map(([, body]) => [body.requestId, body.authorizationVersion]);
  assert.deepEqual(opens, [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2']]);
  // Each terminal state says why the owner is asked again; a state read that finds one asks again the same way.
  for (const [state, words] of [['opened_elsewhere', /was not confirmed on this computer/], ['mode_refused', /did not succeed several times/], ['revoked', /grant has been withdrawn/]]) {
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
  assert.ok(h.progress.some((text) => text.includes('retrying')));
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
  assert.match(f.asked[1].note, /changed after you confirmed/);
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
  assert.match(f.asked[1].note, /grant has been withdrawn/);
  // The open's reply was lost and the content is now different: ask again rather than resend.
  s = scripted([{ ok: true, ...notOpen() }, new TypeError('fetch failed'), { ok: true, ...notOpen(undefined, { authorizationVersion: 'sha256:v2' }) },
    { ok: true, ...notOpen(undefined, { state: 'ready' }) }]);
  f = flowUi();
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: f.ui, newRequestId: ids() })).outcome, 'ready');
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2']]);
  assert.match(f.asked[1].note, /changed after you confirmed/);
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
  assert.match(result.text, /did not open after several tries/);
  assert.equal(f.asked.length, 3);
  assert.equal(opensOf(s).length, 3);
  const lost = () => new TypeError('fetch failed');
  s = scripted([{ ok: true, ...notOpen() }, lost(), lost(), lost(), lost()]);
  f = flowUi();
  result = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() }));
  assert.deepEqual(result, { outcome: 'refused', text: 'Project not opened: fetch failed' }, 'the reason is never hidden');
  assert.deepEqual(routesOf(s), ['state', 'open', 'state', 'state', 'state'], 'three retries, all state reads, then it stops');
  assert.deepEqual(f.waits, [1000, 1000, 1000]);
  const changed = (v) => [{ ok: false, errorCode: 'authorization_changed', teaching: 'changed' }, { ok: true, ...notOpen(undefined, { authorizationVersion: v }) }];
  s = scripted([{ ok: true, ...notOpen() }, ...changed('sha256:v2'), ...changed('sha256:v3'),
    { ok: false, errorCode: 'authorization_changed', teaching: 'changed' }]);
  f = flowUi();
  result = plain(await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: f.ui, newRequestId: ids() }));
  assert.equal(result.outcome, 'refused');
  assert.match(result.text, /changed after you confirmed/);
  assert.equal(f.asked.length, 3);
  assert.deepEqual(opensOf(s), [['req-0001', 'sha256:v1'], ['req-0002', 'sha256:v2'], ['req-0003', 'sha256:v3']]);
});

test('flow: refusals read in plain words and are not retried', async () => {
  const cases = {
    not_authorized: /not authorized to use this Agent/, account_changed: /is not the one shown a moment ago/,
    connection_not_of_this_device: /was not set up by this computer/, client_authority_refused: /only the service may decide/,
    device_revoked: /Sign in again/, official_capability_not_installed: /does not have the official engineering capability installed/,
    project_directory_in_use: /already held by another grant/, project_nested: /overlap/, platform_mismatch: /is not written the way/,
    worker_tools_unavailable: /has not reported the tools it needs/, not_signed_in: /not signed in to Rulith/, manager_signing_out: /signing out/, manager_closing: /is closing/,
  };
  for (const [code, words] of Object.entries(cases)) {
    const s = scripted([{ ok: true, ...notOpen() }, { ok: false, errorCode: code, teaching: 'English teaching' }]);
    const result = plain(await client.openProjectFlow({ api: s.api, agentId: 'agent-1', directory: 'D:\\Work\\game', ui: flowUi().ui, newRequestId: ids() }));
    assert.equal(result.outcome, 'refused', code);
    assert.match(result.text, words, code);
    assert.equal(s.sent.length, 2, code + ' is not retried');
  }
  // A refusal made before anything was sent shows its own words; a path the Gateway rejects shows the Gateway's reason.
  let s = scripted([{ ok: false, errorCode: 'folder_invalid', teaching: 'This computer has no such folder: D:\\x' }]);
  assert.equal((await client.openProjectFlow({ api: s.api, agentId: 'a', directory: 'D:\\x', ui: flowUi().ui, newRequestId: ids() })).text,
    'Project not opened: This computer has no such folder: D:\\x');
  assert.match(client.refusalText({ errorCode: 'bad_command', teaching: 'A whole drive or share cannot be opened as a project; choose a folder in it.' }), /^This folder cannot be opened as a project: A whole drive or share cannot be opened as a project; choose a folder in it\.$/);
  // The setup before opening stopped where only the owner can decide (SYS-LOCAL-01): the words point to the place that asks.
  for (const code of ['runtime_credential_exists', 'connection_rejected', 'connection_missing'])
    assert.match(client.refusalText({ errorCode: code, teaching: 'English reason' }), /“Set up on this computer” for it under This computer in Settings, confirm .*then open the folder again/, code);
  assert.match(client.refusalText({ errorCode: 'worker_taken_over' }), /took over.*“Set up on this computer”/);
  assert.match(client.refusalText({ errorCode: 'local_setup_connection_in_use', teaching: 'English reason' }), /working on another computer.*did not create another copy/);
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
  assert.match(waited.text, /continues from where it is, or asks you to confirm again/);
  assert.doesNotMatch(waited.text, /never lost|the service goes on/);
  assert.ok(f.waits.reduce((a, b) => a + b, 0) >= 4000);
  // Stopped while waiting between reads, and while waiting after a lost reply: nothing more is sent.
  for (const second of [pending(), new TypeError('fetch failed')]) {
    let stop = false;
    const t = scripted([{ ok: true, ...notOpen() }, second, pending()]);
    const g = flowUi();
    g.ui.wait = async () => { stop = true; };
    g.ui.stopped = () => stop;
    const stopped = plain(await client.openProjectFlow({ api: t.api, agentId: 'a', directory: 'D:\\x', ui: g.ui, newRequestId: ids() }));
    assert.deepEqual(stopped, { outcome: 'stopped', text: 'Stopped waiting. You can open this folder again on the left later: it continues from where it is, or asks you to confirm again.' });
    assert.deepEqual(routesOf(t), ['state', 'open'], 'no call after the owner stopped');
  }
  assert.doesNotMatch(client.refusalText({ errorCode: 'project_unavailable' }), /goes on with the earlier one/);
});

test('the conversation panel no longer proposes folders for Console approval', () => {
  const source = fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /在 Console 确认一次|api\("folder"|使用这个文件夹|confirm once in Console|use this folder/);
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
    if (route === '/manager/instances/setup-local') {
      const body = JSON.parse(init.body);
      assert.deepEqual([body.agentId, body.mode], ['agent-1', 'repair']);
      return new Response(JSON.stringify({ ok: true, setup: { requestId: body.requestId, agentId: 'agent-1', mode: 'repair', state: 'done', steps: [] } }));
    }
    if (route === '/manager/projects/state') return new Response(JSON.stringify({ ok: false, errorCode: 'project_nested', teaching: 'nested' }), { status: 400 });
    return new Response(JSON.stringify({ ok: false, teaching: 'unexpected' }), { status: 404 });
  });
  let server;
  const effects = [];
  await apply({ on() {}, effect(fn) { effects.push(fn()); }, tools: { register: () => () => {} }, webServer: { register(route) { server = route; return () => {}; } }, connection: { admit: () => ({ peer: {} }) } },
    { managerHome: 'fixture-manager', runtimeEntry: 'fixture-runtime', keyFile: 'fixture-key.txt', shadow: { enabled: false } });
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  seen.length = 0; // the start's kit refresh read the manager state once (kit-install.mjs)
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
  assert.deepEqual(seen.map(([route]) => route), ['/manager/instances/setup-local', '/manager/state', '/manager/projects/state'],
    'the folder is repaired first (PSC 0.2.27 ③), then the Gateway is asked');
  assert.ok(seen.every(([, key]) => key === 'fixture-manager-key'));
  assert.equal((await post('folder', { source: 'lab', path: dir })).code, 404, 'the Console proposal route is gone');
});
