import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { perform } from '../kits/general/adapter.mjs';
import { context, sha, save, tree, locked, plainFenced, workerRunTimeoutSeconds } from '../kits/general/lib.mjs';
import { fetchPage, searchWeb, guardedAddresses, publicAddress, deepseekSearch, readableHtml, WEB_TEXT_LIMIT } from '../kits/general/web.mjs';
import { globMatcher, globFiles } from '../kits/general/glob-files.mjs';
import { applyPatch } from '../kits/general/apply-patch.mjs';
import { readImage } from '../kits/general/image.mjs';
import { parseKitInstall, installGeneral } from '../kits/general/installer.mjs';
import { parseLocalCli } from '../local/rulith-local.mjs';
import { adapterEnv, workerToolsOf, toolFromSpec, resultFactsFromRows, prepareActionReport, runAdapterTimeoutMs } from '../worker/rulith-worker.mjs';
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

test('patch replays both the passing test invalidation and current mutation; inline receipts stay bounded', async t => {
  const f = fixture(t); f.write('a', 'a\n');
  const snapshot = tree(f.ctx);
  save(f.ctx.stateFile, { gen: 0, digest: snapshot.digest, test_gen: 0 });
  for (const [before, after] of [['a', 'b'], ['b', 'c']]) {
    const out = await f.call('apply_patch', { patch: `*** Begin Patch\n*** Update File: a\n@@\n-${before}\n+${after}\n*** End Patch` });
    assert.deepEqual(out.rows.map(({ from_gen, to_gen }) => [from_gen, to_gen]), before === 'a' ? [[0, 1]] : [[0, 1], [1, 2]]);
    assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), facts: resultFactsFromRows(manifest.tools['eng.apply_patch@1'], out.rows) })) < 8192);
  }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
test('read_image enters real Worker custody and report registration, without inline bytes or facts', async t => {
  const f = fixture(t); f.write('tiny.png', png);
  const out = await f.call('read_image', { path: 'tiny.png' });
  assert.deepEqual(out.rows, []); assert.deepEqual(out['rulith.artifacts'], [{ path: 'tiny.png', mediaType: 'image/png', digest: `sha256:${sha(png)}` }]);
  const identity = materialIdentity({ configFile: path.join(f.dir, 'fixture-config.json'), gatewayUrl: 'https://example.invalid', connectionId: 'fixture' });
  const store = openMaterialStore(path.join(f.dir, 'materials'), identity);
  const executed = await runArtifactOutput(JSON.stringify(out), { artifactOutput: true, sourceRoot: f.root, maxBytes: 1000, putResult: data => store.putResult(data) });
  assert.equal(executed.localArtifact.digest, `sha256:${sha(png)}`); assert.equal(executed.localArtifact.mediaType, 'image/png');
  let registered = 0;
  const prepared = await prepareActionReport({ work: 'read-image', artifactPolicy: { inlineBytes: 8192, objectBytes: 1000 } }, { ok: true, ...executed }, {
    register: async record => { registered++; return { ref: 'art_' + 'a'.repeat(32), mediaType: record.mediaType, encoding: record.encoding, totalBytes: record.totalBytes, digest: record.digest }; },
  });
  assert.equal(registered, 1); assert.deepEqual(prepared.body.artifacts, [{ ref: 'art_' + 'a'.repeat(32) }]);
  assert.equal(prepared.body.facts, undefined); assert.doesNotMatch(JSON.stringify(prepared.body), /iVBOR|tiny.png/);
  await assert.rejects(runArtifactOutput(JSON.stringify({ ...out, 'rulith.artifacts': [{ ...out['rulith.artifacts'][0], path: '../escape' }] }), { artifactOutput: true, sourceRoot: f.root, maxBytes: 1000 }), /refused/);
  f.write('tiny.png', Buffer.concat([png, Buffer.from('changed')]));
  await assert.rejects(runArtifactOutput(JSON.stringify(out), { artifactOutput: true, sourceRoot: f.root, maxBytes: 1000 }), /refused/);
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
  fs.unlinkSync(path.join(f.home, 'specs/test.json')); // Project acceptance needs no owner-pinned legacy test.
  assert.match(installGeneral(parseKitInstall(args)), /Installed 20/);
  installGeneral(parseKitInstall(args));
  const installed = JSON.parse(fs.readFileSync(tools));
  assert.equal(Object.keys(installed.tools).length, 21);
  assert.deepEqual(installed.tools['eng.test@2'], manifest.tools['eng.test@2']);
  assert.deepEqual(installed.tools['eng.acceptance@1'], manifest.tools['eng.acceptance@1']);
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
  f.settings({ runDeadlineSeconds: 7 * 86400 });
  installGeneral(parseKitInstall(args));
  const maxEnv = JSON.parse(fs.readFileSync(config)).worker.env;
  assert.equal(maxEnv.RULITH_WORKER_RUN_TIMEOUT_SECONDS, '604800');
  assert.equal(runAdapterTimeoutMs(maxEnv), 604800000);
});

