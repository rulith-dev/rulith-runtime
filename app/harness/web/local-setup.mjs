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
