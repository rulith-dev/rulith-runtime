// 发给模型的那份对话，发出前再整理一次（2026-10-14；取代 10-09 的 thinking-history.mjs；2026-10-26 起按 D-1026b
// “两次减负之间只追加”）。
//
// 10-09 起“之前轮次的思考不再发回模型”从没在生产里生效：它用 dsh 的“替换”记录改写 assistant/message，已安装的 dsh
// 拒绝替换模型回答（回答内嵌模型的原始输出流）；错误被接住只记日志，于是之前每一轮的思考在之后每次请求里都原样重发。
// 同一限制也挡住了清理旧工具调用的长参数（例如 eng.write_file 的整段文本，重的会话里 8.5～9.6 万字符）。
//
// 现在不改会话，只改发出去的那一份：挂在 dsh 公开的 `llm/stream` 瀑布上（dsh-llm 0.2.1-alpha.1，lib/index.js:2365，
// 每次模型调用都经过它；dsh 的接口目录写明监听者可以 next() 往下走，也可以自己给出分片“短路”，用途包括 retry、replay、
// routing）。重放这个对话的请求（Agent 自己的请求与 dsh 压缩的摘要请求，两者都带 toolHistory）需要整理时，这里不再往下走，
// 而把整理后的副本交给同一个 LlmRuntime 的 stream() 重新发出：副本再走一遍整条瀑布，其他监听者（落盘检查点等）照常看到它，
// 我们自己发出的副本直接放行。会话、日志、界面上的对话一概不改。
//
// 三条规则：
//   1. 思考块只在两个条件都成立时去掉（D-1026b，审查 P1-2）：回答在减负边界之前，而且在最后一条开始新一轮的消息（人发来的，
//      或上级 Agent 发给子 Agent 的；context-relief.mjs 的 startsTurn）之前。实际观察到的情况：DeepSeek 的指南说带工具调用
//      时要把思考发回；10-14～10-26 生产里每当人发来新一轮消息，就把以前各轮的思考全部去掉，DeepSeek 上没有出过错。所以这里
//      当前这一轮的思考一定发回（这是严格要求的），以前各轮的思考也照发，只随一批减负去掉——10-14～10-26 那样每轮都去，
//      发出的前缀从上一轮开头起就变了，模型服务要从那里重新预填（10-26 本机实测一次 7.3 万个 token、约 56 秒）。
//   2. 减负边界之前的模型回答里，工具调用参数中长于 LONG_ARGUMENT 个字符的字符串（任意嵌套深度），换成
//      “前 ARGUMENT_HEAD 个字符… [cleared to save context: N characters, sha256 <16 hex>]”。
//      边界是最新一份以减负标记（RELIEF_MARK）结尾的带板 Rulith 结果；没有标记就没有边界，什么思考与参数都不动。
//      边界由 board-transcript.mjs 决定（2026-10-14 起：只在最近一次请求的真实提示到了减负线、而且一批能省够时才移动），
//      并以替换记录写进会话，这里只读它，不自己开窗口：结果减负、思考去掉与参数缩短永远是同一个边界。
//   3. 当前整视图（D-1026b）：Agent 自己的请求（不带 purpose；dsh 压缩的摘要请求带 purpose "compaction"，不接）里，
//      对话有带板 Rulith 结果时，在最后一条 user 角色的消息（人的消息，也可以是 dsh 的重复调用提醒或项目上下文那一行）或
//      工具结果（不论哪个工具；它之后只可能还有 dsh 的系统／开发者更新，审查 P2-6）的末尾加一个正文块：空一行，然后是
//      board-transcript.mjs 的 currentBoard 算出的当前整视图（TAIL_HEAD 起）。工具结果没有正文时，dsh 的 pi-ai 适配器发出的
//      是“(no output)”（EMPTY_RESULT），所以正文块以它开头，下一次请求里这条结果照样是“(no output)”，仍是前缀。
//      它只在发出的副本里：不写进会话，界面上看不到；对话里的 Rulith 结果只留各自的变化（board-transcript.mjs）。它在发出时
//      由会话算出（会话在这一步的 agent/pre-step 记下；同一瀑布里随后才跑的 dsh 压缩也已经算在里面，审查 P2-8），并核对：
//      它所依据的那份带板结果必须是这份消息列表里最新的一份，否则这次不接；每次没接上都记日志。
//      Anthropic 协议的路线（model-runtime.mjs）上，pi-ai 把对话唯一的缓存断点放在最后一条用户消息的最后一块，也就是当前
//      整视图所在的那块，对话部分就永远读不到缓存（审查 P2-1）。withBoardCache 借 pi-ai 公开的 onPayload 选项，把断点挪到
//      当前整视图之前的那段内容上，当前整视图另成一块跟在后面（cacheBeforeBoard）；断点个数不变。只拆这次请求里本模块确实
//      接上的那段文字（按对话记下，逐字比对结尾），从不按样式找：网页或人贴来的文字里出现同样的表头，不会被拆。dsh 把末尾的
//      系统更新转成一条 user 消息时，当前整视图在它前一条消息里，也照样拆，断点移到那里。
//
// 不变式（中文写明，便于审计）：
//   1. 只去掉规则 1 所说回答里的思考块、只缩短边界之前回答里的长字符串参数、只加当前整视图这一个正文块；其余正文、调用 ID、
//      工具名、工具结果、消息的顺序与 ID 都不变。
//   2. 纯函数：trimOutgoing 对同一份消息列表与同一段当前整视图得到同一份结果（没有跨请求的状态，重启、重放结果相同）；
//      整理过的再整理一遍不变（缩短后的字符串远短于 LONG_ARGUMENT；已经接上同一段当前整视图的不再接）。
//   3. 两次减负之间只追加（D-1026b）：每次发出的消息列表去掉当前整视图之后，都是上一次发出的列表（同样去掉它）在末尾追加
//      的结果，所以新请求与上一次只在上一次当前整视图开始处分叉，模型服务的前缀缓存命中其余全部。board-transcript.mjs 保证
//      会话里的历史只追加，这里保证发出时的整理也只看边界与轮次。例外，逐条：
//      a. 一批减负之后的第一次请求：边界及之前的结果减负，边界之前回答的长参数缩短、其中在最后一条开始新一轮的消息之前的
//         思考去掉。
//      b. 边界落在一轮当中时（在那一轮开始的消息之后），那一轮边界之前的回答先留着思考；下一条开始新一轮的消息到来后的
//         第一次请求，去掉的正是这些回答的思考（只有它们）。
//      c. dsh 的“替换”（压缩，或别的替换）从被替换处起开始新的一串；项目的 Source 真的变了时，project-source.mjs 替换项目
//         上下文那一行，也从那里起开始新的一串（读 Source 失败时不动它）。
//      d. 升级前的对话：以前的版本留在最后的整视图在升级后的第一次请求之前降为变化，只此一次（board-transcript.mjs）。
//      e. 只关缓存、不关发出的内容：Anthropic 协议路线上 cacheBeforeBoard 只往回看两条消息，而且只拆当前整视图接在正文
//         末尾的那一块。末尾有两条以上 dsh 的系统更新（各转成一条 user 消息），或者当前整视图本来就单独成一块（它前面的
//         最后一块不是正文，例如图片），断点就留在原处（当前整视图上），这次请求的对话部分读不到缓存。
//   4. 回答的 replayState（适配器私有；pi-ai 的 blocks 与正文逐块对齐）随思考块一起去掉对应项，适配器照常按原生格式重放；
//      对不齐的不动（适配器自己会退回通用格式）。参数缩短不改块数。
//   5. 失败要看得见：整理出错时这一次原样发出，并按对话警告一次；一个对话已有过模型请求却从没经过这里（dsh 的请求路径变了），
//      也按对话警告一次；当前整视图算不出或与消息列表对不上时这次不接，每次都记日志。
//   6. 发出的副本是记录下来的请求与会话的确定性函数，所以仍可由会话日志加这份代码重算；但 dsh 自己的会话导出、检查器显示的是
//      未整理的原请求。
//   7. dsh 压缩把从对话开头起的一段换成摘要：标记若被压缩掉，它之前的回答也都被压缩掉了，剩下的对话里没有更早的回答可整理；
//      最新一份带板结果被压缩掉了，就没有当前整视图（直到下一份带板结果）。
//   8. 标记只认 board-transcript.mjs 的分类器认出的带板结果的最后一行（reliefBoundary）：Get 读到的文件、子 Agent 的回答
//      等工具内容里出现同样的文字，不能冒充边界。边界在加当前整视图之前、按收到的消息列表认。

