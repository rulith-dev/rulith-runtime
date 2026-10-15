import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { perform } from '../kits/general/adapter.mjs';
import { context, sha, save, tree } from '../kits/general/lib.mjs';
import { fetchPage, searchWeb, guardedAddresses, publicAddress, deepseekSearch } from '../kits/general/web.mjs';
import { parseKitInstall, installGeneral } from '../kits/general/installer.mjs';
import { parseLocalCli } from '../local/rulith-local.mjs';
import { adapterEnv, workerToolsOf, resultFactsFromRows, prepareActionReport } from '../worker/rulith-worker.mjs';
import { runArtifactOutput } from '../worker/run-artifacts.mjs';
import { openMaterialStore, materialIdentity } from '../worker/material-store.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json', import.meta.url)));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'general-'));
  const root = path.join(dir, 'root'), home = path.join(dir, 'pins');
  fs.mkdirSync(root); fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'specs/test.json'), JSON.stringify({ command: ['node', 'test.mjs'] }));
  const env = { RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, ENG_KIT_HOME: home };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, home, env, ctx: context(env),
    write: (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); },
    read: name => fs.readFileSync(path.join(root, name), 'utf8'),
    settings: value => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(value)),
    call: (tool, args) => perform(tool, args, env),
  };
}

test('glob sorts, bounds results, handles recursive patterns, and excludes every .git and treeExclude', async t => {
  const f = fixture(t);
  f.settings({ treeExclude: ['out', '**/node_modules'] });
  for (const name of ['z.js', 'a.js', 'src/b.js', 'src/a.txt', '.git/secret.js', 'src/.git/nested.js', 'out/result.js', 'src/node_modules/dep.js']) f.write(name, 'x');
  assert.deepEqual((await f.call('glob', { pattern: '**/*.js' })).rows.map(r => r.path), ['a.js', 'src/b.js', 'z.js']);
  assert.deepEqual((await f.call('glob', { pattern: 'src/[ab].?s' })).rows, [{ path: 'src/b.js' }]);
  const capped = await f.call('glob', { pattern: '**/*.js', limit: 2 });
  assert.deepEqual(capped.rows, [{ path: 'a.js' }, { path: 'src/b.js' }]); assert.equal(capped.truncated, true);
  for (const pattern of ['../*', '/tmp/*', 'C:/keys/*', '**/../../*']) await assert.rejects(f.call('glob', { pattern }), /glob refused/);
  await assert.rejects(f.call('glob', { pattern: '*', limit: 129 }), /limit refused/);
});

test('multi-file Codex patch returns file states and genuine tree steps; read@2 supplies evidence', async t => {
  const f = fixture(t); f.write('a.txt', 'one\ntwo\nthree\n'); f.write('b.txt', 'b\n');
  await f.call('tree_state', {});
  const out = await f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+second\n three\n*** Add File: c.txt\n+new\n*** Update File: b.txt\n@@\n-b\n+bee\n*** End Patch\n' });
  assert.equal(f.read('a.txt'), 'one\nsecond\nthree\n'); assert.equal(f.read('c.txt'), 'new\n'); assert.equal(f.read('b.txt'), 'bee\n');
  assert.equal(out.rows.length, 3);
  const facts = resultFactsFromRows(manifest.tools['eng.apply_patch@1'], out.rows);
  assert.equal(facts.filter(r => r.predicate === 'eng.file_state').length, 3);
  assert.ok(facts.filter(r => r.predicate === 'eng.tree_step').every(r => r.args.from_gen === 0 && r.args.to_gen === 1));
  for (const row of out.rows) assert.equal(row.readback_digest, sha(f.read(row.path)));
  const read = await f.call('read_v2', { path: 'a.txt', offset: 0 });
  assert.deepEqual(resultFactsFromRows(manifest.tools['eng.read@2'], read.rows), [{ predicate: 'eng.file_read', args: { path: 'a.txt', digest: sha(f.read('a.txt')), bytes: 17 } }]);
  assert.deepEqual(resultFactsFromRows(manifest.tools['eng.read@1'], (await f.call('read', { path: 'a.txt' })).rows), []);
  const next = await f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: b.txt\n@@\n-bee\n+bees\n*** End Patch' });
  assert.equal(next.rows.length, 1);
});

