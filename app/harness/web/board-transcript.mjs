import { createHash } from 'node:crypto';
// Deep Rulith 的板视图转录（D-1008e，所有者 2026-10-08 批准沿用最初 galaxy-core 的 delta-history 设计；2026-10-26 起按
// D-1026b“两次减负之间只追加”）。
//
// Rulith 每个工具结果都带当时的板视图（view）和操作条（operations）。原样留在对话里，几十份几乎相同的板叠在一起：
// 模型要自己比对哪里变了（幻觉的来源），旧板还可能被当成当前局面，上下文也越滚越大。这里在每次请求模型之前，
// 把对话里新到的 Rulith 结果排成历史形态（只改模型看到的那份；界面上的对话原文不变）：只留这一步的变化（`+`／`-` 行）。
// 当前的整个视图（最新一份带板结果的整个视图，每行一项；新增的行前标 `+`，消失的行以 `-` 列出，未变的标 `=`）不写进
// 会话：currentBoard 在这里按同样的规则算出它，outgoing-trim.mjs 只在发出的副本里把它接在最后一条消息的末尾。
//
// 两次减负之间只追加（D-1026b，所有者 2026-10-26 批准）：以前最新一份排成整视图，下一份到来时再改写成变化（降级），
// 而上一份“最新”可能在很远处（中间隔着几份三万字符以上的 web_fetch 结果），从那里起的一切都要重新预填。10-26 本机
// llama.cpp（开着提示缓存）实测：同一对话里两次请求只复用了前约 1.6 万与 1.7 万个 token，重新预填 8.7 万与 7.3 万个
// （约 64 秒与 56 秒）。现在：
//   - 每份结果在它到来后的第一次请求之前（那时它还从没发出过）一次排成最终形态：只有这一步相对上一份视图的变化，
//     比较规则（按段，见下）不变；本对话第一份没有更早的视图，所以它的每一行都是 `+`。此后除减负外不再改。
//   - 整个当前视图只在发出的副本末尾（不进会话、不进界面）；下一次请求只在上一次末尾那段开始处分叉。
//   - 以前的版本排好的结果（旧表头）按原样读回，不再改写（减负除外）；只有当时留在最后的整视图（连同写板提醒）在升级后
//     的第一次请求之前降为变化，只此一次（那次请求的前缀本来就要变：以前各轮的思考又发回了，见 outgoing-trim.mjs）。
//
// 10-09 模型的反馈（项目内容，事后报告）：表头说“整块板”，而视图自己写着 rootScope.lossy 与 dropped，两者打架——这里
// 给的其实是“Rulith 这次返回的整个视图”，省略了什么由视图自己说；未变的行只靠两个空格，不醒目，改标 `=`；Get
// 的动作行带 description 与 inputSchema、其他结果不带，同一批动作每次交替调用都整批 +/- 一遍，是渲染噪声——比较时不看这两项。
//
// 按段比较（2026-10-14，D 项）：Rulith 的视图按设计带不同的段（交互附件 §3.2：默认读取不带 include）。写操作（Set、
// eng.patch_file／run／test）给默认视图（position、goals、actions、taskStatus、goalTypes，约 4.5K 字符），只读的 Execute
// （eng.read 等）给按目标的视图（再加 facts、findings、goalNodes、total、rootScope、gaps，约 16.5K 字符）。以前与上一份
// 视图整体比较，每次切换都把全部事实列成“- 消失”，下次又列成“+ 新增”：既费上下文，也是错的——事实没有消失，只是这份视图
// 没带。现在：由 include 决定的组（nodes 组：facts、findings、goalNodes、total、rootScope 及 truncated；gaps 组：gaps 及
// gapsTruncated、gapsTotal；见下面的 INCLUDE_GROUPS）整组不在这份视图里，就是“没带”，不是“消失”：这样的组与“最近一份带
// 这一组的视图”比较，没带时它的行永远不列成 `-`；其余的键照常与上一份视图比较，不见了就是 `-`（审查 e83bd1d 的 P2-1：
// 截断标志、没有动作时的 actions、空焦点时的 taskStatus、{unavailable:true} 都会在同一种视图里出现或消失，不能当成“没带”）。
// 当前整视图的 +／-／= 也这样标。这份视图没带、而本对话更早的视图带过的组，在表头下用一行列出它们的键（ABSENT_PREFIX）。
// 按组比较的变化用 DELTA_HEAD、DELTA_NONE（10-14～10-26 的写法 SCOPED_DELTA_HEAD、SCOPED_DELTA_NONE 同样按组读回）；
// 10-14 之前排好的变化（旧表头）按当时的方式（与上一份整体比较）读回，原样不动。
//
// 结果怎样读（2026-10-14，所有者：工具结果要读得自然，不要满屏反斜杠）：板以外的部分（结果头）是一行紧凑 JSON。
// Worker 的输出由平台作为字符串带回，原样就是 JSON 里套着转义的 JSON；这里把“本身是一行 JSON（对象或数组）”的字符串解开，
// 作为嵌套的值放回——只在重新编码能逐字还原原字符串时才解开，所以展示无损；回答的顶层字段照平台给的样子，不解开（减负时
// 留下的 result.action／ok／status 因此只来自平台自己的结果，与以前相同）。多行、超过 TEXT_LONG 个字符、或者本身形如
// `<text N>` 的字符串在这行里换成 "<text N>"，原文作为文本块接在这行之后，块头写明字段路径与行数：
// `<text 1> result.result.head (12 lines):`。所以这行里的 "<text N>" 一定是引用，不会与同样文字的原值混淆。
// 全部换行都是 CRLF 时去掉 CR 并在块头注明 `CRLF line endings`（改文件要知道）。块按行数截取，所以内容里的任何一行
// 都不会被认成板行、提示或标记。这只是展示：Board 与 dsh 记下的原始工具结果不变。
// 不带板的 Rulith 结果（Get 读 artifact 等）同样只排结果头；其他工具（子 Agent 等）的结果不动。
//
// 一份结果只排一次（D-1026b），此后逐字沿用（缓存稳定）：进入转录时直接排成变化。之后只有减负会改它（压结果头、
// 长行换短身份、加标记），减负前后各自是固定点。以前每次都按会话重算全部变化，重建的行序与原视图不同时，同一份会在
// 下一步再被改一次；不再重算就没有这回事。之前排好的结果（旧表头、旧的结果头）照旧读、照旧显示；以前留在最后的整视图
// 降为变化一次（见上）。
//
// 上下文减负（2026-10-14，所有者：只在上下文空间不够时才减负，仿 Anthropic context editing 的 trigger／keep／clear_at_least；
// 取代 10-14 上午的两个滑动窗口——它们每当一份大结果或长参数滑出窗口就改一次前缀，79 步里约 20 次让缓存退到 40～90K）：
//   - 减负线与压缩线见 context-relief.mjs：默认是模型上下文窗口的 0.7 与 0.8（deep-rulith.json 可改）；实际的减负线还要
//     在 dsh 实际的压缩线之前留出一步（RELIEF_MARGIN），按会话所用路线的窗口与请求的 maxTokens 在这里算出并记日志。
//     窗口取 dsh 的压缩用的那个：请求头记下的路线此刻由适配器报告的窗口（路线的实际窗口：人设定的、开发者设置
//     localContextWindow、从本机或局域网推理服务读到的，认出是推理服务却没读到时估计 128K，否则 1M；见
//     context-window.mjs），读不到时用会话里最新 request/context 的 contextWindow。窗口改了，下一步的两条线就按新窗口算并
//     重新记日志。窗口太小、没有能用的两条线时不减负，日志记一次（context-relief.mjs MIN_USABLE_CONTEXT_WINDOW）。
//   - 触发：dsh 记下的最近一次模型请求的真实提示大小（assistant/message 的 usage：inputTokens + cacheReadTokens，
//     有 cacheWriteTokens 的也算上）达到减负线。
//     那次请求之后 dsh 压缩过（有 compaction/summary），那次的用量已不代表现在的对话，不触发；不知道窗口或用量，也不触发。
//   - 一批（keep）：比最近 KEEP 份工具结果（带板与否都算）更早的最新一份带板结果成为新的边界。上一个边界之后、新边界及之前的
//     Rulith 结果一次全部减负：结果头超过 CLEAR_FIRST_LINE 个字符时压成一行仍可解析的紧凑 JSON（只留 accepted、errorCode、tool、
//     requestExecuted、result.action/ok/status，并写明清掉了多少字符；文本块随之去掉，指向它们的字段不留），其中超过 LONG_LINE
//     的 `+` 行与 `-` 行一样只显示短身份；新边界那份末尾加一行减负标记（RELIEF_MARK）。
//     新边界也可以是最新一份带板结果（它之后已有 KEEP 份别的工具结果）：整视图只在发出副本的末尾，按原文算，不受减负影响。
//     发出副本时，最新一个标记之前的模型回答里的长参数缩短；其中在最后一条开始新一轮的消息之前的，思考块也去掉
//     （outgoing-trim.mjs 用这里的 reliefBoundary 认标记；当前这一轮的思考要等下一轮开始才去掉）。
//   - 够才做（clear_at_least）：这一批估计至少省 CLEAR_AT_LEAST 个 token 才做——结果减负前后的字符差，加上新落到边界之前的
//     旧回答里长参数缩短省下的字符、以及其中这一批就去掉的思考（在最后一条开始新一轮的消息之前的），按 CHARS_PER_TOKEN
//     折算。不够就什么都不改，余下的交给 dsh 的压缩。
//   - 一批之后，边界及之前的一切不再变，直到下一次触发。
//
// 单一真相放在会话里（而不是只在发出的副本里）：触发要用 dsh 记下的用量与请求上下文，只有会话日志里有（发出的请求只带消息）；
// Rulith 结果本来就以 dsh 的“替换”记录改写；而模型回答 dsh 不许替换，长参数只能在发出的副本里缩短。所以由这里在请求前
// 判断并把边界写成结果末尾的标记（替换记录，原文仍在日志里），outgoing-trim.mjs 只读这个标记。两者由同一个标记定边界，
// 永远一致；重启或回放会话日志得到同一个边界、同样的字节。标记只认本文件的分类器认出的带板结果的最后一行。
//
// 不变式（中文写明，便于审计）：
//   1. include 决定的组的变化相对的是“这个对话里最近一份带这一组的视图”，其余键的变化相对的是上一份视图；从第一份起把
//      各步变化依次叠加，得到每一组最后一次出现时的样子，当前整视图就是其中最新一份带了的那些。第一份没有更早的视图，它的
//      每一行都标 `+`。
//   2. 改写只依据会话记录本身（对话、dsh 记下的用量、请求上下文与请求头；无内存状态），重启或回放后结果相同；已经排好的
//      不再改。两次减负之间，每一步只排新到的、还从没发出过的结果，此前的一切逐字不变：发出的消息列表去掉当前整视图之后，
//      总是上一次请求的列表在末尾追加（D-1026b；几种例外逐条列在 outgoing-trim.mjs 的不变式 3），模型服务的前缀缓存照常命中。
//      一批减负改的是边界及之前尚未减负的结果，此后它们不再变。以前的决定不因对话变长而改动。
//   3. 这不是第二份真相：板的真相仍在 Rulith，这里只是把它沿时间拆成“历次变化 + 最新全量”给模型看。
//   4. 读不懂的结果（传输错误等不是 JSON 的结果）原样不动。
//   5. 减负只改显示，不改比较：短身份就是该行比较用的身份（identity），读回时得到同一个身份；已经减负的不再改（紧凑行带
//      cleared，短身份按原样就是它自己的身份），第二遍什么也不变。
//   6. dsh 压缩把从对话开头起的一段换成摘要。标记若在被压缩的那段里，它之前的一切也都在里面，剩下的对话里没有边界，
//      也没有比边界更早的东西；若在保留的尾部，边界照旧。压缩后的第一次请求之前不触发（用量已过时）。留下的变化不重排；
//      之后新排的变化只与留下的视图比较（被压缩掉的那部分它不再知道）；当前整视图的各行取自最新一份带板结果的原文、
//      标记取自它存下的变化，所以压缩后仍完整、标记不变；最新一份带板结果本身被压缩掉了，就没有当前整视图。
//   7. 10-14 上午用滑动窗口减负过的会话照旧读：带 cleared 的结果头与短身份原样保留；它们没有标记，所以直到下一批之前，
//      旧回答的长参数照常发出。
//   8. 当前整视图（currentBoard，D-1026b）也只依据会话记录：各行取自对话里最新一份带板结果的原文（沿 dsh 的替换记录找回
//      最初那条记录；找不到时用叠加历次变化得到的视图），标记取自这份结果存下的这一步变化（+ 仍是 +，- 照抄，其余为 =），
//      所以与它的变化一致，dsh 压缩之后也不变。它不写进会话，所以不占历史；同一会话状态总得到同一段文字。

