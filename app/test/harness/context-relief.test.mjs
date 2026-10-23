import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, clearFirst, identity, plan, rewriteSession as rewrite, latestPromptTokens, reliefBoundary, sessionLines, KEEP,
  CLEAR_AT_LEAST, CLEAR_FIRST_LINE, CHARS_PER_TOKEN, FULL_HEAD, DELTA_HEAD } from '../../harness/web/board-transcript.mjs';
import { RELIEF_MARK, RELIEF_RATIO, RELIEF_MARGIN, contextLinesFor } from '../../harness/web/context-relief.mjs';
import { contextEnv } from '../../harness/web/launcher-settings.mjs';
import { trimOutgoing, clearedArgument } from '../../harness/web/outgoing-trim.mjs';

// 2026-10-14 上下文减负：低于减负线什么旧的都不改；到了减负线（最近一次请求的真实提示 ≥ reliefRatio × 窗口）一批减负，
// 只在估计能省够 CLEAR_AT_LEAST 时才做；边界写成结果末尾的标记，发出副本时的参数缩短读同一个标记。

const raw = (answer, isError = false) =>
  (isError ? 'Error: ' : '') + JSON.stringify({ isError, content: [{ type: 'text', text: JSON.stringify(answer) }] });

// 一步 Execute 的回答：结果行很长（命令输出），板上加一条事实、位置变化，操作栏换上一条带整份结果的长行。每第 4 步是一次拒绝。
const refused = (i) => i % 4 === 3;
function stepAnswer(i, size = 400) {
  return {
    accepted: !refused(i), tool: 'Execute', requestExecuted: !refused(i),
    ...(refused(i) ? { errorCode: 'precondition_failed', teaching: `teaching ${i} `.repeat(300) } : {}),
    result: { action: 'eng.run_command', ok: !refused(i), status: refused(i) ? 'refused' : 'done', output: `output ${i} `.repeat(size) },
    view: {
      position: { writes: 'open', step: i },
      facts: Array.from({ length: 3 + i }, (_, k) => ({ label: `fact ${k}` })),
      actions: [{ action: 'eng.run_command', status: 'ready', description: 'Run a command', inputSchema: { type: 'object', note: 'n'.repeat(2500) } }],
    },
    operations: [{ tool: 'Execute', step: i, result: { output: `operation ${i} `.repeat(size) } }],
  };
}
const history = (n) => Array.from({ length: n }, (_, i) => raw(stepAnswer(i), refused(i)));
const rowsOf = (text) => text.split('\n').slice(2).filter((line) => /^[=+-] /.test(line));
const SHORT = /^[^:]*: #[0-9a-f]{16} \(\d+ characters\)$/;
// The routed window and output cap of these sessions, and the compaction config the launcher gives dsh by default: the
// relief line is then 0.7 of the window (the real compaction line, 0.8, is more than one step further).
const WINDOW = 262_144;
const MAX_TOKENS = 32_768;
const COMPACTION = JSON.parse(contextEnv({ reliefRatio: 0.7, compactionRatio: 0.8 }).RULITH_DSH_COMPACTION);
const TRIGGER = Math.floor(RELIEF_RATIO * WINDOW);
const rewriteSession = (session, options = {}) => rewrite(session, { compaction: COMPACTION, ...options });

