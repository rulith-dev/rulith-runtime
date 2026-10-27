// "Set up this Agent on this computer" (PSC 0.2.27 ② ③), the app host's half: the browser starts the manager's one
// operation and reads its step list; opening a folder and the app's start run the same operation in repair mode.
// Nothing here installs, pairs or starts anything itself — the Runtime manager does, in one place
// (local/setup-local.mjs, local/instance-manager.mjs) — and nothing that reaches the page carries a secret.
//
// 中文说明：浏览器经这里启动管理器的"在本机设置"并读取逐步进度；打开文件夹前和应用启动时用 repair 模式跑同一个操作。
// 这里自己不装、不配对、不启动任何东西，交给页面的字段里没有任何凭据。
import { randomUUID } from 'node:crypto';
import { say } from './ui-texts.mjs';

/** What the page may see of one setup: its id, Agent, state, Connection id and disposition, and the step list. */
export const setupView = (reply) => {
  const row = reply?.setup ?? reply ?? {};
  return { requestId: String(row.requestId ?? ''), agentId: String(row.agentId ?? ''), mode: String(row.mode ?? ''),
    ...(row.replaceAgentToken === true ? { replaceAgentToken: true } : {}),
    state: String(row.state ?? ''), instanceId: String(row.instanceId ?? ''), connectionId: String(row.connectionId ?? ''),
    connectionDisposition: String(row.connectionDisposition ?? ''),
    steps: (Array.isArray(row.steps) ? row.steps : []).map(({ name, state, reason, errorCode }) => ({
      name: String(name ?? ''), state: String(state ?? ''), reason: String(reason ?? ''),
      ...(typeof errorCode === 'string' ? { errorCode } : {}) })) };
};

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
/** The longest one setup may take before the waiting caller stops waiting (the operation itself goes on). */
export const SETUP_WAIT_MS = 180_000;

/**
 * @param {object} options
 * @param {(route: string, body?: object) => Promise<object>} options.manager - the host's manager call.
 * @param {string} [options.kitHome] - where a new Agent's general kit home goes when it has none yet (the app home's kit).
 */
export function setupRoutes({ manager, kitHome = '', wait = (ms) => new Promise((done) => setTimeout(done, ms)), waitMs = SETUP_WAIT_MS }) {
  const status = async (query = {}) => {
    const requestId = String(query.requestId ?? '');
    if (!REQUEST_ID.test(requestId)) throw Object.assign(new Error(say('setup.unknownRequest')), { errorCode: 'setup_unknown' });
    return setupView(await manager(`/manager/instances/setup-local?requestId=${encodeURIComponent(requestId)}`));
  };
  // `replaceAgentToken: true` only as the owner's confirmation (SYS-LOCAL-01); it is passed on only when it is exactly true.
  const start = async (body = {}) => {
    const requestId = body.requestId === undefined ? randomUUID() : String(body.requestId);
    return setupView(await manager('/manager/instances/setup-local', { requestId, agentId: String(body.agentId ?? ''),
      mode: body.mode === 'repair' ? 'repair' : 'setup', ...(kitHome ? { kitHome } : {}),
      ...(body.replaceAgentToken === true ? { replaceAgentToken: true } : {}) }));
  };
  /** Start (or continue) one setup and wait until it settles. A failure is thrown with its step's reason and code. */
  const ready = async (body = {}) => {
    let setup = await start(body);
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (setup.state === 'done') return setup;
      if (setup.state === 'failed') {
        const step = setup.steps.find((row) => row.state === 'failed');
        throw Object.assign(new Error(step?.reason || say('setup.notFinished')),
          { errorCode: step?.errorCode ?? 'setup_failed', setup });
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(say('setup.inProgress')),
          { errorCode: 'setup_in_progress', setup });
      }
      await wait(250);
      setup = await status(setup);
    }
  };
  return { start, status, ready };
}

/**
 * Settings → Advanced: the owner's "Run without isolation (not recommended)" for one Agent on this computer (PSC 0.2.31
 * ③), off by default. The page sends `{ agentId, runWithoutIsolation, confirmed? }`; turning it on is passed on only with
 * `confirmed: true`, which the page sends after its confirmation (`Run model commands without isolation?`) was
 * accepted. The manager writes it into that Agent's instance local.json Worker environment (`RULITH_ADAPTER_SANDBOX=off`,
 * inside a credential root) and restarts a running Worker with it once its running executions drain (`restarting`).
 * Only the Agent, the value and whether the Worker restarts reach the page.
 *
 * 中文说明：「不隔离运行（不推荐）」按智能体设置：打开必须带页面确认框的确认（confirmed: true），关掉不需要；写入由管理器
 * 完成，运行中的 Worker 排空后重启以用上新值。
 */
