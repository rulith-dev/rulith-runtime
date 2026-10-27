// The context window each model route is measured against (0.19.3, owner direction 2026-10-27).
//
// dsh measures a conversation against its route's context window: context relief (reliefRatio × window,
// board-transcript.mjs), dsh's pressure compaction (compactionRatio × window, compaction-basic) and the composer's
// context popover ("~194K / 1M") all read the window the route's adapter reports (model-runtime.mjs). Before 0.19.3 every
// route was 1M unless the developer setting `localContextWindow` named another, so a local llama.cpp server with a
// 262144-token slot was treated as 1M: neither relief nor compaction ran before the server refused the prompt.
//
// Which window a route has, first that applies (precedence):
//   1. set by the person in Settings → Model (any route; at least MIN_USABLE_CONTEXT_WINDOW, context-relief.mjs);
//   2. the developer setting `localContextWindow` (deep-rulith.json / RULITH_DSH_LOCAL_CONTEXT_WINDOW), local routes only;
//   3. detected from the model server, local routes only (below);
//   4. a local route whose server answered as a local inference server (llama.cpp, vLLM/SGLang, LM Studio or Ollama, each
//      recognised by its own answer) without saying its window: ASSUMED_LOCAL_CONTEXT_WINDOW (128K), shown as assumed,
//      with a hint in Settings asking the person to set it;
//   5. any other route: DEFAULT_CONTEXT_WINDOW (1M), as before 0.19.3 — hosted models, and a local or LAN address that is
//      not recognised as an inference server (a proxy to hosted models such as LiteLLM, one-api or a company gateway, or a
//      server not reached yet).
// A window a server reports is real even when it is below MIN_USABLE_CONTEXT_WINDOW (Ollama and LM Studio load models
// with 4096 by default): it is used as it is, and Settings says it is too small for Rulith and how to raise it.
//
// A local route is one whose base address is localhost, or an IP address on this computer or a private network: the
// ranges web_fetch refuses (web-tools.mjs blockedAddress: 127/8, ::1, 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT,
// Tailscale), 169.254/16, fc00::/7, fe80::/10, IPv4-mapped IPv6 of those), except the unspecified 0.0.0.0/8 and ::.
// Detection asks that server, with the key the app already holds for the model (sent as a Bearer token to that same
// origin, never logged, never stored here), for its per-request window: llama.cpp's `/props?model=…&autoload=false`
// (a router answers for that model if it is loaded; one model's server ignores the query) and then `/props`
// (`default_generation_settings.n_ctx`, the per-slot context the server enforces; never `n_ctx_train`), an OpenAI-style
// `/models` entry for the model id with `max_model_len` (vLLM, SGLang), LM Studio's loaded instance
// `config.context_length` (never `max_context_length`), or Ollama's running model `context_length`. Anything else (401,
// 404, a timeout, an answer that is not one of those) is unknown. All probes share one short deadline (3 s).
//
// Detection runs when a model is saved (the save waits for it, at most the deadline); once after the app's start, when
// an account is signed in (in the background); in the background at a turn's start when the route was not asked yet in
// this run, when the last try found no window a minute ago or more, or when the detected window is ten minutes old or
// more; and in the background after a request on the route was refused for exceeding the context window. A turn never
// waits for it: the window is read from memory when a turn starts, and a detected or changed window is given to the
// route's registered adapter then (model-runtime.mjs, no restart). The adapter is shared by every conversation on that
// route, so a turn already running on it may take the new window at its next request.
//
// What is kept on this computer: `rulith-context-windows.json` in the app's dsh home, one row per route (a hash of
// protocol, base address and model id, as model-runtime.mjs's route ids): the detected window, whether the server was
// recognised, the person's window, and for reading the file the base address and model id. No key, nothing secret. A
// window describes a model server and model, not an account, so the rows are not per account. The file is written only
// when a value changes; a failed detection keeps what was known (the server may simply be down for now). Nothing goes to
// the Gateway.
//
// 中文说明：每条模型路线按哪个上下文窗口来量（减负线、dsh 的压缩线、输入行上下文弹窗的分母都用它）。优先次序：人在设置里
// 填的（不得小于 Rulith 能用的最小窗口）> 开发者设置 localContextWindow（只对本机/局域网路线）> 从模型服务读到的（同上）>
// 认出是本机推理服务（llama.cpp、vLLM、LM Studio、Ollama 各按自己的回答认出）却没告知窗口时按 128K 估计（设置里标明是估计、
// 提示人填写）> 其余照旧 1M（托管模型，以及没认出是推理服务的本机/局域网地址，例如转发到托管模型的代理）。服务报告的窗口哪怕
// 太小也照实使用，设置里提示太小、怎么调大。读窗口用这台电脑已为该模型保存的密钥，只发给同一个服务、不打印不记录；保存模型
// 时、应用启动后（已登录时）、一轮开始时（本次运行还没问过、上次没读到且已过一分钟、读到的已过十分钟）以及路线上的请求因超出
// 窗口被拒之后各读一次（后台），从不让一轮等它。读到或改了之后在下一轮开始时交给这条路线的适配器，不需要重启；同一路线上
// 正在进行的一轮可能在它的下一次请求就用上。结果只存在本机（不发给 Gateway），不含密钥。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { modelEndpoint, modelReady } from '../../../local/model-settings.mjs';
import { blockedAddress } from '../web-tools.mjs';
import { MIN_USABLE_CONTEXT_WINDOW } from './context-relief.mjs';

