// 0.19.3 (owner direction 2026-10-27): the context window each model route is measured against. A local model server
// (this computer or a private network address) is asked for its per-request window with the key the app holds for it; a
// recognised local inference server that does not say is assumed to have 128K, shown as assumed; anything else (hosted
// models, a local proxy to hosted models) keeps 1M; the person's own window wins (at least what Rulith needs), then the
// developer setting, then detection. Every model server here is a local test server or a stand-in function: no real
// model server, manager or credential of this computer is used.
// 中文说明：上下文窗口的读取、优先次序、估计值、太小的窗口、设置页的显示，以及减负线与压缩线按实际窗口计算。只用本地假服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASSUMED_LOCAL_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, MIN_USABLE_CONTEXT_WINDOW, PROBES, createContextWindows, detectContextWindow,
  isLocalModelServer, personWindow, resolveWindow, routeKey, windowValue } from '../../harness/web/context-window.mjs';
import { LIVE_PROVIDER_PREFIX, createRouteAdapter, installLiveModels, liveRoute, modelRoutes } from '../../harness/web/model-runtime.mjs';
import { COMPACTION_HEADROOM_TOKENS, MIN_PROMPT_TOKENS, MODEL_MAX_TOKENS, RELIEF_MARGIN, contextLinesFor } from '../../harness/web/context-relief.mjs';
import { installBoardTranscript } from '../../harness/web/board-transcript.mjs';
import { contextEnv } from '../../harness/web/launcher-settings.mjs';
import { loadPage, nodes, text, plain, flush } from './browser-page.mjs';
import * as PSC from './psc-0.2.32-text.mjs';

const KEY = 'sk-local-test-never-logged-0123456789';
const ACCOUNT = { origin: 'https://console.example', accountId: 'acct-1' };
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulith-context-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A model server on 127.0.0.1 (an ephemeral port): `routes` maps a path (with its query, or without) to
 * `[status, body]` (a string is sent as it is) or `'hang'` (never answers). Every request is recorded with its
 * Authorization header.
 */
async function modelServer(t, routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? '' });
    const answer = routes[req.url] ?? routes[req.url.split('?')[0]] ?? [404, { error: 'not found' }];
    const [status, body] = typeof answer === 'function' ? answer(req) : answer;
    if (status === 'hang') return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
const LLAMA_PROPS = { default_generation_settings: { n_ctx: 262144, params: { n_predict: -1 } }, total_slots: 2,
  model_path: 'model.gguf', build_info: 'b11950-0000000' };
const LLAMA_MODELS = { object: 'list', data: [{ id: 'qwen', object: 'model', meta: { n_ctx: 524288, n_ctx_train: 1048576, n_vocab: 151936 } }] };
// What a proxy to hosted models (LiteLLM, one-api, a company gateway) answers: an OpenAI model list and nothing else.
const PROXY_MODELS = { object: 'list', data: [{ id: 'qwen', object: 'model', created: 0, owned_by: 'openai' }] };

test('a window is a whole number of tokens; a person\'s is at least what Rulith needs; local means localhost or a private address', () => {
  for (const good of [1024, 131072, '262144', ' 4096 ', 100_000_000]) assert.equal(windowValue(good), Number(String(good).trim()), String(good));
  for (const bad of [0, -1, 1023, 1.5, '1.5', '12k', '', null, undefined, 100_000_001, Number.MAX_SAFE_INTEGER + 2, true, {}])
    assert.equal(windowValue(bad), undefined, String(bad));
  // The smallest window Rulith can use, from the output cap, the compaction headroom, the relief margin and a minimal prompt.
  assert.equal(MIN_USABLE_CONTEXT_WINDOW, MODEL_MAX_TOKENS + COMPACTION_HEADROOM_TOKENS + RELIEF_MARGIN + MIN_PROMPT_TOKENS);
  assert.equal(MIN_USABLE_CONTEXT_WINDOW, 85536);
  assert.equal(personWindow(MIN_USABLE_CONTEXT_WINDOW), 85536);
  for (const small of [MIN_USABLE_CONTEXT_WINDOW - 1, 65536, 4096, '32768']) assert.equal(personWindow(small), undefined, String(small));
  for (const local of ['http://127.0.0.1:8080/v1', 'http://127.1.2.3:9/v1', 'http://localhost:1234/v1', 'http://[::1]:8080', 'https://gpu.localhost/v1',
    'https://10.0.0.5/v1', 'https://172.16.0.1/v1', 'https://172.31.255.1/v1', 'https://192.168.1.20:8443/v1', 'https://169.254.10.1/v1',
    'https://100.64.0.1/v1', 'https://100.101.102.103:8443/v1', 'https://[fd00::1]/v1', 'https://[fe80::1]/v1',
    'https://[::ffff:192.168.1.5]/v1', 'http://[::ffff:127.0.0.1]:8080/v1'])
    assert.equal(isLocalModelServer(local), true, local);
  for (const hosted of ['https://api.deepseek.com', 'https://api.anthropic.com/v1/messages', 'https://172.32.0.1/v1', 'https://172.15.0.1',
    'https://100.128.0.1/v1', 'https://8.8.8.8/v1', 'https://[2001:db8::1]/v1', 'https://[fd::1]/v1', 'https://[fe8::1]/v1',
    'http://0.0.0.0:8080/v1', 'http://[::]:8080/v1', 'http://[::ffff:0.0.0.0]:8080/v1', 'https://localhost.example.com/v1', 'not a url', ''])
    assert.equal(isLocalModelServer(hosted), false, hosted);
});

