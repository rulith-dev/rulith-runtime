import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { trimOutgoing, shortenArguments, clearedArgument, installOutgoingTrim, replaysConversation,
  LONG_ARGUMENT, ARGUMENT_HEAD } from '../../harness/web/outgoing-trim.mjs';
import { reliefBoundary, DELTA_HEAD } from '../../harness/web/board-transcript.mjs';
import { RELIEF_MARK } from '../../harness/web/context-relief.mjs';

// 发给模型的那一份在发出前减负（outgoing-trim.mjs）：之前轮次的思考不发；减负边界（最新一份以减负标记结尾的带板 Rulith
// 结果，由 board-transcript.mjs 写下并认出）之前的回答里，长字符串参数缩短。会话本身不改。先用合成的消息列表检查规则，再用已安装 dsh 的真实内核（DSH_MODULES_DIR）证明
// 这个监听者确实在 dsh 的请求路径上被调用。

let ids = 0;
const person = (text, kind = 'user') => ({ id: `u${ids++}`, role: 'user', content: [{ type: 'text', text }], source: { kind } });
const think = (text) => ({ type: 'reasoning', text });
const say = (text) => ({ type: 'text', text });
const call = (id, args = {}, name = 'Execute') => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });
const reply = (...content) => ({ id: `a${ids++}`, role: 'assistant', content,
  source: { kind: 'model', provider: 'p', model: 'm', replayState: { response: { kind: 'pi-ai' }, blocks: content.map((block) => ({ type: block.type })) } } });
const result = (id, text = 'ok') => ({ id: `t${ids++}`, role: 'tool', toolCallId: id, content: [say(text)], source: { kind: 'tool', callId: id } });
// A Board result that board-transcript.mjs made the boundary of a relief batch: its last line is the relief mark.
const BOUNDARY = ['{"accepted":true,"cleared":"earlier"}', DELTA_HEAD, '+ facts: {"label":"a"}', RELIEF_MARK].join('\n');
const marked = (id) => result(id, BOUNDARY);
const N = 6;
const types = (message) => message.content.map((block) => block.type).join('+');
const big = (seed, n = LONG_ARGUMENT + 1) => `${seed}:`.padEnd(n, seed);
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

test('reasoning is dropped only before the latest message from a person; the current turn keeps it', () => {
  const messages = [
    person('first'),
    reply(think('plan A'), call('c1')), result('c1'),
    reply(think('done A'), say('A is done')),
    person('second'),
    reply(think('plan B'), call('c2')), result('c2'),
    person('project context', 'rulith-project'), // 一轮中间的上下文、压缩摘要不算新一轮
    reply(think('still B'), call('c3')), result('c3'),
    person('checkpoint', 'compact-checkpoint'),
    reply(think('more B'), say('B')),
  ];
  const out = trimOutgoing(messages);
  assert.notEqual(out, messages);
  assert.deepEqual(out.map((m) => m.role === 'assistant' ? types(m) : m.role), ['user', 'tool-call', 'tool', 'text', 'user',
    'reasoning+tool-call', 'tool', 'user', 'reasoning+tool-call', 'tool', 'user', 'reasoning+text']);
  assert.deepEqual(out.map((m) => m.id), messages.map((m) => m.id), 'every message keeps its place and id');
  // The adapter's replay blocks stay aligned with the content, so the reply still replays natively.
  for (const m of out.filter((m) => m.role === 'assistant')) assert.deepEqual(m.source.replayState.blocks.map((b) => b.type), m.content.map((b) => b.type));
  assert.deepEqual(out[1].content[0], messages[1].content[1], 'the call block itself is untouched');
  assert.deepEqual(messages[1].content.map((b) => b.type), ['reasoning', 'tool-call'], 'the input list is not changed');
  // Another agent's message to this one (a sub-agent's instruction) also starts a turn.
  const child = trimOutgoing([person('task', 'agent-message'), reply(think('t'), say('r')), person('follow-up', 'agent-message')]);
  assert.equal(types(child[1]), 'text');
});

