// The model the app's conversations use, read live from Rulith's own model settings (PSC 0.2.27 ④, SYS-LOCAL-01).
//
// Rulith keeps one account default per signed-in account and, per Agent, an optional override (the Runtime manager owns
// both: local/model-settings.mjs, local/instance-manager.mjs). Here, at the start of every turn, dsh's request is routed
// to the model in force for that conversation's Agent under the account signed in now, so a model saved in the app is
// used from the next turn on, without a restart; a turn already running finishes on the model it started with.
// The key never leaves this process: it is held in memory by the adapter of its route and by the web-search key
// resolver, and it is written to no profile YAML, environment file, log, browser reply or session record.
//
// 中文说明：每一轮开始时，按"此刻登录的账户 + 这个会话的 Agent"读 Rulith 的模型设置（账户默认值或该 Agent 的明确覆盖），
// 把 dsh 这一轮的请求改走这条路线；保存后的设置从下一轮起生效，进行中的一轮用它开始时的设置完成。密钥只在本进程内存里，
// 不写进 profile、日志、浏览器或会话记录。换账户后读的是新账户的设置，不会用到前一账户的密钥。
//
// Invariants (审计要点):
//   1. Account isolation: settings are read only for the account of this computer's device record (`signedInAccount`);
//      signed out, there is no model. Another account's row is never a fallback. A developer launcher that reads the
//      account defaults of another manager home (`modelHome`) matches them against that home's own device record.
//      A conversation's turns use only its own Agent's model: when that Agent is not set up here under the account
//      signed in now, the turn is refused, not sent to that account's default (`conversationModel`).
//   2. One turn, one route: the route is chosen when the turn starts — before dsh's step compaction runs — and reused for
//      that turn's later steps. Compaction and title requests of a conversation go to that same route (or, between turns,
//      to the route in force now), never to an older route the conversation's log names.
//   3. Stable routes: a provider id names an endpoint, protocol and model (a hash of those, never of the key); a key
//      change under the same id, or another account, gets a new generation suffix, so the running turn keeps the key it
//      started with. Routes of an account that is no longer signed in are unregistered: their keys leave memory, and a
//      turn of that account still running stops at its next model request.
//   4. A provider id an earlier run of this process logged (it is unregistered after a restart, or after an account
//      switch) is answered by the conversation's current route, so dsh's compaction can still measure the conversation.
//      Such an id is never registered for a route as well: a generation an alias holds is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDeviceClient } from '../../../local/device-client.mjs';
import { isLoopback, modelEndpoint, modelReady } from '../../../local/model-settings.mjs';
import { webSearchKey } from '../web-tools.mjs';
import { say } from './ui-texts.mjs';

/** Output cap of every Rulith model route in dsh: long tool arguments were cut off below it (2026-10-14). */
export const MODEL_MAX_TOKENS = 32768;
const DISPLAY_NAME = 'Rulith model';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(say('model.unreadable'));
  }
};
const text = (value) => (typeof value === 'string' ? value : '');

/** The account this computer is signed in to, from the manager home's device record; null when signed out. */
export function signedInAccount(home) {
  const device = createDeviceClient({ root: home }).status();
  return device.state === 'linked' && text(device.origin) && device.account?.id
    ? { origin: device.origin, accountId: String(device.account.id) } : null;
}

/**
 * The model in force for `agentId` (or the account default when none) under `account`, as the Runtime resolves it:
 * an instance whose model source is not `default` uses its own configured model (its override); every other case uses
 * the account's default row. `modelHome` names another manager home whose defaults this launcher reads (developers):
 * its rows are matched against the account signed in *there* (its own device record), the account they were saved for;
 * this computer's own sign-in (`account`) is still required. Returns `{source, url, name, key}`; the key is for this
 * process only.
 */
