// 启动器（start-deep-rulith.mjs）里不读设置文件、不启动任何东西的部分，单独放在这里以便测试。
import fs from 'node:fs';
import path from 'node:path';
import { COMPACTION_HEADROOM_TOKENS, COMPACTION_RATIO, COMPACTION_SUMMARY_MAX_TOKENS, RELIEF_RATIO } from './context-relief.mjs';

export function conversationBoards(settings = {}, env = process.env) {
  const value = settings.conversationBoards;
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`Deep Rulith: conversationBoards in the settings must be a boolean (got ${JSON.stringify(value)})`);
  }
  if (env.RULITH_DSH_CONVERSATION_BOARDS === '0') return false;
  if (env.RULITH_DSH_CONVERSATION_BOARDS === '1') return true;
  return value ?? true;
}

/**
 * 设置里的两条线（deep-rulith.json 的 reliefRatio 与 compactionRatio，缺省取默认值；含义见 context-relief.mjs）。
 * 只拒绝本身不成立的设置：比例不在 0 与 1 之间，或减负比例不小于压缩比例——这时启动器拒绝启动。窗口较小、dsh 实际的
 * 压缩线更低时不拒绝：实际的减负线在运行时按会话的路线压到压缩线之前（board-transcript.mjs 记日志）。
 */
