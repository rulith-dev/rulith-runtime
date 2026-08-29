#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Local execution runtime for Rulith Cloud.
 *
 * The model proposes; the Board validates, derives, and explains rejection.
 * External execution belongs to the Worker. Configuration and governance
 * belong to Console. Every task runs inside one Case Context on a persistent
 * Board. A Case Context is opened with OpenCase(caseId), and completed with
 * CloseCase. Creating or sealing a Board is never part of task execution.
 *
 * The transcript and model credential remain local. The Board stores work,
 * evidence, decisions, receipts, and the Case lifecycle.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const URL_BASE = (process.env.RULITH_URL ?? 'https://api.rulith.ai').replace(/\/$/, '')
const TOKEN = process.env.RULITH_TOKEN ?? ''
const MODEL_KEY = process.env.ANTHROPIC_API_KEY ?? process.env.RULITH_MODEL_KEY ?? ''
const MODEL = process.env.RULITH_MODEL ?? 'claude-sonnet-5'
const MODEL_URL = process.env.RULITH_MODEL_URL ?? 'https://api.anthropic.com/v1/messages'
const MAX_ROUNDS = Number(process.env.RULITH_MAX_ROUNDS ?? 12)
const UI_PORT = Number(process.env.RULITH_UI_PORT ?? 7788)
// 本机界面的门钥: 每次启动随机。回环不是边界——浏览器里的任意网页都能往 127.0.0.1 发
// 简单请求(text/plain 连预检都不触发),没这把钥等于给任何网页留了个盲注入口。
// RULITH_UI_KEY=托管方注入(2026-08-18 本地站): 站拉起本进程时传自己生成的钥,才订阅得了
// /events。嵌入合同本来就写明"嵌入方带钥"——这只是让钥可以由嵌入方发,门的三道一道不少。
const UI_KEY = (process.env.RULITH_UI_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
const UI_MAX_BODY = 64 * 1024
// 接单脑的门钥: 与界面钥同律(每次启动随机、回环不是边界)。**两把不同的钥**——
// 收单口能塞任务给一个有板写权限的智能体,权限比"看时间线"高一档,不该共用一把。
const SERVE_PORT = Number(process.env.RULITH_SERVE_PORT ?? 7799)
const SERVE_KEY = (process.env.RULITH_SERVE_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
const SERVE_RUNS_MAX = Math.max(1, Number(process.env.RULITH_SERVE_RUNS ?? 200))
// 会话槽上界(只数 sessionKey 槽,缺省槽不占位): 一个进程服务几万客户、活跃 1% 是这个形态的常态,
// 内存里的转录必须有上界。到界=LRU 驱逐**闲置**槽——丢的是内存转录,板在服务端 journal 里不丢。
const SERVE_SLOTS_MAX = Math.max(1, Number(process.env.RULITH_SERVE_SLOTS_MAX ?? 64))
// sessionKey 长度上限: 它要参与板名推导,也要当 Map 键。**教学拒不截断**——静默截断会把两个
// 不同客户的长 key 折成同一块板(串板),那比拒绝一单严重得多。
const SESSION_KEY_MAX = 128
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`rulith-agent — local Agent Runtime for Rulith Cloud

Usage:
  node agent/rulith-agent.mjs [options] [task]

Options:
  --agent <id>       Agent id in Console (default: default)
  --ui               Open the loopback timeline UI
  --serve            Accept tasks through the local service endpoint
  --case <id>        Resume an existing case for the first segment
  --shadow           Run the configured shadow verification path
  -h, --help         Show this help without requiring credentials

Required environment:
  RULITH_TOKEN       Agent token from Console
  ANTHROPIC_API_KEY or RULITH_MODEL_KEY

Common optional environment:
  RULITH_URL         Cloud API base (default: https://api.rulith.ai)
  RULITH_MODEL       Model identifier
  RULITH_MODEL_URL   Model API endpoint
  RULITH_MAX_ROUNDS  Maximum model rounds (default: 12)
  RULITH_UI_PORT     Timeline UI port (default: 7788)
  RULITH_UI_OPEN     Set to off to serve the UI without opening a browser
  RULITH_SERVE_PORT  Local task endpoint port (default: 7799)
`)
  process.exit(0)
}
let agentId = 'default'
let withUi = false
let withShadow = false
let withServe = (process.env.RULITH_SERVE ?? '') === 'on'
/** Resume one existing Case Context for the first segment only. */
let resumeCase = (process.env.RULITH_RESUME_CASE ?? '').trim()
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--agent' && argv[i + 1] !== undefined) { agentId = argv[++i]; continue }
  if (argv[i] === '--ui') { withUi = true; continue }
  if (argv[i] === '--serve') { withServe = true; continue }
  if (argv[i] === '--shadow') { withShadow = true; continue }
  if (argv[i] === '--case' && argv[i + 1] !== undefined) { resumeCase = argv[++i]; continue }
  if (argv[i].startsWith('-')) {
    console.error(`Unknown option: ${argv[i]}. Run with --help to see the supported execution surface.`)
    process.exit(1)
  }
  rest.push(argv[i])
}
const TASK = rest.join(' ').trim()
const SERVE = withServe

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1) }
if (TOKEN === '') die('RULITH_TOKEN is missing. Create an Agent token in Console under Access & credentials; it is shown only once.')
if (MODEL_KEY === '') die('A model key is missing. Set ANTHROPIC_API_KEY or RULITH_MODEL_KEY. It stays in this local process and is never sent to Rulith.')
// 无任务=进入多轮对话(2026-08-01 起 CLI 是桌面主形态);带任务=一次办完后退出(CI/脚本兼容不变)。
// **接单脑不是对话**: 收单口进来的每一条都是「任务」,所以 --serve 下按 CLI 语义走
// (纯回话不算办完,照旧催它给 JSON 或 DONE:/STOP:)——排队的是活,不是聊天。
const CHAT = TASK === '' && !SERVE
// Case IDs identify accounting, acceptance, distillation, and audit atoms.
// They are not Board IDs: all compatible Cases for an Agent share its Board.
const CASE_PREFIX = ((process.env.RULITH_CASE_PREFIX ?? 'case').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24)) || 'case'
let caseSeq = 0
const nextCaseId = () => {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  caseSeq += 1
  return `${CASE_PREFIX}-${ymd}-${String(caseSeq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`
}

// ── 事件总线：终端与界面看同一份流（界面晚开也能补看，历史全留） ──────────
const events = []
const clients = new Set()
function emit(type, data) {
  const ev = { t: Date.now(), type, ...data }
  events.push(ev)
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of clients) { try { res.write(line) } catch { clients.delete(res) } }
  traceForward(ev)
}