test('kit Capability accredits every return predicate with the same arguments', () => {
  assert.equal(Object.keys(workerToolsOf(manifest)).length, 20);
  const program = JSON.parse(fs.readFileSync(new URL('../kits/general/pack/program.json', import.meta.url)));
  const sources = JSON.parse(fs.readFileSync(new URL('../kits/general/pack/sources.json', import.meta.url)));
  assert.equal(sources.meta.version, 2);
  assert.equal(fs.existsSync(new URL('../kits/general/tool-descriptions.json', import.meta.url)), false);
  const definitions = new Map(program.vocabulary.defines.map(d => [d.id, d.args]));
  for (const [id, tool] of Object.entries(manifest.tools)) if (!['eng.test@2', 'eng.acceptance@1'].includes(id))
    for (const row of tool.returns) assert.deepEqual(definitions.get(row.predicate), Object.keys(row.args));
  assert.deepEqual(sources.sources[0].words, [...definitions.keys()]); assert.equal(sources.sources[0].name, 'lab');
  assert.deepEqual(program.actions, []);
});

test('all twelve original contract objects retain their canonical source bytes', () => {
  // Digests captured from the engineering kit when ported; no external checkout is needed.
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/general-kit-legacy-contract-digests.json', import.meta.url)));
  assert.equal(Object.keys(baseline).length, 12);
  for (const [id, digest] of Object.entries(baseline)) assert.equal(sha(JSON.stringify(manifest.tools[id])), digest, id);
});

test('artifact custody is opt-in and namespaced; ordinary run stdout is byte-for-byte', async t => {
  const f = fixture(t);
  for (const stdout of [' {"artifacts":[{"id":1}]}\n', ' {"rulith.artifacts":[{}]}\n', 'plain\n'])
    assert.equal(await runArtifactOutput(stdout, {}), stdout);
  const legacy = ' {"artifacts":[{"id":1}]}\n';
  assert.equal(await runArtifactOutput(legacy, { artifactOutput: true }), legacy);
  assert.equal(manifest.tools['eng.read_image@1'].artifactOutput, true);
  assert.equal(Object.values(manifest.tools).filter(tool => tool.artifactOutput).length, 1);
  assert.equal(workerToolsOf(manifest)['eng.read_image@1'].artifactOutput, true);
  for (const artifactOutput of ['true', 1, null]) {
    const invalid = structuredClone(manifest); invalid.tools['eng.read_image@1'].artifactOutput = artifactOutput;
    assert.throws(() => workerToolsOf(invalid), /artifactOutput/);
  }
  const invalid = structuredClone(manifest);
  invalid.tools['eng.read_image@1'] = { ...invalid.tools['eng.read_image@1'], adapter: 'http' };
  assert.throws(() => workerToolsOf(invalid), /artifactOutput/);
  f.write('a', 'text');
  for (const mediaType of ['text/plain', 'application/json', 'application/pdf', 'image/svg+xml']) {
    await assert.rejects(runArtifactOutput(JSON.stringify({ rows: [], 'rulith.artifacts': [{
      path: 'a', mediaType, digest: `sha256:${sha('text')}`,
    }] }), { artifactOutput: true, sourceRoot: f.root }), { message: 'Run adapter Artifact refused' });
  }
});

test('artifact filesystem failures never expose a local path', async t => {
  const f = fixture(t);
  const stdout = JSON.stringify({ rows: [], 'rulith.artifacts': [{ path: 'missing.png', mediaType: 'image/png', digest: `sha256:${sha(png)}` }] });
  for (const sourceRoot of [f.root, path.join(f.dir, 'missing-root')])
    await assert.rejects(runArtifactOutput(stdout, { artifactOutput: true, sourceRoot }), { message: 'Run adapter Artifact refused' });
  f.write('tiny.png', png);
  for (const method of ['lstatSync', 'openSync', 'realpathSync', 'fstatSync', 'readSync']) {
    const saved = fs[method]; fs[method] = () => { throw new Error(`denied: ${f.root}`); };
    try {
      await assert.rejects(runArtifactOutput(stdout.replace('missing.png', 'tiny.png'), { artifactOutput: true, sourceRoot: f.root }), { message: 'Run adapter Artifact refused' });
    } finally { fs[method] = saved; }
  }
});

