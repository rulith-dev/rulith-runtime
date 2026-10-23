import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WEB_TOOLS, FETCH_REFUSALS, offeredWebTools, webSearchKey, fetchRefusal, blockedAddress, installWebFetchGuard }
  from '../../harness/web-tools.mjs';
import { TOOLS } from '../../harness/rulith-mcp.mjs';
import { restrictAgent } from '../../harness/rulith-gate.mjs';
import { installGate } from '../../harness/web/rulith-web-gate.mjs';
import { DELEGATION_TOOLS } from '../../harness/subagents.mjs';

// D-1015c：dsh 的 web_search 与 web_fetch 原生提供，其余 dsh 工具不提供；web_fetch 不得访问本机、局域网与链路本地地址
// （SSRF）；web_search 只用 DeepSeek 自己的密钥，没有时不注册、启动照常。先用替身检查规则，再在已安装 dsh 的真实工具注册表
// 与配置合成上证明（DSH_MODULES_DIR）。

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const PUBLIC = '93.184.215.14';
// A resolver that must never be asked: IP literals and localhost names are decided without a lookup.
const noLookup = async (host) => { throw new Error(`unexpected lookup of ${host}`); };
const resolvesTo = (...addresses) => { const asked = []; const lookup = async (host) => { asked.push(host); return addresses.map((address) => ({ address })); }; lookup.asked = asked; return lookup; };

test('web_search gets only the key of a model route that is DeepSeek\'s own API over https', () => {
  assert.equal(webSearchKey({ url: 'https://api.deepseek.com', key: 'k' }), 'k');
  assert.equal(webSearchKey({ url: 'https://api.deepseek.com/v1/', key: 'k' }), 'k');
  for (const route of [{ url: 'http://api.deepseek.com', key: 'k' }, { url: 'http://127.0.0.1:8080/v1', key: 'k' },
    { url: 'https://api.openai.com/v1', key: 'k' }, { url: 'https://api.deepseek.com.example.org/v1', key: 'k' },
    { url: 'https://api.deepseek.com', key: '' }, { url: 'not a url', key: 'k' }, {}, null, undefined])
    assert.equal(webSearchKey(route), '', JSON.stringify(route));
});

test('the allow-list adds only the web tools dsh registered', () => {
  assert.deepEqual([...WEB_TOOLS], ['web_search', 'web_fetch']);
  const registry = (...names) => ({ get: (name) => names.includes(name) ? { name } : undefined });
  assert.deepEqual(offeredWebTools(registry('web_search', 'web_fetch', 'read', 'write', 'edit', 'bash', 'glob', 'grep')), ['web_search', 'web_fetch']);
  assert.deepEqual(offeredWebTools(registry('web_fetch')), ['web_fetch'], 'no search key: web_search is not offered');
  assert.deepEqual(offeredWebTools(registry()), []);
  // Headless gate.
  for (const [names, want] of [[['web_search', 'web_fetch', 'write', 'edit'], [...TOOLS, 'web_search', 'web_fetch']], [['web_fetch'], [...TOOLS, 'web_fetch']]]) {
    const filters = [];
    restrictAgent({ ctx: { tools: { ...registry(...names), restrict: (filter) => filters.push(filter) } } });
    assert.deepEqual(filters, [{ allow: want }]);
  }
});