export function effectiveModel({ home, modelHome }, account, agentId) {
  if (!account) return { source: 'default', url: '', name: '', key: '' };
  if (agentId) {
    const row = (readJson(path.join(home, 'registry.json'))?.instances ?? []).find((entry) => !entry.signedOutAt
      && entry.mode === 'local_agent' && entry.agentId === agentId && entry.origin === account.origin && entry.accountId === account.accountId);
    if (row && row.modelSource !== 'default') {
      const env = readJson(path.join(row.directory, 'local.json'))?.agent?.env ?? {};
      return { source: 'override', url: text(env.RULITH_MODEL_URL), name: text(env.RULITH_MODEL), key: text(env.RULITH_MODEL_KEY) };
    }
  }
  const owner = modelHome ? signedInAccount(modelHome) : account;
  const row = owner === null ? undefined : (readJson(path.join(modelHome || home, 'model-defaults.json'))?.defaults ?? [])
    .find((entry) => entry?.origin === owner.origin && entry?.accountId === owner.accountId);
  return { source: 'default', url: text(row?.url), name: text(row?.name), key: text(row?.key) };
}

/**
 * The model a conversation's turns use (invariant 1): the model in force for the conversation's own Agent, `agentId`,
 * under the account signed in now. A conversation belongs to one Agent, attached here or not at that moment. When that
 * Agent is not one of the signed-in account's Agents set up on this computer — after switching account, for example —
 * the turn is refused (`refusal`), never sent to the signed-in account's default model or to another Agent's. Without an
 * Agent (`agentId` empty: a conversation that has none) it is the account default. Returns `{ account, model }` or
 * `{ account, refusal }`; the key is for this process only.
 * 中文说明：会话的每一轮只用这个会话自己的 Agent 在此刻登录账户下的模型；这个 Agent 不在当前账户、或没在这台电脑上设置时，
 * 这一轮被拒绝，不改用当前账户的默认模型，也不用别的 Agent 的模型。
 */
export function conversationModel({ home, modelHome }, agentId) {
  const device = createDeviceClient({ root: home }).status();
  const account = device.state === 'linked' && text(device.origin) && device.account?.id
    ? { origin: device.origin, accountId: String(device.account.id) } : null;
  if (!agentId) return { account, model: effectiveModel({ home, modelHome }, account, undefined) };
  const rows = (readJson(path.join(home, 'registry.json'))?.instances ?? []).filter((row) => row?.mode === 'local_agent' && row.agentId === agentId);
  const here = account !== null && (device.agents ?? []).some((row) => row?.id === agentId)
    && rows.some((row) => !row.signedOutAt && row.origin === account.origin && row.accountId === account.accountId);
  if (here) return { account, model: effectiveModel({ home, modelHome }, account, agentId) };
  const name = text(rows.find((row) => text(row.agentName))?.agentName) || agentId;
  return { account, refusal: say('model.agentElsewhere', { name }) };
}

/**
 * The Agents attached on this computer under `account`: local Agent instances of that account that hold their Agent
 * token (what the host attaches). Only whether a token is there is read, never its value. `[{ agentId, name }]`.
 */
export function attachedAgents(home, account) {
  if (!account) return [];
  const holdsToken = (directory) => {
    try { return text(JSON.parse(fs.readFileSync(path.join(directory, 'local.json'), 'utf8'))?.agent?.env?.RULITH_TOKEN) !== ''; }
    catch { return false; }
  };
  return (readJson(path.join(home, 'registry.json'))?.instances ?? [])
    .filter((row) => row?.mode === 'local_agent' && !row.signedOutAt && text(row.agentId) && row.origin === account.origin
      && row.accountId === account.accountId && holdsToken(text(row.directory)))
    .map((row) => ({ agentId: row.agentId, name: text(row.agentName) || text(row.name) || row.agentId }));
}

/**
 * One line saying which model an Agent uses, for the launcher's start-up output: where it comes from, the model id and
 * the endpoint (scheme, host and path only). Never the key, nor whether there is one.
 */
