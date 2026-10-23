import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, clearFirst, plan, rewriteSession, FULL_FIRST, FULL_HEAD, DELTA_HEAD, DELTA_NONE } from '../../harness/web/board-transcript.mjs';
import { RELIEF_MARK } from '../../harness/web/context-relief.mjs';
import { NOTE_PREFIX } from '../../harness/web/shadow-reviewer.mjs';
import { projectToolCall } from '../../harness/tool-history.mjs';

// A Rulith tool result as dsh stores it: the MCP result serialized, with dsh's `Error: ` prefix for refusals.
const raw = (answer, isError = false) =>
  (isError ? 'Error: ' : '') + JSON.stringify({ isError, content: [{ type: 'text', text: JSON.stringify(answer) }] });
const answer = (facts, extra = {}) => ({
  accepted: true, ...extra,
  view: { position: { writes: 'open' }, facts: facts.map((label) => ({ label })) },
  operations: [],
});

// Enough of a dsh session for the rewrite: an event log, the model-visible surface and dsh's replace records.
function fakeSession(texts) {
  const log = [];
  const surface = { nodes: [] };
  const append = (type, data, opts = {}) => {
    const event = { type, seq: log.length, data, ...opts };
    log.push(event);
    if (opts.surfaceOp?.op === 'replace') surface.nodes[surface.nodes.indexOf(opts.surfaceOp.startSeq)] = event.seq;
    else surface.nodes.push(event.seq);
    return event;
  };
  for (const text of texts) append('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: `c${log.length}`, isError: text.startsWith('Error: '), content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
  return { log, surface, append, eventAt: (seq) => log[seq], deriveEventMessage: (event) => event.data.message,
    visible: () => surface.nodes.map((seq) => log[seq].data.message.content[0].text) };
}

test('old calls read as Get, Set and Execute; other content is untouched', () => {
  const session = fakeSession([]);
  const blocks = [
    { type: 'reasoning', text: 'QueryBoard then ReadArtifact' },
    { type: 'text', text: 'ApplyBatch is in this saved reply.' },
    { type: 'tool-call', id: 'q', name: 'QueryBoard', input: { include: ['nodes'] } },
    { type: 'tool-call', id: 's', name: 'ApplyBatch', input: { operations: [{ op: 'assert_fact', value: 'ApplyAction' }] } },
    { type: 'tool-call', id: 'e', name: 'ApplyAction', input: { action: 'QueryBoard', args: { ref: 'ReadArtifact' } } },
    { type: 'tool-call', id: 'a0', name: 'ReadArtifact', input: { ref: 'exact/ref', maxBytes: 1024 } },
    { type: 'tool-call', id: 'a1', name: 'ReadArtifact', input: { ref: 'exact/ref', offset: 0, maxBytes: 1024 } },
    { type: 'tool-call', id: 'a2', name: 'ReadArtifact', input: { ref: 'exact/ref', offset: 1024 } },
    { type: 'tool-call', id: 'new', name: 'Get', input: { artifact: { ref: 'new/ref' } } },
    { type: 'tool-call', id: 'unknown', name: 'other', input: {} },
  ];
  session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'ReadArtifact' }] } });
  session.append('assistant/message', { turn: 2, step: 3, message: { role: 'assistant', content: blocks } });
  session.append('tool/result', { message: { role: 'tool', toolCallId: 'a2', content: [{ type: 'text', text: raw({ artifact: { text: 'ApplyBatch' } }) }] } });
  const projected = blocks.map(projectToolCall);
  assert.deepEqual(projected.slice(0, 2), blocks.slice(0, 2));
  assert.deepEqual(projected.slice(2, 5), blocks.slice(2, 5).map((block, index) => ({ ...block, name: ['Get', 'Set', 'Execute'][index] })));
  assert.deepEqual(projected.slice(5, 8), [
    { type: 'tool-call', id: 'a0', name: 'Get', input: { artifact: { ref: 'exact/ref' } } },
    { type: 'tool-call', id: 'a1', name: 'Get', input: { artifact: { ref: 'exact/ref', offset: 0 } } },
    { type: 'tool-call', id: 'a2', name: 'Get', input: { artifact: { ref: 'exact/ref', offset: 1024 } } },
  ]);
  assert.deepEqual(projected.slice(8), blocks.slice(8));
});