import { projectToolCall } from '../tool-history.mjs';
import { NOTE_PREFIX } from './shadow-reviewer.mjs';
import { MIN_USABLE_CONTEXT_WINDOW, RELIEF_MARK, RELIEF_RATIO, contextLinesFor, reasoningChars, shortenArguments, startsTurn } from './context-relief.mjs';

const ERROR_PREFIX = 'Error: ';
const RULITH_TOOLS = new Set(['Get', 'Set', 'Execute']);

// 表头。按组比较的（10-14 起）；整视图的两种表头 10-26 起只出现在发出副本末尾的当前整视图里（TAIL_HEAD 之下）：
export const FULL_HEAD = 'Board view now (the whole view Rulith returned; + new, - gone, = unchanged; parts a view does not include keep their last state):';
export const FULL_FIRST = 'Board view now (the whole view Rulith returned; your first view in this conversation, so every line is +):';
// 变化的表头（D-1026b，10-26 起）：整视图不再在最新一份结果里，而在对话末尾，所以括号末尾那句改说它在哪里。
export const DELTA_HEAD = 'Board view changes at this step (+ new, - gone; unchanged lines left out; parts a view does not include keep their last state; the whole current view is at the end of the conversation):';
export const DELTA_NONE = 'Board view changes at this step: none (parts a view does not include keep their last state; the whole current view is at the end of the conversation).';
// 10-14～10-26 按组比较的变化表头：照旧按组读回，排好的原样不动。
export const SCOPED_DELTA_HEAD = 'Board view changes at this step (+ new, - gone; unchanged lines left out; parts a view does not include keep their last state; the latest result shows the whole view):';
export const SCOPED_DELTA_NONE = 'Board view changes at this step: none (parts a view does not include keep their last state; the latest result shows the whole view).';
const SCOPED_DELTA_HEADERS = new Set([DELTA_HEAD, DELTA_NONE, SCOPED_DELTA_HEAD, SCOPED_DELTA_NONE]);
/**
 * 当前整视图的表头（D-1026b，模型可见）：发出副本最后一条消息末尾空一行之后的第一行；其下是整视图表头（FULL_HEAD／
 * FULL_FIRST）、可有的“没带的段”一行、各行，以及可有的写板提醒。
 */