test('one bad hunk, later path escape or missing parent leaves every patch file untouched', async t => {
  const f = fixture(t); f.write('a', 'a\n'); f.write('b', 'b\n');
  for (const tail of [
    '*** Update File: b\n@@\n-missing\n+wrong',
    '*** Add File: ../escape\n+wrong',
    '*** Add File: missing/child\n+wrong',
    '*** Add File: C:/escape\n+wrong',
  ]) {
    await assert.rejects(f.call('apply_patch', { patch: `*** Begin Patch\n*** Update File: a\n@@\n-a\n+changed\n${tail}\n*** End Patch` }), /refused|missing/);
    assert.equal(f.read('a'), 'a\n'); assert.equal(f.read('b'), 'b\n');
    assert.deepEqual(fs.readdirSync(f.root), ['a', 'b']);
  }
});

test('delete requires owner allow and reports empty readback; a refused delete rolls back the whole patch', async t => {
  const f = fixture(t); f.write('a', 'a\n'); f.write('b', 'b\n');
  const patch = '*** Begin Patch\n*** Update File: a\n@@\n-a\n+changed\n*** Delete File: b\n*** End Patch';
  await assert.rejects(f.call('apply_patch', { patch }), /delete refused/);
  assert.equal(f.read('a'), 'a\n'); assert.equal(f.read('b'), 'b\n');
  f.settings({ allow: ['delete'] });
  const out = await f.call('apply_patch', { patch });
  assert.equal(fs.existsSync(path.join(f.root, 'b')), false);
  assert.equal(out.rows[1].digest, sha('')); assert.equal(out.rows[1].bytes, 0);
});

test('patch preserves CRLF, supports multiple hunks and anchors, and refuses ambiguous hunks', async t => {
  const f = fixture(t); f.write('a', 'head\r\nx\r\ny\r\ntail\r\n');
  await f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a\n@@ head\n-x\n+xx\n@@\n-y\n+yy\n tail\n*** End of File\n*** End Patch' });
  assert.equal(f.read('a'), 'head\r\nxx\r\nyy\r\ntail\r\n');
  f.write('a', 'same\nsame\n');
  await assert.rejects(f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a\n@@\n-same\n+changed\n*** End Patch' }), /hunk refused/);
  assert.equal(f.read('a'), 'same\nsame\n');
});

test('patch restores every changed file on a write failure and supports empty additions', async t => {
  const f = fixture(t); f.write('a', 'original a\n'); f.write('b', 'original b\n');
  const write = fs.writeFileSync; let writes = 0;
  fs.writeFileSync = (target, data, ...rest) => {
    if (typeof target === 'number' && Buffer.isBuffer(data) && ++writes === 2) throw new Error('fixture write failure');
    return write(target, data, ...rest);
  };
  try {
    await assert.rejects(f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a\n@@\n-original a\n+changed\n*** Update File: b\n@@\n-original b\n+changed\n*** End Patch' }), /fixture write failure/);
  } finally { fs.writeFileSync = write; }
  assert.equal(f.read('a'), 'original a\n'); assert.equal(f.read('b'), 'original b\n');
  await f.call('apply_patch', { patch: '*** Begin Patch\n*** Add File: empty\n*** End Patch' });
  assert.equal(f.read('empty'), '');
});

test('patch replays the passing test invalidation without duplicate file rows; inline receipts stay bounded', async t => {
  const f = fixture(t); f.write('a', 'a\n');
  const snapshot = tree(f.ctx);
  save(f.ctx.stateFile, { gen: 0, digest: snapshot.digest, test_gen: 0 });
  for (const [before, after] of [['a', 'b'], ['b', 'c']]) {
    const out = await f.call('apply_patch', { patch: `*** Begin Patch\n*** Update File: a\n@@\n-${before}\n+${after}\n*** End Patch` });
    assert.equal(out.rows.length, 1); assert.equal(out.rows[0].from_gen, 0); assert.equal(out.rows[0].to_gen, 1);
    assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), facts: resultFactsFromRows(manifest.tools['eng.apply_patch@1'], out.rows) })) < 8192);
  }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