export function modelLine(agentName, model) {
  let where = '';
  try { const url = new URL(text(model?.url).trim()); where = url.origin + url.pathname.replace(/\/+$/, ''); } catch { where = ''; }
  const source = model?.source === 'override' ? 'its own model' : 'the account default model';
  return modelReady(model ?? {})
    ? `Deep Rulith: Agent ${agentName} uses ${source}: ${text(model.name).trim()} at ${where}.`
    : `Deep Rulith: Agent ${agentName} has no usable model yet (${source} is not set or incomplete); save one in Rulith's settings.`;
}

/** What the page may see of a model: never the key, not even its length or a digest. */
export function publicModel(model, account) {
  return { source: model.source === 'override' ? 'override' : 'default', url: text(model.url).trim(), name: text(model.name).trim(),
    modelId: text(model.name).trim(), configured: modelReady(model), keyConfigured: text(model.key).trim() !== '',
    expectedOrigin: account?.origin ?? '', expectedAccountId: account?.accountId ?? '' };
}

/** The prefix of every provider id this module registers. */
export const LIVE_PROVIDER_PREFIX = 'rulith-live-';
/** The context window of a route when nothing says otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** `localContextWindow` from the launcher settings, when it is a positive whole number; otherwise none. */
export const contextWindowSetting = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

/**
 * The dsh route for a saved model: protocol, base URL, model id and a provider id that is a hash of those three, and the
 * context window dsh measures it against. A model on this computer (a loopback endpoint) takes the launcher settings'
 * `localContextWindow` when one is set — what the earlier launcher gave such providers, and what context relief and
 * compaction read (board-transcript.mjs, dsh compaction-basic); every other route keeps the 1M default.
 */
export function liveRoute(model, { localContextWindow } = {}) {
  if (!modelReady(model)) return undefined;
  const endpoint = modelEndpoint(model.url);
  const name = text(model.name).trim();
  const id = LIVE_PROVIDER_PREFIX + createHash('sha256').update(`${endpoint.api}\u0000${endpoint.base}\u0000${name}`).digest('hex').slice(0, 12);
  let local = false;
  try { local = isLoopback(new URL(endpoint.base)); } catch { local = false; }
  const window = local ? contextWindowSetting(localContextWindow) : undefined;
  return { id, api: endpoint.api, baseUrl: endpoint.base, model: name, key: text(model.key), contextWindow: window ?? DEFAULT_CONTEXT_WINDOW };
}

/**
 * One pi-ai adapter for one route, built through dsh's own adapter class and pi-ai's protocol implementations — the same
 * pieces dsh's llm-pi-ai plugin assembles for a configured route (a declared, non-catalog provider: no reasoning levels,
 * DeepSeek thinking format on Chat Completions, the route's context window and this cap). The key is resolved from memory.
 */
export async function createRouteAdapter(route, providerId) {
  const [{ PiAiAdapter }, { resolveRetryPolicy }, { openAICompletionsApi }, { anthropicMessagesApi }] = await Promise.all([
    import('@deepseek-ai/dsh-llm-pi-ai'), import('@deepseek-ai/dsh-llm'),
    import('@earendil-works/pi-ai/api/openai-completions.lazy'), import('@earendil-works/pi-ai/api/anthropic-messages.lazy')]);
  const messages = route.api === 'anthropic-messages';
  const model = { id: route.model, name: route.model, api: route.api, provider: providerId, baseUrl: route.baseUrl, input: ['text'],
    contextWindow: route.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS, reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(messages ? {} : { compat: { thinkingFormat: 'deepseek' } }) };
  const wire = messages ? anthropicMessagesApi() : openAICompletionsApi();
  // The harness-authenticated api-key method, as llm-pi-ai gives a declared route: the request's key is the credential.
  const auth = { apiKey: { name: DISPLAY_NAME, resolve: ({ credential }) => Promise.resolve({
    auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: DISPLAY_NAME }) } };
  const piProvider = { id: providerId, name: DISPLAY_NAME, baseUrl: route.baseUrl, auth, getModels: () => [model],
    stream: (m, context, options) => wire.stream(m, context, options),
    streamSimple: (m, context, options) => wire.streamSimple(m, context, options) };
  const profile = { provider: providerId, displayName: DISPLAY_NAME, piProvider, modelErrors: new Map(),
    configuredMaxTokens: new Map([[route.model, MODEL_MAX_TOKENS]]), streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, `llm: provider "${providerId}" retryPolicy`) };
  const profiles = new Map([[providerId, profile]]);
  // A loopback model may have no key; pi-ai's Chat Completions client still wants one.
  const key = route.key || 'local';
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => key });
}

