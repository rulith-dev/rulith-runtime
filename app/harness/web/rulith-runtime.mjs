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
import { installProjectContext, readSourceBindings, resolveProject } from './project-source.mjs';
import { PROJECT_SOURCE, projectRoutes, sourceAttention } from './open-project.mjs';
import { ShadowReviewer, reviewWithModel, reviewLog } from './shadow-reviewer.mjs';

import { readToolKinds, renderChannelResult } from '../board-channel.mjs';
import { handOf, conversationKey, depthOf } from '../subagents.mjs';
import { ConversationBoards } from './conversation-boards.mjs';
import { conversationBoards } from './launcher-settings.mjs';
export { awaitOutcome } from '../board-channel.mjs';

export const name = 'rulith-runtime';
export const inject = ['tools', 'webServer', 'llm'];

/** The panel observes results already received on this Agent's channel; it never calls MCP.
 * Goal directory rows (including awaiting:"acceptance") pass through unchanged. The browser
 * builds acceptance attention rows from this session's view, using the on-demand workbench link. */
export function cachedBoard(current, status, session) {
  // Session ids are opaque: unusual strings are routed through conversationKey's digest form.
  if (session !== undefined && typeof session !== 'string')
    throw new Error('Invalid session id.');
  if (!current) return { available: false, tools: status };
  if (current.boards?.enabled) {
    if (session === undefined) return { available: true, agentName: current.agentName, liveConversations: current.boards.size };
    // Consult only the observed mapping and existing holders: polling must never open a connection.
    const key = current.boards.sessions.get(session);
    const channel = current.boards.sessions.has(session) ? current.boards.holders.get(key)?.channel : undefined;
    return { available: true, agentName: current.agentName, ...(channel?.latestBoard ?? { view: null }) };
  }
  const channel = current.channel ?? current.boards?.holders.get(undefined)?.channel;
  return { available: true, agentName: current.agentName, ...channel?.latestBoard };
}

/** What the panel may see of a conversation-settings reply: the conversation's row and the control's outcome, nothing of
 * the manager's own state (the manager answers every operation with its full state appended). */
