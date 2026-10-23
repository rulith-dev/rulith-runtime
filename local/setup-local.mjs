// SPDX-License-Identifier: Apache-2.0
/**
 * "Set up this Agent on this computer" — the progress of one manager-owned operation (PSC 0.2.27 ② ③, SYS-LOCAL-01).
 *
 * One request id names one operation for one Agent of the signed-in account. Its steps run in a fixed order, each
 * reported as pending, running, done or failed with a short English reason:
 *
 *   instance — reuse this Agent's instance on this computer, or create it;
 *   pair     — keep a working Connection as it is, or reconnect the one this computer had, or let the Gateway choose
 *              (it creates one only when there is none);
 *   kit      — install or refresh the first-party general kit for this instance, after its Worker drained;
 *   worker   — turn this computer's Worker on for this Agent;
 *   reload   — wait until the running Worker was started with the kit's tools and reports them to Rulith;
 *   ready    — the Connection id (never its secret) and whether it was reused or created.
 *
 * A request may carry `replaceAgentToken: true`: the person confirmed replacing this Agent's token (SYS-LOCAL-01), after
 * the pairing step reported `runtime_credential_exists` (another computer or client holds the Agent's token) or
 * `connection_rejected` / `connection_missing` (reconnecting this computer re-pairs, and a new pairing replaces the
 * token). The confirmation belongs to the request: starting the same request again with it continues from the failed
 * step under that confirmation, and it is never taken back for that request. Without it nothing is replaced.
 *
 * The kit is installed before the Worker is turned on, so a first setup starts the Worker once, already with the kit,
 * instead of starting it, draining it and starting it again. A failure stops at its step; starting the same request id
 * again continues from the first step that is not done, and the steps themselves are idempotent, so a lost answer or a
 * restart never repeats an effect. Two requests for one Agent run one after the other. Nothing here grants a tool or
 * Source permission: those stay with opening a project (PSC 0.2.24) or Console.
 *
 * What is stored is the request, the step states and fixed reasons. A reason is an error's own text only when the
 * action marked it as a teaching or when it comes from a step whose errors the manager already returns to its callers
 * (instance, pair, worker); anything else — an installer's file error, say — becomes a fixed sentence, so no provider
 * reply, path or credential is written here. Finished requests beyond the newest 100 are dropped.
 *
 * 中文说明：一个请求号对应一次"在本机设置"，按固定顺序逐步执行并记下每步的状态与英文原因；失败停在那一步，用同一个请求号
 * 再来一次就从没完成的那步接着做。工具包先装好再开启 Worker，首次设置时 Worker 只启动一次。这里不授予任何工具或 Source 权限。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './manager-registry.mjs'

export const SETUP_STEPS = Object.freeze(['instance', 'pair', 'kit', 'worker', 'reload', 'ready'])
export const SETUP_MODES = Object.freeze(['setup', 'repair'])
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const KEPT_FINISHED = 100
const WAITING = Object.freeze({
  instance: 'Find or create this Agent\'s instance on this computer.',
  pair: 'Keep, reconnect or create this computer\'s Connection for this Agent.',
  kit: 'Install or refresh the general kit after the Worker drains.',
  worker: 'Turn on this computer\'s Worker for this Agent.',
  reload: 'Wait for the Worker to report the general kit\'s tools to Rulith.',
  ready: 'Report the result.',
})
const FAILED = 'This step could not be completed. Nothing after it was done; retry the same setup.'
const INTERRUPTED = 'The Rulith manager stopped during this step. Retry the same setup to continue.'
/** Steps whose errors are the manager's own teachings, already returned verbatim by its routes. */
const SPOKEN = new Set(['instance', 'pair', 'worker'])

const text = (value) => (typeof value === 'string' ? value : '')
const reasonOf = (step, error) => (error?.setupTeaching === true || SPOKEN.has(step)
  ? text(error?.message).slice(0, 400) || FAILED : FAILED)
const codeOf = (error) => (typeof error?.errorCode === 'string' && /^[a-z_]{1,64}$/.test(error.errorCode) ? error.errorCode : undefined)

/**
 * @param {object} options
 * @param {string} options.root - the manager directory; progress lives in `setup-local-requests.json` there.
 * @param {(agentId?: string) => {origin: string, accountId: string}} options.scope - the signed-in account, refusing an
 *   Agent that is not one of its enabled Agents.
 * @param {Record<string, (row: object) => Promise<object|undefined>>} options.actions - one per step; the object it
 *   returns is merged into the request (`reason` becomes the step's reason).
 * @param {(action: () => Promise<void>) => Promise<void>} options.admit - the manager's admission gate.
 */