/**
 * A provider id an earlier run logged, answered by a conversation's current route (invariant 4). dsh's step compaction
 * measures a conversation against the route its log names last (`resolveModelInfo`), before the turn's first request
 * logs the new one; after a restart, or once that route's account was signed out, nobody serves that id any more. This
 * answers it with the current route's adapter, model metadata and context window; a request that still names it is sent
 * to the current route. The target is replaced when another turn starts on a conversation that logged this id.
 * 中文说明：会话日志里记着的旧路线（重启后或换账户后已没人注册）由这个会话此刻的路线代答，dsh 的压缩照样能量会话。
 */
class LoggedRouteAlias {
  constructor(target) { this.target = target; }   // { adapter, provider, model }
  providerInfo(provider) { return { id: provider, name: DISPLAY_NAME }; }
  providerRetryPolicy() { return this.target.adapter.providerRetryPolicy?.(this.target.provider); }
  imageRequestPricing() { return this.target.adapter.imageRequestPricing?.(this.target.provider, this.target.model); }
  listModels() { return Promise.resolve([]); }
  async resolveModel(provider, model, signal) {
    const { adapter, provider: to, model: id } = this.target;
    return { ...(await adapter.resolveModel(to, id, signal)), provider, id: model };
  }
  async prepareCall(provider, model, signal) {
    const { adapter, provider: to, model: id } = this.target;
    const call = await adapter.prepareCall(to, id, signal);
    return { model: { ...call.model, provider, id: model }, stream: (options) => call.stream({ ...options, provider: to, model: id }) };
  }
  stream(options) {
    const { adapter, provider: to, model: id } = this.target;
    return adapter.stream({ ...options, provider: to, model: id });
  }
}

/** The requests dsh makes for a conversation outside its agent loop, which follow the conversation's route. */
const CONVERSATION_SIDE_REQUESTS = new Set(['compaction', 'session-title']);
const accountKey = (account) => (account ? `${account.origin}\u0000${account.accountId}` : '');
const keyDigest = (key) => createHash('sha256').update(text(key)).digest('hex');

/**
 * Route every dsh Agent's turns to the live Rulith model. `routeFor(agent)` returns `{ account, model }`: the account
 * signed in now and the saved model for that agent's conversation (`effectiveModel`). `localContextWindow` is the
 * launcher settings' window for models on this computer (`liveRoute`).
 *
 * The turn's route is chosen when the turn starts: an outermost `agent/pre-step` listener at the turn's first step,
 * ahead of dsh's step compaction, registers it; `agent/request` then uses it for every step of that turn. dsh's
 * compaction and title requests for a conversation (`llm/stream`, by purpose) go to the route of its running turn, or,
 * between turns, to the route in force now. Routes registered for an account that is no longer signed in are
 * unregistered at the next turn start, or when the host calls `forgetOtherAccounts` (its periodic check).
 *
 * Returns `searchKeyFor(agent)`: the DeepSeek key of the route that agent's current turn started with, while its account
 * is still the signed-in one, or '' — what web search may use (web-tools.mjs `webSearchKey`).
 */