test('precedence: the person\'s window, the developer setting, detection, 128K for a recognised local server, else 1M', () => {
  assert.deepEqual(resolveWindow({ local: true, set: 200000, developer: 150000, detected: 262144, recognized: true }), { tokens: 200000, source: 'set' });
  assert.deepEqual(resolveWindow({ local: true, developer: 150000, detected: 262144, recognized: true }), { tokens: 150000, source: 'developer' });
  assert.deepEqual(resolveWindow({ local: true, detected: 262144, recognized: true }), { tokens: 262144, source: 'detected' });
  assert.deepEqual(resolveWindow({ local: true, recognized: true }), { tokens: ASSUMED_LOCAL_CONTEXT_WINDOW, source: 'assumed' });
  assert.equal(ASSUMED_LOCAL_CONTEXT_WINDOW, 131072);
  // A local address not recognised as an inference server (a proxy to hosted models, or not reached yet): 1M as before.
  assert.deepEqual(resolveWindow({ local: true }), { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  // A hosted route: only the person's own window changes it.
  assert.deepEqual(resolveWindow({ local: false, developer: 150000, detected: 262144, recognized: true }), { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  assert.deepEqual(resolveWindow({ local: false, set: 500000 }), { tokens: 500000, source: 'set' });
  assert.equal(DEFAULT_CONTEXT_WINDOW, 1_000_000);
  // The window store's key is the live route's id: one name for one route.
  const model = { url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' };
  assert.equal(liveRoute(model).id, LIVE_PROVIDER_PREFIX + routeKey(model));
});

test('llama.cpp: /props of the model, then /props, give the per-slot window; never a model list\'s n_ctx or the training length', async (t) => {
  const server = await modelServer(t, { '/props': [200, LLAMA_PROPS], '/v1/models': [200, LLAMA_MODELS] });
  const model = { url: `${server.origin}/v1`, name: 'qwen', key: KEY };
  assert.deepEqual(await detectContextWindow(model), { tokens: 262144, recognized: true });
  assert.ok(server.seen.length > 0 && server.seen.every((request) => request.auth === `Bearer ${KEY}`), JSON.stringify(server.seen.map((r) => r.url)));
  // The model's own props are asked first (one model's server ignores the query and answers its props).
  const props = server.seen.map((request) => request.url).filter((url) => url.startsWith('/props'));
  assert.deepEqual(props, ['/props?model=qwen&autoload=false']);
  // Without /props, llama.cpp's model list says no window: neither meta.n_ctx (not verified per slot) nor n_ctx_train.
  const listOnly = await modelServer(t, { '/v1/models': [200, LLAMA_MODELS] });
  assert.deepEqual(await detectContextWindow({ ...model, url: `${listOnly.origin}/v1` }), { tokens: undefined, recognized: false });
  // A model on this computer without a key sends no Authorization header at all.
  const open = await modelServer(t, { '/props': [200, LLAMA_PROPS] });
  assert.equal((await detectContextWindow({ url: `${open.origin}/v1`, name: 'qwen', key: '' })).tokens, 262144);
  assert.ok(open.seen.every((request) => request.auth === ''));
  // A server root (no /v1) and an Anthropic Messages address on the same server are read the same way.
  assert.equal((await detectContextWindow({ url: open.origin, name: 'qwen', key: '' })).tokens, 262144);
  assert.equal((await detectContextWindow({ url: `${open.origin}/v1/messages`, name: 'qwen', key: '' })).tokens, 262144);
});

test('llama.cpp router: the loaded model\'s /props first, asked without loading it; else the router\'s own /props', async (t) => {
  const server = await modelServer(t, { '/props': [200, { role: 'router', total_slots: 0 }],
    '/props?model=org%2Fqwen%3AQ4&autoload=false': [200, { default_generation_settings: { n_ctx: 98304 } }] });
  assert.deepEqual(await detectContextWindow({ url: `${server.origin}/v1`, name: 'org/qwen:Q4', key: KEY }), { tokens: 98304, recognized: true });
  assert.equal(server.seen.filter((request) => request.url.startsWith('/props')).length, 1, 'the model\'s answer is enough');
  // A model the router has not loaded: its props are refused, the router's own say it is llama.cpp but give no window.
  const unloaded = await modelServer(t, { '/props': [200, { role: 'router', total_slots: 0 }], '/props?model=other&autoload=false': [400, {}] });
  assert.deepEqual(await detectContextWindow({ url: `${unloaded.origin}/v1`, name: 'other', key: '' }), { tokens: undefined, recognized: true });
  assert.deepEqual(unloaded.seen.map((request) => request.url).filter((url) => url.startsWith('/props')), ['/props?model=other&autoload=false', '/props']);
});

test('vLLM, LM Studio and Ollama: only a field that is the loaded runtime context counts; a proxy is not an inference server', async (t) => {
  const vllm = await modelServer(t, { '/v1/models': [200, { object: 'list', data: [{ id: 'other', max_model_len: 4096 },
    { id: 'Qwen/Qwen3-32B', object: 'model', owned_by: 'vllm', max_model_len: 40960 }] }] });
  assert.deepEqual(await detectContextWindow({ url: `${vllm.origin}/v1`, name: 'Qwen/Qwen3-32B', key: KEY }), { tokens: 40960, recognized: true });
  assert.deepEqual(await detectContextWindow({ url: `${vllm.origin}/v1`, name: 'not-served', key: KEY }), { tokens: undefined, recognized: true },
    'only the entry of this model id gives the window');
  const lmstudio = await modelServer(t, { '/api/v1/models': [200, { models: [
    { key: 'google/gemma-4', max_context_length: 262144, loaded_instances: [{ id: 'google/gemma-4', config: { context_length: 8192 } }] },
    { key: 'deepseek-r1', max_context_length: 131072, loaded_instances: [] }] }] });
  assert.deepEqual(await detectContextWindow({ url: `${lmstudio.origin}/v1`, name: 'google/gemma-4', key: '' }), { tokens: 8192, recognized: true });
  assert.deepEqual(await detectContextWindow({ url: `${lmstudio.origin}/v1`, name: 'deepseek-r1', key: '' }), { tokens: undefined, recognized: true },
    'a model that is not loaded has no runtime context; max_context_length is the model\'s own limit');
  const ollama = await modelServer(t, { '/api/ps': [200, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 32768, size_vram: 1 }] }] });
  assert.deepEqual(await detectContextWindow({ url: `${ollama.origin}/v1`, name: 'qwen3:8b', key: '' }), { tokens: 32768, recognized: true });
  const idle = await modelServer(t, { '/api/ps': [200, { models: [] }] });
  assert.deepEqual(await detectContextWindow({ url: `${idle.origin}/v1`, name: 'llama3', key: '' }), { tokens: undefined, recognized: true });
  // A proxy to hosted models answers an OpenAI model list only: not recognised, no window.
  const proxy = await modelServer(t, { '/v1/models': [200, PROXY_MODELS] });
  assert.deepEqual(await detectContextWindow({ url: `${proxy.origin}/v1`, name: 'qwen', key: KEY }), { tokens: undefined, recognized: false });
  // The probes in order: llama.cpp's /props first.
  const both = await modelServer(t, { '/props': [200, LLAMA_PROPS], '/v1/models': [200, { data: [{ id: 'qwen', max_model_len: 4096 }] }] });
  assert.equal((await detectContextWindow({ url: `${both.origin}/v1`, name: 'qwen', key: '' })).tokens, 262144);
  assert.equal(PROBES.models({ data: [{ id: 'q', max_model_len: '40960' }] }, 'q').tokens, 40960, 'a string of digits is still a number of tokens');
});

test('401, 404, a timeout and garbage are unknown, quickly, and nothing says the key', async (t) => {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => { logged.push(args.join(' ')); });
  const unknown = { tokens: undefined, recognized: false };
  const refused = await modelServer(t, { '/props': [401, { error: 'invalid api key' }], '/v1/models': [401, {}], '/api/v1/models': [401, {}], '/api/ps': [401, {}] });
  const model = { url: `${refused.origin}/v1`, name: 'qwen', key: KEY };
  assert.deepEqual(await detectContextWindow(model), unknown);
  const missing = await modelServer(t, {});
  assert.deepEqual(await detectContextWindow({ ...model, url: `${missing.origin}/v1` }), unknown);
  for (const garbage of ['not json', '{"default_generation_settings":{"n_ctx":"lots"}}', '{"default_generation_settings":{"n_ctx":-5}}',
    '{"default_generation_settings":{"n_ctx":512}}', '{"default_generation_settings":{"n_ctx":1e12}}', '[]', 'null']) {
    const server = await modelServer(t, { '/props': [200, garbage], '/v1/models': [200, garbage] });
    assert.equal((await detectContextWindow({ ...model, url: `${server.origin}/v1` })).tokens, undefined, garbage);
  }
  const hanging = await modelServer(t, { '/props': ['hang'], '/v1/models': ['hang'], '/api/v1/models': ['hang'], '/api/ps': ['hang'] });
  const started = Date.now();
  assert.deepEqual(await detectContextWindow({ ...model, url: `${hanging.origin}/v1` }, { timeoutMs: 200 }), unknown);
  assert.ok(Date.now() - started < 2000, 'one short deadline for every probe');
  // Nothing listens there: unknown as well.
  assert.deepEqual(await detectContextWindow({ ...model, url: 'http://127.0.0.1:9/v1' }, { timeoutMs: 500 }), unknown);
  // The store's log lines and the file name the model and its address, never the key.
  const dir = temp(t);
  const lines = [];
  const windows = createContextWindows({ file: path.join(dir, 'windows.json'), log: (line) => lines.push(line), timeoutMs: 200 });
  await windows.detect(model);
  const good = await modelServer(t, { '/props': [200, LLAMA_PROPS] });
  await windows.detect({ ...model, url: `${good.origin}/v1` });
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /could not read the context window of qwen at http:\/\/127\.0\.0\.1:\d+\/v1 from the model server; using 1000000 tokens \(default\)/);
  assert.match(lines[1], /context window of qwen at http:\/\/127\.0\.0\.1:\d+\/v1: 262144 tokens, detected from the model server/);
  const saved = fs.readFileSync(path.join(dir, 'windows.json'), 'utf8');
  for (const words of [...lines, ...logged, saved]) assert.equal(words.includes(KEY), false, words);
});