test('artifact opt-in survives compilation only from the pinned local manifest', t => {
  const f = fixture(t), tools = workerToolsOf(manifest), sources = { lab: { type: 'file', access: f.root } };
  for (const id of ['eng.read_image@1', 'eng.read@1']) {
    const def = manifest.tools[id];
    const spec = { impl: 'worker-tool', exec: id, kind: 'read', sourceTypes: ['file'], params: def.params, returns: def.returns, artifactOutput: true };
    const compiled = toolFromSpec(JSON.stringify(spec), JSON.stringify({ source: 'lab', path: 'tiny.png' }), tools, tools[id].digest, sources, 'lab');
    assert.equal(compiled.artifactOutput, id === 'eng.read_image@1' ? true : undefined);
  }
});

test('patch preflight budgets two edges per file and refuses before oversized receipts mutate files', async t => {
  const f = fixture(t);
  const names = Array.from({ length: 4 }, (_, i) => `${i}-${'x'.repeat(170)}`);
  for (const name of names) f.write(name, 'a\n');
  save(f.ctx.stateFile, { gen: 1, digest: tree(f.ctx).digest, test_gen: 0, invalidation: { from_gen: 0, to_gen: 1 } });
  const patch = `*** Begin Patch\n${names.map(name => `*** Update File: ${name}\n@@\n-a\n+b`).join('\n')}\n*** End Patch`;
  await assert.rejects(f.call('apply_patch', { patch }), /patch file count refused/);
  for (const name of names) assert.equal(f.read(name), 'a\n');
});

test('HTML scanning is bounded and linear on unterminated and repeated hostile tags', async t => {
  const f = fixture(t);
  const hostile = '<'.repeat(256 * 1024);
  const start = performance.now();
  assert.equal(readableHtml(hostile), hostile.slice(0, WEB_TEXT_LIMIT));
  assert.ok(performance.now() - start < 500, 'HTML scanner must finish within 500 ms');
  assert.equal(readableHtml('visible' + ' '.repeat(100000) + 'tail'), 'visible tail');
  assert.equal(readableHtml('a<!-- hidden -->b<script>hide</script>c<style>hide</style>d'), 'abcd');
  assert.equal(readableHtml('ok<!--' + '<'.repeat(200000)), 'ok');
  assert.equal(readableHtml('<a>'.repeat(10000) + 'visible'), 'visible');
  const url = await server(t, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(hostile); });
  const out = await fetchPage(f.ctx, { url }, { guard: testOnlyGuard });
  assert.equal(out.rows[0].digest, sha(hostile)); assert.equal(out.truncated, true);
});

test('Source locks recover a dead pid, record holder start time, and keep live holders exclusive', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  const deadPid = 2147483647;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  for (const record of [String(deadPid), JSON.stringify({ pid: deadPid, startedAt: '2020-01-01T00:00:00Z' })]) {
    fs.writeFileSync(lock, record);
    assert.equal(await locked(f.ctx, async () => {
      const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
      assert.equal(holder.pid, process.pid); assert.ok(Number.isFinite(Date.parse(holder.startedAt)));
      assert.ok(Math.abs(Date.now() - Date.parse(holder.startedAt)) < 1000, 'lease starts at acquisition');
      await assert.rejects(locked(f.ctx, () => assert.fail('live lock stolen')), /adapter busy/);
      return 'recovered';
    }), 'recovered');
    assert.equal(fs.existsSync(lock), false);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(f.call('read', { path: 'a' }), /adapter busy/);
});