export function installLiveModels(ctx, { routeFor, createAdapter = createRouteAdapter, localContextWindow } = {}) {
  const turns = new WeakMap();      // agent -> { turn, provider, model, searchKey, account, active }
  let signedIn;                     // the account key last seen signed in (undefined before the first look)
  const searchKeyFor = (agent) => {
    const turn = agent ? turns.get(agent) : undefined;
    return turn && (signedIn === undefined || turn.account === signedIn) ? turn.searchKey : '';
  };
  if (typeof ctx?.llm?.registerAdapter !== 'function' || typeof ctx.on !== 'function') {
    return { installed: false, searchKeyFor, forgetOtherAccounts: () => {} };
  }
  // routeId -> { digest, account, generation }: generations only grow, so an id is never reused for another key.
  const generations = new Map();
  const registered = new Map();     // providerId -> { account, ready: Promise<{ adapter, dispose }> }
  const aliases = new Map();        // logged providerId -> { account, alias, dispose }
  const agentsBySession = new Map(); // session id -> agent (for the conversation's side requests)
  const idOf = (routeId, generation) => (generation === 0 ? routeId : `${routeId}-${generation}`);
  /**
   * The provider id of `route` under `account`. A generation whose id an alias holds is skipped, never registered over:
   * after a restart the counters start again at 0, so an id a conversation logged in an earlier run (and that an alias
   * now answers) can come round again for a new key. 中文说明：重启后代号从 0 重新数，被别名占着的 id 跳过，不重复注册。
   */
  const providerFor = (route, account) => {
    const digest = keyDigest(route.key);
    let entry = generations.get(route.id);
    const held = (generation) => aliases.has(idOf(route.id, generation)) && !registered.has(idOf(route.id, generation));
    if (entry === undefined || entry.digest !== digest || entry.account !== account || held(entry.generation)) {
      let generation = entry === undefined ? 0 : entry.generation + 1;
      while (held(generation)) generation += 1;
      entry = { digest, account, generation };
      generations.set(route.id, entry);
    }
    return idOf(route.id, entry.generation);
  };
  const ensure = async (route, account) => {
    const providerId = providerFor(route, account);
    if (!registered.has(providerId)) {
      const entry = { account, settled: undefined };
      entry.ready = Promise.resolve(createAdapter(route, providerId))
        .then((adapter) => (entry.settled = { adapter, dispose: ctx.llm.registerAdapter([providerId], adapter) }))
        .catch((error) => { if (registered.get(providerId) === entry) registered.delete(providerId); throw error; });
      registered.set(providerId, entry);
    }
    await registered.get(providerId).ready;
    return providerId;
  };
  /** Unregister every route and alias of another account than `account` (a key; '' when signed out). */
  const sweep = (account) => {
    signedIn = account;
    for (const [providerId, entry] of [...registered]) {
      if (entry.account === account) continue;
      registered.delete(providerId);
      // At once when it is registered, so the id is free before anything below asks for it; else as soon as it is.
      if (entry.settled) entry.settled.dispose?.();
      else entry.ready.then(({ dispose }) => dispose?.(), () => {});
    }
    for (const [providerId, entry] of [...aliases]) {
      if (entry.account === account) continue;
      aliases.delete(providerId);
      entry.dispose?.();
    }
  };
  /** The conversation's logged route, when it is one of ours that nobody serves now, answers with `current`. */
  const alias = async (agent, current) => {
    const logged = agent?.session?.requestHeader?.()?.config;
    const providerId = typeof logged?.provider === 'string' ? logged.provider : '';
    if (!providerId.startsWith(LIVE_PROVIDER_PREFIX) || providerId === current.provider || registered.has(providerId)) return;
    const { adapter } = await registered.get(current.provider).ready;
    const target = { adapter, provider: current.provider, model: current.model };
    const existing = aliases.get(providerId);
    if (existing !== undefined) { existing.alias.target = target; existing.account = current.account; return; }
    const entry = { account: current.account, alias: new LoggedRouteAlias(target) };
    try { entry.dispose = ctx.llm.registerAdapter([providerId], entry.alias); } catch { return; }   // somebody else serves it
    aliases.set(providerId, entry);
  };
  /**
   * The route in force now for `agent`'s conversation, registered; undefined when no usable model is set, and
   * `{ refusal }` when the conversation's Agent may not be served under the account signed in now (`conversationModel`).
   */
  const routeNow = async (agent) => {
    const { account, model, refusal } = (await routeFor(agent)) ?? {};
    const key = accountKey(account);
    sweep(key);
    if (typeof refusal === 'string' && refusal !== '') return { refusal };
    const route = liveRoute(model ?? {}, { localContextWindow });
    if (!route) return undefined;
    return { provider: await ensure(route, key), model: route.model, searchKey: webSearchKey(model), account: key };
  };
  /** Start `turn` of `agent`: choose its route, and let the conversation's logged route answer with it. */
  const begin = async (agent, turn) => {
    const now = await routeNow(agent);
    if (now === undefined || now.refusal !== undefined) { turns.delete(agent); return now; }
    const current = { turn, active: true, ...now };
    turns.set(agent, current);
    await alias(agent, current);
    return current;
  };
  const install = (agent) => {
    if (typeof agent?.ctx?.on !== 'function') return;
    if (agent.session?.id !== undefined) agentsBySession.set(String(agent.session.id), agent);
    // Outermost, so the turn's route is chosen before dsh's step compaction measures and summarizes the conversation. A
    // failure here is reported by `agent/request` below, which tries again.
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (turns.get(agent)?.turn !== payload?.turn) await begin(agent, payload?.turn).catch(() => undefined);
      return next();
    }, { prepend: true });
    // Outermost, so the route chosen here is the one requested, whatever dsh's own model selection proposed.
    agent.ctx.on('agent/request', async (payload, next) => {
      const proposed = await next();
      let current = turns.get(agent);
      if (current?.turn !== payload?.turn) current = await begin(agent, payload?.turn);
      if (current === undefined) {
        throw new Error(say('model.notSet'));
      }
      if (current.refusal !== undefined) throw new Error(current.refusal);
      // The route has no reasoning levels, as before; an effort carried over from another route is dropped.
      const { reasoningEffort: _effort, ...rest } = proposed ?? {};
      return { ...rest, provider: current.provider, model: current.model };
    }, { prepend: true });
  };
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/status', (payload) => {
    const turn = payload?.agent ? turns.get(payload.agent) : undefined;
    if (turn !== undefined && payload.status === 'idle') turn.active = false;
  });
  ctx.on('session/disposed', (session) => { if (session?.id !== undefined) agentsBySession.delete(String(session.id)); });
  // dsh's compaction summary and session title for a conversation follow its route (invariant 2). Requests this module
  // sent on (`ours`) and requests of conversations it does not know pass unchanged.
  const ours = new WeakSet();
  ctx.on('llm/stream', function conversationRoute(options, next) {
    if (ours.has(options) || !CONVERSATION_SIDE_REQUESTS.has(options?.purpose) || options.sessionId === undefined) return next();
    const agent = agentsBySession.get(String(options.sessionId));
    if (agent === undefined) return next();
    const runtime = this;
    return (async function* () {
      const turn = turns.get(agent);
      const current = turn?.active && registered.has(turn.provider) ? turn : await routeNow(agent);
      // A conversation whose Agent may not be served now sends nothing anywhere, its logged route included.
      if (current?.refusal !== undefined) throw new Error(current.refusal);
      // Nothing to change (or no model to change to): the request goes on as asked, through the rest of the chain.
      if (current === undefined || (current.provider === options.provider && current.model === options.model)) {
        yield* next();
        return;
      }
      const request = Object.freeze({ ...options, provider: current.provider, model: current.model });
      ours.add(request);
      yield* runtime.stream(request);
    })();
  });
  return { installed: true, searchKeyFor, forgetOtherAccounts: (account) => sweep(accountKey(account)) };
}