import { TAIL_HEAD, classify, currentBoard, reliefBoundary } from './board-transcript.mjs';
import { shortenArguments, startsTurn } from './context-relief.mjs';
// 长参数怎样缩短在 context-relief.mjs 里（board-transcript.mjs 估算一批能省多少时用同一个函数）；这里照旧导出。
export { ARGUMENT_HEAD, LONG_ARGUMENT, clearedArgument, shortenArguments } from './context-relief.mjs';

const REASONING = 'reasoning';
const TOOL_CALL = 'tool-call';
/** 当前整视图与它所接的那条消息原有正文之间空一行（适配器把同一条消息的正文块直接相连）。 */
export const TAIL_SEPARATOR = '\n\n';
/**
 * 没有正文的工具结果，dsh 的 pi-ai 适配器发出的文字（dsh-llm-pi-ai toolResultOf：`content || "(no output)"`；测试核对已安装的
 * 版本）。当前整视图接在这样的结果上时以它开头，发出的仍是同一段前缀。
 */
export const EMPTY_RESULT = '(no output)';
/** 内存里最多记这么多个对话的会话（每次 Agent 请求之前都重新记，所以挤掉的只影响已经不再请求的对话）。 */
const MAX_SESSIONS = 256;

// 同一个（冻结的）调用块在一次次请求里反复出现；记住它的缩短结果，免得每次重新解析几万字符。只是纯函数的缓存。
const shortened = new WeakMap();
const shortenCall = (block) => {
  if (!shortened.has(block)) shortened.set(block, shortenArguments(block.arguments));
  return shortened.get(block);
};

