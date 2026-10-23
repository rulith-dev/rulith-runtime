import { createHash } from 'node:crypto';
// 上下文减负的共同规则（2026-10-14）。三处共用、只在这里定义：board-transcript.mjs（请求前判断要不要减负、改写 Rulith 结果、
// 写下边界标记）、outgoing-trim.mjs（发出的副本里缩短边界之前回答的长参数）、启动器（把两条线交给 dsh 与 rulith-runtime）。
// 这里不依赖别的模块，所以前两者可以互相用对方的东西而不成环。
//
// 两条线（所有者：都按模型上下文窗口的比例定，都可在 deep-rulith.json 设置）：
//   - 减负线 reliefRatio（默认 RELIEF_RATIO 0.7）：最近一次请求的真实提示到了这里，较早的 Rulith 结果与旧回答的长参数一批减负。
//   - 压缩线 compactionRatio（默认 COMPACTION_RATIO 0.8）：dsh 的 compaction-basic 在这里把较早的对话压成摘要（要解码几分钟，
//     而且有损）。dsh 的压缩线是 min(窗口 × thresholdRatio, 窗口 − 请求的 maxTokens − headroomTokens)（dsh-compaction-basic
//     lib/index.js resolveCompactSpec）。dsh 默认 headroomTokens 65536：262144 的窗口、maxTokens 32768 时后一项是 163840，
//     比 0.8 × 窗口先起作用，所以以前实际在约 160K 压缩。启动器把 thresholdRatio 设为 compactionRatio，headroomTokens 设为
//     COMPACTION_HEADROOM_TOKENS（16384），后一项（212992）不再先起作用，压缩线就是 0.8 × 262144 = 209715。dsh 的摘要请求的
//     输出上限默认等于 headroomTokens，所以另设 COMPACTION_SUMMARY_MAX_TOKENS（32768，与 Agent 自己的输出上限相同）：
//     2026-10-14 的三次摘要输出 6～8K token，而 65536 会让压缩线附近的摘要请求（被压缩的一段再加输出）贴近窗口。
//   - 减负线必须在压缩线之前，否则减负永远轮不到。启动器只拒绝本身就不成立的设置（比例不在 0 与 1 之间，或减负比例不小于
//     压缩比例）。窗口较小时 dsh 的实际压缩线会因“窗口 − maxTokens − headroom”而更低（0.8 时窗口小于 245760 就会），这时
//     实际的减负线取 min(reliefRatio × 窗口, 实际压缩线 − RELIEF_MARGIN)：留出约一步的增长，保证先减负。实际的两条线按
//     会话所用的模型路线（窗口与请求的 maxTokens）在运行时算出，并记在日志里。默认设置下两线相差 0.1 × 窗口（262144 时约
//     26K token），约是一步的增长。挪动一条线时连另一条一起看。

/** 默认减负比例：最近一次请求的真实提示达到模型上下文窗口的这个比例时触发（deep-rulith.json 的 reliefRatio 可改）。 */
export const RELIEF_RATIO = 0.7;
/** 启动器给 dsh 的默认压缩比例（deep-rulith.json 的 compactionRatio 可改）。 */
export const COMPACTION_RATIO = 0.8;
export const COMPACTION_HEADROOM_TOKENS = 16384;
export const COMPACTION_SUMMARY_MAX_TOKENS = 32768;
/** 不经启动器时 dsh 自己的默认值（dsh-compaction-basic：thresholdRatio 0.8，headroomTokens 65536）。 */
export const DSH_THRESHOLD_RATIO = 0.8;
export const DSH_HEADROOM_TOKENS = 65536;
/** 实际压缩线之前至少留出的余量：约一步的增长。 */
export const RELIEF_MARGIN = 20000;

/** dsh compaction-basic 的压缩线（与它的 resolveCompactSpec 同一算式）。 */
export const compactionLine = (contextWindow, ratio, maxTokens, headroomTokens) =>
  Math.floor(Math.min(contextWindow * ratio, contextWindow - maxTokens - headroomTokens));

/**
 * 一条模型路线上实际的两条线（token）。compaction 是交给 dsh compaction-basic 的那份配置（thresholdRatio、headroomTokens；
 * 缺省为 dsh 的默认值），maxTokens 是请求的输出上限（会话里记下的请求头；没有记为 0）。
 */
export function contextLinesFor({ contextWindow, maxTokens = 0, reliefRatio = RELIEF_RATIO, compaction = {} }) {
  const compactAt = compactionLine(contextWindow, compaction.thresholdRatio ?? DSH_THRESHOLD_RATIO, maxTokens,
    compaction.headroomTokens ?? DSH_HEADROOM_TOKENS);
  return { relief: Math.max(0, Math.min(Math.floor(reliefRatio * contextWindow), compactAt - RELIEF_MARGIN)), compaction: compactAt };
}

/**
 * 减负标记：board-transcript.mjs 在一批减负的边界结果末尾写下的一行（模型可见）。标记所在结果及之前的 Rulith 结果已减负，
 * 之前的模型回答里的长参数在发出时缩短。只认 board-transcript 按结构认出的带板结果的最后一行，别处出现的同样文字不算。
 */
export const RELIEF_MARK = 'Context relieved up to here: earlier Rulith results keep only their outcome and Board changes, and long tool-call arguments are shortened; the Board holds the state.';

// ---- 长参数怎样缩短（outgoing-trim.mjs 发出时用；board-transcript.mjs 估算一批能省多少时用同一个函数）----

export const LONG_ARGUMENT = 4096;
export const ARGUMENT_HEAD = 400;

/** 一个过长参数的替身：开头 ARGUMENT_HEAD 个字符（不劈开代理对），原长与 sha256 前 16 位。 */
export function clearedArgument(text) {
  let end = ARGUMENT_HEAD;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return `${text.slice(0, end)}… [cleared to save context: ${text.length} characters, sha256 ${digest}]`;
}

/** 递归缩短长字符串；没有变化时原样返回同一个值。对象用 fromEntries 重建，`__proto__` 这样的键也只是普通的键。 */
function shorten(value) {
  if (typeof value === 'string') return value.length > LONG_ARGUMENT ? clearedArgument(value) : value;
  if (value === null || typeof value !== 'object') return value;
  let changed = false;
  const visit = (child) => { const next = shorten(child); if (next !== child) changed = true; return next; };
  const next = Array.isArray(value) ? value.map(visit) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  return changed ? next : value;
}

/**
 * 一个工具调用的原始 JSON 参数，长字符串缩短后的样子。解析不了或顶层不是对象的参数不动：dsh 的 pi-ai 适配器本来就把它们
 * 按 {} 发出。重新序列化与适配器发出时的 JSON.stringify 相同，所以除缩短处外线上内容不变。
 */
export function shortenArguments(raw) {
  if (typeof raw !== 'string' || raw.length <= LONG_ARGUMENT) return raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const next = shorten(parsed);
  return next === parsed ? raw : JSON.stringify(next);
}