test('a historical accepted ApplyBatch resets the Set reminder when replayed', () => {
  const session = fakeSession([]);
  for (let index = 0; index < 7; index++) {
    session.append('assistant/message', { message: { role: 'assistant', content: [
      { type: 'tool-call', id: `c${index}`, name: index === 6 ? 'ApplyBatch' : 'QueryBoard', input: {} },
    ] } });
    session.append('tool/result', { message: { role: 'tool', toolCallId: `c${index}`, content: [{ type: 'text', text: raw(answer([])) }] } });
  }
  rewriteSession(session);
  const last = session.deriveEventMessage(session.eventAt(session.surface.nodes.at(-1)));
  assert.ok(!last.content[0].text.includes('Note:'));
  assert.equal(rewriteSession(session), 0);
});

test('the latest result shows the whole Board with + and -, earlier results only their changes', () => {
  const session = fakeSession([raw(answer(['a', 'b'])), raw(answer(['a', 'c']), true), raw(answer(['a', 'c', 'd'], { result: { ok: 1 } }))]);
  assert.equal(rewriteSession(session), 3);
  const [first, second, third] = session.visible();
  // The first Board has nothing before it: every line is new, so history keeps it whole.
  assert.deepEqual(first.split('\n').slice(1), [DELTA_HEAD, '+ position.writes: "open"', '+ facts: {"label":"a"}', '+ facts: {"label":"b"}', '+ operations: []']);
  // A refusal keeps its own text (the dsh error prefix and the answer without the Board) and its change.
  assert.deepEqual(second.split('\n'), ['Error: {"accepted":true}', DELTA_HEAD, '+ facts: {"label":"c"}', '- facts: {"label":"b"}']);
  assert.deepEqual(third.split('\n'), ['{"accepted":true,"result":{"ok":1}}', FULL_HEAD,
    '= position.writes: "open"', '= facts: {"label":"a"}', '= facts: {"label":"c"}', '+ facts: {"label":"d"}', '= operations: []']);
  // The original results stay in the log for the person's transcript.
  assert.equal(session.log.length, 6);
});

test('each step only demotes the previous latest result; a second pass changes nothing', () => {
  const session = fakeSession([raw(answer(['a']))]);
  rewriteSession(session);
  assert.equal(session.visible()[0].split('\n')[1], FULL_FIRST);
  session.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: raw(answer(['a'])) }] } }, { surfaceOp: 'append' });
  assert.equal(rewriteSession(session), 2); // the new result, and the one before it becomes its changes
  assert.deepEqual(session.visible()[1].split('\n').slice(1, 2), [FULL_HEAD]);
  assert.equal(rewriteSession(session), 0);
});

test('a step that changed nothing says so, and history replays to the latest Board', () => {
  const items = [raw(answer(['a'])), raw(answer(['a'])), raw(answer(['b'])), raw(answer(['b', 'b']))].map(classify);
  const texts = plan(items);
  assert.equal(texts[1].split('\n')[1], DELTA_NONE);
  const replayed = new Map();
  for (const text of texts.slice(0, -1)) for (const line of text.split('\n').slice(2)) {
    const key = line.slice(2);
    if (line[0] === '+') replayed.set(key, (replayed.get(key) ?? 0) + 1);
    if (line[0] === '-') replayed.set(key, replayed.get(key) - 1);
  }
  assert.equal(replayed.get('facts: {"label":"b"}'), 1);
  assert.equal(replayed.get('facts: {"label":"a"}'), 0);
  // The duplicate line counts as one more, not as unchanged.
  assert.ok(texts[3].split('\n').includes('+ facts: {"label":"b"}'));
});