test('a reply that was only reasoning keeps an empty text block; with no message from a person nothing is dropped', () => {
  const alone = [reply(think('alone')), person('now')];
  const out = trimOutgoing(alone);
  assert.deepEqual(out[0].content, [say('')]);
  assert.deepEqual(out[0].source.replayState.blocks, [{ type: 'text' }]);
  const noPerson = [person('summary', 'compact-checkpoint'), reply(think('t'), call('c1')), result('c1')];
  assert.equal(trimOutgoing(noPerson), noPerson, 'unchanged lists come back as the same array');
});

test('long string arguments of calls before the relief mark are shortened; ids, names and later calls are kept', () => {
  const text = big('w', 90_000);
  const nested = { source: 'lab', files: [{ path: 'a.js', text: big('n') }], note: 'short', count: 3 };
  const messages = [person('build it')];
  messages.push(reply(think('t0'), call('c0', { action: 'eng.write_file', args: { path: 'game.js', text } }, 'Execute')), result('c0'));
  messages.push(reply(call('c1', nested, 'Set'), call('c2', { text: 'small' }, 'Get')), result('c1'), result('c2'));
  messages.push(reply(call('c3', { raw: big('x') }), say('parallel')), marked('c3'));
  for (let i = 4; i < 4 + N; i++) messages.push(reply(call(`c${i}`, { text: big(String(i % 10)) })), result(`c${i}`));
  const out = trimOutgoing(messages);
  const args = (message, index = 0) => JSON.parse(message.content.filter((b) => b.type === 'tool-call')[index].arguments);
  assert.equal(args(out[1]).args.text, `${text.slice(0, ARGUMENT_HEAD)}… [cleared to save context: ${text.length} characters, sha256 ${sha(text)}]`);
  assert.deepEqual({ ...args(out[1]).args, text: undefined }, { path: 'game.js', text: undefined }, 'other fields are kept');
  assert.equal(args(out[3]).files[0].text, clearedArgument(nested.files[0].text), 'nested strings are shortened too');
  assert.deepEqual({ ...args(out[3]), files: undefined }, { ...nested, files: undefined });
  assert.equal(out[3].content[1], messages[3].content[1], 'a short call keeps its exact block');
  assert.equal(args(out[6]).raw, clearedArgument(big('x')));
  for (const [i, m] of out.entries()) {
    if (m.role !== 'assistant') continue;
    assert.deepEqual(m.content.map((b) => [b.type, b.id, b.name]), messages[i].content.map((b) => [b.type, b.id, b.name]));
  }
  // Everything from the marked result on goes out exactly as recorded.
  for (let i = 8; i < out.length; i++) assert.equal(out[i], messages[i]);
  assert.equal(out[1].content[0], messages[1].content[0], 'the current turn keeps its reasoning');
  // The shortened form is far below the limit, so a second pass changes nothing; equal input gives equal output.
  assert.equal(trimOutgoing(out), out);
  assert.deepEqual(trimOutgoing(structuredClone(messages)), out);
});

test('the boundary is the newest Board result ending with the relief mark; without one nothing is shortened', () => {
  const messages = [person('go')];
  for (let i = 0; i < 4; i++) messages.push(reply(call(`c${i}`, { text: big('a') })), result(`c${i}`));
  assert.equal(trimOutgoing(messages), messages);
  // The mark counts only as the last line of a laid-out Board result; tool content cannot forge it.
  const decoys = [
    `${BOUNDARY}\nmore output`, // not the last line
    `ok\n${RELIEF_MARK}`, // a sub-agent's answer or any other tool's text
    ['{"accepted":true,"artifact":{"ref":"r","text":"<text 1>"}}', '<text 1> artifact.text (2 lines):', 'file line', RELIEF_MARK].join('\n'), // a file read through Get
    ['{"accepted":true,"result":{"head":"<text 1>"}}', '<text 1> result.head (2 lines):', DELTA_HEAD, RELIEF_MARK].join('\n'), // inside a text block
    `${JSON.stringify({ isError: false, content: [{ type: 'text', text: '{"accepted":true}' }] })}\n${RELIEF_MARK}`, // a raw result
  ];
  for (const text of decoys) {
    messages[4] = result('c1', text);
    assert.equal(reliefBoundary(messages), -1, text);
    assert.equal(trimOutgoing(messages), messages);
  }
  messages[4] = marked('c1');
  assert.equal(reliefBoundary(messages), 4);
  let out = trimOutgoing(messages);
  assert.deepEqual(out.map((m, i) => m !== messages[i]), [false, true, false, true, false, false, false, false, false]);
  assert.match(JSON.parse(out[1].content[0].arguments).text, /… \[cleared to save context: 4097 characters, sha256 [0-9a-f]{16}\]$/);
  // A later batch's mark moves the boundary; the earlier mark stays where it is.
  messages[8] = marked('c3');
  assert.equal(reliefBoundary(messages), 8);
  out = trimOutgoing(messages);
  assert.equal(out.filter((m, i) => m !== messages[i]).length, 4);
});