test('read_image enters real Worker custody and report registration, without inline bytes or facts', async t => {
  const f = fixture(t); f.write('tiny.png', png);
  const out = await f.call('read_image', { path: 'tiny.png' });
  assert.deepEqual(out.rows, []); assert.deepEqual(out.artifacts, [{ path: 'tiny.png', mediaType: 'image/png', digest: `sha256:${sha(png)}` }]);
  const identity = materialIdentity({ configFile: path.join(f.dir, 'fixture-config.json'), gatewayUrl: 'https://example.invalid', connectionId: 'fixture' });
  const store = openMaterialStore(path.join(f.dir, 'materials'), identity);
  const executed = await runArtifactOutput(JSON.stringify(out), { sourceRoot: f.root, maxBytes: 1000, putResult: data => store.putResult(data) });
  assert.equal(executed.localArtifact.digest, `sha256:${sha(png)}`); assert.equal(executed.localArtifact.mediaType, 'image/png');
  let registered = 0;
  const prepared = await prepareActionReport({ work: 'read-image', artifactPolicy: { inlineBytes: 8192, objectBytes: 1000 } }, { ok: true, ...executed }, {
    register: async record => { registered++; return { ref: 'art_' + 'a'.repeat(32), mediaType: record.mediaType, encoding: record.encoding, totalBytes: record.totalBytes, digest: record.digest }; },
  });
  assert.equal(registered, 1); assert.deepEqual(prepared.body.artifacts, [{ ref: 'art_' + 'a'.repeat(32) }]);
  assert.equal(prepared.body.facts, undefined); assert.doesNotMatch(JSON.stringify(prepared.body), /iVBOR|tiny.png/);
  await assert.rejects(runArtifactOutput(JSON.stringify({ ...out, artifacts: [{ ...out.artifacts[0], path: '../escape' }] }), { sourceRoot: f.root, maxBytes: 1000 }), /refused/);
  f.write('tiny.png', Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(runArtifactOutput(JSON.stringify(out), { sourceRoot: f.root, maxBytes: 1000 }), /refused/);
});

test('read_image refuses oversize, non-images, and paths outside the project', async t => {
  const f = fixture(t); f.settings({ imageMaxBytes: 20 }); f.write('large.png', png); f.write('text.png', 'text');
  await assert.rejects(f.call('read_image', { path: 'large.png' }), /size exceeded/);
  await assert.rejects(f.call('read_image', { path: 'text.png' }), /image refused/);
  await assert.rejects(f.call('read_image', { path: '../pins/settings.json' }), /path refused/);
});

async function server(t, handler) {
  const sockets = new Set();
  const s = http.createServer(handler); s.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => s.close(resolve)); });
  return `http://127.0.0.1:${s.address().port}`;
}
const testOnlyGuard = async () => [{ address: '127.0.0.1', family: 4 }];

test('web.fetch uses only an explicit test guard for a local stub, converts HTML and returns evidence', async t => {
  const f = fixture(t);
  const url = await server(t, (req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', 'ignored=1');
    res.end('<html><script>hidden()</script><style>hidden</style><h1>Title</h1><p>A &amp; B &#x1f600;</p></html>');
  });
  await assert.rejects(fetchPage(f.ctx, { url }), /address refused/);
  const out = await fetchPage(f.ctx, { url }, { guard: testOnlyGuard });
  assert.match(out.text, /Title\nA & B 😀/); assert.doesNotMatch(out.text, /hidden/);
  const facts = resultFactsFromRows(manifest.tools['web.fetch@1'], out.rows);
  assert.equal(facts[0].predicate, 'web.page'); assert.equal(facts[0].args.status, 200); assert.equal(facts[0].args.final_url, url + '/');
  assert.match(facts[0].args.digest, /^[a-f0-9]{64}$/);
  // The HTTP hostname is deliberately unresolvable. The checked address must be
  // passed to the socket lookup, rather than doing another DNS lookup at connect time.
  const pinned = await fetchPage(f.ctx, { url: url.replace('127.0.0.1', 'fixture.invalid') }, { guard: testOnlyGuard });
  assert.equal(pinned.rows[0].status, 200);
});

