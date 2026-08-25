#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * rulith-agent —— 独立智能体（纯协议客户端形态）。
 *
 * 它是「脑」：拿一句话任务，连上 rulith cloud，自己跑**提议 → 裁决 → 教学回流**的循环，
 * 直到板上长出带依据的结论。手（工具执行）归 rulith-worker，配置与审计归控制台。
 *
 *   模型提出材料、规则、动作 → 板裁决（推得出才成立、算不准就失败、越界就拦）
 *   → 板的教学报错原样回喂模型 → 模型改 → 再提。
 *
 * 三件不变的纪律（写在这里，因为它们正是这个循环的意义）：
 *   1. **结论不是模型写的**——模型只能提材料与规则，结论由板推。它想直接断言结论，板会拒。
 *   2. **报错是接口**——板的每一次拒绝都带教学文本，原样回喂比我们改写更有用。
 *   3. **模型钥匙不出你的机器**——本进程直连你的模型服务；云上只收板命令，看不到你的 key。
 *
 * 一轮的拍序（2026-08-06 起与 viz 那套循环同形，全部走云协议 op）：
 *   提议 → 板裁决 → **影子随拍审** → **自动放电** → **读完成态** → 回喂
 *   影子必须在放电之前：它的缺陷主张要与主人格的叶子挤进同一次放电才接得了地，
 *   confirmed_defect 也才来得及在 certify 之前挡门。影子放最后＝永远慢一拍＝无牙。
 *   段尾另有一次【关门审计】，牙齿是拦下自动归档。
 *   **手不在这里**：actuate（执行器收据面）归 rulith-worker——提议方与执行方合成一个人，
 *   正是收据面要拆开的东西。
 *
 * 板的两种寿命（2026-08-07 起，法源=核心仓 docs/specs/case-board-upgrade-guide.md CB-30「段→单」）：
 *   **单板长跑（缺省，存量零迁移）**——一块板一直用下去，段尾 `autoArchive()` 把可交付的根归档清台面。
 *   **一单一板（`--case-boards` 开）**——每接一段就是一单：段首 **开单**（一发 CreateBoard：
 *     板名=案号，配方构成随 recipe.packs 由宿主在建板事务内装入——初始化物化，2026-08-14 裁；
 *     播种目标随后），段尾 **封板**（SealBoard 结案：封后写一律
 *     教学拒、读照常、重复封板幂等）。**开单序列＝配方函数**：配方（包清单 + 播种操作）从
 *     `--recipe <file.json>` / `RULITH_RECIPE` 来，同一份配方开出的板天然可比（绩效按配方×案聚合）。
 *     对话历史仍只在本机、跨段连续；段边界留痕（segmentTrail）带上案号，压缩后仍读得懂跨单来龙去脉。
 *
 *     **停轮 ≠ 结案（2026-08-07 review P0-2）**——自动封板**只在板判可交付时发生**
 *     （`certified===true` 且每个根的 `state` 真是 `done`）。模型收尾但板没判过、连轮无进展、
 *     到轮上限、板上根本没有任务树、影子有异议——**一律不封**：案卷留在「在办」，终端与
 *     `/runs` 报**案号（pending_case_id）+ 停轮原因**；带 `--case <案号>`（或 `RULITH_RESUME_CASE`）
 *     起进程即接着办那一案（已装配的板不重播种），也可以去控制台处置。
 *     此前这里只受影子异议约束，于是「宿主缺清关配置 ⇒ 案件 parked/certified=false」照样被封板
 *     并计进绩效的「已结」——**把停手记成了办结**，绩效面因此长期偏乐观。
 *     要在停轮时结掉，得**显式选择作废**：`RULITH_SEAL_ON_STOP=cancelled|failed|abandoned`
 *     （配了才封，且封板带的是这个处置，不是 `completed`——不许把停手说成办结）。
 *
 * 两张脸（2026-08-01 起这是桌面主形态——板务查看归控制台，对话归本机，壳退位）：
 *   **REPL（不带任务参数）**——多轮对话，终端即界面：
 *     RULITH_TOKEN=<控制台「接入与凭证」页生成> ANTHROPIC_API_KEY=<你的模型 key> node rulith-agent.mjs --agent orders
 *   **CLI（带任务参数）**——一次办完退出，适合脚本/CI（行为与从前完全一致）：
 *     node rulith-agent.mjs --agent orders "处理所有未处理订单并发货"
 *   经管道驱动同样通（别的程序/智能体可以直接把它当子进程开——stdin/stdout 即接口）。
 *   对话记录只在本机，**不上板**（RecordChat 已弃用：对话是脑的私事，板记录公务）。
 *   模型服务兼容两种线型：Anthropic 官方（缺省）与 OpenAI 风格（RULITH_MODEL_URL 以
 *   /chat/completions 结尾即自动识别——deepseek/qwen 等都是这个形状）。
 *
 * 三张脸之外的第四种形态 —— **--serve（接单脑，无人值守闭环）**：
 *   不读 stdin、不弹界面，只在回环上挂一个**收单口**：网站后端把一句话任务 POST 进来，
 *   它排队、按槽办完，结果留在内存环形队列里等你取。这是「rulith 当后端」的最小形态:
 *     POST /task  {"text":"…","sessionKey":"可选"} 带 `x-rulith-serve: <钥>` → 202 {ok,id,queued}
 *     GET  /runs?k=<钥>                                   → JSON 快照(队列 + 最近 N 条结果)
 *     GET  /runs?k=<钥>&stream=1                          → SSE(与 --ui 的 /events 同一条事件流)
 *   门与 --ui **同律同码**(随机钥 + Origin/Host 只认本机 + 只收 JSON 封顶 64KB)——回环不是边界。
 *   钥每次启动随机,打印在终端;`RULITH_SERVE_PORT` 改口(缺省 7799)。
 *
 *   **一客一板(服务板)——板的第三种寿命**(2026-08-07 用户裁决,与①长命单板 ②一单一板并列):
 *   `sessionKey` 带上就进**该 key 的会话槽**: 板名从 key 确定性推导(slug + 短哈希尾),
 *   find-or-create,**长命几个月不封板**——服务商是 owner,一个客户一块板。段尾走的是单板长跑
 *   那套 `autoArchive()`(可交付的根归档),**不是封板**: 板与这份服务同寿,封了就是把客户关系写死。
 *   不带 sessionKey 的任务进**缺省槽**,行为与从前一字不差(CASE_BOARDS 开则每单开案封板,否则单板长跑)。
 *
 *   **并发: 同槽恒串行,跨槽真并发**(`RULITH_SERVE_CONCURRENCY`,缺省 1,上限 clamp 到 8)。
 *   从前这里钉的是"恒为 1",前提是本进程有四处**进程级**单例(currentBoard 板寻址口 / messages 转录 /
 *   dischargedDigest+lastLeaves 放电守卫 / lawProbed+segmentTrail),其中转录那一处被判"修不掉"。
 *   分槽之后这四处**全部入槽**(每槽自己的板、自己的转录、自己的放电守卫与段留痕),
 *   旧前提失效 ⇒ 按门牌纪律那条裁决自动作废。**同槽仍恒串行**(一个客户的两单织进一条转录
 *   才是那条命门的真形状)。要**完全隔离**(独立进程内存/独立钥/独立端口)仍是多开进程。
 *   槽本身有上界: `RULITH_SERVE_SLOTS_MAX`(缺省 64,只数会话槽)LRU 驱逐**闲置**槽——
 *   驱逐丢的是内存转录,板在服务端 journal 里一个字不丢,该 key 再来单会重建槽、重读板。
 *
 * 跨案连续性（2026-08-07 收敛：身份板实现已整件删除，理由见本文件「跨案连续性」那块门牌）：
 *   · **身份** = 配方指纹——建板时 `CreateBoard{recipe:{id,digest}}`，host 落 genesis 受信事实
 *     (核心 board-spec BRD-112)。"这一案是哪个智能体按哪版配方办的"从案卷本身答得出。
 *   · **配方** 的权威在云上包簿：缺省向网关取 `GET /agent/v1/recipe?agent=<名>`；
 *     `--recipe <file>` 是**离线/自建部署**的备用形态（显式给了就用它，不去云上抢）。
 *   · **承诺** = 长命板(BRD-113)——服务槽的服务板就是它的键法之一，本来就长命、本来就按客户隔离。
 *   · **结论** = `recallFacts` 同 Authority 显式召回（接地档保真），不是裸断言。
 *
 * --ui 加开本机页面（http://127.0.0.1:7788，只监听回环）。**嵌入合同**（GUI/浏览器接管本体的全部约定）：
 *   GET /events?k=<钥> = 输出（SSE，晚开补看全史）· POST /say {"text":…} 带 x-rulith-ui: <钥> = 输入。
 *   钥每次启动随机生成，打印在终端、也已嵌进本机页面；**只监听回环不等于有门**——任何你访问的网页
 *   都能向 127.0.0.1 发简单请求，没有这把钥它就能盲注任务给一个有板写权限的智能体（Codex review P1）。
 *   REPL 进程是本体，界面全是可插拔的脸——嵌进任何应用都不必改本体（脸只要带上这把钥）。
 *
 * 可选 env：
 *   RULITH_URL        云端地址（缺省 https://api.rulith.com）
 *   RULITH_MODEL      模型名（缺省 claude-sonnet-5）
 *   RULITH_MODEL_URL  模型服务地址（缺省 https://api.anthropic.com/v1/messages）
 *   RULITH_MAX_ROUNDS 最多几轮（缺省 12——防跑飞，到顶如实说明并停）
 *   RULITH_UI_PORT    界面端口（缺省 7788）
 *   RULITH_UI_OPEN    off = 只起界面服务不弹浏览器（无头/嵌入/自动化）
 *   RULITH_CASE_BOARDS  on = 一单一板（等价于 --case-boards；缺省关＝单板长跑）
 *   RULITH_RECIPE     配方文件路径（等价于 --recipe；只在案板模式生效）
 *   RULITH_CASE_PREFIX 案号前缀（缺省＝智能体名）
 *   RULITH_RESUME_CASE 续办既有案号（等价于 --case；只作用于第一段,之后照常每段开新案）
 *   RULITH_ALLOW_BARE_BOARD on = 取不到配方时允许开裸板（实验/自测用）。**缺省不放行**——
 *                     裸板没有宪法门,静默开出来是"配置没生效"最难查的一种形状
 *   RULITH_CASE_LAW_LOCK on = 开案末步给案板上锁（`law_locked`）：案内 add_axiom/define_action/
 *                     RegisterPack 一律教学拒 ⇒ **配方＝本案全部法源**，genesis 指纹从"自称按哪份
 *                     配方开"变成"本案的完整法故事"。摘锁要治理角色（控制台），模型自己摘不掉。
 *                     **缺省不锁**——模型提案规则是演算板的产品本义，且洗绿已被接地档 MIN/
 *                     门只数受信/CA 钉防死；严肃领域的配方按需开。只作用于**新开**的案：
 *                     续办（--case）不补锁——运营可能有意解过锁，续办路替它再锁上是越权
 *   RULITH_AUTO_SEAL  off = 案板模式下段尾不封板（案卷留在「在办」，自己去控制台结）
 *   RULITH_SEAL_ON_STOP cancelled|failed|abandoned = 停轮（板未判可交付）时**也**封板，
 *                     并带这个处置。不配＝不封（缺省），案卷留在「在办」。`completed` 不收：
 *                     停轮不是办结，那个词只能由板判出来
 *   RULITH_SERVE      on = 接单脑（等价于 --serve）
 *   RULITH_SERVE_PORT 收单口端口（缺省 7799，只监听回环）
 *   RULITH_SERVE_RUNS 结果环形队列上界（缺省 200 条——内存里的东西必须有上界）
 *   RULITH_SERVE_CONCURRENCY **跨槽**并发（缺省 1，上限 8；超了教学说明并 clamp。同槽恒串行）
 *   RULITH_SERVE_SLOTS_MAX 会话槽上界（缺省 64；超了 LRU 驱逐**闲置**槽，板不受影响）
 *   （`RULITH_IDENTITY_BOARD` / `RULITH_IDENTITY_PREDICATES` 已于 2026-08-07 随身份板实现整件删除。
 *     配了它们**不会报错也不会生效**——env 没有未知键教学这回事；跨案连续性改走上面那三条腿。）
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

function fingerprintRecipePacks(packs) {
  return packs.map((entry, index) => {
    if (Object.hasOwn(entry, 'digest')) {
      if (typeof entry.digest !== 'string' || entry.digest.trim() === '') {
        throw new Error(`Recipe packs[${index}].digest must be a non-empty string when supplied.`)
      }
      return entry
    }
    const digest = createHash('sha256').update(JSON.stringify(entry.pack)).digest('hex')
    return { ...entry, digest: `sha256:${digest}` }
  })
}

// Keep local recipe identity byte-compatible with the Cloud's closing audit.
// The authoritative package ledger contains only ordered (type, digest) pairs;
// seed operations are case input, not part of the installed program identity.
function recipeDigestOver(id, packs) {
  const pairs = packs.map((entry) => [entry.packType, entry.digest])
  return `sha256:${createHash('sha256').update(JSON.stringify({ id, packs: pairs })).digest('hex')}`
}

const URL_BASE = (process.env.RULITH_URL ?? 'https://api.rulith.com').replace(/\/$/, '')
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
// Station 的并行案件 Profile：sessionKey 是短命 Context 槽，不是客户身份；每槽每段仍按
// 一案一板开卷封卷。缺省 off，原有“一客一长命服务板”合同逐字节保留。
const SERVE_CASE_SLOTS = (process.env.RULITH_SERVE_CASE_SLOTS ?? '') === 'on'