/**
 * dsh's DeepSeek web search with its key resolved per search from the turn's model (PSC 0.2.27 ④ with ACC-LOCAL-10):
 * a different account's key, or a key of a model that is no longer DeepSeek's API, is never used. Registered in place of
 * the launch-time `web-search-deepseek` plugin (disabled in rulith-web.cordis.yml); its endpoint and limits are dsh's
 * defaults. Whether web_search is offered at all is still decided when the app starts.
 */
export async function installLiveSearch(ctx, { searchKeyFor }) {
  if (typeof ctx?.inject !== 'function') return false;
  const search = await import('@deepseek-ai/dsh-web-search-deepseek');
  const initiator = () => ctx.get?.('agents')?.currentInitiator?.();
  const provider = new search.DeepSeekSearchProvider(() => ({
    // With no key (the turn's model is not DeepSeek's API, for example after an account switch) dsh answers exactly as it
    // did before for a missing key under this same name, so no new model-visible text is introduced.
    apiKeyEnv: 'RULITH_DSH_WEB_SEARCH_KEY',
    resolveApiKey: async () => searchKeyFor(initiator()) || undefined,
    baseURL: search.DEEPSEEK_DEFAULT_BASE_URL, model: search.DEEPSEEK_DEFAULT_MODEL, apiVersion: search.DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: search.DEEPSEEK_DEFAULT_MAX_TOKENS, maxUses: search.DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: (request) => { initiator()?.session?.append?.('web/deepseek-search-llm-request', request); },
  }));
  // Registered while the web service and this plugin both live; disposed with either.
  ctx.inject(['web'], (child) => {
    child.effect(() => {
      try { return child.web.registerSearchProvider(provider); } catch {
        // Another provider under this id (an overlay that still enables dsh's own): that one stays, with its launch key.
        console.error('[rulith model] another DeepSeek search provider is registered; web_search keeps it.');
        return () => {};
      }
    });
  });
  return true;
}