export function isolationRoutes({ manager }) {
  const set = async (body = {}) => {
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const on = body.runWithoutIsolation;
    if (!agentId || typeof on !== 'boolean') throw new Error(say('isolation.incomplete'));
    if (on && body.confirmed !== true) throw Object.assign(new Error(say('isolation.unconfirmed')), { errorCode: 'isolation_unconfirmed' });
    // The Agent must be one of the signed-in account's, set up on this computer (the instance the settings page lists).
    const state = await manager('/manager/state');
    const inAccount = (state.device?.agents ?? []).some((agent) => agent.id === agentId);
    const instance = (state.instances ?? []).find((row) => row.mode === 'local_agent' && row.agentId === agentId && !row.signedOutAt);
    if (!inAccount || !instance) throw new Error(say('assign.notSetUp'));
    const reply = await manager('/manager/instances/isolation', { instanceId: instance.id, runWithoutIsolation: on, ...(on ? { confirmed: true } : {}) });
    return { agentId, runWithoutIsolation: reply.runWithoutIsolation === true, restarting: reply.restarting === true };
  };
  return { set };
}

/**
 * D-1026a (owner, 2026-10-26): post-call review is optional in every exploration mode, switched per conversation in the
 * composer, with an Agent-level default here, and never needs Console. The reviewer reads each write call after it runs
 * and may add advice to its result; it never blocks a call (D-1013f). These routes read and change the Agent's side of
 * it through the manager's device grant:
 *
 * - `read({ agentId })`: who reviews for the Agent (`this` computer, an `other` computer, or `none`), its review deadline
 *   and its "review new conversations" default, from the Gateway's review-state route, which creates nothing. It names
 *   the reviewer only by its Connection id, so another computer is not named.
 * - `designate({ agentId, reviewer: 'this' | 'none', reviewSeconds? })`: this computer becomes the reviewer, with the
 *   deadline given (without one the Gateway keeps the current deadline of an unchanged reviewer), or the Agent has none.
 *   The Connection id sent is the one the manager has for this computer's instance of that Agent; the page never names
 *   one, and the manager refuses any other.
 * - `setDefault({ agentId, enabled })`: the default; turning it on for an Agent with no reviewer first makes this
 *   computer its reviewer.
 * - `designateIfNone(agentId)`: used when a conversation's review is turned on (rulith-runtime.mjs). It asks the Gateway
 *   with `ifNone: true` and no deadline, so the Gateway designates only while the Agent still has no eligible reviewer.
 *   With an account service from before these routes it designates nothing and the conversation's switch still goes.
 *
 * `designated` is true only when this computer became the reviewer by that request (it was not before, and is after).
 *
 * A reviewer Connection reviews with its Agent's own model: the Runtime gives that Agent's Worker the Agent's model as
 * its reviewer route at every Worker start (local/rulith-local.mjs, local/model-settings.mjs reviewerRoute). Only the
 * Agent's fields reach the page, never a Connection id.
 *
 * 中文说明：事后审查在每个档位都可选，按会话在输入行开关，智能体的默认值在设置里，不需要 Console。审查员只在写入调用执行后
 * 读它、可附建议，从不拦下调用。指定审查员时发出的连接号只取管理器给这台电脑这个智能体的连接；页面看不到任何连接号。
 */
export const REVIEW_SECONDS = Object.freeze({ min: 60, max: 300 });
/**
 * The Agent's reviewer as far as reviewing goes: the Connection id in a review answer's `reviewer`, unless its
 * `reviewerState` is `ineligible` (that Connection was revoked or deleted), in which case the Agent has none and may be
 * given another. The Gateway's other states keep the reviewer: `ready`; `disconnected` (its Worker is offline, or its key
 * is being changed) and `not_configured` (its Worker does not offer review), whose reviews are recorded as unavailable;
 * `not_designated` comes with no reviewer at all. The one place the Gateway's state names are read. Pure.
 * 中文说明：只有 ineligible（审查员的连接被撤销或删除）算没有审查员；离线（disconnected）或没提供审查（not_configured）的仍是审查员。
 */
