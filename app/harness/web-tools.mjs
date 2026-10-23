// D-1015c（所有者 2026-10-15）：只读、无副作用的网络工具可以不经 Rulith，原生留在 Deep Rulith：dsh 的 web_search 与
// web_fetch。凡有后果的（写、改、命令、作业）仍是带收据的 Rulith Action。dsh 的其他工具（read、write、edit、glob、grep、
// shell、作业……）一个都不提供；文件读取的原生工具等所有者另行评估。
import dns from 'node:dns/promises';
import net from 'node:net';

/** dsh's read-only web tools offered beside Rulith's three (D-1015c). No other dsh tool is offered. */
export const WEB_TOOLS = Object.freeze(['web_search', 'web_fetch']);

/**
 * The web tools this deployment registered. web_search exists only when a search key reached dsh (see webSearchKey);
 * dsh refuses a restriction that names an unregistered tool, so the allow-list names only what is there.
 * @param tools - dsh's tool registry (`ctx.tools`); `get(name)` without a scope is the global view.
 */
export const offeredWebTools = (tools) => WEB_TOOLS.filter((name) => tools.get(name) !== undefined);

// web_search 的密钥：只用 Rulith 模型设置里 DeepSeek 自己的密钥。模型路线不是 DeepSeek API（本机 llama.cpp、别家接口）时
// 不传任何密钥，web_search 就不注册：别家的密钥不能发给 DeepSeek，假密钥也只会让每次搜索失败。
const DEEPSEEK_API_HOST = 'api.deepseek.com';

/**
 * The key web_search may use: the model route's key when that route is DeepSeek's own API over https, else ''.
 * @param route - `{ url, key }` of the model set in Rulith (the launcher's `rulith-model`, or the headless role's env).
 * @returns the key to pass to dsh as RULITH_DSH_WEB_SEARCH_KEY, or '' (web_search is then not offered).
 */
// Without a search key web_search is not registered (overlay), so the addendum must not offer it either.
export const searchOffered = (env = process.env) => Boolean(env.RULITH_DSH_WEB_SEARCH_KEY);
export const withoutSearch = (text) => text.replace('the read-only tools web_search and web_fetch', 'the read-only tool web_fetch');
export const forDeployment = (text, env = process.env) => (searchOffered(env) ? text : withoutSearch(text));

export function webSearchKey(route) {
  if (!route?.key || !route.url) return '';
  try {
    const url = new URL(route.url);
    return url.protocol === 'https:' && url.hostname === DEEPSEEK_API_HOST ? route.key : '';
  } catch { return ''; }
}

// web_fetch 的 SSRF 防线。本机跑着本地服务（模型引擎 127.0.0.1:8080、管理器 7790、启动器 3080–3094），局域网里还有别的
// 机器；模型（或它读到的网页）不能借 web_fetch 访问它们。dsh 自己的 fetch 已在直连时把每个解析出的地址限为公网单播并钉住
// 连接地址，只跟随同源重定向（同一协议、主机与端口；跨源重定向不跟随，模型要重新调用 web_fetch，又经过这里）。但走 HTTP
// 代理时 dsh 只检查 IP 字面量，主机名交给代理解析。所以这里在 dsh 之前再查一遍：IP 字面量直接查网段，主机名在本机解析，
// 任一地址落在下列网段即拒绝；解析不出也拒绝（不放过）。
// 剩余风险（如实记下）：经代理时最终由代理解析主机名，代理与本机解析结果不同（DNS 重绑定、代理的 fake-ip 模式）时，这里
// 看不到代理连向的地址。
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // “本网络”；0.0.0.0 在多数系统上连到本机
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], // 私有网段
  ['100.64.0.0', 10], // 运营商级 NAT 共享地址，也是 Tailscale 等虚拟局域网所用
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地，含云主机元数据 169.254.169.254
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) BLOCKED.addSubnet(address, prefix, 'ipv6');
// net.BlockList 把 IPv4 映射的 IPv6 地址（::ffff:127.0.0.1）按 IPv4 规则检查。

/** The fixed refusals the model can see from web_fetch (also listed in model-visible.md). */
export const FETCH_REFUSALS = Object.freeze({
  url: 'web_fetch refused: only http and https URLs are fetched.',
  local: "web_fetch refused: the URL's host is or resolves to a loopback, private or link-local address.",
  unresolved: "web_fetch refused: the URL's host did not resolve.",
});

/** Whether an address is in a blocked range; anything that is not an IP address counts as blocked. */
export function blockedAddress(address) {
  const family = net.isIP(String(address));
  return family === 0 || BLOCKED.check(String(address), family === 4 ? 'ipv4' : 'ipv6');
}

const systemLookup = (host) => dns.lookup(host, { all: true, order: 'verbatim' });
// 解析服从这次调用的信号（取消；dsh 的 timeout-policy 先于本插件注册时也带它给 web_fetch 的 30 s 期限）：解析卡住不能拖住回合。
const abortable = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const stop = () => reject(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
});

/**
 * Why web_fetch must not fetch this URL, or undefined when it may. The URL is parsed exactly as dsh's fetch parses it
 * (WHATWG URL), so `http://2130706433/`, `http://0x7f.1/` and `http://[::ffff:7f00:1]/` are all 127.0.0.1 here too.
 * @param input - the model's `url` argument, as received.
 * @param lookup - resolves a host name to `[{ address }]` (the system resolver; tests pass their own).
 * @param signal - the call's signal; a lookup cut off by it counts as unresolved.
 * @returns one of FETCH_REFUSALS, or undefined.
 */
export async function fetchRefusal(input, lookup = systemLookup, signal = undefined) {
  if (typeof input !== 'string') return FETCH_REFUSALS.url;
  let url;
  try { url = new URL(input); } catch { return FETCH_REFUSALS.url; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return FETCH_REFUSALS.url;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return FETCH_REFUSALS.url;
  if (host === 'localhost' || host.endsWith('.localhost')) return FETCH_REFUSALS.local;
  if (net.isIP(host)) return blockedAddress(host) ? FETCH_REFUSALS.local : undefined;
  let addresses;
  try { addresses = await abortable(Promise.resolve().then(() => lookup(host)), signal); } catch { return FETCH_REFUSALS.unresolved; }
  if (!Array.isArray(addresses) || addresses.length === 0) return FETCH_REFUSALS.unresolved;
  return addresses.some((entry) => blockedAddress(entry?.address)) ? FETCH_REFUSALS.local : undefined;
}

/**
 * Install the check on dsh's `tools/execute` waterfall, the around-dispatch seam every tool body is reached through
 * (dsh-fs-local names it as the place for containment). A refused call returns an error result without calling next(),
 * so dsh's fetch never runs and nothing is sent. Every hand's calls (main and children) pass this one global listener.
 * @param ctx - the gate's plugin context (injects `tools`).
 * @param lookup - optional resolver for tests.
 */
export function installWebFetchGuard(ctx, lookup) {
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_fetch') return next();
    const reason = await fetchRefusal(exec.arguments?.url, lookup ?? systemLookup, exec.signal);
    if (reason === undefined) return next();
    // dsh's own shape for a failed call (toolErrorResult): the model reads `Error: <reason>`.
    return { isError: true, content: [{ type: 'text', text: `Error: ${reason}` }], error: { message: reason } };
  });
}