export const TAIL_HEAD = 'Current Board as of your latest Rulith result that returned a view (added by the app at the end of the conversation; not part of the message above):';
// 这份视图没带、而更早的视图带过的段（表头下一行）。
export const ABSENT_PREFIX = 'Not in this view (read with Get to see them): ';
// 与上一份视图整体比较的旧表头（10-09～10-14，以及 10-09 之前的写法）：照旧认得，排好的原样不动。
export const LEGACY_DELTA_HEAD = 'Board view changes at this step (+ new, - gone; unchanged lines left out; the latest result shows the whole view):';
export const LEGACY_DELTA_NONE = 'Board view changes at this step: none (the latest result shows the whole view).';
const FULL_PREFIXES = ['Board view now (', 'Board now ('];
const DELTA_PREFIXES = ['Board view changes at this step', 'Board changes at this step'];

/** 板摊成行：对象逐键展开，数组每个元素一行（元素本身是一行 JSON），标量一行。行内不含换行（JSON 已转义）。 */
function flatten(prefix, value, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(`${prefix}: []`);
    for (const item of value) out.push(`${prefix}: ${JSON.stringify(item)}`);
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) out.push(`${prefix}: {}`);
    for (const key of keys) flatten(`${prefix}.${key}`, value[key], out);
  } else {
    out.push(`${prefix}: ${JSON.stringify(value)}`);
  }
}

/** 一份 Rulith 回答（工具结果里的那层 JSON）的板行：view 的各段，再加 operations。每个顶层段至少一行。 */
export function boardLines(answer) {
  const out = [];
  for (const key of Object.keys(answer.view)) flatten(key, answer.view[key], out);
  if (Object.hasOwn(answer, 'operations')) flatten('operations', answer.operations, out);
  return out;
}

const section = (line) => line.slice(0, line.indexOf(': '));
/** 一行所在的顶层段：view 的顶层键（或 operations）。 */
const topSection = (line) => { const key = section(line); const dot = key.indexOf('.'); return dot === -1 ? key : key.slice(0, dot); };

// ---- 结果头：解开嵌套 JSON，长文本成块 ----

/** 单行字符串超过这么多字符就作为文本块显示（多行的一律成块）。 */
export const TEXT_LONG = 400;
/** 文本块的块头：`<text N> <字段路径> (<行数> lines[, CRLF line endings]):`，之后正好是这么多行原文。 */
const BLOCK_LABEL = /^<text (\d+)> .+ \((\d+) lines?(?:, CRLF line endings)?\):$/;
const TEXT_REF = /^<text \d+>$/;
export const textRef = (n) => `<text ${n}>`;

/** 一行紧凑 JSON（对象或数组）且重新编码逐字还原的字符串，返回解开的值；否则 undefined。 */
function nestedJson(text) {
  if (text[0] !== '{' && text[0] !== '[') return undefined;
  if (text.includes('\n')) return undefined;
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  return JSON.stringify(value) === text ? value : undefined;
}

const pathOf = (path, key) => (typeof key === 'number' ? `${path}[${key}]`
  : /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);

/**
 * 逐层解开嵌套 JSON（decode 为假时这一层不解开）；多行、很长或本身形如 <text N> 的字符串换成 <text N>，原文收进 blocks。
 * 对象用 fromEntries 重建，`__proto__` 也只是普通的键。
 */
function present(value, path, blocks, decode = true) {
  if (typeof value === 'string') {
    const nested = decode ? nestedJson(value) : undefined;
    if (nested !== undefined) return present(nested, path, blocks);
    if (!value.includes('\n') && value.length <= TEXT_LONG && !TEXT_REF.test(value)) return value;
    blocks.push({ path, text: value });
    return textRef(blocks.length);
  }
  if (Array.isArray(value)) return value.map((item, index) => present(item, pathOf(path, index), blocks));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, present(item, pathOf(path, key), blocks)]));
  }
  return value;
}

/** 一个文本块：块头 + 原文各行。全部换行都是 CRLF 时去掉行尾的 CR，块头注明；否则原样（CR 照留）。 */
function textBlock(n, { path, text }) {
  let lines = text.split('\n');
  const crlf = lines.length > 1 && lines.slice(0, -1).every((line) => line.endsWith('\r'));
  if (crlf) lines = lines.map((line, index) => (index < lines.length - 1 ? line.slice(0, -1) : line));
  const count = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}${crlf ? ', CRLF line endings' : ''}`;
  return [`${textRef(n)} ${path} (${count}):`, ...lines];
}

/** 一份回答的结果头：除板以外的部分（结果、教学、错误码……），一行紧凑 JSON，后接文本块。顶层字段本身不解开。 */
export function renderHead(answer, isError) {
  const { view: _view, operations: _operations, ...rest } = answer;
  const blocks = [];
  const shown = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, present(value, pathOf('', key), blocks, false)]));
  return [(isError ? ERROR_PREFIX : '') + JSON.stringify(shown), ...blocks.flatMap((block, index) => textBlock(index + 1, block))].join('\n');
}

/** 已排好的文本里结果头占几行：第一行，加上紧随其后按编号与行数截取的文本块。 */
function headLength(lines) {
  let at = 1;
  for (let n = 1; at < lines.length; n += 1) {
    const match = BLOCK_LABEL.exec(lines[at]);
    if (!match || Number(match[1]) !== n) break;
    at += 1 + Number(match[2]);
  }
  return Math.min(at, lines.length);
}

const countLines = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};
const expand = (counts) => [...counts].flatMap(([line, n]) => Array(n).fill(line));

/**
 * 很长的一行（例如操作栏里补交的一份旧结果）以“段名 + 摘要 + 长度”作身份。消失的行显示的是身份，所以模型看到的是
 * “- operations: #… (106197 characters)”，而不是把同一大块再抄一遍（2026-10-14：一份约 10 万字符的旧视图在两次压缩后仍占满上下文）。
 * 新增与未变的行照原样显示；短身份按原样就是它自己的身份。
 */
export const LONG_LINE = 2000;
const LONG_IDENTITY = /^[^:]*: #[0-9a-f]{16} \(\d+ characters\)$/;
function longIdentity(line) {
  if (line.length <= LONG_LINE || LONG_IDENTITY.test(line)) return line;
  return `${section(line)}: #${createHash('sha256').update(line).digest('hex').slice(0, 16)} (${line.length} characters)`;
}

