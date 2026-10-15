import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { sha, refuse } from './lib.mjs';
import { generalSettings } from './general-settings.mjs';

export function publicAddress(raw) {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))
      || a === 192 && b === 88 && c === 99
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113 || a >= 224 || a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  // Normalize IPv4-mapped IPv6 too (URL serializes dotted suffixes as two hex words).
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (canonical.startsWith('::ffff:')) {
    const parts = canonical.slice(7).split(':');
    if (parts.length !== 2) return false;
    const bits = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
    return publicAddress([bits >>> 24, bits >>> 16 & 255, bits >>> 8 & 255, bits & 255].join('.'));
  }
  // Accept global unicast only; this also refuses unspecified, loopback, multicast,
  // private, link-local, IPv4-compatible and transition/NAT64 ranges.
  const [first, second = ''] = canonical.split(':');
  const subnet = parseInt(second || '0', 16);
  return /^[23][0-9a-f]{3}:/.test(canonical) && !/^2001:(?:0:|:|db8:)/.test(canonical) && !canonical.startsWith('2002:')
    && !(first === '2001' && (subnet === 2 || subnet >= 0x10 && subnet <= 0x2f))
    && !(first === '3fff' && subnet <= 0xfff);
}

function urlOf(input) {
  if (typeof input !== 'string' || input.length > 1024) refuse('web URL refused');
  let url; try { url = new URL(input); } catch { refuse('web URL refused'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) refuse('web URL refused');
  url.hash = '';
  return url;
}

// Tests can inject this dependency directly. No model input, settings or environment flag
// can replace the production guard. The checked DNS address is pinned to the connection.
export async function guardedAddresses(url, { lookup = dns.lookup, signal } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!records.length || records.some(record => !publicAddress(record.address))) refuse('web address refused');
  return records;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('web timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function requestBytes(url, { signal, maxBytes, method = 'GET', headers = {}, body, addresses }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method, headers: { accept: 'text/html, text/plain, application/json', 'accept-encoding': 'identity', ...headers },
      agent: false, signal,
      ...(addresses ? { lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) } : {}),
    }, res => {
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(new Error('web size exceeded')); return; }
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) { res.destroy(); reject(new Error('web size exceeded')); }
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

export const WEB_TEXT_LIMIT = 16 * 1024;
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? all;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function scanHtml(html) {
  // The response is already bounded by webMaxBytes. Scan through head/CSS/script
  // material until extracted text exceeds the receipt's preparation budget.
  // Every branch consumes its region once, even for hostile '<' runs.
  const parts = []; let length = 0, last = '';
  const append = raw => {
    let text = decodeEntities(raw).replace(/[ \t]+/g, ' ');
    if (!length) text = text.trimStart();
    else if (last === ' ' && text.startsWith(' ')) text = text.slice(1);
    text = text.slice(0, WEB_TEXT_LIMIT + 1 - length);
    if (text) { parts.push(text); length += text.length; last = text.at(-1); }
  };
  let hidden;
  for (let i = 0; i < html.length && length <= WEB_TEXT_LIMIT;) {
    if (html[i] !== '<') {
      const end = html.indexOf('<', i), next = end < 0 ? html.length : end;
      if (!hidden) append(html.slice(i, next));
      i = next; continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4); i = end < 0 ? html.length : end + 3; continue;
    }
    const end = html.indexOf('>', i + 1);
    if (end < 0) { if (!hidden) append(html.slice(i)); break; }
    const tag = /^\s*(\/?)([a-z][a-z0-9]*)\b/i.exec(html.slice(i + 1, end));
    if (tag) {
      const closing = tag[1], name = tag[2].toLowerCase();
      if (hidden) { if (closing && name === hidden) hidden = undefined; }
      else if (!closing && ['script', 'style', 'noscript'].includes(name)) hidden = name;
      else if (name === 'br' || closing && /^(?:p|div|h[1-6]|li|tr)$/.test(name)) append('\n');
    }
    i = end + 1;
  }
  let text = parts.join('').slice(0, WEB_TEXT_LIMIT).replace(/\n\s*\n/g, '\n\n').trim();
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { text, truncated: length > WEB_TEXT_LIMIT };
}
export function readableHtml(input) { return scanHtml(input).text; }