/** 边界之前的一个回答：缩短长参数；dropReasoning 为真时（也在最后一条开始新一轮的消息之前）去掉思考块。 */
function trimReply(message, dropReasoning) {
  const content = message.content;
  const blocks = [], kept = [];
  let changed = false;
  content.forEach((block, index) => {
    if (dropReasoning && block?.type === REASONING) { changed = true; return; }
    let next = block;
    if (block?.type === TOOL_CALL) {
      const args = shortenCall(block);
      if (args !== block.arguments) { next = Object.freeze({ ...block, arguments: args }); changed = true; }
    }
    blocks.push(next);
    kept.push(index);
  });
  if (!changed) return message;
  let source = message.source;
  const replay = source?.replayState;
  if (kept.length !== content.length && Array.isArray(replay?.blocks) && replay.blocks.length === content.length) {
    const replayBlocks = kept.length ? kept.map((index) => replay.blocks[index]) : [Object.freeze({ type: 'text' })];
    source = Object.freeze({ ...source, replayState: Object.freeze({ ...replay, blocks: Object.freeze(replayBlocks) }) });
  }
  // 只有思考的回答：留一个空正文块（适配器把它当作没有内容的回答略过），消息本身与它的 ID 仍在。
  // 新建的对象都冻结（与 dsh 冻结 Agent 请求一致）；沿用的原对象不碰。
  if (blocks.length === 0) blocks.push(Object.freeze({ type: 'text', text: '' }));
  return Object.freeze({ ...message, content: Object.freeze(blocks), source });
}

const textOf = (message) => (Array.isArray(message?.content) ? message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '');

/**
 * 当前整视图接在哪条消息上：最后一条人的消息（user）或工具结果（tool），它之后只允许 dsh 的系统／开发者更新（审查 P2-6）；
 * 末尾是模型自己的回答等别的消息时没有（-1）。
 */
function tailTarget(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === 'user' || role === 'tool') return Array.isArray(messages[index].content) ? index : -1;
    if (role !== 'system' && role !== 'developer') return -1;
  }
  return -1;
}