/**
 * 比较用的身份：动作行去掉说明部分 description 与 inputSchema（只有 Get 的结果带它们，其他结果不带；它们是同一个
 * 动作定义的另一种渲染，不是板的变化）。显示仍用原行，所以带说明的结果照样给模型看。其余行的身份就是行本身。
 */
export function identity(line) {
  if (!line.startsWith('actions: ')) return longIdentity(line);
  try {
    const row = JSON.parse(line.slice('actions: '.length));
    if (!row || typeof row !== 'object' || Array.isArray(row)) return longIdentity(line);
    if (!Object.hasOwn(row, 'inputSchema') && !Object.hasOwn(row, 'description')) return longIdentity(line);
    const { inputSchema: _schema, description: _description, ...rest } = row;
    return longIdentity(`actions: ${JSON.stringify(rest)}`);
  } catch {
    return longIdentity(line);
  }
}

/**
 * 多重集比较（按 identity）：curr 中多出来的行标 `+`；prev 中没有了的行另列为 `-`，放在同一段最后一行之后。prev 是身份的
 * 多重集（只含这份视图带了的段）；curr 是本次的原行，显示时照原样。
 */
function mark(prev, curr) {
  const remaining = new Map(prev ?? []);
  const rows = markRows(remaining, curr);
  return withGone(rows, expand(remaining));
}

/** curr 的各行：每个身份的前 unchanged.get(身份) 行标 `=`，其余标 `+`（用掉的从 unchanged 里减去）。 */
function markRows(unchanged, curr) {
  return curr.map((line) => {
    const key = identity(line);
    const left = unchanged.get(key) ?? 0;
    if (left > 0) { unchanged.set(key, left - 1); return { mark: '=', line }; }
    return { mark: '+', line };
  });
}

/** 消失的行（身份）插到同一段最后一行之后，按字典序插：重算总得到同一段文本。 */
function withGone(rows, gone) {
  for (const line of [...gone].sort()) {
    const at = rows.findLastIndex((row) => section(row.line) === section(line));
    rows.splice(at === -1 ? rows.length : at + 1, 0, { mark: '-', line });
  }
  return rows;
}

/**
 * 按一份结果存下的这一步变化标出它的整个视图（审查 P2-2）：变化里的 `+` 仍是 `+`（同一身份的几行里排在 `=` 之后，与
 * mark 一样），`-` 行照抄，其余为 `=`。没有压缩时与 mark(那时的基准, curr) 逐字相同；dsh 压缩掉更早的结果之后，
 * 基准已不全，这样得到的仍是这份结果到来时的标记。
 */
function markFromChanges(curr, changes) {
  const unchanged = countLines(curr.map(identity));
  for (const row of changes) if (row.mark === '+') unchanged.set(identity(row.line), (unchanged.get(identity(row.line)) ?? 0) - 1);
  return withGone(markRows(unchanged, curr), changes.filter((row) => row.mark === '-').map((row) => row.line));
}

const absentLines = (absent) => (absent.length > 0 ? [ABSENT_PREFIX + absent.join(', ')] : []);

/**
 * 整个视图的各行（带 +／-／=）及其表头：当前整视图（boardTail）用。prev 为 null 表示这份之前本对话还没有过视图；
 * absent 是这份没带而更早带过的段。
 */
export function renderWhole(curr, prev, absent = []) {
  return [prev === null ? FULL_FIRST : FULL_HEAD, ...absentLines(absent), ...mark(prev, curr).map((row) => `${row.mark} ${row.line}`)];
}

/** 超过 LONG_LINE 的 `+` 行在减负时显示它的身份（长行即短身份），与 `-` 行一样，读回时得到同一个身份。 */
const relievedRow = (row) => (row.mark === '+' && row.line.length > LONG_LINE ? identity(row.line) : row.line);

/** 历史一份：结果头 + 只有变化的行。old 为真（在减负边界及之前）时减负：结果头压成紧凑 JSON，长的 `+` 行显示短身份。 */
export function renderDelta(first, curr, prev, old = false, absent = []) {
  const changed = mark(prev, curr).filter((row) => row.mark !== '=');
  return [old ? clearFirst(first) : first, changed.length > 0 ? DELTA_HEAD : DELTA_NONE, ...absentLines(absent),
    ...changed.map((row) => `${row.mark} ${old ? relievedRow(row) : row.line}`)].join('\n');
}

// ---- 减负的参数（两条线见 context-relief.mjs）----

/** 最近这么多份工具结果（不论是否带板）及发出它们的调用在一批减负里不动。 */
export const KEEP = 6;
/** 一批至少要省这么多 token 才做，否则留给 dsh 的压缩。 */
export const CLEAR_AT_LEAST = 20000;
/**
 * 字符折算 token：2026-10-14 game-demo 会话（Qwen 分词，板与参数多为 JSON、十六进制摘要、代码）实测每 token 2.7～2.9 个字符。
 * 取 3，估计偏低，所以够 CLEAR_AT_LEAST 时实际省下的只会更多；中文文本约每 token 1～1.5 个字符，同样只会低估。
 */
export const CHARS_PER_TOKEN = 3;
/** 结果头（不含板的结果 JSON 与其文本块）超过这么多字符，减负时压成紧凑 JSON。 */
export const CLEAR_FIRST_LINE = 1500;
/** 紧凑 JSON 里保留的字段：短的才留（按 JSON 计不超过这么多字符），长的照样清掉。 */
const KEPT_FIELD = 200;
const clearedNote = (n) => `${n} characters of this earlier result were cleared to save context; the Board holds the state`;
const TEXT_REF_IN_JSON = /"<text \d+>"/;

/**
 * 减负后的结果头：太长时换成一行仍可解析的紧凑 JSON，保留 accepted、errorCode、tool、requestExecuted 与
 * result.action／ok／status（有且短、而且不指向已去掉的文本块时），另加 cleared 写明清掉了多少字符（第一行与文本块合计）。
 * dsh 的 `Error: ` 前缀照留。读不懂的、已经带 cleared 的，原样返回（所以第二遍不变）。
 */
export function clearFirst(first) {
  const isError = first.startsWith(ERROR_PREFIX);
  const size = first.length - (isError ? ERROR_PREFIX.length : 0);
  if (size <= CLEAR_FIRST_LINE) return first;
  const line = first.split('\n', 1)[0];
  let rest;
  try { rest = JSON.parse(isError ? line.slice(ERROR_PREFIX.length) : line); } catch { return first; }
  if (!rest || typeof rest !== 'object' || Array.isArray(rest) || Object.hasOwn(rest, 'cleared')) return first;
  const pick = (from, keys) => {
    const out = {};
    for (const key of keys) {
      if (!Object.hasOwn(from, key) || from[key] === undefined) continue;
      const json = JSON.stringify(from[key]);
      if (json.length <= KEPT_FIELD && !TEXT_REF_IN_JSON.test(json)) out[key] = from[key];
    }
    return out;
  };
  const kept = pick(rest, ['accepted', 'errorCode', 'tool', 'requestExecuted']);
  if (rest.result && typeof rest.result === 'object' && !Array.isArray(rest.result)) {
    const result = pick(rest.result, ['action', 'ok', 'status']);
    if (Object.keys(result).length > 0) kept.result = result;
  }
  kept.cleared = clearedNote(size);
  return (isError ? ERROR_PREFIX : '') + JSON.stringify(kept);
}