const argv = process.argv.slice(2)
let agentName = 'default'
let withUi = false
let withShadow = false
let withServe = (process.env.RULITH_SERVE ?? '') === 'on'
// 案板模式(CB-30)是 **opt-in**: 不带旗＝旧形态一字不改(单板长跑 + 段尾归档),存量零迁移。
let caseBoards = (process.env.RULITH_CASE_BOARDS ?? '') === 'on'
let recipePath = process.env.RULITH_RECIPE ?? ''
/** 续办既有案(`--case <案号>` / `RULITH_RESUME_CASE`): 起进程即接着办那一案,不开新板。
 *  **只作用于第一段**——之后每段照常开新案(一段=一单是案板形态的定义)。 */
let resumeCase = (process.env.RULITH_RESUME_CASE ?? '').trim()
/** 案内锁法(缺省不锁,见头注 RULITH_CASE_LAW_LOCK 那段门牌)。 */
const caseLawLock = (process.env.RULITH_CASE_LAW_LOCK ?? '') === 'on'
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--agent' && argv[i + 1] !== undefined) { agentName = argv[++i]; continue }
  if (argv[i] === '--ui') { withUi = true; continue }
  if (argv[i] === '--serve') { withServe = true; continue }
  if (argv[i] === '--shadow') { withShadow = true; continue }
  if (argv[i] === '--case-boards') { caseBoards = true; continue }
  if (argv[i] === '--recipe' && argv[i + 1] !== undefined) { recipePath = argv[++i]; continue }
  if (argv[i] === '--case' && argv[i + 1] !== undefined) { resumeCase = argv[++i]; continue }
  rest.push(argv[i])
}
const TASK = rest.join(' ').trim()
const CASE_BOARDS = caseBoards
const SERVE = withServe

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1) }
if (TOKEN === '') die('RULITH_TOKEN is missing. Create an Agent token in Console under Access & credentials; it is shown only once.')
if (MODEL_KEY === '') die('A model key is missing. Set ANTHROPIC_API_KEY or RULITH_MODEL_KEY. It stays in this local process and is never sent to Rulith.')
if (SERVE_CASE_SLOTS && (!SERVE || !CASE_BOARDS)) die('RULITH_SERVE_CASE_SLOTS=on requires both --serve and --case-boards. Each concurrent context needs its own case board.')
// 无任务=进入多轮对话(2026-08-01 起 CLI 是桌面主形态);带任务=一次办完后退出(CI/脚本兼容不变)。
// **接单脑不是对话**: 收单口进来的每一条都是「任务」,所以 --serve 下按 CLI 语义走
// (纯回话不算办完,照旧催它给 JSON 或 DONE:/STOP:)——排队的是活,不是聊天。
const CHAT = TASK === '' && !SERVE

// ── 配方（CB-30）：智能体 = 配方（包组合 + principal），一单实例化一块板 ─────────
//
// 配方是**数据不是代码**(用户 2026-07-18 裁定: 能用数据对象就不用闭包注入)——一个 JSON 文件,
// 换配方＝换文件,不改这个可分发物。开单=一发 CreateBoard(构成随配方由宿主装入)+播种。
//
//   {
//     "packs": [
//       {"packType":"domain","pack":{"meta":{"name":"orders","version":1},"vocab":[…]},"digest":"可选"},
//       {"packType":"norms", "pack":{"meta":{"name":"orders-norms","version":1},"norms":[…]}}
//     ],
//     "seed": [ {"op":"declare_goal","id":"G1","label":"…","desired":[…]} ]
//   }
//
// `digest` 是包指纹幂等键(协议面 RegisterPack 的可选字段): 同键同指纹重装=零写,跨部署重试安全。
// 宪法走 `packType:"norms"`(播种即上锁: norm/committed_norm 落 system 通道 EDB,模型造不了也撤不掉);
// 目标/初始材料走 `seed`(一批 ApplyBatch 操作,与模型每轮提交的是同一种东西)。
//
// **配方的权威在云上,不在这个文件旁边**(2026-08-07,核心 board-spec BRD-112)。云上的领域智能体
// 早已配齐领域四件套,每块基于它开的板初始化都基于那套配置——所以缺省路径是**向网关取配方**
// (`GET /agent/v1/recipe?agent=<名>`,包簿的物化),本地 `--recipe` 文件降级为**离线/自建部署的备用**。
// 两者并存过一段时间,而那正是问题: 同一事实两个真相源,案板用的是本地那个。现在定死顺序——
// 显式给了 `--recipe` 就用它(离线形态优先级更高,你明说了要哪份),否则向云取。
// `RECIPE.ref = {id, digest}` 是配方**出身**,建板时随 `CreateBoard{recipe}` 发出去,由 host 落
// genesis 受信事实;有了它,"这一案是哪个智能体按哪版配方办的"从案卷本身答得出。
const RECIPE = { packs: [], seed: [], ref: undefined, maxConcurrentCases: 1 }
if (recipePath !== '') {
  let raw = ''
  try { raw = readFileSync(recipePath, 'utf8') } catch (e) { die(`Cannot read recipe file ${recipePath}: ${e?.message ?? e}. It must be a JSON file; see the schema in the header of rulith-agent.mjs.`) }
  let j = {}
  try { j = JSON.parse(raw) } catch (e) { die(`Recipe file is not valid JSON (${recipePath}): ${e?.message ?? e}`) }
  const declaredPacks = Array.isArray(j.packs) ? j.packs : []
  declaredPacks.forEach((p, i) => {
    if (p === null || typeof p !== 'object' || typeof p.packType !== 'string' || p.pack === null || typeof p.pack !== 'object') {
      die(`Recipe packs[${i}] is invalid. Each entry must look like {"packType":"domain|tools|channels|norms","pack":{...},"digest":"optional"}.`)
    }
  })
  let packs = []
  try { packs = fingerprintRecipePacks(declaredPacks) } catch (e) { die(e?.message ?? String(e)) }
  const seed = Array.isArray(j.seed) ? j.seed : []
  RECIPE.packs = packs
  RECIPE.seed = seed
  RECIPE.maxConcurrentCases = Number.isInteger(j.runtime?.maxConcurrentCases)
    ? Math.max(1, Math.min(8, j.runtime.maxConcurrentCases)) : 1
  // Local recipe identity uses the same ordered package-ledger digest as the
  // Cloud closing audit. Otherwise every local recipe would be reported as
  // drifted even when every installed package fingerprint matches exactly.
  RECIPE.ref = {
    id: String(j.id ?? agentName),
    digest: recipeDigestOver(String(j.id ?? agentName), packs),
  }
  // 配了配方却既没开案板模式、也不是接单脑=十有八九是忘了带旗。**不静默**: 配方在两处用得上——
  // 案板模式的「开单」,与服务槽的「首建服务板」(复用时不重播)。单板长跑形态下它一行都发不出去。
  if (!CASE_BOARDS && !SERVE) console.error(`⚠ Recipe ${recipePath} is configured, but neither --case-boards nor --serve is enabled. Recipes are applied when a case board or service board is first created, so this single-board run will not install it.`)
}

/**
 * 云上取配方(缺省路径)。**包簿是唯一源**——控制台给这个智能体装了什么,新板就照着开。
 * 取不到就如实说并**裸板开工**(不静默):网关老版本没有这条路、或部署没启用包登记簿时,
 * 行为退回"开裸板",而那与从前一模一样——但你得看得见它退了,否则"我明明装了包"会变成一桩悬案。
 */
/** 开案前的配方刷新(2026-08-21): 云上变了就换成新的并**说出口**;拿不到就用手里那份接着办。
 *  与启动那次的分工: 启动那次**取不到就不开工**(fail-closed,少了宪法的板不叫开成了单);
 *  这一次是**刷新**——网络抖一下不该把一个正在服务的智能体打停,但漂了必须让人看见。 */
async function refreshRecipe() {
  if (recipePath !== '') return // 本地配方=你明说了要哪份,不去云上抢
  if (RECIPE.ref === undefined) return // 启动那次就没取成(裸板形态),这里不补
  const was = RECIPE.ref.digest
  try {
    await fetchRecipe({ refresh: true })
  } catch { return }
  const now = RECIPE.ref?.digest ?? was
  if (now !== was) {
    console.log(`Recipe updated: ${String(was).slice(0, 19)}… → ${String(now).slice(0, 19)}…. New cases will use the new recipe.`)
  }
}