// Enough of a dsh session for the rewrite: the event log, the model-visible surface, dsh's replace records, the latest
// request context (the routed window) and the recorded usage of each model reply.
function fakeSession() {
  const log = [];
  const surface = { nodes: [] };
  const append = (type, data, opts = {}) => {
    const event = { type, seq: log.length, data, ...opts };
    log.push(event);
    const op = opts.surfaceOp;
    if (op && op !== 'append') {
      const start = surface.nodes.indexOf(op.startSeq), end = surface.nodes.indexOf(op.endSeq);
      surface.nodes.splice(start, end - start + 1, event.seq);
    } else if (op === 'append') surface.nodes.push(event.seq);
    return event;
  };
  let calls = 0;
  const session = {
    log, surface, append,
    get seq() { return log.length; },
    eventAt: (seq) => log[seq],
    deriveEventMessage: (event) => event.data.message ?? null,
    requestContext: () => ({ provider: 'p', model: 'm', contextWindow: session.window ?? WINDOW }),
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: MAX_TOKENS } }),
    // One model reply with its recorded prompt size, and its tool calls.
    reply(prompt, calls_ = [{ name: 'Execute', args: {} }]) {
      const blocks = calls_.map(({ name, args }) => ({ type: 'tool-call', id: `c${++calls}`, name, arguments: JSON.stringify(args) }));
      append('assistant/message', { message: { role: 'assistant', content: blocks }, usage: { inputTokens: prompt - 1000, cacheReadTokens: 1000 } }, { surfaceOp: 'append' });
      return blocks.map((block) => block.id);
    },
    result(callId, text) {
      append('tool/result', { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
    },
    visible: () => surface.nodes.map((seq) => log[seq]).filter((event) => event.type === 'tool/result').map((event) => event.data.message.content[0].text),
    messages: () => surface.nodes.map((seq) => log[seq].data.message),
  };
  return session;
}

/** One agent step: the model's reply (recorded prompt size), its tool result, then the pre-step rewrite. */
function step(session, prompt, text, options = {}) {
  const [id] = session.reply(prompt);
  session.result(id, text);
  return rewriteSession(session, options);
}

test('results up to the boundary are relieved; later ones and the latest view are shown as they were', () => {
  const items = () => history(10).map(classify);
  const boundary = 3;
  const texts = plan(items(), { boundary });
  const plain = plan(items(), { boundary: -1 });
  for (let i = 0; i < 10; i++) {
    const [first] = texts[i].split('\n');
    const isError = first.startsWith('Error: ');
    assert.equal(isError, refused(i));
    const rest = JSON.parse(isError ? first.slice('Error: '.length) : first);
    if (i <= boundary) {
      // A compact JSON that still parses: the outcome fields stay, the long output and teaching are gone.
      assert.ok(first.length <= CLEAR_FIRST_LINE);
      assert.equal(rest.accepted, !refused(i));
      assert.equal(rest.tool, 'Execute');
      assert.equal(rest.requestExecuted, !refused(i));
      assert.deepEqual(rest.result, { action: 'eng.run_command', ok: !refused(i), status: refused(i) ? 'refused' : 'done' });
      if (refused(i)) assert.equal(rest.errorCode, 'precondition_failed');
      assert.ok(!('teaching' in rest) && !('output' in rest.result));
      assert.match(rest.cleared, /^\d+ characters of this earlier result were cleared to save context; the Board holds the state$/);
      // The new long operations line is shown by its short identity, like the gone one.
      const added = rowsOf(texts[i]).filter((line) => line.startsWith('+ operations:'));
      assert.equal(added.length, 1);
      assert.match(added[0].slice(2), SHORT);
      assert.ok(rowsOf(texts[i]).every((line) => line.length <= 2002));
      // Only the boundary result carries the relief line, as its last line.
      assert.equal(texts[i].endsWith(`\n${RELIEF_MARK}`), i === boundary);
    } else {
      assert.equal(texts[i], plain[i]);
      // The long output (and a refusal's long teaching before it) is a text block after line 1.
      const n = refused(i) ? 2 : 1;
      assert.equal(rest.result.output, `<text ${n}>`);
      const lines = texts[i].split('\n');
      const label = lines.indexOf(`<text ${n}> result.output (1 line):`);
      assert.ok(label > 0 && lines[label + 1].startsWith(`output ${i} output ${i}`));
    }
  }
  // The latest whole view keeps complete raw lines.
  const latest = texts[9].split('\n');
  assert.equal(latest[3], FULL_HEAD); // line 1, then the output's text block (label and one line)
  assert.ok(latest.some((line) => line.startsWith('+ operations: {"tool":"Execute","step":9')));
  assert.ok(latest.some((line) => line.includes('"inputSchema"')));
});