export function conversationView(reply) {
  const out = {};
  for (const field of ['found', 'conversation', 'connections', 'reviewer', 'state', 'result', 'teaching', 'requestId', 'boardId',
    'postCallReview', 'explorationModes', 'openGoals', 'pendingCall', 'ended', 'endedAt', 'closedGoals', 'unconfirmedGoals'])
    if (reply?.[field] !== undefined) out[field] = reply[field];
  return out;
}

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// D-1016a: where the person signs or accepts a goal's criteria: the Agent's cases in Console (a goal's acceptance is on its
// case page). Only from a consoleUrl the launcher settings name; without one the panel offers the local workbench instead.
export function consoleGoalsUrl(consoleUrl, agentId) {
  if (!consoleUrl || !agentId) return '';
  let origin;
  try { origin = new URL(consoleUrl); } catch { return ''; }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return '';
  return `${origin.origin}/console/#/cases?agentId=${encodeURIComponent(agentId)}`;
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
  // 发给模型的那一份在发出前减负（会话不改）：之前轮次的思考不发，减负边界之前的调用长参数缩短（见 outgoing-trim.mjs）。
  installOutgoingTrim(ctx);

  // 1. The Runtime manager: start it unless one already serves this port; stop only the one started here.
  let child = null;
  if (!(await listening(port))) {
    child = spawn(process.execPath, [config.runtimeEntry], {
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
      const error = Object.assign(new Error(reply.teaching || `Rulith answered ${response.status}`), { status: response.status });
      if (typeof reply.errorCode === 'string' && /^[a-z_]{1,64}$/.test(reply.errorCode)) error.errorCode = reply.errorCode;
      throw error;
    }
    return reply;
  };

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
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
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
  const summary = (state) => {
    const chosen = chosenName();
    const instances = (state.instances ?? []).filter((row) => row.mode === 'local_agent' && !row.signedOutAt);
    return {
      signedIn: state.device?.state === 'linked',
      deviceState: state.device?.state ?? 'unknown',
      account: state.device?.account?.name ?? '',
      origin: state.device?.origin || consoleUrl,
      teaching: state.device?.teaching ?? '',
      agents: (state.device?.agents ?? []).map((agent) => {
        const instance = instances.find((row) => row.agentId === agent.id);
        // Worker Connections of this Agent that can be reconnected (Runtime 0.12.5 and later): only names and ids.
        const reconnectable = (Array.isArray(agent.reconnectable) ? agent.reconnectable : [])
          .map((row) => ({ connectionId: String(row.connectionId), name: String(row.displayName || row.name), createdAt: String(row.createdAt ?? '') }));
        return { id: agent.id, name: agent.name, instanceId: instance?.id ?? '', paired: !!instance?.paired, reconnectable,
          worker: instance?.workerSetting ? { enabled: !!instance.workerSetting.enabled, state: instance.workerSetting.state ?? '',
            failure: instance.workerSetting.failure ?? '' } : null };
      }),
      selected: defaultHolder()?.agentName ?? chosen ?? '',
      tools: status,
      model: state.modelDefaults ? { name: state.modelDefaults.name ?? '', url: state.modelDefaults.url ?? '',
        configured: !!state.modelDefaults.configured } : null,
    };
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let text = ''; req.on('data', (chunk) => { text += chunk; if (text.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } }); req.on('error', reject);
  });
  // reconnectConnectionId: an existing Worker Connection of this Agent the person chose to reconnect (PSC SYS-CONN-01,
  // D-1007b); absent means a new Connection.
  const setUp = async (agentId, reconnectConnectionId) => {
    let state = await manager('/manager/state');
    let instance = (state.instances ?? []).find((row) => row.agentId === agentId && row.mode === 'local_agent' && !row.signedOutAt);
    if (!instance) {
      const agent = (state.device?.agents ?? []).find((row) => row.id === agentId);
      if (!agent) throw new Error('This Agent is not in the signed-in account');
      const created = await manager('/manager/instances/create', { name: agent.name, mode: 'local_agent',
        setupTarget: { origin: state.device.origin, accountId: state.device.account.id, agentId } });
      instance = created.instance ?? (created.instances ?? []).find((row) => row.agentId === agentId) ?? created;
    }
    if (!instance.paired) {
      await manager('/manager/instances/pair', { instanceId: instance.id, agentId,
        ...(reconnectConnectionId ? { reconnectConnectionId } : {}) });
      // Pairing often completes inside the pair call; poll only while it is still in progress.
      for (let i = 0; i < 20; i++) {
        state = await manager('/manager/state');
        if ((state.instances ?? []).some((row) => row.id === instance.id && row.paired)) break;
        try { await manager('/manager/instances/pair/poll', { instanceId: instance.id }); } catch { /* re-read the state above */ }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    return instance.id;
  };
  // The selected Agent's local Worker as its own Trace shows it: availability, lease and its latest steps. Read from the
  // instance's event stream through the manager (the address carries the instance key and stays in this process);
  // what reaches the page is shortened text, without keys or result bodies.
  let traceLink = null;
  const shortTool = (id) => String(id ?? '').replace(/^worker_[a-z0-9]+_/, '').replace(/_\d+$/, '').replace(/_[0-9a-f]{12}$/, '')
    .replace(/^eng_/, 'eng.');
  const traceRow = (event) => {
    const at = event.at ?? event.t ?? null;
    const row = (level, text) => ({ at, level, text: String(text).slice(0, 240) });
    switch (event.type) {
      case 'lease': return event.state === 'active' ? row('ok', `租约有效（第 ${event.workerGeneration} 代）`)
        : event.state === 'generation-advanced' ? null : row('warn', `租约：${event.state}${event.errorCode ? `（${event.errorCode}）` : ''}`);
      case 'availability': return row(event.state === 'online' ? 'ok' : 'warn', event.state === 'online' ? '在线' : `不在线（${event.state}）`);
      case 'claimed': return row('info', `领取 ${shortTool(event.id)}`);
      case 'tool-timing': return row(event.outcome === 'returned' ? 'info' : 'warn', `${shortTool(event.tool)} ${event.outcome === 'returned' ? '执行完' : event.outcome}，${((event.durationMs ?? 0) / 1000).toFixed(1)} 秒`);
      case 'reported': if (event.undeliverable) return row('error', event.landed
          ? `${shortTool(event.id)} 的结果送不出（${event.undeliverable}），已转给你处理：在上面“需要处理”里打开 Console 对账`
          : `${shortTool(event.id)} 的结果送不出（${event.undeliverable}），服务没有接住这条报告：在 Console 里处理这次调用`);
        return event.landed === false
        ? row('error', `${shortTool(event.id)} 的结果没有送达（${event.reason ?? '未知'}）：这次调用会一直挂起，需要在 Console 里处理`)
        : row(event.ok === false ? 'warn' : 'ok', `${shortTool(event.id)} ${event.ok === false ? '失败' : '已回报'}`);
      case 'log': return event.stderr ? row('warn', event.line ?? '') : null;
      case 'error': return row('warn', event.note ?? '');
      default: return null;
    }
  };
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
  // The Agent a panel request is about: the conversation's, else the default one.
  const agentForRequest = (query = {}) => resolveHolder(query.session, query.workspace ?? undefined) ?? null;
  installProjectContext(ctx, async (agent) => {
    const holder = agent ? resolveHolder(topSession(agent), agent.session?.header?.cwd) : defaultHolder();
    if (!holder) throw new Error('No attached Agent');
    return boundSources(holder.instanceId);
  });
  const project = async ({ workspace, session }) => {
    try {
      const holder = agentForRequest({ session, workspace });
      if (!holder) throw new Error('No attached Agent');
      const sources = await boundSources(holder.instanceId);
      return { workspace, project: resolveProject(workspace, sources) };
    } catch {
      console.error('[rulith project] Sources cannot be read; panel project unavailable');
      return { workspace, unavailable: true };
    }
  };
  const workerTrace = async (query = {}) => {
    const agent = agentForRequest(query);
    if (!agent) return { available: false };
    const sources = await boundSources(agent.instanceId).catch(() => {
      console.error('[rulith project] Sources cannot be read; Worker bindings unavailable');
      return [];
    });
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
    const rows = events.map(traceRow).filter(Boolean);
    const lastAvailability = [...events].reverse().find((event) => event.type === 'availability');
    return { available: true, agentName: agent.agentName, state: lastAvailability?.state ?? 'unknown', sources,
      stuck: rows.some((row) => row.level === 'error'), events: rows.slice(-30).reverse() };
  };
  // What needs a person for the selected Agent, from the local manager's Health read (Runtime 0.12.6+): one line each, with
  // the place to fix it. Read on a slow poll; the manager itself reads the service only when asked.
  const health = async (query = {}) => {
    const agent = agentForRequest(query);
    if (!agent) return { available: false };
    const goalsUrl = consoleGoalsUrl(config.consoleUrl, agent.agentId);
    let reply;
    try { reply = await manager('/manager/health'); } catch (error) { return { available: true, unsupported: true, goalsUrl, note: String(error.message ?? error).slice(0, 200) }; }
    const all = reply.health ?? {};
    const row = (all.agents ?? []).find((entry) => entry.agentId === agent.agentId);
    const items = [];
    if (all.device && all.device.signedIn === false) items.push({ text: '这台电脑没有登录 Rulith：在左下角重新登录', fix: 'signin' });
    if (row) {
      if (row.pendingCall?.needsPerson) items.push({ text: `一次调用需要你处理：${row.pendingCall.label || row.pendingCall.tool}`, url: row.console?.runtime });
      if (row.program?.state === 'rejected') items.push({ text: `程序更新被拒：${row.program.refusal?.message || row.program.refusal?.errorCode || ''}`, url: row.console?.configuration });
      for (const source of row.sources ?? []) if (source.state !== 'ready') items.push(sourceAttention(source, row.console?.runtime));
      if (row.key && row.key.state !== 'active') items.push({ text: `本机的 Agent 密钥已失效（${row.key.state}）：打开本机 Rulith 修复`, fix: 'workbench' });
      const here = (row.connections ?? []).filter((connection) => connection.registeredHere && connection.state === 'active');
      if (!here.length) items.push({ text: '这台电脑没有接上本机执行的连接：打开本机 Rulith 修复', fix: 'workbench' });
    }
    return { available: true, gatewayState: all.gatewayState ?? 'unavailable', items, goalsUrl };
  };
  // PSC 0.2.24 (D-1018b batch 3): the owner opens a folder of this computer as a project here, confirming once what it
  // grants; no Console step. The page drives the flow (confirmation, progress, asking again); these routes only read and
  // open through the manager's device grant. Once a project is ready its folder appears under the Agent at once.
  const projects = projectRoutes({ manager, onReady: (instanceId) => sourcesCache.delete(instanceId) });
  // The Agent and the conversation key a session's settings belong to. Only observed mappings: a session that never used
  // Rulith has no Board yet, and asking must not open a connection (same rule as the Board panel).
  const pendingControls = new Map();
  const conversationTarget = (session) => {
    if (typeof session !== 'string' || !session) throw new Error('Invalid session id.');
    const holder = resolveHolder(session, sessions.get(session)?.session?.header?.cwd);
    if (!holder) throw new Error('Choose an Agent first');
    if (!holder.boards.enabled) throw new Error('Conversation Boards are off for this launcher; set the exploration mode and reviewer for the Agent in Console');
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
      agents.push({ agentId: agent.id, name: agent.name, attached: !!holder, paired: !!instance?.paired,
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
  const routes = {
    'POST /rulith/api/projects/state': (body) => projects.state(body),
    'POST /rulith/api/projects/open': (body) => projects.open(body),
    'GET /rulith/api/health': (query) => health(query),
    'GET /rulith/api/state': async () => summary(await manager('/manager/state')),
    'GET /rulith/api/worker': (query) => workerTrace(query),
    'GET /rulith/api/project': project,
    'POST /rulith/api/signin': async () => {
      const reply = await manager('/manager/device/start', { consoleUrl, name: os.hostname() });
      return { url: reply.device?.consoleUrl ?? '' };
    },
    'POST /rulith/api/signin/poll': async () => { await manager('/manager/device/poll', {}); return summary(await manager('/manager/state')); },
    'POST /rulith/api/signout': async () => { await manager('/manager/device/signout', {}); for (const holder of [...attached.values()]) drop(holder); return summary(await manager('/manager/state')); },
    'POST /rulith/api/select': async (body) => {
      const state = await manager('/manager/state');
      const agent = (state.device?.agents ?? []).find((row) => row.id === String(body.agentId ?? ''));
      if (!agent) throw new Error('Choose an Agent of the signed-in account');
      // Reconnecting keeps the Agent's Actions and Source bindings on the Connection they belong to; a new Connection
      // leaves them behind. So reconnecting is the default when the Agent offers exactly one Connection (owner, 10-11);
      // a new Connection still needs newConnection:true, and several offered Connections still need a choice (D-1007b).
      const offered = (Array.isArray(agent.reconnectable) ? agent.reconnectable : []).map((row) => String(row.connectionId));
      const instance = (state.instances ?? []).find((row) => row.agentId === agent.id && row.mode === 'local_agent' && !row.signedOutAt);
      const reconnect = typeof body.reconnectConnectionId === 'string' ? body.reconnectConnectionId
        : !instance?.paired && offered.length === 1 && body.newConnection !== true ? offered[0] : '';
      if (!instance?.paired && offered.length && !reconnect && body.newConnection !== true)
        throw new Error('Choose whether to reconnect one of this Agent\'s existing connections or to create a new one');
      if (reconnect && !offered.includes(reconnect)) throw new Error('That connection cannot be reconnected now; refresh and choose again');
      await setUp(agent.id, reconnect);
      fs.writeFileSync(selectionFile, JSON.stringify({ agentName: agent.name }));
      await tick();
      return summary(await manager('/manager/state'));
    },
    'POST /rulith/api/worker': async (body) => {
      await manager('/manager/instances/worker-setting', { instanceId: String(body.instanceId ?? ''), enabled: body.enabled === true });
      return summary(await manager('/manager/state'));
    },
    'GET /rulith/api/board': (query) => cachedBoard(query.session === undefined ? defaultHolder() : resolveHolder(query.session,
      sessions.get(query.session)?.session?.header?.cwd), status, query.session),
    // The sidebar: every Agent of the signed-in account, its directories on this computer and which conversation is whose.
    'GET /rulith/api/tree': () => sidebarTree(),
    // The sidebar starts a conversation in one Agent's directory and records the Agent before the first message. A
    // conversation that already has a Board keeps its Agent.
    'POST /rulith/api/sessions/assign': async (body) => {
      const session = String(body.session ?? ''), agentId = String(body.agentId ?? '');
      if (!session || !agentId) throw new Error('Name the conversation and the Agent');
      const holder = attached.get(agentId);
      if (!holder) throw new Error('That Agent is not set up on this computer');
      const before = assignments.get(session);
      if (before && before !== agentId) {
        const previous = attached.get(before);
        const hasBoard = previous?.boards.sessions.has(session) && previous.boards.holders.has(previous.boards.sessions.get(session));
        if (hasBoard) throw new Error('This conversation already works on another Agent\'s Board; start a new conversation instead');
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
      // A control's request id is its identity: a reply lost in transit leaves the control pending on the Gateway, and only
      // the same id resumes it (a new one is refused as control_pending). Keep the id of an unconfirmed switch and resend it
      // for the same conversation, Connection and mode until the Gateway answers complete.
      const target = { ...conversationTarget(body.session), session: body.session };
      const connectionId = String(body.connectionId ?? ''), mode = String(body.mode ?? '');
      const pendingKey = `${target.conversationKey}|${connectionId}|${mode}`;
      const requestId = pendingControls.get(pendingKey) ?? randomUUID();
      pendingControls.set(pendingKey, requestId);
      const view = await withBoard(target, async () => conversationView(await manager('/manager/conversations/exploration-mode',
        { agentId: target.agentId, conversationKey: target.conversationKey, connectionId, mode, requestId })));
      if (view.state === 'complete') pendingControls.delete(pendingKey);
      return view;
    },
    'POST /rulith/api/conversation/review': async (body) => {
      const target = { ...conversationTarget(body.session), session: body.session };
      return withBoard(target, async () => conversationView(await manager('/manager/conversations/review',
        { agentId: target.agentId, conversationKey: target.conversationKey, enabled: body.enabled === true })));
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
    // The workbench address carries the manager key: handed out only on this guarded same-origin request.
    'POST /rulith/api/workbench': async () => ({ url: `http://127.0.0.1:${port}/?k=${key}` }),
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/rulith/api',
    async handler(req, res) {
      // A custom header keeps cross-site pages out (they cannot send it without a preflight dsh does not grant); the Host
      // check keeps out a rebinding name that resolves to this computer.
      const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
      if (req.headers['x-deep-rulith'] !== '1' || !loopbackHost) return send(res, 403, { ok: false, teaching: 'Same-origin Deep Rulith requests only.' });
      const route = routes[`${req.method} ${(req.url ?? '').split('?')[0]}`];
      if (!route) return send(res, 404, { ok: false, teaching: 'No such Deep Rulith route.' });
      try { send(res, 200, { ok: true, ...(await route(req.method === 'POST' ? await readBody(req)
        : { workspace: new URL(req.url, 'http://127.0.0.1').searchParams.get('workspace'),
          session: new URL(req.url, 'http://127.0.0.1').searchParams.get('session') ?? undefined })) }); }
      catch (error) { send(res, 200, { ok: false, teaching: String(error?.message ?? error).slice(0, 400),
        ...(typeof error?.errorCode === 'string' ? { errorCode: error.errorCode } : {}) }); }
    },
  }));
  await tick();
}