async function fetchRecipe(opts) {
  const refresh = opts?.refresh === true
  if (recipePath !== '') return // 显式给了本地配方=你明说了要哪份,不去云上抢
  if (!CASE_BOARDS && !SERVE) return // 两种形态之外配方发不出去,不必白跑一趟
  // **取不到配方就不开工**(2026-08-08 外部 review 逮出的 fail-open)。此前这里只 warn 然后开裸板,
  // 而 openCase 自己的门牌写着「配方里有宪法包——宪法没落板,①级语义闸与清关台账就不在,
  // 那块板看起来能干活,实际少了一整层门。**少了门的板不叫开成了单**」。两句话直接打架,
  // 而打架的结果是**静默地按更松的那句执行**: 网络抖一下,一整轮案子就在没有宪法的板上办完了。
  // 裸板要开得**显式说出来**(RULITH_ALLOW_BARE_BOARD=on)——那是实验/自测的开关,不是缺省。
  const bareOk = (process.env.RULITH_ALLOW_BARE_BOARD ?? '') === 'on'
  const giveUp = (why) => {
    // **刷新失败 ≠ 首取失败**(2026-08-21): 首取拿不到就不开工(少了宪法的板不叫开成了单);
    // 而刷新时手里**已经有一份能用的配方**,网络抖一下不该把正在服务的智能体打停。
    // 如实说一句、按手里那份接着办——这不是放宽 fail-closed,是两种情形本就不同。
    if (refresh) {
      console.error(`⚠ ${why}. Continuing with the last loaded recipe (${String(RECIPE.ref?.digest ?? '').slice(0, 19)}…). The next case will try the Cloud recipe again.`)
      throw new Error('recipe-refresh-failed')
    }
    if (bareOk) {
      console.error(`⚠ ${why}. RULITH_ALLOW_BARE_BOARD=on: opening a bare board with no packages or seed. It has no Constitution gate; use it only for experiments.`)
      return
    }
    die(`${why}
   Work did not start. A recipe may contain Constitution gates; opening without them would silently weaken the workflow.
   Retry when Cloud is reachable, use --recipe <file> for an offline deployment, or explicitly set RULITH_ALLOW_BARE_BOARD=on for an experiment. Bare boards are never the default.`)
  }
  let r
  try {
    r = await fetch(`${URL_BASE}/agent/v1/recipe?agent=${encodeURIComponent(agentName)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  } catch (e) {
    return giveUp(`Could not fetch the Cloud recipe (${e?.message ?? e})`)
  }
  if (!r.ok) {
    return giveUp(`Cloud recipe request was rejected (HTTP ${r.status}). This deployment may not support /agent/v1/recipe`)
  }
  const j = await r.json().catch(() => ({}))
  const rec = j?.recipe
  if (rec === undefined || !Array.isArray(rec.packs)) {
    return giveUp('Cloud returned an invalid recipe shape')
  }
  // **闸问的是「宪法到没到」,不是「取没取到」**(2026-08-22,RT-AGT-EMPTY-RECIPE)。
  //
  // 上面那道闸只拦"取不到"。而 `{"ok":true,"recipe":{"packs":[]}}` 走的是 200 ⇒ 一路放行:
  // CreateBoard 照发(genesis 上还钉着 recipe digest,读起来像"按配方办的")、RegisterPack **0 次**、
  // 终端"裸板"与"不开工"**各 0 次**、办完照样 `SealBoard{disposition:"completed"}` 进绩效。
  // **一块没有宪法门的板,从头到尾没有一个字提示过。**
  //
  // 触发面全是日常:`--agent` **打错一个字母** / 新智能体还没装包 / 把包全停用
  // (`recipeOf` 滤 disabled)——三条都得到 200 + `packs:[]`。
  //
  // 与本函数上面那段门牌合起来读: 那段说「少了门的板不叫开成了单」,
  // 而**空配方就是少了门**——判据从"fetch 成没成"换成"配方里有没有货",两句话才对得上。
  // 对面 `gateway.ts` 的 `/agent/v1/recipe` 注释写着「空配方不是错…裸板照样开得出来」——
  // 那句在**网关**这一侧成立(它不该替客户端决定开不开工),但客户端不能照它放行。
  if (rec.packs.length === 0) {
    return giveUp(`The Cloud recipe is empty. Agent "${agentName}" has no enabled packages`)
  }
  RECIPE.packs = rec.packs
  RECIPE.seed = [] // 播种(目标/初始材料)是**这一单**的事,不是配方的事;配方只管装法
  RECIPE.ref = { id: String(rec.id ?? agentName), digest: String(rec.digest ?? '') }
  RECIPE.maxConcurrentCases = Number.isInteger(rec.runtime?.maxConcurrentCases)
    ? Math.max(1, Math.min(8, rec.runtime.maxConcurrentCases)) : 1
}

// 案号 = 板名(人面标识,控制台登记簿按它显示在办/已结)。网关的产品面名字白名单是
// 「字母数字开头、可含 - _ .、不超 64 字」——不合规的名字板照样能用,但**不进登记簿**,
// 于是控制台永远看不见这块案卷。所以前缀在这里就洗干净,不把这个坑留到真机。
const CASE_PREFIX = ((process.env.RULITH_CASE_PREFIX ?? agentName).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24)) || 'case'
let caseSeq = 0
const nextCaseId = () => {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  caseSeq += 1
  // 随机尾巴不是装饰: 同一天同一配方可能有多个进程在开单,纯序号会撞名(撞名=CreateBoard 幂等
  // 落到别人的案卷上,两单的材料混进同一次闭包——正是一单一板要消灭的东西)。
  return `${CASE_PREFIX}-${ymd}-${String(caseSeq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`
}
const caseTitleOf = (text) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t === '' ? '(未命名案卷)' : `${t.slice(0, 60)}${t.length > 60 ? '…' : ''}`
}
// 「当前板」曾经是这里的一个进程级 `let currentBoard`。**2026-08-07 分槽后它没了**:
// 板寻址住进会话槽(`slot.board`),`board(op, to)` 的 `to` 因此**必须显式给**——见下面那个函数。
// 一客一板(服务板)形态下,两个客户的段可以真并发跑,进程级的"当前板"就是串板的入口。

/** 服务板板名: 从 sessionKey **确定性**推导(同 key 恒同板,所以 find-or-create 才成立)。
 *  形状受网关产品面白名单管: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`(console.ts isValidWorkspaceName)
 *  ——不合规的板照样能用,但**不进登记簿**,于是控制台永远看不见这位客户的板。
 *  所以: 前缀(已洗净,≤24) + key 的 slug(≤24) + 原始 key 的短哈希尾(8)。
 *  **哈希尾不是装饰**: slug 是有损的(`客户/1` 与 `客户#1` 洗出同一个 slug),没有它两个不同客户
 *  会共用一块板——那正是这个形态最不能出的错。总长 ≤ 24+1+24+1+8 = 58,留足白名单余量。 */
const serviceBoardName = (sessionKey) => {
  const slug = String(sessionKey).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 's'
  const tail = createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 8)
  return `${CASE_PREFIX}-${slug}-${tail}`
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
    body: JSON.stringify({ agent: agentName, events: batch }),
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
  if(e.type==='sealed') add('<div class="round">Case sealed · '+esc(e.board)+(e.idempotent?' (idempotent)':'')+'</div>')
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

// ── 板协议客户端（云上唯一入口；身份只来自令牌） ─────────────────────────
//
// **长命板的 Work 信封**(BRD-113 稳态形态 + LWB-RT-H11,2026-08-10)。
// 核心把 `lifecycle=long_lived` 板上的 op 分成三档(权威表=核心 command-handler 的
// `Record<kind, work_required|work_optional|board_only>`,编译期穷举):
//   · **写面 8 个 = `work_required`**: ApplyBatch/ArchiveTask/RunDischarge/IngestObservation/
//     GrantClearance/ClaimWork/ReportWork/ParkWork —— 缺 work 就零副作用地拒
//     (`work_context_required`)。任务事实必须绑定 Work,不得落入共享区。
//   · **读面 = `work_optional`**: 带 work 给 Work 视图,不带给 Baseline 视图,**两者都受理**,
//     且回执自述作用域(`payload.scope.kind = work|baseline`)。核心 2026-08-10 从"读也必绑"
//     收窄成这样,正是因为"必绑"逼得网关为看一眼板去开一条假线程。
//   · **`board_only`**: 携 work 反被拒(CreateBoard/OpenWork/SealBoard/治理那族)。
//
// 本集合 = 写面 8 个 ＋ 读面 6 个。**读面在这里是主动选择不是被迫**: 服务板上这些读问的就是
// "这一单办到哪了",要的正是 Work 视图;不绑会拿到 Baseline 视图(合法但答非所问)。
//
// 服务板(一客一板)自本轮起就是长命板,而本文件从前**全文件零 command.work、零 OpenWork**——
// 板一变长命,写(ApplyBatch/ArchiveTask)全部落空,而产品面照样报「办好了」(桩模型一句 DONE
// 就能盖过去)。形态 = **服务板 ＝ 长命板 ＋ 一单一 Work**: 收到一单 → OpenWork(root=本单) →
// 全程带信封 → 段尾**归档该 Work**(ArchiveTask,不是 SealBoard——服务板恒不封,RT-SERVE-7)。
//
// case 板一律不带(核心: case 板没有 Work Scope)。
const WORK_GATED = new Set([
  'GetProjection', 'GetChanges', 'GetCompletion', 'QueryBoard', 'RunDischarge', 'ApplyBatch',
  'ArchiveTask', 'ParkWork', 'Explain', 'IngestObservation', 'GrantClearance', 'ListWork', 'ClaimWork', 'ApplyAction', 'ReportWork',
])
/** 板 → 此刻绑的那件事 `{id, root}`。键是**板名**: 服务板与会话槽一一对应且同槽恒串行,
 *  所以一板一绑不会串槽(跨槽并行的两块板是两个键)。 */
const workOf = new Map()
/** 绑定已经不作数的四种拒因(人在控制台把那件事归了/暂存了,或槽被驱逐后板上的事已易主)。 */
const STALE_WORK = new Set(['stale_work_revision', 'work_parked', 'work_closed', 'unknown_work'])
let seq = 0
/** **唯一的板寻址口**——别处一律不拼 boardId,免得有第二个地方知道"这一发该去哪块板"。
 *
 *  `to` **必须显式给**(2026-08-07 分槽): 从前它缺省取进程级 `currentBoard`,一进程一块板时那是
 *  便利,分槽之后那就是串板的入口——两个客户的段并发跑,谁最后写了那个全局,另一个的命令就发去谁的板。
 *  所以缺省口整个删掉,漏传当场炸(下面这条守卫),而不是安静地把一位客户的材料写进另一位的板。 */
async function board(operation, to, profile) {
  if (typeof to !== 'string' || to === '') {
    throw new Error(`board(): 缺板寻址参数 to——分槽之后没有「当前板」这个进程级缺省口了,每一发都要说清发给哪块板(operation.kind=${String(operation?.kind ?? '?')})`)
  }
  // 长命板的 Work 信封: 门内 op 才带(带错方向也是拒)。
  // **不带 expectedRevision**: 它在协议里是可选的乐观并发把手,而这块板不止我们一个写者
  // (云网关的自动放电扳机会在同一件事上补 RunDischarge,那是合法的写)。带上就会被别人的
  // 合法写打成 stale,把一次正常并发变成一串伪失败;不带则由权威端按当前 Work 直接落。
  // 我们不需要那把锁: 同槽恒串行,本进程对这块板是单写者。
  const bound = WORK_GATED.has(String(operation?.kind ?? '')) ? workOf.get(to) : undefined
  let r
  try {
    r = await fetch(`${URL_BASE}/board/v1/command`, {
      method: 'POST',
      // `x-rulith-board-profile`(建板时):这块板**被当成什么在用**——case(办完即封)/continuous(长命,不封)。
      // **它是托管层注记,故走头不进板命令**: BRD-03b 明令板没有子类型,写进 operation 就等于给板
      // 发明一个种类字段。网关据它落登记簿,产品面才讲得出"1 长命板 + N 案板"(BRD-113)。
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
        ...(profile !== undefined ? { 'x-rulith-board-profile': profile } : {}) },
      body: JSON.stringify({ protocol: 'rulith-board/1', boardId: to, requestId: `agent_${Date.now().toString(36)}_${seq++}`, operation,
        ...(bound !== undefined ? { work: { id: bound.id } } : {}) }),
    })
  } catch (e) {
    die(`连不上 ${URL_BASE}——${e?.cause?.code ?? e?.message ?? e}。检查网络,或用 RULITH_URL 指到你的部署。`)
  }
  const raw = await r.text().catch(() => '')
  let j
  try { j = JSON.parse(raw) } catch { j = {} }
  if (r.status === 401) die(`令牌不认（401）：${j.teaching ?? ''}`)
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
      teaching: `云端这一跳没通(HTTP ${r.status})——**不是你写错了**,板根本没看到这批操作。` +
        `原样重发即可;若一直这样,查 ${URL_BASE} 是否可达。` +
        (head !== '' ? `\n   服务端回的头 160 字: ${head}` : '\n   服务端一个字都没回。'),
    }
  }
  // 绑定失效就**丢掉绑定,但不自动重发**: 换个 requestId 重发不是幂等的(核心按 requestId 去重),
  // 写命令重来一次就是重来一次副作用。本发照实回给调用方(教学原样回流给模型),
  // 下一段的 ensureBoardWork 重新对账——这是本文件"报错是接口"那条纪律在 Work 面的同一句话。
  if (bound !== undefined && STALE_WORK.has(String(j?.errorCode ?? ''))) workOf.delete(to)
  return j
}
/** 这块板的寿命自述(GetBoardManifest.payload.lifecycle;老 boardd 不带=当 case 板)。 */
const lifecycleOf = (mf) => (mf?.accepted === true ? mf.payload?.lifecycle : undefined)
/**
 * **一单一 Work 的开工半边**: 这块板要是长命板,就替本单在上面开一件事(root=本单)。
 * 返回绑定 / undefined(不是长命板,或开不出来)。
 *
 * 顺序有讲究:
 *  ① `initializing` 的长命板连 OpenWork 都拒(board_draining)——先按治理路径激活初始 Baseline;
 *  ② 板上已有在跑的那件事就**认领**它,不另开: serial_activation 下同时只许一件在跑,
 *    硬开只会拿到 work_busy。上一单没归成(诚实门拦下)的那件事,由这条腿接着办完。
 */
async function ensureBoardWork(ctx, root) {
  const held = workOf.get(ctx.board)
  if (held !== undefined) return held
  let mf = await board({ kind: 'GetBoardManifest' }, ctx.board)
  if (lifecycleOf(mf)?.kind !== 'long_lived') return undefined
  if (lifecycleOf(mf)?.status === 'initializing') {
    const act = await board({ kind: 'MaintainBaseline', operations: [], activate: true }, ctx.board)
    if (act.accepted !== true) {
      log(`✗ 长命板「${ctx.board}」的初始 Baseline 激活被拒: ${String(act.teaching ?? act.errorCode ?? '').slice(0, 200)}——未激活的板不接 Work,本单办不了`)
      return undefined
    }
    mf = await board({ kind: 'GetBoardManifest' }, ctx.board)
    if (mf.accepted !== true) return undefined
  }
  const running = (mf.payload?.works ?? []).filter((w) => w !== null && typeof w === 'object' && (w.status === undefined || w.status === 'running'))
  const hit = running[0]
  if (hit !== undefined && typeof hit.id === 'string' && typeof hit.root === 'string') {
    const adopted = { id: hit.id, root: hit.root }
    workOf.set(ctx.board, adopted)
    log(`◎ 接上板上还在办的那件事「${adopted.root}」(${adopted.id})——上一单没归成的活由本单接着办完`)
    return adopted
  }
  const id = `WORK_srv_${Date.now().toString(36)}_${seq++}`
  const opened = await board({ kind: 'OpenWork', id, root }, ctx.board)
  if (opened.accepted !== true) {
    log(`✗ 在长命板「${ctx.board}」上开事失败: ${String(opened.teaching ?? opened.errorCode ?? '').slice(0, 200)}`)
    return undefined
  }
  const bound = { id: String(opened.payload?.workId ?? id), root }
  workOf.set(ctx.board, bound)
  return bound
}
/**
 * **真机认不认 `disposition` 这个字段**——封板门(`sealBoardOn`)与归档门(`archiveBoardWork`)
 * 共用的**唯一**判据(同一条判据只有一个执行点)。
 *
 * 判据要**窄**: 只有"这个字段我不认识"才准退回重发。**光是提到 disposition 不算**——
 * 新门拒绝办结时的教学恰恰会说"要作废请用 disposition:cancelled|…",按词命中就会把一次
 * **语义拒**当成形状拒重发,等于绕过刚立起来的那道门(封板门第一版就撞了这个)。
 * 所以判据 = 形状错(errorCode=bad_command) 或 教学明说"不认/未知/不支持",两者都要点名该字段。
 */
function dispositionUnsupported(r) {
  const teaching = String(r?.teaching ?? '')
  if (!/disposition/i.test(teaching)) return false
  // **`errorCode==='bad_command'` 那一臂已删**(2026-08-22,RT-AGT-DISP)。
  //
  // 门牌承诺的是「只有'这个字段我不认识'才准退回」,而那一臂恰好**吞掉最可能的那种拒**:
  // 「档位值不在册」(核心 `msg_seal_board_bad_disposition`)——它必然点名 disposition、
  // 必然是 `bad_command`。于是窄化的 `unknownish` 词表在那条路上**根本没参与判断**。
  //
  // 吞掉的后果不是"少退一次",是**把一单作废洗成办结**:核心 `op_seal_board` 走
  // `disposition.unwrap_or("completed")` ⇒ 退回不带字段重发之后,板上记的**不是"没有",是 `completed`**。
  // 核心自己的注释逐字写着「悄悄当 completed 处理等于把一次'作废'记成'完成'」,
  // 而客户端的降级路从外面把这件事做成了。
  //
  // **今天不触发**(客户端只发册内四档),它是**版本漂移引信**:客户端比 boardd 新、
  // boardd 换档位表、或中间加一层校验时才炸。判据现在只认措辞。
  return /不认|不收|未知|无此|不支持|不识别|unknown|unsupported|unrecognized|not recognized/i.test(teaching)
}

/**
 * **一单一 Work 的收尾半边**: 段尾归档这件事(`ArchiveTask`)。
 *
 * **不是 SealBoard**——服务板与这份服务同寿,封板是不可逆终态,不拿它收拾一位在服务的客户
 * (RT-SERVE-7 钉的正是这条)。归档收的是**这一单**,板照常接下一单。
 *
 * `disposition` = 这一段是**怎么**关的账。不带它,权威端按缺省 `completed` 关账——于是
 * 没办完的活在账面上变成「办结」(2026-08-17 orders-bt 真机: STOP 之后照归,半途案卷进冷层,
 * 受信回执与续办者都看不见)。调用方**只在板判可交付时**传 `completed`;不可交付根本不该
 * 走到这里(判据在段尾的 `deliverableNow`,与案板腿同一个执行点)。
 * 老 boardd 不认这个字段时退回不带并**如实记**(判据与封板门共用 `dispositionUnsupported`)。
 *
 * 归不掉就**留着**(诚实门的原话照记): 还有外向动作没回执的树收起来就没地方贴回执了。
 * 留下的那件事由下一单的 `ensureBoardWork` 认领接着办——不静默丢,也不硬关。
 */
async function archiveBoardWork(ctx, disposition) {
  const bound = workOf.get(ctx.board)
  if (bound === undefined) return
  const base = { kind: 'ArchiveTask', root: bound.root }
  let degraded = false
  let r = await board(disposition === undefined ? base : { ...base, disposition }, ctx.board)
  if (r.accepted !== true && disposition !== undefined && dispositionUnsupported(r)) {
    log(`◎ 真机的归档门还不收 disposition（原话: ${String(r.teaching ?? '').trim().slice(0, 140)}）——已退回不带该字段重发一次；
   **板上不会是"没有"**: 权威端对缺席的 disposition 取缺省 completed(核心 op_seal_board 的 unwrap_or),
   所以这一段在账面上会记成**办结**。处置「${disposition}」只留在本地日志。
   ${disposition === 'completed' ? '(本次两者同值,账面无差。)' : '**这与你要的处置不是一回事**——去控制台按实际情况处置这一案。'}`)
    degraded = true
    r = await board(base, ctx.board)
  }
  if (r.accepted === true) {
    workOf.delete(ctx.board)
    log(`◎ 本单已归档(${bound.root}${disposition === undefined ? '' : ` · 处置 ${disposition}${degraded ? '；真机暂不收该字段' : ''}`})——板保持干净,下一单在干净的台面上开工(历史在冷层,控制台可查)`)
    emitOn(ctx, 'archived', { root: bound.root, ...(disposition === undefined ? {} : { disposition }), ...(degraded ? { degraded: true } : {}) })
  } else {
    log(`◎ 本单归档被拒: ${String(r.teaching ?? r.errorCode ?? '').slice(0, 200)}
   这件事留在板上(下一单接着办)——归档会把树收起来,没办完就归等于把回执的落点也收了。`)
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
  const r = await board({ kind: 'GetProjection', ...(opts.full === true ? {} : attnArg()) }, ctx.board)
  if (r.accepted !== true) return `（板还读不到：${r.teaching ?? r.errorCode ?? ''}）`
  let text = String(r.payload?.text ?? '')
  // 板报缺口(QueryBoard include:gaps,0.11): 「现在该干嘛」由板自己说——桥缺可信来源/放电卡点/
  // 交付义务,不靠模型对着全量投影猜。老 boardd 无 QueryBoard=拒,静默略过(缺口段是增益不是依赖)。
  const { gaps, inFlight } = await boardGaps(ctx)
  if (gaps.length > 0) {
    const lines = gaps.slice(0, 12).map((x) => `- ${x.gap}(${Object.entries(x.args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')})`)
    text += ['', '', '板报缺口（板自己算的「还差什么」，优先处理）：', ...lines].join(String.fromCharCode(10))
  }
  if (inFlight.length > 0) {
    const lines = inFlight.slice(0, 12).map((x) => `- ${String(x.args?.node ?? '')}：求证工单已派出，等真探回话`)
    text += ['', '', '求证在途（不是缺口，不用管——下一轮再看即可，别改叶子也别收尾）：', ...lines].join(String.fromCharCode(10))
  }
  return text
}

// ── 段尾自动归档（2026-08-01 产品级约束：板上事实不得无界累积——闭包跑在活事实上，
//    归档即释放处理能力）。这是**机制不是模型的自觉**：机械枚举根 → 问权威端完成态 →
//    可交付(certify 过)的当场 CloseTask。诚实门天然兜底：没办利索的根关不掉。
//    归档≠删除：历史进冷层，控制台可查。RULITH_AUTO_ARCHIVE=off 可关。
//
//    **服务板(一客一板)沿用的就是这一条腿**(2026-08-07): 一块板要长命几个月,「板活跃面不随
//    月龄增长」不是优化而是能不能用的前提——法=核心仓 board-spec §4.6 BRD-111 腿①(非案卷板
//    有界性,断言 RT-BRD111-*,同日落文)。服务板没有封板这个出口,所以归档是它
//    **唯一**的清台面手段:段尾把本段判可交付的根归掉,活跃面回到常数级。 ──
//
//    **旋钮的判据不在这个函数里**(2026-08-17): 归档有两条腿(本函数 + 长命板的
//    `archiveBoardWork`),判据写在其中一条腿里就只挡得住那一条——门牌承诺的「可关」
//    于是对现役的长命板形态是假的。所以它上移到两条腿**共同的调用点**(段尾),
//    这里只留这个谓词的定义。
const autoArchiveOff = () => (process.env.RULITH_AUTO_ARCHIVE ?? '') === 'off'
async function autoArchive(ctx) {
  const pj = await board({ kind: 'GetProjection', format: 'json' }, ctx.board)
  if (pj.accepted !== true) return // 板读不到就什么也不做——归档是收尾便利,不该反过来搅局
  const facts = pj.payload?.context?.facts ?? []
  const roots = [...new Set(facts.filter((f) => f.atom?.predicate === 'root').map((f) => String(f.atom.args?.node ?? '')))].filter(Boolean)
  for (const root of roots) {
    const c = await board({ kind: 'GetCompletion', root }, ctx.board)
    if (c.accepted !== true || c.payload?.certified !== true) continue // 只归可交付的——其余如实留在台面上
    // **纵深防御**(2026-08-08 外部 review 的 P0): `certified` 只说**规则上证成了**,不说世界办完了。
    // 已 dispatched 未回执的动作会让 driveState 停在 `actuating`——那时归档就是把一棵还在等回执的树
    // 收起来(收完回执连往哪儿贴都没有了)。权威端已有归档门(work_pending),这里再拦一道:
    // 少一次注定被拒的往返,而且日志上说得清"为什么这一根没归"。
    // **判据与案板腿同源**(2026-08-22,RT-AGT-LEG)。此前这里写的是 `state !== 'actuating'`
    // ——一个状态值的**补集**,于是 `parked`/`stuck`/`halted`/`driving` 四种全归。
    // 而案板腿(`deliverableNow`)的判据是 `state === 'done'`,且门牌逐字写着
    // 「两条腿走同一个判据,就没有'哪一条腿松一点'这回事了」——**第三条腿不在那句话的覆盖里**。
    //
    // 后果实测:同一块板(`certified=true, state='parked'`),带 `--case-boards` 报 pending_case_id、
    // 不带就 `ArchiveTask` 且**不带 disposition** ⇒ 核心取缺省 `completed`。
    // 同一块板两个答案,而"办结"那个是错的。
    //
    // 复核过权威端(纪律 9):核心归档门也只拦 `actuating`,**会收**——所以不是客户端比权威端松,
    // 是客户端在这条腿上**放弃使用自己更严的那把尺**。
    const st = String(c.payload?.state ?? '')
    if (st !== 'done') {
      log(`◎ 「${root}」规则上已可交付,但驱动态是 ${st || '(不可考)'} 而不是 done——**先不归档**。` +
        (st === 'actuating' ? '还有外向动作没回执;归早了那棵树就收起来了,回执再来也没地方贴。' : '没到 done 就归,等于把没办完的活记成办结。'))
      continue
    }
    // **处置显式带上**,不靠权威端缺省(缺省是 `completed`——"不带"与"办结"在账面上长一个样)。
    // 走到这里两根轴都成立(certified + done),`completed` 是它当得起的那个词。
    let r = await board({ kind: 'ArchiveTask', root, disposition: 'completed' }, ctx.board)
    if (r.accepted !== true && dispositionUnsupported(r)) {
      // 老 boardd 不认这个字段 ⇒ 退回不带并如实记(与 `archiveBoardWork` 同一条降级路)。
      // 这一格**降级方向是安全的**:走到这里两根轴都成立,不带字段的缺省恰好也是 `completed`。
      log(`◎ 真机的归档门还不收 disposition——已退回不带该字段重发(此处两者同值,账面无差)`)
      r = await board({ kind: 'ArchiveTask', root }, ctx.board)
    }
    if (r.accepted === true) {
      log(`◎ 「${root}」已可交付,顺手归档——板保持干净(历史在冷层,控制台可查)`)
      emitOn(ctx, 'archived', { root })
    } else {
      log(`◎ 「${root}」归档被拒: ${String(r.teaching ?? r.errorCode ?? '').slice(0, 160)}`) // 诚实门的原话
    }
  }
}

// ── 开单 / 封板（CB-30 段→单；只在 --case-boards 下走）────────────────────
//
// **开单＝配方函数**: 建板 → 装包 → 播种,三步照着配方发一遍,一步被拒就整单不成立。
// 为什么整单不成立而不是"带伤开工": 配方里有宪法包——宪法没落板,①级语义闸与清关台账就不在,
// 那块板看起来能干活,实际少了一整层门。**少了门的板不叫开成了单**。
//
// **补偿式原子,不是事务**(2026-08-07 review P1-4 改真): 这三步是三次独立提交,协议面没有回滚。
// 后步失败留下的是一块**半装配板**——占在办额度,而且**制度可能根本没装上**(宪法包失败最危险:
// 它看起来能干活,实际少了一整层门)。所以失败即**当场作废**:
// `SealBoard{disposition:'abandoned', reason:'开案未完成: <步骤>'}`。作废封板不要求板"干净",
// abandoned 这个处置就是为这种半成品存在的。封不掉才留在「在办」,并把案号打给人处置。
// (旧文案写的是「开单失败不封板,留在在办让人自己结」——那把最危险的一种板做成了缺省停留态。)
//
// `predecessor`(BRD-110 案间承继,0.21.0): 这一单是**续办**别的案时带上前案板名——协议面在建板前
// 校验(同 Authority + 前案存在,不过则整单拒、零副作用),建成后 host 通道落 attested
// `case_predecessor`,回执带 `payload.predecessor`,网关登记簿据它把绩效按**案链**聚合。
// 没有它,「误封 → 重办」在账面上是 1 completed + N cancelled,老实续办反而被惩罚。
/** CreateBoard 的“已存在”目前仍共用 rejected，尚无稳定的 already_exists errorCode。
 *  美国节点已经英文化，因此在协议补专码前，兼容权威端现有中英文教学；不能再把续办绑死到 UI 语言。 */
const boardAlreadyExists = (r) => r?.accepted !== true
  && /(?:已存在|already exists)/i.test(String(r?.teaching ?? ''))

async function openCase(ctx, title, predecessor, resumeId) {
  // **续办既有案**(2026-08-08 外部 review: "下次继续这一案"此前是不真实的产品承诺——
  // 四处教学都这么写,而代码里每次都 nextCaseId() 开新板,旧案只会变成孤儿)。
  // 落法顺着既有信号走: CreateBoard 撞"已存在"就说明这块板**已经装配好了**(包与播种都在),
  // 于是**跳过装包与播种**直接接着办——重播会撞 duplicate id,重装不带 digest 会把包再并一次。
  const id = typeof resumeId === 'string' && resumeId !== '' ? resumeId : nextCaseId()
  // **开案前重取配方**(2026-08-21 真机演练撞出)。此前 `fetchRecipe()` 只在进程启动时跑一次,
  // 于是一台常驻两天的智能体,手里那份配方也是两天前的——**云上治理面改了它不知道**,
  // 每开一块新案板都装旧配方。实证:承运那天进了配方,而这台进程开出来的案板
  // `tool_def` 六条、`tool_carrier` **零条** ⇒ `action_ready` 永不成立 ⇒ 模型怎么调都不动。
  // 配方是**治理物**,治理改了就该当场生效;「同一枚出身指纹」要的是同一次物化内不漂,
  // 不是把进程启动那一刻的快照钉死一辈子。指纹变了**说出口**——静默换配方与静默不换同样坏。
  await refreshRecipe()
  // `recipe`(BRD-112 配方出身): 建板时把"按哪份配方开的"一并发出去,host 落 genesis 受信事实
  // (模型写不出)。同配方双开 genesis 逐字节相同 ⇒ 跨案身份是一枚可复核的指纹,不需要一块记得的常驻板。
  // 初始化物化(BRD-112 扩,2026-08-14 用户裁决「配方=治理,装包=板初始化,不是智能体的动作」):
  // 构成(packs)随配方进 CreateBoard,由宿主在建板事务内装入——受信来路,配方内 tools 生而有权,
  // 任一包坏=整个建板拒且板不存在(原子,不再需要为装包半途而废做补偿封板)。
  // lawLock 进配方(吸收① 2026-08-21): 配了 RULITH_CASE_LAW_LOCK 且带构成 ⇒ 锁随配方声明,
  // 宿主在物化尾步同事务落锁——「锁定的就是这份配方」由构造保证,不再靠本客户端末步补一刀。
  // 旧 boardd 不认这个字段(原样忽略)⇒ 回执无 lawLocked 标 ⇒ 下面补锁路照旧接住(如实退回)。
  const mk = await board({ kind: 'CreateBoard', id, title,
    ...(RECIPE.ref !== undefined ? { recipe: { ...RECIPE.ref, ...(RECIPE.packs.length > 0 ? { packs: RECIPE.packs } : {}), ...(caseLawLock && RECIPE.packs.length > 0 ? { lawLock: true } : {}) } } : {}),
    ...(typeof predecessor === 'string' && predecessor !== '' ? { predecessor } : {}) }, id, 'case')
  // CreateBoard 幂等: 撞"已存在"照走(重试安全)。真拒(配额/权限)如实带教学回来——
  // 网关的在办板数上限就长这个样子,那句教学写明了出路(结掉几个在办的案)。
  const existed = boardAlreadyExists(mk)
  if (mk.accepted !== true && !existed) {
    return { ok: false, id, built: false, abandoned: false, teaching: String(mk.teaching ?? mk.errorCode ?? 'CreateBoard 被拒') }
  }
  if (existed) {
    // 已存在=已装配。**不重装不重播**(重播撞 duplicate id;不带 digest 的重装会把包再并一次)。
    // 这既是续办的正路,也顺手让"同一 id 重试开案"变得真幂等。
    log(`◎ 接着办既有案卷「${id}」(已装配,不重播种)`)
    emitOn(ctx, 'case-open', { board: id, ok: true, resumed: true })
    return { ok: true, id, built: true, abandoned: false, resumed: true, packs: 0, seeded: 0 }
  }
  /** 半装配案卷的收口: 作废封板。返回 true=已作废(不占额度),false=作废不掉(留在「在办」)。 */
  const abandon = async (why) => {
    const { r, degraded } = await sealBoardOn(id, `开案未完成: ${why}`, 'abandoned')
    if (r.accepted === true) {
      log(`◎ 半装配的案卷「${id}」已作废封板（disposition=abandoned${degraded ? '；真机暂不收该字段,处置只记在本地' : ''}）——它不会留在「在办」占额度`)
      emitOn(ctx, 'case-abandoned', { board: id, why, ...(degraded ? { degraded: true } : {}) })
      return true
    }
    log(`◎ 半装配的案卷「${id}」**作废不掉**: ${String(r.teaching ?? r.errorCode ?? '').slice(0, 200)}
   案号 ${id} 留在「在办」——去控制台处置(它可能连制度都没装上,别拿它继续办事)`)
    emitOn(ctx, 'case-abandon-failed', { board: id, why, teaching: String(r.teaching ?? r.errorCode ?? '') })
    return false
  }
  // 构成已随 CreateBoard 装入(回执 installed 为证)。**旧权威端降级**: 老 boardd 不识 recipe.packs
  // (只搬不裁会静默丢),回执无 installed ⇒ 如实退回逐件装(RegisterPack),升级 boardd 后自动走新路。
  // 不静默假设装好了——那会开出一块"看起来配好、实际全空"的板。
  const initInstalled = Array.isArray(mk.payload?.installed) ? mk.payload.installed.length : 0
  if (RECIPE.packs.length > 0 && initInstalled === 0) {
    log(`◎ 权威端还不识配方构成(回执无 installed)——退回逐件装,升级 boardd 后此路自动消失`)
    for (const p of RECIPE.packs) {
      const name = String(p.pack?.meta?.name ?? p.packType)
      const r = await board({ kind: 'RegisterPack', packType: p.packType, pack: p.pack, ...(typeof p.digest === 'string' ? { digest: p.digest } : {}) }, id)
      if (r.accepted !== true) {
        const why = `装配方包「${name}」(${p.packType})被拒`
        return { ok: false, id, built: true, abandoned: await abandon(why), teaching: `${why}: ${String(r.teaching ?? r.errorCode ?? '')}` }
      }
    }
  }
  if (RECIPE.seed.length > 0) {
    const r = await board({ kind: 'ApplyBatch', operations: RECIPE.seed }, id)
    if (r.accepted !== true) {
      const why = `播种(宪法/目标 ${RECIPE.seed.length} 条)被拒`
      return { ok: false, id, built: true, abandoned: await abandon(why), teaching: `${why}: ${String(r.teaching ?? r.errorCode ?? '')}` }
    }
  }
  // 案内锁法(RULITH_CASE_LAW_LOCK,2026-08-08): 开案**末步**上锁——必须在装包与播种全办完之后
  // (RT-LAW-2: 锁上的板连 RegisterPack 都拒,锁早一步开案序列自己就被自己锁死)。
  // 上锁=一条普通 assert_fact(自锁是安全方向,落锁不需要许可);摘锁要治理角色,模型自己摘不掉。
  // 锁上之后配方=本案全部法源: 案内 add_axiom/define_action/RegisterPack 一律教学拒。
  // **锁失败=开案失败**(同 abandon 收口): 半上锁的板与半装配的板同病——看起来能干活,
  // 实际少了说好要有的那道门。要"锁不上也开工"就别配这个变量。
  // 宿主已锁(recipe.lawLock 回执带 lawLocked 标)⇒ 跳过补锁——再补一刀会撞 LAW_LOCK id,
  // 把开成的案误判成失败。旧 boardd 无此标 ⇒ 照走补锁路(与 installed 缺位退逐件装同一形)。
  const hostLocked = (mk.payload ?? {}).lawLocked === true
  if (caseLawLock && hostLocked) {
    log(`◎ Case "${id}" opened with its program locked atomically. The installed recipe is its complete law source; unlocking requires a governance role in Console.`)
  }
  if (caseLawLock && !hostLocked) {
    const r = await board({ kind: 'ApplyBatch', operations: [
      { op: 'assert_fact', id: 'LAW_LOCK', predicate: 'law_locked', args: { by: 'recipe' }, summary: '案内锁法: 配方=本案全部法源(RULITH_CASE_LAW_LOCK)' },
    ] }, id)
    if (r.accepted !== true) {
      const why = '案内锁法(law_locked)被拒'
      return { ok: false, id, built: true, abandoned: await abandon(why), teaching: `${why}: ${String(r.teaching ?? r.errorCode ?? '')}` }
    }
    log(`◎ Case "${id}" program locked through the compatibility path. The installed recipe is its complete law source; unlocking requires a governance role in Console.`)
  }
  return { ok: true, id, built: true, abandoned: false, packs: RECIPE.packs.length, seeded: RECIPE.seed.length, ...(caseLawLock ? { lawLocked: true } : {}) }
}

// 停轮时的处置(RULITH_SEAL_ON_STOP): 只认「作废」三档。**`completed` 故意不收**——
// 那个词是板判出来的结论,不是一个环境变量能给的;收了它就等于给"把停手记成办结"开了个官方开关。
const STOP_DISPOSITIONS = ['cancelled', 'failed', 'abandoned']
const SEAL_ON_STOP = (process.env.RULITH_SEAL_ON_STOP ?? '').trim()
if (SEAL_ON_STOP !== '' && !STOP_DISPOSITIONS.includes(SEAL_ON_STOP)) {
  die(`RULITH_SEAL_ON_STOP=${SEAL_ON_STOP} 不认——只收 ${STOP_DISPOSITIONS.join(' / ')}。
   停轮不是办结: completed 是板判出来的(certified 且状态真 done),环境变量给不了它。
   不配这个变量 = 停轮不封板,案卷留在「在办」等你处置(缺省,也是推荐档)。`)
}

/**
 * 封板一发（协议面 SealBoard）。封后**一切写命令教学拒**(errorCode=board_sealed)、
 * **读命令照常**(案卷定稿仍须可审计)、**重复封板幂等**。
 *
 * `disposition` = 这一单是**怎么**结的: completed(办结) / cancelled(撤单) / failed(办砸) /
 * abandoned(弃案,含开案未完成的半成品)。核心侧的封板门据它判: `completed` 要求案卷真办结
 * (有未回执的动作、未结的工单一律拒),作废三档则不要求板"干净"。
 *
 * **优雅降级(如实,不静默)**: 老 boardd 还不认这个字段。若真机因为它拒(教学里点名 disposition),
 * 就退回**不带 disposition** 重发一次,并在终端与事件流里写明"处置只记在本地"——
 * 降级要看得见:静默地把一单以未知处置封掉,比拒绝更难查。
 */
async function sealBoardOn(boardId, reason, disposition) {
  const base = { kind: 'SealBoard', reason: String(reason ?? '').slice(0, 240) }
  const first = await board(disposition === undefined ? base : { ...base, disposition }, boardId)
  if (first.accepted === true || disposition === undefined) return { r: first, degraded: false }
  const teaching = String(first.teaching ?? '')
  // 降级的判据**住在 `dispositionUnsupported` 里**(归档门共用同一条;两处各写一份,
  // 迟早只改一处 ⇒ 一道门开始把语义拒当形状拒重发,而另一道门不会)。
  if (!dispositionUnsupported(first)) return { r: first, degraded: false }
  log(`◎ 真机的封板门还不收 disposition（原话: ${teaching.trim().slice(0, 140)}）——已退回不带该字段重发一次；
   **板上不会是"没有"**: 权威端对缺席的 disposition 取缺省 completed(核心 op_seal_board 的 unwrap_or),
   所以这一单在账面上会记成**办结**。处置「${disposition}」只留在本地日志。
   ${disposition === 'completed' ? '(本次两者同值,账面无差。)' : '**这与你要的处置不是一回事**——去控制台按实际情况处置这一案。'}`)
  return { r: await board(base, boardId), degraded: true }
}

// 封板结案: 段尾 autoArchive 在案板形态下的对应物——那边是板内挑可交付的根归档(板还活着),
// 这边是整块案卷进终态。**只在板判可交付时被调用**(见 runSegment 段尾);停轮那条路要么不封,
// 要么带 RULITH_SEAL_ON_STOP 给的作废处置。RULITH_AUTO_SEAL=off 可关(案卷留在「在办」)。
// 返回 true=这块案卷已进终态,false=没封上(调用方据此把它记成「在办」并报案号)。
async function sealCase(ctx, reason, disposition) {
  // **服务板永不封板**(一客一板,2026-08-07): 板与这份服务同寿——封板是板级终态且不可逆,
  // 把它用在一个还在服务的客户身上,等于用一次段尾收尾把客户关系写死。这条守卫是**可执行断言**:
  // 调用链上任何一处将来把服务槽路由到这里,当场看得见,而不是安静地封掉某位客户的板。
  if (ctx.serviceBoard === true) {
    log(`◎ 服务板「${ctx.board}」不封板——一客一板与这份服务同寿(封板是不可逆终态);要结束这位客户,去运营面处置`)
    return false
  }
  if ((process.env.RULITH_AUTO_SEAL ?? '') === 'off') { log(`◎ Case "${ctx.board}" is complete, but RULITH_AUTO_SEAL=off. It remains active until you close it in Console.`); return false }
  // **义务清空由板说了算,不由客户端预测**(2026-08-18 冷通枪第五发): 封板门的真判据是五臂
  // (未回执动作/求证工单/可领动作/待清关案卷/待取材),我在这边只手抄了两臂 ⇒ 剩下三臂的
  // 未结项照样把封板顶回来,而客户端以为"可以封了"。**同一条判据不许写两份**——所以这里改成
  // 「试着封,板说还有未结就等一等再试」:板的门是唯一执行点,客户端一个字都不复述。
  // (只对 completed 重试: 作废是人的决定,不该被"还有活"拦着改判。)
  let { r, degraded } = await sealBoardOn(ctx.board, reason, disposition)
  if (r.accepted !== true && r.errorCode === 'work_pending' && disposition === 'completed') {
    const deadline = Date.now() + Math.max(0, DELIVERABLE_WAIT_MS)
    while (Date.now() < deadline) {
      log(`◌ 封板被顶回(${String(r.teaching ?? '').slice(0, 90)})——等未结项落地再试`)
      await new Promise((x) => setTimeout(x, 3000))
      ;({ r, degraded } = await sealBoardOn(ctx.board, reason, disposition))
      if (r.accepted === true || r.errorCode !== 'work_pending') break
    }
  }
  if (r.accepted === true) {
    const idem = r.payload?.idempotent === true
    log(`◎ Case "${ctx.board}" sealed (${disposition}${degraded ? '; the deployed server ignored this optional field' : ''})${idem ? ' (idempotent: already sealed)' : ''}. Writes are now rejected, reads remain available, and the record is visible in Console.`)
    emitOn(ctx, 'sealed', { board: ctx.board, idempotent: idem, disposition, ...(degraded ? { degraded: true } : {}) })
    return true
  }
  // 封不上**不静默**: 案卷会一直挂在「在办」占额度,人得知道该去看哪一块
  log(`◎ Case "${ctx.board}" could not be sealed: ${String(r.teaching ?? r.errorCode ?? '').slice(0, 200)}. It remains active and can be resolved in Console.`)
  return false
}

// ── 跨案连续性：三条腿，都不在这个文件里 ─────────────────────────────────
//
// **身份板实现已整件删除**（2026-08-07，用户裁决"收敛到目标形态"）。它此前是 opt-in 的
// `RULITH_IDENTITY_BOARD` + `COMMIT:` 裸行：一块常驻不封板的私有板，开案念给模型听、
// 封板前把这一段新许的承诺写回去。删它的三条理由，逐条是它自己暴露的：
//
//   ① **它记的是 asserted**——模型说的话就是话。用一块板去装"它说过"，换来的是一个新概念
//      （"同时操作多板"）和一份真上下文成本，而它承诺的那件事（跨案连续性）今天有更结实的答案。
//   ② **跨案身份已由配方指纹接管**（核心 board-spec BRD-112）：建板时 `CreateBoard{recipe}`
//      落 genesis 受信事实，"这一案是哪个智能体按哪版配方办的"从**案卷本身**答得出。
//      身份不再需要一块"记得"的板。
//   ③ **分槽之后它是真泄漏**：身份板不入槽（承诺是"这个智能体"答应过什么，不是"对这位客户"），
//      于是一客一板跑起来后，A 客户段里许的承诺会被念进 B 客户的开工上下文。
//      器官删掉，这条泄漏路径**构造性消失**——不是修好了，是没有了。
//
// 跨案连续性现在的三条腿，一条都不在这个文件里：
//   · **身份** = 配方指纹（BRD-112，建板时随 CreateBoard 发出，host 落 genesis）
//   · **承诺** = 长命板（BRD-113：一段需跨案存续的关系一块板；服务槽的服务板就是它的键法之一，
//                它本来就长命、本来就按客户隔离——承诺该落的地方一直是它，不是一块共享板）
//   · **结论** = `recallFacts` 同 Authority 显式召回（接地档保真，BRD-05/FED-42），不是裸断言
//
// **前提**：BRD-112 的配方指纹与 BRD-113 的长命板都已落地。前提失效 ⇒ 本删除自动作废，
// 从 git history 取回（commit 见本行所在提交的父提交链）。

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
  const pj = await board({ kind: 'GetProjection', format: 'json' }, ctx.board)
  if (pj.accepted !== true) return { roots: [], facts: [] }
  const facts = pj.payload?.context?.facts ?? []
  const roots = [...new Set(facts.filter((f) => f.atom?.predicate === 'root').map((f) => String(f.atom.args?.node ?? '')))].filter(Boolean)
  return { roots, facts }
}

const revisionNow = async (ctx) => String((await board({ kind: 'GetHealth' }, ctx.board))?.revision ?? '')

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
    const c = await board({ kind: 'GetCompletion', root }, ctx.board)
    if (c.accepted !== true) continue
    const leaves = c.payload?.leaves ?? []
    seen.push(...leaves)
    // 守卫键**带板**: 案板模式下节点名跨案卷天然重名(每单都有自己的 L1),只按节点名记
    // 「放过了」,第二单的同名叶子会被第一单的记录挡住——**永远等不到求证,certified 永远不来**。
    const key = (l) => `${ctx.board}::${l.node}`
    const fresh = leaves.filter((l) => l.met !== true && ctx.dischargedDigest.get(key(l)) !== l.digest)
    if (fresh.length === 0) continue
    for (const l of fresh) ctx.dischargedDigest.set(key(l), l.digest)
    const r = await board({ kind: 'RunDischarge', root, leaves: fresh.map((l) => String(l.node)) }, ctx.board)
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
    const c = await board({ kind: 'GetCompletion', root }, ctx.board)
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
 * 段一停轮就把那件事归掉,而 ArchiveTask 缺省按 `completed` 关账 ⇒ 没办完的活被记成办结
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
    const g = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx.board)
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
      const g3 = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx.board)
      const rearmed = (g3.accepted === true ? (g3.payload?.gaps ?? []) : []).some((x) => /work-ordered/.test(String(x.args?.reason ?? '')))
      if (!rearmed) break // 没在途也没义务,再等也不会变
    }
    // **同一句话只说一次**(2026-08-18 真机: 3 秒一轮打了十三行一模一样的等待行,把中栏刷成噪音)。
    // 内容变了(等的东西不一样了)才再说——**重复不是信息**,而屏幕上的位置是有限的。
    const waitLine = `◌ ${[inflight ? '求证在途' : '', open.length ? `未回执动作 ${open.join('/')}` : ''].filter(Boolean).join(' · ')}——等它们落地再判可交付(最多 ${Math.round(DELIVERABLE_WAIT_MS / 1000)}s)`
    if (waitLine !== lastWaitLine) { log(waitLine); lastWaitLine = waitLine }
    await new Promise((r) => setTimeout(r, 3000))
    final = await completionAll(ctx)
  }
  const deliverable = final.roots.length > 0 && final.certified === true && final.allDone === true
  const why = final.roots.length === 0
    ? '板上没有任务树——这一段没有可交付物(纯回话/开工即停都是这个形状)'
    : `板未判可交付(certified=${final.certified} · floor=${final.floor} · ${final.state})`
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