test('the store: what a server says is kept on this computer, a failed detection keeps it, the person\'s window wins and clears', async (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'dsh', 'rulith-context-windows.json');
  let props = [200, LLAMA_PROPS];
  const server = await modelServer(t, { '/props': () => props });
  const model = { url: `${server.origin}/v1`, name: 'qwen', key: KEY };
  const windows = createContextWindows({ file });
  assert.deepEqual(windows.info(model), { tokens: 1_000_000, source: 'default', local: true, fallback: 1_000_000 }, 'not asked yet: as before');
  assert.equal(fs.existsSync(file), false, 'nothing is written before anything is known');
  assert.deepEqual((await windows.detect(model)), { tokens: 262144, source: 'detected', local: true, fallback: 262144 });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, { version: 1, routes: { [routeKey(model)]: { detected: 262144, recognized: true, address: `${server.origin}/v1`, model: 'qwen' } } });
  // The same answer again writes nothing.
  const before = fs.statSync(file).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await windows.detect(model);
  assert.equal(fs.statSync(file).mtimeMs, before);
  // The server is down for now: the last detected window stays.
  props = [503, {}];
  assert.equal((await windows.detect(model)).tokens, 262144);
  // A new run of the app reads the file.
  const again = createContextWindows({ file });
  assert.equal(again.info(model).source, 'detected');
  // The person's window wins; cleared, the detected one is back.
  assert.deepEqual(again.set(model, 200000), { tokens: 200000, source: 'set', local: true, set: 200000, fallback: 262144 });
  assert.equal(createContextWindows({ file }).info(model).tokens, 200000, 'kept across runs');
  assert.deepEqual(again.set(model, null), { tokens: 262144, source: 'detected', local: true, fallback: 262144 });
  // The developer setting wins over detection, the person's window over both.
  const developer = createContextWindows({ file, developerWindow: 150000 });
  assert.deepEqual(developer.info(model), { tokens: 150000, source: 'developer', local: true, fallback: 150000 });
  assert.equal(developer.set(model, 300000).source, 'set');
  assert.equal(developer.set(model, null).source, 'developer');
  // Another model id on the same server is another route.
  assert.equal(developer.info({ ...model, name: 'other' }).source, 'developer');
  assert.equal(createContextWindows({ file }).info({ ...model, name: 'other' }).source, 'default');
  // An unreadable file is no knowledge, not an error.
  fs.writeFileSync(file, '{ not json');
  assert.equal(createContextWindows({ file }).info(model).source, 'default');
});

