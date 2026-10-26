// Batch 4 (design §3.2 右栏, §5 d, §6; D-1024a): the right column's 任务 panel and signing a goal's proposed criteria from the
// client. The page half runs on the shipped browser script (browser-page.mjs) with a scripted /rulith/api; the host half on
// its guarded API with a fake manager (which stands for the manager and the Gateway behind it). No network, no manager
// process, no credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { loadPage, nodes, text, plain, flush } from './browser-page.mjs';
// PSC 0.2.29 (D-1025a) fixes the local client's signing texts verbatim: every assertion below reads them from one table.
import * as PSC from './psc-0.2.32-text.mjs';
import { TOOLS } from '../../harness/rulith-mcp.mjs';
import { apply, consoleGoalsUrl, consoleRuntimeUrl, conversationView } from '../../harness/web/rulith-runtime.mjs';

const find = (root, test) => nodes(root).find(test);
const attr = (name, value) => (node) => node.props && (value === undefined ? node.props[name] !== undefined : node.props[name] === value);
const until = async (ready, turns = 200) => { for (let i = 0; i < turns && !ready(); i++) await flush(1); assert.ok(ready(), 'settled'); };
const digest = 'ab'.repeat(32);
const atom = (predicate, args) => JSON.stringify([{ predicate, args }]);
// One goal's proposed criteria as the Gateway reports them (awaitingSignature): a new eligible leaf, a signed one, one the
// Kernel does not take as a criterion, and a signed one that is no longer eligible (signing again replaces it).
const LEAVES = [
  { node: 'leaf-a', label: 'unittest 在 fizzbuzz.py 上通过', criterion: atom('eng.check_passed', { key: 'game:unit:sha256:' + digest }), signed: false, eligible: true },
  { node: 'leaf-b', label: '输出 1 到 100', criterion: atom('eng.check_passed', { key: 'game:range:sha256:' + digest }), signed: true, eligible: true },
  { node: 'leaf-c', label: '代码好读', criterion: atom('work.note', { text: 'readable' }), signed: false, eligible: false },
  { node: 'leaf-d', label: '旧的检查', criterion: atom('eng.check_passed', { check: 'old', spec_digest: 'sha256:' + digest }), signed: true, eligible: false },
];
const awaiting = (extra = {}) => [{ goal: 'goal-7', label: '写 fizzbuzz.py', signable: true, leaves: LEAVES, ...extra }];
const boardData = (extra = {}) => ({ ok: true, available: true, agentName: 'Default agent', seenAt: '2026-10-24T08:00:00.000Z',
  view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running', awaiting: 'acceptance' },
    { goal: 'goal-3', label: '统计单词', status: 'completed' }] },
  goalNodes: [{ nodeId: 'leaf-a', satisfied: true }, { nodeId: 'leaf-b', satisfied: false }] },
  operations: [], ...extra });
const state = (awaitingSignature) => ({ ok: true, found: true, conversation: { boardId: 'board-1', explorationMode: 'strict', awaitingSignature } });
const online = { ok: true, available: true, agentName: 'Default agent', state: 'online', computer: 'VS-STATION' };
// The panel's four reads are its first four hook cells: the cached results, the conversation's state, this computer and
// the Agent's pending call; then its signing state (BUSY: the goal being signed, NOTE: the last outcome).
const BUSY = 4, NOTE = 5;
function panel(page, { board = boardData(), conversation = state(awaiting()), worker = online, health = null, sessionId = 's1' } = {}) {
  const m = page.mount(page.plugin.components.RulithSessionColumn, { sessionId });
  m.cells[0] = board; m.cells[1] = conversation; m.cells[2] = worker; m.cells[3] = health;
  return m;
}
const signRequests = (page) => page.posted('conversation/sign-acceptance');

test('the Tasks panel before a Board, while reading, unreadable and before setup: one plain sentence instead of an empty panel', () => {
  const page = loadPage();
  const only = (data) => { const m = panel(page, data); const shown = m.render(); return [text(shown), !!find(shown, attr('data-rulith-panel-message'))]; };
  assert.deepEqual(only({ board: { ok: true, available: true, view: null }, conversation: { ok: true, found: false } }),
    ['This conversation has not started a task yet. Say what you want done; once it starts, its task, acceptance criteria and recent operations show here.', true]);
  assert.deepEqual(only({ board: null }), ['Reading…', true]);
  assert.deepEqual(only({ board: { ok: true, available: true, view: null }, conversation: null }), ['Reading…', true]);
  assert.deepEqual(only({ board: { ok: true, available: false } }), ['Rulith is not connected yet: sign in, then choose “Set up on this computer” for an Agent on the left.', true]);
  // The host's words, a sentence in the page's language, are shown as they are; a fragment follows the panel's own (batch 5).
  assert.deepEqual(only({ board: { ok: false, own: true, teaching: 'This conversation\'s Agent is not set up on this computer yet: choose “Set up on this computer” for it on the left first.' } }),
    ['This conversation\'s Agent is not set up on this computer yet: choose “Set up on this computer” for it on the left first.', true]);
  assert.deepEqual(only({ board: { ok: false, teaching: 'Choose an Agent first' } }), ['Could not read Rulith: Choose an Agent first', true],
    'a reason the page has no words for is shown after the page\'s own sentence, never hidden');
  // A conversation whose Board exists but whose results this process has not seen yet shows what its state says.
  const m = panel(page, { board: { ok: true, available: true, view: null }, conversation: state([]) });
  assert.match(text(m.render()), /TasksThis conversation's tasks show here once its next result arrives\./);
});

test('running: the task in plain words, its criteria and whether each holds, plain operations, and this computer online', () => {
  const page = loadPage();
  // Nothing awaits a signature: every leaf of the goal is signed. Holds come from the results this panel saw.
  const signedOnly = [{ goal: 'goal-7', label: '写 fizzbuzz.py', signable: true, leaves: LEAVES.slice(0, 2).map((leaf) => ({ ...leaf, signed: true })) }];
  const board = boardData({ view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running' },
    { goal: 'goal-3', label: '统计单词', status: 'completed' }, { goal: 'goal-5', label: 'goal-5', status: 'paused' }] },
  goalNodes: [{ nodeId: 'leaf-a', satisfied: true }, { nodeId: 'leaf-b', satisfied: false }] },
  recent: [
    { tool: 'Execute', label: 'Execute worker_c0ffee_eng_test_1 → goal-7', state: 'done', at: '2026-10-24T08:01:00Z',
      result: { content: [{ type: 'text', text: JSON.stringify({ accepted: true, result: { status: 'confirmed', rows: [{ exit_code: 0 }] } }) }] } },
    { tool: 'Execute', label: 'Execute worker_c0ffee_eng_write_file_1 → goal-7', state: 'done', at: '2026-10-24T08:00:30Z',
      result: { structuredContent: { result: { receipt: { path: 'src/fizzbuzz.py' } } } } },
    { tool: 'Set', label: 'Set', state: 'done', summary: 'declared goal goal-7', at: '2026-10-24T08:00:00Z' },
  ] });
  const m = panel(page, { board, conversation: state(signedOnly) });
  const shown = m.render();
  assert.equal(find(shown, attr('data-rulith-awaiting-signature')), undefined, 'nothing to sign: no card at the top');
  const tasks = nodes(shown).filter(attr('data-rulith-task')).map(text);
  assert.deepEqual(tasks, ['写 fizzbuzz.pyRunning', '(Unnamed task)Paused', '统计单词Completed (acceptance passed)'], 'open tasks first; never a node id');
  const criteria = nodes(shown).filter(attr('data-rulith-criterion')).map(text);
  assert.equal(criteria.length, 2);
  assert.match(criteria[0], /^unittest 在 fizzbuzz\.py 上通过Holds · Signedeng\.check_passed\(key: game:unit:sha256:abababab…\)$/);
  assert.match(criteria[1], /^输出 1 到 100Does not hold · Signed/);
  const operations = nodes(shown).filter(attr('data-rulith-operation')).map(text);
  assert.deepEqual(operations.map((line) => line.replace(/\d\d:\d\d$/, '')), ['Run tests: passed', 'Write fizzbuzz.py', 'Start a task']);
  assert.equal(text(find(shown, attr('data-rulith-computer'))), 'VS-STATION · Online');
  assert.equal(find(shown, attr('data-rulith-computer')).props['data-rulith-computer'], 'online');
  // No internal word, id or code anywhere but the criterion lines' small text.
  const plainText = text(shown).replace(/eng\.check_passed\([^)]*\)/g, '');
  assert.doesNotMatch(plainText, /goal-\d|leaf-|worker_|eng\.|Execute|running|completed|confirmed|租约|席位|等签收|Board|代）/);
  assert.match(text(shown), /^Agent: Default agentRefresh/);
});