test('web.fetch default guard refuses literals, mapped IPv6 and DNS answers in private ranges, without connecting', async t => {
  const f = fixture(t);
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '[::1]', '[::]', '[fc00::1]', '[fdff::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:a00:1]'])
    await assert.rejects(fetchPage(f.ctx, { url: `http://${host}/` }), /address refused/, host);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const address of ['10.1.2.3', '192.168.1.2', '169.254.0.2', '::1'])
    await assert.rejects(guardedAddresses(new URL('http://fixture.invalid'), { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /address refused/);
  await assert.rejects(guardedAddresses(new URL('http://fixture.invalid'), { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /address refused/);
  for (const url of ['file:///etc/passwd', 'http://user:pass@example.invalid']) await assert.rejects(fetchPage(f.ctx, { url }), /URL refused/);
});

test('web.fetch rechecks every redirect using the default guard, enforces five hops, caps streaming bodies and times out', async t => {
  const f = fixture(t); f.settings({ webMaxBytes: 120, webTimeoutSeconds: 1 });
  const url = await server(t, (req, res) => {
    if (req.url === '/private') { res.writeHead(302, { location: 'http://192.168.0.1/' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/large') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('x'.repeat(80)); res.end('x'.repeat(80)); }
    else if (req.url === '/declared') { res.writeHead(200, { 'content-length': 1000 }); res.end('x'); }
    else if (req.url === '/slow') { /* Deliberately never answer. */ }
  });
  const firstHopOnly = async (next, options) => next.hostname === '127.0.0.1' ? testOnlyGuard() : guardedAddresses(next, options);
  await assert.rejects(fetchPage(f.ctx, { url: url + '/private' }, { guard: firstHopOnly }), /address refused/);
  await assert.rejects(fetchPage(f.ctx, { url: url + '/loop' }, { guard: testOnlyGuard }), /redirects exceeded/);
  for (const route of ['/large', '/declared']) await assert.rejects(fetchPage(f.ctx, { url: url + route }, { guard: testOnlyGuard }), /size exceeded/);
  await assert.rejects(fetchPage(f.ctx, { url: url + '/slow' }, { guard: testOnlyGuard }), /timeout/);
});

test('web.search refuses without an environment key and never includes a key in results, errors or console logs', async t => {
  const f = fixture(t); f.settings({ webSearch: { provider: 'deepseek', keyEnv: 'FIXTURE_SEARCH_KEY' } });
  const key = 'fixture-secret-do-not-report';
  let called = false;
  const provider = async ({ query, key: received }) => { called = true; assert.equal(query, 'query'); assert.equal(received, key); return JSON.stringify([{ title: key, url: 'https://example.invalid', snippet: 'x'.repeat(10000) }]); };
  await assert.rejects(searchWeb(f.ctx, { query: 'query' }, {}, { provider }), { message: 'web search key unavailable' }); assert.equal(called, false);
  const lines = [], saved = [console.log, console.error]; console.log = (...x) => lines.push(x); console.error = (...x) => lines.push(x);
  let out;
  try {
    out = await searchWeb(f.ctx, { query: 'query' }, { FIXTURE_SEARCH_KEY: key }, { provider });
    await assert.rejects(searchWeb(f.ctx, { query: 'query' }, { FIXTURE_SEARCH_KEY: key }, { provider: async () => { throw new Error(key); } }), { message: 'web search failed' });
  } finally { [console.log, console.error] = saved; }
  assert.equal(out.truncated, true); assert.doesNotMatch(JSON.stringify({ out, lines }), new RegExp(key));
  assert.equal(resultFactsFromRows(manifest.tools['web.search@1'], out.rows)[0].predicate, 'web.search');
  assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), facts: resultFactsFromRows(manifest.tools['web.search@1'], out.rows) })) <= 8192);
});

test('DeepSeek provider uses the dsh Anthropic request shape and native structured results', async () => {
  const request = async (url, options) => {
    assert.equal(url.href, 'https://api.deepseek.com/anthropic/v1/messages'); assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-api-key'], 'fixture'); assert.equal(options.headers.authorization, 'Bearer fixture');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    assert.equal(body.messages[0].content[0].text, 'Perform a web search for the query: needle');
    return { status: 200, bytes: Buffer.from(JSON.stringify({ content: [
      { type: 'text', citations: [{ url: 'https://example.invalid', cited_text: 'excerpt' }] },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.invalid', title: 'Title' }, { type: 'web_search_result', url: 'https://example.invalid' }] },
    ] })) };
  };
  assert.deepEqual(JSON.parse(await deepseekSearch({ query: 'needle', key: 'fixture', maxBytes: 1000 }, request)), [{ url: 'https://example.invalid', title: 'Title', snippet: 'excerpt' }]);
  for (const response of [{ status: 302, bytes: Buffer.from('{}') }, { status: 200, bytes: Buffer.from('{"content":[]}') }])
    await assert.rejects(deepseekSearch({ query: 'needle', key: 'fixture' }, async () => response), /search failed/);
});

