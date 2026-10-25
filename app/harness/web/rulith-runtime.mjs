// Deep Rulith, host half. It keeps the owner's Rulith Runtime manager running beside dsh: sign-in, Agent pairing and the
// local Worker stay exactly the Runtime's own, reached only through the manager's local API. It gives dsh's agents
// Rulith's three MCP tools for the selected Agent, and serves the browser half's account entry and Rulith panel under
// /rulith/api on dsh's own server (same origin). Nothing here executes model-authored work: execution happens only in
// the Runtime's Worker, through Rulith Actions.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { RulithMcp, TOOLS, surfaceAccepted } from '../rulith-mcp.mjs';
import { installBoardTranscript } from './board-transcript.mjs';
import { installOutgoingTrim } from './outgoing-trim.mjs';
import { installProjectContext, readSourceBindings } from './project-source.mjs';
import { PROJECT_SOURCE, projectRoutes } from './open-project.mjs';
import { rulithBackstop, workBase } from '../../../worker/adapter-confinement.mjs';
import { diagnosisReport, legacyFromEnv } from './diagnosis.mjs';
import { ShadowReviewer, reviewWithModel, reviewLog } from './shadow-reviewer.mjs';

import { readToolKinds, renderChannelResult } from '../board-channel.mjs';
import { handOf, conversationKey, depthOf } from '../subagents.mjs';
import { ConversationBoards } from './conversation-boards.mjs';
import { conversationBoards } from './launcher-settings.mjs';
import { setupRoutes } from './local-setup.mjs';
import { contextWindowSetting, conversationModel, effectiveModel, installLiveModels, installLiveSearch, modelRoutes, signedInAccount }
  from './model-runtime.mjs';
import { folderPicker } from './folder-picker.mjs';
import { installBrand } from './brand.mjs';
import { refreshGeneralKits } from '../kit-install.mjs';
export { awaitOutcome } from '../board-channel.mjs';

export const name = 'rulith-runtime';
export const inject = ['tools', 'webServer', 'llm', 'connection'];

/** The panel observes results already received on this Agent's channel; it never calls MCP. The latest view and its
 * operations strip pass through unchanged, with `recent`: the operations this conversation's results showed (BoardChannel). */
export function cachedBoard(current, status, session) {
  // Session ids are opaque: unusual strings are routed through conversationKey's digest form.
  if (session !== undefined && typeof session !== 'string')
    throw new Error('会话标识无效。');
  if (!current) return { available: false, tools: status };
  if (current.boards?.enabled) {
    if (session === undefined) return { available: true, agentName: current.agentName, liveConversations: current.boards.size };
    // Consult only the observed mapping and existing holders: polling must never open a connection.
    const key = current.boards.sessions.get(session);
    const channel = current.boards.sessions.has(session) ? current.boards.holders.get(key)?.channel : undefined;
    return { available: true, agentName: current.agentName, ...(channel?.latestBoard ?? { view: null }), ...recentOf(channel) };
  }
  const channel = current.channel ?? current.boards?.holders.get(undefined)?.channel;
  return { available: true, agentName: current.agentName, ...channel?.latestBoard, ...recentOf(channel) };
}

/** The folder a panel request's conversation runs in: the folder the page names, else the live conversation's own (its
 * dsh session's working directory), as the board and conversation routes read it. Pure. */
export const requestFolder = (query = {}, sessions = new Map()) => query.workspace
  ?? (typeof query.session === 'string' ? sessions.get(query.session)?.session?.header?.cwd : undefined);

const recentOf = (channel) => (channel?.recentOperations?.length ? { recent: channel.recentOperations } : {});

/** What the panel may see of a conversation-settings reply: the conversation's row and the control's outcome, nothing of
 * the manager's own state (the manager answers every operation with its full state appended). */
export function conversationView(reply) {
  const out = {};
  // PSC 0.2.27 ①: one tier per conversation (`explorationMode`, the strictest, and `explorationModesMixed`); ⑤: whether a
  // deletion is finished (`settled`, `deletion`, `refusedGoals`, `goalsUnread`).
  for (const field of ['found', 'conversation', 'connections', 'reviewer', 'state', 'result', 'teaching', 'requestId', 'boardId',
    'postCallReview', 'explorationMode', 'explorationModesMixed', 'explorationModes', 'openGoals', 'pendingCall', 'ended', 'endedAt',
    'closedGoals', 'unconfirmedGoals', 'goalsUnread', 'settled', 'refusedGoals', 'deletion'])
    if (reply?.[field] !== undefined) out[field] = reply[field];
  return out;
}

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// D-1016a: where the person accepts a goal the app cannot sign for them (a goal waiting for their acceptance in Console):
// the Agent's cases in Console. From the origin this computer signed in to; anything but http(s) gives no link.
export function consoleGoalsUrl(consoleUrl, agentId) {
  if (!consoleUrl || !agentId) return '';
  let origin;
  try { origin = new URL(consoleUrl); } catch { return ''; }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return '';
  return `${origin.origin}/console/#/cases?agentId=${encodeURIComponent(agentId)}`;
}

/** Where a person handles an operation that waits for them: the Agent's Runtime tab in Console (the manager's Health read
 * links the same page). From the origin this computer signed in to; anything but http(s) gives no link. */