test('a recognised local server that does not say is assumed to have 128K; a local proxy keeps 1M; a reported 4096 is real but too small', async (t) => {
  const file = path.join(temp(t), 'w.json');
  const idle = await modelServer(t, { '/api/ps': [200, { models: [] }] });
  const ollama = { url: `${idle.origin}/v1`, name: 'llama3', key: '' };
  const windows = createContextWindows({ file });
  assert.deepEqual(await windows.detect(ollama), { tokens: 131072, source: 'assumed', local: true, fallback: 131072 });
  assert.equal(createContextWindows({ file }).info(ollama).source, 'assumed', 'that it is an inference server is kept');
  const proxy = await modelServer(t, { '/v1/models': [200, PROXY_MODELS] });
  const behindProxy = { url: `${proxy.origin}/v1`, name: 'qwen', key: KEY };
  assert.deepEqual(await windows.detect(behindProxy), { tokens: 1_000_000, source: 'default', local: true, fallback: 1_000_000 });
  assert.equal(liveRoute(behindProxy, { windows }).contextWindow, 1_000_000);
  // Ollama's default load: 4096 tokens, reported as it is, too small for Rulith.
  const small = await modelServer(t, { '/api/ps': [200, { models: [{ name: 'qwen3:8b', context_length: 4096 }] }] });
  const tiny = { url: `${small.origin}/v1`, name: 'qwen3:8b', key: '' };
  assert.deepEqual(await windows.detect(tiny), { tokens: 4096, source: 'detected', local: true, fallback: 4096, tooSmall: true });
  assert.equal(liveRoute(tiny, { windows }).contextWindow, 4096, 'the server\'s real window is used');
  // A person's window covers it.
  assert.deepEqual(windows.set(tiny, MIN_USABLE_CONTEXT_WINDOW), { tokens: 85536, source: 'set', local: true, set: 85536, fallback: 4096 });
});

test('a hosted model is never asked and keeps 1M unless the person sets one', async (t) => {
  const asked = [];
  const windows = createContextWindows({ file: path.join(temp(t), 'w.json'), fetch: async (url) => { asked.push(url); return new Response('{}'); } });
  const hosted = { url: 'https://api.deepseek.com', name: 'deepseek-chat', key: KEY };
  assert.deepEqual(await windows.detect(hosted), { tokens: 1_000_000, source: 'default', local: false, fallback: 1_000_000 });
  windows.detectSoon(hosted);
  windows.detectAfterOverflow(hosted);
  await flush();
  assert.deepEqual(asked, []);
  assert.equal(windows.set(hosted, 500000).tokens, 500000);
  assert.equal(liveRoute(hosted, { windows }).contextWindow, 500000);
  assert.equal(windows.set(hosted, null).tokens, 1_000_000);
  assert.equal(liveRoute(hosted, { windows }).contextWindow, 1_000_000);
});