test('relief changes what is shown, never what changed: every step marks the same identities as without relief', () => {
  const items = () => history(30).map(classify);
  const relieved = plan(items(), { boundary: 23 });
  const plain = plan(items(), { boundary: -1 });
  const marks = (text) => rowsOf(text).map((line) => `${line[0]} ${identity(line.slice(2))}`);
  relieved.forEach((text, i) => assert.deepEqual(marks(text), marks(plain[i]), `step ${i}`));
  assert.equal(relieved.at(-1), plain.at(-1));
  // Rebuilding from the rewritten texts gives the same texts again: the boundary is read back from its mark.
  const replayed = plan(relieved.map(classify));
  assert.ok(replayed.every((text) => text === null));
  const total = (texts) => texts.reduce((n, text) => n + text.length, 0);
  assert.ok(total(relieved) < total(plain) / 2);
});

test('below the relief line nothing earlier is rewritten: each step only demotes the previous latest view', () => {
  const session = fakeSession();
  let before = [];
  history(24).forEach((text, i) => {
    const rewritten = step(session, TRIGGER - 1, text);
    const now = session.visible();
    // The new result is laid out and the previous latest becomes its changes; everything older is byte-identical.
    assert.equal(rewritten, i === 0 ? 1 : 2);
    assert.deepEqual(now.slice(0, -2), before.slice(0, -1));
    before = now;
  });
  assert.ok(session.visible().every((text) => !text.includes(RELIEF_MARK) && !text.split('\n')[0].includes('"cleared"')));
  // Below the line the step-by-step result is the same as one pass over the whole history.
  const once = fakeSession();
  for (const text of history(24)) { const [id] = once.reply(TRIGGER - 1); once.result(id, text); }
  rewriteSession(once);
  assert.deepEqual(once.visible(), session.visible());
});

test('at the relief line one batch relieves everything older than the latest six; nothing older changes until the next batch', () => {
  const session = fakeSession();
  const texts = history(30);
  for (const text of texts.slice(0, 20)) step(session, TRIGGER - 1, text);
  const below = session.visible();
  const batches = [];
  const onBatch = (info) => batches.push(info);
  // The request that produced this reply was at the line: one batch.
  step(session, TRIGGER, texts[20], { onBatch });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].prompt, TRIGGER);
  assert.ok(batches[0].freedTokens >= CLEAR_AT_LEAST);
  const after = session.visible();
  // Results 0..14 have six or more newer tool results: relieved; the boundary (14) carries the mark; 15..19 are as before.
  const boundary = 20 - KEEP;
  for (let i = 0; i < 21; i++) {
    if (i <= boundary) {
      assert.ok(after[i].split('\n')[0].includes('"cleared"'), `result ${i} relieved`);
      assert.equal(after[i].endsWith(`\n${RELIEF_MARK}`), i === boundary);
    } else if (i < 19) assert.equal(after[i], below[i], `result ${i} untouched`);
  }
  assert.equal(reliefBoundary(session.messages()), session.messages().findIndex((m) => m.role === 'tool' && m.content[0].text.endsWith(RELIEF_MARK)));
  // Still above the line, but the next results would free too little: only the demotion happens, old bytes stay.
  for (const text of texts.slice(21, 24)) {
    const previous = session.visible();
    assert.equal(step(session, TRIGGER + 5000, text, { onBatch }), 2);
    assert.deepEqual(session.visible().slice(0, -2), previous.slice(0, -1));
  }
  assert.equal(batches.length, 1);
});

test('no batch when it would free less than CLEAR_AT_LEAST; exactly enough makes one', () => {
  const build = () => {
    const session = fakeSession();
    for (const text of history(12)) step(session, TRIGGER - 1, text);
    const [id] = session.reply(TRIGGER);
    session.result(id, raw(stepAnswer(12)));
    return session;
  };
  // A dry run finds what this batch would free.
  let freed = null;
  rewriteSession(build(), { clearAtLeast: 0, onBatch: (info) => { freed = info.freedTokens; } });
  assert.ok(freed > 0);
  const short = build();
  const before = short.visible();
  rewriteSession(short, { clearAtLeast: freed + 1 });
  assert.deepEqual(short.visible().slice(0, -2), before.slice(0, -2));
  assert.ok(short.visible().every((text) => !text.endsWith(RELIEF_MARK)));
  const enough = build();
  rewriteSession(enough, { clearAtLeast: freed });
  assert.equal(enough.visible().filter((text) => text.endsWith(`\n${RELIEF_MARK}`)).length, 1);
  // The estimate counts characters at CHARS_PER_TOKEN per token.
  assert.equal(CHARS_PER_TOKEN, 3);
});