/** 接在一条消息末尾的那个正文块的文字：空一行加当前整视图；没有正文的工具结果先照适配器的样子写 EMPTY_RESULT。 */
const tailText = (message, board) => (message.role === 'tool' && textOf(message) === '' ? EMPTY_RESULT : '') + TAIL_SEPARATOR + board.text;

/** 这份消息列表是否已经带着这段当前整视图（在 tailTarget 那条消息的最后一个正文块）。 */
export const carriesBoard = (messages, board) => {
  const at = tailTarget(messages);
  const block = at === -1 ? undefined : messages[at].content.at(-1);
  return block?.type === 'text' && (block.text === TAIL_SEPARATOR + board.text || block.text === EMPTY_RESULT + TAIL_SEPARATOR + board.text);
};

/**
 * 当前整视图该接在哪条消息上（tailTarget），而且它所依据的那份带板结果（board.toolCallId）是这份列表里最新的一份带板结果。
 * 对不上（列表里有更新的带板结果、或根本没有它）、没有可接的消息、或已经接上了同一段，返回 -1。
 */
function tailIndex(messages, board) {
  const at = tailTarget(messages);
  if (at === -1 || carriesBoard(messages, board)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== 'tool') continue;
    if (candidate.toolCallId === board.toolCallId) return classify(textOf(candidate)) === null ? -1 : at;
    if (classify(textOf(candidate)) !== null) return -1;
  }
  return -1;
}

/**
 * 发出前的那份消息列表整理后的样子；没有可整理的就原样返回同一个数组。board 是这个对话的当前整视图（currentBoard 的
 * { toolCallId, text }），null 为不接。
 */
export function trimOutgoing(messages, board = null) {
  // 减负边界：最新一份以减负标记结尾的带板结果；它之前的回答算“更早”。没有标记时没有更早的。
  const oldBefore = reliefBoundary(messages);
  // 当前这一轮从最后一条开始新一轮的消息起；它及之后的回答留着思考（规则 1）。没有这样的消息时整段都算当前这一轮。
  const turnStart = messages.findLastIndex(startsTurn);
  let out = null;
  for (let index = 0; index < oldBefore; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const next = trimReply(message, index < turnStart);
    if (next === message) continue;
    out ??= [...messages];
    out[index] = next;
  }
  const at = board === null ? -1 : tailIndex(messages, board);
  if (at !== -1) {
    out ??= [...messages];
    const message = messages[at];
    out[at] = Object.freeze({ ...message,
      content: Object.freeze([...message.content, Object.freeze({ type: 'text', text: tailText(message, board) })]) });
  }
  return out ? Object.freeze(out) : messages;
}

// ---- Anthropic 协议路线的缓存断点（审查 P2-1）----

// 对话 → 这次发出的请求里本模块接上的当前整视图（逐字，含开头的空行；没接时没有）。llm/stream 监听者在发出前记下，
// Anthropic 路线的 withBoardCache 按 pi-ai 选项里的 sessionId（dsh 的 pi-ai 适配器照传）取出：只拆这段，不按样式找。
// 同一对话的请求一次只发一个，所以“这次”是确定的。只在内存里。
const sentBoards = new Map();

/** 记下（text 为 null 时清掉）这个对话这次请求接上的当前整视图。 */
export function noteSentBoard(sessionId, text) {
  const key = String(sessionId);
  sentBoards.delete(key);
  if (text === null) return;
  sentBoards.set(key, text);
  if (sentBoards.size > MAX_SESSIONS) sentBoards.delete(sentBoards.keys().next().value);
}

/** text 恰好以 tail 结尾、而且之前还有内容时，返回之前的部分；否则 null。 */
const cut = (text, tail) => (typeof text === 'string' && text.endsWith(tail) && text.slice(0, -tail.length).trim() !== '' ? text.slice(0, -tail.length) : null);

/**
 * 一条用户消息的内容（字符串或块），最后一块恰好以 tail 结尾时拆开：{ content: 拆开后的块, at: 之前那部分的块的下标 }。
 * 工具结果里的当前整视图移出来、紧跟在这个工具结果之后（Anthropic 要求工具结果排在用户消息的最前面）。拆不了时 null。
 */
