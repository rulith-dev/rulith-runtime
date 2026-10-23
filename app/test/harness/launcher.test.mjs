import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conversationBoards, contextEnv, contextLines, REVIEWER_REQUEST_RESERVED_KEYS, reviewerEnv, reviewerRequestExtra, writeReviewerEnv }
  from '../../harness/web/launcher-settings.mjs';
import { COMPACTION_RATIO, COMPACTION_HEADROOM_TOKENS, COMPACTION_SUMMARY_MAX_TOKENS, RELIEF_MARGIN, RELIEF_RATIO, compactionLine,
  contextLinesFor } from '../../harness/web/context-relief.mjs';

// 启动器的配置管道：deep-rulith.json 的 reliefRatio／compactionRatio → 检查 → 环境变量 → rulith-web.cordis.yml
// （rulith-runtime 的减负线、dsh compaction-basic 的压缩配置）；以及写进 Worker 的审查路线（含 300 s 的超时）。

const web = fileURLToPath(new URL('../../harness/web/', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-launcher-'));

test('conversation Boards default on; the environment overrides the setting in both directions', () => {
  assert.equal(conversationBoards({}, {}), true);
  assert.equal(conversationBoards({ conversationBoards: true }, {}), true);
  assert.equal(conversationBoards({ conversationBoards: false }, {}), false);
  assert.equal(conversationBoards({}, { RULITH_DSH_CONVERSATION_BOARDS: '0' }), false);
  assert.equal(conversationBoards({ conversationBoards: true }, { RULITH_DSH_CONVERSATION_BOARDS: '0' }), false);
  assert.equal(conversationBoards({ conversationBoards: false }, { RULITH_DSH_CONVERSATION_BOARDS: '1' }), true);
  for (const bad of [null, 'false', 0, [], {}]) assert.throws(() => conversationBoards({ conversationBoards: bad }, {}), /must be a boolean/);
});

test('the context lines default to relief at 0.7 and compaction at 0.8 of the window, and relief must come first', () => {
  assert.deepEqual(contextLines({}), { reliefRatio: RELIEF_RATIO, compactionRatio: COMPACTION_RATIO });
  assert.deepEqual([RELIEF_RATIO, COMPACTION_RATIO], [0.7, 0.8]);
  assert.deepEqual(contextLines({ reliefRatio: 0.6, compactionRatio: 0.75 }), { reliefRatio: 0.6, compactionRatio: 0.75 });
  assert.throws(() => contextLines({ reliefRatio: 0.8 }), /reliefRatio \(0\.8\) must be below compactionRatio \(0\.8\)/);
  assert.throws(() => contextLines({ reliefRatio: 0.7, compactionRatio: 0.65 }), /must be below compactionRatio/);
  for (const bad of [0, 1, -0.5, '0.7', Number.NaN]) assert.throws(() => contextLines({ reliefRatio: bad }), /must be a number between 0 and 1/);
  assert.throws(() => contextLines({ compactionRatio: 1.2 }), /compactionRatio in the settings must be a number between 0 and 1/);
});

test('dsh compacts at compactionRatio x window once headroom no longer binds; a smaller window moves relief before the real line', () => {
  // dsh: min(window x thresholdRatio, window - request maxTokens - headroomTokens).
  assert.equal(compactionLine(262144, 0.8, 32768, 65536), 163840, 'the old default headroom bound at about 160K');
  assert.equal(compactionLine(262144, 0.8, 32768, COMPACTION_HEADROOM_TOKENS), Math.floor(0.8 * 262144));
  const launched = JSON.parse(contextEnv(contextLines({})).RULITH_DSH_COMPACTION);
  assert.deepEqual(contextLinesFor({ contextWindow: 262144, maxTokens: 32768, compaction: launched }), { relief: 183500, compaction: 209715 });
  // 131072: dsh compacts at 131072 - 32768 - 16384 = 81920, below 0.7 x 131072 = 91750; relief moves one step before it.
  assert.deepEqual(contextLinesFor({ contextWindow: 131072, maxTokens: 32768, compaction: launched }), { relief: 81920 - RELIEF_MARGIN, compaction: 81920 });
  // The route's own output cap counts: with a smaller one dsh compacts at 0.8 x window, and relief stays one step before it.
  assert.deepEqual(contextLinesFor({ contextWindow: 131072, maxTokens: 8192, compaction: launched }), { relief: 104857 - RELIEF_MARGIN, compaction: 104857 });
  // Without the launcher dsh keeps its own defaults (0.8, headroom 65536).
  assert.deepEqual(contextLinesFor({ contextWindow: 262144, maxTokens: 32768 }), { relief: 143840, compaction: 163840 });
  assert.equal(RELIEF_MARGIN, 20000);
});

test('the lines reach dsh through the environment the overlay reads', () => {
  const env = contextEnv({ reliefRatio: 0.65, compactionRatio: 0.85 });
  assert.equal(env.RULITH_DSH_RELIEF_RATIO, '0.65');
  assert.deepEqual(JSON.parse(env.RULITH_DSH_COMPACTION), { thresholdRatio: 0.85, headroomTokens: COMPACTION_HEADROOM_TOKENS,
    maxTokens: COMPACTION_SUMMARY_MAX_TOKENS });
  const overlay = fs.readFileSync(path.join(web, 'rulith-web.cordis.yml'), 'utf8');
  // Quoted: unquoted, the `: ` inside the expression makes YAML read a mapping.
  assert.match(overlay, /\n {8}reliefRatio: !!js 'process\.env\.RULITH_DSH_RELIEF_RATIO \? Number\(process\.env\.RULITH_DSH_RELIEF_RATIO\) : undefined'\n/);
  assert.match(overlay, /- id: compaction-basic\n {16}name: '@deepseek-ai\/dsh-compaction-basic'\n {16}config: !!js JSON\.parse\(process\.env\.RULITH_DSH_COMPACTION \|\| '\{\}'\)\n/);
  const runtime = fs.readFileSync(path.join(web, 'rulith-runtime.mjs'), 'utf8');
  assert.match(runtime, /installBoardTranscript\(ctx, \{ reliefRatio: config\.reliefRatio, compaction: config\.compaction \}\)/);
  assert.match(overlay, /\n {8}compaction: !!js JSON\.parse\(process\.env\.RULITH_DSH_COMPACTION \|\| '\{\}'\)\n/);
});

// Installed-dsh contract: the overlay read in dsh's entry-list YAML dialect and its `!!js` values evaluated by the
// installed loader's interpolate(), as at entry activation.
test('installed dsh: the overlay evaluates the relief ratio and the compaction config from the environment', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const yaml = createRequire(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))('js-yaml');
  const { interpolate } = await import(pathToFileURL(path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js')));
  // dsh-app-boot's entryListSchema: JSON_SCHEMA plus the `!!js` scalar.
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (data) => typeof data === 'string', construct: (data) => ({ __jsExpr: data }) });
  const rows = yaml.load(fs.readFileSync(path.join(web, 'rulith-web.cordis.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA.extend(js) }).find((row) => row.insert).insert;
  const runtime = rows.find((row) => row.id === 'rulith-runtime').config;
  const compaction = rows.find((row) => row.id === 'preset-rulith').config.plugins[0].config.find((row) => row.id === 'compaction-basic').config;
  const saved = { relief: process.env.RULITH_DSH_RELIEF_RATIO, compaction: process.env.RULITH_DSH_COMPACTION };
  try {
    delete process.env.RULITH_DSH_RELIEF_RATIO; delete process.env.RULITH_DSH_COMPACTION;
    assert.equal(interpolate({}, runtime).reliefRatio, undefined, 'without the launcher: the defaults');
    assert.deepEqual(interpolate({}, runtime).compaction, {});
    assert.deepEqual(interpolate({}, compaction), {});
    Object.assign(process.env, contextEnv({ reliefRatio: 0.65, compactionRatio: 0.85 }));
    const want = { thresholdRatio: 0.85, headroomTokens: COMPACTION_HEADROOM_TOKENS, maxTokens: COMPACTION_SUMMARY_MAX_TOKENS };
    assert.equal(interpolate({}, runtime).reliefRatio, 0.65);
    assert.deepEqual(interpolate({}, runtime).compaction, want, 'rulith-runtime reads the same compaction config as dsh');
    assert.deepEqual(interpolate({}, compaction), want);
  } finally {
    for (const [key, value] of [['RULITH_DSH_RELIEF_RATIO', saved.relief], ['RULITH_DSH_COMPACTION', saved.compaction]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// The launcher itself, with a stand-in for dsh that records the environment it was started with.
function launch(settings, modelDefaults, extraEnv = {}) {
  const dir = temp();
  const out = path.join(dir, 'dsh-env.json');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(fakeDsh, `import fs from 'node:fs';\nconst pick = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('RULITH_DSH_')));\nfs.writeFileSync(process.env.FAKE_DSH_OUT, JSON.stringify({ argv: process.argv.slice(2), env: pick }));\n`);
  const s = { dshBin: fakeDsh, dshHome: path.join(dir, 'dsh-home'), cwd: dir, managerHome: path.join(dir, 'manager-home'),
    keyFile: path.join(dir, 'key.txt'), runtimeEntry: path.join(dir, 'runtime.mjs'), persona: path.join(dir, 'persona.txt'), ...settings };
  fs.mkdirSync(s.managerHome, { recursive: true });
  if (modelDefaults) fs.writeFileSync(path.join(s.managerHome, 'model-defaults.json'), JSON.stringify({ defaults: modelDefaults }));
  const file = path.join(dir, 'deep-rulith.json');
  fs.writeFileSync(file, JSON.stringify(s));
  const env = { ...process.env, ...extraEnv, FAKE_DSH_OUT: out };
  if (!Object.hasOwn(extraEnv, 'RULITH_DSH_CONVERSATION_BOARDS')) delete env.RULITH_DSH_CONVERSATION_BOARDS;
  const run = spawnSync(process.execPath, [path.join(web, 'start-deep-rulith.mjs'), file], { env, encoding: 'utf8', timeout: 30_000 });
  const started = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, started };
}

test('the launcher passes conversationBoards to the runtime and rejects invalid settings before dsh starts', () => {
  for (const [settings, env, expected] of [[{}, {}, '1'], [{ conversationBoards: false }, {}, '0'],
    [{ conversationBoards: true }, { RULITH_DSH_CONVERSATION_BOARDS: '0' }, '0'],
    [{ conversationBoards: false }, { RULITH_DSH_CONVERSATION_BOARDS: '1' }, '1']]) {
    const ok = launch(settings, undefined, env);
    assert.equal(ok.run.status, 0, ok.run.stderr);
    assert.equal(ok.started.env.RULITH_DSH_CONVERSATION_BOARDS, expected);
  }
  const refused = launch({ conversationBoards: 'false' });
  assert.notEqual(refused.run.status, 0);
  assert.match(refused.run.stderr, /conversationBoards in the settings must be a boolean/);
  assert.equal(refused.started, null);
});

test('reviewerThinking and reviewerRequestExtra become the reviewer request extra; anything else is refused', () => {
  assert.equal(reviewerRequestExtra({}), undefined, 'absent: send nothing');
  assert.equal(reviewerRequestExtra({ reviewerThinking: false }), '{"chat_template_kwargs":{"enable_thinking":false}}');
  assert.equal(reviewerRequestExtra({ reviewerThinking: true }), '{"chat_template_kwargs":{"enable_thinking":true}}');
  for (const level of ['low', 'medium', 'high']) {
    assert.deepEqual(JSON.parse(reviewerRequestExtra({ reviewerThinking: level })),
      { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: level });
  }
  for (const bad of ['max', 'true', 'High', 1, 0, null, {}, []]) {
    assert.throws(() => reviewerRequestExtra({ reviewerThinking: bad }),
      /reviewerThinking in the settings must be false, true, "low", "medium" or "high"/, JSON.stringify(bad));
  }
  // The raw object is written as it is and takes precedence over reviewerThinking.
  const raw = { chat_template_kwargs: { enable_thinking: true, thinking_budget: 4096 } };
  assert.equal(reviewerRequestExtra({ reviewerThinking: false, reviewerRequestExtra: raw }), JSON.stringify(raw));
  assert.equal(reviewerRequestExtra({ reviewerRequestExtra: {} }), '{}');
  for (const bad of [null, [], 'text', 42, true]) {
    assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: bad }), /reviewerRequestExtra in the settings must be a JSON object/);
  }
  assert.deepEqual(REVIEWER_REQUEST_RESERVED_KEYS, ['model', 'messages', 'max_tokens', 'temperature', 'stream', 'tools', 'tool_choice', 'n']);
  for (const key of REVIEWER_REQUEST_RESERVED_KEYS) {
    assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: { [key]: 1, chat_template_kwargs: {} } }),
      { message: `Deep Rulith: reviewerRequestExtra in the settings may not set ${key}; the Worker controls it` });
  }
  assert.throws(() => reviewerRequestExtra({ reviewerRequestExtra: { stream: true, n: 2 } }), /may not set stream, n; the Worker controls them/);
});

test('the request extra is written beside the other reviewer keys and removed when the settings no longer have it', () => {
  const home = temp();
  fs.mkdirSync(path.join(home, 'instances', 'on'), { recursive: true });
  const file = path.join(home, 'instances', 'on', 'local.json');
  fs.writeFileSync(file, JSON.stringify({ worker: { enabled: true, env: { RULITH_TOOLS_FILE: 'tools.json' } } }));
  const route = { baseURL: 'http://127.0.0.1:8091/v1', modelId: 'qwen', key: 'k' };
  const thinking = reviewerEnv({ ...route, extra: reviewerRequestExtra({ reviewerThinking: 'high' }) });
  assert.equal(writeReviewerEnv(home, thinking), 1);
  const env = () => JSON.parse(fs.readFileSync(file, 'utf8')).worker.env;
  assert.equal(env().RULITH_REVIEWER_REQUEST_EXTRA, '{"chat_template_kwargs":{"enable_thinking":true},"reasoning_effort":"high"}');
  assert.equal(env().RULITH_REVIEWER_MODEL, 'qwen');
  assert.equal(writeReviewerEnv(home, thinking), 0, 'already written: nothing to do');
  const off = reviewerEnv({ ...route, extra: reviewerRequestExtra({ reviewerThinking: false }) });
  assert.equal(writeReviewerEnv(home, off), 1);
  assert.equal(env().RULITH_REVIEWER_REQUEST_EXTRA, '{"chat_template_kwargs":{"enable_thinking":false}}');
  const absent = reviewerEnv({ ...route, extra: reviewerRequestExtra({}) });
  assert.equal(writeReviewerEnv(home, absent), 1);
  assert.equal(Object.hasOwn(env(), 'RULITH_REVIEWER_REQUEST_EXTRA'), false, 'neither setting: the key is removed');
  assert.equal(env().RULITH_TOOLS_FILE, 'tools.json');
  assert.equal(writeReviewerEnv(home, absent), 0, 'already absent: nothing to do');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the launcher refuses to start on an invalid reviewerThinking or a reviewerRequestExtra with a key the Worker controls', () => {
  for (const [settings, message] of [
    [{ reviewerThinking: 'max' }, /reviewerThinking in the settings must be false, true, "low", "medium" or "high" \(got "max"\)/],
    [{ reviewerRequestExtra: ['x'] }, /reviewerRequestExtra in the settings must be a JSON object/],
    [{ reviewerThinking: true, reviewerRequestExtra: { max_tokens: 9 } }, /reviewerRequestExtra in the settings may not set max_tokens/],
  ]) {
    const refused = launch(settings);
    assert.notEqual(refused.run.status, 0);
    assert.match(refused.run.stderr, message);
    assert.equal(refused.started, null, 'dsh is not started');
  }
  for (const settings of [{ reviewerThinking: 'low' }, { reviewerRequestExtra: { chat_template_kwargs: { enable_thinking: true } } }]) {
    const ok = launch(settings);
    assert.equal(ok.run.status, 0, ok.run.stderr);
  }
});

test('the launcher passes the context lines to dsh, and refuses to start when relief is not below compaction', () => {
  const ok = launch({ reliefRatio: 0.65, compactionRatio: 0.85, localContextWindow: 262144 });
  assert.equal(ok.run.status, 0, ok.run.stderr);
  assert.equal(ok.started.env.RULITH_DSH_RELIEF_RATIO, '0.65');
  assert.equal(JSON.parse(ok.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.85);
  // A small local window is not refused: the relief line is moved before dsh's real compaction line at run time.
  const defaults = launch({ localContextWindow: 131072 });
  assert.equal(defaults.run.status, 0, defaults.run.stderr);
  assert.equal(defaults.started.env.RULITH_DSH_RELIEF_RATIO, '0.7');
  assert.equal(JSON.parse(defaults.started.env.RULITH_DSH_COMPACTION).thresholdRatio, 0.8);
  const refused = launch({ reliefRatio: 0.9 });
  assert.notEqual(refused.run.status, 0);
  assert.match(refused.run.stderr, /reliefRatio \(0\.9\) must be below compactionRatio \(0\.8\)/);
  assert.equal(refused.started, null, 'dsh is not started');
});

test("the platform reviewer's route in each enabled Worker's worker.env drops the old 300 s timeout", () => {
  const home = temp();
  const instance = (name, local) => {
    fs.mkdirSync(path.join(home, 'instances', name), { recursive: true });
    if (local) fs.writeFileSync(path.join(home, 'instances', name, 'local.json'), JSON.stringify(local));
  };
  instance('on', { worker: { enabled: true, env: { RULITH_TOOLS_FILE: 'tools.json', RULITH_REVIEWER_MAX_TOKENS: '8000', RULITH_REVIEWER_TIMEOUT_MS: '300000' } }, agent: { env: { RULITH_TOKEN: 't' } } });
  instance('off', { worker: { enabled: false, env: {} } });
  instance('empty', null);
  const want = reviewerEnv({ baseURL: 'http://127.0.0.1:8091/v1', modelId: 'qwen', key: 'k' });
  assert.deepEqual(want, { RULITH_REVIEWER_URL: 'http://127.0.0.1:8091/v1/chat/completions', RULITH_REVIEWER_MODEL: 'qwen',
    RULITH_REVIEWER_KEY: 'k', RULITH_REVIEWER_MAX_TOKENS: '16000', RULITH_REVIEWER_TIMEOUT_MS: undefined,
    RULITH_REVIEWER_REQUEST_EXTRA: undefined });
  assert.equal(writeReviewerEnv(home, want), 1);
  const on = JSON.parse(fs.readFileSync(path.join(home, 'instances', 'on', 'local.json'), 'utf8'));
  assert.deepEqual(on.worker.env, { RULITH_TOOLS_FILE: 'tools.json', RULITH_REVIEWER_URL: want.RULITH_REVIEWER_URL,
    RULITH_REVIEWER_MODEL: 'qwen', RULITH_REVIEWER_KEY: 'k', RULITH_REVIEWER_MAX_TOKENS: '16000' });
  assert.deepEqual(on.agent, { env: { RULITH_TOKEN: 't' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'instances', 'off', 'local.json'), 'utf8')).worker.env, {});
  assert.equal(writeReviewerEnv(home, want), 0, 'already written: nothing to do');
  fs.rmSync(home, { recursive: true, force: true });
});

test('reviewerRoutes send instances of matching Agents to another reviewer route', async () => {
  const { reviewerRoutes } = await import('../../harness/web/launcher-settings.mjs');
  assert.deepEqual(reviewerRoutes({}), []);
  assert.throws(() => reviewerRoutes({ reviewerRoutes: [{ agentPrefix: 'x' }] }), /agentPrefix, provider and model/);
  assert.deepEqual(reviewerRoutes({ reviewerRoutes: [{ agentPrefix: 'bench-h-', provider: 'p', model: 'm', reviewerThinking: true }] }),
    [{ agentPrefix: 'bench-h-', provider: 'p', model: 'm', extra: JSON.stringify({ chat_template_kwargs: { enable_thinking: true } }) }]);
  const home = temp();
  for (const [id, name] of [['inst-a', 'bench-h-one'], ['inst-b', 'bench-q-two']]) {
    fs.mkdirSync(path.join(home, 'instances', id), { recursive: true });
    fs.writeFileSync(path.join(home, 'instances', id, 'local.json'), JSON.stringify({ worker: { enabled: true, env: {} } }));
  }
  fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify({ instances: [{ id: 'inst-a', name: 'bench-h-one', agentName: 'bench-h-one' }, { id: 'inst-b', name: 'bench-q-two', agentName: 'bench-q-two' }] }));
  const def = reviewerEnv({ baseURL: 'http://local/v1', modelId: 'qwen', key: 'k1' });
  const alt = reviewerEnv({ baseURL: 'https://api.example/v1', modelId: 'ds', key: 'k2' });
  assert.equal(writeReviewerEnv(home, def, [{ agentPrefix: 'bench-h-', env: alt }]), 2);
  const read = (id) => JSON.parse(fs.readFileSync(path.join(home, 'instances', id, 'local.json'), 'utf8')).worker.env;
  assert.equal(read('inst-a').RULITH_REVIEWER_MODEL, 'ds');
  assert.equal(read('inst-b').RULITH_REVIEWER_MODEL, 'qwen');
});