// ---- 认出一份工具结果 ----

/** MCP 结果（dsh 存下的工具结果第一行，可能带 `Error: `）里的 Rulith 回答；不是时返回 null。 */
function mcpAnswer(text) {
  const isError = text.startsWith(ERROR_PREFIX);
  try {
    const outer = JSON.parse(isError ? text.slice(ERROR_PREFIX.length) : text);
    if (!outer || !Array.isArray(outer.content)) return null;
    const answer = JSON.parse(outer.content.map((part) => part?.text ?? '').join(''));
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    return { answer, isError };
  } catch {
    return null;
  }
}

/** 原样的工具结果：第一行是 MCP 结果，之后只可能是宿主附加的建议行（shadow-reviewer 的 NOTE_PREFIX）。 */
function rawParts(text) {
  const lines = text.split('\n');
  const notes = lines.slice(1).filter((line) => line.startsWith(NOTE_PREFIX));
  const body = lines.filter((line, index) => index === 0 || !line.startsWith(NOTE_PREFIX)).join('\n');
  return { body, notes };
}

/**
 * 认出一份带板工具结果的形态。
 * - raw：Rulith 原样的回答（可能带 dsh 加的 `Error: ` 前缀），且带板；结果头在这里一次排好；
 * - full／delta：已经排好的（结果头逐字沿用）；legacy 为真的变化是与上一份视图整体比较排出的（旧表头）；
 * - null：不是带板的 Rulith 结果，不动。
 * 已排好的文本按结构读：结果头（第一行与按行数截取的文本块）、表头、可有的“没带的段”一行、板行，其后只可能是写板提醒、
 * 建议行与减负标记（标记只认最后一行）。
 */
export function classify(text) {
  const lines = text.split('\n');
  const headEnd = headLength(lines);
  const header = lines[headEnd] ?? '';
  const kind = FULL_PREFIXES.some((prefix) => header.startsWith(prefix)) ? 'full'
    : DELTA_PREFIXES.some((prefix) => header.startsWith(prefix)) ? 'delta' : null;
  if (kind !== null) {
    let at = headEnd + 1;
    const absentLine = lines[at]?.startsWith(ABSENT_PREFIX) ? lines[at++] : null;
    const rows = [];
    // `=` 未变；旧会话里未变是两个空格。
    for (; at < lines.length && /^[ =+-] /.test(lines[at]); at += 1) rows.push({ mark: lines[at][0] === ' ' ? '=' : lines[at][0], line: lines[at].slice(2) });
    const tail = lines.slice(at);
    return { kind, legacy: kind === 'delta' && !SCOPED_DELTA_HEADERS.has(header), text,
      first: lines.slice(0, headEnd).join('\n'), header, absentLine,
      absent: absentLine === null ? [] : absentLine.slice(ABSENT_PREFIX.length).split(', '), rows, tail,
      notes: tail.filter((line) => line.startsWith(NOTE_PREFIX)), marked: tail.at(-1) === RELIEF_MARK };
  }
  const { body, notes } = rawParts(text);
  const parsed = mcpAnswer(body);
  const view = parsed?.answer.view;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
  return { kind: 'raw', text, first: renderHead(parsed.answer, parsed.isError), lines: boardLines(parsed.answer), notes, marked: false };
}

/**
 * 不带板的 Rulith 结果（Get 读 artifact、被拒的调用等）：原样的（第一行是 MCP 结果）先排好结果头；已排好的（第一行是回答本身
 * 的 JSON）读出结果头。两种之后都只能是建议行。读不懂的（传输错误等纯文本、多出别的行）返回 null，不动。
 */