test('web main and children see exactly their names; write, edit and shell tools never', () => {
  const handlers = new Map();
  installGate({ on: (event, fn) => handlers.set(event, fn), systemPrompt: { section() {} } }, 'approved persona');
  const agent = (header, registered) => {
    const filters = [];
    return { filters, options: {}, session: { id: 'a', header },
      ctx: { tools: { get: (name) => registered.includes(name) ? {} : undefined, restrict: (filter) => filters.push(filter) },
        systemPrompt: { section() {} }, effect() {} } };
  };
  const everything = ['web_search', 'web_fetch', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'job_output'];
  const main = agent({}, everything); handlers.get('agent/created')({ agent: main });
  assert.deepEqual(main.filters[0].allow, [...TOOLS, ...DELEGATION_TOOLS, 'web_search', 'web_fetch']);
  const child = agent({ parentSession: 'main', delegationDepth: 1 }, everything); handlers.get('agent/created')({ agent: child });
  assert.deepEqual(child.filters[0].allow, [...TOOLS, 'web_search', 'web_fetch']);
  const keyless = agent({ parentSession: 'main', delegationDepth: 1 }, ['web_fetch', 'write']); handlers.get('agent/created')({ agent: keyless });
  assert.deepEqual(keyless.filters[0].allow, [...TOOLS, 'web_fetch']);
  for (const filter of [main, child, keyless].map((a) => a.filters[0]))
    for (const name of ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh']) assert.ok(!filter.allow.includes(name), name);
  assert.equal(typeof handlers.get('tools/execute'), 'function', 'the web gate installs the web_fetch guard');
});

test('web_fetch refuses non-http schemes, localhost names and local, private and link-local addresses in every spelling', async () => {
  const refused = {
    [FETCH_REFUSALS.url]: ['file:///C:/Users/x/.ssh/id_rsa', 'ftp://example.com/', 'data:text/plain,hi', 'javascript:alert(1)',
      'gopher://example.com/', 'ws://example.com/', 'not a url', '', 'http://', 42, null, undefined, ['http://example.com/']],
    [FETCH_REFUSALS.local]: ['http://localhost:7790/manager/state', 'http://LOCALHOST./', 'http://ui.localhost:3080/',
      'http://127.0.0.1:8080/v1/models', 'https://127.255.255.254/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/',
      'http://017700000001/', 'http://%31%32%37.0.0.1/', 'http://0.0.0.0:3080/', 'http://0/', 'http://[::1]:7790/', 'http://[::]/',
      'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::ffff:192.168.1.119]/',
      'http://10.0.0.1/', 'http://10.255.255.255/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.119/',
      'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://100.127.255.255/',
      'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[febf::1]/'],
  };
  for (const [reason, urls] of Object.entries(refused))
    for (const url of urls) assert.equal(await fetchRefusal(url, noLookup), reason, String(url));
  for (const url of [`http://${PUBLIC}/`, 'https://8.8.8.8/', 'http://172.15.255.255/', 'http://172.32.0.1/', 'http://11.0.0.1/',
    'http://192.169.0.1/', 'http://100.63.255.255/', 'http://100.128.0.1/', 'http://169.253.0.1/', 'http://[2606:4700::1111]/',
    'http://[::ffff:8.8.8.8]/', 'http://[fe00::1]/'])
    assert.equal(await fetchRefusal(url, noLookup), undefined, url);
  assert.equal(blockedAddress('not an address'), true, 'a resolver answer that is not an address counts as blocked');
});

test('web_fetch resolves host names first: any local or private answer, no answer, or a failed lookup refuses', async () => {
  const lookup = resolvesTo(PUBLIC);
  assert.equal(await fetchRefusal('https://example.com/a?b=c', lookup), undefined);
  assert.deepEqual(lookup.asked, ['example.com']);
  assert.equal(await fetchRefusal('https://example.com./', resolvesTo(PUBLIC)), undefined, 'trailing dot');
  for (const answer of [['127.0.0.1'], [PUBLIC, '192.168.1.119'], ['::1'], ['::ffff:10.0.0.1'], ['169.254.169.254'], ['not-an-ip']])
    assert.equal(await fetchRefusal('http://rebind.example/', resolvesTo(...answer)), FETCH_REFUSALS.local, answer.join());
  assert.equal(await fetchRefusal('http://nowhere.example/', resolvesTo()), FETCH_REFUSALS.unresolved);
  // A lookup that hangs is cut off by the call's signal (cancellation, or dsh's tool timeout around this listener).
  const abort = new AbortController(); setTimeout(() => abort.abort(new Error('tool timeout')), 20);
  assert.equal(await fetchRefusal('http://hang.example/', () => new Promise(() => {}), abort.signal), FETCH_REFUSALS.unresolved);
  assert.equal(await fetchRefusal('http://nowhere.example/', async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }),
    FETCH_REFUSALS.unresolved);
});

