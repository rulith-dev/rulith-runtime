// 发给模型的那份对话，发出前再减一次负（2026-10-14；取代 10-09 的 thinking-history.mjs）。
//
// 10-09 起“之前轮次的思考不再发回模型”从没在生产里生效：它用 dsh 的“替换”记录改写 assistant/message，已安装的 dsh
// 拒绝替换模型回答（回答内嵌模型的原始输出流）；错误被接住只记日志，于是之前每一轮的思考在之后每次请求里都原样重发。
// 同一限制也挡住了清理旧工具调用的长参数（例如 eng.write_file 的整段文本，重的会话里 8.5～9.6 万字符）。
//
// 现在不改会话，只改发出去的那一份：挂在 dsh 公开的 `llm/stream` 瀑布上（dsh-llm 0.2.1-alpha.1，lib/index.js:2365，
// 每次模型调用都经过它；dsh 的接口目录写明监听者可以 next() 往下走，也可以自己给出分片“短路”，用途包括 retry、replay、
// routing）。重放这个对话的请求（Agent 自己的请求与 dsh 压缩的摘要请求，两者都带 toolHistory）需要减负时，这里不再往下走，
// 而把减负后的副本交给同一个 LlmRuntime 的 stream() 重新发出：副本再走一遍整条瀑布，其他监听者（落盘检查点等）照常看到它，
// 我们自己发出的副本直接放行。会话、日志、界面上的对话一概不改。
//
// 两条规则：
//   1. 最后一条“人或上级 Agent 发来的消息”（role user，source.kind 为 user 或 agent-message）之前的模型回答，去掉思考块；
//      从那条消息起（当前这一轮）保留思考：DeepSeek 思考模式在同一轮的工具调用之间需要它，模型也要接着自己的思路。
//      dsh 压缩留下的摘要（compact-checkpoint）与项目上下文（rulith-project）也是 user 角色，但会出现在一轮中间，不算新一轮。
//   2. 减负边界之前的模型回答里，工具调用参数中长于 LONG_ARGUMENT 个字符的字符串（任意嵌套深度），换成
//      “前 ARGUMENT_HEAD 个字符… [cleared to save context: N characters, sha256 <16 hex>]”。边界是最新一份以减负标记
//      （RELIEF_MARK）结尾的带板 Rulith 结果；没有标记就没有边界，什么参数都不缩短。
//      边界由 board-transcript.mjs 决定（2026-10-14 起：只在最近一次请求的真实提示到了减负线、而且一批能省够时才移动），
//      并以替换记录写进会话，这里只读它，不自己开窗口：结果减负与参数缩短永远是同一个边界。
//
// 不变式（中文写明，便于审计）：
//   1. 只去掉思考块、只缩短边界之前回答里的长字符串参数；正文、调用 ID、工具名、工具结果、消息的顺序与 ID 都不变。
//   2. 纯函数：同一份消息列表得到同一份结果（没有跨请求的状态，重启、重放结果相同）；减过的再减一遍不变（缩短后的字符串
//      远短于 LONG_ARGUMENT）。所以发出的前缀只在两种时候变：人发来新一轮消息（上一轮的思考一次去掉），一批减负加了新的
//      标记（新落到边界之前的回答从此固定为缩短的样子）。其余时候前缀逐字不变，模型服务的前缀缓存照常命中。
//   3. 回答的 replayState（适配器私有；pi-ai 的 blocks 与正文逐块对齐）随思考块一起去掉对应项，适配器照常按原生格式重放；
//      对不齐的不动（适配器自己会退回通用格式）。参数缩短不改块数。
//   4. 失败要看得见：减负出错时这一次原样发出，并按对话警告一次；一个对话已有过模型请求却从没经过这里（dsh 的请求路径变了），
//      也按对话警告一次。不能再像 thinking-history 那样悄无声息地失效。
//   5. 发出的副本是记录下来的请求的确定性函数，所以仍可由会话日志加这份代码重算；但 dsh 自己的会话导出、检查器显示的是
//      未减负的原请求。
//   6. dsh 压缩把从对话开头起的一段换成摘要：标记若被压缩掉，它之前的回答也都被压缩掉了，剩下的对话里没有更早的回答可缩短。
//   7. 标记只认 board-transcript.mjs 的分类器认出的带板结果的最后一行（reliefBoundary）：Get 读到的文件、子 Agent 的回答
//      等工具内容里出现同样的文字，不能冒充边界。