const INELIGIBLE_REVIEWER_STATES = new Set(['ineligible']);
export const effectiveReviewer = (reply) => {
  const reviewer = typeof reply?.reviewer === 'string' ? reply.reviewer : '';
  return reviewer && !INELIGIBLE_REVIEWER_STATES.has(String(reply?.reviewerState ?? '')) ? reviewer : '';
};
/**
 * No review routes on the way: an account service from before them (PSC 0.2.33) answers `not_found` (no such route) or
 * `bad_command`; a proxy's 404 without a JSON body reaches here as `not_found` too (device-client.mjs agentReviewState);
 * a manager from before them (one already running on the port) answers 404 itself.
 */
const reviewUnsupported = (error) => ['not_found', 'bad_command'].includes(error?.errorCode) || error?.status === 404;
const validSeconds = (value) => Number.isInteger(value) && value >= REVIEW_SECONDS.min && value <= REVIEW_SECONDS.max;

export function reviewRoutes({ manager }) {
  const agentOf = (body) => {
    const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
    if (!agentId) throw new Error(say('review.incomplete'));
    return agentId;
  };
  /** The Agent must be the signed-in account's; `here` is this computer's Connection for it ('' when it has none). */
  const place = async (agentId) => {
    const state = await manager('/manager/state');
    if (!(state.device?.agents ?? []).some((agent) => agent.id === agentId)) throw new Error(say('open.notInAccount'));
    const instance = (state.instances ?? []).find((row) => row.mode === 'local_agent' && row.agentId === agentId && !row.signedOutAt);
    return { here: typeof instance?.connectionId === 'string' ? instance.connectionId : '' };
  };
  const agentState = (agentId) => manager('/manager/agents/review-state', { agentId });
  /** What the page may see: who reviews, by kind, the deadline and the default. Pure. */
  const view = (agentId, reply, here) => {
    const reviewer = effectiveReviewer(reply);
    return { agentId, reviewer: !reviewer ? 'none' : reviewer === here ? 'this' : 'other',
      reviewSeconds: validSeconds(reply?.reviewSeconds) ? reply.reviewSeconds : null,
      reviewNewConversations: typeof reply?.reviewNewConversations === 'boolean' ? reply.reviewNewConversations : null,
      thisComputer: here !== '' };
  };
  const read = async (query = {}) => {
    const agentId = agentOf(query);
    const { here } = await place(agentId);
    return view(agentId, await agentState(agentId), here);
  };
  /** Refused (nothing sent) when this computer is not set up for the Agent: it has no Connection to designate. */
  const notHere = () => Object.assign(new Error(say('review.notHere')), { errorCode: 'reviewer_not_set_up_here' });
  const designate = async (body = {}) => {
    const agentId = agentOf(body);
    if (!['this', 'none'].includes(body.reviewer)) throw new Error(say('review.incomplete'));
    if (body.reviewSeconds !== undefined && (body.reviewer !== 'this' || !validSeconds(body.reviewSeconds))) throw new Error(say('review.deadline'));
    const { here } = await place(agentId);
    if (body.reviewer === 'none') return { ...view(agentId, await manager('/manager/agents/reviewer', { agentId, connectionId: null }), here), designated: false };
    if (!here) throw notHere();
    const before = effectiveReviewer(await agentState(agentId));
    const reply = await manager('/manager/agents/reviewer', { agentId, connectionId: here, ...(validSeconds(body.reviewSeconds) ? { reviewSeconds: body.reviewSeconds } : {}) });
    return { ...view(agentId, reply, here), designated: before !== here && effectiveReviewer(reply) === here };
  };
  /** When the Agent has no eligible reviewer, this computer becomes it. Says whether it did. */
  const designateIfNone = async (agentId, here) => {
    let before;
    try { before = await agentState(agentId); } catch (error) {
      // An account service from before these routes: review stays the conversation's switch alone, as in 0.19.1.
      if (reviewUnsupported(error)) return false;
      throw error;
    }
    if (effectiveReviewer(before)) return false;
    const at = here ?? (await place(agentId)).here;
    if (!at) throw notHere();
    return effectiveReviewer(await manager('/manager/agents/reviewer', { agentId, connectionId: at, ifNone: true })) === at;
  };
  const setDefault = async (body = {}) => {
    const agentId = agentOf(body);
    if (typeof body.enabled !== 'boolean') throw new Error(say('review.incomplete'));
    const { here } = await place(agentId);
    const designated = body.enabled ? await designateIfNone(agentId, here) : false;
    return { ...view(agentId, await manager('/manager/agents/review-default', { agentId, enabled: body.enabled }), here), designated };
  };
  return { read, designate, designateIfNone, setDefault };
}