test('a refused web_fetch never reaches dsh\'s fetch; other tools and allowed URLs pass through unchanged', async () => {
  let handler;
  installWebFetchGuard({ on: (event, fn) => { assert.equal(event, 'tools/execute'); handler = fn; } }, resolvesTo(PUBLIC));
  let dispatched = 0; const passed = { isError: false, value: 'fetched' };
  const next = async () => { dispatched++; return passed; };
  const refused = await handler({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1:7790/manager/state' } }, next);
  assert.equal(dispatched, 0);
  assert.deepEqual(refused, { isError: true, content: [{ type: 'text', text: `Error: ${FETCH_REFUSALS.local}` }], error: { message: FETCH_REFUSALS.local } });
  assert.equal(await handler({ name: 'web_fetch', arguments: { url: 'https://example.com/' } }, next), passed);
  assert.equal(dispatched, 1);
  // Other tools are not looked at (an http URL argument of another tool is not resolved).
  const strict = []; let other;
  installWebFetchGuard({ on: (_event, fn) => { other = fn; } }, async (host) => { strict.push(host); return []; });
  for (const name of ['web_search', 'Execute', 'Set', 'Get']) assert.equal(await other({ name, arguments: { url: 'http://127.0.0.1/' } }, next), passed);
  assert.deepEqual(strict, []);
});

test('model-visible text names the web tools, the guard\'s refusals and dsh\'s descriptions', () => {
  const doc = read('harness/model-visible.md');
  for (const reason of Object.values(FETCH_REFUSALS)) assert.ok(doc.includes(reason), reason);
  assert.ok(doc.includes("Your tools are Rulith's three, delegation tools, and the read-only tools web_search and web_fetch."));
  assert.ok(doc.includes('"name": "web_search"') && doc.includes('"name": "web_fetch"'));
});

// The overlays, as dsh composes them: base (+ headless or web-app's bundle patches) + Deep Rulith's overlay, read in
// dsh's entry-list YAML dialect and composed by dsh-app-boot's own composeEntries.
const dshRoot = () => path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
async function composed(profile) {
  const root = dshRoot();
  const boot = await import(pathToFileURL(path.join(root, 'dsh-app-boot', 'lib', 'index.js')));
  const yaml = createRequire(path.join(root, 'dsh-app-boot', 'lib', 'index.js'))('js-yaml');
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (data) => typeof data === 'string', construct: (data) => ({ __jsExpr: data }) });
  const load = (file) => yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA.extend(js) });
  const base = load(path.join(root, 'dsh-base', 'cordis.patch.yml'));
  const layers = profile === 'web'
    ? [base, ...JSON.parse(fs.readFileSync(path.join(root, 'dsh-web-app', 'package.json'), 'utf8')).dsh.bundle.patch.map((file) => load(path.join(root, 'dsh-web-app', file))),
      load(new URL('../../harness/web/rulith-web.cordis.yml', import.meta.url))]
    : [base, load(path.join(root, 'dsh-headless', 'cordis.patch.yml')), load(new URL('../../harness/rulith.cordis.yml', import.meta.url))];
  const enabled = [];
  const walk = (entries) => { for (const entry of entries) { if (entry.disabled) continue; enabled.push(entry); if (entry.group && Array.isArray(entry.config)) walk(entry.config); } };
  walk(boot.composeEntries(layers));
  return enabled;
}
const withSearchKey = async (value, body) => {
  const saved = process.env.RULITH_DSH_WEB_SEARCH_KEY;
  if (value === undefined) delete process.env.RULITH_DSH_WEB_SEARCH_KEY; else process.env.RULITH_DSH_WEB_SEARCH_KEY = value;
  try { return await body(); } finally { if (saved === undefined) delete process.env.RULITH_DSH_WEB_SEARCH_KEY; else process.env.RULITH_DSH_WEB_SEARCH_KEY = saved; }
};

