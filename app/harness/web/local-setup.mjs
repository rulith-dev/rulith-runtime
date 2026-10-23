// "Set up this Agent on this computer" (PSC 0.2.27 ② ③), the app host's half: the browser starts the manager's one
// operation and reads its step list; opening a folder and the app's start run the same operation in repair mode.
// Nothing here installs, pairs or starts anything itself — the Runtime manager does, in one place
// (local/setup-local.mjs, local/instance-manager.mjs) — and nothing that reaches the page carries a secret.
//
// 中文说明：浏览器经这里启动管理器的"在本机设置"并读取逐步进度；打开文件夹前和应用启动时用 repair 模式跑同一个操作。
// 这里自己不装、不配对、不启动任何东西，交给页面的字段里没有任何凭据。
import { randomUUID } from 'node:crypto';

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
    if (!REQUEST_ID.test(requestId)) throw Object.assign(new Error('Name the setup request to read.'), { errorCode: 'setup_unknown' });
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
        throw Object.assign(new Error(step?.reason || 'Setting this Agent up on this computer did not finish.'),
          { errorCode: step?.errorCode ?? 'setup_failed', setup });
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('Setting this Agent up on this computer is still in progress. Check again shortly.'),
          { errorCode: 'setup_in_progress', setup });
      }
      await wait(250);
      setup = await status(setup);
    }
  };
  return { start, status, ready };
}
