#!/usr/bin/env node
// Deep Rulith launcher, and the installed command. Takes its settings from this computer's settings file (paths only) or,
// with none, derives them from the app home (app-home.mjs); takes the model from Rulith's own model settings (the manager
// home), and starts dsh's web profile "rulith" with the Deep Rulith overlay. The model key travels only in the child's
// environment; it is never printed or written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { conversationBoards, contextEnv, contextLines, reviewerEnv, reviewerRequestExtra, reviewerRoutes, writeReviewerEnv } from './launcher-settings.mjs';
import { holdAppHome, launcherSettings } from './app-home.mjs';
import { managerListening, refreshGeneralKits } from '../kit-install.mjs';
import { webSearchKey } from '../web-tools.mjs';

// `args` are the launcher's own arguments: `--init` first, or dsh web flags (--no-open, --port ...).
const { settings: s, args, home } = await launcherSettings();
if (home) {
  await holdAppHome(home).catch((error) => { console.error(error.message); process.exit(1); });
  console.log(`Deep Rulith keeps its files in ${home}.`);
}
// The model settings live in a Rulith manager home: this one's, or another the settings name (modelHome).
const modelFile = path.join(s.modelHome ?? s.managerHome, 'model-defaults.json');
const defaults = fs.existsSync(modelFile) ? JSON.parse(fs.readFileSync(modelFile, 'utf8')).defaults ?? [] : [];
const model = defaults.find((row) => row.key && row.url && row.name) ?? null;
// An independent modelHome uses the same Rulith model-defaults format as the main route. Otherwise shadow follows
// the actual dsh request route, including a provider selected on the Models page; no separate key is needed.
// D-1013c: the Board review now runs on the platform (a reviewer Connection designated in Console), so the host-side
// shadow is off unless the settings turn it on with "shadow": {"enabled": true}.
const shadow = s.shadow ?? {};
const hostShadow = shadow.enabled === true;
let shadowModel = null;
if (hostShadow && shadow.modelHome) {
  const file = path.join(shadow.modelHome, 'model-defaults.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).defaults ?? [];
  shadowModel = rows.find((row) => row.key && row.url && row.name) ?? null;
  if (!shadowModel) throw new Error('Deep Rulith: no model is configured in shadow.modelHome');
}
const base = model ? model.url.replace(/\/+$/, '') : '';
// A model entry without maxTokens answers within the library's default output cap, and long tool arguments (a whole
// file) were cut off mid-call on 2026-10-14 ("已达到输出 token 上限"). Every provider's models get maxTokens 32768 unless
// the person set one on the Models page.
const MODEL_MAX_TOKENS = 32768;
// The two context lines (reliefRatio, compactionRatio; see context-relief.mjs): Deep Rulith relieves old results before
// dsh compacts. Ratios that are invalid in themselves refuse to start; the effective lines of each model route (window
// and output cap) are computed at run time and logged by board-transcript.mjs.
const lines = contextLines(s);
// The reviewer's request extra (reviewerThinking or reviewerRequestExtra; see launcher-settings.mjs). An invalid value, or a
// key the Worker controls, refuses to start, like the ratios above.
const reviewerExtra = reviewerRequestExtra(s);
const env = {
  ...process.env,
  DSH_HOME: s.dshHome, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
  RULITH_DSH_MANAGER_HOME: s.managerHome, RULITH_DSH_MANAGER_PORT: String(s.managerPort ?? 7790), RULITH_DSH_KEY_FILE: s.keyFile,
  RULITH_DSH_RUNTIME_ENTRY: s.runtimeEntry, RULITH_DSH_PERSONA: s.persona,
  ...(s.consoleUrl ? { RULITH_DSH_CONSOLE_URL: s.consoleUrl } : {}), ...(s.mcpUrl ? { RULITH_DSH_MCP_URL: s.mcpUrl } : {}), ...(s.agentName ? { RULITH_DSH_AGENT: s.agentName } : {}),
  RULITH_DSH_MODEL: model?.name ?? 'unset', RULITH_DSH_MODEL_BASE: base || 'http://127.0.0.1:9/unset',
  RULITH_MODEL_KEY: model?.key ?? '',
  // D-1015c: dsh's web_search searches through DeepSeek with this key; set only when Rulith's model is DeepSeek's own API
  // (web-tools.mjs). Without it the overlay leaves web_search unregistered and dsh starts as usual.
  RULITH_DSH_WEB_SEARCH_KEY: webSearchKey(model),
  RULITH_DSH_SHADOW: JSON.stringify({ enabled: hostShadow,
    provider: shadow.provider ?? (shadowModel ? 'rulith-shadow' : undefined), model: shadow.model ?? shadowModel?.name,
    maxTokens: shadow.maxTokens ?? 8000, timeoutMs: shadow.timeoutMs ?? 120_000 }),
  RULITH_SHADOW_MODEL_KEY: shadowModel?.key ?? '',
  ...contextEnv(lines),
  RULITH_DSH_CONVERSATION_BOARDS: conversationBoards(s) ? '1' : '0',
};
if (!env.RULITH_DSH_WEB_SEARCH_KEY) delete env.RULITH_DSH_WEB_SEARCH_KEY;
if (!model) console.error('Deep Rulith: no model is set in Rulith yet; set it under 更多设置 (Rulith workbench) and restart.');
// The local Worker is the platform reviewer's model route (D-1013f post-call advice). The managed host gives the Worker
// only its instance's worker.env, so on every start the route of the model dsh currently uses for the agent
// (agent-default-model: provider, model) is written there: its base URL, model id and key. The key comes from where dsh
// itself reads it (the Rulith model settings for rulith-model, the provider's apiKeyEnv in the process environment or in
// dsh's .credentials.yaml otherwise) and moves file to file, never printed. Designating the Connection as reviewer in
// Console is what turns the review on; the shadow therefore follows the model the person picked (owner 2026-10-14).
function writeReviewerRoute(YAML, doc) {
  const rows = YAML.isSeq(doc.contents) ? doc.contents.items : [];
  const row = (id) => rows.find((item) => YAML.isMap(item) && item.get('id') === id && !item.has('insert'));
  const chosen = row('agent-default-model');
  const routeEnv = (providerName, modelId, extra) => {
    const provider = row('llm-pi-ai')?.getIn(['config', 'providers', providerName]);
    const baseURL = YAML.isMap(provider) ? String(provider.get('baseURL') ?? '').replace(/\/+$/, '') : '';
    const keyEnv = YAML.isMap(provider) ? provider.get('apiKeyEnv') : undefined;
    let key = providerName === 'rulith-model' ? model?.key ?? '' : (keyEnv ? process.env[keyEnv] ?? '' : '');
    if (!key && keyEnv) {
      const credentials = path.join(s.dshHome, '.credentials.yaml');
      if (fs.existsSync(credentials)) key = String(YAML.parse(fs.readFileSync(credentials, 'utf8'))?.refs?.[keyEnv] ?? '');
    }
    return baseURL && modelId ? reviewerEnv({ baseURL, modelId, key, extra }) : null;
  };
  const overrides = reviewerRoutes(s).map((r) => {
    const env = routeEnv(r.provider, r.model, r.extra);
    if (!env) throw new Error(`Deep Rulith: reviewerRoutes provider ${r.provider} has no base URL in the dsh profile`);
    return { agentPrefix: r.agentPrefix, env };
  });
  const providerName = chosen?.getIn(['config', 'provider']) ?? 'rulith-model';
  const modelId = chosen?.getIn(['config', 'model']) ?? env.RULITH_DSH_MODEL;
  const provider = row('llm-pi-ai')?.getIn(['config', 'providers', providerName]);
  const baseURL = YAML.isMap(provider) ? String(provider.get('baseURL') ?? '').replace(/\/+$/, '') : '';
  const keyEnv = YAML.isMap(provider) ? provider.get('apiKeyEnv') : undefined;
  let key = providerName === 'rulith-model' ? model?.key ?? '' : (keyEnv ? process.env[keyEnv] ?? '' : '');
  if (!key && keyEnv) {
    const credentials = path.join(s.dshHome, '.credentials.yaml');
    if (fs.existsSync(credentials)) key = String(YAML.parse(fs.readFileSync(credentials, 'utf8'))?.refs?.[keyEnv] ?? '');
  }
  if (!baseURL || !modelId) return;
  // The reviewer's output cap (16000), timeout (300000 ms, the Gateway's maximum) and request extra (written when the settings
  // have reviewerThinking or reviewerRequestExtra, removed when they have neither) are explained in launcher-settings.mjs.
  writeReviewerEnv(s.managerHome, reviewerEnv({ baseURL, modelId, key, extra: reviewerExtra }), overrides);
}

const overlay = fileURLToPath(new URL('./rulith-web.cordis.yml', import.meta.url));
const profile = s.profile ?? 'rulith';
const profilePatch = path.join(s.dshHome, 'profiles', profile, 'cordis.patch.yml');

// 模型路线 rulith-model 写在 profile 自己的补丁层（cordis.patch.yml），不写在 overlay 里。原因有二：
// 一、dsh 的补丁按条目整段替换 config，overlay 排在最后，若由它设定 llm-pi-ai，人在模型页添加的提供商重启后就被整段覆盖；
// 二、模型页每次写入都校验全部提供商，读不懂 `!!js` 表达式，overlay 里的表达式会让添加任何提供商都失败。
// 所以每次启动只更新 rulith-model 这一条路线（取自 Rulith 的模型设置），人加的其他提供商原样保留；
// 默认模型只在人没有选过别的提供商时才指向 rulith-model。写入的只有模型名与地址，不是机密；密钥仍只经环境变量传入。
function writeModelRoute() {
  if (!fs.existsSync(profilePatch)) return;
  const YAML = createRequire(s.dshBin)('yaml'); // dsh 模型页写这个文件用的同一个库，注释与其他条目原样保留
  const doc = YAML.parseDocument(fs.readFileSync(profilePatch, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`Deep Rulith: ${profilePatch} is not valid YAML; fix it and restart`);
  if (!YAML.isSeq(doc.contents)) doc.contents = doc.createNode([]);
  const rows = doc.contents;
  const row = (id) => rows.items.find((item) => YAML.isMap(item) && item.get('id') === id && !item.has('insert'));
  const route = {
    api: 'openai-completions', apiKeyEnv: 'RULITH_MODEL_KEY', baseURL: env.RULITH_DSH_MODEL_BASE,
    compat: { thinkingFormat: 'deepseek' }, models: [{ id: env.RULITH_DSH_MODEL, contextWindow: 1000000, maxTokens: MODEL_MAX_TOKENS }],
  };
  let llm = row('llm-pi-ai');
  if (!llm) { llm = doc.createNode({ id: 'llm-pi-ai' }); rows.add(llm); }
  if (!YAML.isMap(llm.get('config'))) llm.set('config', doc.createNode({}));
  if (!YAML.isMap(llm.getIn(['config', 'providers']))) llm.setIn(['config', 'providers'], doc.createNode({}));
  llm.setIn(['config', 'providers', 'rulith-model'], doc.createNode(route));
  if (shadowModel) llm.setIn(['config', 'providers', 'rulith-shadow'], doc.createNode({
    ...route, apiKeyEnv: 'RULITH_SHADOW_MODEL_KEY', baseURL: shadowModel.url.replace(/\/+$/, ''),
    models: [{ id: shadow.model ?? shadowModel.name, contextWindow: 1000000 }],
  }));
  const chosen = row('agent-default-model');
  if (!chosen) rows.add(doc.createNode({ id: 'agent-default-model', config: { provider: 'rulith-model', model: env.RULITH_DSH_MODEL } }));
  else if (chosen.getIn(['config', 'provider']) === 'rulith-model') chosen.setIn(['config', 'model'], env.RULITH_DSH_MODEL);
  const providers = llm.getIn(['config', 'providers']);
  for (const pair of YAML.isMap(providers) ? providers.items : []) {
    const models = YAML.isMap(pair.value) ? pair.value.get('models') : undefined;
    for (const entry of YAML.isSeq(models) ? models.items : [])
      if (YAML.isMap(entry) && !entry.has('maxTokens')) entry.set('maxTokens', MODEL_MAX_TOKENS);
    // A provider the person added on the Models page may name no context window; compaction then triggers against the
    // library default instead of the server's real size. For a local OpenAI-compatible server (llama.cpp) the launcher
    // asks nothing and assumes nothing beyond what the person set: `localContextWindow` in deep-rulith.json
    // fills only entries that have none.
    if (s.localContextWindow && YAML.isMap(pair.value) && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(pair.value.get('baseURL') ?? '')))
      for (const entry of YAML.isSeq(models) ? models.items : [])
        if (YAML.isMap(entry) && !entry.has('contextWindow')) entry.set('contextWindow', s.localContextWindow);
  }
  const text = doc.toString();
  fs.writeFileSync(`${profilePatch}.tmp`, text);
  fs.renameSync(`${profilePatch}.tmp`, profilePatch);
  writeReviewerRoute(YAML, doc);
}

// The profile is created once from dsh's shipped web template: by `--init`, or by the first start without one (launcher
// flags must precede app flags such as --port). Every launch refreshes the product's browser plugin (a copy; no links),
// so upgrades do not keep the old UI.
const init = args[0] === '--init';
const syncBrowserPlugin = () => {
  const target = path.join(s.dshHome, 'profiles', profile, 'node_modules', 'rulith-dsh-ui');
  fs.cpSync(fileURLToPath(new URL('./rulith-dsh-ui', import.meta.url)), target, { recursive: true });
};
function createProfile() {
  const made = spawnSync(process.execPath, [s.dshBin, '--profile', profile, '--from-default-profile', 'web', '--patch', overlay, '--dump-config'],
    { cwd: s.cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (made.status !== 0) return made.status ?? 1;
  syncBrowserPlugin();
  writeModelRoute();
  console.log(`Deep Rulith profile "${profile}" created in ${s.dshHome}.`);
  return 0;
}
if (init) process.exit(createProfile());
if (!fs.existsSync(path.join(s.dshHome, 'profiles', profile, 'package.json'))) {
  const code = createProfile();
  if (code !== 0) process.exit(code);
}
// The kit refresh covers this launcher's own Agent (agentName) when the settings name one, else every paired Agent; an Agent
// whose Worker has no kit home yet gets `kitHome` when the settings have one (the app home's kit). A manager already
// listening on the port belongs to another launcher sharing this manager home; its Workers run on the files a refresh
// rewrites, so the refresh waits for a start that brings the manager up itself.
if (await managerListening(Number(s.managerPort ?? 7790)))
  console.error('Deep Rulith: a Rulith manager already runs on this port (another launcher); general kit refresh skipped.');
else refreshGeneralKits(s.managerHome, { agent: s.agentName, kitHome: s.kitHome });
syncBrowserPlugin(); writeModelRoute();
const child = spawn(process.execPath, [s.dshBin, '--profile', profile, '--patch', overlay, ...(s.webPort ? ['--port', String(s.webPort)] : []), ...args],
  { cwd: s.cwd, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