export function classifyPlain(text) {
  const lines = text.split('\n');
  const isError = lines[0].startsWith(ERROR_PREFIX);
  let value;
  try { value = JSON.parse(isError ? lines[0].slice(ERROR_PREFIX.length) : lines[0]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const onlyNotes = (rest) => rest.every((line) => line.startsWith(NOTE_PREFIX));
  if (Array.isArray(value.content)) {
    const parsed = mcpAnswer(lines[0]);
    if (parsed === null || !onlyNotes(lines.slice(1))) return null;
    return { text, first: renderHead(parsed.answer, parsed.isError), notes: lines.slice(1) };
  }
  const headEnd = headLength(lines);
  if (!onlyNotes(lines.slice(headEnd))) return null;
  return { text, first: lines.slice(0, headEnd).join('\n'), notes: lines.slice(headEnd) };
}

const textOf = (message) => (Array.isArray(message?.content) ? message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '');

/**
 * 减负边界在发出的消息列表里的下标：最新一份最后一行是减负标记、而且按上面的分类器是带板 Rulith 结果的工具消息；
 * 没有时为 -1。Get 读到的文件、子 Agent 的回答等里出现同样的文字，不算（outgoing-trim.mjs 用它）。
 */
export function reliefBoundary(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    const text = textOf(message);
    if (text.endsWith(`\n${RELIEF_MARK}`) && classify(text)?.marked === true) return index;
  }
  return -1;
}

// G1（D-1008j，取自 galaxy-core 实测：提醒把所学写到板上，写板次数与板上事实都明显增加）：最新一份结果之前，
// 连续这么多次 Rulith 调用都没有被接受的 Set，就附一句提醒。10-26 起（D-1026b）它接在当前整视图之后（以前在最新一份
// 结果末尾，降为变化时去掉）：当前整视图只在发出的副本里，所以提醒也只出现一次、不在对话里堆积，也不改写历史。
export const WRITE_NOTE_AFTER = 6;
export const writeNote = (n) => `Note: ${n} Rulith calls since your last accepted Set. Record what you have learned on the Board before relying on it.`;
const acceptedBatch = (item) => {
  if (item.tool !== 'Set') return false;
  try { return JSON.parse(item.first.split('\n', 1)[0].replace(/^Error: /, '')).accepted === true; } catch { return false; }
};

// 由 include 决定带不带的组（交互附件 §3.2：selector.goals 加 include 的 nodes 与 gaps）：只有这样的组整组不在时，才算
// 这份视图“没带”它。伴随的标志属于它的组（truncated 随 nodes 组；gapsTruncated／gapsTotal 随 gaps）。其余键（position、
// goals、actions、taskStatus、goalTypes、unavailable 等）在同一种视图里也会按内容出现或消失（超过上限才有的截断标志、
// 没有动作时省略的 actions、焦点为空时没有的 taskStatus、读不到局面时的 {unavailable:true}），所以照常与上一份视图比较：
// 不见了就是 `-`。§3.2 里 taskStatus 也可由 include 选择，但它在焦点为空时同样不出现，两者分不开，按所有者 2026-10-14
// 的决定照常比较。
const INCLUDE_GROUPS = [
  ['nodes', ['facts', 'findings', 'goalNodes', 'total', 'rootScope', 'truncated']],
  ['gaps', ['gaps', 'gapsTruncated', 'gapsTotal']],
];
const GROUP_OF = new Map(INCLUDE_GROUPS.flatMap(([group, keys]) => keys.map((key) => [key, group])));
const COMPANIONS = new Set(['truncated', 'gapsTruncated', 'gapsTotal']);
const ALWAYS = ''; // 其余的键：每份视图都算带了这一组
const groupOf = (line) => GROUP_OF.get(topSection(line)) ?? ALWAYS;
/** 视图里带了哪些组（ALWAYS 总在）。 */
const groupsOf = (lines) => new Set([ALWAYS, ...lines.map(groupOf)]);

/** 把变化行叠加到 base（身份 → 次数）上，得到这份视图的身份。 */
function apply(base, rows) {
  const next = new Map(base ?? []);
  for (const row of rows) {
    const key = identity(row.line);
    if (row.mark === '+') next.set(key, (next.get(key) ?? 0) + 1);
    else if (row.mark === '-') {
      const left = (next.get(key) ?? 0) - 1;
      if (left > 0) next.set(key, left); else next.delete(key);
    }
  }
  return expand(next);
}

/** known 里这些组的身份多重集（比较的基准）。 */
function baseOf(known, groups) {
  const base = new Map();
  for (const [group, entry] of known) if (groups.has(group)) for (const [key, n] of entry.ids) base.set(key, n);
  return base;
}

/** 这份视图没带、而更早的视图带过的组，以各组最后一次出现时的键列出（伴随标志不列）；组按第一次出现的顺序。 */
const absentKeys = (known, groups) => [...known].filter(([group]) => !groups.has(group)).flatMap(([, entry]) => entry.keys);

/**
 * 一份结果所带视图的行：原样的取板行，整视图取它的行，变化由基准叠加——新表头的按组（最近一份带这一组的视图；
 * 表头下列出的没带的组除外），旧表头的按上一份整个视图。
 */
function viewOf(item, previous, known) {
  if (item.kind === 'raw') return item.lines;
  if (item.kind === 'full') return item.rows.filter((row) => row.mark !== '-').map((row) => row.line);
  if (item.legacy) return apply(previous, item.rows);
  const present = new Set([ALWAYS, ...known.keys(), ...item.rows.map((row) => groupOf(row.line))]);
  for (const key of item.absent) present.delete(GROUP_OF.get(key));
  return apply(baseOf(known, present), item.rows);
}

/** 已排好的一份照原样留下；只在减负（old）或要加标记时按读出的各部分重写，减负前后各自是固定点。 */
function keep(item, old, marked) {
  if (!old && marked === item.marked) return item.text;
  const rows = item.rows.map((row) => `${row.mark} ${old ? relievedRow(row) : row.line}`);
  return [old ? clearFirst(item.first) : item.first, item.header, ...(item.absentLine === null ? [] : [item.absentLine]), ...rows,
    ...item.tail.filter((line) => line !== RELIEF_MARK), ...(marked ? [RELIEF_MARK] : [])].join('\n');
}

/**
 * 依次比较一份份视图的状态（render 与 boardTail 共用同一套比较）：previous 是上一份视图（身份 → 次数，旧表头的变化相对它），
 * known 是组 → 最近一份带这一组的视图里这一组的 { 身份多重集 ids, 顶层键 keys }（按各组第一次出现的顺序）。
 *   view(item)：这份结果所带视图的行；against(curr)：这份视图的比较基准、没带的段、是否本对话第一份视图；record(curr)：记下它。
 */
function tracker() {
  let previous = null;
  const known = new Map();
  return {
    view: (item) => viewOf(item, previous, known),
    against(curr) {
      const present = groupsOf(curr);
      return { base: baseOf(known, present), absent: absentKeys(known, present), first: known.size === 0 };
    },
    record(curr) {
      const ids = curr.map(identity);
      previous = countLines(ids);
      for (const group of groupsOf(ids)) {
        const mine = ids.filter((id) => groupOf(id) === group);
        known.set(group, { ids: countLines(mine), keys: [...new Set(mine.map(topSection))].filter((key) => !COMPANIONS.has(key)) });
      }
    },
  };
}

/**
 * 每一份带板结果应有的文本（items 按对话顺序给出 classify 的结果，null 已滤掉）。boundary 是减负边界在 items 里的下标
 * （-1 为没有）：它及之前的结果减负，它本身末尾带减负标记；已经带标记的照留。
 * 原样的结果在这里第一次、也是唯一一次排成变化（D-1026b：最新一份也一样，整视图只在发出副本的末尾）；以前的版本留下的
 * 整视图（连同它的写板提醒）在升级后的第一次请求之前降为变化，只此一次（审查 P2-5：那次请求的前缀本来就要变，因为以前
 * 各轮的思考又发回了）；其余已排好的原样留下（10-14～10-26 的按组变化也一样）。
 */
function render(items, boundary) {
  const t = tracker();
  return items.map((item, index) => {
    const old = index <= boundary;
    const marked = item.marked || index === boundary;
    const curr = t.view(item);
    let text;
    if (item.kind === 'raw' || item.kind === 'full') {
      const { base, absent } = t.against(curr);
      text = renderDelta(item.first, curr, base, old, absent)
        + (item.notes.length ? '\n' + item.notes.join('\n') : '') + (marked ? `\n${RELIEF_MARK}` : '');
    } else {
      text = keep(item, old, marked);
    }
    t.record(curr);
    return text;
  });
}

/**
 * 当前整视图（D-1026b）：items 是对话里的带板结果（按顺序，带 tool），latest 是最新一份所带视图的原样各行（取自它的原文；
 * 给 null 时由历次变化叠加得到）。已排好的最新一份按它存下的这一步变化标记（+ 仍是 +，- 照抄，其余为 =；没带的段也取它
 * 自己那一行），所以 dsh 压缩掉更早的结果之后标记不变（审查 P2-2）；还没排的（原样的）与它之前的视图比较。compacted 为真
 * （对话里有 dsh 的压缩摘要）时，不说“本对话第一份视图”。写板提醒（G1）接在最后。没有带板结果时返回 null。纯函数。
 */
export function boardTail(items, latest = null, { compacted = false } = {}) {
  if (items.length === 0) return null;
  const last = items.at(-1);
  const t = tracker();
  for (const item of items.slice(0, -1)) t.record(t.view(item));
  let whole;
  if (last.kind === 'raw') {
    const curr = latest ?? last.lines;
    const { base, absent, first } = t.against(curr);
    whole = renderWhole(curr, first && !compacted ? null : base, absent);
  } else {
    const curr = latest ?? t.view(last);
    const first = last.kind === 'full' ? last.header === FULL_FIRST : items.length === 1 && !compacted;
    whole = [first ? FULL_FIRST : FULL_HEAD, ...absentLines(last.absent),
      ...markFromChanges(curr, last.rows.filter((row) => row.mark !== '=')).map((row) => `${row.mark} ${row.line}`)];
  }
  let sinceWrite = 0;
  for (const item of items) sinceWrite = acceptedBatch(item) ? 0 : sinceWrite + 1;
  return [TAIL_HEAD, ...whole, ...(sinceWrite >= WRITE_NOTE_AFTER ? [writeNote(sinceWrite)] : [])].join('\n');
}

/** 已有的减负边界：最新一份带减负标记的结果（items 下标），没有为 -1。 */
const markedBoundary = (items) => items.findLastIndex((item) => item.marked);

/** 每一份应有的文本；已经是应有形态的给 null。boundary 默认是已有的边界（不触发新的一批）。 */
export function plan(items, { boundary = markedBoundary(items) } = {}) {
  return render(items, boundary).map((text, index) => (text === items[index].text ? null : text));
}

/** 不带板的 Rulith 结果应有的文本：结果头（在边界之前时减负）加建议行。 */
const renderPlain = (item, old) => (old ? clearFirst(item.first) : item.first) + (item.notes.length ? '\n' + item.notes.join('\n') : '');

/** 一个模型回答里的长参数在发出副本里缩短后省下的字符数（与 outgoing-trim.mjs 同一个函数）。 */
function argumentSavings(message) {
  let saved = 0;
  for (const block of message?.content ?? []) {
    if (block?.type === 'tool-call' && typeof block.arguments === 'string') saved += block.arguments.length - shortenArguments(block.arguments).length;
  }
  return saved;
}

/**
 * 最近一次模型请求的真实提示大小（dsh 记在 assistant/message 的 usage 里：inputTokens + cacheReadTokens，另有
 * cacheWriteTokens 的服务也算上——与 dsh 的 token-meter 算压力的口径相同）。那之后 dsh 压缩过（有 compaction/summary），
 * 或没有记用量，返回 null：不知道现在多大，就不触发。
 */
export function latestPromptTokens(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'compaction/summary') return null;
    if (event?.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (!usage || typeof usage.inputTokens !== 'number') return null;
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  }
  return null;
}