test('results without a Board and unreadable text are left alone', () => {
  assert.equal(classify('Error: The connection to Rulith was interrupted during this call; its outcome is unknown.'), null);
  assert.equal(classify(raw({ accepted: true, artifact: { text: 'x' } })), null);
  const session = fakeSession(['plain text', raw({ accepted: true })]);
  assert.equal(rewriteSession(session), 0);
});

// 10-09：Get 的动作行带 description 与 inputSchema，其他结果不带。这是同一个动作的两种渲染，不是板的变化：比较时不看它，
// 显示时照原样。
test('an action row that differs only by description or inputSchema is unchanged; the latest view still shows them', () => {
  const ship = { action: 'ship', status: 'ready' };
  const withActions = (actions, extra = {}) => ({ accepted: true, ...extra, view: { position: { writes: 'open' }, actions }, operations: [] });
  const items = [
    raw(withActions([ship])),
    raw(withActions([{ ...ship, description: 'Ship it', inputSchema: { type: 'object' } }])),
    raw(withActions([ship])),
    raw(withActions([{ ...ship, description: 'Ship it', inputSchema: { type: 'object' } }])),
  ].map(classify);
  const texts = plan(items);
  assert.equal(texts[1].split('\n')[1], DELTA_NONE);
  assert.equal(texts[2].split('\n')[1], DELTA_NONE);
  assert.deepEqual(texts[3].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"',
    '= actions: {"action":"ship","status":"ready","description":"Ship it","inputSchema":{"type":"object"}}', '= operations: []']);
  // A real change of the action is still a change.
  const changed = plan([raw(withActions([ship])), raw(withActions([{ ...ship, status: 'blocked', inputSchema: {} }]))].map(classify));
  assert.ok(changed[1].split('\n').includes('- actions: {"action":"ship","status":"ready"}'));
});

test('results laid out before 10-09 (old headers, two-space unchanged lines) are read and left as they are', () => {
  const oldFull = ['{"accepted":true}', 'Board now (whole Board; + added, - removed since your previous Board):',
    '  position.writes: "open"', '+ facts: {"label":"a"}', '  operations: []'].join('\n');
  const oldDelta = ['{"accepted":true}', 'Board changes at this step (+ added, - removed; the latest result shows the whole Board):',
    '+ position.writes: "open"', '+ operations: []'].join('\n');
  const items = [classify(oldDelta), classify(oldFull)];
  assert.deepEqual(items.map((item) => [item.kind, item.legacy]), [['delta', true], ['full', false]]);
  assert.deepEqual(plan(items), [null, null]);
  // A new result after them: the old whole view is demoted to its changes, and the new one is compared with it.
  const texts = plan([oldDelta, oldFull, raw(answer(['a']))].map(classify));
  assert.equal(texts[0], null);
  assert.deepEqual(texts[1].split('\n').slice(1), [DELTA_HEAD, '+ facts: {"label":"a"}']);
  assert.deepEqual(texts[2].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '= facts: {"label":"a"}', '= operations: []']);
});

// rulith/v4（A 包）：视图按目标改名（goals.directory、goalNodes、taskStatus 以 goal 为键、position.newGoals），
// Get 另带 observation。转录逐键摊平，不认任何段名，所以照样工作；observation 留在第一行。
test('a rulith/v4 answer is laid out the same way: goal directory, goal nodes and taskStatus by goal', () => {
  const v4 = (status, extra = {}) => ({ accepted: true, ...extra,
    view: { position: { writes: 'open', newGoals: 'open' }, goals: { directory: [{ goal: 'g-1', label: 'tests pass', status }], total: 1 },
      goalNodes: [{ goal: 'g-1', met: status === 'completed' }], taskStatus: [{ goal: 'g-1', certified: status === 'completed' }] },
    operations: [] });
  const texts = plan([raw(v4('running', { observation: { consistency: 'committed' } })), raw(v4('completed', { result: { goals: [] } }))].map(classify));
  assert.equal(texts[0].split('\n')[0], '{"accepted":true,"observation":{"consistency":"committed"}}');
  assert.ok(texts[0].split('\n').includes('+ goals.directory: {"goal":"g-1","label":"tests pass","status":"running"}'));
  assert.deepEqual(texts[1].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '= position.newGoals: "open"',
    '+ goals.directory: {"goal":"g-1","label":"tests pass","status":"completed"}', '- goals.directory: {"goal":"g-1","label":"tests pass","status":"running"}',
    '= goals.total: 1', '+ goalNodes: {"goal":"g-1","met":true}', '- goalNodes: {"goal":"g-1","met":false}',
    '+ taskStatus: {"goal":"g-1","certified":true}', '- taskStatus: {"goal":"g-1","certified":false}', '= operations: []']);
});