/** The window of a route when nothing says otherwise (hosted models, and local addresses not recognised; as before 0.19.3). */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** The window assumed for a recognised local inference server that did not say its window and that nobody set. */
export const ASSUMED_LOCAL_CONTEXT_WINDOW = 131_072;
/** The one deadline all detection probes of a model share. */
export const DETECT_TIMEOUT_MS = 3000;
/** How long after a try that found no window a turn's start may ask again. */
export const DETECT_RETRY_MS = 60_000;
/** How long a detected window is used before a turn's start asks again. */
export const DETECT_REFRESH_MS = 600_000;
/** The windows a server may report; anything outside is not a window. A person's window is at least MIN_USABLE_CONTEXT_WINDOW. */
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 100_000_000;
export { MIN_USABLE_CONTEXT_WINDOW };
export const CONTEXT_WINDOWS_FILE = 'rulith-context-windows.json';

const text = (value) => (typeof value === 'string' ? value : '');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A window: a whole number of tokens from MIN to MAX (a string of digits counts); otherwise undefined. */
export function windowValue(value) {
  const number = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= MIN_CONTEXT_WINDOW && number <= MAX_CONTEXT_WINDOW ? number : undefined;
}

/** A window a person may set: a window, and at least MIN_USABLE_CONTEXT_WINDOW; otherwise undefined. */
export function personWindow(value) {
  const tokens = windowValue(value);
  return tokens !== undefined && tokens >= MIN_USABLE_CONTEXT_WINDOW ? tokens : undefined;
}

/** The route of a saved model, as model-runtime.mjs names it: a hash of protocol, base address and model id. */
export function routeKey(model) {
  const endpoint = modelEndpoint(text(model?.url));
  if (endpoint === undefined) return '';
  return createHash('sha256').update(`${endpoint.api}\u0000${endpoint.base}\u0000${text(model?.name).trim()}`).digest('hex').slice(0, 12);
}

const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addSubnet('0.0.0.0', 8, 'ipv4');
UNSPECIFIED.addAddress('::', 'ipv6');
/**
 * Whether an address is localhost, or an IP address on this computer or a private network (the ranges web_fetch refuses,
 * web-tools.mjs, IPv4-mapped IPv6 included), but not the unspecified 0.0.0.0/8 or ::. No name is looked up.
 */