test('awaiting signature: the criteria card goes to the top, with each leaf, its criterion in small text, and Sign these criteria', () => {
  const page = loadPage();
  const m = panel(page);
  const shown = m.render();
  const panelNode = find(shown, attr('data-rulith-task-panel'));
  const order = panelNode.children.map((child) => (child.props['data-rulith-awaiting-signature'] ? 'card' : text(child).slice(0, 5)));
  assert.equal(order[1], 'card', 'the card comes right after the header, before Tasks');
  assert.ok(order.indexOf('card') < order.findIndex((label) => label.startsWith('Tasks')));
  const card = find(shown, attr('data-rulith-awaiting-signature', 'goal-7'));
  assert.match(text(card), /^Proposed acceptance criteria写 fizzbuzz\.py/);
  const leaf = (node) => text(find(card, attr('data-rulith-leaf', node)));
  assert.equal(leaf('leaf-a'), 'unittest 在 fizzbuzz.py 上通过eng.check_passed(key: game:unit:sha256:abababab…)');
  assert.match(leaf('leaf-b'), /^输出 1 到 100Signed/);
  assert.match(leaf('leaf-c'), /^代码好读Not a criterionwork\.note\(text: readable\)$/);
  assert.match(leaf('leaf-d'), /^旧的检查SignedWill be replacedeng\.check_passed\(check: old, spec_digest: sha256:abababab…\)$/);
  assert.equal(text(find(card, attr('data-rulith-sign', 'goal-7'))), 'Sign these criteria');
  assert.equal(text(find(shown, attr('data-rulith-task', 'goal-7'))), '写 fizzbuzz.pyWaiting for your signature');
  // Every criterion of the goal, signed or not, in 验收标准与状态.
  assert.deepEqual(nodes(shown).filter(attr('data-rulith-criterion')).map((row) => text(row).split('eng.')[0].split('work.')[0]),
    ['unittest 在 fizzbuzz.py 上通过Holds · Not signed', '输出 1 到 100Does not hold · Signed', '代码好读Not read yet whether it holds · Not a criterion', '旧的检查Not read yet whether it holds · Signed']);
  // Only a leaf that is not a criterion is left unsigned: nothing waits for the person, so no card; it says why in its row.
  const noteOnly = panel(page, { conversation: state(awaiting({ leaves: [LEAVES[1], LEAVES[2]] })) }).render();
  assert.equal(find(noteOnly, attr('data-rulith-awaiting-signature')), undefined);
  assert.equal(text(find(noteOnly, attr('data-rulith-task', 'goal-7'))), '写 fizzbuzz.pyWaiting for your signatureAccept in Console',
    'a goal waiting for acceptance with nothing to sign here is accepted in Console');
  assert.match(text(find(noteOnly, attr('data-rulith-criterion', 'leaf-c'))), /· Not a criterion/);
  assert.equal(signRequests(page).length, 0, 'drawing the panel signs nothing');
  // A criterion that is not JSON is shown as it is, on one line.
  const plainCriterion = panel(page, { conversation: state(awaiting({ leaves: [{ node: 'leaf-x', label: 'x', criterion: 'eng.check_passed(\n key)', signed: false, eligible: true }] })) });
  assert.equal(text(find(plainCriterion.render(), attr('data-rulith-leaf', 'leaf-x'))), 'xeng.check_passed( key)');
});