test('a very long line that is gone is shown by a short identity, and history still replays', () => {
  const big = 'x'.repeat(5000);
  const first = { ...answer(['a']), operations: [{ tool: 'Execute', result: { teaching: big } }] };
  const second = { ...answer(['a']), operations: [{ tool: 'Execute', state: 'done' }] };
  const texts = plan([raw(first), raw(second)].map(classify));
  const gone = texts[1].split('\n').filter((line) => line.startsWith('- operations:'));
  assert.equal(gone.length, 1);
  assert.match(gone[0], /^- operations: #[0-9a-f]{16} \(\d+ characters\)$/);
  assert.ok(!texts[1].includes(big));
  // The rewritten texts replay to the same result: a second pass over them changes nothing.
  const again = plan(texts.map((text, index) => classify(texts[index] ?? text)));
  assert.ok(again.every((text) => text === null));
});

// 2026-10-14 结果头读起来自然：本身是一行 JSON 的字符串解开成嵌套的值；多行或很长的字符串作为带字段路径的文本块接在第一行之后。
// 只是展示：结果头在第一次进入转录时定下，之后逐字沿用。
test('a nested JSON string is shown as a value, and multi-line text as a labelled block after line 1', () => {
  const worker = { rows: [{ exit_code: 1, gen: 45 }],
    head: "node:internal/modules/cjs/loader:1424\r\n  throw err;\r\n  ^\r\n\r\nError: Cannot find module 'D:\\Work\\game-demo\\test.mjs'\r\n",
    tail: 'last line\n' };
  const answer = { accepted: true, result: { action: 'eng.test', ok: true, result: JSON.stringify(worker) }, view: { position: { writes: 'open' } }, operations: [] };
  const [text] = plan([classify(raw(answer))]);
  const lines = text.split('\n');
  assert.equal(lines[0], '{"accepted":true,"result":{"action":"eng.test","ok":true,"result":{"rows":[{"exit_code":1,"gen":45}],"head":"<text 1>","tail":"<text 2>"}}}');
  assert.deepEqual(lines.slice(1, 11), [
    '<text 1> result.result.head (6 lines, CRLF line endings):',
    'node:internal/modules/cjs/loader:1424', '  throw err;', '  ^', '', "Error: Cannot find module 'D:\\Work\\game-demo\\test.mjs'", '',
    '<text 2> result.result.tail (2 lines):', 'last line', '',
  ]);
  assert.equal(lines[11], FULL_FIRST);
  assert.ok(!lines[0].includes('\\'), 'no escaped JSON inside line 1');
  // Read back as it is: a second pass changes nothing, and the text block is not taken for Board rows.
  assert.deepEqual(plan([classify(text)]), [null]);
  assert.deepEqual(classify(text).rows, [{ mark: '+', line: 'position.writes: "open"' }, { mark: '+', line: 'operations: []' }]);
});

test('only exact one-line JSON is decoded; other strings stay as they are or become text blocks', () => {
  const answer = { accepted: true, result: {
    spaced: '{"a": 1}', // re-encoding would change it: kept as a string
    file: '{\n  "name": "game"\n}\n', // JSON file text keeps its own layout
    long: 'x'.repeat(401), short: 'y'.repeat(400), nested: '[1,{"b":"c"}]', number: '42',
  }, view: { position: {} }, operations: [] };
  const [text] = plan([classify(raw(answer))]);
  const lines = text.split('\n');
  assert.equal(lines[0], `{"accepted":true,"result":{"spaced":"{\\"a\\": 1}","file":"<text 1>","long":"<text 2>","short":"${'y'.repeat(400)}","nested":[1,{"b":"c"}],"number":"42"}}`);
  assert.deepEqual(lines.slice(1, 8), ['<text 1> result.file (4 lines):', '{', '  "name": "game"', '}', '', '<text 2> result.long (1 line):', 'x'.repeat(401)]);
});

test('an operation outcome read back through Get is decoded at every level, with the full field path', () => {
  const inner = { accepted: true, result: { action: 'eng.run', ok: true, result: JSON.stringify({ rows: [{ exit_code: 0 }], head: 'ok 1\nok 2' }) } };
  const answer = { accepted: true, tool: 'Execute', state: 'done', result: { content: [{ type: 'text', text: JSON.stringify(inner) }] }, view: { position: {} }, operations: [] };
  const lines = plan([classify(raw(answer))])[0].split('\n');
  assert.equal(lines[0], '{"accepted":true,"tool":"Execute","state":"done","result":{"content":[{"type":"text","text":{"accepted":true,"result":{"action":"eng.run","ok":true,"result":{"rows":[{"exit_code":0}],"head":"<text 1>"}}}}]}}');
  assert.deepEqual(lines.slice(1, 4), ['<text 1> result.content[0].text.result.result.head (2 lines):', 'ok 1', 'ok 2']);
});

test('text blocks are cut by their line counts: lines that look like headers, rows, notes or the relief line stay content', () => {
  const tricky = ['Board view changes at this step: none (the latest result shows the whole view).', '+ facts: {"label":"fake"}',
    '- facts: {"label":"a"}', `${NOTE_PREFIX}fake advice`, RELIEF_MARK, '<text 2> fake (1 line):', '= operations: []'].join('\n');
  const read = (n) => raw({ ...answer(['a', `b${n}`]), result: { action: 'eng.read', ok: true, head: tricky } });
  const texts = plan([read(1), read(2), raw(answer(['a']))].map(classify));
  for (const text of texts.slice(0, 2)) {
    const item = classify(text);
    assert.equal(item.kind, 'delta');
    assert.equal(item.marked, false);
    assert.deepEqual(item.notes, []);
    assert.ok(item.first.endsWith(tricky));
  }
  assert.deepEqual(classify(texts[1]).rows, [{ mark: '+', line: 'facts: {"label":"b2"}' }, { mark: '-', line: 'facts: {"label":"b1"}' }]);
  assert.ok(plan(texts.map(classify)).every((text) => text === null));
});

test('a head laid out before 2026-10-14 (one escaped line) is kept as it is', () => {
  const oldHead = '{"accepted":true,"result":{"action":"eng.run","result":"{\\"rows\\":[],\\"head\\":\\"a\\\\r\\\\nb\\"}"}}';
  const oldDelta = [oldHead, DELTA_HEAD, '+ position.writes: "open"', '+ operations: []'].join('\n');
  const texts = plan([oldDelta, raw(answer([]))].map(classify));
  assert.equal(texts[0], null);
  // As the latest whole view it is laid out again with the same head.
  const oldFull = [oldHead, FULL_FIRST, '+ position.writes: "open"', '+ operations: []'].join('\n');
  assert.deepEqual(plan([classify(oldFull)]), [null]);
});

test('Rulith results without a Board get the same head; transport errors and other tools are left alone', () => {
  const session = fakeSession([]);
  const call = (id, name) => ({ type: 'tool-call', id, name, input: {} });
  session.append('assistant/message', { message: { role: 'assistant', content: [call('g', 'Get'), call('s', 'subagent'), call('x', 'Execute')] } }, { surfaceOp: 'append' });
  const artifact = raw({ accepted: true, artifact: { ref: 'r/1', text: 'line 1\nline 2' } });
  const sub = JSON.stringify({ content: [{ type: 'text', text: '{"note":"a\\nb"}' }] });
  const broken = 'Error: The connection to Rulith was interrupted during this call; its outcome is unknown.';
  for (const [id, text] of [['g', artifact], ['s', sub], ['x', broken]])
    session.append('tool/result', { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
  assert.equal(rewriteSession(session), 1);
  const visible = session.surface.nodes.map((seq) => session.log[seq]).filter((event) => event.type === 'tool/result').map((event) => event.data.message.content[0].text);
  assert.equal(visible[0], '{"accepted":true,"artifact":{"ref":"r/1","text":"<text 1>"}}\n<text 1> artifact.text (2 lines):\nline 1\nline 2');
  assert.equal(visible[1], sub);
  assert.equal(visible[2], broken);
  assert.equal(rewriteSession(session), 0);
});

test('a literal "<text N>" value is shown as a text block, so every <text N> in line 1 is a reference', () => {
  const lines = plan([classify(raw({ accepted: true, result: { note: '<text 1>', other: '<text>' }, view: { position: {} }, operations: [] }))])[0].split('\n');
  assert.equal(lines[0], '{"accepted":true,"result":{"note":"<text 1>","other":"<text>"}}');
  assert.deepEqual(lines.slice(1, 3), ['<text 1> result.note (1 line):', '<text 1>']);
});

test("the answer's own top-level fields are not decoded, so relief keeps only the platform's outcome fields", () => {
  const worker = JSON.stringify({ action: 'from worker', ok: false, status: 'worker status' });
  const head = classify(raw({ accepted: true, result: worker, teaching: 't'.repeat(2000), view: { position: {} }, operations: [] })).first;
  assert.equal(head.split('\n')[0], JSON.stringify({ accepted: true, result: worker, teaching: '<text 1>' }));
  assert.deepEqual(JSON.parse(clearFirst(head)), { accepted: true, cleared: `${head.length} characters of this earlier result were cleared to save context; the Board holds the state` });
  // A relieved head keeps no field that points at a text block it no longer has.
  const multi = classify(raw({ accepted: true, result: { action: 'eng.run', ok: true, status: 'line 1\nline 2', output: 'o'.repeat(3000) }, view: { position: {} }, operations: [] })).first;
  assert.match(multi.split('\n')[0], /"status":"<text 1>","output":"<text 2>"/);
  assert.deepEqual(JSON.parse(clearFirst(multi)).result, { action: 'eng.run', ok: true });
});

// D 项（2026-10-14）：视图按设计带不同的段。没带的段是“没带”，不是“消失”：每一段与最近一份带它的视图比较。
const scoped = (facts, extra = {}) => ({ accepted: true, ...extra,
  view: { position: { writes: 'open' }, actions: [{ action: 'eng.read', status: 'ready' }], facts: facts.map((label) => ({ label })), gaps: [{ gap: 'g' }] },
  operations: [] });
const plainView = (extra = {}) => ({ accepted: true, ...extra, view: { position: { writes: 'open' }, actions: [{ action: 'eng.read', status: 'ready' }], goalTypes: [] }, operations: [] });
const ABSENT = 'Not in this view (read with Get to see them): ';

test('alternating section sets give no false removals: a part not included is named, not listed as gone', () => {
  const texts = plan([scoped(['a', 'b']), plainView(), scoped(['a', 'b']), plainView(), scoped(['a', 'b'])].map((answer) => raw(answer)).map(classify));
  // The default view does not include facts and gaps: no "- facts" lines, one line naming what it left out.
  assert.deepEqual(texts[1].split('\n').slice(1), [DELTA_HEAD, `${ABSENT}facts, gaps`, '+ goalTypes: []']);
  // The scoped view again: facts and gaps are compared with their last appearance, so nothing changed in them. goalTypes
  // is not chosen by include, so its absence is a change like any other.
  assert.deepEqual(texts[2].split('\n').slice(1), [DELTA_HEAD, '- goalTypes: []']);
  assert.deepEqual(texts[3].split('\n').slice(1), [DELTA_HEAD, `${ABSENT}facts, gaps`, '+ goalTypes: []']);
  // The latest whole view marks its parts against their last appearance as well.
  assert.deepEqual(texts[4].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"',
    '= actions: {"action":"eng.read","status":"ready"}', '= facts: {"label":"a"}', '= facts: {"label":"b"}', '= gaps: {"gap":"g"}', '= operations: []',
    '- goalTypes: []']);
  assert.ok(texts.every((text) => !/^- (facts|gaps): /m.test(text)));
  // Read back, nothing changes; laid out step by step, the result is the same.
  assert.ok(plan(texts.map(classify)).every((text) => text === null));
});

test('a section that reappears is compared with its last appearance', () => {
  const texts = plan([scoped(['a', 'b']), plainView(), scoped(['a', 'c']), raw(plainView())].map((answer) => (typeof answer === 'string' ? answer : raw(answer))).map(classify));
  assert.deepEqual(texts[2].split('\n').slice(1), [DELTA_HEAD, '+ facts: {"label":"c"}', '- facts: {"label":"b"}', '- goalTypes: []']);
  // A section that a later view empties is still compared: an empty list is a change, not an absence.
  const emptied = plan([scoped(['a']), scoped([])].map((answer) => raw(answer)).map(classify));
  assert.deepEqual(emptied[1].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '= actions: {"action":"eng.read","status":"ready"}',
    '+ facts: []', '- facts: {"label":"a"}', '= gaps: {"gap":"g"}', '= operations: []']);
});

test('a result is laid out when it enters and when it is demoted, then kept: no second rewrite one step later', () => {
  // Before 10-14 a demoted result was laid out again from the rebuilt Board on the next pass, and a removal in a later
  // section could move ahead of a change in an earlier one: one more rewrite of the same result, one step late.
  const view = (step, facts) => ({ accepted: true, view: { position: { writes: 'open', step }, facts: facts.map((label) => ({ label })) }, operations: [] });
  const session = fakeSession([]);
  const add = (answer) => session.append('tool/result', { message: { role: 'tool', toolCallId: `c${session.log.length}`, content: [{ type: 'text', text: raw(answer) }] } }, { surfaceOp: 'append' });
  add(view(1, ['a', 'old'])); rewriteSession(session);
  add(view(2, ['a'])); rewriteSession(session);
  const demoted = session.visible()[1];
  assert.deepEqual(demoted.split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '+ position.step: 2', '- position.step: 1', '= facts: {"label":"a"}', '- facts: {"label":"old"}', '= operations: []']);
  add(view(3, ['a'])); rewriteSession(session);
  const changes = session.visible()[1];
  assert.deepEqual(changes.split('\n').slice(1), [DELTA_HEAD, '+ position.step: 2', '- position.step: 1', '- facts: {"label":"old"}']);
  add(view(4, ['a']));
  assert.equal(rewriteSession(session), 2, 'only the new result and the one it demotes');
  assert.equal(session.visible()[1], changes);
});

