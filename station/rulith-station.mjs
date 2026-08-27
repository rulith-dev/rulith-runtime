#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * rulith-station — 本地站（托管容器，v1，零依赖单文件；2026-08-18 用户裁「可以推」）。
 *
 * 定位与云上 Space 同本体：**托管容器不是板**——起停/配置/汇流/故障隔离，无闭包无真值，
 * 不碰板语义。脑（REPL）与手（worker）保持分进程分凭证；站只是它们的本地宿主与一块屏。
 *
 * 做四件事：
 *   ① 起停 REPL 与 worker（子进程拉起，配置由站持有）
 *   ② 汇流时间线：REPL 事件（嵌入合同 SSE /events，钥由站注入 RULITH_UI_KEY）
 *      + worker 执行事件（RULITH_WORKER_EVENTS=jsonl，读孩子的 stdout——**不是网络口**，
 *      worker 纯出站零入站的形态一根毛不变）→ 一条 SSE 流，浏览器晚开补看全史
 *   ③ 配置面：两件的 env 表单化。**密文类值打码显示，回存打码值=保持原值**；
 *      密文库(rulith-sources.json)只显示条目名，值永不出站（SRC-40 不因 UI 松动）
 *   ④ 插话转发：POST /say → Agent 接单口 /task（站持注入钥，并为每案生成 contextKey）
 *
 * 门与 REPL --ui 同律同码：随机站钥 + Origin/Host 只认本机 + 只收 JSON 封顶 64KB。
 * 回环不是边界——任何网页都能往 127.0.0.1 发简单请求，三道门一道不少。
 *
 * 配置文件 rulith-station.json（缺省当前目录，RULITH_STATION_CONFIG 可指）：
 *   { "repl":   { "args": ["--agent","orders","--ui"], "env": { "RULITH_TOKEN": "…", … } },
 *     "worker": { "env": { "RULITH_CHANNEL": "…", "RULITH_CHANNEL_KEY": "…", … } },
 *     "paths":  { "repl": "…/rulith-agent.mjs", "worker": "…/rulith-worker.mjs" } }
 * 首次启动没有配置文件会生成骨架——先填 env 再从界面上点启动。
 *
 * 站型（profile）预留：专业化=配方（云上）×站型（本地装备+面板）。v1 只有通用站；
 * 站型机制（装备清单+面板插件打包）排 P2/P3，第一个站型拿 coder 开刀。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
const HERE = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.RULITH_STATION_PORT ?? 7790)
const KEY = (process.env.RULITH_STATION_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
const CONFIG_FILE = process.env.RULITH_STATION_CONFIG ?? './rulith-station.json'
const MAX_BODY = 64 * 1024

// ── 配置（纯函数导出给测试：打码与回存合并是仅有的两处"模型不在场也能错"的逻辑）────
const SECRET_RE = /(TOKEN|KEY|SECRET|PASSWORD|DSN)/i
const MASK = '••••'
/** env 打码视图：密文类键只露尾 4 位。 */
export function maskEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    const s = String(v)
    out[k] = SECRET_RE.test(k) && s.length > 0 ? `${MASK}${s.slice(-4)}` : s
  }
  return out
}
/** 回存合并：打码值(含 MASK)=保持原值；空串=删键；其余=覆写。绝不把打码串存成真值。 */
export function applyEnvEdit(prior, edit) {
  const out = { ...(prior ?? {}) }
  for (const [k, v] of Object.entries(edit ?? {})) {
    const s = String(v)
    if (s.includes(MASK)) continue
    if (s === '') { delete out[k]; continue }
    out[k] = s
  }
  return out
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    const skeleton = {
      repl: { args: ['--agent', 'default', '--ui'], env: { RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: '', RULITH_MODEL_KEY: '', RULITH_CASE_BOARDS: 'on' } },
      worker: { env: { RULITH_WORK_URL: 'https://api.rulith.ai/work', RULITH_CHANNEL: '', RULITH_CHANNEL_KEY: '' } },
      paths: {},
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(skeleton, null, 2))
    console.log(`Created ${CONFIG_FILE}. Add your environment values, then start the components from Station.`)
    return skeleton
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
}
function saveConfig(cfg) { writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)) }

// ── 事件总线（与 REPL 同形：全史保留，SSE 晚开补看）────────────────────────
const events = []
const clients = new Set()
function emit(src, type, data = {}) {
  const ev = { t: Date.now(), src, type, ...data }
  events.push(ev)
  if (events.length > 2000) events.splice(0, events.length - 1500)
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of clients) { try { res.write(line) } catch { clients.delete(res) } }
}

// ── 子进程管理 ────────────────────────────────────────────────────────────
const comps = {
  repl: { child: null, uiKey: '', uiPort: 7788, serveKey: '', servePort: 7799, maxConcurrentCases: 1, es: null },
  worker: { child: null },
}
const running = (c) => comps[c].child !== null && comps[c].child.exitCode === null