/** 板报缺口的**唯一读取点**（全板视图与每轮指引共用一份判据）。
 *  **在途不是缺口**（2026-08-18 冷通枪逮到）：`work-ordered` = 求证工单已派给真探、正在等回话，
 *  是**正常在途态**。把它摆进"还差什么（优先处理）"那一栏，模型会合理地判断"卡住了"并停轮
 *  ——真机上它 15 秒就收工，活干完了却不结案。在途单独一栏说清"等着就行"。 */
async function boardGaps(ctx) {
  const g = await board({ kind: 'QueryBoard', include: ['gaps'] }, ctx.board)
  const all = g.accepted === true ? (g.payload?.gaps ?? []) : []
  const isFlight = (x) => /work-ordered/.test(String(x.args?.reason ?? ''))
  return { gaps: all.filter((x) => !isFlight(x)), inFlight: all.filter(isFlight) }
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
Do not supply business identifiers, amounts, addresses, or other business arguments from conversation. Include args only when a legacy board explicitly teaches that compatibility form. Continue only after a terminal receipt with done=true; done=false means accepted for processing, not succeeded.

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
rulith-agent · Agent "${agentName}" · ${URL_BASE}`)
// 配方在**开第一块板之前**取: 之后每一次建板都带着同一枚出身指纹(BRD-112)
await fetchRecipe()
/** 配方出处的一句人话——三种来源(云上/本地/没有)得看得见,不然"我明明装了包"会变成悬案。 */
const recipeLine = () => (
  recipePath !== '' ? `${recipePath} (local file · ${RECIPE.packs.length} package(s) · ${RECIPE.seed.length} seed operation(s))`
  : RECIPE.ref !== undefined ? `Cloud recipe "${RECIPE.ref.id}" (${RECIPE.packs.length} package(s) · digest ${RECIPE.ref.digest.slice(0, 19)}…)`
  : 'empty (bare board; no packages installed)'
)
if (CASE_BOARDS) {
  log(`Case-board mode: every task opens a new case (${CASE_PREFIX}-…), and completed cases are sealed. Recipe: ${recipeLine()}`)
}

// 案板模式下每一单是控制台登记簿里独立的一行(名字=案号),所以核对地址按**当前案卷**出——
// 指着智能体名那一页会让人去看一块根本没这单的板。
const consoleUrlOf = (name) => `https://console.rulith.com/agents/${encodeURIComponent(name)}`
const consoleUrl = consoleUrlOf(agentName)
/** 停轮未结时终端上的那一句(三张脸共用一份措辞——同一件事三种说法比不说更糟)。 */
const pendingLine = (id) => (id === null || id === undefined ? '' : ` · Case remains open: pending_case_id=${id}. Resume with --case ${id}, or resolve it in Console.`)

// ── 锁态探测(2026-08-01 立法权锁,「看不见」优先于「拒得住」): 锁定板的系统提示
//    **根本不含**立规则/定义动作的模板——不给把手,模型就不会伸手去摸、也不会烧轮数撞拒绝。 ──
const SYSTEM_LOCKED = `You are a domain-agnostic Rulith execution agent. Legislative authority is locked on this board. The current board and its installed packs are the only source of domain semantics: vocabulary, rules, actions, parameter shapes, and acceptance names. Concrete goals and instance values come from the user task, board facts, and trusted tool results. Placeholders in this prompt are not domain facts.

Do not invent predicates, actions, or acceptance names. Do not attempt add_axiom, define_action, RegisterPack, or unlock the board. If a required domain capability is missing, reply STOP: and identify it.

${EXECUTION_GUIDE}`

// ══ 会话槽（2026-08-07 一客一板；「四处进程级单例」在这里被全部收编）═══════════
//
// 从前本文件的循环状态是**四处进程级 let**: currentBoard(板寻址口)/messages(转录)/
// dischargedDigest+lastLeaves(放电守卫)/lawProbed+segmentTrail(锁态与段留痕)。
// 一进程一条转录时那是最简的形态,也正是"并发只能是 1"那条裁决的**全部前提**。
// 服务形态(一个进程服务几万客户)要的是"一客一板、互不相干",于是这四处全部搬进槽对象——
// 前提没了,那条裁决按门牌纪律自动作废,跨槽并发随之合法。
//
// 槽 = 一条对话 + 一块板 + 一份放电记账 + 一条 FIFO。**同槽恒串行**(一个客户的两单织进
// 同一条转录才是那条命门的真形状);**跨槽可并行**(它们之间没有一个字节是共享的)。
// SYSTEM_ACTIVE 也入槽: 锁态是**板的**属性(装了什么包),两块板锁态不同就该念不同的系统提示。
const makeSlot = (key, boardId, opts = {}) => ({
  key,                              // sessionKey;'' = 缺省槽(不带 key 的任务与 REPL/CLI 都住这里)
  board: boardId,                   // 这个槽的板寻址口(案板模式下每段被开单换成新案卷)
  messages: [],                     // 转录(**只在本机**,不上板)
  segmentTrail: [],                 // 段留痕(压缩后唯一留下来的东西)
  dischargedDigest: new Map(),      // 放电守卫: `板::节点` → 放过的 spec 版本
  lastLeaves: [],                   // 脉冲用
  lawProbed: false,                 // 锁态探针只探一次(同配方开出的板锁态相同)
  system: SYSTEM,     // 该槽此刻念的系统提示(锁态探到就换成 SYSTEM_LOCKED 那版)
  caseMode: opts.caseMode === true, // 这个槽走不走一单一板(服务槽恒 false: 它的板长命)
  serviceBoard: opts.serviceBoard === true, // 服务板(一客一板): 永不封板,段尾走 autoArchive
  ready: opts.ready === true,       // 服务板 find-or-create 是否已办妥
  broken: '',                       // 非空 = 这个槽的板供给失败,不再接单(如实报,不假装能办)
  queue: [],                        // 本槽待办(同槽 FIFO)
  busy: false,                      // 本槽是否有段在跑
  taskId: undefined,                // 在办任务号(事件标注用)
  lastUsed: Date.now(),             // LRU 用
})
// **缺省槽**: 不带 sessionKey 的一切(REPL / CLI / --serve 无 key 任务)都跑在它上面,
// 行为与分槽之前逐字节等价。它**永不被驱逐**(stdin/UI 插话、CLI 收尾读板都指着它)。
const defaultSlot = makeSlot('', agentName, { caseMode: CASE_BOARDS })
// 锁态读板自述(锁合一 2026-08-03): GetBoardManifest.lawLocked=权威端真相
// (旧 GetCapabilities.lawLocked 是网关洗上去的便利标,已随便利层锁退役;老 boardd 无自述=不锁)
//
// 案板模式下探针要落在**案卷**上、且只探一次: 同一份配方开出的板锁态相同(锁来自装了什么包),
// 每单再探一遍纯属给开单成本添砖。所以这里是"首次可探时探,探过就记住"。
async function probeLawLock(ctx) {
  if (ctx.lawProbed) return
  ctx.lawProbed = true
  const mf = await board({ kind: 'GetBoardManifest' }, ctx.board)
  if (mf.accepted === true && mf.payload?.lawLocked === true) {
    ctx.system = SYSTEM_LOCKED
    log(`Board legislation is locked. Rules come from packages installed by the board owner; this Agent executes under them.${ctx.key === '' ? '' : ` (session ${ctx.key})`}`)
  }
}
// 单板长跑: 开工前探那块长命板。案板模式: 板还没开出来,推迟到第一次开单之后。
if (!CASE_BOARDS) await probeLawLock(defaultSlot)

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
 *  返回 `{ note, pendingCaseId }`：`note` 是板的判词/停轮原因，`pendingCaseId` 是**没结掉的案号**
 *  （非 null 即「这一单还在办」）。两个字段一起才说得清一段的结局——只回 note 的形状，
 *  正是「停轮被读成结案」的那条缝。 */
async function runSegment(ctx, userText) {
  const messages = ctx.messages
  compactTranscript(ctx) // 段起始先收窗——切口落在段边界最干净,不会切断本段的推理链
  // ── 开单(CB-30): **新段=新板**。对话历史照旧跨段留在本机,板只承载这一单的案卷。
  //    `ctx.caseMode` 而不是全局 CASE_BOARDS: 服务槽(一客一板)在同一个进程里恒 false——
  //    它的板长命,没有"这一段就是一单"这回事。 ──
  let sealHealed = false
  let boardSealedStop = false
  if (ctx.caseMode) {
    const useResume = resumeCase
    resumeCase = '' // **只作用于第一段**: 用完即清,之后每段照常开新案(一段=一单)
    const opened = await openCase(ctx, caseTitleOf(userText), undefined, useResume)
    if (!opened.ok) {
      // 建出来了但没装齐: 把「当前板」指向它——读照常,收尾那句核对地址才指得到真正该看的那块
      if (opened.built) ctx.board = opened.id
      const note = `Could not open the case; this task did not start: ${opened.teaching.slice(0, 300)}`
      // 半成品已作废(补偿式原子)就不是「在办」;作废不掉的才留案号要人处置
      const stranded = opened.built === true && opened.abandoned !== true ? opened.id : null
      log(`
✗ ${note}${stranded === null ? '' : `
   (Case "${stranded}" exists but is not fully configured and could not be abandoned. It remains open for review in Console.)`}`)
      emitOn(ctx, 'case-open', { board: opened.id, ok: false, teaching: opened.teaching, ...(stranded === null ? {} : { pendingCaseId: stranded }) })
      ctx.segmentTrail.push(`${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} → ${note}`)
      return { note, pendingCaseId: stranded }
    }
    ctx.board = opened.id
    log(`
Case opened: "${opened.id}" · ${opened.packs} package(s) · ${opened.seeded} seed operation(s)`)
    emitOn(ctx, 'case-open', { board: opened.id, ok: true, title: caseTitleOf(userText), packs: opened.packs, seeded: opened.seeded })
    await probeLawLock(ctx)
  }
  // ── 一单一 Work(BRD-113 稳态形态)──────────────────────────────────────────
  //
  // 这块板要是长命板(服务板恒是,云上的默认工作板也可能是),**本段先在它上面开一件事**,
  // 此后本段的每一发门内 op 都自动带上信封(见 `board()`)。root=本单(接单形态下就是那个
  // 单号,产品面 /runs 上看得见的同一个),因为段尾的 ArchiveTask.root 必须逐字等于它。
  // case 板与老 boardd 一律返回 undefined ⇒ 行为与从前一字不差(零回归)。
  //
  // 位置在**开单之后、读板之前**: 第一发读(projectionText 的 GetProjection)就已经在门内了。
  if (!ctx.caseMode) await ensureBoardWork(ctx, ctx.taskId ?? `seg_${Date.now().toString(36)}_${seq++}`)
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
          const r = await board(c, ctx.board)
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
              emitOn(ctx, 'verdict', { accepted: true, cmd: c.kind, done: false, added: (r.delta?.added ?? []).length, revision: r.revision ?? '', ...(inv !== '' ? { invocation: inv } : {}) })
              lines.push(`${head} was accepted${tag}, but no terminal receipt has landed. It may be awaiting clearance or Worker pickup. Do not treat it as complete; reread the board for effect_confirmed.`)
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
      const boardHasWork = CHAT && !nudged && (await boardGaps(ctx)).length > 0
      if (boardHasWork) {
        nudged = true
        feedback = 'Your previous reply described a submission but included no JSON block. Submit board operations as a JSON array, or one top-level command such as ApplyAction as an object with kind. If nothing remains, reply DONE: or STOP:.'
      } else if (CHAT) { note = 'response only (no board operation)'; done = true }
      else feedback = 'No JSON submission was found. Return a JSON array for board operations, one object with kind for a top-level command such as ApplyAction, or finish with DONE: or STOP:.'
    } else {
      const r = await board({ kind: 'ApplyBatch', operations: ops }, ctx.board)
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
        if (String(r.errorCode ?? '') === 'board_sealed') {
          // **board_sealed 是唯一一种"照着改"没有出路的拒**: 案卷已结,同一块板上再提一万次也是拒。
          // 教学回流因此要自愈——案板模式当场另开一单接着办(人有可能在控制台把这块案卷结了);
          // 单板长跑与**服务板**(一客一板)都没有"另开"这条路: 前者的板就是那一块,后者的板名由
          // sessionKey 定死(另开=换客户),被外力封了如实停并报出路——服务板归运营面管。
          //
          // **续办要带前案**(BRD-110,0.21.0): 新案 CreateBoard 带 `predecessor: <旧案板名>`,
          // 承继链才发得出去。没有它,「一件事经误封→重办」在绩效面上是 1 completed + N cancelled——
          // 老实续办反被记成一串废案(网关登记簿按 predecessor 聚合案链,见 gateway.ts recordCreate)。
          const sealedBoard = ctx.board
          const healed = ctx.caseMode && !sealHealed ? await openCase(ctx, caseTitleOf(userText), sealedBoard) : { ok: false }
          if (healed.ok) {
            sealHealed = true
            ctx.board = healed.id
            lastRevision = await revisionNow(ctx)
            log(`The previous case was already sealed. Opened successor case "${healed.id}" with predecessor "${sealedBoard}" and installed the recipe.`)
            emitOn(ctx, 'case-open', { board: healed.id, ok: true, healed: true, predecessor: sealedBoard })
            feedback = `The previous board is sealed (board_sealed). Reads remain available, but no further write can succeed there.
Successor case "${healed.id}" is ready with the recipe installed. Materials were not copied automatically; resubmit this operation and its required premises on the new case.`
          } else {
            boardSealedStop = true
            note = ctx.serviceBoard
              ? `Service board "${ctx.board}" is sealed (board_sealed). Writes are frozen; this task has stopped.`
              : 'The board is sealed (board_sealed). Writes are rejected; this task has stopped.'
            log(`
⚠ ${note}。${ctx.serviceBoard
  ? '一客一板的板名由 sessionKey 定死,客户端不会替你另开一块(另开=换了个客户)。封板不可逆,**没有解封**——要续办这位客户,给他换一个 sessionKey 落新板(旧板结论要搬,走运营面的显式召回);旧板读面照常,案卷仍可审计。'
  : '案卷定稿后要办新的事得开一块新板（--case-boards 会每段自动开单）。'}`)
            break
          }
        } else feedback = `The board rejected this batch:\n${teaching}\n\nCorrect the request using that guidance and submit again.`
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
  let shadowClear = true
  if (withShadow && !boardSealedStop) shadowClear = await shadowReview(ctx, userText)
  // ── 单尾(CB-30 + review P0-2「停轮≠结案」)────────────────────────────────
  //
  // 封板是**板级终态**,不可逆。所以自动封板的判据只有一条: **板判可交付**
  // (`certified===true` 且每个根的 state 真是 done)。模型说 DONE、连轮无进展、到轮上限、
  // 板上根本没有任务树——这些都只是**停轮**,不是办结:案卷留在「在办」,案号报出来,
  // 人与下一段都还能接着办。绩效面数的是登记簿的已结,所以这条判据同时也是账的诚实。
  //
  // **服务槽(一客一板)走的是 else 那条腿**: `ctx.caseMode` 恒 false ⇒ 段尾只 `autoArchive()`,
  // 一发 SealBoard 都不会打出去。RULITH_AUTO_SEAL / RULITH_SEAL_ON_STOP 两个旋钮都在
  // caseMode 这条腿里面,因此对服务槽天然不生效——板与这份服务同寿,没有"这一段办完就结案"这回事。
  let pendingCaseId = null
  if (boardSealedStop) {
    log('The board is already sealed; no final write was attempted.')
  } else if (!shadowClear) {
    if (ctx.caseMode) pendingCaseId = ctx.board
    log(ctx.caseMode
      ? 'Shadow review raised a finding. The case remains open and the shadow_finding is on the board.'
      : 'Shadow review raised a finding. Automatic archival was skipped and the shadow_finding is on the board.')
  } else if (ctx.caseMode) {
    // 判据在 `deliverableNow`(长命板腿共用同一个执行点)。
    const { deliverable, why } = await deliverableNow(ctx)
    if (deliverable) {
      if (!await sealCase(ctx, note, 'completed')) pendingCaseId = ctx.board
    } else if (SEAL_ON_STOP !== '') {
      // **显式选择作废**: 配了 RULITH_SEAL_ON_STOP 才在停轮时封,且带的是作废处置——
      // 这是运维的一次决定("这条线上的停轮单一律作废"),不是缺省行为。
      log(`The task stopped before certification. RULITH_SEAL_ON_STOP=${SEAL_ON_STOP} explicitly closes it with that disposition (${why}).`)
      if (!await sealCase(ctx, `${note} | stop disposition ${SEAL_ON_STOP}: ${why}`, SEAL_ON_STOP)) pendingCaseId = ctx.board
    } else {
      pendingCaseId = ctx.board
      log(`
Case "${ctx.board}" remains open: ${why}.
   Stopping is not completion. Resume with --case ${ctx.board}, or resolve it in Console. To close stopped work explicitly, set RULITH_SEAL_ON_STOP=cancelled|failed|abandoned.`)
      emitOn(ctx, 'case-pending', { board: ctx.board, reason: why, note })
    }
  } else if (autoArchiveOff()) {
    // 旋钮的判据落在**两条归档腿共同的调用点**上(2026-08-17)。从前它只写在 `autoArchive()`
    // 里边,于是长命板腿(`archiveBoardWork`)根本不看它——门牌承诺的「可关」对现役形态是假的。
    log('RULITH_AUTO_ARCHIVE=off: no work was archived. The board remains unchanged for operator review.')
  } else if (workOf.has(ctx.board)) {
    // 长命板形态: 段尾归的是**这一单那件事**(ArchiveTask,不是 SealBoard——服务板恒不封)。
    // 归一件事就把它整个局部面收起,所以不必再逐根 autoArchive;而 `ArchiveTask.root` 必须逐字
    // 等于 OpenWork 冻结的那个 root,逐根归反而会被权威端当 bad_command 拒。
    // 影子有异议时走的是上面那条腿(不归档)——同一条纪律的两个投影,牙齿仍在。
    //
    // **三重判据与案板腿同源**(2026-08-17 orders-bt 真机): 此前这一发是**无条件**的,
    // 段一停轮就归,而 ArchiveTask 缺省按 completed 关账 ⇒ 没办完的活被记成办结,
    // 半途案卷进冷层,受信回执与续办者都看不见它。归得掉才归,归就说清是 completed。
    const { deliverable, why } = await deliverableNow(ctx)
    if (deliverable) await archiveBoardWork(ctx, 'completed')
    else {
      const bound = workOf.get(ctx.board)
      log(`
This segment remains open: ${why}.
   Work ${bound?.id ?? '?'} (root ${bound?.root ?? '?'}) remains on the board for the next segment. Archiving unfinished work would remove the receipt target and falsely record completion.`)
      emitOn(ctx, 'work-pending', { board: ctx.board, work: bound?.id, root: bound?.root, reason: why, note })
    }
  } else await autoArchive(ctx) // 单板长跑(case/老 boardd)照旧清板: 可交付的根归档,下一段在干净的板上开工
  // 段边界留痕: 这一行是压缩后**唯一**留下来的东西,所以要写得能独立读懂——
  // 用户说了什么 + 板判如何。细节不写,细节在板上。案板形态多带一个案号:
  // 新段=新板之后,"上一单在哪块案卷上"是跨单衔接唯一还找得回来的线头。
  ctx.segmentTrail.push(`${ctx.caseMode ? `[case ${ctx.board}${pendingCaseId === null ? '' : ' · open'}] ` : ''}${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} → ${note}`)
  if (ctx.segmentTrail.length > 40) ctx.segmentTrail.splice(0, ctx.segmentTrail.length - 40) // 留痕本身也要有上界
  return { note, pendingCaseId }
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
  const r = await board({ kind: 'ApplyBatch', operations: ops }, ctx.board)
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
  // 本机显式 env 优先；未配时采用 Console 随配方下发的最大并行案件数。
  const wantedConcurrency = Number(process.env.RULITH_SERVE_CONCURRENCY ?? RECIPE.maxConcurrentCases ?? 1)
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
  let serveSeq = 0
  // 在跑的段(按开跑先后),`inFlight.length` 即跨槽并发数,上界 = SERVE_CONCURRENCY。
  // 它同时是 /runs 快照里 running/runningAll 的来源——**一份状态一处存**。
  const inFlight = []
  const pushRun = (r) => { runs.push(r); while (runs.length > SERVE_RUNS_MAX) runs.shift() }

  // ── 会话槽表(一客一板)─────────────────────────────────────────────────
  //
  // Map 的迭代顺序=插入顺序,LRU 因此只要"命中即删了再塞"就成立,不必另存时间堆。
  // 缺省槽**不进这张表**: 它不占上界、永不被驱逐(stdin/UI 插话与 CLI 收尾都指着它)。
  const sessions = new Map()
  /** 到上界就驱逐**最久未用的闲置槽**(在跑的、还有排队的都不动)。
   *  驱逐丢的是**内存转录**——板在服务端 journal 里一个字不丢,该 key 再来单会重建槽、重读投影,
   *  代价是那位客户的对话上下文断了一次(板上的事实没断)。这是"内存必须有上界"的价钱,写在明处。 */
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
      const s = sessions.get(victim)
      sessions.delete(victim)
      // Work 绑定跟着槽走(否则这张表随驱逐单调增长)。**丢的只是本机的记性**: 那件事在服务端
      // 还开着,这个 key 再来单时 ensureBoardWork 会从板的清单上把它认领回来。
      workOf.delete(s.board)
      log(`Evicted least-recently-used idle session "${victim}" at the ${SERVE_SLOTS_MAX}-slot limit. Board ${s.board} is unchanged; only the local transcript was released.`)
      emit('slot-evicted', { session: victim, board: s.board, slots: sessions.size })
    }
  }
  /** 取(或建)某个 sessionKey 的槽。**服务槽 = 一客一板**: 板名由 key 确定性推导,
   *  caseMode 恒 false(它的板长命,没有"一段=一单"这回事),serviceBoard=true(段尾永不封板)。 */
  const slotFor = (sessionKey) => {
    if (sessionKey === '') return defaultSlot
    const hit = sessions.get(sessionKey)
    if (hit !== undefined) {
      sessions.delete(sessionKey); sessions.set(sessionKey, hit) // LRU: 命中即挪到队尾
      hit.lastUsed = Date.now()
      return hit
    }
    evictIfNeeded()
    const slot = SERVE_CASE_SLOTS
      ? makeSlot(sessionKey, agentName, { caseMode: true, serviceBoard: false })
      : makeSlot(sessionKey, serviceBoardName(sessionKey), { caseMode: false, serviceBoard: true })
    sessions.set(sessionKey, slot)
    log(SERVE_CASE_SLOTS
      ? `Opened work slot "${sessionKey}" (one task per case board; ${sessions.size}/${SERVE_SLOTS_MAX} slots).`
      : `Opened session "${sessionKey}" on service board "${slot.board}" (${sessions.size}/${SERVE_SLOTS_MAX} slots).`)
    emit('slot-open', { session: sessionKey, ...(SERVE_CASE_SLOTS ? {} : { board: slot.board }), slots: sessions.size, ...(SERVE_CASE_SLOTS ? { mode: 'case' } : {}) })
    return slot
  }
  /** 服务板的 find-or-create。**首建才装配方播种,复用不重播**——这不是省事,是正确性:
   *  RegisterPack 只在**带 digest** 时幂等(同 (packType,name,version) 同指纹=零写;异指纹=冲突拒);
   *  不带 digest 的重装会把同一个领域包再并进一次(核心 command-handler `domainPacks.set([...旧, 新])`),
   *  宪法包会再播一遍种。查证于 rulith 核心 src/protocol/command-handler.ts 的 RegisterPack 臂。
   *  所以复用时一发都不重播——板上已有的制度就是那一份。 */
  const ensureServiceBoard = async (ctx) => {
    if (ctx.ready) return true
    if (ctx.broken !== '') return false
    // 服务板的配方出身与案板同源(BRD-113: 长命板的配置与案板同一份配方,差别只在它不封板)
    const mk = await board({ kind: 'CreateBoard', id: ctx.board, title: `${agentName} · session ${ctx.key}`,
      lifecycle: 'long_lived', workConcurrency: 'serial_activation',
      ...(RECIPE.ref !== undefined ? { recipe: RECIPE.ref } : {}) }, ctx.board, 'continuous')
    const existed = boardAlreadyExists(mk)
    if (mk.accepted !== true && !existed) {
      ctx.broken = String(mk.teaching ?? mk.errorCode ?? 'CreateBoard rejected')
      log(`✗ Could not create service board "${ctx.board}": ${ctx.broken.slice(0, 240)}`)
      return false
    }
    if (existed) {
      // **复用**: 板上已有这位客户的全部历史(服务端 journal),配方一发都不重播。
      log(`Service board "${ctx.board}" already exists. Reusing it without replaying the recipe.`)
      ctx.ready = true
      await probeLawLock(ctx)
      return true
    }
    // **首建**: 配方照发一遍(与开单序列同一份数据)。这里失败留下的是一块**半装配的服务板**,
    // 而服务板**没有作废封板这条出路**(封板是不可逆终态,不能拿它收拾一位在服务的客户)。
    // 所以: 标记这个槽 broken、如实报出板名,让运营面处置——**不自动重试**,因为不带 digest 的
    // 配方重试会把已装上的那几个包再装一遍。要能安全重试,给配方每个包加 digest。
    for (const p of RECIPE.packs) {
      const name = String(p.pack?.meta?.name ?? p.packType)
      const r = await board({ kind: 'RegisterPack', packType: p.packType, pack: p.pack, ...(typeof p.digest === 'string' ? { digest: p.digest } : {}) }, ctx.board)
      if (r.accepted !== true) {
        ctx.broken = `Recipe package "${name}" (${p.packType}) was rejected: ${String(r.teaching ?? r.errorCode ?? '')}`
        log(`✗ Service board "${ctx.board}" is partially configured: ${ctx.broken.slice(0, 240)}
   The board remains available for operator review, but this slot will not accept work. Add digests to every package before retrying so installation is idempotent.`)
        emit('slot-broken', { session: ctx.key, board: ctx.board, why: ctx.broken })
        return false
      }
    }
    // ── 播种落哪一层,取决于板的寿命(2026-08-10)──────────────────────────────
    //
    // 首建的长命板停在 `initializing`: 那个状态下连 OpenWork 都拒,门内的 ApplyBatch 更发不出去。
    // 而**首版 Baseline 的激活与播种是同一笔**(核心明令: initializing 板的 MaintainBaseline
    // 必须带 activate:true 才验证并开放 OpenWork)。所以配方种子落 **Baseline** 而不是某一单的
    // Work——它是板级共享材料,放进第一单的 Work 里第二单就看不见了。"先激活再开工"这件事
    // 因此在这里一次办妥(`ensureBoardWork` 里的懒激活是兜底,不是主路)。
    const mf0 = await board({ kind: 'GetBoardManifest' }, ctx.board)
    const life0 = lifecycleOf(mf0)
    const seeded = life0?.kind === 'long_lived'
      ? (life0.status === 'initializing'
        ? await board({ kind: 'MaintainBaseline', operations: RECIPE.seed, activate: true }, ctx.board)
        : RECIPE.seed.length > 0 ? await board({ kind: 'MaintainBaseline', operations: RECIPE.seed }, ctx.board) : { accepted: true })
      : RECIPE.seed.length > 0 ? await board({ kind: 'ApplyBatch', operations: RECIPE.seed }, ctx.board) : { accepted: true }
    if (seeded.accepted !== true) {
      ctx.broken = `Seed (${RECIPE.seed.length} operation(s)${life0?.kind === 'long_lived' ? ', initial Baseline' : ''}) was rejected: ${String(seeded.teaching ?? seeded.errorCode ?? '')}`
      log(`✗ Service board "${ctx.board}" is partially configured: ${ctx.broken.slice(0, 240)}. This slot will not accept work; resolve it in Console.`)
      emit('slot-broken', { session: ctx.key, board: ctx.board, why: ctx.broken })
      return false
    }
    log(`Service board "${ctx.board}" created with ${RECIPE.packs.length} package(s) and ${RECIPE.seed.length} seed operation(s). Future use will not replay them.`)
    emit('slot-provisioned', { session: ctx.key, board: ctx.board, packs: RECIPE.packs.length, seeded: RECIPE.seed.length })
    ctx.ready = true
    await probeLawLock(ctx)
    return true
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
    ok: true, agent: agentName, url: URL_BASE,
    concurrency: SERVE_CONCURRENCY, caseBoards: CASE_BOARDS,
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
        // **教学拒不截断**: 静默截断会把两个不同客户的长 key 折成同一块板(串板),
        // 那比拒绝一单严重得多——一客一板的全部意义就在"两位客户的材料不进同一次闭包"。
        if (sessionKey.length > SESSION_KEY_MAX) {
          return deny(`sessionKey exceeds ${SESSION_KEY_MAX} characters (${sessionKey.length} received). It cannot be truncated because it determines board identity. Use a short stable identifier such as your system's user id.`, 400)
        }
        const slot = slotFor(sessionKey)
        const item = { id: `task_${Date.now().toString(36)}_${serveSeq++}`, text, at: Date.now(), sessionKey }
        slot.queue.push(item)
        slot.lastUsed = item.at
        const depth = allSlots().reduce((n, s) => n + s.queue.length, 0)
        emit('task-queued', { id: item.id, text: item.text, depth,
          ...(sessionKey === '' ? {} : { session: sessionKey, ...(slot.serviceBoard ? { board: slot.board } : {}) }) })
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, id: item.id, queued: depth,
          ...(sessionKey === '' ? {} : { sessionKey, ...(slot.serviceBoard ? { board: slot.board } : {}) }),
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
Task endpoint ready (serial within a slot · ${SERVE_CONCURRENCY} concurrent slot(s) · ${SERVE_SLOTS_MAX} ${SERVE_CASE_SLOTS ? 'work' : 'session'} slot limit): http://127.0.0.1:${SERVE_PORT}
  Submit: curl -s -XPOST http://127.0.0.1:${SERVE_PORT}/task -H 'content-type: application/json' -H 'x-rulith-serve: ${SERVE_KEY}' -d '{"text":"…"}'
  ${SERVE_CASE_SLOTS ? 'Parallel cases: give every task a short-lived sessionKey; each slot receives an independent case board that is sealed on completion.' : 'One customer per board: a stable sessionKey selects that customer\'s long-lived service board.'}
        -d '{"text":"…","sessionKey":"${SERVE_CASE_SLOTS ? 'ctx-1' : 'user-42'}"}'
  Inspect: curl -s 'http://127.0.0.1:${SERVE_PORT}/runs?k=${SERVE_KEY}'
  The key is randomized on every start. Loopback alone is not an authorization boundary.`)
  emit('start', { agent: agentName, url: URL_BASE, task: '(task endpoint)', projection: '', concurrency: SERVE_CONCURRENCY,
    ...(SERVE_CASE_SLOTS ? { mode: 'parallel_cases' } : {}) })

  /** 办一单(某个槽的队首)。**同槽恒串行**由 `slot.busy` 保证,跨槽由 `inFlight` 的长度封顶。 */
  async function runOne(slot) {
    const item = slot.queue.shift()
    if (item === undefined) return
    slot.busy = true
    slot.lastUsed = Date.now()
    slot.taskId = item.id
    const flight = { id: item.id, text: item.text, startedAt: Date.now(),
      ...(slot.key === '' ? {} : { sessionKey: slot.key, ...(slot.serviceBoard ? { board: slot.board } : {}) }) }
    inFlight.push(flight)
    emit('task-start', { id: item.id, text: item.text,
      ...(slot.key === '' ? {} : { session: slot.key, ...(slot.serviceBoard ? { board: slot.board } : {}) }) })
    log(`
▶ Task ${item.id}${slot.key === '' ? '' : ` (session ${slot.key} · board ${slot.board})`}: ${item.text}`)
    let note = ''
    let pendingCaseId = null
    try {
      // 服务槽先把板办妥(find-or-create;首建才装配方)。办不妥就**不办这一单**——
      // 拿一块没装上制度的板干活,比不干活危险。
      if (slot.serviceBoard && !(await ensureServiceBoard(slot))) {
        note = `Service board is not ready; task was not started: ${slot.broken || 'CreateBoard failed'}`
        log(`✗ ${note}`)
      } else {
        const seg = await runSegment(slot, item.text)
        note = seg.note
        pendingCaseId = seg.pendingCaseId
      }
    } catch (e) {
      // 一单办炸**不许掀翻整个队列**: 如实记档,接着办下一单(无人值守的第一要务是活着)
      note = `Task aborted with an unexpected error: ${e?.message ?? e}`
      // 炸了的那一单**当然没结**: 案板形态下把案号留给调用方(否则这一单从产品面消失)
      if (slot.caseMode) pendingCaseId = slot.board
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
      // 板名: 案板形态是这一单的案卷,服务形态是这位客户的服务板——两种都要出现在记录里,
      // 否则调用方拿到一句 note 却不知道该去看哪块板。
      ...(slot.caseMode || slot.serviceBoard ? { board: slot.board } : {}),
      ...(slot.key === '' ? {} : { sessionKey: slot.key }),
      // 未结的案号进 run 记录: 调用方(网站后端)据它决定"要不要接着办 / 要不要报给人",
      // 只给一句 note 的话,"停轮"与"办结"在机器眼里长得一模一样。
      ...(pendingCaseId === null ? {} : { pendingCaseId }),
      console: slot.caseMode || slot.serviceBoard ? consoleUrlOf(slot.board) : consoleUrl,
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
  if (TASK !== '') { defaultSlot.queue.push({ id: `task_${Date.now().toString(36)}_${serveSeq++}`, text: TASK, at: Date.now(), sessionKey: '' }); pump() }
} else if (!CHAT) {
  // ── 一次办完(CI/脚本形态,行为不变) ──
  log(`Task: ${TASK}
`)
  emit('start', { agent: agentName, url: URL_BASE, task: TASK, projection: '' })
  const { note, pendingCaseId } = await runSegment(defaultSlot, TASK)
  // 封板后**读照常**——案卷定稿仍须可审计,所以收尾这一读在两种形态下都成立
  const after = await projectionText(defaultSlot)
  const seen = CASE_BOARDS ? consoleUrlOf(defaultSlot.board) : consoleUrl
  log('\n──────── Final authoritative board state ────────')
  log(after)
  if (pendingCaseId !== null) log(`⚠ This case remains open: pending_case_id=${pendingCaseId}. Resume with --case ${pendingCaseId}, or resolve it in Console.`)
  log(`
Verify the task tree, work items, and conclusions in Console: ${seen}
`)
  emit('end', { ok: note.includes('干完'), note, projection: after, console: seen, ...(pendingCaseId === null ? {} : { pendingCaseId }) })
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

  log(CASE_BOARDS
    ? 'Interactive case-board mode. Every message opens a new case; completed cases are sealed and remain auditable in Console.'
    : `Interactive mode. Verify task trees, work items, and conclusions in Console: ${consoleUrl}`)
  log('The transcript stays on this machine and is not written to the board. Empty lines are ignored. Use exit, quit, or Ctrl+C to stop.\n')
  emit('start', { agent: agentName, url: URL_BASE, task: '(interactive)', projection: '' })
  for (;;) {
    if (inbox.length === 0 && (stdinOpen || withUi)) process.stdout.write('You> ')
    const line = await nextInput()
    if (line === null) break
    if (line === 'exit' || line === 'quit') break
    emit('user', { text: line }) // 每张脸都看得到谁问了什么(晚开的浏览器也补得到)
    queuedAtSegmentStart = inbox.length // 水位线: 此刻排着的都是「下一段」,之后到的才是插话
    const { note, pendingCaseId } = await runSegment(defaultSlot, line)
    emit('segment-end', { note, ...(CASE_BOARDS ? { board: defaultSlot.board } : {}), ...(pendingCaseId === null ? {} : { pendingCaseId }) })
    log(`
· ${note}${pendingLine(pendingCaseId)} · Verify in Console: ${CASE_BOARDS ? consoleUrlOf(defaultSlot.board) : consoleUrl}
`)
  }
  rl.close()
  log('Stopped.')
  process.exit(0)
}