export function isLocalModelServer(raw) {
  let host;
  try { host = new URL(text(raw).trim()).hostname; } catch { return false; }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  if (family === 0 || UNSPECIFIED.check(host, family === 4 ? 'ipv4' : 'ipv6')) return false;
  return blockedAddress(host);
}

/**
 * The window of a route from what is known about it, in the order above. `local`: a local route; `set`: the person's;
 * `developer`: the developer setting; `detected`: what its server reported; `recognized`: its server answered as a local
 * inference server. Returns `{ tokens, source }`, source one of set | developer | detected | assumed | default. Pure.
 */
export function resolveWindow({ local = false, set, developer, detected, recognized = false } = {}) {
  if (set !== undefined) return { tokens: set, source: 'set' };
  if (local && developer !== undefined) return { tokens: developer, source: 'developer' };
  if (local && detected !== undefined) return { tokens: detected, source: 'detected' };
  if (local && recognized) return { tokens: ASSUMED_LOCAL_CONTEXT_WINDOW, source: 'assumed' };
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

const entriesOf = (value, name) => (Array.isArray(value?.[name]) ? value[name] : []);
/**
 * What one probe's answer says: `{ recognized, tokens? }`. `recognized` only when the answer has that server's own shape
 * (an OpenAI-style model list without `max_model_len`, as proxies answer, is not); `tokens` only from a field that is the
 * loaded runtime context. Pure.
 */
export const PROBES = {
  // llama.cpp (and builds of its server): the per-slot context it enforces.
  props: (body) => ({ recognized: isObject(body) && (isObject(body.default_generation_settings) || Number.isInteger(body.total_slots)),
    tokens: windowValue(body?.default_generation_settings?.n_ctx) }),
  // vLLM and SGLang list max_model_len with every model they serve.
  models: (body, name) => {
    const entries = entriesOf(body, 'data').filter(isObject);
    return { recognized: entries.some((row) => windowValue(row.max_model_len) !== undefined),
      tokens: windowValue(entries.find((row) => row.id === name)?.max_model_len) };
  },
  // LM Studio: the context of the loaded instance of this model (never max_context_length, the model's own limit).
  lmstudio: (body, name) => {
    const rows = entriesOf(body, 'models').filter((row) => isObject(row) && typeof row.key === 'string' && Array.isArray(row.loaded_instances));
    let tokens;
    for (const row of rows) {
      const loaded = row.loaded_instances;
      const instance = loaded.find((one) => one?.id === name) ?? (row.key === name && loaded.length === 1 ? loaded[0] : undefined);
      tokens ??= windowValue(instance?.config?.context_length);
    }
    return { recognized: rows.length > 0, tokens };
  },
  // Ollama: the context of the running model (only while it is loaded); /api/ps is Ollama's own route.
  ollama: (body, name) => ({ recognized: isObject(body) && Array.isArray(body.models),
    tokens: windowValue(entriesOf(body, 'models').find((row) => row && (row.name === name || row.model === name))?.context_length) }),
};

/**
 * Ask a model server what it is and its per-request context window: the probes above, all at once under one deadline;
 * the window is the first found in the order listed, `recognized` whether any answered as a local inference server. The
 * key is sent as a Bearer token to the model's own origin only (no redirect is followed) and appears in no log, error or
 * result. Never throws. Returns `{ tokens, recognized }` (`tokens` undefined when unknown).
 */
export async function detectContextWindow(model, { fetch: fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  const unknown = { tokens: undefined, recognized: false };
  const endpoint = modelEndpoint(text(model?.url));
  const name = text(model?.name).trim();
  if (endpoint === undefined || name === '') return unknown;
  let base;
  try { base = new URL(endpoint.base); } catch { return unknown; }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return unknown;
  const api = endpoint.base.replace(/\/+$/, '');
  const root = api.replace(/\/v1$/, '');
  const key = text(model?.key).trim();
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal,
        headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* nothing to read */ }
        return undefined;
      }
      const body = await response.text();
      return body.length > 8_000_000 ? undefined : JSON.parse(body);
    } catch { return undefined; }
  };
  // llama.cpp: the model's own props first (a router answers for a loaded model; autoload=false never loads one to answer),
  // then the server's.
  const llama = async () => {
    const forModel = PROBES.props(await get(`${root}/props?model=${encodeURIComponent(name)}&autoload=false`));
    if (forModel.tokens !== undefined) return forModel;
    const server = PROBES.props(await get(`${root}/props`));
    return { tokens: server.tokens, recognized: forModel.recognized || server.recognized };
  };
  const answers = await Promise.all([
    llama(),
    get(`${api}/models`).then((body) => PROBES.models(body, name)),
    get(`${root}/api/v1/models`).then((body) => PROBES.lmstudio(body, name)),
    get(`${root}/api/ps`).then((body) => PROBES.ollama(body, name)),
  ]);
  return { tokens: answers.find((answer) => answer.tokens !== undefined)?.tokens, recognized: answers.some((answer) => answer.recognized) };
}