// ── 事件上云（实时交互，2026-08-18）: 控制台智能体页「实时交互」面板的喂料 ──
// RULITH_TRACE=off 关。fire-and-forget 批量（1.5s 或攒到 50 条），失败静默丢——
// 上报是视窗不是义务，绝不拦办案主流程，也绝不重试成风暴。
// 体积纪律: propose 的 ops 全文**不出进程**（只带条数 opsN）;长文本截断;
// start/end 的板面投影不上传（板上真有什么，控制台自己会去板上读）。
const TRACE_ON = (process.env.RULITH_TRACE ?? '') !== 'off'
let traceBuf = []
let traceTimer = null
function traceForward(ev) {
  if (!TRACE_ON) return
  const e = { ...ev }
  if (Array.isArray(e.ops)) { e.opsN = e.ops.length; delete e.ops }
  for (const k of ['say', 'text', 'note']) if (typeof e[k] === 'string' && e[k].length > 400) e[k] = e[k].slice(0, 400) + '…'
  if (typeof e.teaching === 'string' && e.teaching.length > 300) e.teaching = e.teaching.slice(0, 300) + '…'
  if (typeof e.projection === 'string') delete e.projection
  if (Array.isArray(e.notes)) e.notes = e.notes.map((n) => String(n).slice(0, 200)).slice(0, 8)
  traceBuf.push(e)
  if (traceBuf.length >= 50) flushTrace()
  else if (traceTimer === null) traceTimer = setTimeout(flushTrace, 1500)
}
function flushTrace() {
  if (traceTimer !== null) { clearTimeout(traceTimer); traceTimer = null }
  if (traceBuf.length === 0) return
  const batch = traceBuf.splice(0, 200)
  fetch(`${URL_BASE}/agent/v1/trace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId, events: batch }),
  }).catch(() => {})
}
/** 段内事件带上**槽/任务**标注(2026-08-07 跨槽并发): 一条 SSE 流上现在会有几个段交叉着发
 *  round/propose/verdict,不标注的话读流的人分不清哪一行属于哪位客户。缺省槽不带 `session`
 *  字段——不带 sessionKey 的形态下事件形状与从前逐字节一致(旧 UI/旧测试零回归)。 */
const emitOn = (ctx, type, data) => emit(type, {
  ...(ctx.key === '' ? {} : { session: ctx.key }),
  ...(ctx.taskId === undefined ? {} : { task: ctx.taskId }),
  // 板名随段事件走(2026-08-18): 云上「处理记录」按板合流,不带板的 round/propose/verdict
  // 到了那边就归不进任何一件案卷。data 里已带 board 的事件(case-open 等)以 data 为准。
  ...(ctx.board === undefined || ctx.board === '' ? {} : { board: ctx.board }),
  ...data,
})

// ── 界面（零依赖：内置 http + 内联页面 + SSE） ─────────────────────────
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>rulith-agent · reasoning timeline</title>
<style>
:root{--bg:#0a0d13;--panel:#10161f;--line:#1d2735;--fg:#e8eef5;--dim:#8b98a8;--faint:#707d8e;
--cyan:#35d0ba;--amber:#e0a03a;--green:#34d399;--red:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14.5px/1.7 -apple-system,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:26px 20px 60px}
h1{font-size:19px;margin:0 0 4px}.sub{color:var(--dim);font-size:13px}
.pill{display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:99px;font-size:12px;
border:1px solid var(--line);color:var(--dim)}
.pill.run{color:var(--cyan);border-color:rgba(53,208,186,.4)}
.pill.ok{color:var(--green);border-color:rgba(52,211,153,.4)}
.pill.stop{color:var(--amber);border-color:rgba(224,160,58,.4)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.round{color:var(--faint);font-size:12px;letter-spacing:.6px;margin:22px 0 6px}
.say{white-space:pre-wrap}
.verdict{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.accept{color:var(--green)}.reject{color:var(--amber)}
pre{background:#0b1119;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;
font:12.5px/1.6 ui-monospace,Consolas,monospace;margin:8px 0 0;white-space:pre-wrap;word-break:break-all}
details summary{cursor:pointer;color:var(--faint);font-size:12.5px}
a{color:var(--cyan)}
.why{color:var(--dim);font-size:13px;margin-top:4px}
</style></head><body><div class="wrap">
<h1>rulith-agent · reasoning timeline</h1>
<p class="sub" id="head">Connecting…</p>
<div id="feed"></div>
<div id="saybox" style="display:none;position:sticky;bottom:0;background:var(--bg);padding:12px 0 18px">
  <form id="sayform" style="display:flex;gap:8px">
    <input id="saytext" placeholder="Continue the conversation…" style="flex:1;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:14px">
    <button style="background:var(--cyan);color:#06231f;border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer">Send</button>
  </form>
</div>
</div>
<script data-k="__UI_KEY__">
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const feed=document.getElementById('feed')
const add=(html)=>{const d=document.createElement('div');d.innerHTML=html;feed.appendChild(d);window.scrollTo(0,document.body.scrollHeight)}
const UIK=document.currentScript?document.currentScript.dataset.k:window.__UIK
const es=new EventSource('/events?k='+encodeURIComponent(UIK))
es.onmessage=(m)=>{
  const e=JSON.parse(m.data)
  if(e.type==='start'){
    document.getElementById('head').innerHTML='Agent <b>'+esc(e.agent)+'</b> · '+esc(e.url)+
      ' <span class="pill run">Running</span><div class="why">Task: '+esc(e.task)+'</div>'
    add('<div class="card"><div class="sub">Initial board state</div><pre>'+esc(e.projection||'(empty)')+'</pre></div>')
  }
  if(e.type==='user'){
    document.getElementById('saybox').style.display='block' // 对话形态才会有 user 事件——露出输入框
    add('<div class="card" style="border-color:rgba(53,208,186,.35)"><div class="sub">You</div><div class="say">'+esc(e.text)+'</div></div>')
  }
  if(e.type==='case-open') add('<div class="round">'+(e.ok?(e.healed?'Previous case closed → new case ':'Case opened · ')+esc(e.board):'Could not open case · '+esc(e.teaching||''))+'</div>')
  if(e.type==='segment-end') add('<div class="round">'+esc(e.note||'')+'</div>')
  if(e.type==='round') add('<div class="round">Round '+e.n+'</div>')
  if(e.type==='propose') add('<div class="card"><div class="say">'+esc(e.say||'(The model proposed operations only.)')+'</div>'+
    (e.ops?'<details><summary>Proposed '+e.ops.length+' operation(s)</summary><pre>'+esc(JSON.stringify(e.ops,null,2))+'</pre></details>':'')+
    (e.cmds?'<details><summary>Issued '+e.cmds.length+' command(s) ('+esc(e.cmds.map((c)=>c.action||c.kind).join(' → '))+')</summary><pre>'+esc(JSON.stringify(e.cmds,null,2))+'</pre></details>':'')+'</div>')
  if(e.type==='verdict'){
    const box=e.accepted
      ? e.cmd
        ? e.done===true
          ? '<div class="verdict '+(e.ok===true?'accept':'reject')+'"><b>Board: action '+(e.ok===true?'completed':'failed')+'</b> · '+esc(e.cmd)+' · invocation '+esc(e.invocation||'')+' · revision '+esc(e.revision||'')+'</div>'
          : '<div class="verdict reject"><b>Board: action accepted but not completed synchronously</b> · '+esc(e.cmd)+' · invocation '+esc(e.invocation||'')+' · revision '+esc(e.revision||'')+'</div>'
        : '<div class="verdict accept"><b>Board: accepted</b> · '+e.added+' item(s) added · revision '+esc(e.revision||'')+'</div>'
      : '<div class="verdict reject"><b>Board: rejected</b><div class="why">'+esc(e.teaching)+'</div>'+
        '<div class="why" style="color:var(--faint)">The board returns this guidance to the model so it can correct the request.</div></div>'
    feed.lastElementChild.firstElementChild.insertAdjacentHTML('beforeend',box)
    window.scrollTo(0,document.body.scrollHeight)
  }
  if(e.type==='end'){
    document.getElementById('head').querySelector('.pill').outerHTML=
      '<span class="pill '+(e.ok?'ok':'stop')+'">'+esc(e.note)+'</span>'
    add('<div class="round">Final authoritative board state</div><div class="card"><pre>'+esc(e.projection)+'</pre>'+
      '<p class="sub" style="margin:10px 0 0">Verify in Console: <a href="'+esc(e.console)+'" target="_blank" rel="noopener">'+esc(e.console)+'</a></p></div>')
  }
}
document.getElementById('sayform').addEventListener('submit',async(ev)=>{
  ev.preventDefault()
  const t=document.getElementById('saytext')
  const v=t.value.trim(); if(!v)return
  t.value=''
  await fetch('/say',{method:'POST',headers:{'content-type':'application/json','x-rulith-ui':UIK},body:JSON.stringify({text:v})}).catch(()=>{})
})
</script></body></html>`

let server = null
// 浏览器/GUI 脸的输入面挂点: REPL 收件箱把自己注册进来(--ui 且对话形态时),POST /say 即投递。
// 这就是「嵌入别的应用」的全部合同: GET /events 出(SSE,晚开补看全史) + POST /say 进。
let uiInput = null
if (withUi) {
  // 门(三道,都便宜): ① 随机钥(头或 query) ② Origin/Host 必须是本机自己 ③ 只收 JSON、封顶 64KB。
  // 任何一道不过就 403 并说清缘由——嵌入方照着补,攻击者拿不到钥。
  const uiGate = (req) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = req.headers['x-rulith-ui'] ?? url.searchParams.get('k') ?? ''
    if (key !== UI_KEY) return 'Missing or invalid UI key. Use the key printed at startup: x-rulith-ui for requests, or ?k= for SSE.'
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return `Cross-origin request rejected (Origin: ${origin}). The local UI accepts local origins only.`
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return `Non-local Host rejected (${host}) to prevent DNS rebinding.`
    return null
  }
  server = http.createServer((req, res) => {
    // 缺省 403 是**门**的码(钥/源/内容类型);`bad_command` 那一类要显式给 400——
    // 「不许你」和「这条命令不成形」是两件事,拿同一个码说会让客户端分不开该改什么。
    // (本文件下方 `--serve` 那个 deny 一直有这个形参,这一处 2026-08-22 补齐——
    //  同一个仓里两份同名助手,一份没跟上,正是本轮两仓反复撞见的形状。)
    const deny = (why, status = 403) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, teaching: why }))
    }
    if (req.method === 'POST' && req.url === '/say') {
      const bad = uiGate(req)
      if (bad !== null) return deny(bad)
      const ct = String(req.headers['content-type'] ?? '')
      if (!ct.startsWith('application/json')) return deny('Only application/json is accepted; plain-text bodies can bypass browser preflight checks.')
      // 按字节收、收完再解码(2026-08-18): 逐块拼字符串会把跨块的多字节字符切坏——
      // 短消息永远正常、长消息偶发乱码,是最难查的那一类。
      const chunks = []
      let size = 0
      let over = false
      req.on('data', (c) => {
        size += c.length
        if (size > UI_MAX_BODY) { over = true; req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => {
        if (over) return deny('Request body exceeds 64KB.')
        let text = ''
        try { text = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').text ?? '') } catch { return deny('Body is not valid JSON. Expected {"text":"…"}.') }
        // **一段全是 `�` 的文字不是任务**(2026-08-22 真机看图撞出,RT-AUI-4)。
        //
        // 那次的 `推理时间线` 页面上「你」整行是替换字符,而它下面照样写着
        // 「开单 · 案卷 orders-…-41d9」——**乱码开成了一块案卷**,上了板、烧了模型轮、留在「在办」。
        //
        // 成因不在这里(那次是 `curl.exe` 收命令行参数时按 Windows ANSI 码页转过一道,
        // 中文在参数里就烂了;本函数上面那句「按字节收、收完再解码」是对的)。
        // **但"来源不是我们"不等于"我们不用管"**:非法字节被 Node 解成 U+FFFD 之后,
        // 这里拿到的是一个**合法的 JS 字符串**,于是一路放行。凡是编码坏掉的客户端
        // (不同的终端、代理、被截断的多字节流)都会走到这一格。
        //
        // 判据看**占比**不看"有没有":正文里偶尔一个替换字符是他的**内容**脏,不是他的编码坏。
        const bad = (text.match(/�/g) ?? []).length
        if (text.length >= 4 && bad / text.length > 0.3) {
          return deny(`The text contains ${bad}/${text.length} Unicode replacement characters (�), so the incoming bytes were not valid UTF-8. ` +
            `The board would preserve the corrupted text. Send a UTF-8 file (for example, curl --data-binary @file) or fix the sender encoding.`, 400)
        }
        if (uiInput === null) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, teaching: 'This one-shot run does not accept follow-up messages. Start without a task argument to enter interactive mode.' }))
          return
        }
        uiInput(text)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    if (req.url.startsWith('/events')) {
      const bad = uiGate(req)
      if (bad !== null) return deny(bad)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`) // 晚开的页面补看全程
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    const bad = uiGate(req)
    if (bad !== null) return deny(bad)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE.replace('__UI_KEY__', UI_KEY))
  })
  await new Promise((r) => server.listen(UI_PORT, '127.0.0.1', r))
  const url = `http://127.0.0.1:${UI_PORT}/?k=${UI_KEY}`
  console.log(`\nLocal UI: ${url} (loopback only; the key is randomized at every start; embedded clients should send x-rulith-ui)`)
  // 无头/嵌入场景(以及自动化测试)不该弹浏览器: RULITH_UI_OPEN=off 只起服务不开窗
  const opener = (process.env.RULITH_UI_OPEN ?? '') === 'off' ? null
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try { if (opener !== null) spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref() } catch { /* 打不开就手点上面那个地址 */ }
}

// ── Board Protocol client ─────────────────────────────────────────────────
// Configuration and Board lifecycle belong to Console/governance. This local
// runtime only opens, uses, pauses, and closes Case Contexts on the Agent Board.
const CASE_CONTEXT_OPERATIONS = new Set([
  'GetProjection', 'GetChanges', 'GetCompletion', 'QueryBoard', 'RunDischarge', 'ApplyBatch',
  'CloseCase', 'PauseCase', 'Explain', 'IngestObservation', 'GrantClearance', 'ClaimWork', 'ApplyAction', 'ReportWork',
])
const STALE_CASE = new Set(['stale_case_revision', 'case_paused', 'case_closed', 'unknown_case'])
let seq = 0
/** The only Board address and Case envelope constructor in the runtime. */
async function board(operation, ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.board !== 'string' || ctx.board === '') {
    throw new Error(`board(): missing execution context for ${String(operation?.kind ?? '?')}.`)
  }
  const bound = CASE_CONTEXT_OPERATIONS.has(String(operation?.kind ?? '')) ? ctx.case : undefined
  let r
  try {
    r = await fetch(`${URL_BASE}/board/v1/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ protocol: 'rulith-board/1', boardId: ctx.board, requestId: `agent_${Date.now().toString(36)}_${seq++}`, operation,
        ...(bound !== undefined ? { case: { id: bound.id, expectedRevision: bound.revision } } : {}) }),
    })
  } catch (e) {
    die(`Cannot reach ${URL_BASE}: ${e?.cause?.code ?? e?.message ?? e}. Check the network or point RULITH_URL at your deployment.`)
  }
  const raw = await r.text().catch(() => '')
  let j
  try { j = JSON.parse(raw) } catch { j = {} }
  if (r.status === 401) die(`Token rejected (401): ${j.teaching ?? ''}`)
  // **没有内容的报错不是接口**(2026-08-22,RT-ALOOP-TRANSPORT)。
  //
  // 本函数原来除 401 外**从不看 HTTP 状态**:502 + HTML 正文、200 + 半截 JSON、网关重启,
  // 一律折成一次"语义拒"——而调用点读的是 `teaching ?? errorCode ?? ''`,于是模型收到的是
  //   「板拒绝了这一批,原话:(空)。照它说的改,再提一次。」
  // 模型照着空气改,烧到 MAX_ROUNDS。实测两种载荷都是这个形状。
  //
  // 判据是**「这份回执里有没有板的裁决」**,不是「HTTP 通没通」——初版写的是 `!r.ok`,
  // 而 `200 + 半截 JSON` 那一格 `r.ok` 为真,判据当场漏(枪的第二臂逮住的)。
  // 板的回执**必然带 `accepted` 这个布尔**(接受与拒绝都带);两个字段都没有 ⇒ 这根本不是回执。
  // 合成一条真的教学,用网关既有的 `upstream_unavailable`,并把 HTTP 状态与正文头带上。
  // 这是本文件第二条纪律(报错是接口)在传输面的同一句话。
  if (typeof j?.accepted !== 'boolean' && typeof j?.errorCode !== 'string') {
    const head = raw.replace(/\s+/g, ' ').trim().slice(0, 160)
    j = {
      accepted: false,
      errorCode: 'upstream_unavailable',
      teaching: `The Cloud hop failed (HTTP ${r.status}); the board never received this batch.` +
        ` Retry it unchanged. If it keeps failing, check whether ${URL_BASE} is reachable.` +
        (head !== '' ? `\n   First 160 response characters: ${head}` : '\n   The server returned an empty body.'),
    }
  }
  if (bound !== undefined && STALE_CASE.has(String(j?.errorCode ?? ''))) ctx.case = undefined
  if (bound !== undefined && j?.accepted === true && typeof j.caseRevision === 'string') {
    ctx.case = { ...bound, revision: j.caseRevision }
  }
  return j
}
/** Open or resume exactly one named Case Context. Never adopt another Case. */
async function ensureCaseContext(ctx, caseId) {
  if (ctx.case?.id === caseId && ctx.case?.root === caseId && typeof ctx.case?.revision === 'string' && ctx.case.revision !== '') return ctx.case
  ctx.case = undefined
  let mf = await board({ kind: 'GetBoardManifest' }, ctx)
  if (mf.accepted !== true) {
    log(`✗ Cannot inspect Agent Board "${ctx.board}": ${String(mf.teaching ?? mf.errorCode ?? '').slice(0, 240)}`)
    return undefined
  }
  if (mf.payload?.status === 'initializing') {
    log(`✗ Agent Board "${ctx.board}" is still initializing. Complete Capability and shared-state setup in Console; the execution runtime will not perform governance activation.`)
    return undefined
  }
  const running = (mf.payload?.cases ?? []).filter((candidate) => candidate !== null && typeof candidate === 'object' && candidate.status === 'running')
  const hit = running.find((w) => w.id === caseId)
  if (hit !== undefined) {
    if (hit.root !== caseId) {
      log(`✗ Case Context "${caseId}" has root "${String(hit.root)}". Case identity and acceptance root must be identical.`)
      return undefined
    }
    ctx.case = { id: caseId, root: caseId, revision: String(hit.revision) }
    log(`◎ Resuming Case "${caseId}" on Agent Board "${ctx.board}".`)
    return ctx.case
  }
  const opened = await board({ kind: 'OpenCase', caseId, root: caseId }, ctx)
  if (opened.accepted !== true) {
    log(`✗ Could not open Case "${caseId}" on Agent Board "${ctx.board}": ${String(opened.teaching ?? opened.errorCode ?? '').slice(0, 240)}`)
    return undefined
  }
  const openedId = String(opened.payload?.caseId ?? '')
  if (openedId !== caseId) {
    log(`✗ The authority opened Case Context "${openedId}" for requested Case "${caseId}". Execution stopped before writing task facts.`)
    return undefined
  }
  const revision = String(opened.payload?.caseRevision ?? '')
  if (revision === '') {
    log(`✗ The authority opened Case "${caseId}" without a Case revision. Execution stopped before writing task facts.`)
    return undefined
  }
  ctx.case = { id: caseId, root: caseId, revision }
  return ctx.case
}
/** Close the current Case Context with an explicit disposition. */
async function archiveCaseContext(ctx, disposition) {
  const bound = ctx.case
  if (bound === undefined) return false
  const r = await board({ kind: 'CloseCase', root: bound.root, disposition }, ctx)
  if (r.accepted === true) {
    ctx.case = undefined
    log(`◎ Closed Case "${bound.root}" with disposition "${disposition}". Its record remains available in Console.`)
    emitOn(ctx, 'case-closed', { caseId: bound.root, disposition })
    return true
  } else {
    log(`◎ Case close rejected: ${String(r.teaching ?? r.errorCode ?? '').slice(0, 240)}
   Case "${bound.root}" remains active so later evidence and receipts still have a valid target.`)
    return false
  }
}
// 注意力预算(核心 §6.5.1,协议面 GetProjection.attention): **有损聚焦**,只对模型读用,
// 不用于裁决读(裁决必须无损)。板一大,全量投影会把窗口吃光——真板实测 364 条事实的板
// 收到 60 条省约 74% 上下文。text 面自带「本视图已聚焦…要看全板重发不带 attention 的读」,
// 所以模型知道自己看的是窄视图,不会把"没看见"当成"不存在"。
// 缺省不开(零回归): 配 RULITH_ATTENTION_FACTS=60 才生效。
const ATTENTION_FACTS = Number(process.env.RULITH_ATTENTION_FACTS ?? 0)
const attnArg = () => (ATTENTION_FACTS > 0 ? { attention: { budget: { facts: ATTENTION_FACTS } } } : {})

const projectionText = async (ctx, opts = {}) => {
  const r = await board({ kind: 'GetProjection', ...(opts.full === true ? {} : attnArg()) }, ctx)
  if (r.accepted !== true) return `(board unavailable: ${r.teaching ?? r.errorCode ?? ''})`
  let text = String(r.payload?.text ?? '')
  // 板报缺口(QueryBoard include:gaps,0.11): 「现在该干嘛」由板自己说——桥缺可信来源/放电卡点/
  // 交付义务,不靠模型对着全量投影猜。老 boardd 无 QueryBoard=拒,静默略过(缺口段是增益不是依赖)。
  const { gaps, inFlight } = await boardGaps(ctx)
  if (gaps.length > 0) {
    const lines = gaps.slice(0, 12).map((x) => `- ${x.gap}(${Object.entries(x.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')})`)
    text += ['', '', 'Board-reported gaps (what remains; handle these first):', ...lines].join(String.fromCharCode(10))
  }
  if (inFlight.length > 0) {
    const lines = inFlight.slice(0, 12).map((x) => `- ${String(x.args?.node ?? '')}: verification dispatched; waiting for evidence`)
    text += ['', '', 'Verification in flight (not a gap; wait for the next round and do not rewrite the leaf or close the task):', ...lines].join(String.fromCharCode(10))
  }
  return text
}

// One persistent Agent Board carries governance and shared state. Every task
// gets exactly one Case Context, opened by OpenCase(caseId) and closed by
// CloseCase. Board creation, package installation, and board sealing belong
// to the governance plane and are deliberately absent from this runtime.

// ══ viz 那套循环的四个器官（2026-08-06 搬进来）══════════════════════════
//
// 用户裁定：viz 演示里的循环是唯一满意的形态，REPL 要照它的功能来，但**全部走云协议 op**。
// 它在 apps 侧是 `runProtocolAgent`（rulith-agent-runtime），本文件不能 import 它——
// REPL 是**单文件零依赖可分发物**，客户机上只有一个 node 就得能跑，接那个包会拖进整个 rulith-core。
// 所以这里是**按协议面重新实现**，不是复制代码：能对齐的是行为，对不齐的是实现。
//
// 搬了什么、为什么：
//   ① 自动放电（digest 守卫）—— 此前**完全没有**。任务树的叶子带着 spec 躺在板上，
//      永远等不到后端求证，certified 因此永远不来。这是四个缺口里唯一会让循环**跑不到头**的。
//   ② 板裁决终态 —— 此前 `DONE:` 就是结论，板没有否决权；而本文件开头第一条纪律写的是
//      「结论不是模型写的」。现在 DONE 只是**请求**，收尾那句话报的是板的判词。
//   ③ 影子拍序前移 —— viz 的命门是「影子先审、再放电」：影子的缺陷主张与主叶**同一次**放电接地，
//      confirmed_defect 才来得及在 certify 之前挡门。影子放最后＝永远慢一拍＝无牙。
//      段尾那次审阅保留，改称【关门审计】。
//   ④ stalled 早停 + 插话不打断 —— 连轮空转不再烧到 MAX_ROUNDS；用户中途说话当轮就进对话。
//
// **没搬 actuate（执行器收据面）**，那是故意的：本文件是「脑」，手归 rulith-worker（见文件头边界）。
// 一个进程既提议又执行，等于把提议方和执行方合成一个人——那正是收据面要拆开的东西。

/** 板上现有的根（枚举给放电/完成态/归档共用）。 */
async function boardRoots(ctx) {
  const pj = await board({ kind: 'GetProjection', format: 'json' }, ctx)
  if (pj.accepted !== true) return { roots: [], facts: [] }
  const facts = pj.payload?.context?.facts ?? []
  const roots = [...new Set(facts.filter((f) => f.atom?.predicate === 'root').map((f) => String(f.atom.args?.node ?? '')))].filter(Boolean)
  return { roots, facts }
}

/**
 * Wait for the terminal receipt of one accepted outward action without spending
 * another model turn. Intake actions are the important edge case: before their
 * receipt there is deliberately no task root, so the ordinary settlement loop
 * (which starts from a task tree) cannot observe them.
 */
async function waitForTerminalActionReceipt(ctx, invocation) {
  if (!invocation || SETTLE_WAIT_MS <= 0) return undefined
  const until = Date.now() + SETTLE_WAIT_MS
  let announced = false
  while (Date.now() < until) {
    const { facts } = await boardRoots(ctx)
    for (const fact of facts) {
      const predicate = fact.atom?.predicate
      const args = fact.atom?.args ?? {}
      if (String(args.invocation ?? '') !== invocation) continue
      if (predicate === 'effect_confirmed') {
        return { ok: true, detail: String(args.result ?? '') }
      }
      if (predicate === 'effect_failed') {
        return { ok: false, detail: String(args.reason ?? '') }
      }
    }
    if (!announced) {
      log(`◌ Waiting locally for the terminal action receipt (${invocation}); no model turn is being consumed.`)
      announced = true
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return undefined
}

const revisionNow = async (ctx) => String((await board({ kind: 'GetHealth' }, ctx))?.revision ?? '')

// ① 自动放电：板算 digest，客户端只记「这个版本我放过了」。
//    at-most-once per spec 版本——改了 spec 就自动重放电，策略杠杆留在模型手里。
//    放电**不是工具**，模型不用（也不该）知道怎么触发它；它只会在 [结果] 里看到接地或缺口。
//    守卫状态(dischargedDigest/lastLeaves)**入槽**(2026-08-07): 它是"这块板的这个 spec 版本我放过了"
//    的记账,跨客户共享一份等于把 A 的放电记录拿去挡 B 的叶子(永远等不到求证)。
async function dischargePass(ctx) {
  if ((process.env.RULITH_AUTO_DISCHARGE ?? '') === 'off') return ''
  const { roots } = await boardRoots(ctx)
  if (roots.length === 0) { ctx.lastLeaves = []; return '' }
  const notes = []
  const seen = []
  for (const root of roots) {
    const c = await board({ kind: 'GetCompletion', root }, ctx)
    if (c.accepted !== true) continue
    const leaves = c.payload?.leaves ?? []
    seen.push(...leaves)
    // 守卫键**带板**: 案板模式下节点名跨案卷天然重名(每单都有自己的 L1),只按节点名记
    // 「放过了」,第二单的同名叶子会被第一单的记录挡住——**永远等不到求证,certified 永远不来**。
    const key = (l) => `${ctx.board}::${l.node}`
    const fresh = leaves.filter((l) => l.met !== true && ctx.dischargedDigest.get(key(l)) !== l.digest)
    if (fresh.length === 0) continue
    for (const l of fresh) ctx.dischargedDigest.set(key(l), l.digest)
    const r = await board({ kind: 'RunDischarge', root, leaves: fresh.map((l) => String(l.node)) }, ctx)
    if (r.accepted !== true) {
      // 放电拒**不静默**：没装验收桥是最常见的一种,教学原话直接回模型与人(报错=接口)
      notes.push(`[Verification rejected] ${String(r.teaching ?? r.errorCode ?? '').slice(0, 180)}`)
      continue
    }
    const gaps = r.payload?.gaps ?? []
    // 在途与缺口分栏(同上): work-ordered 是"派出去了,等回话",说成缺口会让模型以为卡住了。
    const ordered = gaps.filter((g) => /work-ordered|退避窗|backoff window/.test(String(g.reason ?? '')))
    const real = gaps.filter((g) => !/work-ordered/.test(String(g.reason ?? '')))
    notes.push(`[Verification] ${fresh.length} ${fresh.length === 1 ? 'leaf' : 'leaves'}${real.length ? `; gaps: ${real.map((g) => `${g.node}(${String(g.reason ?? '').slice(0, 80)})`).join(' · ')}` : ''}${ordered.length ? `; evidence pending (the runtime will wait): ${ordered.map((g) => g.node).join(' · ')}` : ''}${real.length === 0 && ordered.length === 0 ? '; all closed' : ''}`)
  }
  ctx.lastLeaves = seen
  // **人也要看得见**(2026-08-06 真机第一次跑就是这个坑): 器官只喂模型不喂人,等于没跑——
  // 出了岔子没人知道该看哪。终端是这个形态的唯一界面,它必须显示循环在做什么。
  for (const n of notes) log(n)
  if (notes.length) emitOn(ctx, 'discharge', { notes })
  return notes.length ? '\n' + notes.join('\n') : ''
}

// ② 板裁决的完成态：多根取合取（全部 certified 才算 certified），floor 取最弱的一档。
//    `allDone` 是**另一根轴**,不能与 certified 混用: certified 说的是「够不够硬」,
//    state 说的是「还有没有活」。真机上见过 certified=true 而 state=actuating(手领了活没回执)——
//    只看 certified 就封板,等于把"还在办"记成"办完了"(2026-08-07 review 的假绿正是这个形状)。
const FLOOR_ORDER = ['asserted', 'assume', 'approximate', 'attested', 'verified']
async function completionAll(ctx) {
  const { roots } = await boardRoots(ctx)
  if (roots.length === 0) return { certified: false, floor: '—', state: 'empty', allDone: false, breached: false, conflicts: [], roots: [] }
  let certified = true; let floor = 'verified'; let breached = false; let allDone = true; const conflicts = []; const states = []
  for (const root of roots) {
    const c = await board({ kind: 'GetCompletion', root }, ctx)
    if (c.accepted !== true) { certified = false; allDone = false; continue }
    const p = c.payload ?? {}
    if (p.certified !== true) certified = false
    if (String(p.state ?? '') !== 'done') allDone = false
    const f = String(p.floor ?? 'asserted')
    if (FLOOR_ORDER.indexOf(f) < FLOOR_ORDER.indexOf(floor)) floor = f
    if (p.breached === true) breached = true
    for (const x of p.conflicts ?? []) conflicts.push(x)
    states.push(`${root}=${String(p.state ?? '')}`)
  }
  return { certified, floor, state: states.join(' '), allDone, breached, conflicts, roots }
}

/**
 * **段尾收工的唯一可交付判据**——案板腿(封板)与长命板腿(归 Work)共用这一个执行点。
 *
 * 从前只有案板腿有这三重判据(`roots>0 && certified && allDone`),长命板腿是**无条件**归档:
 * 段一停轮就把那件事归掉,而 CloseCase 缺省按 `completed` 关账 ⇒ 没办完的活被记成办结
 * (2026-08-17 orders-bt 真机)。两条腿走同一个判据,就没有"哪一条腿松一点"这回事了。
 *
 * 收工前**重读一次板的裁决**: 段内最后一轮之后板还可能变(放电回执/影子异议落板),
 * 拿轮内的旧读去决定终态,就是拿过期判词收工。
 */
async function deliverableNow(ctx) {
  let final = await completionAll(ctx)
  // **在途要等一等再判**(2026-08-18 冷通枪逮到的真缺陷): 求证工单派出去要几秒到几十秒才回,
  // 而模型往往在派完的那一轮就 DONE。只判一次 ⇒ 板此刻还没 certified ⇒ 案卷永久留「在办」,
  // 而十几秒后板自己就判可交付了——**"办完了却不结案"的全部成因就是这个时序**。
  // 只在**还有活着的求证在途**时等(不是无脑 sleep): 最多 DELIVERABLE_WAIT_MS,每 3s 重判一次。
  const deadline = Date.now() + Math.max(0, DELIVERABLE_WAIT_MS)
  let pushed = false
  let lastWaitLine = ''
  // 循环条件**不能只看 certified**(2026-08-18 第四发): 失败形状恰恰是「已 certified 但义务未清」
  // ——那时循环不进,直接判 deliverable,封板被板拒(还有 N 项未结),案卷白白留「在办」。
  // 判据 = 未达可交付 **或** 还有未结义务,两者都清才收工。
  while (final.roots.length > 0 && Date.now() < deadline) {
    const notYet = final.certified !== true || final.allDone !== true
    // **先补一次放电再等**(2026-08-18 冷通枪第二发逮到): 模型往往在第一批求证刚回一条时就 DONE,
    // 剩下的叶子**连工单都还没派**——只等在途等不来它们。放电是幂等的(按 spec 版本 at-most-once),
    // 收工前补跑一次不会重复烧后端,却能把"还没派单的叶子"一次性推出去。
    const { roots, facts } = await boardRoots(ctx)
    if (roots.length === 0) break
    const openNow = openObligations(facts)
    if (!notYet && openNow.length === 0) break // 达标且义务清空——收工
    if (!pushed && notYet) { pushed = true; await dischargePass(ctx); final = await completionAll(ctx); continue }
    const g = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx)
    // `leaf_gap(...:work-ordered)` 是派单视图，不是租约台账。旧 gap 可能晚于
    // 对应的 discharge_done；直接拿它判在途会让混合核验白等满一个结算窗。
    const inflight = hasLiveDischargeWork(facts)
      && (g.accepted === true ? (g.payload?.gaps ?? []) : []).some((x) => /work-ordered/.test(String(x.args?.reason ?? '')))
    // **动作在途也要等**(2026-08-18 冷通枪第三发): 板判 1/1 叶接地 certified,封板却被拒——
    // 「本案还有 5 项未结」= 已派发未回执的动作(等执行器/等清关)。求证与动作是两条在途线,
    // 只等一条,另一条就成了"办完了却不结案"的新成因。义务清没清是**宿主看得见的机械事实**,
    // 不该靠模型自觉等——所以判据放在这里,不放在提示词里。
    const open = openNow
    if (!inflight && open.length === 0 && !notYet) break
    if (!inflight && open.length === 0) {
      // **认输前先代跑一次复活重探**(与段内落定等待同一条判据,2026-08-18 第五发):
      // 求证失败后的补单只在下一次 RunDischarge 时发生——收工闸里没有下一个模型轮了,
      // 宿主不代跑,失败的求证就永远等不来第二枪,案卷白白留「在办」。补不出新在途才认输。
      await dischargePass(ctx)
      const g3 = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx)
      const rearmed = (g3.accepted === true ? (g3.payload?.gaps ?? []) : []).some((x) => /work-ordered/.test(String(x.args?.reason ?? '')))
      if (!rearmed) break // 没在途也没义务,再等也不会变
    }
    // **同一句话只说一次**(2026-08-18 真机: 3 秒一轮打了十三行一模一样的等待行,把中栏刷成噪音)。
    // 内容变了(等的东西不一样了)才再说——**重复不是信息**,而屏幕上的位置是有限的。
    const waitLine = `◌ ${[inflight ? 'verification in flight' : '', open.length ? `unreceipted actions ${open.join('/')}` : ''].filter(Boolean).join(' · ')}; waiting before deciding deliverability (up to ${Math.round(DELIVERABLE_WAIT_MS / 1000)}s)`
    if (waitLine !== lastWaitLine) { log(waitLine); lastWaitLine = waitLine }
    await new Promise((r) => setTimeout(r, 3000))
    final = await completionAll(ctx)
  }
  const deliverable = final.roots.length > 0 && final.certified === true && final.allDone === true
  const why = final.roots.length === 0
    ? 'The board has no task tree, so this segment has no deliverable.'
    : `The board has not established deliverability (certified=${final.certified} · floor=${final.floor} · ${final.state}).`
  return { final, deliverable, why }
}

/** 未结义务(已派发未回执的动作 + 待清关的审查)。**唯一判据**: 脉冲与收工闸共用这一份。 */

function openObligations(facts) {
  const fs = facts ?? []
  const arg = (f, k) => String(f.atom?.args?.[k] ?? '')
  // **有结论 = 成败两档**(核心 69-seal-gate 门牌同句): 回执的意思是"这件事有了结论",
  // 失败也是结论。原先只数 effect_confirmed ⇒ 失败的调用永远算未结。
  //
  // ⚠️ **键按 invocation,不按工具名**(2026-08-20 修): 同一只手可以有多次在飞的调用。
  // 上一轮改名时这一集**只改了查的那侧、没改建的那侧**(建集用 `action`,查用 `invocation`)
  // ——`action` 这个键在板上已经不存在了 ⇒ 集合全是空串 ⇒ **永远匹配不上** ⇒
  // 每一次调用都被算作未结,收工闸白等到超时。与核心那四处写点是同一个病:
  // **改名漏一侧不报错,只让某个判据恒假。**
  const settled = new Set(
    fs.filter((f) => f.atom?.predicate === 'effect_confirmed' || f.atom?.predicate === 'effect_failed')
      .map((f) => arg(f, 'invocation')),
  )
  const acts = [...new Set(fs.filter((f) => f.atom?.predicate === 'dispatched' && !settled.has(arg(f, 'invocation'))).map((f) => arg(f, 'tool')))]
  // **字段名逐个照板上的真形写**(2026-08-18 真机: 读错字段 ⇒ 清关后义务永远消不掉,
  // 收工闸白等到超时)。宪法闸族的实参 2026-08-20 由旧名 action-sig 整族改名为 `tool`。
  const sig = (f) => arg(f, 'tool')
  const cleared = new Set(fs.filter((f) => f.atom?.predicate === 'norm_cleared').map((f) => `${sig(f)}@${arg(f, 'norm')}`))
  const revs = [...new Set(fs.filter((f) => f.atom?.predicate === 'norm_review' && !cleared.has(`${sig(f)}@${arg(f, 'norm')}`)).map((f) => `${sig(f)}@${arg(f, 'norm')}`))]
  // **拦在宪法闸前的动作也是未结义务**(2026-08-18 用户裁「宪法闸 review 拦截审核应该是同一拍动作」):
  // dispatch_blocked 是 host 记账 EDB,清关落地即 retract——在板上活着就意味着审查席/人签正在替它
  // 干活。真机形状: 求证先转绿(certified=true)而 deduct/notify 还压在闸下,模型被叫醒只能回
  // 「等 norm 审核」白烧两轮——义务清没清与叶子绿没绿是两根轴,这里是缺的那半边判据。
  const blocked = [...new Set(fs.filter((f) => f.atom?.predicate === 'dispatch_blocked' && !revs.includes(`${sig(f)}@${arg(f, 'norm')}`)).map((f) => `${sig(f)}⛔${arg(f, 'norm')}`))]
  // **意图是义务的先声**(2026-08-18 首探二发逮住): ApplyBatch 返回后,①级语义闸(嵌入)与
  // 派发是**异步**的——有一个好几秒的窗口,板上还没有 dispatched/dispatch_blocked,
  // 光数它们的闸在窗口里读 0,注定红的首探照旧出手。意图与批同步落板,没有这个窗口:
  // 还有 tool_invoked 没走到 effect_confirmed/effect_failed,就视作"有人马上要干活"。
  // (键从工具名换成 invocation: 同一只手可以有多次在飞的调用,核心 2026-08-20 工具面收敛。)
  // 永不落地的意图(缺工具/缺实参)会把这条挂到超时——那正是 nextStepLine 缺实参分支
  // 与收工闸时限在管的事,不归这里兜。
  const intents = [...new Set(fs.filter((f) => !f.derived && f.atom?.predicate === 'tool_invoked' && !settled.has(arg(f, 'invocation'))).map((f) => arg(f, 'tool')))].filter((a) => !acts.includes(a))
  return [...acts, ...revs, ...blocked, ...intents]
}

/** 求证是否真的还在途。`leaf_gap(...:work-ordered)` 是派单视图，可能在终态回执后残留；
 * 等待只认权威工单台账的差集：discharge_work - discharge_done。 */
function hasLiveDischargeWork(facts = []) {
  const arg = (f, key) => String(f?.atom?.args?.[key] ?? '')
  const done = new Set(facts
    .filter((f) => f?.atom?.predicate === 'discharge_done')
    .map((f) => arg(f, 'work'))
    .filter(Boolean))
  return facts.some((f) => {
    if (f?.atom?.predicate !== 'discharge_work') return false
    const work = arg(f, 'work')
    return work !== '' && !done.has(work)
  })
}

/** A work-ordered gap is only an in-flight display hint while the authoritative
 * discharge ledger still contains unfinished work. QueryBoard may retain the
 * dispatch-era gap after the terminal receipt, so the gap alone is not a
 * lifecycle authority. */
function visibleInFlightGaps(gaps = [], facts = []) {
  return hasLiveDischargeWork(facts) ? gaps : []
}

/** 板报缺口的**唯一读取点**（全板视图与每轮指引共用一份判据）。
 *  **在途不是缺口**（2026-08-18 冷通枪逮到）：`work-ordered` = 求证工单已派给真探、正在等回话，
 *  是**正常在途态**。把它摆进"还差什么（优先处理）"那一栏，模型会合理地判断"卡住了"并停轮
 *  ——真机上它 15 秒就收工，活干完了却不结案。在途单独一栏说清"等着就行"。 */
async function boardGaps(ctx) {
  const g = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx)
  const all = g.accepted === true ? (g.payload?.gaps ?? []) : []
  const isFlight = (x) => /work-ordered/.test(String(x.args?.reason ?? ''))
  const candidates = all.filter(isFlight)
  if (candidates.length === 0) return { gaps: all, inFlight: [] }
  const p = await board({ kind: 'GetProjection', format: 'json' }, ctx)
  // If the ledger cannot be read, keep the conservative waiting hint. Hiding
  // real in-flight verification would be more damaging than a stale hint.
  const inFlight = p.accepted === true
    ? visibleInFlightGaps(candidates, p.payload?.context?.facts ?? [])
    : candidates
  return { gaps: all.filter((x) => !isFlight(x)), inFlight }
}






// ── 模型客户端（你的 key，直连你的模型服务；rulith 看不到这一段） ──────────
// 两种线型按 URL 形状识别: /chat/completions 结尾 = OpenAI 风格(deepseek/qwen 等),否则 Anthropic。
// 主人格与影子人格各一套配置(影子缺省沿用主配置——同一个模型换个立场,也已经值回票价;
// 独立小模型审大模型是升级形态,RULITH_SHADOW_* 配上即生效)。
/** 收工前等在途求证的上限(0=不等,老行为)。真探跑几秒到几十秒,而模型常在派完那轮就 DONE。 */
/** 在途就地结算的上限(0=关,老行为=每轮问一次模型)。派出去的求证/查询要几秒到几十秒才回,
 *  而模型在这段时间里除了「我等等」什么也说不出——**那几轮是纯烧**。宿主替它等,不花钱。 */
const SETTLE_WAIT_MS = Number(process.env.RULITH_SETTLE_WAIT_MS ?? 60_000)
const DELIVERABLE_WAIT_MS = Number(process.env.RULITH_DELIVERABLE_WAIT_MS ?? 45_000)
const MAIN_CFG = { url: MODEL_URL, key: MODEL_KEY, model: MODEL }
const SHADOW_CFG = {
  url: process.env.RULITH_SHADOW_URL ?? MODEL_URL,
  key: process.env.RULITH_SHADOW_KEY ?? MODEL_KEY,
  model: process.env.RULITH_SHADOW_MODEL ?? MODEL,
}
async function ask(messages, system, cfg = MAIN_CFG) {
  const openaiStyle = /\/chat\/completions\/?$/.test(cfg.url)
  let r
  try {
    r = await fetch(cfg.url, {
      method: 'POST',
      headers: openaiStyle
        ? { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` }
        : { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: openaiStyle
        ? JSON.stringify({
            model: cfg.model, max_tokens: 6000,
            // 混合思考模型(DeepSeek v4-pro 等)不关思考会把 token 烧在 reasoning 上,content 回空
            // ——真机 12 轮全空说才找到的。RULITH_MODEL_THINKING=enabled 可打开。
            thinking: { type: process.env.RULITH_MODEL_THINKING === 'enabled' ? 'enabled' : 'disabled' },
            messages: [{ role: 'system', content: system }, ...messages],
          })
        : JSON.stringify({ model: cfg.model, max_tokens: 6000, system, messages }),
    })
  } catch (e) {
    // 用户面工具不该抛原始堆栈: 说清连的是谁、怎么改(2026-08-01 自跑时踩到)
    die(`Cannot reach model service ${cfg.url}: ${e?.cause?.code ?? e?.message ?? e}.
   Set RULITH_MODEL_URL for a self-hosted or proxy endpoint. Leave it unset when using the default provider endpoint.`)
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) die(`Model service error (${r.status}): ${JSON.stringify(j).slice(0, 300)}`)
  if (openaiStyle) return String(j.choices?.[0]?.message?.content ?? '')
  return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

const EXECUTION_GUIDE = `The generic loop has six steps: read the goal and board projection; select one currently available action from the actions section; submit it; wait for its terminal receipt; read the board again; finish only when the board reports certified=true and no obligations remain.

1. Conclusions must be derived by the board. Submit only materials, task structure, or actions already declared by the board.
   The Worker writes structured tool-result facts automatically. Refer to those nodes and facts; do not copy them with assert_fact.
2. The actions section is authoritative. Use only actions marked as available, with names and parameter shapes from tool_def/action_def.
3. Submit at most one top-level command per turn. For a multi-step workflow, wait for the previous terminal receipt and the resulting closure before choosing the next command.
4. The host initiates verification automatically. Do not rewrite acceptance leaves while verification is pending, and do not treat an action receipt as final acceptance.
5. The board decides completion. Never assert acceptance_met or test_result yourself, and never use DONE to impersonate certification.
6. A rejection includes actionable teaching. Follow it; do not route around it.

In each turn, give a short explanation and exactly one JSON code block of one of these forms:

- Board operations: an array whose items contain op. One batch may contain the facts needed to establish a task tree.
- Top-level command: one object containing kind. Do not return an array of top-level commands or mix it with board operations.

Generic material template (replace every <...> placeholder with real content from the board or installed packs):
\`\`\`json
[{"op":"assert_fact","id":"<fact-id>","predicate":"<predicate-from-a-pack>","args":{"<argument-name>":"<real-value>"}}]
\`\`\`

Generic task-tree template:
\`\`\`json
[
  {"op":"assert_fact","id":"<goal-fact-id>","predicate":"goal_node","args":{"node":"<goal-node>"}},
  {"op":"assert_fact","id":"<acceptance-fact-id>","predicate":"acceptance","args":{"node":"<goal-node>","test":"<acceptance-name-from-the-task-or-pack>"}}
]
\`\`\`
Attach acceptance to leaves. Split independent obligations into separate leaves and connect them to their parent with subgoal_of. A leaf normally has one acceptance; multiple acceptance facts on one leaf are only for alternative verification paths.

Board-local action template (the actions section shows PRE/EFFECT and no parameter table, so omit args):
\`\`\`json
{"kind":"ApplyAction","action":"<board-local-action>"}
\`\`\`

External action template (select a target node already on the board; the host binds business arguments from uniquely matching trusted facts):
\`\`\`json
{"kind":"ApplyAction","action":"<external-action>","target":"<leaf-owned-by-the-action>"}
\`\`\`
The only bootstrap exception is an action whose description begins with [intake]. It atomically claims external work and returns its task structure. When no target leaf exists, invoke it once without target:
\`\`\`json
{"kind":"ApplyAction","action":"<[intake]-action>"}
\`\`\`
Do not create a temporary task tree before intake. After its terminal receipt, read the board again and bind every later external action to a real returned leaf. Without the [intake] marker, never guess that an action may run without a target.
Do not supply business identifiers, amounts, addresses, or other business arguments from conversation. Action arguments must come from board-grounded bindings. Continue only after a terminal receipt with done=true; done=false means accepted for processing, not succeeded.

Reply with BOARD: alone to read the full board. Reply with DONE: only when the board is complete. Reply with STOP: when material, domain capability, or a human decision is genuinely missing.`

const SYSTEM = `You are a domain-agnostic Rulith execution agent. The current board and its installed packs are the only source of domain semantics: vocabulary, rules, actions, parameter shapes, and acceptance names. Concrete goals and instance values come from the user task, board facts, and trusted tool results. Placeholders in this prompt are not domain facts.

Do not invent predicates, actions, or acceptance names. Do not add temporary axioms, define actions, or register packs. If a required domain capability is missing, reply STOP: and identify the missing capability; board administrators manage packs.

${EXECUTION_GUIDE}`

/** 模型这一轮提交了什么: `{ops:[…]}`=一批板内操作 · `{cmd:{kind,…}}`=一条顶层命令 · null=没提交。
 *
 *  **顶层命令这一支是 2026-08-21 真机演练撞出来补的(P0)**: 此前这里是
 *  `Array.isArray(v) ? v : null` —— 提示词第 9 条教的「让执行器干活 = 发一条独立命令
 *  `{"kind":"ApplyAction",…}`」是个**对象**，于是**被静默丢掉**，调用方按"模型这轮什么都没提交"
 *  处理，还回一句「没读到 JSON 操作块」。**教学教了一条客户端运不了的路，而且丢得无声无息**：
 *  模型照着模板发、看见什么也没发生、于是开始猜别的写法——四发实跑 `dispatched` 全是 0，
 *  根子就在这一行。纪律 4 的最坏形态不是没有模板，是模板抄了不管用。 */
const extractSubmission = (text) => {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (!m) return null
  let v
  try { v = JSON.parse(m[1].trim()) } catch { return null }
  if (Array.isArray(v)) {
    // 顶层命令数组仍要识别出来，交给循环作 fail-visible 单发拒绝；若误归成 ops，
    // 模型只会收到一段无关的 ApplyBatch 形状错误。产品面缺省每轮只执行一个外向动作。
    if (v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && typeof x.kind === 'string')) return { cmds: v }
    return { ops: v }
  }
  // 顶层命令: 认 `kind`(协议面的动词键)。板寻址与 requestId 由客户端补——那是它的活,不是模型的。
  if (v !== null && typeof v === 'object' && typeof v.kind === 'string') return { cmds: [v] }
  return null
}

// ── 主循环：提议 → 裁决 → 教学回流 ──────────────────────────────────
const log = (s) => console.log(s)
log(`
rulith-agent · Agent "${agentId}" · ${URL_BASE}`)
const consoleUrlOf = (name) => `https://console.rulith.ai/agents/${encodeURIComponent(name)}`
const consoleUrl = consoleUrlOf(agentId)
/** 停轮未结时终端上的那一句(三张脸共用一份措辞——同一件事三种说法比不说更糟)。 */
const pendingLine = (id) => (id === null || id === undefined ? '' : ` · Case remains open: pending_case_id=${id}. Resume with --case ${id}, or resolve it in Console.`)

// ── 锁态探测(2026-08-01 立法权锁,「看不见」优先于「拒得住」): 锁定板的系统提示
//    **根本不含**立规则/定义动作的模板——不给把手,模型就不会伸手去摸、也不会烧轮数撞拒绝。 ──
const SYSTEM_LOCKED = `You are a domain-agnostic Rulith execution agent. Legislative authority is locked on this board. The current board and its installed packs are the only source of domain semantics: vocabulary, rules, actions, parameter shapes, and acceptance names. Concrete goals and instance values come from the user task, board facts, and trusted tool results. Placeholders in this prompt are not domain facts.

Do not invent predicates, actions, or acceptance names. Do not attempt add_axiom, define_action, RegisterPack, or unlock the board. If a required domain capability is missing, reply STOP: and identify it.

${EXECUTION_GUIDE}`

// A slot owns only local conversation and scheduler state. All slots address
// the same persistent Agent Board; each queued task receives an independent
// Case Context before any task-scoped operation is sent.
const makeSlot = (key) => ({
  key,                              // sessionKey; '' is the local/default conversation
  board: agentId,                   // public Agent identity; Gateway resolves its Board
  case: undefined,                  // the currently active Case Context, if any
  messages: [],                     // 转录(**只在本机**,不上板)
  segmentTrail: [],                 // 段留痕(压缩后唯一留下来的东西)
  dischargedDigest: new Map(),      // 放电守卫: `板::节点` → 放过的 spec 版本
  lastLeaves: [],                   // 脉冲用
  lawProbed: false,                 // board governance is stable across Case Contexts
  system: SYSTEM,     // 该槽此刻念的系统提示(锁态探到就换成 SYSTEM_LOCKED 那版)
  queue: [],                        // 本槽待办(同槽 FIFO)
  busy: false,                      // 本槽是否有段在跑
  taskId: undefined,                // 在办任务号(事件标注用)
  lastUsed: Date.now(),             // LRU 用
})
const defaultSlot = makeSlot('')
// 锁态读板自述(锁合一 2026-08-03): GetBoardManifest.lawLocked=权威端真相
// (旧 GetCapabilities.lawLocked 是网关洗上去的便利标,已随便利层锁退役;老 boardd 无自述=不锁)
//
// 案板模式下探针要落在**案卷**上、且只探一次: 同一份配方开出的板锁态相同(锁来自装了什么包),
// 每单再探一遍纯属给开单成本添砖。所以这里是"首次可探时探,探过就记住"。
async function probeLawLock(ctx) {
  if (ctx.lawProbed) return
  ctx.lawProbed = true
  const mf = await board({ kind: 'GetBoardManifest' }, ctx)
  if (mf.accepted === true && mf.payload?.lawLocked === true) {
    ctx.system = SYSTEM_LOCKED
    log(`Board legislation is locked. Rules come from packages installed by the board owner; this Agent executes under them.${ctx.key === '' ? '' : ` (session ${ctx.key})`}`)
  }
}
await probeLawLock(defaultSlot)

// ── 转录压缩：滚动窗 + 段边界留痕（2026-08-06 用户裁定）────────────────────
//
// CHAT 形态下 `messages` 跨段累积、**从不裁剪**。企业里这个进程要跑一整天、办几十单,
// 撑爆是时间问题——而撑爆的形状是模型服务 400/超长计费,不是干净的报错。
//
// 走滚动窗不走摘要压缩(用户裁定): 摘要要多一次模型调用(长跑下是持续成本),而且**摘要本身会失真**,
// 失真的摘要没有板那样的诚实档可查。板才是权威记录——细节本来就该在板上,不在转录里。
// 丢掉的段各留一行痕,模型知道"之前办过这些",要细节自己发 BOARD:。
//
// **切口必须落在 user 上**: 模型线型要求首条是 user,切在 assistant/user 配对中间会 400。
const KEEP_MESSAGES = Number(process.env.RULITH_KEEP_MESSAGES ?? 24)
function compactTranscript(ctx) {
  const messages = ctx.messages
  if (messages.length <= KEEP_MESSAGES) return
  let drop = messages.length - KEEP_MESSAGES
  while (drop < messages.length && messages[drop]?.role !== 'user') drop += 1
  if (drop >= messages.length || drop <= 0) return // 切不出干净的口就不切(宁可长,不可发坏形状)
  const cut = messages.splice(0, drop)
  const trail = ctx.segmentTrail.length ? ctx.segmentTrail.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)'
  // 留痕**并进**第一条 user,不新增消息——不动角色结构,任何线型都不会因此变形
  messages[0] = {
    ...messages[0],
    content: `[Transcript compacted] ${cut.length} earlier message(s) were removed. The board remains authoritative; reply BOARD: to read it.
Earlier segments:
${trail}

───
${messages[0].content}`,
  }
  log(`Transcript compacted: dropped ${cut.length}, kept ${messages.length} message(s) and ${ctx.segmentTrail.length} segment marker(s).`)
  emitOn(ctx, 'compact', { dropped: cut.length, kept: messages.length, segments: ctx.segmentTrail.length })
}
/** 插话取件口（viz 的 pollUserMsg 在协议面的对应）。CHAT 形态由收件箱挂上；
 *  CLI 形态**故意留空**——一次办完的脚本/CI 没有第二个说话的人,给它一个空钩比给它半个功能诚实。
 *
 *  **只喂缺省槽**(2026-08-07 分槽): stdin 与 --ui 的 /say 是**一个人**在这台机器前说话,
 *  他说的话属于他自己那条对话,不属于某位远程客户的会话槽。把它散给所有槽=把本机操作者的
 *  插话注进别人的案子;随便挑一个槽=更糟(不确定注给了谁)。所以判据是"槽是不是缺省槽"。 */
let pollInterject = null

/** 办一段: 把一句用户输入推进到 DONE/STOP/轮上限。chat 形态下模型纯回话(不带 JSON)也算一段说完。
 *
 *  **一轮的拍序是命门**（viz 逐义）：提议 → 裁决 → 影子审 → 放电 → 读完成态 → 回喂。
 *  影子必须排在放电**之前**：它的缺陷主张要与主人格的叶子挤进同一次放电才接得了地，
 *  confirmed_defect 也才来得及在 certify 之前挡门。影子放最后＝永远慢一拍＝无牙。
 *
 *  Returns `{ note, caseId, pendingCaseId }`: `note` is the Board verdict or stop reason,
 *  `caseId` is the Case handled by this segment, and `pendingCaseId` is present only
 *  when that Case Context remains open. Together they distinguish a completed segment
 *  from a paused Case without inferring lifecycle state from prose. */
async function runSegment(ctx, userText) {
  const messages = ctx.messages
  compactTranscript(ctx) // 段起始先收窗——切口落在段边界最干净,不会切断本段的推理链
  const useResume = resumeCase
  resumeCase = '' // Resume applies to the first segment only.
  const caseId = useResume || ctx.taskId || nextCaseId()
  ctx.case = undefined
  const opened = await ensureCaseContext(ctx, caseId)
  if (opened === undefined) {
    const note = `Could not open Case Context "${caseId}" on Agent Board "${ctx.board}"; this task did not start.`
    log(`\n✗ ${note}`)
    emitOn(ctx, 'case-open', { board: ctx.board, caseId, ok: false })
    ctx.segmentTrail.push(`[case ${caseId} · open] ${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} → ${note}`)
    return { note, caseId, pendingCaseId: caseId }
  }
  log(`\nCase Context opened: "${caseId}" on Agent Board "${ctx.board}".`)
  emitOn(ctx, 'case-open', { board: ctx.board, caseId, ok: true })
  const proj = await projectionText(ctx)
  messages.push({ role: 'user', content: `${CHAT ? 'User message' : 'Task'}: ${userText}

Current board:
${proj}` })
  let done = false
  let note = 'in progress'
  let nudged = false // 「说了要提交却没提交」的纠偏机会,每段只给一次
  let lastRevision = await revisionNow(ctx)
  // 已完成的旧根不能替新一段收工。只有本段实际见过「未完成」之后再转为可交付，
  // 才能由板直接结束循环；Work/case 形态通常开场就是未完成，这一格防老单板误收新任务。
  const startCompletion = await completionAll(ctx)
  let sawUndeliverable = !(startCompletion.certified === true && startCompletion.allDone === true)
  for (let round = 1; round <= MAX_ROUNDS && !done; round++) {
    emitOn(ctx, 'round', { n: round })
    // 轮号**也上终端**(2026-08-18): 从前它只进事件流,于是任何按 stdout 数轮数的量具
    // (冷通枪就是一个)恒读 0 ——**读数一直在骗人**,而"0 轮通过"看着还挺好。
    log(`— Round ${round} —`)
    // 插话不打断(viz pollUserMsg 同律): 人在本段跑着的时候又说了话,当轮就进对话,不必等段跑完。
    // **只有缺省槽有这条线**: 本机操作者的话属于他自己那条对话,不属于某位远程客户的会话槽。
    const interject = ctx === defaultSlot ? pollInterject?.() : undefined
    if (interject) {
      log(`
[User interjection] ${interject}`)
      emitOn(ctx, 'user', { text: interject, interject: true })
      messages.push({ role: 'user', content: `[User] ${interject}` })
    }
    const reply = await ask(messages, ctx.system)
    const say = reply.replace(/```[\s\S]*?```/g, '').trim()
    if (say) log(`
${say.slice(0, 1200)}`)
    messages.push({ role: 'assistant', content: reply })
    const stopping = /^\s*DONE:/m.test(reply) || /^\s*STOP:/m.test(reply)
    // BOARD: = 重读全板(不受注意力预算收窄)。沿用本文件既有的**裸行标记**约定
    // (DONE:/STOP: 同族),不引第二套工具语法——JSON 数组仍然只表示"提交这批操作"。
    const wantsBoard = !stopping && /^\s*BOARD:/m.test(reply)
    const sub = stopping ? null : extractSubmission(reply)
    const ops = sub?.ops ?? null
    const cmds = sub?.cmds ?? null
    emitOn(ctx, 'propose', { say, ...(ops ? { ops } : {}), ...(cmds ? {
      cmd: cmds.map((c) => c.kind).join('+'),
      // 站中栏折叠框用的全文(与 ops 同待遇——签了什么必须看得见,args 截断防巨块)
      cmds: cmds.map((c) => ({ kind: c.kind, ...(typeof c.action === 'string' ? { action: c.action } : {}),
        ...(typeof c.target === 'string' ? { target: c.target } : {}),
        ...(c.args !== undefined ? { args: String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args)).slice(0, 200) } : {}) })),
    } : {}) })

    let feedback = ''
    if (wantsBoard) {
      feedback = `Full board:\n${await projectionText(ctx, { full: true })}`
      log('(The model requested the full board.)')
    } else if (stopping) {
      // done/stop = **请求**不是结论(viz 同律: 模型只请求,板裁决)。本轮照常走完放电与裁决,
      // 收尾那句话报板的判词——本文件第一条纪律就是「结论不是模型写的」。
      done = true
    } else if (cmds !== null) {
      // **每轮一个顶层命令**：动作结果会改变闭包与下一步可做集合，所以多步必须在每次
      // 终态回执之后重新读板。命令数组整批拒绝、零副作用；事务性多步由领域包封成一个原子动作。
      // 同步回执(2026-08-21 修)照旧: 板在 act_wait_ms 内等到受信回执会把 done/ok/result
      // 合进 payload——答案已经在手,客户端不许扔了再叫模型去等。
      if (cmds.length !== 1) {
        feedback = `Only one top-level command is allowed per turn; ${cmds.length} were received and none were executed. Split the sequence across turns, waiting for each terminal receipt and rereading the board before choosing the next command.`
        log(`Board rejected the command batch: ${feedback}`)
        emitOn(ctx, 'verdict', { accepted: false, cmd: 'command-batch', teaching: feedback })
      } else {
        const lines = []
        let succeeded = 0
        for (let ci = 0; ci < cmds.length; ci++) {
          const c = cmds[ci]
          const r = await board(c, ctx)
          const head = `${c.kind}${typeof c.action === 'string' ? ` ${c.action}` : ''}`
          if (r.accepted === true) {
            const p = r.payload ?? {}
            const inv = p.invocation ?? p.invocationId ?? ''
            const tag = inv !== '' ? ` · ${inv}` : ''
            if (p.done === true) {
              const detail = String(p.ok === true ? (p.result ?? '') : (p.reason ?? '')).slice(0, 400)
              log(`Board: ${head} ${p.ok === true ? 'completed' : 'failed'}${tag}${detail !== '' ? ` — ${detail.slice(0, 160)}` : ''}`)
              emitOn(ctx, 'verdict', { accepted: true, cmd: c.kind, done: true, ok: p.ok === true, added: (r.delta?.added ?? []).length, revision: r.revision ?? '', ...(inv !== '' ? { invocation: inv } : {}) })
              lines.push(p.ok === true
                ? `${head} completed${tag}. Worker receipt: ${detail}`
                : `${head} failed${tag}. Worker receipt: ${detail}. This is an execution failure, not a command-shape error. A retry must be a new invocation.`)
              if (p.ok === true) succeeded += 1
              else {
                if (ci < cmds.length - 1) {
                  const stopped = `Action sequence stopped: ${succeeded}/${cmds.length} completed. The previous action failed; ${cmds.length - 1 - ci} action(s) were not executed.`
                  log(`Board: ${stopped}`)
                  emitOn(ctx, 'sequence-stopped', { total: cmds.length, succeeded, reason: 'effect_failed', remaining: cmds.length - 1 - ci })
                  lines.push(`${stopped} Dependent actions cannot be issued blindly.`)
                }
                break
              }
            } else {
              log(`Board: ${head} accepted${tag}; terminal receipt pending.`)
              const terminal = await waitForTerminalActionReceipt(ctx, String(inv))
              if (terminal !== undefined) {
                const detail = terminal.detail.slice(0, 400)
                log(`Board: ${head} ${terminal.ok ? 'completed' : 'failed'}${tag}${detail !== '' ? ` — ${detail.slice(0, 160)}` : ''}`)
                emitOn(ctx, 'verdict', { accepted: true, cmd: c.kind, done: true, ok: terminal.ok, added: (r.delta?.added ?? []).length, revision: r.revision ?? '', ...(inv !== '' ? { invocation: inv } : {}) })
                lines.push(terminal.ok
                  ? `${head} completed${tag}. Worker receipt: ${detail}`
                  : `${head} failed${tag}. Worker receipt: ${detail}. This is an execution failure, not a command-shape error. A retry must be a new invocation.`)
                if (terminal.ok) succeeded += 1
                else break
                continue
              }
              emitOn(ctx, 'verdict', { accepted: true, cmd: c.kind, done: false, added: (r.delta?.added ?? []).length, revision: r.revision ?? '', ...(inv !== '' ? { invocation: inv } : {}) })
              lines.push(`${head} was accepted${tag}, but no terminal receipt landed within the local settlement window. It may be awaiting clearance or Worker pickup. Do not treat it as complete.`)
              if (ci < cmds.length - 1) {
                const stopped = `Action sequence stopped: ${succeeded}/${cmds.length} completed. The previous action has no terminal receipt; ${cmds.length - 1 - ci} action(s) were not executed.`
                log(`Board: ${stopped}`)
                emitOn(ctx, 'sequence-stopped', { total: cmds.length, succeeded, reason: 'receipt_pending', remaining: cmds.length - 1 - ci })
                lines.push(`${stopped} The synchronous barrier cannot be bypassed.`)
              }
              break
            }
          } else {
            const t = String(r.teaching ?? r.errorCode ?? '')
            log(`Board rejected ${head}: ${t.slice(0, 160)}`)
            emitOn(ctx, 'verdict', { accepted: false, cmd: c.kind, teaching: t })
            lines.push(`${head} was rejected: ${t}`)
            if (ci < cmds.length - 1) {
              lines.push(`${cmds.length - 1 - ci} remaining action(s) were not executed because the sequence stops at the first rejection.`)
            }
            break
          }
        }
        feedback = lines.join('\n')
      }
    } else if (ops === null) {
      // 对话形态: 纯回答是合法的一段(段收在这里;板上有没有活由板自己的封板闸判,不由客户端猜)。
      // **但"板上还有活"时的零提交不是纯回话**(2026-08-21 实跑撞出): 模型写完一整段计划、
      // 一个字没发——段当场收工,那一轮的活全丢,案卷空着留在「在办」。
      // 判据**问板不猜话**: 首版拿正则测「是不是冒号结尾」,那测的是散文的标点,
      // 同一个故障换成句号收尾就一次都不纠偏——**修的是那一次的样本不是那一类**;
      // 而且它违反的正是它上一行自己的注释「板上有没有活由板自己判,不由客户端猜」。
      // 一次纠偏,只一次(不许变成无限重试)。
      const boardHasWork = CHAT && !nudged && (await boardGaps(ctx)).gaps.length > 0
      if (boardHasWork) {
        nudged = true
        feedback = 'Your previous reply described a submission but included no JSON block. Submit board operations as a JSON array, or one top-level command such as ApplyAction as an object with kind. If nothing remains, reply DONE: or STOP:.'
      } else if (CHAT) { note = 'response only (no board operation)'; done = true }
      else feedback = 'No JSON submission was found. Return a JSON array for board operations, one object with kind for a top-level command such as ApplyAction, or finish with DONE: or STOP:.'
    } else {
      const r = await board({ kind: 'ApplyBatch', operations: ops }, ctx)
      if (r.accepted === true) {
        const added = (r.delta?.added ?? []).length
        log(`Board accepted ${ops.length} operation(s) · ${added} item(s) added · revision ${r.revision ?? ''}`)
        emitOn(ctx, 'verdict', { accepted: true, added, revision: r.revision ?? '' })
        // **只回增量,不回灌全板**(viz 逐义,2026-08-06 搬)。此前每轮都把整块板塞回转录:
        // 一块小探针板的投影已经 2-3.3 KB(大半是词表),真板远不止——12 轮就是十几份全板副本,
        // 而板每轮只多几条。要看全板,模型自己发 BOARD: 要(下面那件工具),那是**它的**决定。
        const warn = (r.payload?.warnings ?? []).join('\n')
        feedback = `Board accepted the batch (revision ${r.revision ?? ''}, ${added} item(s) added).${warn ? `\n${warn}` : ''}`
      } else {
        // **报错是接口**：原样回喂，不改写——板的教学比我们的转述准
        const teaching = String(r.teaching ?? r.errorCode ?? '')
        log(`Board rejected the batch: ${teaching.slice(0, 300)}`)
        emitOn(ctx, 'verdict', { accepted: false, teaching })
        feedback = `The board rejected this batch:\n${teaching}\n\nCorrect the request using that guidance and submit again.`
      }
    }

    // ③ 影子先审（板变过才审——没动过的板没有新东西可挑）
    const revAfterTool = await revisionNow(ctx)
    if (withShadow && revAfterTool !== lastRevision) await shadowReview(ctx, userText, { inline: true })
    // ① 再放电（影子的缺陷主张与主叶同一次接地）——**义务未清不放首枪**(2026-08-18 用户
    //    「经常出这个回执失败」): 树一落板就派求证,而动作还没执行,首探必红、复活律再绿——
    //    一条注定要红的探针不该在那个时刻出手。义务清空的那一刻,落定等待的空闲分支会补跑
    //    (同一拍内,晚几秒不晚一轮)。
    //    ⚠ 上一版"义务未清就扣住放电"翻过车(冷通枪 3/3→1/3: 回执永不归的动作把求证卡死):
    //    区别在这次是**拍内推迟不是硬闸**——settle 超时照常叫醒模型走轮,deliverableNow
    //    收工前仍无条件补跑一次,回执永不归时求证依然有出手机会,卡不死。
    {
      const { facts: fNow } = await boardRoots(ctx)
      if (openObligations(fNow).length === 0) feedback += await dischargePass(ctx)
    }
    // ② **在途就地结算,不烧模型轮**(用户裁 2026-08-18:「云上闭包如果包含放电,等放电结果
    //    返回后再返回结果给智能体,这样省很大空循环」)。
    //
    //    真机形状: 派出求证/查询之后,板一时没有新东西可说,模型于是一轮一轮地回
    //    「求证在途,我等等」——**每一轮都是一次完整的模型调用(整块板重发)**,三五轮就是纯烧。
    //    宿主原地等一分钱不花,所以等待归宿主,模型只在**状态真的变了**之后才被叫醒。
    //
    //    **不放进云上写命令**(用户原话是那个位置,这里是它的等价省法): 协议面的写 op 一旦
    //    阻塞在外部工人身上,没连工人就挂住;而且那是所有客户端共用的裁决面,语义会变得
    //    不确定、金样也钉不住。**贵的是模型那一轮,不是 HTTP 那一跳。**
    //
    //    只在「模型此刻确实无事可做」时等: 有缺口 ⇒ 那是模型的活,立刻叫醒它。
    let c = await completionAll(ctx)
    let { facts } = await boardRoots(ctx)
    let { gaps: gapsNow, inFlight: flightNow } = await boardGaps(ctx)
    if (!hasLiveDischargeWork(facts)) flightNow = []
    let settledBoard = ''
    if (SETTLE_WAIT_MS > 0 && c.roots.length > 0) {
      const until = Date.now() + SETTLE_WAIT_MS
      let said = false
      // 未回执动作(含 q_pending/q_snapshot 这类查询)与求证在途是同一件事: 都在等别人回话。
      //
      // **等这一轮派出去的全部尘埃落定,再一次性回给模型**(用户裁 2026-08-18)。
      //
      // 两版教训都在这一行里: ① 上一版把任何缺口都当成"模型有活干"就不等 —— 而求证在途期间
      // 板上**必然**挂着 `undone_leaf`(它是"还没验完"的同义词),于是宿主放弃等待,模型白烧
      // 三轮「BOARD: 等结果」。② 只放行"能动手的缺口"仍留了口子: 四条求证里第一条先失败就
      // 提前叫醒模型,它拿到的是**半份结果**,剩下的落地后还得再叫一轮 —— **半份结果比晚一点
      // 更贵**,模型会照着半份去改一片正在被验的叶子。
      // 所以判据只剩一句: **还有人在替它干活就等**(上限 SETTLE_WAIT_MS,工人离线不会挂死)。
      //
      // ③ **复活重探由宿主代跑**(2026-08-18 真机第五发: 求证 r1..r5 五次重试恰好烧掉第 7..12 轮,
      //    每轮全文是「BOARD: 等求证结果。」): 放电引擎裁 1a 说"补单只在下一次 RunDischarge 时
      //    发生,不自旋"——而那个"下一次"从前只挂在模型轮上,于是**每次重试都要一整个模型调用来
      //    点火**。等待期间在途一空但板未 certified,宿主自己补跑一次放电: 补出新在途就接着等,
      //    补不出(重试上限已尽/真没路)才叫醒模型。重试上限仍归放电引擎(3 次+受信效果后重置),
      //    这里只是把点火的手从模型换成宿主——**贵的是模型那一轮,不是 RunDischarge 那一跳**。
      while (Date.now() < until) {
        if (flightNow.length === 0 && openObligations(facts).length === 0) {
          if (c.certified === true || c.roots.length === 0) break
          const armed = await dischargePass(ctx)
          ;({ facts } = await boardRoots(ctx))
          ;({ gaps: gapsNow, inFlight: flightNow } = await boardGaps(ctx))
          if (!hasLiveDischargeWork(facts)) flightNow = []
          if (flightNow.length === 0 && openObligations(facts).length === 0) {
            // **重探退避窗内宿主替模型把窗睡掉**(2026-08-23 与板侧退避同批): 板明说
            // "过 Ns 再来",此刻叫醒模型它也无事可做——那正是"每次重试烧一整轮"的老坑。
            // 窗过再补一发放电;真没路(缺口不带窗)才叫模型。
            const bo = gapsNow
              .map((g) => String(g.reason ?? '').match(/退避窗\(还剩约 (\d+)s\)|backoff window \(about (\d+)s/))
              .find(Boolean)
            if (bo && Date.now() < until) {
              const waitS = Math.min(Number(bo[1] ?? bo[2] ?? 5) + 1, Math.max(1, Math.ceil((until - Date.now()) / 1000)))
              if (!said) { log('◌ Waiting locally for verification and receipts; no model turn is being consumed.'); said = true }
              await new Promise((r) => setTimeout(r, waitS * 1000))
              continue
            }
            break // 补不出新在途且无退避窗=没人可替它干活了,该模型上
          }
          feedback += armed
          continue
        }
        if (!said) { log('◌ Waiting locally for verification and receipts; no model turn is being consumed.'); said = true }
        await new Promise((r) => setTimeout(r, 2000))
        c = await completionAll(ctx)
        ;({ facts } = await boardRoots(ctx))
        ;({ gaps: gapsNow, inFlight: flightNow } = await boardGaps(ctx))
        if (!hasLiveDischargeWork(facts)) flightNow = []
        // **收口判据=三合一**(2026-08-18 两发对撞后的终形): ① 只看 certified 提前 break
        // ——求证先转绿而动作还压在闸下,模型被提前叫醒白烧两轮(「同一拍」裁决);
        // ② 干脆不 break——板在 certified 后还挂着一条陈旧 work-ordered 缺口行,
        // busy 循环靠它恒判"在途",每轮把 60s 窗等满(427 真机: 两个整窗+多烧一轮)。
        // 所以: certified 且没活了且**义务清了**才 break——同一拍不破,陈旧行不拖窗。
        if (c.certified === true && c.allDone === true && openObligations(facts).length === 0) break
      }
      if (said) {
        log(`◌ Settlement complete (certified=${c.certified} · ${c.state}). The next model turn receives the landed result.`)
        // **等完就把板面一起端上去**(2026-08-18 用户看站输出第三发): 真机里模型在结算之后
        // 连回两轮 `BOARD:` —— 每一轮都是一次完整的模型调用而产出为零,**而那是我们自己教的**
        // (「回一行 BOARD: 看着就行」)。宿主既然已经替它等了,落定的板面就该直接给它:
        // 它要的东西我们手上就有,让它花一轮来要,等于把省下的空转又还回去。
        settledBoard = await projectionText(ctx)
      }
    }
    // 完成态**上终端**给人看(不是喂模型的教学: 模型看板自己的投影与回执)
    if (c.roots.length > 0) log(`[Completion] certified=${c.certified} floor=${c.floor} ${c.state}`)
    emitOn(ctx, 'board', { certified: c.certified, floor: c.floor, state: c.state, breached: c.breached })

    if (!(c.certified === true && c.allDone === true)) sawUndeliverable = true
    // 完成是板的裁决，不需要模型再说一遍 DONE。动作/清关/求证全清后由宿主直接收工，
    // 省掉真机里那轮 `BOARD: 等待…` 和紧随其后的 `DONE:` 两次完整模型调用。
    if (!done && sawUndeliverable && c.certified === true && c.allDone === true && openObligations(facts).length === 0) {
      done = true
      log('The board marked the case deliverable and all obligations are clear. The host is completing without another model turn.')
      emitOn(ctx, 'auto-complete', { certified: true, floor: c.floor, state: c.state })
    }

    if (done) {
      note = c.certified
        ? `Board certified the case as deliverable (floor=${c.floor}).`
        : c.roots.length === 0 ? 'Response only; no task tree exists on the board.' : `The model stopped, but the board did not certify the case (floor=${c.floor} · ${c.state}).`
      break
    }

    // 轮的上限只剩 MAX_ROUNDS 一个(2026-08-18 拆补丁: 早停判据被"等在途不算空转"改过一轮又一轮,
    // 那是客户端在猜"模型是不是卡住了"——板不会卡住,它每轮都如实说自己的状态;烧不烧得起是预算问题,
    // 归 MAX_ROUNDS 一条线管,不需要第二个会猜错的判据)。
    lastRevision = await revisionNow(ctx)
    // 结算过就把落定的板面一起端上（省掉模型那一轮 `BOARD:` 的要价）。
    messages.push({ role: 'user', content: `[Result] ${feedback}\n[Completion] certified=${c.certified} floor=${c.floor} ${c.state}`
      + (settledBoard !== '' ? `\n\nCurrent landed board state:\n${settledBoard}` : '')
      + `\n\nContinue, or finish with DONE:.` })
  }
  if (note === 'in progress') { note = `Stopped at the ${MAX_ROUNDS}-round limit.`; log(`
⚠ ${note} Increase RULITH_MAX_ROUNDS only after reviewing why the workflow did not converge.`) }
  // 影子人格(--shadow): 段尾对抗审阅——同一智能体的内外人格,板侧防篡改机制(CD 钉等)天然在。
  // **抗议的牙齿 = 拦下本段的收尾动作**: 单板长跑形态拦的是自动归档,案板形态拦的是**封板**。
  // 同一条纪律的两个投影: 影子有异议的活不算收尾,板上留着,人与主人格都看得见。
  const shadowClear = !withShadow || await shadowReview(ctx, userText)
  let pendingCaseId = caseId
  if (!shadowClear) {
    log('Shadow review raised a finding. The Case Context remains open and the shadow_finding is on the Board.')
  } else {
    const { deliverable, why } = await deliverableNow(ctx)
    if (deliverable && await archiveCaseContext(ctx, 'completed')) pendingCaseId = null
    else {
      log(`\nCase "${caseId}" remains open: ${why}.\n   Stopping is not completion. Resume with --case ${caseId}, or close it explicitly through the Case lifecycle API.`)
      emitOn(ctx, 'case-pending', { board: ctx.board, caseId, reason: why, note })
    }
  }
  ctx.segmentTrail.push(`[case ${caseId}${pendingCaseId === null ? '' : ' · open'}] ${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} → ${note}`)
  if (ctx.segmentTrail.length > 40) ctx.segmentTrail.splice(0, ctx.segmentTrail.length - 40) // 留痕本身也要有上界
  return { note, caseId, pendingCaseId }
}

/** 影子审阅: 对抗立场读板与本段经过,专挑真缺陷。发现→落板 shadow_finding + 返回 false(拦归档)。
 *  审不出问题回 PASS。影子**只能落异议事实,不能改主人格写的任何东西**——它是审的,不是改的。
 *
 *  两个时机（viz 逐义，2026-08-06 补上第一个）：
 *    - `inline`（每轮，板变过才跑）——**牙齿在这里**：异议落板后紧接着就是同一轮的放电，
 *      影子的缺陷主张与主人格的叶子一起接地，confirmed_defect 赶得上在 certify 之前挡门。
 *    - 段尾【关门审计】——最后一道,牙齿是拦下本段自动归档:有异议的活不算收尾,板上留着。
 *  只有段尾那次的返回值被用来拦归档;inline 那次不拦(它靠板机制生效,不靠流程分支)。 */
async function shadowReview(ctx, userText, opts = {}) {
  const proj = await projectionText(ctx)
  const verdict = await ask(
    [{ role: 'user', content: `Completed segment: ${userText}\n\nCurrent board:\n${proj}` }],
    `You are the Agent's adversarial shadow reviewer. Assume the primary Agent may be wrong and identify only concrete defects:
- Is every conclusion actually supported? Are values abnormal, sources doubtful, or expected materials missing?
- Did claims that require verification go through a trusted computation or source, or were they merely stated?
- Is unfinished work being presented as complete?
Do not invent criticism. If no issue is substantiated, reply with exactly PASS.
Otherwise return at most three lines, each formatted FINDING: <one precise issue with a node or value>.`,
    SHADOW_CFG,
  )
  const findings = verdict.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('FINDING:')).slice(0, 3)
  const tag = opts.inline ? '◆ Shadow review (inline)' : '◆ Shadow review (final)'
  if (findings.length === 0) { log(`${tag}: PASS`); emitOn(ctx, 'shadow', { pass: true, inline: opts.inline === true }); return true }
  for (const f of findings) log(`${tag}: ${f.slice(0, 200)}`)
  emitOn(ctx, 'shadow', { pass: false, findings, inline: opts.inline === true })
  // 异议落板(asserted 档如实——影子的话也是话,不是证据;它的作用是可见与拦归档)
  const ops = findings.map((f, i) => ({
    op: 'assert_fact', id: `SF_${Date.now().toString(36)}_${i}`,
    predicate: 'shadow_finding', args: { text: f.slice(9, 240).trim() },
  }))
  const r = await board({ kind: 'ApplyBatch', operations: ops }, ctx)
  if (r.accepted !== true) log(`◆ Board rejected the shadow finding: ${String(r.teaching ?? '').slice(0, 120)}`)
  return false
}

if (SERVE) {
  // ── 接单脑(批7 起,2026-08-07 分槽): 回环收单 → **按槽**跑 → 结果留内存环形队列 ──
  //
  // 这是「网站后端可直接嵌的无人值守闭环」的最小形态: 它不读 stdin、不弹界面,
  // 只把 **runSegment** 这一个循环挂到一个 HTTP 口上。前面那些器官(开单/放电/影子/封板/
  // 身份板)一行都不改——接单脑只负责**排队、分槽与留痕**,不负责办事。
  //
  // **同槽恒串行,跨槽按 SERVE_CONCURRENCY 并行**。旧门牌写的是"并发恒为 1",前提是四处
  // 进程级单例(尤其 messages 转录);那四处已全部入槽(见 makeSlot),前提失效 ⇒ 裁决作废。
  // 留下来的那半条仍然成立: **一个客户的两单不能织进同一条转录**,所以每槽自己一条 FIFO。
  const wantedConcurrency = Number(process.env.RULITH_SERVE_CONCURRENCY ?? 1)
  // 上限 8 是**保守的闸不是测出来的极限**: 每个并行段都在烧模型配额与云上写配额,
  // 一个手滑的 =200 会把这两样同时打爆,而爆的形状是 429/超时,不是干净的报错。
  // 要更高的并发,形态仍是多开进程(那样每个进程的资源账是分开的)。
  const SERVE_CONCURRENCY = !Number.isFinite(wantedConcurrency) || wantedConcurrency < 1
    ? 1 : Math.min(8, Math.floor(wantedConcurrency))
  if (Number.isFinite(wantedConcurrency) && Math.floor(wantedConcurrency) > 8) {
    console.error(`⚠ RULITH_SERVE_CONCURRENCY=${wantedConcurrency} exceeds the supported maximum and was clamped to 8.
   Cross-slot concurrency is real, but every slot consumes model and Cloud capacity. Eight is a conservative guardrail, not a measured limit. Run additional processes for higher concurrency.`)
  }

  const runs = []       // 环形队列: 最近 SERVE_RUNS_MAX 条(内存里的东西必须有上界)
  // 在跑的段(按开跑先后),`inFlight.length` 即跨槽并发数,上界 = SERVE_CONCURRENCY。
  // 它同时是 /runs 快照里 running/runningAll 的来源——**一份状态一处存**。
  const inFlight = []
  const pushRun = (r) => { runs.push(r); while (runs.length > SERVE_RUNS_MAX) runs.shift() }

  // Session slots isolate local transcripts and queues. They do not create Boards:
  // every slot opens Case Contexts on the same persistent Agent Board.
  const sessions = new Map()
  const evictIfNeeded = () => {
    while (sessions.size >= SERVE_SLOTS_MAX) {
      let victim
      for (const [k, s] of sessions) { if (!s.busy && s.queue.length === 0) { victim = k; break } }
      if (victim === undefined) {
        // 全都在忙: 这时候硬驱逐等于打断一位客户办到一半的段。**如实超一格**并说出来——
        // 闲下来的那一刻下一次准入就会把它收回去(稳态仍有界)。
        log(`All ${SERVE_SLOTS_MAX} session slots are busy. Temporarily admitting slot ${sessions.size + 1}; the next idle slot will be reclaimed.`)
        return
      }
      sessions.delete(victim)
      log(`Evicted least-recently-used idle session "${victim}" at the ${SERVE_SLOTS_MAX}-slot limit. Only its local transcript was released.`)
      emit('slot-evicted', { session: victim, slots: sessions.size })
    }
  }
  const slotFor = (sessionKey) => {
    if (sessionKey === '') return defaultSlot
    const hit = sessions.get(sessionKey)
    if (hit !== undefined) {
      sessions.delete(sessionKey); sessions.set(sessionKey, hit) // LRU: 命中即挪到队尾
      hit.lastUsed = Date.now()
      return hit
    }
    evictIfNeeded()
    const slot = makeSlot(sessionKey)
    sessions.set(sessionKey, slot)
    log(`Opened session "${sessionKey}" (${sessions.size}/${SERVE_SLOTS_MAX} slots).`)
    emit('slot-open', { session: sessionKey, slots: sessions.size })
    return slot
  }

  // 门与 --ui 同律同码: 随机钥(头或 query) + Origin/Host 只认本机 + 只收 JSON 封顶 64KB。
  const serveGate = (req) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = req.headers['x-rulith-serve'] ?? url.searchParams.get('k') ?? ''
    if (key !== SERVE_KEY) return 'Missing or invalid task key. Use the startup key in the x-rulith-serve header, or ?k= for SSE.'
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return `Cross-origin request rejected (Origin: ${origin}). The task endpoint accepts local origins only.`
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return `Non-local Host rejected (${host}) to prevent DNS rebinding.`
    return null
  }
  /** 全体槽(缺省槽在前,会话槽按 LRU 顺序在后)——排队/调度/快照都读这一个视图。 */
  const allSlots = () => [defaultSlot, ...sessions.values()]
  const snapshot = () => ({
    ok: true, agentId, url: URL_BASE,
    concurrency: SERVE_CONCURRENCY,
    slotsMax: SERVE_SLOTS_MAX, sessions: sessions.size,
    // `running`: **单条或 null**——批7 的形状,调用方与既有回归网都按它读。并发之后它是
    // "最早开跑的那一条";全部在跑的看 `runningAll`(不改旧字段语义 = 不悄悄换合同)。
    running: inFlight[0] ?? null,
    runningAll: inFlight.slice(),
    queued: allSlots().flatMap((s) => s.queue.map((q) => ({ id: q.id, text: q.text, at: q.at, ...(s.key === '' ? {} : { sessionKey: s.key }) }))),
    runs: runs.slice(-SERVE_RUNS_MAX),
  })

  const serveSrv = http.createServer((req, res) => {
    const deny = (why, status = 403) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, teaching: why }))
    }
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'POST' && path === '/task') {
      const bad = serveGate(req)
      if (bad !== null) return deny(bad)
      const ct = String(req.headers['content-type'] ?? '')
      if (!ct.startsWith('application/json')) return deny('Only application/json is accepted; plain-text bodies can bypass browser preflight checks.')
      // 按字节收、收完再解码（同 /say）：逐块拼字符串会把跨块的多字节字符切坏。
      const bodyChunks = []
      let size = 0
      let over = false
      req.on('data', (c) => { size += c.length; if (size > UI_MAX_BODY) { over = true; req.destroy(); return } bodyChunks.push(c) })
      req.on('end', () => {
        if (over) return deny('Request body exceeds 64KB.')
        const raw = Buffer.concat(bodyChunks).toString('utf8')
        let text = ''
        let sessionKey = ''
        try {
          const b = JSON.parse(raw || '{}')
          text = String(b.text ?? '').trim()
          sessionKey = String(b.sessionKey ?? '').trim()
        } catch { return deny('Body is not valid JSON. Expected {"text":"...","sessionKey":"optional"}.') }
        if (text === '') return deny('Missing text. Expected {"text":"process this task"}.', 400)
        // Session keys select bounded local transcript/queue slots. They never select a Board.
        if (sessionKey.length > SESSION_KEY_MAX) {
          return deny(`sessionKey exceeds ${SESSION_KEY_MAX} characters (${sessionKey.length} received). It cannot be truncated because it identifies a local conversation slot. Use a short opaque identifier.`, 400)
        }
        const slot = slotFor(sessionKey)
        const item = { id: nextCaseId(), text, at: Date.now(), sessionKey }
        slot.queue.push(item)
        slot.lastUsed = item.at
        const depth = allSlots().reduce((n, s) => n + s.queue.length, 0)
        emit('task-queued', { id: item.id, text: item.text, depth,
          ...(sessionKey === '' ? {} : { session: sessionKey }) })
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, id: item.id, queued: depth,
          ...(sessionKey === '' ? {} : { sessionKey }),
          teaching: 'Queued. Read GET /runs?k=<key>, or add &stream=1 for SSE.' }))
        pump()
      })
      return
    }
    if (path === '/runs') {
      const bad = serveGate(req)
      if (bad !== null) return deny(bad)
      const wantsStream = new URL(req.url, 'http://127.0.0.1').searchParams.get('stream') === '1'
        || String(req.headers.accept ?? '').includes('text/event-stream')
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return void res.end(JSON.stringify(snapshot()))
      }
      // SSE: 与 --ui 的 /events 是**同一条事件流**(晚开补看全史)——两张脸不各写一套时间线
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    return deny('Available endpoints: POST /task {"text":"...","sessionKey":"optional"} and GET /runs?k=<key> (add &stream=1 for SSE).', 404)
  })
  await new Promise((r) => serveSrv.listen(SERVE_PORT, '127.0.0.1', r))
  log(`
Task endpoint ready (serial within a session · ${SERVE_CONCURRENCY} concurrent Case Context(s) · ${SERVE_SLOTS_MAX} session limit): http://127.0.0.1:${SERVE_PORT}
  Submit: curl -s -XPOST http://127.0.0.1:${SERVE_PORT}/task -H 'content-type: application/json' -H 'x-rulith-serve: ${SERVE_KEY}' -d '{"text":"…"}'
  Optional session: -d '{"text":"…","sessionKey":"conversation-1"}'
  Every task receives its own Case Context on Agent Board "${agentId}". Sessions only isolate local transcripts and queues.
  Inspect: curl -s 'http://127.0.0.1:${SERVE_PORT}/runs?k=${SERVE_KEY}'
  The key is randomized on every start. Loopback alone is not an authorization boundary.`)
  emit('start', { agentId, url: URL_BASE, task: '(task endpoint)', projection: '', concurrency: SERVE_CONCURRENCY })

  /** 办一单(某个槽的队首)。**同槽恒串行**由 `slot.busy` 保证,跨槽由 `inFlight` 的长度封顶。 */
  async function runOne(slot) {
    const item = slot.queue.shift()
    if (item === undefined) return
    slot.busy = true
    slot.lastUsed = Date.now()
    slot.taskId = item.id
    const flight = { id: item.id, text: item.text, startedAt: Date.now(),
      ...(slot.key === '' ? {} : { sessionKey: slot.key }) }
    inFlight.push(flight)
    emit('task-start', { id: item.id, text: item.text,
      ...(slot.key === '' ? {} : { session: slot.key }) })
    log(`
▶ Case ${item.id}${slot.key === '' ? '' : ` (session ${slot.key})`}: ${item.text}`)
    let note = ''
    let pendingCaseId = null
    try {
      const seg = await runSegment(slot, item.text)
      note = seg.note
      pendingCaseId = seg.pendingCaseId
    } catch (e) {
      // 一单办炸**不许掀翻整个队列**: 如实记档,接着办下一单(无人值守的第一要务是活着)
      note = `Task aborted with an unexpected error: ${e?.message ?? e}`
      pendingCaseId = slot.case?.id ?? item.id
      log(`✗ ${note}`)
    } finally {
      // 清账落 **finally**: 上面任何一处炸了都不许把这个槽永久钉成 busy——那位客户从此再也
      // 办不了单,而症状是"投单回 202、结果永远不来",没有一行日志说得清为什么。
      const at = inFlight.indexOf(flight)
      if (at >= 0) inFlight.splice(at, 1)
      slot.busy = false
      slot.taskId = undefined
      slot.lastUsed = Date.now()
    }
    const rec = {
      id: item.id, text: item.text, at: item.at,
      startedAt: flight.startedAt, endedAt: Date.now(), note,
      board: slot.board,
      caseId: item.id,
      ...(slot.key === '' ? {} : { sessionKey: slot.key }),
      // 未结的案号进 run 记录: 调用方(网站后端)据它决定"要不要接着办 / 要不要报给人",
      // 只给一句 note 的话,"停轮"与"办结"在机器眼里长得一模一样。
      ...(pendingCaseId === null ? {} : { pendingCaseId }),
      console: consoleUrl,
    }
    pushRun(rec)
    emit('task-done', rec)
    log(`· ${note}${pendingLine(pendingCaseId)} · Verify in Console: ${rec.console}
`)
  }
  // 泵(槽感知调度): 扫一遍槽,把**空闲且有排队**的槽开起来,直到跨槽并发到顶。
  // 段是 async 的,这里**不 await**——await 一条就等于把并发压回 1。每条办完再泵一次,
  // 于是"有空位就立刻开下一条"这件事不需要定时器。
  function pump() {
    for (const slot of allSlots()) {
      if (inFlight.length >= SERVE_CONCURRENCY) return
      if (slot.busy || slot.queue.length === 0) continue
      // `.catch` 不是装饰: node 里一个没接住的 rejection 会**结束进程**,而无人值守形态下
      // 那等于整台服务因为某一单的意外而下线。runOne 自己已经把办事那段包严了,这一层兜的是
      // 它之外(记档/发事件)万一出的岔子。
      void runOne(slot)
        .catch((e) => log(`✗ Scheduler error; the queue will continue: ${e?.message ?? e}`))
        .finally(pump)
    }
  }
  // 带任务参数启动 = 第一单已经在手上(脚本可以"起进程即办一单,之后接着收单")。
  // 它没有 sessionKey,所以进缺省槽——与从前一字不差。
  if (TASK !== '') { defaultSlot.queue.push({ id: nextCaseId(), text: TASK, at: Date.now(), sessionKey: '' }); pump() }
} else if (!CHAT) {
  // ── 一次办完(CI/脚本形态,行为不变) ──
  log(`Task: ${TASK}
`)
  emit('start', { agentId, url: URL_BASE, task: TASK, projection: '' })
  const { note, caseId, pendingCaseId } = await runSegment(defaultSlot, TASK)
  // A closed or rejected Case has no active execution envelope. Do not fall back
  // to an unscoped Agent Board read: the Console case record is the authority.
  const after = pendingCaseId !== null && defaultSlot.case?.id === pendingCaseId
    ? await projectionText(defaultSlot)
    : ''
  const seen = consoleUrl
  log('\n──────── Final authoritative board state ────────')
  log(after === '' ? '(Case Context is not active; inspect its record in Console.)' : after)
  if (pendingCaseId !== null) log(`⚠ This case remains open: pending_case_id=${pendingCaseId}. Resume with --case ${pendingCaseId}, or resolve it in Console.`)
  log(`
Verify the task tree, work items, and conclusions in Console: ${seen}
`)
  emit('end', {
    ok: pendingCaseId === null && note.startsWith('Board certified the case as deliverable'),
    note,
    caseId,
    board: defaultSlot.board,
    projection: after,
    console: seen,
    ...(pendingCaseId === null ? {} : { pendingCaseId }),
  })
  if (withUi) log(`The local timeline remains available at http://127.0.0.1:${UI_PORT}. Press Ctrl+C to exit.`)
  else process.exit(0)
} else {
  // ── 多轮对话(桌面主形态,2026-08-01): **REPL 进程是本体,界面是可插拔的脸**——
  //    终端(人敲)、管道(脚本/别的智能体把它当子进程)、浏览器/GUI(--ui: SSE /events 出 + POST /say 进)
  //    全部汇入同一个收件箱、驱动同一个循环。嵌进别的应用=接管这两条流,不必改本体。
  const inbox = []
  let wake = null
  let stdinOpen = true
  const pushInput = (text) => {
    const t = String(text ?? '').trim()
    if (t === '') return
    inbox.push(t)
    if (wake) { const w = wake; wake = null; w() }
  }
  const nextInput = async () => {
    for (;;) {
      if (inbox.length > 0) return inbox.shift()
      // stdin 关了(管道用完)且没有别的脸在喂 → 如实收工,不是炸(ERR_USE_AFTER_CLOSE 真机踩过)
      if (!stdinOpen && !withUi) return null
      await new Promise((r) => { wake = r })
    }
  }
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (l) => pushInput(l))
  rl.on('close', () => { stdinOpen = false; if (wake) { const w = wake; wake = null; w() } })
  if (withUi) uiInput = pushInput // 浏览器脸的输入面挂进来(POST /say)
  // 插话不打断: 段跑着的时候来的话,当轮就进对话——不必排队等本段跑完(viz 逐义)。
  // 取自**同一个收件箱**,所以终端/管道/浏览器三张脸都自动获得这个能力,无需各自接线。
  //
  // **水位线是命门**(2026-08-06 真机第一次跑就撞): 收件箱里本来就排着的行是**下一段**,
  // 不是插话。不设水位线直接 shift(),管道喂三行会被吞成一段——`printf '一\n二\nexit\n'`
  // 里的"二"当场被当成"一"的插话。判据是**到达时刻**: 只有段开跑之后才进来的才算插话。
  let queuedAtSegmentStart = 0
  pollInterject = () => (inbox.length > queuedAtSegmentStart ? inbox.splice(queuedAtSegmentStart, 1)[0] : undefined)

  log(`Interactive mode. Every message opens a Case Context on Agent Board "${defaultSlot.board}". Verify Cases and conclusions in Console: ${consoleUrl}`)
  log('The transcript stays on this machine and is not written to the board. Empty lines are ignored. Use exit, quit, or Ctrl+C to stop.\n')
  emit('start', { agentId, url: URL_BASE, task: '(interactive)', projection: '' })
  for (;;) {
    if (inbox.length === 0 && (stdinOpen || withUi)) process.stdout.write('You> ')
    const line = await nextInput()
    if (line === null) break
    if (line === 'exit' || line === 'quit') break
    emit('user', { text: line }) // 每张脸都看得到谁问了什么(晚开的浏览器也补得到)
    queuedAtSegmentStart = inbox.length // 水位线: 此刻排着的都是「下一段」,之后到的才是插话
    const { note, caseId, pendingCaseId } = await runSegment(defaultSlot, line)
    emit('segment-end', { note, board: defaultSlot.board, caseId, ...(pendingCaseId === null ? {} : { pendingCaseId }) })
    log(`
· ${note}${pendingLine(pendingCaseId)} · Verify in Console: ${consoleUrl}
`)
  }
  rl.close()
  log('Stopped.')
  process.exit(0)
}