function startRepl(cfg) {
  if (running('repl')) return 'Already running.'
  const path = resolve(cfg.paths?.repl ?? resolve(HERE, '../agent/rulith-agent.mjs'))
  if (!existsSync(path)) return `Agent runtime not found at ${path}. Set paths.repl in the Station configuration.`
  const uiKey = randomUUID().replace(/-/g, '')
  const serveKey = randomUUID().replace(/-/g, '')
  const uiPort = Number(cfg.repl?.env?.RULITH_UI_PORT ?? 7788)
  const servePort = Number(cfg.repl?.env?.RULITH_SERVE_PORT ?? 7799)
  const args = Array.isArray(cfg.repl?.args) ? cfg.repl.args : []
  const withUi = [...args]
  for (const flag of ['--ui', '--serve', '--case-boards']) if (!withUi.includes(flag)) withUi.push(flag)
  const child = spawn(process.execPath, [path, ...withUi], {
    env: { ...process.env, ...(cfg.repl?.env ?? {}),
      RULITH_UI_KEY: uiKey, RULITH_SERVE_KEY: serveKey,
      RULITH_SERVE_PORT: String(servePort), RULITH_SERVE_CASE_SLOTS: 'on', RULITH_CASE_BOARDS: 'on' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const configuredConcurrency = Math.max(1, Math.min(8, Math.trunc(Number(cfg.repl?.env?.RULITH_SERVE_CONCURRENCY ?? 1)) || 1))
  comps.repl = { ...comps.repl, child, uiKey, uiPort, serveKey, servePort, maxConcurrentCases: configuredConcurrency }
  wireStdio('repl', child)
  child.on('exit', (code) => { emit('repl', 'exit', { code }); comps.repl.child = null; comps.repl.es?.abort?.() })
  emit('repl', 'spawn', { pid: child.pid })
  subscribeReplEvents(uiPort, uiKey, child)
  return null
}

/** 订阅 REPL 的 SSE（嵌入合同）：起来前重试,断了只要孩子还活着就重连。
 *  **重连去重**(2026-08-18 真机: 419 办结后事件流安静了 305s——undici 默认 300s 空闲超时
 *  掐断 SSE,站重连,agent 的 /events 按「晚开补看全史」把整段历史重放,时间线整段贴了第二遍;
 *  每安静五分钟复发一次)。同一帧只进一次: 按帧原文指纹去重——重连由此免疫,
 *  站自己重启时仍靠重放恢复历史(那时指纹集是空的,历史照进)。 */
async function subscribeReplEvents(port, key, child) {
  const ctl = new AbortController()
  comps.repl.es = ctl
  const seenFrames = new Set()
  for (let tries = 0; tries < 40 && child.exitCode === null; tries++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/events?k=${key}`, { signal: ctl.signal })
      if (!r.ok) { await new Promise((s) => setTimeout(s, 500)); continue }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
          if (dataLine === undefined) continue
          const fp = createHash('sha1').update(dataLine).digest('base64')
          if (seenFrames.has(fp)) continue
          if (seenFrames.size > 20000) seenFrames.clear()
          seenFrames.add(fp)
          try {
            const ev = JSON.parse(dataLine.slice(6))
            if (ev.type === 'start' && Number.isInteger(ev.concurrency) && ev.concurrency >= 1 && ev.concurrency <= 8) {
              comps.repl.maxConcurrentCases = ev.concurrency
            }
            const { type: _ty, t: _t0, ...rest } = ev
            emit('repl', ev.type ?? '?', { ...rest, at: ev.t })
          } catch { /* 坏帧跳过 */ }
        }
      }
      tries = 0 // 连上过——断线从头计数重连
    } catch { /* 还没起来/断了 */ }
    if (ctl.signal.aborted) return
    await new Promise((s) => setTimeout(s, 500))
  }
}

function startWorker(cfg) {
  if (running('worker')) return 'Already running.'
  const path = resolve(cfg.paths?.worker ?? resolve(HERE, '../worker/rulith-worker.mjs'))
  if (!existsSync(path)) return `Worker runtime not found at ${path}. Set paths.worker in the Station configuration.`
  const child = spawn(process.execPath, [path], {
    env: { ...process.env, ...(cfg.worker?.env ?? {}), RULITH_WORKER_EVENTS: 'jsonl' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dirname(path),
  })
  comps.worker.child = child
  wireStdio('worker', child)
  child.on('exit', (code) => { emit('worker', 'exit', { code }); comps.worker.child = null })
  emit('worker', 'spawn', { pid: child.pid })
  return null
}

/** 孩子的 stdout/stderr → 事件：JSON 行=结构化事件原样进流,其余=日志行(终端的脸也保留)。 */
function wireStdio(src, child) {
  let bufs = { out: '', err: '' }
  const feed = (which, chunk) => {
    bufs[which] += chunk
    let i
    while ((i = bufs[which].indexOf('\n')) >= 0) {
      // 旧版 worker 的心跳点不带换行,会粘在事件 JSON 前面(`..{"t":…}`)——剥掉再认
      const line = bufs[which].slice(0, i).replace(/^\.+(?=\{)/, ''); bufs[which] = bufs[which].slice(i + 1)
      if (line.trim() === '') continue
      if (line.startsWith('{')) {
        try { const ev = JSON.parse(line); const { type: _ty, t: _t0, ...rest } = ev; emit(src, ev.type ?? 'log', { ...rest, at: ev.t }); continue } catch { /* 非事件 JSON 当日志 */ }
      }
      emit(src, 'log', { line: line.slice(0, 400), ...(which === 'err' ? { stderr: true } : {}) })
    }
  }
  child.stdout.on('data', (c) => feed('out', String(c)))
  child.stderr.on('data', (c) => feed('err', String(c)))
}

function stopComp(name) {
  const c = comps[name].child
  if (c === null) return 'Not running.'
  c.kill()
  return null
}

// ── HTTP 面（门与 REPL --ui 同律同码）──────────────────────────────────────
function gate(req) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const k = req.headers['x-rulith-station'] ?? url.searchParams.get('k') ?? ''
  if (k !== KEY) return 'Missing or invalid Station key. Use the key printed at startup.'
  const origin = req.headers.origin
  if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return `Cross-origin request rejected (Origin: ${origin}).`
  const host = String(req.headers.host ?? '')
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return `Non-local Host rejected (${host}) to prevent DNS rebinding.`
  return null
}
// **按字节收、收完再解码**(2026-08-18): 逐块 `raw += chunk` 是隐式 toString(),
// 一个多字节字符正好跨 TCP 块边界就会被切成两半 ⇒ 短消息永远正常、长消息偶发乱码。
// 这类"平时都对"的缺陷最难查,而修法只是不要在半路把字节当字符串。
const readJson = (req) => new Promise((ok, no) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { no(new Error('body>64KB')); req.destroy(); return } chunks.push(c) })
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { no(new Error('Body is not valid JSON.')) } })
})
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }

if (IS_MAIN) {
  let cfg = loadConfig()
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    try {
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end(stationPage.replace('__KEY__', KEY))
      }
      const bad = gate(req)
      if (bad !== null) return void json(res, 403, { ok: false, teaching: bad })
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      if (path === '/status' && req.method === 'GET') {
        // REPL 原生页地址随状态给(它的钥是站注入的,人手上没有——不给就等于那扇门只有站能进)
        return void json(res, 200, { ok: true, repl: running('repl'), worker: running('worker'), config: CONFIG_FILE,
          maxConcurrentCases: comps.repl.maxConcurrentCases,
          ...(running('repl') ? { replUi: `http://127.0.0.1:${comps.repl.uiPort}/?k=${comps.repl.uiKey}` } : {}) })
      }
      if (path === '/config' && req.method === 'GET') {
        return void json(res, 200, { ok: true, repl: { args: cfg.repl?.args ?? [], env: maskEnv(cfg.repl?.env) }, worker: { env: maskEnv(cfg.worker?.env) } })
      }
      if (path === '/config' && req.method === 'POST') {
        const b = await readJson(req)
        const comp = String(b.comp ?? '')
        if (comp !== 'repl' && comp !== 'worker') return void json(res, 400, { ok: false, teaching: 'comp must be repl or worker.' })
        cfg[comp] = { ...(cfg[comp] ?? {}), env: applyEnvEdit(cfg[comp]?.env, b.env ?? {}), ...(comp === 'repl' && Array.isArray(b.args) ? { args: b.args.map(String) } : {}) }
        saveConfig(cfg)
        return void json(res, 200, { ok: true, teaching: running(comp) ? 'Saved. Restart this component to apply the change.' : 'Saved.' })
      }
      if (path === '/ctl' && req.method === 'POST') {
        const b = await readJson(req)
        cfg = loadConfig() // 起停前重读——外部手工改过的配置不吃陈值
        const err = b.op === 'stop' ? stopComp(String(b.comp))
          : String(b.comp) === 'repl' ? startRepl(cfg)
          : String(b.comp) === 'worker' ? startWorker(cfg)
          : 'comp must be repl or worker.'
        return void json(res, err === null ? 200 : 400, err === null ? { ok: true } : { ok: false, teaching: err })
      }
      if (path === '/say' && req.method === 'POST') {
        if (!running('repl')) return void json(res, 409, { ok: false, teaching: 'The Agent runtime is not running. Start it first.' })
        const b = await readJson(req)
        const sessionKey = String(b.sessionKey ?? '').trim() || `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
        const r = await fetch(`http://127.0.0.1:${comps.repl.servePort}/task`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': comps.repl.serveKey },
          body: JSON.stringify({ text: String(b.text ?? ''), sessionKey }),
        }).catch(() => undefined)
        if (r === undefined) return void json(res, 502, { ok: false, teaching: 'The Agent task endpoint did not respond.' })
        return void json(res, r.status, await r.json().catch(() => ({ ok: r.ok })))
      }
      json(res, 404, { ok: false, teaching: 'Endpoint not found.' })
    } catch (e) {
      json(res, 400, { ok: false, teaching: String(e?.message ?? e) })
    }
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`rulith-station · http://127.0.0.1:${PORT}/?k=${KEY}`)
    console.log('(Loopback only; configuration: ' + resolve(CONFIG_FILE) + '; secret values never leave this process.)')
  })
  process.on('SIGINT', () => { stopComp('repl'); stopComp('worker'); process.exit(0) })
}

