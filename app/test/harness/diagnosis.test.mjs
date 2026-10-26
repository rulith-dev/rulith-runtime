// Batch 7 (design §3.2 设置 → 高级 → 诊断, §7 合包发布): Settings → Advanced → Diagnosis replaces the retired English
// workbench as the place to look, and a computer the workbench set up says what became of its Agents (the command's
// line, the wizard and Diagnosis). English (D-1025b). No network, no manager process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPage, nodes, text } from './browser-page.mjs';
import { legacyWorkbench, legacyWorkbenchLine } from '../../harness/web/app-home.mjs';
import { diagnosisReport, isolationOffFor, isolationStatus, legacyFromEnv } from '../../harness/web/diagnosis.mjs';
import { noteProtection, protectionProblems } from '../../../local/sandbox-home-label.mjs';

const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulith-diagnosis-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test('the workbench\'s Agents are found in ~/.rulith/manager, read only, and said in one English line', (t) => {
  const user = tmp(t);
  const appManager = path.join(user, '.rulith', 'app', 'manager');
  assert.equal(legacyWorkbench(appManager, user), null, 'no workbench here: nothing to say');
  const old = path.join(user, '.rulith', 'manager');
  writeJson(path.join(old, 'registry.json'), { instances: [{ id: 'a' }, { id: 'b' }, { id: 'c', signedOutAt: '2026-10-01T00:00:00Z' }] });
  const before = fs.readFileSync(path.join(old, 'registry.json'), 'utf8');
  const found = legacyWorkbench(appManager, user);
  assert.deepEqual(found, { home: old, agents: 2 }, 'signed-out instances start nothing and are not counted');
  assert.equal(fs.readFileSync(path.join(old, 'registry.json'), 'utf8'), before, 'nothing there is changed');
  assert.equal(legacyWorkbench(old, user), null, 'an app whose manager home is the workbench\'s own uses those Agents itself');
  writeJson(path.join(old, 'registry.json'), { instances: [{ id: 'a', signedOutAt: 'x' }] });
  assert.equal(legacyWorkbench(appManager, user), null);
  const line = legacyWorkbenchLine({ home: old, agents: 2 });
  assert.match(line, /^Rulith: 2 Agents set up by the retired Rulith workbench \(.+\) no longer start their Workers with `rulith`\./);
  assert.match(line, /Run `rulith manager` to keep them running, or set each Agent up again in the app; that replaces its Agent token,/);
  assert.match(line, /Sources bound to its old Connection must be bound again in Console\.$/);
  assert.match(legacyWorkbenchLine({ home: old, agents: 1 }), /^Rulith: 1 Agent set up/);
  assert.deepEqual(legacyFromEnv({ RULITH_DSH_LEGACY_WORKBENCH: JSON.stringify({ home: old, agents: 2 }) }), { home: old, agents: 2 });
  for (const bad of ['', 'nope', '{"home":3,"agents":1}', '{"home":"x","agents":0}']) assert.equal(legacyFromEnv({ RULITH_DSH_LEGACY_WORKBENCH: bad }), null, bad);
});

test('isolation status says what the Worker does on each platform, fail-closed included, and names Agents switched off', () => {
  assert.equal(isolationStatus({ platform: 'darwin' }).state, 'unavailable');
  assert.match(isolationStatus({ platform: 'darwin' }).text, /^Not available on this platform yet/);
  assert.deepEqual(isolationStatus({ platform: 'linux', bwrap: () => true }).state, 'on');
  const noBwrap = isolationStatus({ platform: 'linux', bwrap: () => false });
  assert.equal(noBwrap.state, 'refusing');
  assert.match(noBwrap.text, /bwrap\) is not installed: model commands are refused/);
  const root = os.tmpdir();
  assert.equal(isolationStatus({ platform: 'win32', roots: [root], protectedRoot: () => true }).state, 'on');
  const unprotected = isolationStatus({ platform: 'win32', roots: [root], protectedRoot: () => false });
  assert.equal(unprotected.state, 'refusing');
  assert.match(unprotected.text, /Model commands are refused: .+ is not read-protected/);
  const partly = isolationStatus({ platform: 'win32', roots: [], offFor: ['Research'], protectedRoot: () => true });
  assert.equal(partly.state, 'partly-off');
  assert.match(partly.text, /Turned off for Research \(RULITH_ADAPTER_SANDBOX=off; not recommended\)\.$/);
});