test('arguments that are not a JSON object, or have no long string, are left alone', () => {
  for (const raw of [`{"text":"${big('u')}`, JSON.stringify([big('a')]), JSON.stringify(big('a')), JSON.stringify({ n: 1, s: 'x'.repeat(LONG_ARGUMENT) }), '{}'])
    assert.equal(shortenArguments(raw), raw);
  // A key named __proto__ stays an ordinary key.
  const raw = `{"__proto__":{"text":${JSON.stringify(big('p'))}}}`;
  assert.deepEqual(Object.keys(JSON.parse(shortenArguments(raw))), ['__proto__']);
  // The fixed text is the one model-visible.md lists.
  const doc = fs.readFileSync(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('… [cleared to save context: <N> characters, sha256 <first 16 hex'));
  assert.match(clearedArgument(big('d')), /^d:d{398}… \[cleared to save context: 4097 characters, sha256 [0-9a-f]{16}\]$/);
  // The head never splits a surrogate pair.
  const emoji = 'x'.repeat(ARGUMENT_HEAD - 1) + '😀'.repeat(3000);
  assert.ok(clearedArgument(emoji).startsWith('x'.repeat(ARGUMENT_HEAD - 1) + '…'));
});

test('the listener sends a trimmed copy through the same LlmRuntime once, passes everything else on, and warns once per conversation', async () => {
  const listeners = {}, warnings = [], dispatched = [];
  const ctx = { on: (name, fn) => { listeners[name] = fn; }, logger: { warn: (text) => warnings.push(text) } };
  installOutgoingTrim(ctx);
  // A stand-in for dsh's waterfall: stream() runs the listener again, next() reaches the adapter.
  const runtime = { stream(options) { return listeners['llm/stream'].call(runtime, options, () => { dispatched.push(options); return 'adapter stream'; }); } };
  const messages = Object.freeze([person('one'), reply(think('t'), say('r')), person('two')]);
  const request = Object.freeze({ provider: 'p', model: 'm', messages, toolHistory: undefined, sessionId: 's1' });
  assert.equal(runtime.stream(request), 'adapter stream');
  assert.equal(dispatched.length, 1);
  assert.notEqual(dispatched[0], request);
  assert.ok(Object.isFrozen(dispatched[0]));
  assert.deepEqual({ ...dispatched[0], messages: undefined }, { ...request, messages: undefined }, 'route, session and signal are kept');
  assert.equal(types(dispatched[0].messages[1]), 'text');
  // Nothing to trim, or not a replay of the conversation (session title, shadow review): passed on as it came.
  for (const other of [{ ...request, messages: [person('x')] }, { provider: 'p', model: 'm', messages, sessionId: 's1', purpose: 'session-title' }]) {
    runtime.stream(other); assert.equal(dispatched.at(-1), other);
  }
  assert.equal(replaysConversation({ messages: [], toolHistory: [] }), true);
  // A failure sends the request as it was and is reported once for the conversation.
  const broken = { ...request, messages: [{ role: 'assistant', get content() { throw new Error('unexpected message shape'); } }] };
  runtime.stream(broken); runtime.stream(broken);
  assert.equal(dispatched.at(-1), broken);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conversation s1\): a request went out untrimmed \(unexpected message shape\)/);
  // A conversation whose requests never reach the listener is reported once as well; one that did is not.
  const step = (id, n) => listeners['agent/pre-step']({ agent: { session: { id } }, step: n }, () => 'next');
  assert.equal(step('s1', 2), 'next');
  assert.equal(step('s2', 1), 'next');
  assert.equal(warnings.length, 1, 'the first step of a turn proves nothing yet');
  step('s2', 2); step('s2', 3);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /conversation s2\): its model requests did not pass the llm\/stream listener/);
});