/**
 * 这个会话所用路线上实际的两条线：窗口取 `route`（installBoardTranscript 传来：请求头记下的路线此刻由适配器报告的窗口，
 * 与 dsh 的压缩量会话用的同一个），没有时取最新的 request/context；输出上限取记下的请求头（与 dsh 的压缩同一来源）。
 * 不知道窗口时返回 null；窗口太小、没有能用的两条线时 relief 与 compaction 为 null（不减负）。
 */
export function sessionLines(session, { reliefRatio = RELIEF_RATIO, compaction = {}, route } = {}) {
  const used = Number.isFinite(route?.contextWindow) ? route : session.requestContext?.();
  if (!Number.isFinite(used?.contextWindow)) return null;
  const maxTokens = session.requestHeader?.()?.config?.maxTokens ?? 0;
  const lines = contextLinesFor({ contextWindow: used.contextWindow, maxTokens, reliefRatio, compaction });
  return { provider: used.provider, model: used.model, contextWindow: used.contextWindow, maxTokens,
    ...(lines ?? { relief: null, compaction: null }) };
}

/**
 * 读出对话里（dsh 的模型可见面上）的 Rulith 结果与模型回答：entries 是 Rulith 结果（带板的 board 为真，不带板的为假），
 * 各带 classify 的结果、所在记录与位置；replies 是模型回答及其位置。工具名取自模型消息里的工具调用块（旧名映射为新名）。
 * turnStart 是最后一条开始新一轮的消息（人或上级 Agent 发来的）的位置，没有为 -1；compacted 表示对话里有 dsh 的压缩摘要。
 */
function readSession(session) {
  const entries = []; // Rulith 结果：带板的（board）与不带板的
  const replies = []; // 模型回答及其在对话里的位置
  const toolOf = new Map(); // 调用 ID → 工具名，取自模型消息里的工具调用块
  let results = 0; // 对话里的工具结果（带板与否都算），用来判断哪些结果在最近 KEEP 份之外
  let turnStart = -1, compacted = false;
  const nodes = [...session.surface.nodes];
  nodes.forEach((seq, position) => {
    const event = session.eventAt(seq);
    if (event?.type === 'user/message') {
      const message = session.deriveEventMessage(event);
      if (startsTurn(message)) turnStart = position;
      if (message?.source?.kind === 'compact-checkpoint') compacted = true;
      return;
    }
    if (event?.type === 'assistant/message') {
      const message = session.deriveEventMessage(event);
      replies.push({ position, message });
      for (const block of message?.content ?? []) if (block?.type === 'tool-call') toolOf.set(block.id, projectToolCall(block).name);
      return;
    }
    if (event?.type !== 'tool/result') return;
    results += 1;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const tool = toolOf.get(message.toolCallId);
    const item = classify(text);
    if (item !== null) {
      item.tool = tool;
      entries.push({ seq, event, message, item, board: true, ordinal: results, position });
      return;
    }
    if (!RULITH_TOOLS.has(tool)) return;
    const plain = classifyPlain(text);
    if (plain !== null) entries.push({ seq, event, message, item: plain, board: false, ordinal: results, position });
  });
  for (const entry of entries) entry.item.later = results - entry.ordinal;
  return { entries, replies, turnStart, compacted };
}

/**
 * 一份工具结果最初的原文：dsh 记下的那条 append 记录（沿替换记录 surfaceOp.startSeq 往回找；dsh 的替换记录原样留在日志里）。
 * 找不到（链断了、不是工具结果）时返回 null。
 */
function originalText(session, seq) {
  let event = session.eventAt(seq);
  for (let hops = 0; hops < 10_000 && event?.type === 'tool/result'; hops += 1) {
    const op = event.surfaceOp;
    if (op === undefined || op === 'append') return textOf(session.deriveEventMessage(event));
    if (op?.op !== 'replace' || op.startSeq !== op.endSeq) return null;
    event = session.eventAt(op.startSeq);
  }
  return null;
}

/**
 * 这个对话现在的当前整视图（D-1026b）：{ toolCallId, text }，toolCallId 是最新一份带板结果的调用 ID，text 是接在发出副本
 * 末尾的那段（TAIL_HEAD 起）；对话里没有带板结果时返回 null。各行取自那份结果的原文，所以减负与 dsh 压缩之后仍完整；
 * 原文读不出时用历次变化叠加得到的视图。只读会话，不写（outgoing-trim.mjs 在每次 Agent 请求之前调用）。
 */
export function currentBoard(session) {
  const { entries, compacted } = readSession(session);
  const board = entries.filter((entry) => entry.board);
  if (board.length === 0) return null;
  const latest = board.at(-1);
  const original = latest.item.kind === 'raw' ? latest.item : classify(originalText(session, latest.seq) ?? '');
  const lines = original?.kind === 'raw' ? original.lines : null;
  return { toolCallId: latest.message.toolCallId, text: boardTail(board.map((entry) => entry.item), lines, { compacted }) };
}