test('Diagnosis reads versions, folders and the per-Agent switch, and nothing secret', (t) => {
  const home = tmp(t);
  const manager = path.join(home, 'manager'), instance = path.join(manager, 'instances', 'one');
  writeJson(path.join(manager, 'registry.json'), { instances: [{ id: 'one', agentName: 'Research', directory: instance }] });
  writeJson(path.join(instance, 'local.json'), { agent: { env: { RULITH_TOKEN: 'rlt_agt_secret-value' } },
    worker: { env: { RULITH_CONNECTION_KEY: 'conn-secret-value', RULITH_ADAPTER_SANDBOX: 'off' } } });
  assert.deepEqual(isolationOffFor(manager), ['Research']);
  const report = diagnosisReport({ managerHome: manager, dshHome: path.join(home, 'dsh'), appHome: home, kitHome: path.join(home, 'kit'),
    keyFile: path.join(home, 'manager.key'), legacyWorkbench: { home: '/old', agents: 1 }, env: {},
    isolation: ({ offFor }) => ({ state: 'test', text: 'off for ' + offFor.join(',') }) });
  assert.match(report.versions.rulith, /^\d+\.\d+\.\d+/);
  assert.match(report.versions.dsh, /^\d+\.\d+\.\d+/);
  assert.equal(report.versions.node, process.version);
  assert.deepEqual(report.isolation, { state: 'test', text: 'off for Research' });
  assert.deepEqual(report.folders.map((f) => f.label), ['Rulith files', 'Local manager', 'Conversations (DeepSeek Harness)', 'Logs',
    'General kit settings', 'Model command work area']);
  assert.equal(report.folders.find((f) => f.label === 'Logs').path, path.join(home, 'dsh', 'logs'));
  assert.deepEqual(report.legacyWorkbench, { home: '/old', agents: 1 });
  assert.doesNotMatch(JSON.stringify(report), /secret-value|RULITH_TOKEN|CONNECTION_KEY/);
});

test('Diagnosis says which folder could not be protected and why, from what the labelling code noted', (t) => {
  const home = tmp(t);
  const manager = path.join(home, 'manager'), project = path.join(home, 'project'), dsh = path.join(home, 'dsh');
  for (const d of [manager, project, dsh]) fs.mkdirSync(d, { recursive: true });
  noteProtection(manager, 'root', [{ path: dsh, ok: false, reason: 'the label could not be applied: Windows denied changing its integrity label (access denied)' },
    { path: manager, ok: true }]);
  noteProtection(manager, 'project', [{ path: project, ok: false, reason: 'it is owned by another account (S-1-5-32-544), not by you' }]);
  assert.deepEqual(protectionProblems(manager).map((row) => row.kind).sort(), ['project', 'root']);
  const status = isolationStatus({ platform: 'win32', roots: [manager, dsh], problems: protectionProblems(manager),
    protectedRoot: (root) => root !== dsh });
  assert.equal(status.state, 'refusing');
  assert.match(status.text, /refused: .*dsh \(the label could not be applied: Windows denied changing its integrity label \(access denied\)\) is not read-protected/);
  assert.deepEqual(status.problems.map((row) => [row.kind, row.path]), [['root', dsh], ['project', project]]);
  // Fixed since: an ok note clears it, and a root that now verifies is not shown even if a stale note remains.
  noteProtection(manager, 'project', [{ path: project, ok: true }]);
  const fixed = isolationStatus({ platform: 'win32', roots: [manager, dsh], problems: protectionProblems(manager), protectedRoot: () => true });
  assert.equal(fixed.state, 'on');
  assert.equal(fixed.problems, undefined);
  // The report reads the notes from the manager home.
  noteProtection(manager, 'project', [{ path: project, ok: false, reason: 'its drive does not support integrity labels (use an NTFS drive)' }]);
  const report = diagnosisReport({ managerHome: manager, dshHome: dsh, appHome: home, env: {},
    isolation: ({ problems }) => ({ state: 'test', text: problems.map((row) => row.reason).join('|') }) });
  assert.match(report.isolation.text, /use an NTFS drive/);
});