test('a turn\'s start asks in the background: not asked yet, a minute after a miss, ten minutes after a window; never when set', async (t) => {
  let clock = 1_000_000;
  const asked = [];
  let answer = () => new Response('{}', { status: 404 });
  const windows = createContextWindows({ file: path.join(temp(t), 'w.json'), now: () => clock,
    fetch: async (url) => { asked.push(new URL(url).pathname); return answer(url); } });
  const model = { url: 'http://127.0.0.1:9/v1', name: 'qwen', key: '' };
  const tries = async () => { const count = asked.length; windows.detectSoon(model); await flush(8); return asked.length - count; };
  windows.detectSoon(model);
  windows.detectSoon(model);   // already running: not asked twice
  await flush(8);
  assert.ok(asked.length > 0 && asked.length <= 6, String(asked.length));
  assert.equal(await tries(), 0, 'within a minute of a miss');
  clock += 60_000;
  answer = (url) => new Response(JSON.stringify(new URL(url).pathname === '/props' ? LLAMA_PROPS : {}), { status: 200 });
  assert.ok(await tries() > 0, 'a minute after a miss');
  assert.equal(windows.info(model).source, 'detected');
  clock += 9 * 60_000;
  assert.equal(await tries(), 0, 'a detected window is not asked again at every turn');
  clock += 60_000;
  assert.ok(await tries() > 0, 'ten minutes after the window was read');
  // After a refusal for exceeding the window: asked at once, whatever its age.
  const count = asked.length;
  windows.detectAfterOverflow(model);
  await flush(8);
  assert.ok(asked.length > count);
  // The person's window does not depend on the server: never asked for it.
  windows.set(model, 200000);
  clock += 3_600_000;
  assert.equal(await tries(), 0);
  windows.detectAfterOverflow(model);
  await flush(8);
  assert.equal(await tries(), 0);
});

/** A stand-in for dsh's LLM registry and one Agent (model-runtime's per-agent waterfalls), as in local-setup.test.mjs. */
function fakeDsh() {
  const registered = new Map(), listeners = new Map();
  const ctx = { llm: { registerAdapter: (ids, adapter) => { for (const id of ids) registered.set(id, adapter); return () => { for (const id of ids) registered.delete(id); }; } },
    on: (event, fn) => listeners.set(event, fn) };
  const agent = { session: { id: 's-1', requestHeader: () => undefined },
    ctx: { handlers: {}, on(event, fn) { (this.handlers[event] ??= []).push(fn); } } };
  return { ctx, registered, agent, listeners, created: () => listeners.get('agent/created')({ agent }),
    request: (turn) => agent.ctx.handlers['agent/request'][0]({ turn, step: 1 }, async () => ({ provider: 'rulith-model', model: 'launch-model' })) };
}