/**
 * The windows of this computer's routes: what is known about each (kept in `file`), the developer setting
 * (`developerWindow`, already validated), detection, and the person's setting. `log(line)` receives one line when a
 * window is detected, cannot be read the first time in this run, or is set or cleared; it names the model id and base
 * address, never a key. Every method is safe to call at any time: a file that cannot be read or written leaves memory as
 * it is.
 */
export function createContextWindows({ file, developerWindow, fetch: fetchImpl, timeoutMs = DETECT_TIMEOUT_MS,
  retryMs = DETECT_RETRY_MS, refreshMs = DETECT_REFRESH_MS, now = Date.now, log = () => {} } = {}) {
  let rows = null;                  // routeKey -> { detected?, recognized?, set?, address, model }
  const attempts = new Map();       // routeKey -> { at, ok } (this process)
  const running = new Map();        // routeKey -> Promise of the detection in flight
  const unreadLogged = new Set();
  const load = () => {
    if (rows !== null) return rows;
    rows = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, row] of Object.entries(saved?.routes ?? {})) {
        if (!/^[0-9a-f]{12}$/.test(key) || !isObject(row)) continue;
        const detected = windowValue(row.detected), set = personWindow(row.set), recognized = row.recognized === true || detected !== undefined;
        if (detected === undefined && set === undefined && !recognized) continue;
        rows.set(key, { ...(detected !== undefined ? { detected } : {}), ...(recognized ? { recognized } : {}),
          ...(set !== undefined ? { set } : {}), address: text(row.address), model: text(row.model) });
      }
    } catch { /* none yet, or unreadable: nothing is known */ }
    return rows;
  };
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const routes = Object.fromEntries([...load()].sort(([a], [b]) => a.localeCompare(b)));
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, routes }, null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* kept in memory for this run */ }
  };
  const about = (model) => {
    const endpoint = modelEndpoint(text(model?.url));
    return { key: routeKey(model), local: endpoint !== undefined && isLocalModelServer(endpoint.base),
      address: endpoint?.base ?? '', name: text(model?.name).trim() };
  };
  /**
   * The window of `model`'s route now: `{ tokens, source, local, set?, fallback, tooSmall? }`; `fallback` is the window
   * the route has without the person's setting (what clearing it returns to); `tooSmall` when the window in use is below
   * MIN_USABLE_CONTEXT_WINDOW (only a reported or developer window can be). Synchronous: read from memory.
   */
  const info = (model) => {
    const { key, local } = about(model);
    const row = (key && load().get(key)) || {};
    const auto = resolveWindow({ local, developer: developerWindow, detected: row.detected, recognized: row.recognized === true });
    const effective = row.set !== undefined ? resolveWindow({ local, set: row.set }) : auto;
    return { ...effective, local, ...(row.set !== undefined ? { set: row.set } : {}), fallback: auto.tokens,
      ...(effective.tokens < MIN_USABLE_CONTEXT_WINDOW ? { tooSmall: true } : {}) };
  };
  const label = ({ name, address }) => `${name} at ${address}`;
  /** Ask the model's server now (a local route with a usable model only); resolves to `info(model)`, never rejects. */
  const detect = (model) => {
    const route = about(model);
    if (!route.key || !route.local || !modelReady(model ?? {})) return Promise.resolve(info(model));
    if (running.has(route.key)) return running.get(route.key);
    const run = (async () => {
      let answer;
      try { answer = await detectContextWindow(model, { fetch: fetchImpl, timeoutMs }); } catch { answer = { tokens: undefined, recognized: false }; }
      const { tokens } = answer;
      attempts.set(route.key, { at: now(), ok: tokens !== undefined });
      const known = load();
      const row = known.get(route.key) ?? {};
      // Kept only once something is known: a window, or that the server is a local inference server.
      if (tokens !== undefined || answer.recognized || row.recognized === true) {
        const next = { ...row, ...(tokens !== undefined ? { detected: tokens } : {}), recognized: true, address: route.address, model: route.name };
        const fields = (one) => JSON.stringify([one.detected, one.recognized === true, one.set, one.address, one.model]);
        if (fields(next) !== fields(row)) { known.set(route.key, next); save(); }
      }
      if (tokens !== undefined) {
        unreadLogged.delete(route.key);
        if (row.detected !== tokens) log(`rulith model: context window of ${label(route)}: ${tokens} tokens, detected from the model server`);
      } else if (!unreadLogged.has(route.key)) {
        unreadLogged.add(route.key);
        const current = info(model);
        log(`rulith model: could not read the context window of ${label(route)} from the model server; using ${current.tokens} tokens (${current.source})`);
      }
      return info(model);
    })().finally(() => running.delete(route.key));
    running.set(route.key, run);
    return run;
  };
  /** Whether a local route's window depends on detection (not set by the person or the developer setting). */
  const followsServer = (model) => {
    const route = about(model);
    if (!route.key || !route.local || running.has(route.key) || !modelReady(model ?? {})) return false;
    return !['set', 'developer'].includes(info(model).source);
  };
  return {
    info,
    detect,
    /**
     * At a turn's start, in the background: a local route that follows its server is asked when it was not asked yet in
     * this run, when the last try found no window `retryMs` ago or more, or when its detected window is `refreshMs` old.
     */
    detectSoon(model) {
      if (!followsServer(model)) return;
      const last = attempts.get(routeKey(model));
      if (last !== undefined && now() - last.at < (last.ok ? refreshMs : retryMs)) return;
      void detect(model);
    },
    /** After a request on the route was refused for exceeding its context window: asked again now, in the background. */
    detectAfterOverflow(model) {
      if (followsServer(model)) void detect(model);
    },
    /** The person's window for `model`'s route (`null` clears it); returns `info(model)`. The value is already valid. */
    set(model, tokens) {
      const route = about(model);
      if (!route.key) return info(model);
      const known = load();
      const row = known.get(route.key) ?? {};
      if (tokens === null) {
        if (row.set === undefined) return info(model);
        const { set: _cleared, ...rest } = row;
        if (rest.detected === undefined && rest.recognized !== true) known.delete(route.key); else known.set(route.key, rest);
        save();
        const current = info(model);
        log(`rulith model: context window of ${label(route)} is no longer set; using ${current.tokens} tokens (${current.source})`);
        return current;
      }
      if (row.set === tokens) return info(model);
      known.set(route.key, { ...row, set: tokens, address: route.address, model: route.name });
      save();
      log(`rulith model: context window of ${label(route)} set to ${tokens} tokens in Settings`);
      return info(model);
    },
  };
}