const summary = { ok: true, signedIn: true, account: 'Owner', computer: 'OWNER-PC', origin: 'https://console.example',
  agents: [{ id: 'a1', name: 'Default agent', paired: true, worker: { enabled: true, state: 'online', failure: '' } },
    { id: 'a2', name: 'Other', paired: false, worker: null }] };

test('Settings → Advanced keeps a Diagnosis: versions, this computer, isolation, folders and the workbench notice, in English', () => {
  const page = loadPage();
  const diagnosis = page.mount(page.plugin.components.DiagnosisSection, { state: summary });
  assert.match(text(diagnosis.render()), /^Diagnosis\s*Reading…$/);
  diagnosis.cells[0] = { ok: true, versions: { rulith: '0.19.0', dsh: '0.2.1-alpha.1', node: 'v24.12.0', platform: 'win32-x64' },
    isolation: { state: 'on', text: 'On: model commands run at low integrity and cannot read Rulith\'s own folders.' },
    folders: [{ label: 'Rulith files', path: 'C:\\Users\\o\\.rulith\\app' }, { label: 'Logs', path: 'C:\\Users\\o\\.rulith\\app\\dsh\\logs' }],
    legacyWorkbench: { home: 'C:\\Users\\o\\.rulith\\manager', agents: 2 } };
  const shown = page.expand(diagnosis.render());
  const words = text(shown);
  assert.match(words, /Rulith 0\.19\.0 · DeepSeek Harness 0\.2\.1-alpha\.1 · Node\.js v24\.12\.0 · win32-x64/);
  assert.match(words, /This computer: OWNER-PC · signed in · Default agent: online, Other: not set up/);
  assert.match(words, /Model-command isolation: On: model commands run at low integrity/);
  assert.match(words, /Rulith files: C:\\Users\\o\\\.rulith\\app[\s\S]*Logs: C:\\Users\\o\\\.rulith\\app\\dsh\\logs/);
  assert.match(words, /2 Agents set up by the retired Rulith workbench \(C:\\Users\\o\\\.rulith\\manager\) no longer start their Workers with rulith\./);
  assert.equal(nodes(shown).some((node) => node.props && node.props['data-rulith-diagnosis'] === 'on'), true);
  assert.equal(nodes(shown).some((node) => node.tag === 'button'), false, 'a view, with nothing to press');
  diagnosis.cells[0] = { ok: false, teaching: 'not reachable' };
  assert.match(text(diagnosis.render()), /Rulith could not read its diagnosis[\s\S]*not reachable/);
  // In the Advanced section, after the MCP client hint.
  const advanced = page.expand(page.mount(page.plugin.components.AdvancedSection, { state: summary }).render());
  assert.match(text(advanced), /Other clients[\s\S]*Diagnosis/);
  assert.equal(page.mount(page.plugin.components.LegacyWorkbenchNotice, { legacy: null }).render(), null);
});

test('the wizard shows the workbench notice when the computer has the workbench\'s Agents, and nothing otherwise', () => {
  const page = loadPage({ reply: () => ({ ok: true }) });
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const services = { ui: { selection: store({}), openSession() {} }, sessions: { list: store({ ids: [], byId: {} }) }, workspaces: { list: store({ items: [] }) } };
  const wizardWith = (state) => {
    const m = page.mount(page.plugin.makeRulithWizard(services));
    m.cells[0] = state; m.cells[1] = null; m.cells[2] = null;
    return text(page.expand(m.render()));
  };
  const signedOut = { ok: true, signedIn: false };
  assert.doesNotMatch(wizardWith(signedOut), /retired Rulith workbench/);
  assert.match(wizardWith({ ...signedOut, legacyWorkbench: { home: '/home/o/.rulith/manager', agents: 1 } }),
    /1 Agent set up by the retired Rulith workbench \(\/home\/o\/\.rulith\/manager\) no longer start their Workers with rulith\. Run "rulith manager"/);
});