test('long arguments of earlier calls count toward the batch and are shortened only before the mark', () => {
  const session = fakeSession();
  // Small results (nothing to clear in them) after calls that wrote whole files.
  const small = (i) => raw({ accepted: true, tool: 'Execute', result: { action: 'eng.write_file', ok: true }, view: { position: { step: i } }, operations: [] });
  const file = (i) => `${i}:`.padEnd(30_000, String(i));
  for (let i = 0; i < 9; i++) {
    const [id] = session.reply(i === 8 ? TRIGGER : 1000, [{ name: 'Execute', args: { action: 'eng.write_file', args: { path: `f${i}.js`, text: file(i) } } }]);
    session.result(id, small(i));
    rewriteSession(session);
  }
  // At the line: results 0..2 are older than the latest six; their calls' texts (3 × 30000 characters) free enough.
  const visible = session.visible();
  assert.equal(visible.findIndex((text) => text.endsWith(`\n${RELIEF_MARK}`)), 2);
  const out = trimOutgoing(session.messages());
  const sent = out.filter((m) => m.role === 'assistant').map((m) => JSON.parse(m.content[0].arguments).args.text);
  sent.forEach((text, i) => assert.equal(text, i <= 2 ? clearedArgument(file(i)) : file(i), `call ${i}`));
});

test('the decision is a function of the record: replaying the log gives the same bytes and no further rewrite', () => {
  const session = fakeSession();
  const texts = history(40);
  texts.forEach((text, i) => step(session, i >= 20 ? TRIGGER + 1000 * i : TRIGGER - 1, text));
  const marks = session.visible().filter((text) => text.endsWith(`\n${RELIEF_MARK}`)).length;
  assert.ok(marks >= 2, 'a second batch once enough had accumulated again');
  // Restart: a new session folded from the same log events (originals and replace records alike).
  const replay = fakeSession();
  for (const event of session.log) {
    const { type, seq: _seq, data, ...opts } = event;
    replay.append(type, data, opts);
  }
  assert.deepEqual(replay.visible(), session.visible());
  assert.equal(rewriteSession(replay), 0);
  assert.equal(rewriteSession(session), 0);
  // The person's transcript keeps every original result.
  assert.deepEqual(session.log.filter((event) => event.type === 'tool/result' && event.surfaceOp === 'append').map((event) => event.data.message.content[0].text), texts);
});

test('after a dsh compaction: the stale prompt size does not trigger, and the boundary is whatever mark is left', () => {
  const session = fakeSession();
  const texts = history(34);
  texts.slice(0, 21).forEach((text, i) => step(session, i === 20 ? TRIGGER : TRIGGER - 1, text));
  const markedSeq = () => session.surface.nodes.find((seq) => session.log[seq].type === 'tool/result' && session.log[seq].data.message.content[0].text.endsWith(RELIEF_MARK));
  assert.notEqual(markedSeq(), undefined);
  // dsh compacts from the first node through the marked result: the summary replaces that span.
  const compact = (endSeq) => {
    session.append('compaction/summary', { summary: 'recap' });
    session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint' } } },
      { surfaceOp: { op: 'replace', startSeq: session.surface.nodes[0], endSeq } });
  };
  compact(markedSeq());
  // The latest recorded size predates the compaction: unknown, so no batch even though it was at the line.
  assert.equal(latestPromptTokens(session), null);
  const before = session.visible();
  assert.ok(rewriteSession(session) <= before.length);
  assert.ok(session.visible().every((text) => !text.endsWith(RELIEF_MARK)));
  assert.equal(reliefBoundary(session.messages()), -1, 'nothing older than the old boundary is left');
  // The next request reports a size again; a later batch works on what is left.
  texts.slice(21).forEach((text) => step(session, TRIGGER + 2000, text));
  assert.ok(session.visible().filter((text) => text.endsWith(`\n${RELIEF_MARK}`)).length >= 1);
  assert.ok(latestPromptTokens(session) >= TRIGGER);
});