test('signable:false and a shortened list: the reason in Chinese and no button; unknown criteria are never claimed absent', () => {
  const page = loadPage();
  const card = (entry) => find(panel(page, { conversation: state(awaiting(entry)) }).render(), attr('data-rulith-awaiting-signature', 'goal-7'));
  for (const [refusal, words] of [...Object.entries(PSC.SIGN_REASONS), ['something_new', PSC.SIGNING.unknownReason]]) {
    const shown = card({ signable: false, refusal, leaves: LEAVES.map((leaf) => ({ ...leaf, eligible: false })) });
    assert.equal(find(shown, attr('data-rulith-sign')), undefined, refusal);
    assert.equal(find(shown, attr('data-rulith-leaf-ineligible')), undefined, 'the reason is the goal\'s, not each leaf\'s');
    assert.equal(text(find(shown, attr('data-rulith-sign-unavailable'))), PSC.fill(PSC.SIGNING.unavailable, { category: words }));
  }
  const truncated = card({ leavesTruncated: true });
  assert.equal(find(truncated, attr('data-rulith-sign')), undefined, 'a shortened list would replace leaves this page never saw');
  assert.equal(text(find(truncated, attr('data-rulith-sign-unavailable'))), PSC.SIGNING.truncated);
  // Not one leaf can be signed: nothing waits for the person here, so no card (its row says why).
  assert.equal(card({ leaves: [{ ...LEAVES[0], eligible: false }] }), undefined);
  // awaitingSignature: null — the service cannot tell now.
  let shown = panel(page, { conversation: state(null) }).render();
  assert.equal(find(shown, attr('data-rulith-awaiting-signature')), undefined);
  assert.equal(text(find(shown, attr('data-rulith-awaiting-unknown'))), 'The criteria awaiting your signature cannot be read right now');
  assert.doesNotMatch(text(shown), /No acceptance criteria yet/);
  // Absent (an older service): the same, whatever the cached results show.
  const conversation = { ok: true, found: true, conversation: { boardId: 'board-1' } };
  for (const board of [boardData(), boardData({ view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running' }] } } })]) {
    shown = panel(page, { conversation, board }).render();
    assert.equal(text(find(shown, attr('data-rulith-awaiting-unknown'))), 'The criteria awaiting your signature cannot be read right now');
    assert.doesNotMatch(text(shown), /No acceptance criteria yet/);
  }
  // An ended conversation reports []: nothing to sign; a goal waiting for acceptance with nothing proposed goes to Console.
  shown = panel(page, { conversation: state([]), board: boardData({ casesUrl: 'https://rulith.example/console/#/cases?agentId=a1' }) }).render();
  const task = find(shown, attr('data-rulith-task', 'goal-7'));
  assert.equal(find(task, (node) => node.tag === 'a').props.href, 'https://rulith.example/console/#/cases?agentId=a1');
  assert.equal(text(find(task, (node) => node.tag === 'a')), 'Handle in Console');
  // More goals than the service lists.
  shown = panel(page, { conversation: { ok: true, found: true, conversation: { awaitingSignature: awaiting(), awaitingSignatureTruncated: true } } }).render();
  assert.match(text(shown), /More tasks await your signature than are listed here: see them in Console\./);
});

test('a failed state read never claims no Board or nothing to sign: cannot be read right now, with the results there are, and after a restart', () => {
  const page = loadPage();
  for (const conversation of [{ ok: false, teaching: 'The account service is temporarily unavailable.' }, { ok: false, errorCode: 'conversations_unavailable' },
    { ok: false, teaching: 'Sign in to a Rulith account from the manager first.' }]) {
    // With this process's cached results.
    let shown = panel(page, { conversation, board: boardData({ view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running' }] } } }) }).render();
    assert.equal(text(find(shown, attr('data-rulith-awaiting-unknown'))), 'The criteria awaiting your signature cannot be read right now', JSON.stringify(conversation));
    assert.doesNotMatch(text(shown), /No acceptance criteria yet|has not started a task/);
    assert.match(text(shown), /Acceptance criteria and statusAcceptance criteria show here once they are read\./);
    // After a restart (no cached results yet) while the service cannot be read: not "no task yet", not "no Board".
    shown = panel(page, { conversation, board: { ok: true, available: true, agentName: 'Default agent', view: null } }).render();
    assert.equal(find(shown, attr('data-rulith-panel-message')), undefined);
    assert.doesNotMatch(text(shown), /has not started a task|No acceptance criteria yet|No tasks yet/);
    assert.match(text(shown), /The criteria awaiting your signature cannot be read right now/);
    assert.match(text(shown), /TasksThis conversation's tasks cannot be read right now: they show here once its next result arrives\./);
  }
  // Only the service's found:false is "no Board yet"; a reply without the field says nothing either way.
  assert.match(text(panel(page, { conversation: { ok: true, found: false }, board: { ok: true, available: true, view: null } }).render()), /^This conversation has not started a task yet\./);
  assert.equal(text(panel(page, { conversation: { ok: true }, board: { ok: true, available: true, view: null } }).render()), 'Reading…');
});

test('an operation that waits for a person: one sentence and 去 Console 处理; this computer offline points to settings', () => {
  const page = loadPage();
  const waiting = { tool: 'Execute', label: 'Execute worker_c0ffee_eng_run_1', state: 'waiting_for_decision', decision: "a person's decision in Console", at: '2026-10-24T08:02:00Z' };
  let shown = panel(page, { board: boardData({ recent: [waiting], consoleUrl: 'https://rulith.example/console/#/agents/a1?tab=runtime' }) }).render();
  const decision = find(shown, attr('data-rulith-decision'));
  assert.equal(text(decision), 'An operation is waiting for your decision. Handle in Console');
  assert.equal(find(decision, (node) => node.tag === 'a').props.href, 'https://rulith.example/console/#/agents/a1?tab=runtime');
  assert.match(text(find(shown, attr('data-rulith-operation'))), /^Run commands: waiting for your decision/);
  // Without a Console address (signed out, say) the sentence still says where; a person's reconciliation reads as such.
  shown = panel(page, { board: boardData({ recent: [{ ...waiting, state: 'needs_person' }] }) }).render();
  assert.equal(text(find(shown, attr('data-rulith-decision'))), 'An operation\'s result needs you to reconcile it in Console. Handle it in Console.');
  // A goal waiting for a decision says so in 任务, with the same sentence.
  shown = panel(page, { conversation: state([]), board: boardData({ view: { goals: { directory: [{ goal: 'goal-7', label: '写 fizzbuzz.py', status: 'running', awaiting: 'decision' }] } } }) }).render();
  assert.equal(text(find(shown, attr('data-rulith-task', 'goal-7'))), '写 fizzbuzz.pyWaiting for your decision');
  assert.match(text(find(shown, attr('data-rulith-decision'))), /^An operation is waiting for your decision\./);
  // Offline: 在线／离线 only, and where to look.
  shown = panel(page, { worker: { ok: true, available: true, state: 'offline', computer: 'VS-STATION' } }).render();
  const computer = find(shown, attr('data-rulith-computer'));
  assert.equal(computer.props['data-rulith-computer'], 'offline');
  assert.equal(text(computer), 'VS-STATION · OfflineView in Settings');
  find(computer, (node) => node.tag === 'button').props.onClick();
  assert.deepEqual(plain(page.plugin.settingsView.getSnapshot()), { open: true, section: 'computer' });
  assert.equal(text(find(panel(page, { worker: null }).render(), attr('data-rulith-computer'))), 'Reading…');
  assert.equal(text(find(panel(page, { worker: { ok: true, available: false, computer: 'VS-STATION' } }).render(), attr('data-rulith-computer'))), 'VS-STATION · OfflineView in Settings');
  // A Worker state that could not be read is 读不到, never 离线.
  for (const worker of [{ ok: false, teaching: 'the Worker trace answered 500' }, { ok: true, available: true, state: 'unknown', computer: 'VS-STATION' }]) {
    const unread = find(panel(page, { worker }).render(), attr('data-rulith-computer'));
    assert.equal(unread.props['data-rulith-computer'], 'unread');
    assert.doesNotMatch(text(unread), /Offline|View in Settings/);
    assert.match(text(unread), /Could not be read$/);
  }
});

test('a call waiting for a person shows after a restart too, from the Agent\'s Health read, with its Console page', () => {
  const page = loadPage();
  const health = (phase, extra = {}) => ({ ok: true, available: true, consoleUrl: 'https://rulith.example/console/#/agents/a1?tab=runtime',
    pendingCall: { needsPerson: true, phase }, ...extra });
  // No result of this conversation seen yet (a restart): the Health read alone.
  const restarted = { ok: true, available: true, agentName: 'Default agent', view: null };
  let shown = panel(page, { board: restarted, conversation: state([]), health: health('waiting') }).render();
  let decision = find(shown, attr('data-rulith-decision'));
  assert.equal(text(decision), 'This Agent has an operation waiting for your decision. Handle in Console');
  assert.equal(find(decision, (node) => node.tag === 'a').props.href, 'https://rulith.example/console/#/agents/a1?tab=runtime');
  shown = panel(page, { board: restarted, conversation: state([]), health: health('reconciliation_required') }).render();
  assert.equal(text(find(shown, attr('data-rulith-decision'))), 'An operation of this Agent needs you to reconcile its result in Console. Handle in Console');
  // Nothing needs a person, or the read failed: no sentence.
  for (const read of [health('forwarding', { pendingCall: { needsPerson: false, phase: 'forwarding' } }), { ok: true, available: true, pendingCall: null },
    { ok: false, teaching: 'Rulith answered 400' }, null])
    assert.equal(find(panel(page, { board: restarted, conversation: state([]), health: read }).render(), attr('data-rulith-decision')), undefined);
  // This conversation's own result says more: its sentence, with the Health read's page when the result has none.
  const waiting = { tool: 'Execute', label: 'Execute worker_c0ffee_eng_run_1', state: 'waiting_for_decision', at: '2026-10-24T08:02:00Z' };
  shown = panel(page, { board: boardData({ recent: [waiting] }), health: health('waiting') }).render();
  decision = find(shown, attr('data-rulith-decision'));
  assert.equal(text(decision), 'An operation is waiting for your decision. Handle in Console');
  assert.equal(find(decision, (node) => node.tag === 'a').props.href, 'https://rulith.example/console/#/agents/a1?tab=runtime');
});

test('operation lines are plain one-liners: never a tool id, a state code or a reason code', () => {
  const { plugin } = loadPage();
  const line = (op) => plain(plugin.operationLine(op));
  const exec = (action, extra = {}) => ({ tool: 'Execute', label: `Execute worker_c0ffee_eng_${action}_1 → goal-7`, state: 'done', ...extra });
  const withResult = (value) => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  const cases = [
    [exec('write_file', withResult({ result: { receipt: { path: 'D:\\game\\fizzbuzz.py' } } })), 'Write fizzbuzz.py'],
    [exec('write_file'), 'Write files'],
    [exec('patch_file', withResult({ result: { path: 'src/app.js' } })), 'Edit app.js'],
    [exec('read', withResult({ result: { path: 'README.md' } })), 'Read README.md'],
    [exec('test', withResult({ result: { rows: [{ exit_code: 0 }] } })), 'Run tests: passed'],
    [exec('test', withResult({ result: { rows: [{ exit_code: 1 }] } })), 'Run tests: did not pass'],
    [exec('test'), 'Run tests'],
    [exec('acceptance', withResult({ exit_code: 0 })), 'Run acceptance checks: passed'],
    [exec('run', { state: 'failed', summary: 'the Worker reported failure' }), 'Run commands: failed'],
    [exec('run', { state: 'refused', reason: 'The owner withdrew this grant after this conversation began; nothing was run. A new conversation uses the owner\'s current grants.' }), 'Refused: the project\'s grant was withdrawn'],
    [exec('run', { state: 'refused', reason: 'The execution environment for this Action is offline; nothing was run. Try again later or use another Action.' }), 'Refused: this computer is offline'],
    [exec('run', { state: 'refused', reason: 'A person refused this call. No work was dispatched.' }), 'Refused: you refused this operation'],
    [exec('run', { state: 'refused', summary: 'refused: bad_command', reason: 'command refused' }), 'Run commands: refused'],
    [exec('run', { state: 'refused', contentWithheld: true }), 'Run commands: refused'],
    [exec('run', { state: 'unknown', summary: 'reconciled; the external effect is unknown' }), 'Run commands: result unknown, reconcile it in Console'],
    [exec('job_start', { state: 'running', stage: 'at_worker' }), 'Run commands in the background: running on this computer'],
    [exec('run', { state: 'running', stage: 'not_dispatched' }), 'Run commands: in progress'],
    [exec('run', { state: 'waiting_for_decision' }), 'Run commands: waiting for your decision'],
    [exec('run', { state: 'needs_person' }), 'Run commands: needs you to reconcile it in Console'],
    [{ tool: 'Execute', label: 'Execute write_calculation_result → goal-2', state: 'done' }, 'Run an operation'],
    [{ tool: 'Execute', label: 'Execute constructor', state: 'done' }, 'Run an operation'],
    [{ tool: 'Set', label: 'Set', state: 'done', summary: 'declared goal goal-7' }, 'Start a task'],
    [{ tool: 'Set', label: 'Set', state: 'done', summary: '3 nodes written' }, 'Record evidence'],
    [{ tool: 'Set', label: 'Set', state: 'done', summary: '3 nodes written; completed goal-7' }, 'Record evidence'],
    [{ tool: 'Set', label: 'Set', state: 'done', summary: 'completed goal-7' }, 'Task completed (acceptance passed)'],
    [{ tool: 'Set', label: 'Set end_goal goal-7', state: 'done', summary: 'ended goal-7 as abandoned' }, 'End the task'],
    [{ tool: 'Get', label: 'Get artifact art-1', state: 'done' }, 'Read a result'],
  ];
  for (const [op, words] of cases) {
    const shown = line(op);
    assert.equal(shown.text, words, JSON.stringify(op).slice(0, 120));
    assert.doesNotMatch(shown.text + (shown.detail || ''), /worker_|eng[._]|Execute|goal-|waiting_for_decision|needs_person|at_worker|not_dispatched|source_revoked|bad_command|\bSet\b/);
  }
  assert.equal(line(cases[9][0]).detail, 'Run commands', 'a refusal with its reason keeps what was refused beside it');
});

test('ACC-LOCAL-11 signing in the client: only the dialog\'s Sign signs; the same request id on retry; Signed', async () => {
  const answers = [{ ok: true, state: 'pending' }, { ok: true, state: 'complete', result: { accepted: true } }];
  const page = loadPage({ reply: ({ url }) => (url === '/rulith/api/conversation/sign-acceptance' ? answers.shift()
    : url.startsWith('/rulith/api/conversation?') ? state([]) : { ok: true }) });
  const { plugin } = page;
  const m = panel(page);
  const dialog = () => page.mount(plugin.components.SignDialog).render();
  const signButton = () => find(m.render(), attr('data-rulith-sign', 'goal-7'));
  assert.equal(dialog(), null, 'no confirmation until asked');
  // The button only opens the confirmation; 先不签 and a click beside the dialog sign nothing.
  signButton().props.onClick();
  let asked = dialog();
  assert.equal(signRequests(page).length, 0);
  const box = find(asked, attr('data-rulith-sign-dialog', 'goal-7'));
  assert.equal(box.props.role, 'dialog');
  assert.match(text(box), /^写 fizzbuzz\.py/);
  assert.ok(text(box).includes(PSC.SIGNING.body));
  assert.deepEqual(nodes(box).filter((node) => node.tag === 'button').map(text), [PSC.SIGNING.cancel, PSC.SIGNING.accept]);
  assert.equal(nodes(box).filter((node) => node.tag === 'button').some((node) => node.props.autoFocus), false, 'nothing is focused to sign on Enter');
  find(box, attr('data-rulith-sign-cancel')).props.onClick();
  assert.equal(plugin.signView.getSnapshot(), null);
  signButton().props.onClick();
  dialog().props.onClick();   // the backdrop
  assert.equal(plugin.signView.getSnapshot(), null);
  await flush();
  assert.equal(signRequests(page).length, 0, 'nothing signs without the confirm click');
  // 签字: what the dialog showed, frozen; a second click of the same dialog does nothing.
  signButton().props.onClick();
  asked = dialog();
  const confirm = find(asked, attr('data-rulith-sign-confirm'));
  assert.equal(text(confirm), 'Sign');
  confirm.props.onClick(); confirm.props.onClick();
  assert.equal(plugin.signView.getSnapshot(), null);
  await until(() => answers.length === 0 && m.cells[NOTE]?.state === 'signed');
  const sent = signRequests(page).map((request) => request.body);
  assert.equal(sent.length, 2, 'pending, then the same request again');
  assert.ok(/^[0-9a-f-]{36}$/.test(sent[0].requestId));
  assert.deepEqual(plain(sent), [0, 1].map(() => ({ session: 's1', goal: 'goal-7', leaves: ['leaf-a', 'leaf-b'], requestId: sent[0].requestId })),
    'every eligible leaf in the proposal\'s order, the signed one included; never an ineligible one');
  const note = find(m.render(), attr('data-rulith-sign-note'));
  assert.equal(text(note), PSC.SIGNING.signed);
  assert.equal(note.props['data-rulith-sign-note'], 'signed');
  assert.ok(page.requests.some((request) => request.method === 'GET' && request.url === '/rulith/api/conversation?session=s1'),
    'the conversation is read again afterwards');
  assert.equal(find(m.render(), attr('data-rulith-awaiting-signature')), undefined, 'the state read afterwards has nothing left to sign');
  // A new confirmation (of criteria proposed again) is a new request id.
  m.cells[1] = state(awaiting());
  answers.push({ ok: true, state: 'complete', result: { accepted: true } });
  signButton().props.onClick();
  find(dialog(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => signRequests(page).length === 3 && answers.length === 0);
  assert.notEqual(signRequests(page)[2].body.requestId, sent[0].requestId);
});

test('ACC-LOCAL-11 sign outcomes: each refusal code in words, pending and lost answers retried with the same request id', async () => {
  const { plugin } = loadPage();
  const { SIGN } = plugin;
  const flow = async (replies, tries, unconfirmed = false) => {
    const sent = [], waits = [], reports = [];
    const outcome = await plugin.signAcceptanceFlow({ sessionId: 's1', goal: 'goal-7', leaves: ['leaf-a'], requestId: 'req-0001', tries, unconfirmed,
      wait: async (ms) => { waits.push(ms); }, report: (o) => reports.push(o.state),
      api: async (route, body) => { sent.push({ route, body }); const next = replies.shift(); if (next instanceof Error) throw next; return next; } });
    return { outcome: plain(outcome), sent, waits, reports };
  };
  // The Kernel's refusal is a complete control with accepted:false; nothing was signed.
  for (const [code, reason] of [...Object.entries(PSC.SIGN_REASONS), ['bad_command', PSC.SIGNING.unknownReason], ['constructor', PSC.SIGNING.unknownReason]]) {
    const { outcome, sent } = await flow([{ ok: true, state: 'complete', result: { accepted: false, errorCode: code, teaching: 'x' } }]);
    assert.deepEqual(outcome, { state: 'refused', errorCode: code, text: PSC.fill(PSC.SIGNING.refused, { teaching: reason }), answered: true }, code);
    assert.equal(sent.length, 1, 'a refusal is not retried');
  }
  // A refusal of the request itself (4xx with its code) and a complete control without a result are refusals too.
  for (const reply of [{ ok: false, errorCode: 'request_conflict', teaching: 'x' }, { ok: false, errorCode: 'conversation_ended' },
    { ok: false }, { ok: true, state: 'complete' }])
    assert.equal((await flow([reply])).outcome.text, PSC.fill(PSC.SIGNING.refused, { teaching: PSC.SIGNING.unknownReason }));
  // A refusal without a code says the service's own reason (Console Text A's {teaching}), never "unknown".
  assert.equal((await flow([{ ok: false, teaching: 'The signing request is incomplete.' }])).outcome.text, 'Nothing was signed: The signing request is incomplete.');
  assert.equal((await flow([{ ok: true, state: 'complete', result: { accepted: false, teaching: 'This goal is not open.' } }])).outcome.text,
    'Nothing was signed: This goal is not open.');
  // 202, a 503 or a lost answer (signature_unconfirmed) and a network failure: pending, sent again with the same id.
  const retried = await flow([{ ok: true, state: 'pending' }, { ok: false, errorCode: 'signature_unconfirmed' }, new TypeError('Failed to fetch'),
    { ok: true, state: 'complete', result: { accepted: true } }]);
  assert.deepEqual(retried.outcome, { state: 'signed', text: PSC.SIGNING.signed, answered: true });
  assert.deepEqual(retried.sent.map((row) => row.body.requestId), ['req-0001', 'req-0001', 'req-0001', 'req-0001']);
  assert.deepEqual(retried.sent.map((row) => row.route), Array(4).fill('conversation/sign-acceptance'));
  assert.deepEqual(retried.reports, ['pending', 'pending', 'pending']);
  assert.deepEqual(retried.waits, [1500, 3000, 4500]);
  // Once an attempt went unconfirmed, a later refusal that did not come from the Kernel (the manager not reached, signing
  // out, another control pending, the device no longer authorized, …) cannot say the first one failed: still pending.
  for (const later of [{ ok: false, teaching: 'fetch failed' }, { ok: false, errorCode: 'manager_signing_out' }, { ok: false, errorCode: 'manager_closing' },
    { ok: false, teaching: 'Choose an Agent first' }, { ok: false, errorCode: 'not_authorized' }, { ok: false, errorCode: 'control_pending' }]) {
    const run = await flow([{ ok: true, state: 'pending' }, later, { ok: true, state: 'pending' }], 3);
    assert.deepEqual(run.outcome, { state: 'pending', text: SIGN.pending }, JSON.stringify(later));
    assert.deepEqual(run.sent.map((row) => row.body.requestId), ['req-0001', 'req-0001', 'req-0001']);
    // A rerun of a request already unconfirmed: the same from its first attempt.
    assert.deepEqual((await flow([later], 1, true)).outcome, { state: 'pending', text: SIGN.pending });
    // Before anything went unconfirmed it is a refusal: nothing was signed.
    assert.equal((await flow([later], 1)).outcome.state, 'refused');
  }
  // The Kernel's answer is definite even then.
  assert.deepEqual((await flow([{ ok: true, state: 'pending' }, { ok: true, state: 'complete', result: { accepted: false, errorCode: 'goal_ended' } }])).outcome,
    { state: 'refused', errorCode: 'goal_ended', text: PSC.fill(PSC.SIGNING.refused, { teaching: PSC.SIGN_REASONS.goal_ended }), answered: true });
  // Still unconfirmed after the last try: it says so, never that nothing was signed.
  const exhausted = await flow([{ ok: true, state: 'pending' }, { ok: true, state: 'pending' }, new Error('offline')], 3);
  assert.deepEqual(exhausted.outcome, { state: 'pending', text: SIGN.pending });
  assert.equal(SIGN.pending, PSC.SIGNING.pending);
  assert.equal(exhausted.sent.length, 3);
  assert.deepEqual(plain(plugin.signOutcome(null)), { state: 'pending', text: SIGN.pending });
  // The texts are exactly the ones PSC 0.2.29 fixes, every one of them.
  assert.deepEqual(plain(SIGN), PSC.SIGNING);
  assert.deepEqual(plain(plugin.SIGN_REASONS), PSC.SIGN_REASONS);
});

test('ACC-LOCAL-11 a refused or unconfirmed signature in the panel says so, and the panel signs one goal at a time', async () => {
  const answers = [{ ok: true, state: 'complete', result: { accepted: false, errorCode: 'leaf_not_proposed' } }];
  const page = loadPage({ reply: ({ url }) => (url === '/rulith/api/conversation/sign-acceptance' ? answers.shift() ?? { ok: false, errorCode: 'signature_unconfirmed' }
    : { ok: true }) });
  const m = panel(page);
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[NOTE]?.state === 'refused');
  let note = find(m.render(), attr('data-rulith-sign-note'));
  assert.equal(text(note), PSC.fill(PSC.SIGNING.refused, { teaching: PSC.SIGN_REASONS.leaf_not_proposed }));
  assert.equal(note.props.role, 'alert');
  // Unconfirmed every time: the button waits while it retries, and the note says the outcome is not confirmed.
  m.cells[1] = state(awaiting());
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[BUSY] === 'goal-7');
  const busy = find(m.render(), attr('data-rulith-sign', 'goal-7'));
  assert.equal(busy.props.disabled, true);
  assert.equal(text(busy), PSC.SIGNING.signing);
  busy.props.onClick();
  assert.equal(page.plugin.signView.getSnapshot(), null, 'no second confirmation while one is being signed');
  await until(() => m.cells[BUSY] === '' && m.cells[NOTE]?.state === 'pending', 2000);
  note = find(m.render(), attr('data-rulith-sign-note'));
  assert.equal(text(note), PSC.SIGNING.pending);
  const unconfirmedId = signRequests(page)[1].body.requestId;
  assert.equal(new Set(signRequests(page).slice(1).map((request) => request.body.requestId)).size, 1);
  assert.equal(signRequests(page).length, 1 + 5);
  // Confirming the same goal again resends that request, as it was confirmed (its id and leaves), even if the proposal
  // changed meanwhile; the dialog shows what will be sent.
  m.cells[1] = state(awaiting({ leaves: [LEAVES[0], { ...LEAVES[2], eligible: true }] }));
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  const again = page.mount(page.plugin.components.SignDialog).render();
  assert.deepEqual(nodes(again).filter(attr('data-rulith-leaf')).map((node) => node.props['data-rulith-leaf']), ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-d']);
  answers.push({ ok: true, state: 'complete', result: { accepted: true } });
  find(again, attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[NOTE]?.state === 'signed');
  assert.deepEqual(plain(signRequests(page).at(-1).body), { session: 's1', goal: 'goal-7', leaves: ['leaf-a', 'leaf-b'], requestId: unconfirmedId });
  assert.equal(page.plugin.unconfirmedSignatures.size, 0, 'the Kernel answered: nothing is left unconfirmed');
});

test('ACC-LOCAL-11 an unconfirmed signature is kept until a state read shows it settled; then a confirmation is a new request', async () => {
  const page = loadPage({ reply: ({ url }) => (url === '/rulith/api/conversation/sign-acceptance' ? { ok: false, errorCode: 'signature_unconfirmed' } : { ok: true }) });
  const m = panel(page, { sessionId: 's2' });
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => m.cells[BUSY] === '' && m.cells[NOTE]?.state === 'pending', 2000);
  const first = signRequests(page)[0].body.requestId;
  assert.equal(page.plugin.unconfirmedSignatures.size, 1);
  // A failed or undecided read changes nothing; one that still shows the leaves unsigned keeps it too.
  for (const read of [{ ok: false }, state(null), state(awaiting())]) { m.cells[1] = read; m.render(); }
  assert.equal(page.plugin.unconfirmedSignatures.size, 1);
  // The leaves the request named are signed now: settled; a new confirmation is a new request.
  m.cells[1] = state(awaiting({ leaves: LEAVES.map((leaf) => (leaf.node === 'leaf-a' || leaf.node === 'leaf-b' ? { ...leaf, signed: true } : leaf)).concat(
    [{ node: 'leaf-e', label: '新的标准', criterion: atom('eng.check_passed', { key: 'game:e:sha256:' + digest }), signed: false, eligible: true }]) }));
  m.render();
  assert.equal(page.plugin.unconfirmedSignatures.size, 0);
  find(m.render(), attr('data-rulith-sign', 'goal-7')).props.onClick();
  find(page.mount(page.plugin.components.SignDialog).render(), attr('data-rulith-sign-confirm')).props.onClick();
  await until(() => signRequests(page).length === 10 && m.cells[BUSY] === '', 2000);
  assert.notEqual(signRequests(page)[5].body.requestId, first);
  assert.deepEqual(plain(signRequests(page)[5].body.leaves), ['leaf-a', 'leaf-b', 'leaf-e']);
  // A goal that left the list (ended) is settled as well.
  m.cells[1] = state([]); m.render();
  assert.equal(page.plugin.unconfirmedSignatures.size, 0);
});

test('the right column opens at most a third of the window, keeps the conversation wide, and registers as Tasks', () => {
  const page = loadPage({ windowExtra: { innerWidth: 1600 } });
  const { plugin } = page;
  for (const [width, right] of [[1280, 426], [1600, 533], [1920, 640]]) {
    assert.equal(plugin.rightColumnWidth(width), right, String(width));
    assert.ok(right <= width / 3, 'at most a third');
    assert.ok(width - 280 - right >= 560, 'the conversation keeps its minimum beside the default sidebar');
  }
  assert.equal(plugin.rightColumnWidth(1100), 300, 'dsh\'s own minimum; dsh keeps 400 px for the conversation below that');
  // The first width is set through the layout face's panel actions, once, when the layout service is up.
  const set = [], registered = new Map(), tabs = [];
  const slots = { inject(_name, fn) { fn(); }, register(options, component) { registered.set(options.name + '|' + (options.id || options.key || ''), component); } };
  const layout = { panels: { setRightbar: (px) => set.push(px) }, toggleSidebar() {} };
  plugin.apply({ slots, effect(fn) { fn(); }, sidebarRight: { mounted: { subscribe() { return () => {}; }, getSnapshot: () => undefined } },
    sidebarRightTabs: { register: (tab) => { tabs.push(tab); return () => {}; } },
    inject(deps, fn) { if (deps[0] === 'layout') fn({ layout, slots }); } });
  assert.deepEqual(set, [533]);
  assert.equal(tabs[0].title(), 'Tasks');
  assert.equal(tabs[0].guide[0].description(), 'Tasks, acceptance criteria, recent operations and this computer');
  assert.ok(registered.has('shell.overlay|rulith-sign'), 'the signing confirmation is drawn over the whole page');
  assert.equal(text(registered.get('sidebar.right.pane.tab.title|rulith-dsh-ui/board')()), 'Tasks');
  // A layout face without panel actions (another dsh) is left as it is.
  plugin.apply({ slots, effect(fn) { fn(); }, sidebarRight: { mounted: { subscribe() { return () => {}; }, getSnapshot: () => undefined } },
    sidebarRightTabs: { register: () => () => {} }, inject(deps, fn) { if (deps[0] === 'layout') fn({ layout: { toggleSidebar() {} }, slots }); } });
  assert.deepEqual(set, [533]);
});

test('installed dsh: the layout face carries the panel actions the app sets the first width through, and its defaults are as assumed', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, () => {
  const source = fs.readFileSync(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js'), 'utf8');
  // The defaults the app corrects (45 % first width) and keeps (300 px minimum, 400 px for the conversation).
  assert.match(source, /const RIGHTBAR_DEFAULT_RATIO = \.45;/);
  assert.match(source, /const available = viewport - s - 400;/);
  assert.match(source, /setRightbar: \(d, px\) => \{[\s\S]*?d\.layoutInfo\.rightbar = clampWidth\(px, 300,/);
  assert.match(source, /d\.layoutInfo\.rightbar \?\?= Math\.max\(300, Math\.round\(d\.layoutInfo\.viewportWidth \* RIGHTBAR_DEFAULT_RATIO\)\);/,
    'opening keeps a width set before');
  // The face the plugin gets is a LayoutController whose `panels` are the store's actions.
  let exports;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory(() => ({})); } } }, AbortController });
  const actions = { setRightbar() {} };
  const face = new exports.LayoutController(actions, () => false, {});
  assert.equal(face.panels, actions);
  assert.match(source, /new LayoutController\(instance\.actions,/);
  // dsh's own column solver at three window widths, with its default sidebar (280 px): the app's first width against
  // dsh's 45 % (which left the conversation 424 px at 1280, design §6).
  const math = vm.runInNewContext(source.slice(source.indexOf('const SIDEBAR_AUTO_COLLAPSE'), source.indexOf('//#region lib/types/client/DocumentTitle.js'))
    + '; ({ computeColumns, RIGHTBAR_DEFAULT_RATIO })', {});
  const { plugin } = loadPage();
  const columns = (width, right) => plain(math.computeColumns(width, 280, right, 56));
  assert.deepEqual(columns(1280, 1280 * math.RIGHTBAR_DEFAULT_RATIO), { sidebar: 280, center: 424, rightbar: 576 });
  assert.deepEqual([1280, 1600, 1920].map((width) => columns(width, plugin.rightColumnWidth(width))), [
    { sidebar: 280, center: 574, rightbar: 426 }, { sidebar: 280, center: 787, rightbar: 533 }, { sidebar: 280, center: 1000, rightbar: 640 }]);
});

test('the left column wraps names instead of cutting them off', () => {
  const page = loadPage();
  const store = (value) => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
  const title = '把 wordcount 的统计结果写进 report.md，并让测试覆盖空文件和超长行';
  const list = { ids: ['s1'], byId: { s1: { id: 's1', cwd: '/project', title, updatedAt: Date.now(), running: false, blank: false } } };
  const tree = page.mount(page.plugin.makeRulithTree({ sessions: { list: store(list) }, workspaces: { list: store({}) },
    ui: { selection: store({ sessionId: 's1' }), openSession() {}, archiveSession() {} } }), { wide: true });
  tree.cells[0] = { ok: true, defaultAgentId: 'a1', assignments: { s1: 'a1' }, agents: [{ agentId: 'a1', name: 'A rather long Agent name for this account', attached: true,
    isDefault: true, directories: [{ path: '/project', label: 'a-project-folder-with-a-long-name', source: 'project' }] }] };
  const shown = tree.render();
  const named = nodes(shown).filter((node) => node.tag === 'span' && [title, 'A rather long Agent name for this account'].includes(text(node))
    || node.tag === 'span' && text(node) === '📁 a-project-folder-with-a-long-name');
  assert.equal(named.length, 3);
  for (const node of named) {
    assert.equal(node.props.style.whiteSpace, undefined, text(node));
    assert.equal(node.props.style.textOverflow, undefined, text(node));
    assert.equal(node.props.style.wordBreak, 'break-word');
  }
});

// ---- The host half: the guarded route over a fake manager (standing for the manager and the Gateway behind it).
async function hostFixture(t, manager) {
  const previousFlag = process.env.RULITH_DSH_CONVERSATION_BOARDS;
  process.env.RULITH_DSH_CONVERSATION_BOARDS = '1';
  t.after(() => { if (previousFlag === undefined) delete process.env.RULITH_DSH_CONVERSATION_BOARDS; else process.env.RULITH_DSH_CONVERSATION_BOARDS = previousFlag; });
  const calls = [], effects = [];
  let server;
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(net, 'connect', (_options, callback) => { const socket = new EventEmitter(); socket.destroy = () => {}; queueMicrotask(callback); return socket; });
  t.mock.method(fs, 'readFileSync', (file) => {
    if (String(file).endsWith('fixture-key.txt')) return 'fixture-manager-key';
    if (String(file).endsWith('registry.json')) return JSON.stringify({ instances: [{ id: 'instance', mode: 'local_agent', agentId: 'agent-1', agentName: 'Default agent', directory: 'fixture-instance' }] });
    if (String(file).endsWith('local.json')) return JSON.stringify({ agent: { env: { RULITH_TOKEN: 'fixture-token' } } });
    throw new Error('fixture file absent');
  });
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).includes('/manager/')) {
      const route = new URL(String(url)).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (route === '/manager/conversations/sign-acceptance') calls.push(body);
      const [status, answer] = route === '/manager/conversations/sign-acceptance' || route === '/manager/health' ? await manager(body, route) : [200, { ok: true }];
      return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init.body);
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 'fixture-mcp-session' };
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25',
      tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })), _meta: { 'rulith/v4': { agentId: 'agent-1' } } } }), { headers });
  });
  const ctx = { on() {}, effect(fn) { effects.push(fn()); }, tools: { register() { return () => {}; } }, webServer: { register(route) { server = route; return () => {}; } }, connection: { admit: () => ({ peer: {} }) } };
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  await apply(ctx, { managerHome: 'fixture-manager', runtimeEntry: 'fixture-runtime', keyFile: 'fixture-key.txt', conversationBoards: true, shadow: { enabled: false } });
  const post = async (body) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/rulith/api/conversation/sign-acceptance', headers: { host: 'localhost', 'x-deep-rulith': '1' } });
    let reply;
    const done = server.handler(req, { writeHead() {}, end(value) { reply = JSON.parse(value); } });
    queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
    await done;
    return reply;
  };
  const get = async (url) => {
    let reply;
    await server.handler({ method: 'GET', url, headers: { host: 'localhost', 'x-deep-rulith': '1' } },
      { writeHead() {}, end(value) { reply = JSON.parse(value); } });
    return reply;
  };
  return { calls, post, get };
}
const record = (body, extra = {}) => ({ ok: true, controlId: 'control-1', accountId: 'acct-1', requestId: body.requestId, agentId: body.agentId,
  boardId: 'board-1', state: 'complete', createdAt: '2026-10-24T00:00:00Z', operation: { kind: 'SignAcceptance', goal: body.goal, leaves: body.leaves },
  result: { accepted: true }, device: { token: 'never' }, instances: [{ id: 'never' }], ...extra });