function splitTail(content, tail) {
  const board = { type: 'text', text: tail.slice(TAIL_SEPARATOR.length) };
  if (typeof content === 'string') {
    const before = cut(content, tail);
    return before === null ? null : { content: [{ type: 'text', text: before }, board], at: 0 };
  }
  if (!Array.isArray(content)) return null;
  const block = content.at(-1);
  let stable = null;
  if (block?.type === 'text') {
    const before = cut(block.text, tail);
    if (before !== null) stable = { ...block, text: before };
  } else if (block?.type === 'tool_result' && typeof block.content === 'string') {
    const before = cut(block.content, tail);
    if (before !== null) stable = { ...block, content: before };
  } else if (block?.type === 'tool_result' && Array.isArray(block.content) && block.content.at(-1)?.type === 'text') {
    const before = cut(block.content.at(-1).text, tail);
    if (before !== null) stable = { ...block, content: [...block.content.slice(0, -1), { ...block.content.at(-1), text: before }] };
  }
  return stable === null ? null : { content: [...content.slice(0, -1), stable, board], at: content.length - 1 };
}

/**
 * Anthropic Messages 的请求体（pi-ai 排好的 params）：pi-ai 把对话唯一的缓存断点（cache_control）放在最后一条用户消息的
 * 最后一块。tail 是这次请求里接上的当前整视图（逐字）。它在最后一条用户消息、或紧挨在前的一条用户消息（dsh 把末尾的系统
 * 更新转成了一条 user 消息时）的最后一块末尾时，把那一块拆成两块：之前的内容带上断点，当前整视图另成一个不带断点的正文块
 * 跟在后面；断点原来在后一条消息上时从那里拿掉。下一次请求里这条消息没有当前整视图，它的内容与这次断点之前的逐字相同，
 * 所以对话部分从缓存读。断点个数不变。不是这种情形时返回 undefined（pi-ai 照原样发出）：末尾两条以上系统更新、当前整视图
 * 本来就单独成一块（跟在图片等非正文块后面）时都是这样，只是这次读不到缓存（不变式 3 例外 e）。纯函数，不改传入的对象。
 */
export function cacheBeforeBoard(payload, tail) {
  const messages = payload?.messages;
  if (typeof tail !== 'string' || !tail.startsWith(TAIL_SEPARATOR) || !Array.isArray(messages)) return undefined;
  const last = messages.length - 1;
  const lastContent = messages[last]?.role === 'user' && Array.isArray(messages[last].content) ? messages[last].content : null;
  const mark = lastContent?.at(-1)?.cache_control;
  if (!mark) return undefined;
  for (const at of [last, last - 1]) {
    if (messages[at]?.role !== 'user') continue;
    const split = splitTail(messages[at].content, tail);
    if (split === null) continue;
    const out = [...messages];
    out[at] = { ...messages[at], content: split.content.map((block, index) => (index === split.at ? { ...block, cache_control: mark } : block)) };
    if (at !== last) {
      const { cache_control: _moved, ...rest } = lastContent.at(-1);
      out[last] = { ...messages[last], content: [...lastContent.slice(0, -1), rest] };
    }
    return { ...payload, messages: out };
  }
  return undefined;
}

/**
 * pi-ai 的流选项：这个对话这次请求接上了当前整视图时，加上 cacheBeforeBoard（接在调用方自己的 onPayload 之后）；
 * 没接时原样返回。Anthropic 协议路线用（model-runtime.mjs）。
 */
export function withBoardCache(options) {
  const tail = options?.sessionId === undefined ? undefined : sentBoards.get(String(options.sessionId));
  if (tail === undefined) return options;
  const prior = options.onPayload;
  return { ...options, onPayload: async (payload, model) => {
    const replaced = prior === undefined ? undefined : await prior(payload, model);
    return cacheBeforeBoard(replaced ?? payload, tail) ?? replaced;
  } };
}

/** 重放一个对话的请求：Agent 自己的请求（dsh-agent-loop lib/index.js:1272）与 dsh 压缩的摘要请求都带 toolHistory；
 * 会话标题、影子审查这类单发请求不带。 */