/**
 * The two host routes (`GET`/`POST /rulith/api/model`). Saving goes through the manager's own model APIs for the
 * signed-in account (`/manager/model/default`, `/manager/instances/model`), guarded by the account the page read.
 */
export function modelRoutes({ manager, read, defaultsElsewhere = false }) {
  const fields = ['url', 'name', 'key', 'clearKey', 'thinking', 'maxOutputTokens'];
  return {
    get: async (query = {}) => {
      const { account, model } = await read(query.agentId ? String(query.agentId) : undefined);
      return { model: publicModel(model, account) };
    },
    save: async (body = {}) => {
      const state = await manager('/manager/state');
      const device = state.device ?? {};
      if (device.state !== 'linked') throw Object.assign(new Error(say('model.notSignedIn')), { errorCode: 'not_signed_in' });
      if (body.expectedOrigin !== device.origin || body.expectedAccountId !== String(device.account?.id ?? '')) {
        throw Object.assign(new Error(say('model.accountChanged')), { errorCode: 'account_changed' });
      }
      const values = Object.fromEntries(fields.filter((name) => body[name] !== undefined).map((name) => [name, body[name]]));
      const guard = { expectedOrigin: body.expectedOrigin, expectedAccountId: body.expectedAccountId };
      const agentId = body.agentId === undefined ? '' : String(body.agentId);
      if (agentId) {
        if (!(device.agents ?? []).some((agent) => agent.id === agentId)) throw new Error(say('model.chooseAgent'));
        const instance = (state.instances ?? []).find((row) => row.agentId === agentId && row.mode === 'local_agent' && !row.signedOutAt);
        if (!instance) throw Object.assign(new Error(say('model.agentNotSetUp')), { errorCode: 'agent_not_set_up' });
        if (!['default', 'override'].includes(body.source)) throw new Error(say('model.chooseSource'));
        await manager('/manager/instances/model', body.source === 'override'
          ? { instanceId: instance.id, source: 'custom', ...guard, ...values }
          : { instanceId: instance.id, source: 'default', ...guard });
      } else {
        // A launcher reading another home's defaults (`modelHome`) would not see a default saved here.
        if (defaultsElsewhere) throw Object.assign(new Error(say('model.defaultsElsewhere')), { errorCode: 'model_defaults_elsewhere' });
        await manager('/manager/model/default', { ...guard, ...values });
      }
      const { account, model } = await read(agentId || undefined);
      return { model: publicModel(model, account), applies: 'next_turn' };
    },
  };
}