test('results laid out by whole-view comparison (10-09 to 10-14) are read that way and kept', () => {
  // As the old layout showed a default view after a scoped one: every fact "gone", then "new" again.
  const legacy = [
    ['{"accepted":true}', 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):',
      '+ position.writes: "open"', '+ facts: {"label":"a"}', '+ operations: []'].join('\n'),
    ['{"accepted":true}', 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):',
      '+ goalTypes: []', '- facts: {"label":"a"}'].join('\n'),
    ['{"accepted":true}', 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):',
      '+ facts: {"label":"a"}', '- goalTypes: []'].join('\n'),
  ];
  const next = raw({ accepted: true, view: { position: { writes: 'open' }, facts: [{ label: 'a' }, { label: 'b' }] }, operations: [] });
  const texts = plan([...legacy, next].map(classify));
  assert.deepEqual(texts.slice(0, 3), [null, null, null]);
  // The Board as the old layout implied it: facts [a] and no goalTypes in the last view.
  assert.deepEqual(texts[3].split('\n').slice(1), [FULL_HEAD, '= position.writes: "open"', '= facts: {"label":"a"}', '+ facts: {"label":"b"}', '= operations: []']);
});

// 审查 e83bd1d 的 P2-1：只有 include 决定的组（nodes 组、gaps 组）整组不在才算没带；其余键在同一种视图里出现或消失，照常比较。
test('a key that disappears outside the include groups is a real removal', () => {
  const read = (facts, extra = {}) => ({ accepted: true, view: { position: { writes: 'open' }, facts: facts.map((label) => ({ label })), total: facts.length, ...extra }, operations: [] });
  const rows = (text) => text.split('\n').slice(1);
  // A truncation flag of the nodes group that goes away while the group stays.
  let texts = plan([read(['a', 'b'], { truncated: true }), read(['a'])].map((answer) => raw(answer)).map(classify));
  assert.deepEqual(rows(texts[1]), [FULL_HEAD, '= position.writes: "open"', '= facts: {"label":"a"}', '- facts: {"label":"b"}', '+ total: 1', '- total: 2',
    '= operations: []', '- truncated: true']);
  // An unreadable position, then a normal view: unavailable is compared like any key, and never named as not included.
  const normal = { accepted: true, view: { position: { writes: 'open' }, actions: [{ action: 'x' }] }, operations: [] };
  const unavailable = { accepted: true, view: { unavailable: true }, operations: [] };
  texts = plan([normal, unavailable, normal].map((answer) => raw(answer)).map(classify));
  assert.deepEqual(rows(texts[1]), [DELTA_HEAD, '+ unavailable: true', '- actions: {"action":"x"}', '- position.writes: "open"']);
  assert.deepEqual(rows(texts[2]), [FULL_HEAD, '+ position.writes: "open"', '+ actions: {"action":"x"}', '= operations: []', '- unavailable: true']);
  assert.ok(texts.every((text) => !text.includes(ABSENT)));
  // taskStatus gone with an empty focus, and actions omitted when there are none.
  const plainOf = (extra) => ({ accepted: true, view: { position: { writes: 'open' }, ...extra }, operations: [] });
  texts = plan([plainOf({ actions: [{ action: 'x' }], taskStatus: [{ goal: 'g1', status: 'open' }] }), plainOf({})].map((answer) => raw(answer)).map(classify));
  assert.deepEqual(rows(texts[1]), [FULL_HEAD, '= position.writes: "open"', '= operations: []', '- actions: {"action":"x"}', '- taskStatus: {"goal":"g1","status":"open"}']);
});

test('the gaps group keeps its companion flags; a group counts as not included only when it is absent as a whole', () => {
  const view = (extra) => ({ accepted: true, view: { position: { writes: 'open' }, ...extra }, operations: [] });
  const texts = plan([
    view({ gaps: [{ gap: 'a' }], gapsTruncated: true, gapsTotal: 30 }),
    view({ gaps: [{ gap: 'a' }] }), // flags gone while gaps stays: real removals
    view({}), // gaps not included at all
    view({ total: 3 }), // part of the nodes group present: compared, and the group is not named as absent
  ].map((answer) => raw(answer)).map(classify));
  const rows = (text) => text.split('\n').slice(1);
  assert.deepEqual(rows(texts[1]), [DELTA_HEAD, '- gapsTotal: 30', '- gapsTruncated: true']);
  assert.deepEqual(rows(texts[2]), [DELTA_NONE, `${ABSENT}gaps`]);
  assert.deepEqual(rows(texts[3]), [FULL_HEAD, `${ABSENT}gaps`, '= position.writes: "open"', '+ total: 3', '= operations: []']);
  // Read back, the layout is stable.
  assert.ok(plan(texts.map(classify)).every((text) => text === null));
});