// D-1015c: dsh's web_search searches through DeepSeek. The launcher passes the model's key for it only when Rulith's model
// is DeepSeek's own API; otherwise web_search is not registered (the overlay reads the variable) and dsh starts as usual.
test('the launcher passes a web search key only for a DeepSeek model, never prints it, and starts without one', () => {
  const key = 'test-deepseek-key-0123456789';
  const deepseek = launch({}, [{ name: 'deepseek-chat', url: 'https://api.deepseek.com/v1', key }]);
  assert.equal(deepseek.run.status, 0, deepseek.run.stderr);
  assert.equal(deepseek.started.env.RULITH_DSH_WEB_SEARCH_KEY, key);
  assert.ok(!deepseek.run.stdout.includes(key) && !deepseek.run.stderr.includes(key), 'the key is not printed');
  for (const [label, defaults] of [['local engine', [{ name: 'qwen', url: 'http://127.0.0.1:8080/v1', key }]],
    ['another provider', [{ name: 'gpt', url: 'https://api.openai.com/v1', key }]], ['no model', undefined]]) {
    const started = launch({}, defaults);
    assert.equal(started.run.status, 0, `${label}: ${started.run.stderr}`);
    assert.equal(Object.hasOwn(started.started.env, 'RULITH_DSH_WEB_SEARCH_KEY'), false, `${label}: web_search is not offered`);
  }
  // The overlays name only the variable; no key is written into either file.
  for (const file of ['rulith-web.cordis.yml', '../rulith.cordis.yml']) {
    const overlay = fs.readFileSync(path.join(web, file), 'utf8');
    assert.match(overlay, /- id: web-search-deepseek\n {2}config:\n {4}apiKeyEnv: RULITH_DSH_WEB_SEARCH_KEY\n(?: {4}#.*\n)? {4}baseURL: https:\/\/api\.deepseek\.com\/anthropic\/v1\n/);
    assert.match(overlay, /\n {4}search: !!js '!!process\.env\.RULITH_DSH_WEB_SEARCH_KEY'\n {4}fetch: true\n/);
    assert.doesNotMatch(overlay, /- id: (web|web-fetch-http|web-search-deepseek|tool-web)\n {2}disabled: true/);
    for (const id of ['tool-fs', 'tool-fs-search', 'fs-observation-policy', 'tool-bash', 'tool-pwsh', 'tool-jobs'])
      assert.match(overlay, new RegExp(`- id: ${id}\n {2}disabled: true\n`), id);
  }
});

// D-1016a fix 1: a launcher refreshes the general kit only for its own Agent, and not at all while another launcher's
// manager serves the port. A stand-in Runtime records each installer call; nothing real is installed or started.
test('the launcher refreshes only its own Agent and skips the refresh while a manager already listens', async () => {
  const net = await import('node:net');
  const dir = temp();
  try {
    const runtime = path.join(dir, 'runtime'), calls = path.join(dir, 'calls.txt');
    fs.mkdirSync(path.join(runtime, 'local'), { recursive: true }); fs.mkdirSync(path.join(runtime, 'kits', 'general'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'kits', 'general', 'installer.mjs'), '');
    fs.writeFileSync(path.join(runtime, 'local', 'rulith-local.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(process.env.FAKE_INSTALL_OUT, process.argv[6] + '\\n');\n`);
    const managerHome = path.join(dir, 'manager-home');
    const instances = ['mine', 'other'].map((agentName) => {
      const directory = path.join(dir, agentName); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'local.json'), JSON.stringify({ worker: { env: {
        ENG_KIT_HOME: path.join(dir, `${agentName}-pins`), RULITH_WORKER_ROOT: directory, RULITH_TOOLS_FILE: path.join(directory, 'tools.json') } } }));
      return { mode: 'local_agent', agentName, directory };
    });
    fs.mkdirSync(managerHome);
    fs.writeFileSync(path.join(managerHome, 'registry.json'), JSON.stringify({ instances }));
    const fakeDsh = path.join(dir, 'fake-dsh.mjs'); fs.writeFileSync(fakeDsh, '');
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const managerPort = server.address().port;
    const file = path.join(dir, 'deep-rulith.json');
    fs.writeFileSync(file, JSON.stringify({ dshBin: fakeDsh, dshHome: path.join(dir, 'dsh-home'), cwd: dir, managerHome, managerPort,
      keyFile: path.join(dir, 'key.txt'), runtimeEntry: path.join(dir, 'runtime.mjs'), persona: path.join(dir, 'persona.txt'), agentName: 'mine' }));
    const env = { ...process.env, RULITH_RUNTIME_DIR: runtime, FAKE_INSTALL_OUT: calls };
    const start = () => new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, [path.join(web, 'start-deep-rulith.mjs'), file],
        { env, encoding: 'utf8', timeout: 30_000 }, (error, _stdout, stderr) => resolve({ error, stderr })));
    });
    const busy = await start();
    assert.equal(busy.error, null, busy.stderr);
    assert.match(busy.stderr, /another launcher\); general kit refresh skipped/);
    assert.equal(fs.existsSync(calls), false);
    await new Promise((resolve) => server.close(resolve));
    const free = await start();
    assert.equal(free.error, null, free.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'mine\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