const signBody = { session: 's1', goal: 'goal-7', leaves: ['leaf-a', 'leaf-b'], requestId: '6f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f' };

test('ACC-LOCAL-11 host: the sign route forwards exactly the confirmation and confirms the answer is this request\'s', async (t) => {
  let answer = (body) => [200, record(body)];
  const f = await hostFixture(t, (body) => answer(body));
  const signed = await f.post(signBody);
  assert.deepEqual(f.calls, [{ agentId: 'agent-1', conversationKey: 'dsh:s1', goal: 'goal-7', leaves: ['leaf-a', 'leaf-b'], requestId: signBody.requestId }]);
  assert.deepEqual(signed, { ok: true, state: 'complete', result: { accepted: true }, requestId: signBody.requestId, boardId: 'board-1' },
    'only the control\'s outcome reaches the page, nothing of the manager\'s state');
  // The Kernel's refusal passes as the control's result.
  answer = (body) => [200, record(body, { result: { accepted: false, errorCode: 'goal_ended', teaching: 'This goal has ended.' } })];
  assert.deepEqual((await f.post(signBody)).result, { accepted: false, errorCode: 'goal_ended', teaching: 'This goal has ended.' });
  // 202 from the Gateway arrives as the pending control.
  answer = (body) => [200, record(body, { state: 'pending', result: undefined, teaching: 'Send the same request again.' })];
  assert.equal((await f.post(signBody)).state, 'pending');
  // An answer that is not this request's (another id, Agent or operation) does not confirm it.
  for (const wrong of [{ requestId: 'other-request' }, { agentId: 'agent-2' }, { operation: { kind: 'SignAcceptance', goal: 'goal-7', leaves: ['leaf-a'] } },
    { operation: { kind: 'SetExplorationMode', mode: 'strict' } }, { operation: undefined }]) {
    answer = (body) => [200, record(body, wrong)];
    assert.deepEqual(await f.post(signBody), { ok: false, teaching: 'The answer received does not confirm this signature.', errorCode: 'signature_unconfirmed', own: true }, JSON.stringify(wrong));
  }
  // The manager's refusal keeps its code; its "no definite answer" stays unconfirmed.
  answer = () => [400, { ok: false, errorCode: 'request_conflict', teaching: 'This request id was used for another operation.' }];
  assert.equal((await f.post(signBody)).errorCode, 'request_conflict');
  answer = () => [400, { ok: false, errorCode: 'signature_unconfirmed', teaching: 'The account service did not confirm whether these criteria were signed.' }];
  assert.equal((await f.post(signBody)).errorCode, 'signature_unconfirmed');
  // The manager lost mid-request: unconfirmed. The manager not reached at all: a definite failure without a code.
  answer = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  assert.equal((await f.post(signBody)).errorCode, 'signature_unconfirmed');
  answer = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const refused = await f.post(signBody);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, undefined);
  // A body that is not one confirmation is refused before the manager is asked.
  const before = f.calls.length;
  for (const bad of [{ ...signBody, requestId: '' }, { ...signBody, requestId: 'bad id with spaces' }, { ...signBody, leaves: [] },
    { ...signBody, leaves: ['leaf-a', 'leaf-a'] }, { ...signBody, leaves: 'leaf-a' }, { ...signBody, goal: '' }, { ...signBody, leaves: [1] },
    { ...signBody, leaves: Array.from({ length: 65 }, (_, i) => 'leaf-' + i) }, { ...signBody, session: '' }]) {
    const reply = await f.post(bad);
    assert.equal(reply.ok, false, JSON.stringify(bad).slice(0, 80));
    assert.notEqual(reply.errorCode, 'signature_unconfirmed');
  }
  assert.equal(f.calls.length, before);
});