// Installed-dsh contract: the real agent loop, LlmRuntime and cordis waterfall, with a scripted adapter in place of a model
// server. Proves the listener is on dsh's request path, that the adapter receives the trimmed copy and the session does not.
test('installed dsh: the agent loop sends the trimmed copy to the adapter and keeps the session as recorded', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
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
    async *stream(options) {
      received.push(options.messages);
      const blocks = script.shift() ?? [say('done')];
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
        if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text };
        if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: blocks.some((b) => b.type === 'tool-call') ? 'tool-calls' : 'stop' },
        replayState: { blocks: blocks.map((block) => ({ type: block.type })) } };
    }
  }
  ctx.llm.registerAdapter(['scripted'], new Scripted());
  ctx.tools.register({ name: 'write', description: 'write a file', parameters: { type: 'object', properties: { text: { type: 'string' } } },
    // The first call's result ends with the relief mark, as if board-transcript.mjs had made it a batch boundary.
    output: { schema: {}, render: (_args, text) => [say(text)] },
    async execute(args) { return args.text.startsWith('1:') ? BOUNDARY : 'written'; } });
  installOutgoingTrim(ctx);
  const handle = await ctx.agents.create({ sessionId: 'outgoing-trim-integration', agentOptions: { provider: 'scripted', model: 'm' } });
  try {
    const text = (i) => big(String(i), 5000);
    for (let i = 1; i <= N + 1; i++) script.push([think(`think ${i}`), call(`c${i}`, { text: text(i) }, 'write')]);
    script.push([think('final'), say('all written')]);
    handle.agent.followup(createUserMessage({ content: [say('first')], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    script.push([say('second answer')]);
    handle.agent.followup(createUserMessage({ content: [say('second')], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    assert.equal(received.length, N + 3);
    const replies = (messages) => messages.filter((m) => m.role === 'assistant');
    const argsOf = (message) => JSON.parse(message.content.find((b) => b.type === 'tool-call').arguments).text;
    // Turn 1, last step: its own reasoning is kept; the first call is now older than the latest six.
    const lastStep = replies(received[N + 1]);
    assert.deepEqual(lastStep.map(types), Array(N + 1).fill('reasoning+tool-call'));
    assert.equal(argsOf(lastStep[0]), clearedArgument(text(1)));
    for (let i = 1; i <= N; i++) assert.equal(argsOf(lastStep[i]), text(i + 1));
    // Turn 2: turn 1's reasoning is gone, text, ids, names and replay alignment are kept.
    const second = replies(received[N + 2]);
    assert.deepEqual(second.map(types), [...Array(N + 1).fill('tool-call'), 'text']);
    assert.deepEqual(second.map((m) => m.content.map((b) => b.id ?? b.text)), [...Array.from({ length: N + 1 }, (_, i) => [`c${i + 1}`]), ['all written']]);
    for (const m of second) assert.deepEqual(m.source.replayState.blocks.map((b) => b.type), m.content.map((b) => b.type));
    // The session keeps every reasoning block and the full arguments.
    const stored = replies(handle.agent.session.deriveMessages());
    assert.deepEqual(stored.slice(0, N + 2).map(types), [...Array(N + 1).fill('reasoning+tool-call'), 'reasoning+text']);
    assert.equal(argsOf(stored[0]), text(1));
  } finally {
    await handle.dispose();
  }
});