// Account for the result text and the facts together, including JSON escaping.
export function boundedReceipt(row, text, predicate) {
  const result = { rows: [row], text };
  const facts = [{ predicate, args: row }];
  const bytes = () => Buffer.byteLength(JSON.stringify({ result: JSON.stringify(result), facts }));
  while (bytes() > 7400 && result.text.length) {
    result.text = result.text.slice(0, Math.floor(result.text.length * 0.8)); result.truncated = true;
    if (/[\uD800-\uDBFF]$/.test(result.text)) result.text = result.text.slice(0, -1);
  }
  if (bytes() > 7400) refuse('web metadata too large');
  return result;
}

export async function fetchPage(ctx, args, deps = {}) {
  const opts = generalSettings(ctx.home), initial = urlOf(args.url);
  const signal = AbortSignal.timeout(opts.webTimeoutSeconds * 1000);
  let url = initial;
  try {
    for (let hop = 0; ; hop++) {
      const addresses = await (deps.guard ?? guardedAddresses)(url, { signal, lookup: deps.lookup });
      const response = await requestBytes(url, { addresses, signal, maxBytes: opts.webMaxBytes });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        if (hop >= 5) refuse('web redirects exceeded');
        url = urlOf(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') refuse('web encoding refused');
      const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('text/') && type !== 'application/json' && type !== 'application/xhtml+xml') refuse('web media type refused');
      const raw = response.bytes.toString('utf8');
      const extracted = type.includes('html') ? scanHtml(raw) : { text: raw.slice(0, WEB_TEXT_LIMIT), truncated: raw.length > WEB_TEXT_LIMIT };
      const out = boundedReceipt({ url: initial.href, final_url: url.href, status: response.status,
        digest: sha(response.bytes), fetched_at: new Date().toISOString() }, extracted.text, 'web.page');
      if (extracted.truncated) out.truncated = true;
      return out;
    }
  } catch (error) {
    if (signal.aborted) refuse('web timeout');
    if (['web URL refused', 'web address refused', 'web size exceeded', 'web redirects exceeded', 'web encoding refused', 'web media type refused', 'web metadata too large'].includes(error.message)) throw error;
    refuse('web request failed');
  }
}

export async function deepseekSearch({ query, key, signal, maxBytes }, request = requestBytes) {
  const response = await request(new URL('https://api.deepseek.com/anthropic/v1/messages'), {
    signal, maxBytes, method: 'POST', headers: { 'x-api-key': key, authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }),
  });
  if (response.status < 200 || response.status >= 300) refuse('web search failed');
  const blocks = JSON.parse(response.bytes).content;
  if (!Array.isArray(blocks) || !blocks.some(block => block.type === 'web_search_tool_result' && Array.isArray(block.content))) refuse('web search failed');
  const snippets = new Map(), results = new Map();
  for (const block of blocks) if (block.type === 'text') for (const cite of block.citations ?? [])
    if (typeof cite.url === 'string' && typeof cite.cited_text === 'string' && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
  for (const block of blocks) if (block.type === 'web_search_tool_result') for (const item of block.content ?? [])
    if (item.type === 'web_search_result' && typeof item.url === 'string' && !results.has(item.url)) results.set(item.url, {
      url: item.url, title: item.title ?? '', snippet: snippets.get(item.url) ?? '',
    });
  return JSON.stringify([...results.values()]);
}

export async function searchWeb(ctx, args, env, { provider = deepseekSearch } = {}) {
  const opts = generalSettings(ctx.home);
  const config = opts.webSearch;
  const key = config && env[config.keyEnv];
  if (typeof key !== 'string' || !key.trim()) refuse('web search key unavailable');
  if (typeof args.query !== 'string' || !args.query || Buffer.byteLength(args.query) > 1024) refuse('query refused');
  const signal = AbortSignal.timeout(opts.webTimeoutSeconds * 1000);
  try {
    const answer = await withAbort(provider({ query: args.query, key, signal, maxBytes: opts.webMaxBytes }), signal);
    if (typeof answer !== 'string' || Buffer.byteLength(answer) > opts.webMaxBytes) refuse('web search failed');
    // A provider may echo headers in its body or error. Only scrubbed results are digested/reported.
    const text = answer.replaceAll(key, '[redacted]');
    return boundedReceipt({ query: args.query.replaceAll(key, '[redacted]'), provider: config.provider,
      digest: sha(text), fetched_at: new Date().toISOString() }, text, 'web.search');
  } catch { refuse(signal.aborted ? 'web timeout' : 'web search failed'); }
}
