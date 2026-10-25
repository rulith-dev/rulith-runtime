#!/usr/bin/env node
// Deep Rulith launcher, and the installed command. Takes its settings from this computer's settings file (paths only) or,
// with none, derives them from the app home (app-home.mjs), and starts dsh's web profile "rulith" with the Deep Rulith
// overlay. Which model a conversation uses is decided at every turn by the host half from Rulith's own model settings for
// the account signed in then (web/model-runtime.mjs, PSC 0.2.27 ④); the launcher only names the signed-in account's
// default model as the profile's default route, without its key, and never prints or writes a key.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { conversationBoards, contextEnv, contextLines, localContextWindow, reviewerEnv, reviewerRequestExtra, reviewerRoutes, writeReviewerEnv } from './launcher-settings.mjs';
import { holdAppHome, launcherSettings, settingsCredentialRoots } from './app-home.mjs';
import { webSearchKey } from '../web-tools.mjs';
import { attachedAgents, effectiveModel, modelLine, signedInAccount } from './model-runtime.mjs';
import { credentialRootRefusal, ensureCredentialRootLabels } from '../../../local/sandbox-home-label.mjs';

// `args` are the launcher's own arguments: `--init` first, or dsh web flags (--no-open, --port ...).
const { settings: s, args, home } = await launcherSettings();
if (home) {
  await holdAppHome(home).catch((error) => { console.error(error.message); process.exit(1); });
  console.log(`Deep Rulith keeps its files in ${home}.`);
} else {
  // 模型命令隔离（D-1024a）：设置文件模式下没有 app home 的整体标签，所以 App 自己给它管的凭据位置打标签：dsh home（会话
  // 凭据 .credentials.yaml）与设置里点名的另一个模型设置目录（modelHome，存模型密钥）整个目录，以及设置里点名的管理器
  // 密钥文件（可以在任意位置，单个文件也是凭据根）。这几项同时交给管理器（RULITH_CREDENTIAL_ROOTS，见下），由它和实例宿主
  // 补标签、由启动器在每条命令前核验；打不上就拒绝运行模型命令（fail-closed），这里只如实说明。管理器 home 由管理器自己打。
  const refusal = credentialRootRefusal(ensureCredentialRootLabels(settingsCredentialRoots(s)));
  if (refusal) console.error(`Rulith: ${refusal}`);
}
// The model settings live in a Rulith manager home: this one's, or another the settings name (modelHome, developers). Only
// the row of the account signed in counts (account isolation, SYS-LOCAL-01), never the first row of the file; a
// modelHome's rows are matched against the account signed in to that home, the account they were saved for, while this
// computer's own sign-in is still required (model-runtime.mjs effectiveModel).
const account = signedInAccount(s.managerHome);
const modelHome = s.modelHome ? path.resolve(s.modelHome) : '';
const defaultOf = (home) => {
  const found = effectiveModel({ home: s.managerHome, modelHome: home }, account);
  return found.url && found.name ? found : null;
};
const model = defaultOf(modelHome);
// An independent modelHome uses the same Rulith model-defaults format as the main route. Otherwise shadow follows
// the actual dsh request route, including a provider selected on the Models page; no separate key is needed.
// D-1013c: the Board review now runs on the platform (a reviewer Connection designated in Console), so the host-side
// shadow is off unless the settings turn it on with "shadow": {"enabled": true}.
const shadow = s.shadow ?? {};
const hostShadow = shadow.enabled === true;
let shadowModel = null;
if (hostShadow && shadow.modelHome) {
  shadowModel = defaultOf(path.resolve(shadow.modelHome));
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
// The context window of a model on this computer (a loopback endpoint), when the settings name one; invalid refuses to start.
const localWindow = localContextWindow(s);
const env = {
  ...process.env,
  DSH_HOME: s.dshHome, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
  RULITH_DSH_MANAGER_HOME: s.managerHome, RULITH_DSH_MANAGER_PORT: String(s.managerPort ?? 7790), RULITH_DSH_KEY_FILE: s.keyFile,
  RULITH_DSH_RUNTIME_ENTRY: s.runtimeEntry, RULITH_DSH_PERSONA: s.persona,
  ...(s.consoleUrl ? { RULITH_DSH_CONSOLE_URL: s.consoleUrl } : {}), ...(s.mcpUrl ? { RULITH_DSH_MCP_URL: s.mcpUrl } : {}), ...(s.agentName ? { RULITH_DSH_AGENT: s.agentName } : {}),
  RULITH_DSH_MODEL: model?.name ?? 'unset', RULITH_DSH_MODEL_BASE: base || 'http://127.0.0.1:9/unset',
  // The profile's route rulith-model is only the default a new conversation starts from: every turn is routed to the live
  // Rulith model (web/model-runtime.mjs), whose key stays in memory. This variable is therefore empty, so nothing can
  // reach a model with a key captured at launch, for example after the account was switched.
  RULITH_MODEL_KEY: '',
  // D-1015c: dsh's web_search searches through DeepSeek; offered when the signed-in account's model is DeepSeek's own API
  // (web-tools.mjs). Only a flag: the key is resolved per search from the turn's model (model-runtime.mjs).
  RULITH_DSH_WEB_SEARCH_KEY: webSearchKey(model) ? '1' : '',
  // Where a new Agent's general kit home goes (the app home's kit), and another home's model defaults (developers).
  ...(s.kitHome ? { RULITH_DSH_KIT_HOME: path.resolve(s.kitHome) } : {}),
  ...(modelHome ? { RULITH_DSH_MODEL_HOME: modelHome } : {}),
  // The live route of a loopback model takes this window (model-runtime.mjs liveRoute), as the profile's routes did.
  ...(localWindow ? { RULITH_DSH_LOCAL_CONTEXT_WINDOW: String(localWindow) } : {}),
  RULITH_DSH_SHADOW: JSON.stringify({ enabled: hostShadow,
    provider: shadow.provider ?? (shadowModel ? 'rulith-shadow' : undefined), model: shadow.model ?? shadowModel?.name,
    maxTokens: shadow.maxTokens ?? 8000, timeoutMs: shadow.timeoutMs ?? 120_000 }),
  RULITH_SHADOW_MODEL_KEY: shadowModel?.key ?? '',
  ...contextEnv(lines),
  RULITH_DSH_CONVERSATION_BOARDS: conversationBoards(s) ? '1' : '0',
  // 模型命令隔离（D-1024a）：产品默认要求隔离（Windows 低完整性 / Linux bwrap），由 Worker 在启动适配器时落实（见
  // worker/adapter-confinement.mjs）；引擎把隔离设为默认开，无需这里再设 RULITH_ADAPTER_SANDBOX。这里把运行配置真正用到的
  // 凭据根（app home、manager home、dsh home）交给管理器，它据此给每个根打标签并转交给 Worker，供 confinedLaunch 逐个校验；
  // 设置文件模式与无设置文件模式都适用（两种模式下这几个位置都要遮住）。
  // The app's credential roots the manager also protects and the Worker verifies before every command: the dsh home, a
  // modelHome the settings name (another manager home, holding model keys) and the manager key file; in no-settings mode
  // the app home (which holds all of them) as well. A settings-file location is not assumed to be Rulith's own directory.
  RULITH_CREDENTIAL_ROOTS: JSON.stringify([...new Set([...settingsCredentialRoots(s), ...(home ? [home] : [])].map((p) => path.resolve(p)))]),
};
if (!env.RULITH_DSH_WEB_SEARCH_KEY) delete env.RULITH_DSH_WEB_SEARCH_KEY;
if (!model) console.error('Deep Rulith: no model is set for the signed-in Rulith account yet; once one is saved, it is used from the next turn.');
// Which model each Agent attached here uses now (its own model, or the account default), so a wrong selection shows at
// once: where it comes from, the model id and the endpoint. Never a key, nor whether there is one.
// 中文说明：启动时逐个打印本机已接上的 Agent 此刻所用的模型（来源、模型 ID、地址），不打印密钥。
for (const agent of attachedAgents(s.managerHome, account))
  console.log(modelLine(agent.name, effectiveModel({ home: s.managerHome, modelHome }, account, agent.agentId)));
// The local Worker is the platform reviewer's model route (D-1013f post-call advice). Since PSC 0.2.27 ④ the Runtime gives
// each local Agent's Worker that Agent's own model as its reviewer route at every Worker start (local/rulith-local.mjs), so
// a saved model change reaches it at the Worker's next reload, and one account's key is never copied into another's
// instances. So the launcher no longer writes a default route: it removes the one earlier launchers wrote into every
// instance, and writes only what the settings ask for explicitly — reviewerRoutes for Agents of a name prefix (a provider
// of the dsh profile; its key from where dsh reads it, file to file, never printed) and the reviewer request extra.
// Designating the Connection as reviewer in Console is what turns the review on.
function writeReviewerRoute(YAML, doc) {
  const rows = YAML.isSeq(doc.contents) ? doc.contents.items : [];
  const row = (id) => rows.find((item) => YAML.isMap(item) && item.get('id') === id && !item.has('insert'));
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
  // The default: no route of the launcher's own (the Runtime derives it), only the request extra (launcher-settings.mjs).
  writeReviewerEnv(s.managerHome, { RULITH_REVIEWER_URL: undefined, RULITH_REVIEWER_MODEL: undefined, RULITH_REVIEWER_KEY: undefined,
    RULITH_REVIEWER_MAX_TOKENS: undefined, RULITH_REVIEWER_TIMEOUT_MS: undefined, RULITH_REVIEWER_REQUEST_EXTRA: reviewerExtra }, overrides);
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
    if (localWindow && YAML.isMap(pair.value) && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(pair.value.get('baseURL') ?? '')))
      for (const entry of YAML.isSeq(models) ? models.items : [])
        if (YAML.isMap(entry) && !entry.has('contextWindow')) entry.set('contextWindow', localWindow);
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
// The general kit is refreshed by the host half once it reaches the manager (kit-install.mjs), through the manager's own
// setup operation, whether this launcher started the manager or another one did.
syncBrowserPlugin(); writeModelRoute();
const child = spawn(process.execPath, [s.dshBin, '--profile', profile, '--patch', overlay, ...(s.webPort ? ['--port', String(s.webPort)] : []), ...args],
  { cwd: s.cwd, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