test('CLI is explicit; installer merges tools and passes only the named search environment variable', t => {
  const f = fixture(t), manager = path.join(f.dir, 'manager'), agent = path.join(f.dir, 'agent'), worker = path.join(f.dir, 'worker');
  for (const dir of [manager, agent, worker]) fs.mkdirSync(dir);
  const config = path.join(agent, 'local.json'), tools = path.join(worker, 'tools.json');
  fs.writeFileSync(path.join(manager, 'registry.json'), JSON.stringify({ instances: [{ mode: 'local_agent', agentName: 'Fixture', directory: agent }] }));
  fs.writeFileSync(config, JSON.stringify({ worker: { env: { RULITH_WORKER_ROOT: worker, RULITH_TOOLS_FILE: tools, UNRELATED: 'retained' } } }));
  fs.writeFileSync(tools, JSON.stringify({ format: manifest.format, tools: { 'other.tool@1': { adapter: 'run' } } }));
  f.settings({ webSearch: { provider: 'deepseek', keyEnv: 'FIXTURE_SEARCH_KEY' }, runDeadlineSeconds: 45 });
  const args = ['--agent', 'Fixture', '--kit-home', f.home, '--manager-home', manager];
  assert.deepEqual(parseLocalCli(['kit', 'install', 'general', ...args]), { command: 'kit', args });
  assert.throws(() => parseLocalCli(['kit', 'install', 'unknown']), /Expected/);
  assert.throws(() => parseKitInstall(['--agent', 'Fixture']), /required/);
  assert.throws(() => parseKitInstall([...args, '--agent', 'Duplicate']), /Expected/);
  assert.match(installGeneral(parseKitInstall(args)), /Installed 18/);
  installGeneral(parseKitInstall(args));
  const installed = JSON.parse(fs.readFileSync(tools));
  assert.equal(Object.keys(installed.tools).length, 19);
  assert.deepEqual(installed.tools['web.search@1'].env.pass, ['ENG_KIT_HOME', 'FIXTURE_SEARCH_KEY']);
  assert.deepEqual(installed.tools['eng.run@1'].env.pass, ['ENG_KIT_HOME']);
  const ambient = { ENG_KIT_HOME: f.home, FIXTURE_SEARCH_KEY: 'fixture-key' };
  assert.equal(adapterEnv(ambient, installed.tools['web.search@1'].env.pass).FIXTURE_SEARCH_KEY, 'fixture-key');
  assert.equal(adapterEnv(ambient, installed.tools['eng.run@1'].env.pass).FIXTURE_SEARCH_KEY, undefined);
  assert.deepEqual(installed.tools['eng.read@1'], manifest.tools['eng.read@1']);
  for (const tool of Object.values(manifest.tools)) assert.ok(fs.existsSync(path.join(worker, tool.entry)));
  const local = JSON.parse(fs.readFileSync(config));
  assert.equal(local.worker.env.ENG_KIT_HOME, f.home); assert.equal(local.worker.env.UNRELATED, 'retained');
  assert.equal(local.worker.env.RULITH_WORKER_RUN_TIMEOUT_SECONDS, '105');
  assert.equal(local.worker.env.FIXTURE_SEARCH_KEY, undefined);
  assert.equal(parseKitInstall(['--agent', 'a', '--kit-home', f.home], { RULITH_MANAGER_HOME: manager })['manager-home'], manager);
});

test('kit Capability accredits every return predicate with the same arguments', () => {
  assert.equal(Object.keys(workerToolsOf(manifest)).length, 18);
  const descriptions = JSON.parse(fs.readFileSync(new URL('../kits/general/tool-descriptions.json', import.meta.url)));
  assert.deepEqual(Object.keys(descriptions).sort(), Object.keys(manifest.tools).sort());
  assert.ok(Object.values(descriptions).every(text => typeof text === 'string' && text.length < 100 && !text.includes('\n')));
  const program = JSON.parse(fs.readFileSync(new URL('../kits/general/pack/program.json', import.meta.url)));
  const sources = JSON.parse(fs.readFileSync(new URL('../kits/general/pack/sources.json', import.meta.url)));
  const definitions = new Map(program.vocabulary.defines.map(d => [d.id, d.args]));
  for (const tool of Object.values(manifest.tools)) for (const row of tool.returns) assert.deepEqual(definitions.get(row.predicate), Object.keys(row.args));
  assert.deepEqual(sources.sources[0].words, [...definitions.keys()]); assert.equal(sources.sources[0].name, 'lab');
  assert.deepEqual(program.actions, []);
});

test('all twelve original contract objects retain their canonical source bytes', () => {
  // Digests captured from the engineering kit when ported; no external checkout is needed.
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/general-kit-legacy-contract-digests.json', import.meta.url)));
  assert.equal(Object.keys(baseline).length, 12);
  for (const [id, digest] of Object.entries(baseline)) assert.equal(sha(JSON.stringify(manifest.tools[id])), digest, id);
});