export function createLocalSetup({ root, scope, actions, admit }) {
  const file = join(root, 'setup-local-requests.json')
  const rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  // A request this process did not finish was interrupted: say so, and let the same request continue it.
  for (const row of rows) {
    if (row.state !== 'running' && row.state !== 'pending') continue
    row.state = 'failed'
    for (const step of row.steps) if (step.state === 'running') Object.assign(step, { state: 'failed', reason: INTERRUPTED })
  }
  const running = new Map(), agents = new Map()
  const save = () => {
    const finished = rows.filter((row) => row.state === 'done' || row.state === 'failed')
    if (finished.length > KEPT_FINISHED) {
      const drop = new Set(finished.sort((a, b) => text(a.updatedAt).localeCompare(text(b.updatedAt))).slice(0, finished.length - KEPT_FINISHED))
      for (let index = rows.length - 1; index >= 0; index--) if (drop.has(rows[index])) rows.splice(index, 1)
    }
    writeJsonAtomic(file, rows)
  }
  const view = (row) => ({ requestId: row.requestId, agentId: row.agentId, mode: row.mode, state: row.state,
    ...(row.replaceAgentToken === true ? { replaceAgentToken: true } : {}),
    instanceId: row.instanceId, connectionId: row.connectionId, connectionDisposition: row.connectionDisposition,
    steps: row.steps.map(({ name, state, reason, errorCode }) => ({ name, state, reason, ...(errorCode ? { errorCode } : {}) })) })
  const owned = (row, current) => row !== undefined && row.origin === current.origin && row.accountId === current.accountId
  const status = (requestId) => {
    const row = rows.find((entry) => entry.requestId === requestId)
    if (!owned(row, scope())) throw Object.assign(new Error('No local setup with that request id exists for the signed-in account.'), { errorCode: 'setup_unknown' })
    return view(row)
  }
  const start = ({ requestId, agentId, mode = 'setup', kitHome = '', replaceAgentToken = false } = {}) => {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('Give this setup a request id of 8–128 letters, digits, dots, colons, dashes or underscores.')
    if (!SETUP_MODES.includes(mode)) throw new Error('Choose the setup or repair mode.')
    if (typeof agentId !== 'string' || agentId === '') throw new Error('Choose an Agent of the signed-in account.')
    const current = scope(agentId)
    let row = rows.find((entry) => entry.requestId === requestId)
    if (row !== undefined && (!owned(row, current) || row.agentId !== agentId || row.mode !== mode)) {
      throw Object.assign(new Error('This setup request id already belongs to another Agent, account or mode. Start a new request.'), { errorCode: 'setup_request_conflict' })
    }
    if (row === undefined) {
      const at = new Date().toISOString()
      row = { requestId, agentId, mode, origin: current.origin, accountId: current.accountId, ...(kitHome ? { kitHome } : {}),
        ...(replaceAgentToken === true ? { replaceAgentToken: true } : {}),
        state: 'pending', instanceId: '', connectionId: '', connectionDisposition: '', createdAt: at, updatedAt: at,
        steps: SETUP_STEPS.map((name) => ({ name, state: 'pending', reason: WAITING[name] })) }
      rows.push(row); save()
    }
    if (running.has(requestId) || row.state === 'done') return view(row)
    // A confirmation given when the same request is started again applies from its first unfinished step on.
    // 中文说明：同一个请求再次启动时带上的"确认替换 Agent token"从没完成的那步起生效；对这个请求不再收回。
    if (replaceAgentToken === true && row.replaceAgentToken !== true) { row.replaceAgentToken = true; save() }
    const touch = () => { row.updatedAt = new Date().toISOString(); save() }
    const agentKey = JSON.stringify([current.origin, current.accountId, agentId])
    const run = (agents.get(agentKey) ?? Promise.resolve()).then(() => admit(async () => {
      row.state = 'running'; touch()
      for (const step of row.steps) {
        if (step.state === 'done') continue
        Object.assign(step, { state: 'running', reason: WAITING[step.name] }); delete step.errorCode; touch()
        try {
          // Asked again before every step: an account switch or a removed Agent stops the operation where it is.
          const now = scope(agentId)
          if (now.origin !== row.origin || now.accountId !== row.accountId) {
            throw Object.assign(new Error('The signed-in account changed. Nothing more was done for the previous account.'), { setupTeaching: true })
          }
          const { reason, ...result } = (await actions[step.name](row)) ?? {}
          Object.assign(row, result)
          Object.assign(step, { state: 'done', reason: text(reason) || 'Done.' }); touch()
        } catch (error) {
          const errorCode = codeOf(error)
          Object.assign(step, { state: 'failed', reason: reasonOf(step.name, error), ...(errorCode ? { errorCode } : {}) })
          row.state = 'failed'; touch()
          return
        }
      }
      row.state = 'done'; touch()
    })).catch((error) => {
      // Admission refused (signing out, closing) or the account went away before the first step.
      const step = row.steps.find((entry) => entry.state !== 'done')
      if (step !== undefined) {
        const errorCode = codeOf(error)
        Object.assign(step, { state: 'failed', reason: text(error?.message).slice(0, 400) || FAILED, ...(errorCode ? { errorCode } : {}) })
      }
      row.state = 'failed'; touch()
    }).finally(() => {
      running.delete(requestId)
      if (agents.get(agentKey) === run) agents.delete(agentKey)
    })
    running.set(requestId, run); agents.set(agentKey, run)
    return view(row)
  }
  /** Start (or continue) and wait until it settles: the in-process form for tests and the manager itself. */
  const wait = async (requestId) => { await running.get(requestId); return status(requestId) }
  return { start, status, wait }
}
