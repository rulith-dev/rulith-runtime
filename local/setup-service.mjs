// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, createHash, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, copyFileSync, realpathSync, statSync, constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
const digest = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' ? value : ''
const fields = (value, allowed) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected setup fields.') }
function atomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path)
}
export function setupOrigin(raw) {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use a Console HTTPS origin, or a loopback origin for local testing.')
  return url.origin
}

/** 本机保存模型配置和领取私钥；Cloud 只收到配对公钥、资源定位及无凭据工具定义。 */
export function createSetupService({ configFile, getConfig, saveConfig, effectiveEnv, mcpServices, toolManagement, stopped, agentStopped = stopped, agentCredentialConfigured = () => !!getConfig().agent?.env?.RULITH_TOKEN, approvePairing }) {
  const stateFile = configFile + '.setup.json'
  let busy = false
  const state = () => read(stateFile, {})
  const connection = () => { const env = effectiveEnv(); return { id: text(env.RULITH_CONNECTION), key: text(env.RULITH_CONNECTION_KEY), base: env.RULITH_WORK_URL ? new URL(env.RULITH_WORK_URL).origin : '' } }
  const exclusive = async action => {
    if (busy) throw new Error('Wait for the current setup step to finish.')
    busy = true; try { return await action() } finally { busy = false }
  }
  const cloud = async (base, path, body, worker = false) => {
    const credentials = connection()
    const response = await fetch(setupOrigin(base) + path, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(worker ? { 'x-rulith-connection': credentials.id, 'x-rulith-connection-key': credentials.key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const bytes = []; let size = 0
    for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw new Error('Setup response exceeds its size limit.'); bytes.push(chunk) }
    const value = JSON.parse(Buffer.concat(bytes).toString('utf8'))
    if (!response.ok) {
      // 服务端给出的 errorCode 需要原样上抛：取消配对必须区分"已批准"和"没能确认"。
      const error = new Error(text(value.teaching) || 'Console could not confirm this step (' + response.status + ').')
      error.status = response.status
      error.errorCode = text(value.errorCode) || undefined
      throw error
    }
    return value
  }
  const configured = () => !!(connection().id && connection().key)
  const persistConfiguration = (mutate, modelOnly = false) => {
    if (!(modelOnly ? agentStopped() : stopped())) throw new Error(modelOnly ? 'Stop Agent before changing its model.' : 'Stop Agent and Worker before changing local setup.')
    const current = read(configFile, getConfig()), next = structuredClone(current)
    mutate(next); saveConfig(next)
  }
  const context = () => {
    if (!configured()) throw new Error('Pair this Local first.')
    return cloud(connection().base, '/local-setup/context', undefined, true)
  }
  return {
    get busy() { return busy },
    overview() {
      const current = state(), cfg = getConfig()
      return { linked: configured(), machineName: hostname(), clientMode: current.clientMode || (cfg.roles?.includes('agent') ? 'local_agent' : 'existing_agent'),
        consoleUrl: current.base || connection().base || 'https://console.rulith.ai', code: current.code, expiresAt: current.expiresAt,
        agentId: current.agentId, connectionId: connection().id, resources: current.resources || [],
        model: { url: text(cfg.agent?.env?.RULITH_MODEL_URL), name: text(cfg.agent?.env?.RULITH_MODEL), keyConfigured: !!text(cfg.agent?.env?.RULITH_MODEL_KEY) },
        services: mcpServices.overview().services.map(service => ({ name: service.name, tools: service.definition.accessModes.map(mode => ({ name: mode.title, kind: mode.operation })) })), busy }
    },
    context,
    start: body => exclusive(async () => {
      fields(body, ['consoleUrl', 'name', 'clientMode'])
      if (!stopped()) throw new Error('Stop Agent and Worker before pairing.')
      if (connection().id || connection().key) throw new Error('This Local already has a connection identity. Continue with it, or review the deployment configuration before pairing.')
      const base = setupOrigin(body.consoleUrl), name = text(body.name).trim() || hostname(), clientMode = body.clientMode
      if (!['existing_agent', 'local_agent'].includes(clientMode)) throw new Error('Choose an existing client or the Local agent.')
      if (clientMode === 'local_agent' && agentCredentialConfigured()) throw new Error('This Local already has an Agent credential. Use the existing deployment; pairing will not replace its identity.')
      let pending = state()
      const deadline = pending.expiresAt ? Date.parse(pending.expiresAt)
        : pending.requestStartedAt ? Date.parse(pending.requestStartedAt) + 600000 : NaN
      const stale = pending.requestId !== undefined
        && (pending.base !== base || pending.clientMode !== clientMode || pending.name !== name
          || (!Number.isFinite(deadline) || deadline <= Date.now()))
      if (stale) {
        // 一个已经存在的 pairing 不能因为"本机没收到结果"就丢掉证明。
        //
        // 批准可能已经成功而回执丢失：那样这里的旧 requestId/deviceSecret 是唯一还能指向
        // 那份凭据的东西，直接重新生成就等于把一份已签发的 Agent token 留在无人认领的状态,
        // 而且服务端在 replaceAgentToken=false 时会拒绝第二次批准，重试永远卡住。
        // 码过期说明的是"码过期"，不是"批准没发生"。所以先向权威问清楚：只有确认 cancelled
        // 才铸新的；已批准则明确要求去领取，其余一律保留原证明重试。
        const cancelled = await cloud(pending.base ?? base, '/local-setup/cancel',
          { pairingId: pending.requestId, deviceSecret: pending.deviceSecret }).catch(error => {
          if (error?.errorCode !== 'local_setup_already_approved') throw error
          const approved = new Error('The previous pairing for this Local was already approved, so a credential for it exists.'
            + ' Collect it rather than starting a new pairing; if it is unwanted, revoke or replace that Agent\'s token in Console.')
          approved.status = 409; approved.errorCode = error.errorCode
          throw approved
        })
        if (text(cancelled.state) !== 'cancelled' || cancelled.pairingId !== pending.requestId) {
          throw new Error('The previous pairing request could not be confirmed cancelled, so its proof was kept. Try again.')
        }
      }
      if (!pending.requestId || stale) {
        const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
        pending = { ...pending, requestStartedAt: new Date().toISOString(), requestId: randomUUID(), deviceSecret: randomBytes(32).toString('hex'),
          publicKey: keys.publicKey, privateKey: keys.privateKey, base, name, clientMode }
        for (const field of ['code', 'expiresAt', 'approvedAgentId']) delete pending[field]
        atomic(stateFile, pending)
      }
      const reply = await cloud(base, '/local-setup/start', { requestId: pending.requestId, deviceDigest: digest(pending.deviceSecret), name, clientMode, publicKey: pending.publicKey })
      atomic(stateFile, { ...pending, code: reply.code, expiresAt: reply.expiresAt })
      // 已登录设备可直接批准本次配对：仍走同一 /local-setup 通道与同一份一次性证明，
      // 浏览器不接触本机密钥。批准失败不改写本地身份，重试仍是同一 pairing。
      if (approvePairing !== undefined) {
        const approved = await approvePairing({ pairingId: pending.requestId, deviceSecret: pending.deviceSecret, base, clientMode, name })
        const agentId = text(approved?.agentId).trim()
        if (!agentId) throw new Error('Device approval did not name the Agent this pairing was approved for.')
        // 绑定到本实例：后续领取必须是同一个 Agent，切换视图或并发配对都不会改写这里。
        atomic(stateFile, { ...state(), approvedAgentId: agentId })
        return { code: reply.code, expiresAt: reply.expiresAt, approved: true, agentId }
      }
      return { code: reply.code, expiresAt: reply.expiresAt, consoleUrl: base + '/console/#/setup?code=' + encodeURIComponent(reply.code) }
    }),
    poll: () => exclusive(async () => {
      const current = state()
      if (!current.deviceSecret) return { state: configured() ? 'delivered' : 'not_started' }
      const request = { pairingId: current.requestId, deviceSecret: current.deviceSecret }
      if (configured() && (current.connectionId !== connection().id || current.credentialDigest !== digest(connection().key))) throw new Error('Local credentials changed while pairing. The current connection will not be replaced or acknowledged.')
      if (!configured()) {
        const reply = await cloud(current.base, '/local-setup/poll', request)
        if (!reply.key) return { state: reply.state }
        if (reply.pairingId !== current.requestId || reply.clientMode !== current.clientMode || !reply.agentId || !reply.connectionId) throw new Error('Pairing result does not match this Local request.')
        // 设备批准过的配对只接受被批准的那个 Agent。管理器可能同时有多个实例在配对，
        // 一个被换过身份的结果必须在装载凭据之前被拒绝，而不是等到运行时才发现。
        if (current.approvedAgentId && reply.agentId !== current.approvedAgentId) throw new Error('Pairing result names a different Agent than this instance approved.')
        let token
        if (current.clientMode === 'local_agent') {
          token = privateDecrypt({ key: current.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(reply.encryptedAgentToken, 'base64')).toString('utf8')
          if (!token.startsWith('rlt_agt_')) throw new Error('Console did not supply an Agent credential.')
        }
        // 先记录即将保存的身份；断电后只允许同一 Connection/密钥继续确认领取。
        atomic(stateFile, { ...current, agentId: reply.agentId, connectionId: reply.connectionId, credentialDigest: digest(reply.key) })
        persistConfiguration(next => {
          // 已有部署身份不会因为网页重试被替换。各角色身份仍独立，配对结果只装入空槽。
          if (next.worker?.env?.RULITH_CONNECTION_KEY || next.worker?.env?.RULITH_CONNECTION || (token && agentCredentialConfigured())) throw new Error('Local credentials changed while pairing. Reload and review the configuration.')
          next.roles = current.clientMode === 'local_agent' ? ['agent', 'worker'] : ['worker']
          next.worker = { ...next.worker, env: { ...next.worker?.env, RULITH_WORK_URL: current.base + '/work', RULITH_CONNECTION: reply.connectionId, RULITH_CONNECTION_KEY: reply.key } }
          if (token) next.agent = { ...next.agent, env: { ...next.agent?.env, RULITH_URL: current.base, RULITH_TOKEN: token } }
        })
      }
      await cloud(current.base, '/local-setup/ack', request)
      const saved = state(); delete saved.deviceSecret; delete saved.privateKey; delete saved.publicKey; delete saved.credentialDigest; atomic(stateFile, saved)
      return { state: 'delivered' }
    }),
    /**
     * Cancel this Local's unfinished pairing, at the authority that owns it.
     *
     * Local cannot decide this alone. The absence of a delivered credential here proves only
     * that this computer did not *receive* one: an approval may have succeeded and its
     * response been lost, or be in flight right now. So the decision is asked of the service,
     * with the original proof, and nothing local is dropped until it answers `cancelled`.
     *
     *   · `cancelled` — atomically cancelled, and no later start or approval can replay this
     *     pairing. Only then is the pending proof removed, so a retry before confirmation
     *     presents the same proof rather than minting a second request.
     *   · 409 `local_setup_already_approved` — a credential exists for this pairing. Nothing
     *     is touched, here or there; collecting it is what remains.
     *   · anything else, including a lost response — nothing is dropped, and the same
     *     cancellation can be sent again. An unknown answer is not a cancellation.
     */
    cancel: () => exclusive(async () => {
      const current = state()
      if (configured()) throw new Error('This Local already holds a connection identity; there is no unfinished pairing to cancel.')
      if (!current.requestId || !current.deviceSecret) return { state: 'nothing_pending' }
      const reply = await cloud(current.base, '/local-setup/cancel', { pairingId: current.requestId, deviceSecret: current.deviceSecret })
      if (text(reply.state) !== 'cancelled' || reply.pairingId !== current.requestId) {
        throw new Error('The pairing was not confirmed cancelled, so nothing was changed here. Try the cancellation again.')
      }
      // Confirmed. The proof, the key and the code go now — keeping them would let a later
      // attachment reuse a request the service has already refused to honour.
      const saved = state()
      for (const field of ['requestId', 'requestStartedAt', 'deviceSecret', 'privateKey', 'publicKey', 'code', 'expiresAt', 'approvedAgentId', 'clientMode', 'name']) delete saved[field]
      atomic(stateFile, saved)
      return { state: 'cancelled', pairingId: reply.pairingId }
    }),
    model: body => exclusive(async () => {
      // thinking 是可选的既有模型设置；沿用同一次写入，避免出现第二条改模型的路径。
      fields(body, ['url', 'name', 'key', 'thinking'])
      const url = new URL(body.url)
      if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) || !text(body.name).trim() || text(body.name).length > 256 || text(body.key).length > 4096) throw new Error('Provide a model name and HTTPS endpoint, or a local HTTP endpoint.')
      if (body.thinking !== undefined && !['enabled', 'standard', ''].includes(text(body.thinking))) throw new Error('Thinking must be enabled or standard.')
      persistConfiguration(next => {
        next.agent = { ...next.agent, env: { ...next.agent?.env, RULITH_MODEL_URL: url.href, RULITH_MODEL: body.name.trim(),
          ...(text(body.key) ? { RULITH_MODEL_KEY: body.key } : {}),
          ...(body.thinking === undefined ? {} : { RULITH_MODEL_THINKING: text(body.thinking) === 'enabled' ? 'enabled' : '' }) } }
      }, true)
      return { teaching: 'Model configuration saved on this computer.' }
    }),
    example: body => exclusive(async () => {
      fields(body, ['directory'])
      if (!stopped()) throw new Error('Stop Agent and Worker before preparing files.')
      const current = await context()
      if (!current.sources.some(source => source.name === 'verified-calculation-local' && source.type === 'file')) throw new Error('Install Verified Calculation for this Agent in Console first.')
      if (!text(body.directory).trim()) throw new Error('Choose a new directory for the sample.')
      const target = resolve(body.directory)
      if (existsSync(target) && readdirSync(target).length) throw new Error('Choose an empty directory; existing files will not be overwritten.')
      const source = fileURLToPath(new URL('../examples/verified-calculation/', import.meta.url))
      mkdirSync(join(target, 'adapters/verified-calculation'), { recursive: true })
      for (const file of ['read-input.mjs','write-output.mjs','verify-output.mjs']) copyFileSync(join(source,file),join(target,'adapters/verified-calculation',file),fsConstants.COPYFILE_EXCL)
      copyFileSync(join(source,'data/input.json'),join(target,'input.json'),fsConstants.COPYFILE_EXCL)
      // 旧发布包的清单未标出读写类型；向导显式对齐现役计算能力的三个固定 Action。
      // 不改历史下载锚，也不从工具名称推断任意用户工具的类型。
      const manifest = read(join(source,'worker-tools.json'))
      for (const [id, kind] of [['read_input','read'],['write_output','write'],['verify_output','read']]) manifest.tools['rulith.verified_calculation.' + id + '@1'].kind = kind
      writeFileSync(join(target,'worker-tools.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
      persistConfiguration(next => { next.worker = { ...next.worker, env: { ...next.worker?.env, RULITH_WORKER_ROOT: target, RULITH_TOOLS_FILE: join(target,'worker-tools.json') } } })
      atomic(stateFile, { ...state(), resources: [{ name: 'verified-calculation-local', type: 'file', access: target }] })
      return { directory: target }
    }),
    resources: body => exclusive(async () => {
      fields(body, ['resources', 'services'])
      if (!stopped()) throw new Error('Stop Agent and Worker before changing resources.')
      const current = await context(), services = mcpServices.overview().services, resources = []
      if (!Array.isArray(body.resources) || !Array.isArray(body.services) || body.resources.length + body.services.length > 32) throw new Error('Choose at most 32 resources to share with Console.')
      for (const value of body.resources) {
        fields(value, ['name','access'])
        const required = current.sources.find(row => row.name === value.name)
        if (!required || resources.some(row => row.name === value.name) || !['file','db','http','mcp'].includes(required.type) || !text(value.access).trim()) throw new Error('Choose each configured resource once and supply its local location.')
        const access = required.type === 'file' ? realpathSync(value.access) : text(value.access)
        if (required.type === 'file' && !statSync(access).isDirectory() && !statSync(access).isFile()) throw new Error('Local file resource is unavailable.')
        // 非文件凭据由既有 vault 配置，提案仅携带逻辑引用，避免 DSN/token 进入 Cloud。
        if (required.type !== 'file' && !access.startsWith('local://')) throw new Error('Use local://resource-name for a service configured in the local credential vault.')
        resources.push({ name: required.name, type: required.type, access })
      }
      for (const name of body.services) {
        const service = services.find(row => row.name === name)
        if (!service || resources.some(row => row.name === name)) throw new Error('Select each installed MCP service once.')
        resources.push({ name, type: 'mcp', access: 'local://' + name, definition: service.definition })
      }
      // 使用与真实 Worker 相同的组成和校验路径，错误清单不能被向导报为就绪。
      toolManagement.overview()
      const result = await cloud(connection().base, '/local-setup/resources', { resources }, true)
      atomic(stateFile, { ...state(), resources })
      return result
    }),
  }
}