test('installed dsh: the overlays enable exactly the web tool plugins, and web_search only with a key', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const { interpolate } = await import(pathToFileURL(path.join(dshRoot(), 'cordis-plugin-loader', 'lib', 'index.js')));
  // Tool, web and filesystem plugins that are on, by package (the timeout policy, subagent model selection and cordis
  // inspection host rows register no model tool; the job registry, a host service, is matched by neither pattern).
  const tooling = (entries) => entries.map((entry) => entry.name).filter((name) => /^@deepseek-ai\/dsh-(tool-|web|fs|skill|goal|todo|workflow|ptc|mcp)/.test(name)).sort();
  const headless = await composed('headless');
  assert.deepEqual(tooling(headless), ['@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-tool-call-timeout-policy', '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web-fetch-http', '@deepseek-ai/dsh-web-search-deepseek']);
  const web = await composed('web');
  assert.deepEqual(tooling(web), ['@deepseek-ai/dsh-fs-sandbox', '@deepseek-ai/dsh-tool-call-timeout-policy', '@deepseek-ai/dsh-tool-cordis/host',
    '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent/model-selection-settings', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-web-app/startup', '@deepseek-ai/dsh-web-fetch-http', '@deepseek-ai/dsh-web-search-deepseek']);
  for (const entries of [headless, web]) {
    const row = (id) => entries.find((entry) => entry.id === id);
    for (const id of ['tool-fs', 'tool-fs-search', 'fs-observation-policy', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'llm-deepseek-account', 'deepseek-account'])
      assert.equal(row(id), undefined, `${id} stays off`);
    assert.deepEqual(row('web').config, { searchProvider: 'deepseek-official', fetchProvider: 'http' });
    assert.deepEqual(row('web-search-deepseek').config, { apiKeyEnv: 'RULITH_DSH_WEB_SEARCH_KEY', baseURL: 'https://api.deepseek.com/anthropic/v1' },
      'no key in any file, only the variable name; the key goes only to DeepSeek');
    for (const [key, search] of [[undefined, false], ['', false], ['test-search-key', true]]) {
      const config = await withSearchKey(key, () => interpolate({}, row('tool-web').config));
      assert.deepEqual(config, { search, fetch: true, searchTimeoutMs: 60000 });
      if (entries === web) for (const id of ['tool-subagent', 'tool-subagent-fork']) {
        const filter = await withSearchKey(key, () => interpolate({}, row(id).config).toolFilter);
        assert.deepEqual(filter, { allow: [...TOOLS, ...(search ? ['web_search'] : []), 'web_fetch'] }, `${id} children`);
      }
    }
  }
});

// The real tool registry: dsh-tools, dsh-web and dsh-tool-web, with a recording fetch provider in place of the network.
async function kernel({ search }) {
  const root = dshRoot();
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib', 'index.js')));
  const names = ['cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop'];
  const [cordis, toolWeb, dshWeb, llm, ...plugins] = await Promise.all(['cordis', 'dsh-tool-web', 'dsh-web', ...names].map(load));
  const ctx = new cordis.Context();
  const config = { 'dsh-system-prompt': { includeHarnessIdentity: false, includeRuntimeContext: false }, 'dsh-agent-loop': { agents: [] } };
  await ctx.plugin(llm.default, {});
  for (const [index, name] of names.slice(1).entries()) await ctx.plugin(plugins[index].default, config[name] ?? {});
  await ctx.plugin(dshWeb.default, { searchProvider: 'recording', fetchProvider: 'recording' });
  const fetched = [];
  ctx.web.registerFetchProvider({ id: 'recording', available: () => true,
    fetch: async (request) => { fetched.push(request.url); return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'page' }, truncated: false }; } });
  ctx.web.registerSearchProvider({ id: 'recording', available: () => true, search: async () => ({ sources: [], truncated: false }) });
  await ctx.plugin(toolWeb, { search, fetch: true, searchMaxResults: 8, searchMaxQueries: 4, fetchTimeoutMs: 30000, searchTimeoutMs: 60000, fetchMaxOutputChars: 200000 });
  // dsh's other local tools stand registered beside them, as if their plugins were on; the allow-list must hide them.
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash']) ctx.tools.register({ name, description: name, parameters: { type: 'object' },
    output: { schema: {}, render: () => [] }, async execute() { throw new Error(`${name} must not run`); } });
  for (const name of TOOLS) ctx.tools.register({ name, description: name, parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, async execute() { return {}; } });
  return { ctx, fetched, toolWeb };
}