test('a compaction that keeps the marked result keeps the boundary', () => {
  const session = fakeSession();
  history(24).forEach((text, i) => step(session, i === 20 ? TRIGGER : TRIGGER - 1, text));
  const marked = session.surface.nodes.findIndex((seq) => session.log[seq].type === 'tool/result' && session.log[seq].data.message.content[0].text.endsWith(RELIEF_MARK));
  session.append('compaction/summary', { summary: 'recap' });
  session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint' } } },
    { surfaceOp: { op: 'replace', startSeq: session.surface.nodes[0], endSeq: session.surface.nodes[marked - 4] } });
  rewriteSession(session);
  const visible = session.visible();
  assert.equal(visible.filter((text) => text.endsWith(`\n${RELIEF_MARK}`)).length, 1);
  assert.ok(reliefBoundary(session.messages()) > 0);
});

test('tool results without a Board count toward the six', () => {
  const board = raw(stepAnswer(0, 2000));
  const artifact = raw({ accepted: true, artifact: { text: 'x' } });
  const firstLine = (between) => {
    const session = fakeSession();
    session.result(session.reply(1000)[0], board);
    for (let i = 0; i < between; i++) session.result(session.reply(1000, [{ name: 'Get', args: { artifact: { ref: 'r' } } }])[0], artifact);
    session.result(session.reply(TRIGGER)[0], raw(stepAnswer(1)));
    rewriteSession(session, { clearAtLeast: 0 });
    return session.visible()[0].split('\n')[0];
  };
  // With four Get-artifact reads and one Board result after it, five results are newer: still recent.
  assert.ok(!firstLine(4).includes('"cleared"'));
  // With five reads, six results are newer: the first one is relieved, though only one Board result follows it.
  assert.ok(firstLine(5).includes('"cleared"'));
});

test('a short, unreadable or already cleared result line is left as it is', () => {
  assert.equal(clearFirst('{"accepted":true}'), '{"accepted":true}');
  const unreadable = `{"accepted":true,${'x'.repeat(2000)}`;
  assert.equal(clearFirst(unreadable), unreadable);
  const long = JSON.stringify({ accepted: false, errorCode: 'e', result: { status: { detail: 'd'.repeat(300) }, action: 'a' }, teaching: 't'.repeat(2000) });
  const cleared = clearFirst(`Error: ${long}`);
  assert.ok(cleared.startsWith('Error: {'));
  // A kept field must be short: a long status is cleared with the rest.
  assert.deepEqual(JSON.parse(cleared.slice('Error: '.length)), { accepted: false, errorCode: 'e', result: { action: 'a' },
    cleared: `${long.length} characters of this earlier result were cleared to save context; the Board holds the state` });
  assert.equal(clearFirst(cleared), cleared);
  const padded = JSON.stringify({ accepted: true, cleared: 'earlier', pad: 'p'.repeat(2000) });
  assert.equal(clearFirst(padded), padded);
  // A head with text blocks counts them too, and loses them when cleared.
  const head = `{"accepted":true,"result":{"action":"eng.read","ok":true,"head":"<text 1>"}}\n<text 1> result.head (2 lines):\n${'a'.repeat(1000)}\n${'b'.repeat(1000)}`;
  assert.deepEqual(JSON.parse(clearFirst(head)), { accepted: true, result: { action: 'eng.read', ok: true },
    cleared: `${head.length} characters of this earlier result were cleared to save context; the Board holds the state` });
});