test('a competing stale-lock recoverer cannot enter or unlink the elected holder lock', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, startedAt: '2020-01-01T00:00:00Z' }));
  let competing, injected = false, entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const read = fs.readFileSync;
  // Inject the other acquisition between the original holder's stale read and unlink.
  fs.readFileSync = (file, ...rest) => {
    const bytes = read(file, ...rest);
    if (file === lock && !injected) {
      injected = true;
      competing = locked(f.ctx, async () => { entered = true; await gate; });
      competing.catch(() => {});
    }
    return bytes;
  };
  try {
    await locked(f.ctx, async () => {
      assert.equal(entered, false);
      await assert.rejects(competing, /adapter busy/);
      assert.equal(JSON.parse(read(lock, 'utf8')).pid, process.pid);
    });
  } finally { fs.readFileSync = read; release(); await competing?.catch(() => {}); }
  assert.equal(injected, true); assert.equal(fs.existsSync(lock), false);
  // A killed participant left in the middle of choosing also cannot wedge recovery.
  const deadClaim = path.join(`${lock}.claims`, '2147483647-00000000-0000-0000-0000-000000000000');
  fs.mkdirSync(deadClaim);
  assert.equal(await locked(f.ctx, async () => 'recovered'), 'recovered');
});

test('patch accepts both Codex blank context forms and preserves EOL per line', async t => {
  const f = fixture(t);
  for (const blank of ['', ' ']) {
    f.write('mixed', 'head\r\n\nx\r\ny\nlast');
    await f.call('apply_patch', { patch: `*** Begin Patch\n*** Update File: mixed\n@@\n head\n${blank}\n-x\n+xx\n-y\n+yy\n last\n*** End Patch` });
    assert.equal(f.read('mixed'), 'head\r\n\nxx\r\nyy\nlast');
  }
  f.write('mixed', 'head\nkeep\r\nend\r\n');
  await f.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: mixed\n@@\n-head\n+new\n keep\n*** End Patch' });
  assert.equal(f.read('mixed'), 'new\nkeep\r\nend\r\n');
});

for (const directory of [false, true]) test(`patch and image refuse ${directory ? 'directory links/junctions' : 'file symlinks'} before resolving their targets`, async t => {
  const f = fixture(t);
  f.settings({ allow: ['delete'] }); f.write('real/a', 'a\n'); f.write('real/image.png', png);
  const link = path.join(f.root, 'link');
  try { fs.symlinkSync(path.join(f.root, directory ? 'real' : 'real/a'), link, directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) { t.skip(`link creation unavailable: ${error.code}`); return; }
    throw error;
  }
  const name = directory ? 'link/a' : 'link';
  for (const body of [`*** Update File: ${name}\n@@\n-a\n+changed`, `*** Delete File: ${name}`, ...(directory ? ['*** Add File: link/new\n+new'] : [])])
    await assert.rejects(f.call('apply_patch', { patch: `*** Begin Patch\n${body}\n*** End Patch` }), /path refused/);
  await assert.rejects(f.call('read_image', { path: directory ? 'link/image.png' : 'link' }), /path refused/);
  assert.equal(f.read('real/a'), 'a\n'); assert.deepEqual(fs.readFileSync(path.join(f.root, 'real/image.png')), png);
  assert.equal(fs.existsSync(path.join(f.root, 'real/new')), false);
});

test('plain path checks terminate with different Windows root casing', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.write('a', 'a\n'); f.write('tiny.png', png);
  const ctx = { ...f.ctx, root: f.ctx.root.toUpperCase() };
  assert.ok(plainFenced(ctx.root, 'a'));
  assert.equal(readImage(ctx, { path: 'tiny.png' })['rulith.artifacts'].length, 1);
  applyPatch(ctx, '*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n*** End Patch');
  assert.equal(f.read('a'), 'b\n');
});