test('installed dsh: the gate offers exactly Rulith\'s three and the registered web tools; a refused web_fetch never fetches', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  for (const search of [true, false]) {
    const { ctx, fetched } = await kernel({ search });
    try {
      installWebFetchGuard(ctx, resolvesTo(PUBLIC));
      ctx.on('agent/created', ({ agent }) => { restrictAgent(agent); });
      const handle = await ctx.agents.create({ sessionId: `web-tools-${search}`, agentOptions: { provider: 'none', model: 'm' } });
      try {
        const agent = handle.agent;
        const visible = ctx.tools.schemas(agent).map((schema) => schema.name).sort();
        assert.deepEqual(visible, [...TOOLS, ...(search ? ['web_search'] : []), 'web_fetch'].sort());
        const doc = read('harness/model-visible.md');
        if (search) assert.ok(doc.includes(JSON.stringify(ctx.tools.schemas(agent).filter((s) => WEB_TOOLS.includes(s.name))
          .sort((a, b) => WEB_TOOLS.indexOf(a.name) - WEB_TOOLS.indexOf(b.name)), null, 2)), 'model-visible.md lists dsh\'s web tool schemas exactly');
        const call = (name, args) => ctx.tools.execute({ name, arguments: args, callId: `c-${name}-${Math.random()}`, agent, signal: new AbortController().signal });
        for (const url of ['http://127.0.0.1:7790/manager/state', 'http://localhost:8080/v1/models', 'http://[::ffff:192.168.1.119]/', 'file:///etc/passwd']) {
          const result = await call('web_fetch', { url });
          assert.equal(result.isError, true, url);
          assert.match(result.content[0].text, /^Error: web_fetch refused: /, url);
        }
        assert.deepEqual(fetched, [], 'nothing was fetched');
        const ok = await call('web_fetch', { url: 'https://example.com/page' });
        assert.equal(ok.isError, false);
        assert.match(ok.content[0].text, /^Fetched https:\/\/example\.com\/page \(HTTP 200\)/);
        assert.deepEqual(fetched, ['https://example.com/page']);
        for (const name of ['write', 'bash', 'read']) assert.equal((await call(name, {})).isError, true, `${name} is not callable`);
      } finally { await handle.dispose(); }
    } finally { await ctx.dispose?.(); }
  }
});

// dsh's own fetch, on loopback only: a host name pinned to a local test server stands in for a public site. The guard
// checks the URL the model gave; this pins the assumption that dsh then follows only same-origin redirects (same scheme,
// host and port, so the guard's answer still holds) and refuses a redirect to any other origin, which the model would have
// to fetch anew through the guard.
test('installed dsh: web_fetch follows same-origin redirects only; a redirect to another origin is refused unfetched', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const http = await import('node:http');
  const { HttpFetchProvider } = await import(pathToFileURL(path.join(dshRoot(), 'dsh-web-fetch-http', 'lib', 'index.js')));
  const served = [];
  const server = http.createServer((req, res) => {
    served.push(req.url);
    const port = server.address().port;
    const redirect = { '/same': '/final', '/cross-host': `http://127.0.0.1:${port}/final`, '/cross-port': `http://site.test:${port + 1}/final`,
      '/cross-scheme': `https://site.test:${port}/final`, '/local-service': 'http://localhost:7790/manager/state' }[req.url];
    if (redirect) { res.writeHead(302, { location: redirect }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('final page');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const provider = new HttpFetchProvider({ maxResponseBytes: 1e6, maxBodyChars: 1e5, timeoutMs: 5000, maxRedirects: 5, userAgent: 'test' },
      async (host) => { if (host !== 'site.test') throw new Error(`unexpected resolution of ${host}`); return [{ address: '127.0.0.1', family: 4 }]; });
    const same = await provider.fetch({ url: `http://site.test:${port}/same` }, new AbortController().signal);
    assert.equal(same.body.content, 'final page');
    assert.deepEqual(served, ['/same', '/final']);
    for (const route of ['/cross-host', '/cross-port', '/cross-scheme', '/local-service']) {
      served.length = 0;
      await assert.rejects(provider.fetch({ url: `http://site.test:${port}${route}` }, new AbortController().signal), (error) => error.code === 'WEB_REDIRECT_BLOCKED', route);
      assert.deepEqual(served, [route], `${route}: the redirect target was not fetched`);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('without a search key the addendum offers only web_fetch, and nothing else changes', async () => {
  const { forDeployment } = await import('../../harness/web-tools.mjs');
  const { ADDENDUM } = await import('../../harness/rulith-gate.mjs');
  const { ADDENDUM: WEB } = await import('../../harness/web/rulith-web-gate.mjs');
  assert.equal(forDeployment(ADDENDUM, { RULITH_DSH_WEB_SEARCH_KEY: 'k' }), ADDENDUM);
  const plain = forDeployment(ADDENDUM, {});
  assert.match(plain, /^Your tools are Rulith's three and the read-only tool web_fetch\. Web results leave nothing on the Board/);
  assert.equal(plain.slice(plain.indexOf(' Web results')), ADDENDUM.slice(ADDENDUM.indexOf(' Web results')));
  assert.match(forDeployment(WEB, {}), /^Your tools are Rulith's three, delegation tools, and the read-only tool web_fetch\./);
});