export const replaysConversation = (options) => Array.isArray(options?.messages) && Object.hasOwn(options, 'toolHistory');

/** Agent 自己的一步请求：dsh-agent-loop 发出的不带 purpose（dsh 压缩的摘要请求带 purpose "compaction"）。 */
const agentStep = (options) => options.purpose === undefined;

const reasonOf = (error) => String(error?.message ?? error).slice(0, 300);

/** 挂到 dsh 的 `llm/stream` 瀑布：发出前整理；失败或没经过这里时按对话警告一次，当前整视图没接上时每次记日志。 */
export function installOutgoingTrim(ctx) {
  const ours = new WeakSet(); // 这里发出的副本：再次经过时直接放行
  const reached = new Set(); // 请求经过过这里的对话
  const warned = new Set();
  // 对话 → 它的会话（每一步的 agent/pre-step 记下）：发出时由它算当前整视图。只在内存里，什么都不写进会话。
  const sessions = new Map();
  const label = (sessionId) => String(sessionId ?? '') || 'without a session id';
  const warnOnce = (sessionId, kind, text) => {
    const key = `${kind}\n${String(sessionId ?? '')}`;
    if (warned.has(key)) return;
    warned.add(key);
    ctx.logger.warn(`rulith outgoing trim (conversation ${label(sessionId)}): ${text}`);
  };
  const miss = (sessionId, text) => ctx.logger.warn(`rulith outgoing trim (conversation ${label(sessionId)}): ${text}`);
  ctx.on('llm/stream', function outgoingTrim(options, next) {
    if (ours.has(options) || !replaysConversation(options)) return next();
    const id = options.sessionId === undefined ? undefined : String(options.sessionId);
    if (id !== undefined) reached.add(id);
    const session = id !== undefined && agentStep(options) ? sessions.get(id) : undefined;
    let board = null;
    if (session !== undefined) {
      try {
        board = currentBoard(session);
      } catch (error) {
        miss(options.sessionId, `a request went out without the current Board: it could not be read from the conversation (${reasonOf(error)})`);
      }
    }
    let messages;
    try {
      messages = trimOutgoing(options.messages, board);
    } catch (error) {
      warnOnce(options.sessionId, 'trim', `a request went out untrimmed (${reasonOf(error)})`);
      // 这次原样发出、没有接上当前整视图：清掉上一次记下的，免得 Anthropic 路线的缓存断点按上一次的整视图去拆这次的请求。
      if (id !== undefined) noteSentBoard(id, null);
      return next();
    }
    const attached = board !== null && carriesBoard(messages, board);
    if (board !== null && !attached)
      miss(options.sessionId, 'a request went out without the current Board (it did not match the newest Board result, or no person message or tool result can carry it)');
    if (id !== undefined) noteSentBoard(id, attached ? TAIL_SEPARATOR + board.text : null);
    if (messages === options.messages) return next();
    const request = Object.freeze({ ...options, messages });
    ours.add(request);
    return this.stream(request); // this：派发这次瀑布的 LlmRuntime（dsh 的签名 'llm/stream'(this: LlmRuntime, options, next)）
  });
  // 每一步请求之前：记下这个对话的会话（发出时由它算当前整视图）。第 2 步起，这一轮的第 1 步一定已经请求过模型；
  // 那次请求若没经过上面，说明 dsh 的请求路径变了，整理没有生效。
  ctx.on('agent/pre-step', (payload, next) => {
    const session = payload?.agent?.session;
    const id = session?.id;
    if (payload?.step > 1 && id !== undefined && !reached.has(String(id)))
      warnOnce(id, 'path', 'its model requests did not pass the llm/stream listener; the current Board is not added, and earlier reasoning and long old tool arguments are sent in full');
    if (id !== undefined && session?.surface !== undefined) {
      const key = String(id);
      sessions.delete(key);
      sessions.set(key, session);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    return next();
  });
  ctx.on('session/disposed', (session) => { if (session?.id !== undefined) sessions.delete(String(session.id)); });
}