test('web tools skip tree walks and Source locks throughout network waits', async t => {
  const f = fixture(t);
  f.settings({ webSearch: { provider: 'deepseek', keyEnv: 'FIXTURE_SEARCH_KEY' } });
  const cache = path.join(f.home, 'tree-cache.json'), lock = `${f.ctx.stateFile}.lock`;
  let waiting, resume;
  const started = new Promise(resolve => { waiting = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const url = await server(t, async (_req, res) => { waiting(); await gate; res.end('page'); });
  const fetching = perform('web_fetch', { url }, f.env, { guard: testOnlyGuard });
  await started;
  try {
    assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(cache), false);
    await locked(f.ctx, async () => {
      const searching = await perform('web_search', { query: 'query' }, { ...f.env, FIXTURE_SEARCH_KEY: 'fixture' }, { provider: async () => 'answer' });
      assert.equal(searching.text, 'answer');
    });
  } finally { resume(); await fetching; }
  assert.equal(fs.existsSync(f.ctx.stateFile), false); assert.equal(fs.existsSync(cache), false);
});

test('SSRF guard refuses benchmarking, protocol, documentation, reserved and multicast ranges', async () => {
  for (const address of ['198.18.0.0', '198.19.255.255', '192.0.0.0', '192.0.0.255', '192.0.2.1',
    '198.51.100.9', '203.0.113.2', '240.0.0.1', '255.255.255.255', '224.0.0.1', '239.255.255.255',
    '2001:db8::1', '2001:db8:ffff::1', 'ff02::1', '::ffff:c612:1', '::ffff:c000:201',
    '2001:2::1', '2001:10::1', '2001:1f:ffff::1', '2001:20::1', '2001:2f:ffff::1',
    '3fff::1', '3fff:fff:ffff::1', '192.88.99.1']) {
    assert.equal(publicAddress(address), false, address);
    await assert.rejects(guardedAddresses(new URL('http://fixture.invalid'), { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /web address refused/, address);
  }
  for (const address of ['198.17.255.255', '198.20.0.0', '192.0.1.1', '2001:db9::1', '2001:30::1', '3fff:1000::1']) assert.equal(publicAddress(address), true, address);
});

test('glob refuses excess wildcard tokens and an expired walk deadline with a fixed verdict', async t => {
  const f = fixture(t); f.write('a', 'a');
  await assert.rejects(f.call('glob', { pattern: '*a'.repeat(21) }), { message: 'glob complexity refused' });
  assert.throws(() => globMatcher('**/'.repeat(21) + 'a'), { message: 'glob complexity refused' });
  const now = performance.now.bind(performance); let elapsed = 0;
  t.mock.method(performance, 'now', () => now() + elapsed);
  const matcher = globMatcher('*a'.repeat(20) + 'b');
  assert.equal(matcher.test('a'.repeat(2000)), false);
  elapsed = 5001;
  assert.throws(() => matcher.test('a'.repeat(2000)), { message: 'glob complexity refused' });
  elapsed = 0;
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args) => { const entries = readdir(...args); if (args[0] === f.root) elapsed = 5001; return entries; });
  assert.throws(() => globFiles(f.ctx, { pattern: '**/*.java' }), { message: 'glob complexity refused' });
});

test('glob handles 5000 realistic repository files without a shared operation limit', t => {
  const f = fixture(t);
  f.settings({ treeExclude: ['**/node_modules', '**/target', '**/dist'] });
  for (let i = 0; i < 1250; i++) {
    f.write(`src/main/java/com/example/component${i % 25}/Application${i}Service.java`, 'class Example {}');
    f.write(`console-web/src/components/feature${i % 25}/Component${i}.vue`, '<template/>');
    f.write(`docs/reference/component${i % 25}/guide${i}.md`, '# Guide');
    f.write(`src/test/java/com/example/component${i % 25}/Application${i}Test.java`, 'class Test {}');
  }
  for (const pattern of ['**/*.java', '**/*.md', 'console-web/src/**/*.vue', 'src/main/java/**/*Service.java']) {
    const out = globFiles(f.ctx, { pattern });
    assert.ok(out.rows.length > 0, pattern); assert.equal(out.truncated, true);
    assert.ok(out.rows.every(row => globMatcher(pattern).test(row.path)), pattern);
  }
});

test('exclusive lock publication cannot overwrite a legacy wx holder arriving after the read', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`, read = fs.readFileSync;
  let fd, injected = false, entered = false;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    try { return read(file, ...args); }
    catch (error) {
      if (file === lock && !injected && error.code === 'ENOENT') {
        injected = true; fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid));
      }
      throw error;
    }
  });
  try {
    await assert.rejects(locked(f.ctx, () => { entered = true; }), /adapter busy/);
    assert.equal(entered, false); assert.equal(read(lock, 'utf8'), String(process.pid));
  } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
  assert.equal(injected, true);
  assert.deepEqual(fs.readdirSync(f.home).filter(name => name.endsWith('.tmp')), []);
});

test('Source lock leases recover old live pids and choosing claims, but fresh live holders block', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  f.settings({ runDeadlineSeconds: 1, pollMaxWaitSeconds: 2, webTimeoutSeconds: 3 });
  const old = new Date(Date.now() - 124000);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: old.toISOString() }));
  assert.equal(await locked(f.ctx, () => 'recovered'), 'recovered');
  // Legacy pid-only locks use their filesystem timestamp.
  fs.writeFileSync(lock, String(process.pid)); fs.utimesSync(lock, old, old);
  assert.equal(await locked(f.ctx, () => 'legacy recovered'), 'legacy recovered');
  fs.writeFileSync(lock, ''); fs.utimesSync(lock, old, old);
  assert.equal(await locked(f.ctx, () => 'empty legacy recovered'), 'empty legacy recovered');
  const claim = path.join(`${lock}.claims`, `${process.pid}-00000000-0000-0000-0000-000000000000`);
  fs.mkdirSync(claim); fs.utimesSync(claim, old, old);
  assert.equal(await locked(f.ctx, () => 'claim recovered'), 'claim recovered');
  assert.equal(fs.existsSync(claim), false);
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'ticket.json'), JSON.stringify({ pid: process.pid, ticket: 1, startedAt: old.toISOString() }));
  fs.utimesSync(claim, old, old);
  assert.equal(await locked(f.ctx, () => 'published claim recovered'), 'published claim recovered');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(locked(f.ctx, () => assert.fail('fresh lock stolen')), /adapter busy/);
  fs.unlinkSync(lock);
  fs.mkdirSync(claim);
  await assert.rejects(locked(f.ctx, () => assert.fail('fresh choosing claim stolen')), /adapter busy/);
});

test('lock lease adds 60 seconds beyond the installed Worker timeout for every deadline', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  for (const field of ['runDeadlineSeconds', 'pollMaxWaitSeconds', 'webTimeoutSeconds']) {
    f.settings({ runDeadlineSeconds: 1, pollMaxWaitSeconds: 1, webTimeoutSeconds: 1, [field]: 100 });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 170000).toISOString() }));
    await assert.rejects(locked(f.ctx, () => assert.fail(`${field} ignored`)), /adapter busy/);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 221000).toISOString() }));
    assert.equal(await locked(f.ctx, () => 'recovered'), 'recovered');
  }
});

test('unrelated claims directory files do not block a Source', async t => {
  const f = fixture(t), claims = `${f.ctx.stateFile}.lock.claims`;
  fs.mkdirSync(claims);
  for (const name of ['.DS_Store', 'desktop.ini']) fs.writeFileSync(path.join(claims, name), 'metadata');
  assert.equal(await locked(f.ctx, () => 'entered'), 'entered');
  assert.deepEqual(fs.readdirSync(claims).sort(), ['.DS_Store', 'desktop.ini']);
});

test('standalone lock callers can derive the kit home from the state file', async t => {
  const f = fixture(t);
  assert.equal(await locked({ stateFile: f.ctx.stateFile }, () => 'entered'), 'entered');
});

test('simultaneous choosing callers retry and serialize rather than both returning busy', async t => {
  const f = fixture(t), claims = `${f.ctx.stateFile}.lock.claims`, read = fs.readdirSync;
  let injected = false, competing, active = 0, entered = 0;
  const action = async () => {
    assert.equal(active++, 0); entered++;
    await new Promise(resolve => setTimeout(resolve, 40)); active--; return 'entered';
  };
  t.mock.method(fs, 'readdirSync', (directory, ...args) => {
    if (directory === claims && !injected) { injected = true; competing = locked(f.ctx, action); }
    return read(directory, ...args);
  });
  const first = locked(f.ctx, action);
  assert.deepEqual(await Promise.all([first, competing]), ['entered', 'entered']);
  assert.equal(entered, 2); assert.equal(active, 0);
});

test('next Source acquisition removes only stale kit save temporaries', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  const uuid = '00000000-0000-0000-0000-000000000000';
  const stale = [`${path.basename(lock)}.${uuid}.tmp`, `tree-cache.json.${uuid}.tmp`, `${path.basename(f.ctx.stateFile)}.${uuid}.tmp`, `${path.basename(f.ctx.jobFile)}.${uuid}.tmp`];
  const keep = [`${path.basename(lock)}.11111111-1111-1111-1111-111111111111.tmp`, 'owner.tmp', `owner.json.${uuid}.tmp`];
  const old = new Date(Date.now() - 200000);
  for (const name of [...stale, ...keep]) fs.writeFileSync(path.join(f.home, name), 'partial');
  for (const name of [...stale, ...keep.slice(1)]) fs.utimesSync(path.join(f.home, name), old, old);
  assert.equal(await locked(f.ctx, () => 'entered'), 'entered');
  for (const name of stale) assert.equal(fs.existsSync(path.join(f.home, name)), false, name);
  for (const name of keep) assert.equal(fs.existsSync(path.join(f.home, name)), true, name);
});

test('failed kit save removes its temporary file immediately', t => {
  const f = fixture(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('fixture rename refused'), { code: 'EACCES' }); });
  assert.throws(() => save(f.ctx.stateFile, { value: 1 }), /fixture rename refused/);
  assert.deepEqual(fs.readdirSync(f.home), ['specs']);
});

test('HTML fetch reaches body text after 100 KiB of head and still hashes every byte', async t => {
  const f = fixture(t);
  const html = `<html><head><style>${'x'.repeat(110000)}</style><script>${'y'.repeat(110000)}</script></head><body><p>late body text</p></body></html>`;
  const url = await server(t, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  const out = await fetchPage(f.ctx, { url }, { guard: testOnlyGuard });
  assert.equal(out.text, 'late body text'); assert.equal(out.rows[0].digest, sha(html));
  assert.equal(out.truncated, undefined);
  const text = readableHtml('<p>' + 'visible '.repeat(100000) + '</p>');
  assert.ok(text.length <= WEB_TEXT_LIMIT); assert.ok(text.startsWith('visible'));
});

test('HTML preserves visible text after an unterminated less-than sign', () => {
  for (const text of ['value < 3', 'before <unfinished', '<', '<<tail']) assert.equal(readableHtml(text), text);
  assert.equal(readableHtml('<script>hidden <unfinished'), '');
});

test('README explains search key custody and the command user trust boundary', () => {
  const readme = fs.readFileSync(new URL('../kits/general/README.md', import.meta.url), 'utf8');
  assert.match(readme, /Worker process environment/);
  assert.match(readme, /eng\.run.*eng\.job_start/);
  assert.match(readme, /dedicated low-privilege search key/);
});

test('P3 choosing and published claims retain the extra lease margin', async t => {
  const f = fixture(t), claims = `${f.ctx.stateFile}.lock.claims`;
  const claim = path.join(claims, `${process.pid}-00000000-0000-0000-0000-000000000000`);
  fs.mkdirSync(claim, { recursive: true });
  const age = new Date(Date.now() - (workerRunTimeoutSeconds(f.home) + 10) * 1000);
  for (const published of [false, true]) {
    if (published) fs.writeFileSync(path.join(claim, 'ticket.json'), JSON.stringify({ pid: process.pid, ticket: 1, startedAt: age.toISOString() }));
    fs.utimesSync(claim, age, age);
    await assert.rejects(locked(f.ctx, () => assert.fail('claim lease margin ignored')), /adapter busy/);
    assert.equal(fs.existsSync(claim), true);
  }
});

test('P3 stale temporary cleanup ignores every unlink failure', async t => {
  const f = fixture(t), unlink = fs.unlinkSync;
  const file = `${f.ctx.stateFile}.00000000-0000-0000-0000-000000000000.tmp`;
  fs.writeFileSync(file, 'partial');
  const old = new Date(Date.now() - 300000); fs.utimesSync(file, old, old);
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
    let attempted = false;
    const mock = t.mock.method(fs, 'unlinkSync', (target, ...args) => {
      if (target === file) { attempted = true; throw Object.assign(new Error('fixture cleanup failure'), { code }); }
      return unlink(target, ...args);
    });
    try { assert.equal(await locked(f.ctx, () => 'action result'), 'action result'); assert.equal(attempted, true); }
    finally { mock.mock.restore(); }
    assert.equal(fs.existsSync(file), true);
  }
});

for (const code of ['ENOTSUP', 'ENOSYS', 'EISDIR', 'EPERM', 'EXDEV']) {
  test(`P3 unsupported hard links fall back to exclusive creation: ${code}`, async t => {
    const f = fixture(t), lock = `${f.ctx.stateFile}.lock`, read = fs.readFileSync;
    const link = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('fixture link unsupported'), { code }); });
    assert.equal(await locked(f.ctx, () => {
      const holder = JSON.parse(read(lock, 'utf8'));
      assert.equal(holder.pid, process.pid); assert.ok(holder.token);
      return 'action result';
    }), 'action result');
    assert.ok(link.mock.callCount() > 0); assert.equal(fs.existsSync(lock), false);
    let injected = false;
    const reader = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === lock && !injected) {
        injected = true; fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        throw Object.assign(new Error('fixture read race'), { code: 'ENOENT' });
      }
      return read(file, ...args);
    });
    try {
      await assert.rejects(locked(f.ctx, () => assert.fail('legacy holder overwritten')), /adapter busy/);
      assert.equal(read(lock, 'utf8'), String(process.pid));
    } finally { reader.mock.restore(); }
  });
}

test('P3 pretty-printed tag whitespace cannot exhaust the HTML text budget', () => {
  for (const tag of ['span', 'div']) {
    const html = '<html><head><title>T</title></head><body>' + `\n      <${tag} class="i"></${tag}>`.repeat(9000) + '\n<p>BODY TEXT HERE</p></body></html>';
    assert.match(readableHtml(html), /BODY TEXT HERE/);
  }
  assert.equal(readableHtml('<p>first</p>\n  <span>second</span>'), 'first\nsecond');
});

test('P3 foreign malformed or unreadable claims are skipped and expiry still cleans them', async t => {
  const f = fixture(t), claims = `${f.ctx.stateFile}.lock.claims`, read = fs.readFileSync;
  const names = ['0', String(Number.MAX_SAFE_INTEGER + 1), ...Array(6).fill(String(process.pid))];
  const dirs = names.map((pid, i) => path.join(claims, `${pid}-${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`));
  const records = ['{}', '{}', 'not json', 'null', '{"ticket":0}', '{"ticket":9007199254740992}', '{}', '{}'];
  for (const [i, dir] of dirs.entries()) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'ticket.json'), records[i]); }
  const unreadable = dirs.slice(-2).map(dir => path.join(dir, 'ticket.json'));
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const i = unreadable.indexOf(file);
    if (i >= 0) throw Object.assign(new Error('fixture unreadable ticket'), { code: ['EACCES', 'EIO'][i] });
    return read(file, ...args);
  });
  assert.equal(await locked(f.ctx, () => 'entered'), 'entered');
  for (const dir of dirs) assert.equal(fs.existsSync(dir), true);
  const old = new Date(Date.now() - 300000);
  for (const dir of dirs) fs.utimesSync(dir, old, old);
  assert.equal(await locked(f.ctx, () => 'expired'), 'expired');
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
});

test('P3 lock release leaves empty and non-JSON replacement holders without masking results', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  for (const replacement of ['', 'old kit partial record', 'null']) {
    assert.equal(await locked(f.ctx, () => { fs.writeFileSync(lock, replacement); return 'action result'; }), 'action result');
    assert.equal(fs.readFileSync(lock, 'utf8'), replacement); fs.unlinkSync(lock);
    const failure = new Error('action failure');
    await assert.rejects(locked(f.ctx, () => { fs.writeFileSync(lock, replacement); throw failure; }), error => error === failure);
    assert.equal(fs.readFileSync(lock, 'utf8'), replacement); fs.unlinkSync(lock);
  }
});

test('P3 job_stop uses its run budget even when poll maximum is below five seconds', async t => {
  const f = fixture(t);
  for (const runDeadlineSeconds of [1, 10]) {
    f.settings({ pollMaxWaitSeconds: 1, runDeadlineSeconds });
    const job = { id: 'fixture-job', status: 'running', command: ['node', 'job.mjs'], before: 'fixture-tree', pid: 0, supervisor_pid: 0, exit_code: -1 };
    save(f.ctx.jobFile, job);
    const timer = setTimeout(() => save(f.ctx.jobFile, { ...job, status: 'stopped' }), runDeadlineSeconds === 1 ? 50 : 1200);
    try {
      const out = await f.call('job_stop', { job_id: job.id });
      assert.equal(out.rows[0].status, 'stopped');
      assert.equal(fs.readFileSync(`${f.ctx.jobFile}.stop`, 'utf8'), job.id);
    } finally { clearTimeout(timer); }
  }
});

test('P3 future-dated live holders beyond the lease recover after clock corrections', async t => {
  const f = fixture(t), lock = `${f.ctx.stateFile}.lock`;
  const lease = (workerRunTimeoutSeconds(f.home) + 60) * 1000;
  const future = new Date(Date.now() + lease + 60000);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: future.toISOString() }));
  assert.equal(await locked(f.ctx, () => 'lock recovered'), 'lock recovered');
  const claim = path.join(`${lock}.claims`, `${process.pid}-00000000-0000-0000-0000-000000000000`);
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'ticket.json'), JSON.stringify({ pid: process.pid, ticket: 1, startedAt: future.toISOString() }));
  assert.equal(await locked(f.ctx, () => 'claim recovered'), 'claim recovered');
  assert.equal(fs.existsSync(claim), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() + lease / 2).toISOString() }));
  await assert.rejects(locked(f.ctx, () => assert.fail('within-lease clock skew stolen')), /adapter busy/);
});