test('sessions relieved by the old sliding window stay as they are and carry no boundary', () => {
  // Texts as the 10-14 morning window left them: cleared line 1, short identities, no mark.
  const items = history(12).map(classify);
  const old = plan(items, { boundary: 4 }).map((text) => text.replace(`\n${RELIEF_MARK}`, ''));
  const session = fakeSession();
  old.forEach((text) => session.result(session.reply(TRIGGER - 1)[0], text));
  assert.equal(rewriteSession(session), 0);
  assert.equal(reliefBoundary(session.messages()), -1);
  assert.ok(session.visible()[0].split('\n')[0].includes('"cleared"'));
});

test('relief touches only Rulith results: other tool results and the assistant messages stay as they were', () => {
  const session = fakeSession();
  const call = { type: 'tool-call', id: 'w', name: 'Execute', arguments: JSON.stringify({ action: 'eng.write_file', args: { text: 'w'.repeat(6000) } }) };
  const assistant = session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, call] } }, { surfaceOp: 'append' });
  session.result('w', 'plain text '.repeat(500));
  history(8).forEach((text, i) => session.result(session.reply(i === 7 ? TRIGGER : 1000)[0], text));
  rewriteSession(session, { clearAtLeast: 0 });
  assert.equal(session.surface.nodes[0], assistant.seq);
  assert.equal(session.log.filter((event) => event.type === 'assistant/message' && event.data.message.content[0].type === 'reasoning').length, 1);
  assert.equal(session.visible()[0], 'plain text '.repeat(500));
  assert.ok(session.visible()[1].includes('"cleared"'));
  assert.equal(session.visible()[1].split('\n')[1], DELTA_HEAD);
});

test("the relief line is the session route's own: a smaller window moves it one step before dsh's real compaction line", () => {
  const lines = [];
  const session = fakeSession();
  session.window = 131_072;
  // dsh compacts at 131072 - 32768 - 16384 = 81920 here; relief at 61920, below 0.7 x 131072 = 91750.
  const { relief } = contextLinesFor({ contextWindow: 131_072, maxTokens: MAX_TOKENS, compaction: COMPACTION });
  assert.equal(relief, 81_920 - RELIEF_MARGIN);
  history(20).forEach((text, i) => step(session, i === 19 ? relief : relief - 1, text, { onLines: (line) => lines.push(line) }));
  assert.deepEqual(lines.at(-1), { provider: 'p', model: 'm', contextWindow: 131_072, maxTokens: MAX_TOKENS, relief, compaction: 81_920 });
  assert.deepEqual(sessionLines(session, { compaction: COMPACTION }), lines.at(-1));
  assert.equal(session.visible().filter((text) => text.endsWith(`\n${RELIEF_MARK}`)).length, 1, 'one batch at the moved line');
});

test('relief keeps the per-section layout: the line naming absent sections stays, and the rows are read back the same', () => {
  const view = (i, scopedView) => raw({ accepted: true, result: { action: 'eng.read', output: `output ${i} `.repeat(300) },
    view: scopedView ? { position: { step: i }, facts: Array.from({ length: 40 }, (_, k) => ({ label: `fact ${k} `.repeat(20) })) } : { position: { step: i }, goalTypes: [] },
    operations: [{ tool: 'Execute', step: i, result: { output: `operation ${i} `.repeat(400) } }] });
  const session = fakeSession();
  Array.from({ length: 16 }, (_, i) => view(i, i % 2 === 0)).forEach((text, i) => step(session, i === 15 ? TRIGGER : 1000, text));
  const visible = session.visible();
  const boundary = visible.findIndex((text) => text.endsWith(`\n${RELIEF_MARK}`));
  assert.ok(boundary > 0);
  // A relieved default view still names the sections it did not carry, and no fact is listed as gone anywhere.
  const relievedDefault = visible.slice(0, boundary + 1).find((text, i) => i % 2 === 1);
  assert.ok(relievedDefault.split('\n')[0].includes('"cleared"'));
  assert.equal(relievedDefault.split('\n')[2], 'Not in this view (read with Get to see them): facts');
  assert.ok(visible.every((text) => !/^- facts: /m.test(text)));
  assert.equal(rewriteSession(session), 0);
});