export function contextLines(settings = {}) {
  const reliefRatio = settings.reliefRatio ?? RELIEF_RATIO;
  const compactionRatio = settings.compactionRatio ?? COMPACTION_RATIO;
  for (const [name, value] of [['reliefRatio', reliefRatio], ['compactionRatio', compactionRatio]]) {
    if (typeof value !== 'number' || !(value > 0 && value < 1)) throw new Error(`Deep Rulith: ${name} in the settings must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
  }
  if (reliefRatio >= compactionRatio) {
    throw new Error(`Deep Rulith: reliefRatio (${reliefRatio}) must be below compactionRatio (${compactionRatio}), or dsh compacts before context relief can act`);
  }
  return { reliefRatio, compactionRatio };
}

/**
 * 交给 dsh 的环境变量：rulith-web.cordis.yml 读它们设定 rulith-runtime 的减负比例，以及 dsh compaction-basic 的压缩配置
 * （thresholdRatio、headroomTokens、摘要的输出上限；rulith-runtime 也读同一份，好算出实际的压缩线）。
 */
export const contextEnv = ({ reliefRatio, compactionRatio }) => ({
  RULITH_DSH_RELIEF_RATIO: String(reliefRatio),
  RULITH_DSH_COMPACTION: JSON.stringify({ thresholdRatio: compactionRatio, headroomTokens: COMPACTION_HEADROOM_TOKENS,
    maxTokens: COMPACTION_SUMMARY_MAX_TOKENS }),
});

// 平台审查（D-1013f）走本机 Worker 的模型路线。下面是写进各个启用了 Worker 的实例 worker.env 的几项。
// 推理模型会把一部分 max_tokens 花在思考上：2026-10-14 用 2～2.5 万字符的审查材料重放，8000 全花在了思考上，所以给 16000。
// Runtime 0.16.3 起事后审查的时间只按 Gateway 报价里的 remainingMs 算（期限可设 60～300 s），RULITH_REVIEWER_TIMEOUT_MS 只管
// 宪法清关审查、用它自己的缺省；0.16.2 时代这里写过 300000，现在写 undefined，让 writeReviewerEnv 把旧值从 worker.env 删掉。
export const REVIEWER_MAX_TOKENS = '16000';
export const reviewerEnv = ({ baseURL, modelId, key, extra }) => ({
  RULITH_REVIEWER_URL: `${baseURL}/chat/completions`, RULITH_REVIEWER_MODEL: String(modelId),
  RULITH_REVIEWER_KEY: key, RULITH_REVIEWER_MAX_TOKENS: REVIEWER_MAX_TOKENS, RULITH_REVIEWER_TIMEOUT_MS: undefined,
  // undefined：设置里两项都没有，写入时从 worker.env 删掉这一项（见 writeReviewerEnv）。
  RULITH_REVIEWER_REQUEST_EXTRA: extra,
});

// 审查员思考开关（D-1014c 补充，负责人 2026-10-14）：本机引擎缺省不思考，每个请求可用
// chat_template_kwargs.enable_thinking 开关思考；这样主智能体可以不思考，而影子审查员思考。
// deep-rulith.json 的 reviewerThinking：false、true，或档位 "low"／"medium"／"high"（思考，并带 reasoning_effort）；不设就什么都不发。
// reviewerRequestExtra：一个 JSON 对象，原样写出，优先于 reviewerThinking。2026-10-14 在本机引擎上核实：chat_template_kwargs.enable_thinking
// 开关思考有效，reasoning_effort 的 low／medium／high 有档次（同一题思考 435／538／1152 字符，high 等于只开思考）；
// chat_template_kwargs.thinking_budget 与顶层 enable_thinking 不生效。换参数时用 reviewerRequestExtra，不必改代码。
// 两项都按 Runtime 的同一条规则拒绝 Worker 掌管的键；不成立的设置让启动器拒绝启动。
// Runtime 0.16.3 起 Worker 才读 RULITH_REVIEWER_REQUEST_EXTRA；依赖还是 ^0.16.2 时它被忽略。
export const REVIEWER_REQUEST_RESERVED_KEYS = Object.freeze(['model', 'messages', 'max_tokens', 'temperature', 'stream', 'tools', 'tool_choice', 'n']);
export const REVIEWER_THINKING_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** 设置里的审查员请求附加字段，作为 RULITH_REVIEWER_REQUEST_EXTRA 的值（JSON 文本）；两项都没设时为 undefined。 */
export function reviewerRequestExtra(settings = {}) {
  const thinking = settings.reviewerThinking;
  if (thinking !== undefined && thinking !== true && thinking !== false && !REVIEWER_THINKING_LEVELS.includes(thinking)) {
    throw new Error(`Deep Rulith: reviewerThinking in the settings must be false, true, "low", "medium" or "high" (got ${JSON.stringify(thinking)})`);
  }
  const raw = settings.reviewerRequestExtra;
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Deep Rulith: reviewerRequestExtra in the settings must be a JSON object');
    }
    const reserved = Object.keys(raw).filter((key) => REVIEWER_REQUEST_RESERVED_KEYS.includes(key));
    if (reserved.length > 0) {
      throw new Error(`Deep Rulith: reviewerRequestExtra in the settings may not set ${reserved.join(', ')}; the Worker controls ${reserved.length === 1 ? 'it' : 'them'}`);
    }
    return JSON.stringify(raw);
  }
  if (thinking === undefined) return undefined;
  if (thinking === true || thinking === false) return JSON.stringify({ chat_template_kwargs: { enable_thinking: thinking } });
  if (REVIEWER_THINKING_LEVELS.includes(thinking)) {
    return JSON.stringify({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: thinking });
  }
  throw new Error(`Deep Rulith: reviewerThinking in the settings must be false, true, "low", "medium" or "high" (got ${JSON.stringify(thinking)})`);
}

/**
 * 把这几项写进 managerHome 下每个启用了 Worker 的实例的 local.json（worker.env），其余内容原样保留；已经一样的不写。
 * 值为 undefined 的项从 worker.env 删掉。先写临时文件再改名，权限 0600（含密钥）。返回写了几个实例。
 */
export function writeReviewerEnv(managerHome, wantDefault, overrides = []) {
  const instances = path.join(managerHome, 'instances');
  // 按 Agent 名前缀改用别的审查员路线（reviewerRoutes）：实例 id 到 Agent 名的对应取自管理器的 registry.json。
  const names = new Map();
  const registry = path.join(managerHome, 'registry.json');
  if (overrides.length > 0 && fs.existsSync(registry)) {
    for (const row of JSON.parse(fs.readFileSync(registry, 'utf8')).instances ?? []) names.set(row.id, row.agentName ?? row.name ?? '');
  }
  let written = 0;
  for (const name of fs.existsSync(instances) ? fs.readdirSync(instances) : []) {
    const file = path.join(instances, name, 'local.json');
    if (!fs.existsSync(file)) continue;
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!local.worker?.enabled) continue;
    const agentName = names.get(name) ?? '';
    const want = overrides.find((o) => agentName.startsWith(o.agentPrefix))?.env ?? wantDefault;
    const env = local.worker.env ?? {};
    if (Object.entries(want).every(([k, v]) => (v === undefined ? !Object.hasOwn(env, k) : env[k] === v))) continue;
    const next = { ...env };
    for (const [k, v] of Object.entries(want)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    local.worker.env = next;
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    written += 1;
  }
  return written;
}

/**
 * deep-rulith.json 的 reviewerRoutes：[{ agentPrefix, provider, model, reviewerThinking?, reviewerRequestExtra? }]。
 * Agent 名以 agentPrefix 开头的实例，审查员改走该提供商与模型（取 dsh 配置里同名提供商的地址与密钥来源），
 * 附加字段按同一规则各自计算；其余实例仍走 agent-default-model。用于同一台机器上并行的不同实验组。
 */
export function reviewerRoutes(settings = {}) {
  const routes = settings.reviewerRoutes ?? [];
  if (!Array.isArray(routes)) throw new Error('Deep Rulith: reviewerRoutes in the settings must be a list');
  return routes.map((r) => {
    if (!r || typeof r.agentPrefix !== 'string' || !r.agentPrefix || typeof r.provider !== 'string' || typeof r.model !== 'string') {
      throw new Error('Deep Rulith: each reviewerRoutes entry needs agentPrefix, provider and model');
    }
    return { agentPrefix: r.agentPrefix, provider: r.provider, model: r.model, extra: reviewerRequestExtra(r) };
  });
}