test('a changed window reaches the registered route when a turn starts on it, under the same provider id; an overflow asks the server again', async (t) => {
  const asked = [];
  const windows = createContextWindows({ file: path.join(temp(t), 'w.json'), fetch: async (url) => { asked.push(url); return new Response('{}', { status: 404 }); } });
  const model = { url: 'http://127.0.0.1:9/v1', name: 'qwen', key: '' };
  const dsh = fakeDsh();
  const routes = [];
  installLiveModels(dsh.ctx, { routeFor: () => ({ account: ACCOUNT, model }), windows,
    createAdapter: async (route, id) => { routes.push(route); return { id }; } });
  dsh.created();
  const first = await dsh.request(1);
  assert.equal(routes[0].contextWindow, 1_000_000, 'not recognised (yet): as before');
  windows.set(model, 262144);
  assert.equal(routes[0].contextWindow, 1_000_000, 'the registered route takes it when a turn starts on the route');
  const second = await dsh.request(2);
  assert.equal(second.provider, first.provider, 'the window is not part of the route\'s id');
  assert.equal(routes.length, 1, 'nothing new is registered');
  assert.equal(routes[0].contextWindow, 262144);
  windows.set(model, null);
  // A request refused for exceeding the window: the server is asked again, in the background; other errors ask nothing.
  await flush(8);
  const before = asked.length;
  const next = async () => 'next';
  assert.equal(await dsh.listeners.get('agent/request-error')({ agent: dsh.agent, failure: { code: 'PROVIDER_ERROR' } }, next), 'next');
  await flush(8);
  assert.equal(asked.length, before);
  assert.equal(await dsh.listeners.get('agent/request-error')({ agent: dsh.agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, next), 'next');
  await flush(8);
  assert.ok(asked.length > before);
  // The real adapter reads its route's window at each request.
  const route = liveRoute(model, { windows });
  const adapter = await createRouteAdapter(route, 'rulith-live-test');
  assert.equal((await adapter.resolveModel('rulith-live-test', 'qwen')).context.contextWindow, 1_000_000);
  route.contextWindow = 98304;
  assert.equal((await adapter.resolveModel('rulith-live-test', 'qwen')).context.contextWindow, 98304);
  assert.equal((await adapter.prepareCall('rulith-live-test', 'qwen')).model.context.contextWindow, 98304);
});

test('the model routes: the window, its source and a too-small warning reach the page without the key; the person\'s window is checked', async (t) => {
  const server = await modelServer(t, { '/props': [200, LLAMA_PROPS] });
  const windows = createContextWindows({ file: path.join(temp(t), 'w.json') });
  let model = { source: 'default', url: `${server.origin}/v1`, name: 'qwen', key: KEY };
  let account = ACCOUNT;
  const sent = [];
  const state = { device: { state: 'linked', origin: ACCOUNT.origin, account: { id: ACCOUNT.accountId }, agents: [] }, instances: [] };
  const routes = modelRoutes({ manager: async (route) => { sent.push(route); return route === '/manager/state' ? state : {}; },
    read: async () => ({ account, model }), windows });
  const guard = { expectedOrigin: ACCOUNT.origin, expectedAccountId: ACCOUNT.accountId };
  assert.deepEqual((await routes.get()).model.contextWindow, { tokens: 1_000_000, source: 'default', fallback: 1_000_000 });
  const saved = await routes.save({ ...guard, url: model.url, name: 'qwen' });
  assert.deepEqual(saved.model.contextWindow, { tokens: 262144, source: 'detected', fallback: 262144 }, 'asked before the answer');
  assert.ok(server.seen.some((request) => request.url.startsWith('/props') && request.auth === `Bearer ${KEY}`));
  const set = await routes.setContextWindow({ ...guard, contextWindow: '200000' });
  assert.deepEqual(set.model.contextWindow, { tokens: 200000, source: 'set', set: 200000, fallback: 262144 });
  assert.equal(set.applies, 'next_turn');
  assert.equal(JSON.stringify([saved, set]).includes(KEY), false, 'the key never reaches the page');
  const refusal = PSC.fill(PSC.HOST['model.windowInvalid'], { min: 85536 });
  assert.match(refusal, /from 85536 to 100000000/);
  for (const bad of ['12k', 0, 100, -1, '1.5', 1e9, 4096, 65536, MIN_USABLE_CONTEXT_WINDOW - 1])
    await assert.rejects(routes.setContextWindow({ ...guard, contextWindow: bad }), (error) => error.errorCode === 'context_window_invalid'
      && error.message === refusal, String(bad));
  assert.equal((await routes.setContextWindow({ ...guard, contextWindow: MIN_USABLE_CONTEXT_WINDOW })).model.contextWindow.tokens, 85536);
  assert.equal((await routes.setContextWindow({ ...guard, contextWindow: '' })).model.contextWindow.source, 'detected', 'empty clears it');
  await routes.setContextWindow({ ...guard, contextWindow: 120000 });
  assert.equal((await routes.setContextWindow({ ...guard, contextWindow: null })).model.contextWindow.source, 'detected');
  assert.deepEqual(sent, ['/manager/state', '/manager/model/default'], 'the window goes to no manager or Gateway route');
  // A server reporting a window too small for Rulith: shown with the minimum.
  const small = await modelServer(t, { '/props': [200, { default_generation_settings: { n_ctx: 8192 } }] });
  model = { source: 'default', url: `${small.origin}/v1`, name: 'qwen', key: '' };
  await routes.save({ ...guard, url: model.url, name: 'qwen' });
  assert.deepEqual((await routes.get()).model.contextWindow, { tokens: 8192, source: 'detected', fallback: 8192, tooSmall: true, minimum: 85536 });
  // Guarded by the account the page read; no usable model, no window.
  await assert.rejects(routes.setContextWindow({ ...guard, expectedAccountId: 'acct-other', contextWindow: 200000 }), (error) => error.errorCode === 'account_changed');
  account = null;
  await assert.rejects(routes.setContextWindow({ ...guard, contextWindow: 200000 }), (error) => error.errorCode === 'not_signed_in');
  account = ACCOUNT;
  model = { source: 'default', url: '', name: '', key: '' };
  await assert.rejects(routes.setContextWindow({ ...guard, contextWindow: 200000 }), (error) => error.errorCode === 'model_not_set'
    && error.message === PSC.HOST['model.windowNoModel']);
  assert.equal(Object.hasOwn((await routes.get()).model, 'contextWindow'), false, 'no usable model: no window shown');
  // A host without a store answers as before.
  model = { source: 'default', url: 'https://api.deepseek.com', name: 'deepseek-chat', key: KEY };
  assert.equal(Object.hasOwn((await modelRoutes({ manager: async () => ({}), read: async () => ({ account, model }) }).get()).model, 'contextWindow'), false);
});

test('Settings → Model: the window in use and where it comes from; assumed and too-small windows say what to do; saving the window alone saves no model', async () => {
  const page = loadPage({ reply: ({ url, method }) => {
    if (url === '/rulith/api/model/context-window' && method === 'POST') return { ok: true, applies: 'next_turn', model: {} };
    if (url === '/rulith/api/model' && method === 'POST') return { ok: true, applies: 'next_turn', model: { configured: true } };
    return { ok: true };
  } });
  const base = { source: 'default', url: 'http://127.0.0.1:8080/v1', name: 'qwen', modelId: 'qwen', configured: true, keyConfigured: true,
    expectedOrigin: ACCOUNT.origin, expectedAccountId: ACCOUNT.accountId };
  const form = page.mount(page.plugin.components.ModelForm, {});
  form.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 262144, source: 'detected', fallback: 262144 } } };
  let shown = form.render();
  const line = (root) => nodes(root).find((node) => node.props['data-rulith-context-window'] !== undefined);
  const warning = (root) => nodes(root).find((node) => node.props['data-rulith-context-window-small'] !== undefined);
  const fieldOf = (root) => nodes(root).find((node) => node.props['data-rulith-context-window-field'] !== undefined);
  assert.equal(text(line(shown)), 'Context window: 262,144 tokens (detected from the model server)');
  assert.equal(text(line(shown)), PSC.fill(PSC.PAGE.model.window, { tokens: '262,144', source: PSC.PAGE.model.windowSources.detected }));
  assert.doesNotMatch(text(shown), new RegExp(PSC.PAGE.model.windowAssumed.slice(0, 30)));
  assert.equal(warning(shown), undefined);
  assert.equal(fieldOf(shown).props.value, '');
  assert.equal(fieldOf(shown).props.placeholder, 'Leave empty to use 262,144');
  assert.match(text(shown), /Context window \(tokens\)/);
  // Only the window changed: it alone is sent, with the account the page read.
  fieldOf(shown).props.onChange({ target: { value: ' 200000 ' } });
  await nodes(form.render()).find((node) => node.tag === 'button' && text(node) === 'Save').props.onClick();
  assert.deepEqual(plain(page.posted('model/context-window').map((r) => r.body)),
    [{ expectedOrigin: ACCOUNT.origin, expectedAccountId: ACCOUNT.accountId, contextWindow: '200000' }]);
  assert.equal(page.posted('model').length, 0, 'the model is not saved again');
  assert.match(text(form.render()), /Saved\. It applies from the next turn\./);
  // The person's window: shown as set by them, in the field; emptied, it is cleared.
  form.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 200000, source: 'set', set: 200000, fallback: 262144 } } };
  shown = form.render();
  assert.equal(text(line(shown)), 'Context window: 200,000 tokens (set by you)');
  assert.equal(fieldOf(shown).props.value, '200000');
  fieldOf(shown).props.onChange({ target: { value: '' } });
  await nodes(form.render()).find((node) => node.tag === 'button' && text(node) === 'Save').props.onClick();
  assert.deepEqual(plain(page.posted('model/context-window').at(-1).body.contextWindow), '');
  // An assumed window says so and asks for the server's size.
  const assumed = page.mount(page.plugin.components.ModelForm, {});
  assumed.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 131072, source: 'assumed', fallback: 131072 } } };
  shown = assumed.render();
  assert.equal(text(line(shown)), 'Context window: 131,072 tokens (assumed: the model server did not report it)');
  assert.match(text(shown), new RegExp(PSC.PAGE.model.windowAssumed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A window too small for Rulith (a server's real one): the warning names the minimum and how to raise it.
  const tiny = page.mount(page.plugin.components.ModelForm, {});
  tiny.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 4096, source: 'detected', fallback: 4096, tooSmall: true, minimum: 85536 } } };
  shown = tiny.render();
  assert.equal(text(line(shown)), 'Context window: 4,096 tokens (detected from the model server)');
  assert.equal(text(warning(shown)), PSC.fill(PSC.PAGE.model.windowTooSmall, { min: '85,536' }));
  assert.match(text(warning(shown)), /at least 85,536 tokens.*llama\.cpp -c, Ollama num_ctx/);
  // The default, and the developer setting, by their names.
  for (const [source, words] of [['default', 'the default'], ['developer', 'from the settings file']]) {
    const other = page.mount(page.plugin.components.ModelForm, {});
    other.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 1000000, source, fallback: 1000000 } } };
    assert.equal(text(line(other.render())), `Context window: 1,000,000 tokens (${words})`);
  }
  // A model and its window changed together: the model first, then the window for the model now in force.
  const both = page.mount(page.plugin.components.ModelForm, {});
  both.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 131072, source: 'assumed', fallback: 131072 } } };
  shown = both.render();
  nodes(shown).filter((node) => node.tag === 'input')[1].props.onChange({ target: { value: 'qwen-next' } });
  fieldOf(both.render()).props.onChange({ target: { value: '96000' } });
  const before = page.requests.length;
  await nodes(both.render()).find((node) => node.tag === 'button' && text(node) === 'Save').props.onClick();
  await flush();
  assert.deepEqual(page.requests.slice(before).filter((r) => r.method === 'POST').map((r) => r.url), ['/rulith/api/model', '/rulith/api/model/context-window']);
  // No window from the host (no usable model, or an older host): no line, no field.
  const none = page.mount(page.plugin.components.ModelForm, {});
  none.cells[0] = { ok: true, model: { ...base, configured: false } };
  assert.equal(line(none.render()), undefined);
  assert.equal(fieldOf(none.render()), undefined);
  // Chinese: the same lines in the Chinese table.
  const zh = loadPage({ windowExtra: { navigator: { language: 'zh-CN' } } });
  assert.equal(zh.plugin.LOCALE, 'zh');
  const form2 = zh.mount(zh.plugin.components.ModelForm, {});
  form2.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 262144, source: 'detected', fallback: 262144 } } };
  assert.equal(text(line(form2.render())), '上下文窗口：262,144 token（从模型服务读到）');
  form2.cells[0] = { ok: true, model: { ...base, contextWindow: { tokens: 4096, source: 'detected', fallback: 4096, tooSmall: true, minimum: 85536 } } };
  assert.match(text(warning(form2.render())), /^Rulith 需要至少 85,536 token 的上下文窗口/);
});