export function consoleRuntimeUrl(origin, agentId) {
  if (!origin || !agentId) return '';
  let url;
  try { url = new URL(origin); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  return `${url.origin}/console/#/agents/${encodeURIComponent(agentId)}?tab=runtime`;
}

/** Every Agent paired on this computer with a usable credential: one entry per local Agent instance. */
export function pairedAgents(home) {
  const registry = readJson(path.join(home, 'registry.json'));
  const out = [];
  for (const row of (registry?.instances ?? []).filter((r) => r.mode === 'local_agent' && !r.signedOutAt)) {
    const token = readJson(path.join(row.directory, 'local.json'))?.agent?.env?.RULITH_TOKEN;
    if (token && row.agentId) out.push({ instanceId: row.id, agentId: row.agentId, agentName: row.agentName, token });
  }
  return out;
}

/** A directory path compared the way Windows and dsh compare it: resolved, without a trailing separator, case-folded on Windows. */
export const samePath = (value) => {
  if (typeof value !== 'string' || !value) return '';
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The Agent this dsh speaks for: the chosen instance, or the only paired local Agent in the manager home. */
export function selectedAgent(home, agentName) {
  const registry = readJson(path.join(home, 'registry.json'));
  const rows = (registry?.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt
    && (!agentName || row.agentName === agentName));
  if (rows.length !== 1) return null;
  const local = readJson(path.join(rows[0].directory, 'local.json'));
  const token = local?.agent?.env?.RULITH_TOKEN;
  return token ? { instanceId: rows[0].id, agentId: rows[0].agentId, agentName: rows[0].agentName, token } : null;
}

export async function apply(ctx, config = {}) {
  const separateBoards = conversationBoards(config);
  const home = config.managerHome;
  const port = Number(config.managerPort ?? 7790);
  if (!home || !config.runtimeEntry || !config.keyFile) throw new Error('rulith-runtime needs managerHome, runtimeEntry and keyFile');
  const key = fs.readFileSync(config.keyFile, 'utf8').trim();
  const consoleUrl = config.consoleUrl || 'https://console.rulith.ai';
  const stateDir = process.env.DSH_HOME ?? home;
  const shadowSettings = config.shadow ?? {};
  const shadowLog = reviewLog(path.join(stateDir, 'logs'));
  const selectionFile = path.join(stateDir, 'rulith-selected.json');
  const statusFile = path.join(stateDir, 'rulith-runtime-status.json');
  const chosenName = () => readJson(selectionFile)?.agentName || config.agentName || undefined;
  // 历史工具调用只在模型侧改名；必须先映射，再排板视图与统计已接受的 Set。
  // 模型看到的 Rulith 结果：最新一份整块板（+／- 标出变化），更早的只留变化（D-1008e）；上下文到减负线（reliefRatio ×
  // 窗口）时一批减负（见 board-transcript.mjs）。
  installBoardTranscript(ctx, { reliefRatio: config.reliefRatio, compaction: config.compaction });
  // The page's title, icon and manifest are Rulith's (design §3.2 页面标题、图标; brand.mjs).
  installBrand(ctx);
  // 发给模型的那一份在发出前减负（会话不改）：之前轮次的思考不发，减负边界之前的调用长参数缩短（见 outgoing-trim.mjs）。
  installOutgoingTrim(ctx);
  // PSC 0.2.27 ④: every turn uses the model saved in Rulith for the conversation's Agent under the account signed in now
  // (model-runtime.mjs), installed before anything below can wait, so no conversation starts without it. `modelHome` is a
  // developer setting that reads the account defaults of another manager home; `localContextWindow` (launcher settings)
  // is the context window of a model on this computer.
  const modelHome = config.modelHome || process.env.RULITH_DSH_MODEL_HOME || '';
  const readModel = (agentId) => {
    const account = signedInAccount(home);
    return { account, model: effectiveModel({ home, modelHome }, account, agentId) };
  };
  // A conversation's turns use its own Agent's model: the Agent recorded for it, whether or not that Agent is attached at
  // this moment; else the Agent its Rulith calls would go to. When that Agent is not set up here under the account signed
  // in now (after switching account, say), the turn is refused rather than sent to that account's default model
  // (model-runtime.mjs conversationModel). 中文说明：会话按自己的 Agent 选模型，不因 Agent 暂时没接上就改用默认模型。
  const conversationAgent = (sessionId, cwd) => (typeof sessionId === 'string' ? assignments.get(sessionId) : undefined)
    || resolveHolder(sessionId, cwd)?.agentId;
  const live = installLiveModels(ctx, {
    routeFor: (agent) => conversationModel({ home, modelHome }, conversationAgent(topSession(agent), agent?.session?.header?.cwd)),
    localContextWindow: contextWindowSetting(config.localContextWindow ?? process.env.RULITH_DSH_LOCAL_CONTEXT_WINDOW),
  });
  void installLiveSearch(ctx, live).catch(() => {
    console.error('[rulith model] web_search could not be tied to the Rulith model; it stays unavailable.');
  });

  // 1. The Runtime manager: start it unless one already serves this port; stop only the one started here.
  let child = null;
  if (!(await listening(port))) {
    // `manager`: only the Runtime manager. With no command the Runtime's executable opens this app (rulith-local.mjs).
    child = spawn(process.execPath, [config.runtimeEntry, 'manager'], {
      env: { ...process.env, RULITH_MANAGER_HOME: home, RULITH_MANAGER_PORT: String(port), RULITH_MANAGER_KEY: key },
      stdio: 'ignore', windowsHide: true,
    });
  }
  ctx.effect(() => () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    else try { process.kill(-child.pid); } catch { child.kill(); }
  });
  const manager = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined
      ? { headers: { 'x-rulith-manager': key } }
      : { method: 'POST', headers: { 'x-rulith-manager': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok || reply.ok === false) {
      // The refusal's code travels with it (the project flow tells the owner what happened from it); only a plain code.
      const error = Object.assign(new Error(reply.teaching || `本机 Rulith 没有完成这个请求（${response.status}）。`), { status: response.status });
      if (typeof reply.errorCode === 'string' && /^[a-z_]{1,64}$/.test(reply.errorCode)) error.errorCode = reply.errorCode;
      throw error;
    }
    return reply;
  };
  // PSC 0.2.27 ② ③: "set up this Agent on this computer" is the manager's one operation (local-setup.mjs). A new Agent's
  // general kit home is the app home's kit (the launcher passes it); an Agent that has one keeps it.
  const setup = setupRoutes({ manager, kitHome: config.kitHome || process.env.RULITH_DSH_KIT_HOME || '' });
  const models = modelRoutes({ manager, read: readModel, defaultsElsewhere: Boolean(modelHome) });

  // 2. Every paired Agent is attached at once (owner 2026-10-17: the sidebar is Agent -> directory -> conversation). The
  //    three tools are registered once; each call goes to the Agent its conversation belongs to. A conversation belongs to
  //    the Agent recorded for it (assigned when the sidebar starts it in an Agent's directory, or at its first Rulith call),
  //    else the Agent whose directory it runs in, else the default Agent; once it has a Board it never changes Agent.
  //    The bridge never retries: any transport failure closes its MCP connection, whichever hand made the call. A model
  //    mid-turn must not see its tools vanish over that (2026-10-06).
  const attached = new Map();        // agentId -> holder
  let toolDisposers = null;
  const sessions = new Map();
  let status = { state: 'starting' };
  const assignmentsFile = path.join(stateDir, 'rulith-session-agents.json');
  const assignments = new Map(Object.entries(readJson(assignmentsFile) ?? {}));
  const saveAssignments = () => fs.promises.writeFile(assignmentsFile, JSON.stringify(Object.fromEntries(assignments), null, 2)).catch(() => {});
  let dirOwners = new Map();         // samePath(directory) -> agentId, refreshed with the sidebar tree
  const liveConversations = () => [...attached.values()].reduce((n, h) => n + h.boards.size, 0);
  const report = (state, detail = {}) => {
    // A conversation set reports only its own count; the status counts every attached Agent's.
    status = { state, at: new Date().toISOString(), agents: [...attached.values()].map((h) => h.agentName), ...detail,
      liveConversations: liveConversations() };
    try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch {}
  };
  const defaultHolder = () => {
    const name = chosenName();
    return [...attached.values()].find((h) => h.agentName === name) ?? attached.values().next().value;
  };
  const topSession = (agent) => depthOf(agent) ? agent?.session?.header?.parentSession : agent?.session?.id;
  // Resolve without recording: used by reads and by observing new conversations.
  const resolveHolder = (sessionId, cwd) => {
    const assigned = typeof sessionId === 'string' ? assignments.get(sessionId) : undefined;
    if (assigned) return attached.get(assigned);
    const owner = cwd ? dirOwners.get(samePath(cwd)) : undefined;
    return (owner && attached.get(owner)) ?? defaultHolder();
  };
  // A tool call fixes the conversation's Agent for good.
  const holderForCall = (agent) => {
    const id = topSession(agent);
    const holder = resolveHolder(id, agent?.session?.header?.cwd);
    if (holder && typeof id === 'string' && !assignments.has(id)) { assignments.set(id, holder.agentId); void saveAssignments(); }
    return holder;
  };
  const drop = (holder) => {
    if (!holder) return;
    holder.boards.close();
    attached.delete(holder.agentId);
    if (!attached.size && toolDisposers) { for (const dispose of toolDisposers) dispose(); toolDisposers = null; }
  };
  const connect = async (token, conversationKey, signal) => {
    const bridge = new RulithMcp({ url: config.mcpUrl || 'https://api.rulith.ai/mcp', token, conversationKey, identity() {} });
    const abort = () => bridge.close();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await bridge.initialize();
      const listed = await bridge.list();
      if (!surfaceAccepted(listed)) throw new Error('MCP tool surface refused');
      return { bridge, listed };
    } catch (error) { bridge.close(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  };
  const registerTools = (listed) => {
    toolDisposers = listed.tools.map((tool) => ctx.tools.register({
      name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema,
      output: { schema: {}, render: renderChannelResult },
      async execute(args, exec) {
        const holder = holderForCall(exec.agent);
        if (!holder) throw new Error('Rulith Agent detached: this conversation\'s Agent is not attached on this computer');
        // Routing only: no hand's conversation or reasoning reaches the shadow.
        const mainRoute = exec.agent?.session?.requestHeader?.()?.config ?? exec.agent?.options ?? {};
        const outcome = await holder.boards.holder(exec.agent).channel.call(tool.name, args, { hand: handOf(exec.agent), signal: exec.signal,
          route: { provider: shadowSettings.provider ?? mainRoute.provider ?? 'rulith-model',
            model: shadowSettings.model ?? mainRoute.model ?? process.env.RULITH_DSH_MODEL,
            maxTokens: shadowSettings.maxTokens ?? 8000 }, timeoutMs: shadowSettings.timeoutMs ?? 120_000 });
        if (outcome.isError) throw new Error(JSON.stringify(outcome));
        return outcome;
      },
    }));
  };
  const attach = async (agent) => {
    // Discovery: reuse the first known conversation of this Agent when there is one; on startup registration can precede
    // all sessions.
    const ownerOf = (a) => assignments.get(a.session.id) ?? (dirOwners.get(samePath(a.session.header?.cwd)) || null);
    const defaultsHere = chosenName() ? agent.agentName === chosenName() : attached.size === 0;
    const first = separateBoards ? [...sessions.values()].find((a) => !depthOf(a)
      && (ownerOf(a) === agent.agentId || (ownerOf(a) === null && defaultsHere))) : undefined;
    const { bridge, listed } = await connect(agent.token, first ? conversationKey(first) : undefined);
    const holder = { agentId: agent.agentId, instanceId: agent.instanceId, token: agent.token, agentName: agent.agentName };
    holder.boards = new ConversationBoards({ enabled: separateBoards,
      connect: (key, signal) => connect(agent.token, key, signal),
      report: (state, detail) => {
        if (attached.get(holder.agentId) === holder) report(state, { agentName: holder.agentName, tools: [...TOOLS], ...detail });
      },
      shadow: () => new ShadowReviewer({ enabled: shadowSettings.enabled !== false, log: shadowLog,
        chat: (route, user, signal) => reviewWithModel(ctx.llm, route, user, signal) }),
      toolKinds: () => {
        // This Agent's local Worker's explicit manifest kinds; never infer read from an Action's name or args.
        const row = (readJson(path.join(home, 'registry.json'))?.instances ?? []).find((entry) => entry.id === holder.instanceId);
        const env = row ? readJson(path.join(row.directory, 'local.json'))?.worker?.env ?? {} : {};
        return readToolKinds(env.RULITH_TOOLS_FILE);
      } });
    attached.set(holder.agentId, holder);
    if (!separateBoards) holder.boards.holder().bridge = bridge;
    else if (first && sessions.get(first.session.id) === first) holder.boards.holder(first).bridge = bridge;
    else bridge.close();
    for (const a of sessions.values()) if (resolveHolder(topSession(a), a.session.header?.cwd) === holder) holder.boards.observe(a);
    if (!toolDisposers) registerTools(listed);
    return holder;
  };
  ctx.on('agent/created', ({ agent }) => {
    sessions.set(agent.session.id, agent);
    resolveHolder(topSession(agent), agent.session.header?.cwd)?.boards.observe(agent);
  });
  ctx.on('session/disposed', (session) => {
    sessions.delete(session.id);
    for (const holder of attached.values()) holder.boards.disposeSession(session);
  });
  // The app's start refreshes the general kit of every Agent that already has one here (or the Agent the launcher
  // settings name) with its Worker on, through the same manager operation as "set up on this computer" (repair mode),
  // also when another launcher already runs the manager; it never makes a first install. Tried again on the next tick
  // until the manager answers.
  let kitRefresh = 'pending';
  const refreshKits = () => {
    if (kitRefresh !== 'pending') return;
    kitRefresh = 'running';
    refreshGeneralKits(manager, setup, { agentName: config.agentName }).then(() => { kitRefresh = 'done'; }, () => { kitRefresh = 'pending'; });
  };
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    refreshKits();
    try {
      // Model routes of an account no longer signed in here leave memory, keys included (model-runtime.mjs); an unreadable
      // device record counts as signed out.
      let account = null;
      try { account = signedInAccount(home); } catch { account = null; }
      live.forgetOtherAccounts(account);
      const paired = pairedAgents(home);
      const wanted = new Map(paired.map((a) => [a.agentId, a]));
      for (const holder of [...attached.values()])
        if (wanted.get(holder.agentId)?.token !== holder.token) drop(holder);
      const failures = [];
      for (const agent of paired) {
        if (attached.has(agent.agentId)) continue;
        try { await attach(agent); }
        catch (error) { failures.push(`${agent.agentName}: ${String(error?.message ?? error).slice(0, 160)}`); }
      }
      if (!paired.length) report('no_agent', { hint: 'Sign in with the Deep Rulith entry and set up an Agent' });
      else if (!attached.size) report('failed', { error: failures.join('; ').slice(0, 300) });
      else report('attached', { agentName: defaultHolder()?.agentName, tools: [...TOOLS], ...(failures.length ? { failures } : {}) });
      // Run independently: one idle conversation's retry budget cannot block another or Agent attachment.
      for (const holder of attached.values()) void holder.boards.reconnectIdle();
    } catch (error) { report('failed', { error: String(error?.message ?? error).slice(0, 300) }); } finally { busy = false; }
  };
  const timer = setInterval(tick, 3000);
  ctx.effect(() => () => { clearInterval(timer); for (const holder of [...attached.values()]) drop(holder); });

  // 3. The browser half's API: same origin only (the custom header cannot be sent cross-origin without a preflight,
  //    which this route never grants). Answers carry no token, key or secret.
  // The account entry and the settings page (design §3.2 账户面板, 设置): the signed-in account, this computer's name and,
  // per Agent of the account, whether it is set up here and its Worker's state. Agents are chosen in the sidebar and
  // Connections are reused automatically (PSC 0.2.27 ②), so no selection, Connection or tool count is shown. `isDefault`
  // is the account's own default Agent, passed on only when the service says so.
  // Agents an earlier English workbench set up here, as the launcher found them (shown in the wizard and settings).
  const legacyWorkbench = legacyFromEnv();
  const summary = (state) => {
    const instances = (state.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt);
    return {
      ...(legacyWorkbench ? { legacyWorkbench } : {}),
      signedIn: state.device?.state === 'linked',
      deviceState: state.device?.state ?? 'unknown',
      account: state.device?.account?.name ?? '',
      origin: state.device?.origin || consoleUrl,
      computer: os.hostname(),
      teaching: state.device?.teaching ?? '',
      agents: (state.device?.agents ?? []).map((agent) => {
        const instance = instances.find((row) => row.agentId === agent.id);
        return { id: agent.id, name: agent.name, ...(typeof agent.isDefault === 'boolean' ? { isDefault: agent.isDefault } : {}),
          paired: !!instance?.paired,
          worker: instance?.workerSetting ? { enabled: !!instance.workerSetting.enabled, state: instance.workerSetting.state ?? '',
            failure: instance.workerSetting.failure ?? '' } : null };
      }),
    };
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = ''; req.on('data', (chunk) => { text += chunk; if (text.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } }); req.on('error', reject);
  });
  // Whether this conversation's Agent's Worker on this computer is online, as its own Trace last reported it (the 任务
  // panel's 这台电脑). Read from the instance's event stream through the manager (the address carries the instance key and
  // stays in this process); only the state and this computer's name reach the page.
  let traceLink = null;
  // Where each Source this Agent may use is bound, as Console locked it: the same read-only list the Worker loads at
  // start (GET <work>/sources with its own Connection credentials). Only names, types and locations reach the page.
  const sourcesCache = new Map();
  const boundSources = async (instanceId) => {
    const cached = sourcesCache.get(instanceId);
    if (cached && Date.now() - cached.at < 60_000) return cached.rows;
    const row = (readJson(path.join(home, 'registry.json'))?.instances ?? []).find((entry) => entry.id === instanceId);
    const env = row ? readJson(path.join(row.directory, 'local.json'))?.worker?.env ?? {} : {};
    const rows = await readSourceBindings(env);
    sourcesCache.set(instanceId, { at: Date.now(), rows });
    return rows;
  };
  // The Agent a panel request is about: the conversation's, resolved as the board and conversation routes resolve it (its
  // recorded Agent, else the Agent whose folder it runs in), else the default one (batch 4 P3: the health and worker reads
  // of a conversation in another Agent's folder named the default Agent).
  const agentForRequest = (query = {}) => resolveHolder(query.session, requestFolder(query, sessions)) ?? null;
  installProjectContext(ctx, async (agent) => {
    const holder = agent ? resolveHolder(topSession(agent), agent.session?.header?.cwd) : defaultHolder();
    if (!holder) throw new Error('No attached Agent');
    return boundSources(holder.instanceId);
  });
  const workerTrace = async (query = {}) => {
    const agent = agentForRequest(query);
    if (!agent) return { available: false, computer: os.hostname() };
    if (traceLink?.instanceId !== agent.instanceId)
      traceLink = { instanceId: agent.instanceId, url: new URL((await manager('/manager/instances/open', { instanceId: agent.instanceId, page: '/' })).url) };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1500);
    let text = '';
    try {
      const response = await fetch(`${traceLink.url.origin}/events?k=${encodeURIComponent(traceLink.url.searchParams.get('k') ?? '')}&history=paged`, { signal: abort.signal });
      if (!response.ok) throw new Error(`the Worker trace answered ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    } catch (error) {
      if (error.name !== 'AbortError') { traceLink = null; throw error; }
    } finally { clearTimeout(timer); }
    const events = text.split('\n\n').filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => { try { return JSON.parse(chunk.slice(6)); } catch { return null; } })
      .filter((event) => event?.src === 'worker');
    const lastAvailability = [...events].reverse().find((event) => event.type === 'availability');
    return { available: true, agentName: agent.agentName, state: lastAvailability?.state ?? 'unknown', computer: os.hostname() };
  };
  // The Agent's call that waits for a person (a decision, or reconciling its result), from the manager's Health read, with
  // its page in Console: the 任务 panel shows it after a restart too, before the conversation's next result. Only whether
  // it needs a person and its phase reach the page. Read on a slow poll; the manager reads the service only when asked.
  const health = async (query = {}) => {
    const agent = agentForRequest(query);
    if (!agent) return { available: false };
    const reply = await manager('/manager/health');
    const row = (reply.health?.agents ?? []).find((entry) => entry.agentId === agent.agentId);
    const call = row?.pendingCall;
    return { available: true, consoleUrl: typeof row?.console?.runtime === 'string' ? row.console.runtime : '',
      pendingCall: call ? { needsPerson: call.needsPerson === true, phase: typeof call.phase === 'string' ? call.phase : '' } : null };
  };
  // PSC 0.2.24 (D-1018b batch 3): the owner opens a folder of this computer as a project here, confirming once what it
  // grants; no Console step. The page drives the flow (confirmation, progress, asking again); these routes only read and
  // open through the manager's device grant. Once a project is ready its folder appears under the Agent at once.
  // Before a folder is opened, the same "set up on this computer" runs in repair mode (PSC 0.2.27 ③): whatever is missing
  // (the kit, the Worker, an unfinished pairing) is fixed first, and an existing pairing is left as it is. Once per Agent
  // per half minute, so the page's progress reads do not repeat it.
  const repaired = new Map();
  const repair = async (agentId) => {
    if (Date.now() - (repaired.get(agentId) ?? 0) < 30_000) return;
    await setup.ready({ agentId, mode: 'repair' });
    repaired.set(agentId, Date.now());
  };
  // Model-command isolation (D-1024a): a project may neither contain nor lie inside Rulith's own credential or work
  // locations; the folder's prior label is recorded in the manager home.
  const credentialRootsListed = () => { try { const v = JSON.parse(process.env.RULITH_CREDENTIAL_ROOTS ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const projects = projectRoutes({ manager, repair, onReady: (instanceId) => sourcesCache.delete(instanceId), managerHome: home,
    protectedRoots: () => [home, process.env.DSH_HOME, config.keyFile, rulithBackstop(), workBase(), ...credentialRootsListed()] });
  // The Agent and the conversation key a session's settings belong to. Only observed mappings: a session that never used
  // Rulith has no Board yet, and asking must not open a connection (same rule as the Board panel).
  const pendingControls = new Map();
  const conversationTarget = (session) => {
    if (typeof session !== 'string' || !session) throw new Error('会话标识无效。');
    const holder = resolveHolder(session, sessions.get(session)?.session?.header?.cwd);
    if (!holder) throw new Error('这个会话的智能体还没有在这台电脑上设置好：先在左侧为它「在本机设置」。');
    if (!holder.boards.enabled) throw new Error('这个应用设置成所有会话共用一份记录（conversationBoards 关闭），会话的档位和审查只能在 Console 里改。');
    // The key is a function of the top-level session id (subagents.mjs), so a conversation that has not called Rulith yet,
    // or one opened from before this launcher started, is addressed the same way as an observed one.
    const key = holder.boards.sessions.get(session) ?? conversationKey({ session: { id: session } });
    return { agentId: holder.agentId, conversationKey: key, holder };
  };
  // A setting chosen before the conversation's first Rulith call: open its Board first (MCP initialize creates it with the
  // Agent's defaults), then the switch applies to that Board. Only on the owner's explicit choice, never from polling.
  const withBoard = async (target, send) => {
    const first = await send();
    if (first.found !== false) return first;
    // Opening the Board fixes the conversation's Agent, as a tool call would.
    if (!assignments.has(target.session)) { assignments.set(target.session, target.agentId); void saveAssignments(); }
    await target.holder.boards.ensureBoard(target.conversationKey);
    return send();
  };
  // Agent -> directory -> conversation. Directories are the Agent's file Sources on this computer; an Agent without one
  // gets its own empty working directory under the dsh home, so that it can still hold conversations (dsh needs a
  // directory per conversation). Only names, ids, paths and states reach the page.
  const slug = (name) => String(name || 'agent').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agent';
  const sidebarTree = async () => {
    const state = await manager('/manager/state');
    const instances = (state.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt);
    const owners = new Map();
    const agents = [];
    for (const agent of state.device?.agents ?? []) {
      const instance = instances.find((row) => row.agentId === agent.id);
      const holder = attached.get(agent.id);
      const directories = [];
      if (holder) {
        const sources = await boundSources(holder.instanceId).catch(() => []);
        for (const source of sources) {
          if (source.type !== 'file' || !source.location) continue;
          let exists = false;
          try { exists = fs.statSync(source.location).isDirectory(); } catch {}
          if (!exists || directories.some((d) => samePath(d.path) === samePath(source.location))) continue;
          // A project opened from here is named by the official capability (project, project-<8 hex>): show its folder.
          directories.push({ path: path.resolve(source.location),
            label: PROJECT_SOURCE.test(source.name) ? path.basename(path.resolve(source.location)) || source.name : source.name,
            source: source.name });
        }
        if (!directories.length) {
          const own = path.join(stateDir, 'agents', slug(agent.name));
          try { fs.mkdirSync(own, { recursive: true }); } catch {}
          directories.push({ path: own, label: '工作台', source: null });
        }
      }
      // `isDefault`: the account's default Agent, as the service marks it; absent when it does not say (no badge then).
      agents.push({ agentId: agent.id, name: agent.name, ...(typeof agent.isDefault === 'boolean' ? { isDefault: agent.isDefault } : {}),
        attached: !!holder, paired: !!instance?.paired,
        worker: instance?.workerSetting ? { enabled: !!instance.workerSetting.enabled, state: instance.workerSetting.state ?? '' } : null,
        liveConversations: holder?.boards.size ?? 0, directories });
    }
    // A directory several Agents share belongs, for conversations not yet assigned, to the default Agent when it is one
    // of them (it was the only Agent before the sidebar existed), else to the first.
    const defaultId = defaultHolder()?.agentId;
    for (const a of [...agents].sort((x, y) => (y.agentId === defaultId) - (x.agentId === defaultId)))
      for (const d of a.directories) if (!owners.has(samePath(d.path))) owners.set(samePath(d.path), a.agentId);
    dirOwners = owners;
    return { defaultAgentId: defaultHolder()?.agentId ?? null, agents, assignments: Object.fromEntries(assignments) };
  };
  // The OS folder chooser for 「打开文件夹…」 (folder-picker.mjs): dsh's directory-picker service, when it is composed.
  const folders = folderPicker({ service: () => ctx.get?.('directoryPicker') });
  const routes = {
    // PSC 0.2.27 ② ③: start (or continue, with the same requestId) setting one Agent up on this computer; answers at once
    // with the step list. Every 「在本机设置」 click is `setup` mode (it checks this computer's Connection and may start a
    // Worker that stopped itself); `mode: "repair"` leaves a working pairing as it is and is what opening a folder and the
    // app's start run. `replaceAgentToken: true` is the owner's confirmation, after the page showed what replacing this
    // Agent's token does (SYS-LOCAL-01). The GET reads it: { requestId, agentId, mode, state, connectionId,
    // connectionDisposition, steps }; once it is done the Agent is attached at once, so the sidebar can start conversations.
    'POST /rulith/api/setup': (body) => setup.start({ agentId: body.agentId, ...(body.mode === 'repair' ? { mode: 'repair' } : {}),
      ...(body.requestId ? { requestId: body.requestId } : {}), ...(body.replaceAgentToken === true ? { replaceAgentToken: true } : {}) }),
    'GET /rulith/api/setup': async (query) => {
      const view = await setup.status(query);
      if (view.state === 'done') await tick();
      return view;
    },
    // PSC 0.2.27 ④: the model in force (no key), and saving it for the signed-in account; used from the next turn. The
    // composer asks for its conversation's (`session`): that conversation's Agent's model.
    'GET /rulith/api/model': (query) => models.get(query.agentId || !query.session ? query
      : { agentId: conversationAgent(query.session, sessions.get(query.session)?.session?.header?.cwd) }),
    'POST /rulith/api/model': (body) => models.save(body),
    // Design §3.2 打开文件夹: the operating system's folder chooser, opened in this process and closed again when the page
    // goes away. GET: { available }. POST: { state: chosen | cancelled | unavailable, path?, teaching? }; the chosen folder
    // is then opened through the project routes below like a typed one.
    'GET /rulith/api/pick-folder': () => folders.available(),
    'POST /rulith/api/pick-folder': (_body, request) => folders.pick(request),
    'POST /rulith/api/projects/state': (body) => projects.state(body),
    'POST /rulith/api/projects/open': (body) => projects.open(body),
    'GET /rulith/api/health': (query) => health(query),
    'GET /rulith/api/state': async () => summary(await manager('/manager/state')),
    // Settings → Advanced → Diagnosis: versions, isolation status, folders (diagnosis.mjs). Paths and versions only.
    'GET /rulith/api/diagnosis': () => diagnosisReport({ managerHome: home, dshHome: process.env.DSH_HOME, appHome: process.env.RULITH_DSH_APP_HOME,
      kitHome: config.kitHome || process.env.RULITH_DSH_KIT_HOME, keyFile: config.keyFile, legacyWorkbench }),
    'GET /rulith/api/worker': (query) => workerTrace(query),
    'POST /rulith/api/signin': async () => {
      const reply = await manager('/manager/device/start', { consoleUrl, name: os.hostname() });
      return { url: reply.device?.consoleUrl ?? '' };
    },
    'POST /rulith/api/signin/poll': async () => { await manager('/manager/device/poll', {}); return summary(await manager('/manager/state')); },
    'POST /rulith/api/signout': async () => { await manager('/manager/device/signout', {}); for (const holder of [...attached.values()]) drop(holder);
      live.forgetOtherAccounts(null); return summary(await manager('/manager/state')); },
    // The 任务 panel's read: this conversation's cached results (never a Board read), and the two Console pages a person may
    // need from it (an operation that waits for them; a goal they accept in Console), at the origin this computer signed in to.
    'GET /rulith/api/board': (query) => {
      const holder = query.session === undefined ? defaultHolder() : resolveHolder(query.session, sessions.get(query.session)?.session?.header?.cwd);
      const view = cachedBoard(holder, status, query.session);
      let origin = '';
      try { origin = signedInAccount(home)?.origin ?? ''; } catch { origin = ''; }
      return holder && origin ? { ...view, consoleUrl: consoleRuntimeUrl(origin, holder.agentId), casesUrl: consoleGoalsUrl(origin, holder.agentId) } : view;
    },
    // The sidebar: every Agent of the signed-in account, its directories on this computer and which conversation is whose.
    'GET /rulith/api/tree': () => sidebarTree(),
    // The sidebar starts a conversation in one Agent's directory and records the Agent before the first message. A
    // conversation that already has a Board keeps its Agent.
    'POST /rulith/api/sessions/assign': async (body) => {
      const session = String(body.session ?? ''), agentId = String(body.agentId ?? '');
      if (!session || !agentId) throw new Error('请求里缺少会话或智能体。');
      const holder = attached.get(agentId);
      if (!holder) throw new Error('这个智能体还没有在这台电脑上设置好。');
      const before = assignments.get(session);
      if (before && before !== agentId) {
        const previous = attached.get(before);
        const hasBoard = previous?.boards.sessions.has(session) && previous.boards.holders.has(previous.boards.sessions.get(session));
        if (hasBoard) throw new Error('这个会话已经属于另一个智能体：请开一个新会话。');
        previous?.boards.disposeSession({ id: session });
      }
      assignments.set(session, agentId); await saveAssignments();
      const live = sessions.get(session);
      if (live) holder.boards.observe(live);
      return { session, agentId };
    },
    // ACC-CONV-05/06 (PSC 0.2.16 ③): this conversation's own exploration mode and post-call review switch, issued by the
    // signed-in owner's client through the manager's device grant. The conversation names itself by its key; nothing else
    // of the manager's state reaches the browser (conversationView picks the fields).
    'GET /rulith/api/conversation': async (query) => {
      const { agentId, conversationKey: key } = conversationTarget(query.session);
      return conversationView(await manager('/manager/conversations/state', { agentId, conversationKey: key }));
    },
    'POST /rulith/api/conversation/exploration-mode': async (body) => {
      // PSC 0.2.27 ①: one tier per conversation. The Gateway writes it to every Connection of the conversation's Board, so
      // the request names no Connection. A control's request id is its identity: a reply lost in transit leaves the control
      // pending on the Gateway, and only the same id resumes it (a new one is refused as control_pending). Keep the id of an
      // unconfirmed switch and resend it for the same conversation and mode until the Gateway answers complete.
      const target = { ...conversationTarget(body.session), session: body.session };
      const mode = String(body.mode ?? '');
      const pendingKey = `${target.conversationKey}|${mode}`;
      const requestId = pendingControls.get(pendingKey) ?? randomUUID();
      pendingControls.set(pendingKey, requestId);
      const view = await withBoard(target, async () => conversationView(await manager('/manager/conversations/exploration-mode',
        { agentId: target.agentId, conversationKey: target.conversationKey, mode, requestId })));
      if (view.state === 'complete') pendingControls.delete(pendingKey);
      return view;
    },
    'POST /rulith/api/conversation/review': async (body) => {
      const target = { ...conversationTarget(body.session), session: body.session };
      return withBoard(target, async () => conversationView(await manager('/manager/conversations/review',
        { agentId: target.agentId, conversationKey: target.conversationKey, enabled: body.enabled === true })));
    },
    // Batch 4 (design §5 d, D-1024a; PSC 0.2.28): the person signs the criteria the Agent proposed for one goal of this
    // conversation as its acceptance, from their own client through this computer's device grant (the same path as the tier
    // switch). Sent only after the person confirmed in the page's dialog; the page makes one request id per confirmation and
    // sends the same one again while the answer is pending. A request that got no definite answer — the manager could not be
    // reached mid-request, or the account service did not answer — is `signature_unconfirmed`: the page says the outcome
    // is not confirmed yet, never that nothing was signed. 中文说明：只有确认框里的「签字」才会走到这里；没有确定回答的请求如实说“还没有确认”。
    'POST /rulith/api/conversation/sign-acceptance': async (body) => {
      const target = conversationTarget(body.session);
      const goal = typeof body.goal === 'string' ? body.goal : '';
      const leaves = Array.isArray(body.leaves) ? body.leaves : [];
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      if (!goal || goal.length > 256 || !leaves.length || leaves.length > 64 || new Set(leaves).size !== leaves.length
        || leaves.some((leaf) => typeof leaf !== 'string' || !leaf || leaf.length > 256) || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId))
        throw new Error('签字请求不完整：缺少任务、确认过的标准或这次确认的请求号。');
      let reply;
      try {
        reply = await manager('/manager/conversations/sign-acceptance',
          { agentId: target.agentId, conversationKey: target.conversationKey, goal, leaves, requestId });
      } catch (error) {
        // An answer of the manager (with or without a code) is definite; a connection refused never reached it.
        if (error.errorCode || error.status !== undefined || error.cause?.code === 'ECONNREFUSED') throw error;
        throw Object.assign(new Error('签字已经发出，结果还没有确认。'), { errorCode: 'signature_unconfirmed' });
      }
      // The answer is Console's control record (as Console checks it): this request id, this Agent and exactly this
      // operation. Any other record does not confirm this signature, so the same request is sent again.
      const operation = reply.operation;
      if (reply.requestId !== requestId || reply.agentId !== target.agentId || !operation || operation.kind !== 'SignAcceptance'
        || operation.goal !== goal || JSON.stringify(operation.leaves) !== JSON.stringify(leaves))
        throw Object.assign(new Error('收到的回答不能确认这次签字。'), { errorCode: 'signature_unconfirmed' });
      return conversationView(reply);
    },
    // PSC 0.2.21: deleting a conversation. The preview feeds the confirmation dialog; the deletion seals the conversation's
    // Board and closes its open goals as abandoned (records are kept). Its request id is fixed by the conversation, so a
    // retry after a lost reply finishes the same deletion. The browser then removes the conversation from the list.
    'POST /rulith/api/conversation/end-preview': async (body) => {
      const { agentId, conversationKey: key } = conversationTarget(body.session);
      return conversationView(await manager('/manager/conversations/end-preview', { agentId, conversationKey: key }));
    },
    'POST /rulith/api/conversation/end': async (body) => {
      const target = conversationTarget(body.session);
      const view = conversationView(await manager('/manager/conversations/end', { agentId: target.agentId,
        conversationKey: target.conversationKey, requestId: 'end.' + createHash('sha256').update(String(body.session)).digest('hex').slice(0, 32) }));
      if (view.ended) target.holder.boards.drop(target.conversationKey);
      return view;
    },
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/rulith/api',
    async handler(req, res) {
      // A custom header keeps cross-site pages out (they cannot send it without a preflight dsh does not grant); the Host
      // check keeps out a rebinding name that resolves to this computer.
      const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
      if (req.headers['x-deep-rulith'] !== '1' || !loopbackHost) return send(res, 403, { ok: false, teaching: '只接受本页发出的 Rulith 请求。' });
      // 以前这条前缀路由只看 `x-deep-rulith:1`（一个常量，不是机密）和 loopback Host，不要本页的会话凭据。loopback 对
      // 这台电脑上每个账户、每个程序共享：模型命令只要能向 127.0.0.1:3080 发请求，就能在不读任何机密的情况下，对这条路由
      // 做出签字、设置档位、打开项目、setup、删除会话等有后果的操作（SSRF 防线只管工具，管不到命令里启动的 curl/node）。
      // 所以这里加上与其它接口同一道的会话校验：`ctx.connection.admit()` 验签名 cookie（机密在凭据库里，不在这条路由上，
      // 命令无法伪造）。本页带 cookie 照常通过；无凭据的请求被拒。model-command-isolation（D-1024a / PSC 0.2.29）。
      const admission = ctx.connection?.admit?.(req);
      if (admission === undefined) return send(res, 503, { ok: false, teaching: "Rulith could not confirm this page's session." });
      if (admission.rejection !== undefined) return send(res, admission.rejection, { ok: false,
        teaching: admission.rejection === 401 ? "This needs this page's Rulith session." : "This page's Rulith session did not pass the check." });
      const route = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
      if (!route) return send(res, 404, { ok: false, teaching: '没有这个 Rulith 接口。' });
      const query = () => {
        const params = new URL(req.url, 'http://127.0.0.1').searchParams;
        return { ...Object.fromEntries(params), workspace: params.get('workspace'), session: params.get('session') ?? undefined };
      };
      // Aborted when the page goes away before the answer (the folder chooser closes then).
      const gone = new AbortController();
      res.on?.('close', () => { if (!res.writableEnded) gone.abort(); });
      try { send(res, 200, { ok: true, ...(await route(req.method === 'POST' ? await readBody(req) : query(), { signal: gone.signal })) }); }
      catch (error) { send(res, 200, { ok: false, teaching: String(error?.message ?? error).slice(0, 400),
        ...(typeof error?.errorCode === 'string' ? { errorCode: error.errorCode } : {}) }); }
    },
  }));
  await tick();
}