// Installed-dsh contract: dsh's real session, agent loop and llm/stream waterfall with a scripted adapter. Proves that the
// recorded usage and the routed window reach the relief decision, that dsh accepts the batch's replace records, and that
// the copy sent to the model shortens long arguments before the mark.
test('installed dsh: a relief batch on the real session and agent loop', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { installBoardTranscript } = await import('../../harness/web/board-transcript.mjs');
  const { installOutgoingTrim } = await import('../../harness/web/outgoing-trim.mjs');
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const kernel = ['cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop'];
  const [cordis, ...plugins] = await Promise.all(['cordis', ...kernel].map(load));
  const { LlmAdapter, createUserMessage } = plugins[1];
  const ctx = new cordis.Context();
  const config = { 'dsh-system-prompt': { includeHarnessIdentity: false, includeRuntimeContext: false }, 'dsh-agent-loop': { agents: [] } };
  for (const [index, name] of kernel.entries()) await ctx.plugin(plugins[index].default, config[name] ?? {});
  const received = [], script = [];
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: WINDOW } }; }
    async *stream(options) {
      received.push(options.messages);
      const { blocks, prompt } = script.shift() ?? { blocks: [{ type: 'text', text: 'done' }], prompt: 1000 };
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
        if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'usage', usage: { inputTokens: prompt, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: blocks.some((b) => b.type === 'tool-call') ? 'tool-calls' : 'stop' }, replayState: { blocks: blocks.map((b) => ({ type: b.type })) } };
    }
  }
  ctx.llm.registerAdapter(['scripted'], new Scripted());
  // Execute answers like Rulith: the MCP result as text, with a long output and a Board.
  ctx.tools.register({ name: 'Execute', description: 'execute', parameters: { type: 'object', properties: { i: { type: 'number' }, text: { type: 'string' } } },
    output: { schema: {}, render: (_args, text) => [{ type: 'text', text }] }, async execute(args) { return raw(stepAnswer(args.i, 2000)); } });
  installBoardTranscript(ctx, { reliefRatio: 0.5 });
  installOutgoingTrim(ctx);
  const handle = await ctx.agents.create({ sessionId: 'context-relief-integration', agentOptions: { provider: 'scripted', model: 'm' } });
  try {
    const file = (i) => `${i}:`.padEnd(5000, String(i));
    // Twelve steps below the line, the twelfth reporting a prompt at it; the pre-step before the next request makes the batch.
    for (let i = 0; i < 12; i++) script.push({ prompt: i === 11 ? 0.5 * WINDOW : 1000,
      blocks: [{ type: 'tool-call', id: `c${i}`, name: 'Execute', arguments: JSON.stringify({ i, text: file(i) }) }] });
    script.push({ prompt: 1000, blocks: [{ type: 'text', text: 'all done' }] });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    const session = handle.agent.session;
    assert.equal(session.requestContext().contextWindow, WINDOW);
    const results = session.surface.nodes.map((seq) => session.eventAt(seq)).filter((event) => event.type === 'tool/result')
      .map((event) => session.deriveEventMessage(event).content[0].text);
    // Results 0..5 have six newer results: relieved, and the sixth carries the mark; the rest keep their full head.
    results.forEach((text, i) => {
      assert.equal(text.split('\n')[0].includes('"cleared"'), i <= 5, `result ${i}`);
      assert.equal(text.endsWith(`\n${RELIEF_MARK}`), i === 5, `result ${i}`);
    });
    // The last request went out with the arguments of calls 0..5 shortened and the later ones as recorded.
    const sent = received.at(-1).filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool-call'))
      .map((m) => JSON.parse(m.content.find((b) => b.type === 'tool-call').arguments).text);
    sent.forEach((text, i) => assert.equal(text, i <= 5 ? clearedArgument(file(i)) : file(i), `call ${i}`));
    // The originals stay in the log for the person's transcript.
    const originals = session.snapshotEvents().filter((event) => event.type === 'tool/result' && event.surfaceOp === 'append');
    assert.equal(originals.length, 12);
    assert.ok(originals.every((event) => event.data.message.content[0].text.startsWith('{"isError":false')));
  } finally {
    await handle.dispose();
  }
});