test('host: the Health read gives the panel the Agent\'s pending call (whether it needs a person, its phase) and its Console page only', async (t) => {
  let health = { agents: [{ agentId: 'agent-1', console: { runtime: 'https://rulith.example/console/#/agents/agent-1?tab=runtime' },
    pendingCall: { tool: 'Execute', label: 'Execute worker_c0ffee_eng_run_1', phase: 'waiting', since: 't', needsPerson: true }, key: { state: 'active' } }] };
  const f = await hostFixture(t, (_body, route) => (route === '/manager/health' ? [200, { ok: true, health, device: { token: 'never' } }] : [200, { ok: true }]));
  assert.deepEqual(await f.get('/rulith/api/health?session=s1'), { ok: true, available: true,
    consoleUrl: 'https://rulith.example/console/#/agents/agent-1?tab=runtime', pendingCall: { needsPerson: true, phase: 'waiting' } });
  health = { agents: [{ agentId: 'agent-1', console: {} }] };
  assert.deepEqual(await f.get('/rulith/api/health?session=s1'), { ok: true, available: true, consoleUrl: '', pendingCall: null });
});

test('the Console pages the panel links come from the origin this computer signed in to, only over http(s)', () => {
  assert.equal(consoleRuntimeUrl('https://rulith.ai', 'agent 1'), 'https://rulith.ai/console/#/agents/agent%201?tab=runtime');
  assert.equal(consoleRuntimeUrl('http://127.0.0.1:8080/path?x=1', 'a'), 'http://127.0.0.1:8080/console/#/agents/a?tab=runtime');
  assert.equal(consoleGoalsUrl('https://rulith.ai', 'a'), 'https://rulith.ai/console/#/cases?agentId=a');
  for (const [origin, agent] of [['', 'a'], ['https://rulith.ai', ''], ['javascript:alert(1)', 'a'], ['not a url', 'a']])
    assert.equal(consoleRuntimeUrl(origin, agent), '');
  // The sign route's answer reaches the page through the same field picker as the other conversation controls.
  assert.deepEqual(conversationView({ state: 'complete', result: { accepted: true }, requestId: 'r', operation: { kind: 'SignAcceptance' }, accountId: 'acct', controlId: 'c' }),
    { state: 'complete', result: { accepted: true }, requestId: 'r' });
});