/**
 * 在一次请求模型之前改写这个对话：只动 Rulith 的工具结果，用 dsh 自己的“替换”记录（原文仍在日志里，界面显示原文），
 * 与 dsh 的工具结果裁剪器同一做法。到了减负线时按上面的规则判断要不要做一批。返回改写了几份。
 * options：reliefRatio、compaction（交给 dsh 的压缩配置）、keep、clearAtLeast 覆盖默认值；onLines(lines) 收到这个会话
 * 实际的两条线；onBatch(info) 在做了一批时被调用（日志与回放统计用）；turnStarting 为真表示这一步要进会话的消息里有一条
 * 开始新一轮（pre-step 时它还不在会话里），这一批的估计因此把会话里所有回答都算作当前这一轮之前。
 */
export function rewriteSession(session, options = {}) {
  const { keep = KEEP, clearAtLeast = CLEAR_AT_LEAST, onBatch, onLines, turnStarting = false } = options;
  const read = readSession(session);
  const { entries, replies } = read;
  const turnStart = turnStarting ? Infinity : read.turnStart;
  const board = entries.filter((entry) => entry.board);
  const items = board.map((entry) => entry.item);
  const textsFor = (boundary) => {
    const boardTexts = render(items, boundary);
    const before = boundary === -1 ? -1 : board[boundary].position;
    let next = 0;
    return entries.map((entry) => (entry.board ? boardTexts[next++] : renderPlain(entry.item, entry.position < before)));
  };
  let boundary = markedBoundary(items);
  let wanted = textsFor(boundary);
  // 减负线：最近一次请求的真实提示达到这个会话实际的减负线。
  const lines = sessionLines(session, options);
  if (lines !== null) onLines?.(lines);
  const prompt = latestPromptTokens(session);
  if (lines !== null && lines.relief !== null && prompt !== null && prompt >= lines.relief) {
    const candidate = items.findLastIndex((item) => item.later >= keep);
    if (candidate > boundary) {
      const batch = textsFor(candidate);
      let freedChars = 0;
      batch.forEach((text, index) => { freedChars += wanted[index].length - text.length; });
      const from = boundary === -1 ? -1 : board[boundary].position;
      const to = board[candidate].position;
      // 新落到边界之前的回答：长参数缩短；在最后一条开始新一轮的消息之前的，思考也一并去掉（审查 P1-1；当前这一轮的思考
      // 要等下一轮开始才去掉，不算进这一批；一轮的第一步之前，人发来的新消息还没进会话，由 turnStarting 补上）。
      for (const reply of replies) {
        if (reply.position <= from || reply.position >= to) continue;
        freedChars += argumentSavings(reply.message) + (reply.position < turnStart ? reasoningChars(reply.message) : 0);
      }
      const freedTokens = Math.floor(freedChars / CHARS_PER_TOKEN);
      if (freedTokens >= clearAtLeast) {
        boundary = candidate;
        wanted = batch;
        onBatch?.({ prompt, trigger: lines.relief, contextWindow: lines.contextWindow, freedChars, freedTokens, boundarySeq: board[candidate].seq });
      }
    }
  }
  let rewritten = 0;
  entries.forEach((entry, index) => {
    const text = wanted[index];
    if (text === entry.item.text) return;
    session.append('tool/result', { ...entry.event.data, message: { ...entry.message, content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
      sourceEventSeqs: [entry.seq],
    });
    rewritten += 1;
  });
  return rewritten;
}

/**
 * 挂到 dsh 的 agent/pre-step：每次请求模型之前改写一次；出错只记日志，对话照常按原样继续。dsh 的压缩（compaction-basic，
 * 在 Agent 预设里，登记在本插件之后）在同一瀑布里随后才跑：这一步若压缩，压缩看到的已是排好的结果；压缩之后的第一次
 * 请求之前不再触发减负（latestPromptTokens 见到压缩摘要即不知道现在多大）。当前整视图在发出时才由会话算出
 * （outgoing-trim.mjs），所以总是压缩之后的样子。
 * options 来自 rulith-runtime 的配置：reliefRatio（deep-rulith.json 的 reliefRatio）与 compaction（启动器交给 dsh 的压缩配置），
 * 都经启动器的环境变量传来。每条模型路线实际的两条线记一次日志。
 */
export function installBoardTranscript(ctx, options = {}) {
  const { reliefRatio = RELIEF_RATIO, compaction = {} } = options;
  if (!(reliefRatio > 0 && reliefRatio < 1)) throw new Error(`rulith board transcript: reliefRatio must be between 0 and 1 (got ${reliefRatio})`);
  const logged = new Set();
  const onLines = (lines) => {
    const key = JSON.stringify([lines.provider, lines.model, lines.contextWindow, lines.maxTokens]);
    if (logged.has(key)) return;
    logged.add(key);
    const route = `rulith context lines for ${lines.provider}/${lines.model} (window ${lines.contextWindow}, output ${lines.maxTokens}): `;
    ctx.logger?.info?.(lines.relief === null
      ? `${route}none usable: the window is too small for context relief and compaction (Rulith needs at least ${MIN_USABLE_CONTEXT_WINDOW} tokens); no relief on this route`
      : `${route}relief at ${lines.relief} tokens (reliefRatio ${reliefRatio}), dsh compacts at ${lines.compaction}`);
  };
  /**
   * 0.19.3：两条线按 dsh 的压缩量会话用的同一个窗口算——请求头记下的路线此刻由适配器报告的窗口（model-runtime.mjs 可在两轮
   * 之间更新它），而不是上一次请求记下的 request/context。读不到（没有请求头、没有这条路线）时用 request/context。
   */
  const routeWindow = async (session) => {
    const config = session?.requestHeader?.()?.config;
    if (typeof ctx.llm?.resolveModelInfo !== 'function' || !config?.provider || !config?.model) return undefined;
    try {
      const contextWindow = (await ctx.llm.resolveModelInfo(config.provider, config.model))?.context?.contextWindow;
      return Number.isFinite(contextWindow) ? { provider: config.provider, model: config.model, contextWindow } : undefined;
    } catch { return undefined; }
  };
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      // 这一步要进会话的消息（dsh 在这个瀑布之后才把它们追加进会话）里有开始新一轮的，估计时以前的回答都已在当前这一轮之前。
      const turnStarting = Array.isArray(messages) && messages.some(startsTurn);
      const route = agent?.session ? await routeWindow(agent.session) : undefined;
      if (agent?.session) rewriteSession(agent.session, { reliefRatio, compaction, route, onLines, turnStarting, onBatch: (info) => ctx.logger?.info?.(
        `rulith context relief: prompt ${info.prompt} >= ${info.trigger} tokens (window ${info.contextWindow}); `
        + `relieved up to seq ${info.boundarySeq}, about ${info.freedTokens} tokens freed`) });
    } catch (error) {
      ctx.logger?.warn?.(`rulith board transcript: left the conversation as it was (${String(error?.message ?? error).slice(0, 300)})`);
    }
    return next();
  });
}