// ── 界面（内联单页；2026-08-18 改版：**照 REPL --ui 那张页的视觉语言**）───────
//
// 用户裁决：「7788 那个界面还可以，是人看的；7790 的比较抽象」——所以中栏原样借用它的
// 卡片语言（一轮=一张卡：模型说了什么 + 板的判词贴在卡底），右栏放手的流水（worker 执行），
// 左栏是控制台（起停/配置/案卷/去处）。**三栏各答一个问题**：
//   左＝这套装置现在什么状态、我能按什么　中＝它在想什么、板怎么判　右＝它的手在干什么
export const stationPage = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>rulith-station · local control room</title>
<style>
:root{--bg:#0a0d13;--panel:#10161f;--line:#1d2735;--fg:#e8eef5;--dim:#8b98a8;--faint:#707d8e;
--cyan:#35d0ba;--amber:#e0a03a;--green:#34d399;--red:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14.5px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.top{display:flex;align-items:baseline;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.top h1{font-size:17px;margin:0}
.grid{display:grid;grid-template-columns:250px minmax(0,1fr) minmax(0,380px);gap:0;height:calc(100vh - 53px)}
.col{overflow:auto;padding:16px 18px 40px}
.col.left{border-right:1px solid var(--line)}
.col.right{border-left:1px solid var(--line)}
.col.mid{padding-bottom:0;display:flex;flex-direction:column}
.feedwrap{flex:1;overflow:auto;padding-bottom:10px}
@media(max-width:1100px){.grid{grid-template-columns:1fr;height:auto}.col{height:auto;border:0;border-top:1px solid var(--line)}}
h2{font-size:12px;letter-spacing:.8px;color:var(--faint);margin:0 0 10px;font-weight:600;text-transform:uppercase}
.sub{color:var(--dim);font-size:13px}
.faint{color:var(--faint);font-size:12.5px}
.pill{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:99px;font-size:12px;
border:1px solid var(--line);color:var(--dim)}
.pill.run{color:var(--cyan);border-color:rgba(53,208,186,.4)}
.pill.ok{color:var(--green);border-color:rgba(52,211,153,.4)}
.pill.stop{color:var(--amber);border-color:rgba(224,160,58,.4)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px;margin:11px 0}
.round{color:var(--faint);font-size:12px;letter-spacing:.6px;margin:20px 0 4px}
.say{white-space:pre-wrap}
.verdict{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13.5px}
.accept{color:var(--green)}.pending,.reject{color:var(--amber)}.fault{color:var(--red)}
pre{background:#0b1119;border:1px solid var(--line);border-radius:8px;padding:9px 11px;overflow:auto;
font:12.5px/1.6 ui-monospace,Consolas,monospace;margin:8px 0 0;white-space:pre-wrap;word-break:break-all}
details summary{cursor:pointer;color:var(--faint);font-size:12.5px}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.why{color:var(--dim);font-size:13px;margin-top:4px}
.btn{background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 11px;
cursor:pointer;font-size:13px}
.btn:hover{border-color:var(--dim)}
.btn.go{background:var(--cyan);color:#06231f;border:0;font-weight:600}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(29,39,53,.6)}
.wline{padding:5px 0;border-bottom:1px solid rgba(29,39,53,.55);font-size:13.5px}
.wt{color:var(--faint);font-size:11.5px;margin-right:6px}
code{background:rgba(53,208,186,.09);color:var(--cyan);padding:0 5px;border-radius:4px;font:12.5px ui-monospace,Consolas,monospace}
input,textarea{width:100%;background:#0b1119;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:13.5px}
textarea{font:12px/1.55 ui-monospace,Consolas,monospace;min-height:130px}
.cases a{display:block;padding:3px 0;font-size:13px}
.crow{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 7px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--dim)}
.crow:hover{background:#141c28}
.crow.sel{background:rgba(53,208,186,.08);color:var(--cyan)}
.bchip{display:none;font-size:10.5px;color:var(--faint);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:5px;vertical-align:1px}
body.multi .bchip{display:inline}
</style></head><body>
<div class="top">
  <h1>rulith-station</h1>
  <span class="sub">Local control room · Agent and Worker on one screen</span>
  <span style="flex:1"></span>
  <span class="faint" id="agentline"></span>
  <span class="pill" id="busy" style="display:none"></span>
</div>
<div class="grid">
  <!-- 左：控制台 -->
  <div class="col left">
    <h2>Components</h2>
    <div class="row"><span>Agent <span class="faint" id="pid-repl"></span></span>
      <span><span class="pill stop" id="st-repl">…</span> <button class="btn" id="bt-repl" onclick="ctl('repl')">Start</button></span></div>
    <div class="row"><span>Worker <span class="faint" id="pid-worker"></span></span>
      <span><span class="pill stop" id="st-worker">…</span> <button class="btn" id="bt-worker" onclick="ctl('worker')">Start</button></span></div>
    <p class="faint" style="margin:10px 0 0">The Agent proposes, the board decides, and the Worker executes. Each runs separately with its own credential; Station only hosts and observes them.</p>
    <div class="row" style="margin-top:8px"><span>Maximum concurrent cases</span><b id="max-concurrency">1</b></div>

    <h2 style="margin-top:26px">Cases in this session</h2>
    <div class="cases" id="cases"><span class="faint">No cases yet</span></div>

    <h2 style="margin-top:26px">Open</h2>
    <div class="cases">
      <a href="https://console.rulith.ai/cases" target="_blank" rel="noopener">Console · Runs ↗</a>
      <a href="#" id="replnative" onclick="return false" class="faint">Agent timeline (available after startup)</a>
    </div>

    <h2 style="margin-top:26px">Configuration</h2>
    <p class="faint" style="margin:0 0 8px">Secrets show only their final four characters. Saving a masked value preserves the original. Restart the component after a change.</p>
    <details><summary>Agent environment</summary>
      <textarea id="c-repl"></textarea>
      <div style="margin:6px 0"><span class="faint">Arguments (JSON array)</span><input id="c-repl-args"></div>
      <button class="btn" onclick="saveCfg('repl')">Save</button> <span class="faint" id="m-repl"></span>
    </details>
    <details style="margin-top:8px"><summary>Worker environment</summary>
      <textarea id="c-worker"></textarea>
      <button class="btn" onclick="saveCfg('worker')">Save</button> <span class="faint" id="m-worker"></span>
    </details>
  </div>

  <!-- 中：推理时间线（借 7788 的卡片语言） -->
  <div class="col mid">
    <div style="display:flex;justify-content:flex-end;padding:2px 0"><button class="btn" style="padding:2px 8px;font-size:12px" onclick="clearFeed('feed')">Clear</button></div>
    <div class="feedwrap" id="feedwrap"><div id="feed"><p class="faint">Waiting for the Agent. Its proposals and the board's decisions will appear here.</p></div></div>
    <div style="position:sticky;bottom:0;background:var(--bg);padding:10px 0 16px;border-top:1px solid var(--line)">
      <form id="sayform" style="display:flex;gap:8px">
        <input id="saytext" placeholder="Give the Agent a task (queued when capacity is full)…">
        <button class="btn go">Send</button>
      </form>
    </div>
  </div>

  <!-- 右：手的流水 -->
  <div class="col right">
    <h2>Worker activity <button class="btn" style="float:right;padding:2px 8px;font-size:12px" onclick="clearFeed('wfeed')">Clear</button></h2>
    <p class="faint" style="margin:-4px 0 10px">Claims, execution outcomes, and receipts returned to the board.</p>
    <div id="wfeed"><span class="faint">Waiting for the Worker…</span></div>
  </div>
</div>
<script>
const K='__KEY__'
// 清空只清**这块屏**(事件全史仍在站里,刷新页面即补看)——看不过来时把噪音抹掉,不是删账。
function clearFeed(id){const el=document.getElementById(id);el.innerHTML='<span class="faint">Cleared from this view. Refresh to replay retained events.</span>'}
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const $=(id)=>document.getElementById(id)
const feed=$('feed'), wfeed=$('wfeed')
let lastCards={}, pendingUsers={}, seenCases=[]
// 多实例=多块板(云上真相),站只做**按板分流的视窗**: 事件带 board 就打标,切换=纯显隐过滤。
// filterBoard=''为全部混流;curBoard=脑的 stdout 日志行不带板号,按最近一条结构化事件归属
// (脑现在串行办案,这个归属是准的;真并发时脑该把板号写进结构化事件,那是运行时的活)。
let filterBoard='', curBoard='', busyMap={}
const eventKey=(e)=>String(e.session||e.board||'')
const bshort=(b)=>String(b||'').split('-').slice(-2).join('-')
const bchip=(e)=>e.board?'<span class="bchip">'+esc(bshort(e.board))+'</span>':''
function tagBoard(d,board){if(board){d.dataset.board=board;if(filterBoard&&board!==filterBoard)d.style.display='none'}}
function atBottom(el){return el.scrollHeight-el.scrollTop-el.clientHeight<80}
function addMid(html,board){
  const stick=atBottom($('feedwrap'))
  if(feed.firstElementChild&&feed.firstElementChild.tagName==='P')feed.innerHTML=''
  const d=document.createElement('div');d.innerHTML=html;tagBoard(d,board);feed.appendChild(d)
  if(stick)$('feedwrap').scrollTop=$('feedwrap').scrollHeight
  return d
}
function addRight(html,board){
  const stick=atBottom($('wfeed'))
  if(wfeed.firstElementChild&&wfeed.firstElementChild.tagName==='SPAN')wfeed.innerHTML=''
  const d=document.createElement('div');d.className='wline';d.innerHTML=html;tagBoard(d,board);wfeed.appendChild(d)
  if(stick)wfeed.scrollTop=wfeed.scrollHeight
}
const hhmm=(e)=>new Date(e.at||e.t).toTimeString().slice(0,8)
// 忙碌指示：宿主在替模型等的时候亮一枚 pill，落定就灭——它是状态不是事件，不该在时间线上留痕。
// 多实例: 每板一份(全局一枚会被并发实例互相覆盖);过滤时只亮当前板的,混流时多板并示带短名。
function setBusy(t,b){b=b||'';if(!t)delete busyMap[b];else busyMap[b]=t;renderBusy()}
function renderBusy(){
  const el=$('busy'),ents=Object.entries(busyMap).filter(([b])=>!filterBoard||!b||b===filterBoard)
  if(!ents.length){el.style.display='none';return}
  el.style.display='';el.className='pill run'
  el.textContent=clip(ents.map(([b,t])=>(b&&ents.length>1?bshort(b)+'·':'')+t).join(' ｜ '),96)
}
const clip=(s,n)=>{s=String(s||'');return s.length>n?s.slice(0,n)+'…':s}

// ── 中栏：一轮一张卡，板的判词贴在卡底（7788 的形） ──────────────────────
function midEvent(e){
  if(e.board)curBoard=e.board
  if(e.type==='start'){$('agentline').textContent='Agent '+(e.agent||'')+' · '+(e.url||'');if(e.concurrency)$('max-concurrency').textContent=String(e.concurrency);return}
  if(e.type==='task-start'){
    const k=eventKey(e);lastCards[k]=null
    pendingUsers[k]=addMid('<div class="card" style="border-color:rgba(53,208,186,.35)"><div class="faint">Work instance '+esc(e.session||'')+' · '+hhmm(e)+'</div><div class="say">'+esc(e.text||'')+'</div></div>',e.board)
    return
  }
  // 你的输入卡先进屏(此刻还不知道它会开出哪块案卷),等 case-open 一到回头补板标——
  // 流是串行的,最近一张未标卡就是它的(2026-08-18 用户: 过滤到单个案卷时历史输入全员出场)。
  if(e.type==='user'){const k=eventKey(e);lastCards[k]=null;pendingUsers[k]=addMid('<div class="card" style="border-color:rgba(53,208,186,.35)"><div class="faint">You · '+hhmm(e)+'</div><div class="say">'+esc(e.text||'')+'</div></div>',e.board);return}
  if(e.type==='round'){lastCards[eventKey(e)]=null;addMid('<div class="round">Round '+esc(String(e.n))+(e.board?' · '+esc(e.board):'')+'</div>',e.board);return}
  if(e.type==='propose'){
    lastCards[eventKey(e)]=addMid('<div class="card"><div class="say">'+esc(e.say||'(This round proposed operations only.)')+'</div>'
      +(e.ops?'<details><summary>Proposed '+e.ops.length+' operation(s)</summary><pre>'+esc(JSON.stringify(e.ops,null,2))+'</pre></details>':'')
      +(e.cmds?'<details><summary>Issued '+e.cmds.length+' command(s) ('+esc(e.cmds.map((c)=>c.action||c.kind).join(' → '))+')</summary><pre>'+esc(JSON.stringify(e.cmds,null,2))+'</pre></details>':'')+'</div>',e.board)
    return
  }
  if(e.type==='verdict'){
    const box=e.accepted
      ? e.cmd
        ? e.done===true
          ? '<div class="verdict '+(e.ok===true?'accept':'reject')+'"><b>Board: action '+(e.ok===true?'completed':'failed')+'</b> · '+esc(e.cmd)+' · invocation '+esc(e.invocation||'')+' · revision '+esc(e.revision||'')+'</div>'
          : '<div class="verdict reject"><b>Board: action accepted but not completed synchronously</b> · '+esc(e.cmd)+' · invocation '+esc(e.invocation||'')+' · revision '+esc(e.revision||'')+'</div>'
        : '<div class="verdict accept"><b>Board: accepted</b> · '+esc(String(e.added||0))+' item(s) added · revision '+esc(e.revision||'')+'</div>'
      : '<div class="verdict reject"><b>Board: rejected</b><div class="why">'+esc(e.teaching||'')+'</div>'
        +'<div class="why" style="color:var(--faint)">This guidance is returned to the Agent so it can correct the request.</div></div>'
    const card=lastCards[eventKey(e)]
    if(card&&card.firstElementChild){card.firstElementChild.insertAdjacentHTML('beforeend',box);$('feedwrap').scrollTop=$('feedwrap').scrollHeight}
    else addMid('<div class="card">'+box+'</div>',e.board)
    return
  }
  if(e.type==='case-open'){
    noteCase(e.board,e.at||e.t,'running',e.session)
    const pending=pendingUsers[eventKey(e)]
    if(pending&&!pending.dataset.board)tagBoard(pending,e.board)
    delete pendingUsers[eventKey(e)]
    addMid('<div class="round">Case opened · '+esc(e.board||'')+'</div>',e.board);return
  }
  if(e.type==='sealed'){setBusy('',e.board);noteCase(e.board,e.at||e.t,'completed',e.session);addMid('<div class="round" style="color:var(--green)">Case sealed · '+esc(e.board||'')+'</div>',e.board);return}
  // 放电事件：有真缺口才值得占时间线；纯"求证在途"是宿主机械，收进状态提示（log 径同律）。
  if(e.type==='discharge'){const dn=(e.notes||[]).join(' · ');if(/gap|rejected|缺口|放电拒/i.test(dn))addMid('<div class="faint" style="margin:6px 0">Verification · '+esc(clip(dn,200))+'</div>',e.board);else setBusy('Verification requested; waiting for evidence',e.board);return}
  if(e.type==='task-done'){setBusy('',e.board);noteCase(e.board,e.at||e.t,e.pendingCaseId?'pending':'completed',e.sessionKey);return}
  if(e.type==='segment-end'||e.type==='end'){setBusy('',e.board);addMid('<div class="round">'+esc(clip(e.note,200))+'</div>',e.board);return}
  // 退出行按当前案卷归属(中断的是它);两案之间的退出归上一案,无伤——重点是别在每个过滤视图里全员出场。
  if(e.type==='exit'){addMid('<div class="round" style="color:var(--amber)">Agent process exited (code '+esc(String(e.code))+')</div>');return}
  if(e.type==='log'){
    // 并发后裸 stdout 没有可靠板归属；宁可作为全局日志显示，也不猜给“最近一块板”制造串线。
    const t=String(e.line||''),B=e.board||''
    // 动作状态只认结构化 verdict（cmd/done/ok/invocation），不再从人话日志反解。
    // 一方面避免文案改动让状态消失，另一方面避免内联模板吞掉正则转义、拖垮整页脚本。
    // **宿主内部机械不占时间线**（2026-08-18 用户：只留必要的）：等待/结算/封板重试是"它在替你
    // 忙"，不是"发生了一件事"——收进顶部一枚状态提示，来了就亮、落定就灭。
    if(/^◌/.test(t)){setBusy(t.replace(/^◌\s*/,''),B);return}
    // 放电那行说的是"求证派出去了"——右栏已有工单流水，中栏只保留一次，不重复贴。
    if(/^\[discharge\]|^verification ·|^\[放电\]|^求证 ·/i.test(t)){setBusy('Verification requested; waiting for evidence',B);return}
    // 剩下的只留"这件事的结论"：封板/未结案/板判。其余（配方、模式说明、提示）不进时间线。
    if(/case sealed|not closed|board.*deliverable|outstanding obligation|封板结案|没有结案|板判可交付|未结义务/i.test(t)){setBusy('',B);addMid('<div class="faint" style="margin:5px 0">'+esc(clip(t,260))+'</div>',B)}
    return
  }
}
function noteCase(b,at,status,session){
  if(!b)return
  const hit=seenCases.find((c)=>c.b===b)
  if(hit){if(status)hit.status=status;if(session)hit.session=session;renderCases();return}
  seenCases.push({b,at:at||Date.now(),status:status||'running',session:session||''})
  renderCases()
}
// 实例切换器: 点某块板=三栏都按它过滤;「全部」=混流(并发时发现异常靠它)。≥2 块板才显板徽章。
// 排序=开单时间倒序(显式,不依赖事件到达序——SSE 重连补史时到达序不保真),每行带开单时刻。
function renderCases(){
  document.body.classList.toggle('multi',seenCases.length>1)
  const all=seenCases.length>1?'<div class="crow'+(filterBoard===''?' sel':'')+'" data-b=""><span>All · combined</span></div>':''
  const state=(s)=>s==='completed'?'✓':s==='pending'?'◐':'●'
  const rows=seenCases.slice().sort((x,y)=>y.at-x.at).map((c)=>'<div class="crow'+(filterBoard===c.b?' sel':'')+'" data-b="'+esc(c.b)+'"><span title="'+esc(c.b)+'">'+state(c.status)+' '+esc(bshort(c.b))+'</span><span class="faint" style="margin-left:auto">'+hhmm({at:c.at}).slice(0,5)+'</span><a href="https://console.rulith.ai/cases/'+encodeURIComponent(c.b)+'" target="_blank" rel="noopener">↗</a></div>').join('')
  $('cases').innerHTML=(all+rows)||'<span class="faint">No cases yet</span>'
}
$('cases').addEventListener('click',(ev)=>{
  if(ev.target.tagName==='A')return // 控制台链接照常跳转,不当切换
  const r=ev.target.closest('.crow');if(!r)return
  setFilter(r.dataset.b||'')
})
function setFilter(b){
  filterBoard=b
  const show=(el)=>{const eb=el.dataset?el.dataset.board:undefined;el.style.display=(!b||!eb||eb===b)?'':'none'}
  for(const el of feed.children)show(el)
  for(const el of wfeed.children)show(el)
  renderCases();renderBusy()
  $('feedwrap').scrollTop=$('feedwrap').scrollHeight
}

// ── 右栏：手的流水 ────────────────────────────────────────────────────
function reportedState(e){
  if(e.kind!=='verification')return e.ok===false
    ? {cls:'reject',icon:'○',label:'Failed'}
    : {cls:'accept',icon:'○',label:''}
  // 核验是三态，不是普通动作的成败布尔值。not_satisfied 说明探针正常执行、
  // 只是当前世界尚未满足验收式；只有 error 才是核验器/基础设施故障。
  const outcome=e.outcome||(e.ok===true?'satisfied':'error') // 兼容尚未携 outcome 的旧 worker
  if(outcome==='satisfied')return {cls:'accept',icon:'●',label:'Verified'}
  if(outcome==='not_satisfied')return {cls:'pending',icon:'○',label:'Condition not satisfied'}
  return {cls:'fault',icon:'×',label:'Verification error'}
}
function rightEvent(e){
  const t='<span class="wt">'+hhmm(e)+'</span>'
  if(e.type==='up')return addRight(t+'Online <span class="faint">source '+esc(clip(e.channel,26))+' · '+esc(String(e.tools))+' tool(s)'+(e.reviewer?' · reviewer enabled':'')+'</span>')
  if(e.type==='claimed')return addRight(t+bchip(e)+'<span style="color:var(--cyan)">●</span> Claimed <code>'+esc(e.kind||'')+'</code> '+esc(e.id||e.action||''),e.board)
  if(e.type==='reported'){
    const s=reportedState(e)
    return addRight(t+bchip(e)+'<span class="'+s.cls+'">'+s.icon+'</span> Receipt '+esc(e.id||e.action||'')
      +(e.verdict?' verdict <code>'+esc(e.verdict)+'</code>':'')
      +(s.label?' <span class="'+s.cls+'">'+s.label+'</span>':'')+(e.landed===false?' <span class="fault">Rejected by board</span>':'')
      +((e.result||e.reason)?'<div class="faint" style="margin-left:14px">'+esc(clip(e.result||e.reason,110))+'</div>':''),e.board)
  }
  if(e.type==='skip')return addRight(t+bchip(e)+'<span class="faint">Skipped '+esc(e.id||'')+' ('+esc(e.why||'')+')</span>',e.board)
  if(e.type==='error')return addRight(t+'<span class="reject">'+esc(clip(e.note,160))+'</span>')
  if(e.type==='exit')return addRight(t+'<span class="reject">Worker process exited (code '+esc(String(e.code))+')</span>')
  if(e.type==='log'){
    const s=String(e.line||'')
    if(/^\\.+$/.test(s.trim()))return           // 轮询心跳点，不占屏
    if(/提示:|锚建议/.test(s))return            // 运维提示，不占客户的屏
    return addRight(t+'<span class="faint">'+esc(clip(s,150))+'</span>')
  }
}

const es=new EventSource('/events?k='+encodeURIComponent(K))
es.onmessage=(m)=>{const e=JSON.parse(m.data)
  if(e.src==='repl')midEvent(e); else if(e.src==='worker')rightEvent(e)
  if(e.type==='spawn'||e.type==='exit')refresh()}

async function refresh(){
  const r=await fetch('/status?k='+K).then(r=>r.json()).catch(()=>null);if(!r)return
  for(const c of ['repl','worker']){
    $('st-'+c).textContent=r[c]?'Running':'Stopped';$('st-'+c).className='pill '+(r[c]?'run':'stop')
    $('bt-'+c).textContent=r[c]?'Stop':'Start';$('bt-'+c).dataset.op=r[c]?'stop':'start'
  }
  const rn=$('replnative')
  if(r.replUi){rn.href=r.replUi;rn.target='_blank';rn.rel='noopener';rn.className='';rn.textContent='Agent timeline ↗';rn.onclick=null}
}
async function ctl(c){
  const op=$('bt-'+c).dataset.op||'start'
  const r=await fetch('/ctl?k='+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({comp:c,op})}).then(r=>r.json())
  if(!r.ok)alert(r.teaching||'Failed')
  setTimeout(refresh,700)
}
async function loadCfg(){
  const r=await fetch('/config?k='+K).then(r=>r.json()).catch(()=>null);if(!r||!r.ok)return
  $('c-repl').value=JSON.stringify(r.repl.env,null,2)
  $('c-repl-args').value=JSON.stringify(r.repl.args)
  $('c-worker').value=JSON.stringify(r.worker.env,null,2)
}
async function saveCfg(c){
  let env,args
  try{env=JSON.parse($('c-'+c).value)}catch(e){$('m-'+c).textContent='Environment is not valid JSON: '+e.message;return}
  if(c==='repl'){try{args=JSON.parse($('c-repl-args').value)}catch(e){$('m-repl').textContent='Arguments must be a valid JSON array.';return}}
  const r=await fetch('/config?k='+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({comp:c,env,...(args!==undefined?{args}:{})})}).then(r=>r.json())
  $('m-'+c).textContent=r.teaching||(r.ok?'Saved.':'Failed')
  loadCfg()
}
$('sayform').addEventListener('submit',async(ev)=>{ev.preventDefault()
  const t=$('saytext');const v=t.value.trim();if(!v)return;t.value=''
  const r=await fetch('/say?k='+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:v})}).then(r=>r.json()).catch(()=>null)
  if(r&&!r.ok&&r.teaching)addMid('<div class="card"><span class="reject">'+esc(r.teaching)+'</span></div>')})
refresh();loadCfg()
</script></body></html>`