// Installed dsh (this package's own dependency): the effective window is what dsh logs in request/context (the composer's
// context popover reads it), what compaction measures against (resolveModelInfo), and what the relief and compaction
// lines are computed from at the same step (board-transcript.mjs logs them). A window detected or set later reaches the
// route when the next turn starts, without a restart; a window too small for Rulith turns relief off and is logged once.
test('installed dsh: request/context, compaction and the logged context lines use the effective window, and follow a change at the next turn', async (t) => {
  const root = process.env.DSH_MODULES_DIR ? path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai')
    : fileURLToPath(new URL('../../../node_modules/@deepseek-ai/', import.meta.url));
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const kernel = ['cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent',
    'dsh-agent-loop', 'dsh-token-meter', 'dsh-compaction-basic'];
  const [cordis, ...plugins] = await Promise.all(['cordis', ...kernel].map(load));
  const { createUserMessage } = plugins[1];
  // One local server: llama.cpp's /props (once it is switched on) and Chat Completions answering "done".
  let props = [404, {}];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? '' });
      if (req.url.startsWith('/props')) { res.writeHead(props[0], { 'content-type': 'application/json' }); res.end(JSON.stringify(props[1])); return; }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
      const request = JSON.parse(body);
      const chunk = (choice) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [choice] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null })
        + chunk({ index: 0, delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const model = { source: 'default', url: `http://127.0.0.1:${server.address().port}/v1`, name: 'qwen', key: KEY };
  const ctx = new cordis.Context();
  const compaction = JSON.parse(contextEnv({ reliefRatio: 0.7, compactionRatio: 0.8 }).RULITH_DSH_COMPACTION);
  const config = { 'dsh-system-prompt': { includeHarnessIdentity: false, includeRuntimeContext: false }, 'dsh-agent-loop': { agents: [] },
    'dsh-compaction-basic': compaction };
  for (const [index, name] of kernel.entries()) await ctx.plugin(plugins[index].default, config[name] ?? {});
  const logged = [];
  installBoardTranscript({ on: (...args) => ctx.on(...args), llm: ctx.llm, logger: { info: (line) => logged.push(line), warn: () => {} } },
    { compaction: { thresholdRatio: compaction.thresholdRatio, headroomTokens: compaction.headroomTokens } });
  const dir = temp(t);
  const windows = createContextWindows({ file: path.join(dir, 'rulith-context-windows.json'), timeoutMs: 1000 });
  installLiveModels(ctx, { routeFor: () => ({ account: ACCOUNT, model }), windows });
  const handle = await ctx.agents.create({ sessionId: 'context-window-integration', agentOptions: { provider: 'rulith-model', model: 'launch-model' } });
  const session = handle.agent.session;
  const say = async (words) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  };
  const linesFor = (contextWindow) => contextLinesFor({ contextWindow, maxTokens: session.requestHeader()?.config?.maxTokens ?? 0,
    reliefRatio: 0.7, compaction });
  const linesLogged = (window) => logged.filter((line) => line.includes(`(window ${window}, `));
  try {
    // The server does not answer as an inference server yet: 1M, as before 0.19.3.
    await say('first');
    const provider = session.requestContext().provider;
    assert.match(provider, /^rulith-live-[0-9a-f]{12}$/);
    assert.equal(session.requestContext().contextWindow, 1_000_000);
    // The server now reports its slot (as after the app's start, or saving the model). A try the turn's start began is let
    // finish first.
    await windows.detect(model);
    props = [200, LLAMA_PROPS];
    assert.equal((await windows.detect(model)).tokens, 262144);
    await say('second');
    assert.equal(session.requestContext().contextWindow, 262144);
    assert.equal(session.requestContext().provider, provider, 'same route, no restart');
    assert.equal((await ctx.llm.resolveModelInfo(provider, 'qwen')).context.contextWindow, 262144, 'what compaction measures against');
    // The lines of that very turn's first step use it already (the route's window, as compaction does).
    const at262 = linesFor(262144);
    assert.ok(linesLogged(262144).some((line) => line.includes(`relief at ${at262.relief} tokens`) && line.endsWith(`dsh compacts at ${at262.compaction}`)),
      logged.join('\n'));
    // The person sets the window: the next turn uses it, and the lines follow at once.
    windows.set(model, 200000);
    await say('third');
    assert.equal(session.requestContext().contextWindow, 200000);
    assert.ok(linesLogged(200000).some((line) => line.includes(`relief at ${linesFor(200000).relief} tokens`)), logged.join('\n'));
    // The server is restarted with 32768 tokens, too small for Rulith: real, used, and relief is off, logged once.
    windows.set(model, null);
    props = [200, { default_generation_settings: { n_ctx: 32768 } }];
    assert.equal((await windows.detect(model)).tooSmall, true);
    await say('fourth');
    await say('fifth');
    assert.equal(session.requestContext().contextWindow, 32768);
    const none = linesLogged(32768);
    assert.equal(none.length, 1, none.join('\n'));
    assert.match(none[0], /none usable: the window is too small for context relief and compaction \(Rulith needs at least 85536 tokens\)/);
    // The key reached only the model's own server, as a Bearer token, and no log line.
    assert.ok(seen.every((request) => request.auth === `Bearer ${KEY}`), JSON.stringify(seen));
    assert.equal(logged.some((line) => line.includes(KEY)), false);
  } finally {
    await handle.dispose();
  }
});