import { reliefBoundary } from './board-transcript.mjs';
import { shortenArguments } from './context-relief.mjs';
// 长参数怎样缩短在 context-relief.mjs 里（board-transcript.mjs 估算一批能省多少时用同一个函数）；这里照旧导出。
export { ARGUMENT_HEAD, LONG_ARGUMENT, clearedArgument, shortenArguments } from './context-relief.mjs';

const TURN_SOURCES = new Set(['user', 'agent-message']);
const REASONING = 'reasoning';
const TOOL_CALL = 'tool-call';

// 同一个（冻结的）调用块在一次次请求里反复出现；记住它的缩短结果，免得每次重新解析几万字符。只是纯函数的缓存。
const shortened = new WeakMap();
const shortenCall = (block) => {
  if (!shortened.has(block)) shortened.set(block, shortenArguments(block.arguments));
  return shortened.get(block);
};

function trimReply(message, dropReasoning, shortenCalls) {
  const content = message.content;
  const blocks = [], kept = [];
  let changed = false;
  content.forEach((block, index) => {
    if (dropReasoning && block?.type === REASONING) { changed = true; return; }
    let next = block;
    if (shortenCalls && block?.type === TOOL_CALL) {
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

/** 发出前的那份消息列表减负后的样子；没有可减的就原样返回同一个数组。 */
export function trimOutgoing(messages) {
  let turnStart = -1;
  messages.forEach((message, index) => {
    if (message?.role === 'user' && TURN_SOURCES.has(message.source?.kind)) turnStart = index;
  });
  // 减负边界：最新一份以减负标记结尾的带板结果；它之前的回答算“更早”。没有标记时没有更早的。
  const oldBefore = reliefBoundary(messages);
  let out = null;
  messages.forEach((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    const next = trimReply(message, index < turnStart, index < oldBefore);
    if (next === message) return;
    out ??= [...messages];
    out[index] = next;
  });
  return out ? Object.freeze(out) : messages;
}

/** 重放一个对话的请求：Agent 自己的请求（dsh-agent-loop lib/index.js:1272）与 dsh 压缩的摘要请求都带 toolHistory；
 * 会话标题、影子审查这类单发请求不带。 */
export const replaysConversation = (options) => Array.isArray(options?.messages) && Object.hasOwn(options, 'toolHistory');

const reasonOf = (error) => String(error?.message ?? error).slice(0, 300);

/** 挂到 dsh 的 `llm/stream` 瀑布：发出前减负；失败或没经过这里时按对话警告一次。 */
export function installOutgoingTrim(ctx) {
  const ours = new WeakSet(); // 这里发出的副本：再次经过时直接放行
  const reached = new Set(); // 请求经过过这里的对话
  const warned = new Set();
  const warnOnce = (sessionId, text) => {
    const key = String(sessionId ?? '');
    if (warned.has(key)) return;
    warned.add(key);
    ctx.logger.warn(`rulith outgoing trim (conversation ${key || 'without a session id'}): ${text}`);
  };
  ctx.on('llm/stream', function outgoingTrim(options, next) {
    if (ours.has(options) || !replaysConversation(options)) return next();
    if (options.sessionId !== undefined) reached.add(String(options.sessionId));
    let messages;
    try {
      messages = trimOutgoing(options.messages);
    } catch (error) {
      warnOnce(options.sessionId, `a request went out untrimmed (${reasonOf(error)})`);
      return next();
    }
    if (messages === options.messages) return next();
    const request = Object.freeze({ ...options, messages });
    ours.add(request);
    return this.stream(request); // this：派发这次瀑布的 LlmRuntime（dsh 的签名 'llm/stream'(this: LlmRuntime, options, next)）
  });
  // 第 2 步起，这一轮的第 1 步一定已经请求过模型；那次请求若没经过上面，说明 dsh 的请求路径变了，减负没有生效。
  ctx.on('agent/pre-step', (payload, next) => {
    const id = payload?.agent?.session?.id;
    if (payload?.step > 1 && id !== undefined && !reached.has(String(id)))
      warnOnce(id, 'its model requests did not pass the llm/stream listener; earlier reasoning and long old tool arguments are sent in full');
    return next();
  });
}
