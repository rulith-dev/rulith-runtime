import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { perform, main } from '../kits/general/adapter.mjs';
import { context, sha, save } from '../kits/general/lib.mjs';
import { acceptanceSpec } from '../kits/general/acceptance-specs.mjs';
import { buildPackages } from '../kits/general/pack/build-pack.mjs';
import { resultFactsFromRows } from '../worker/rulith-worker.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tools = JSON.parse(fs.readFileSync(path.join(repo, 'kits/general/worker-tools.json'))).tools;
function fixture(t) {
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'acceptance-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const root = path.join(dir, 'project'), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(root, '.rulith/acceptance'), { recursive: true });
  fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, ENG_KIT_HOME: home };
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  write('test.mjs', 'process.exitCode = 0;\n');
  const spec = { command: [process.execPath, 'test.mjs'], cwd: '.', files: { 'test.mjs': sha('process.exitCode = 0;\n') } };
  const put = (value = spec, check = 'unit') => write(`.rulith/acceptance/${check}.json`, JSON.stringify(value));
  put();
  return { root, home, env, ctx: context(env), write, spec, put,
    call: (tool, args = {}) => perform(tool, args, env),
    cli: (entry, args = {}) => spawnSync(process.execPath, [path.join(repo, `kits/general/${entry}.mjs`), JSON.stringify(args)], { env, encoding: 'utf8', windowsHide: true }),
  };
}

test('acceptance digest hashes compact recursively sorted JSON UTF-8 without a newline', t => {
  const f = fixture(t);
  const a = acceptanceSpec(f.ctx, 'unit');
  const expected = `{"command":${JSON.stringify(f.spec.command)},"cwd":".","files":{"test.mjs":"${f.spec.files['test.mjs']}"}}`;
  assert.equal(a.digest, sha(Buffer.from(expected, 'utf8')));
  f.write('.rulith/acceptance/unit.json', JSON.stringify({ files: f.spec.files, cwd: '.', command: f.spec.command }, null, 4) + '\r\n');
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  f.put({ ...f.spec, files: { 'z.mjs': 'a'.repeat(64), 'test.mjs': f.spec.files['test.mjs'] } });
  const reordered = acceptanceSpec(f.ctx, 'unit').digest;
  f.put({ files: { 'test.mjs': f.spec.files['test.mjs'], 'z.mjs': 'a'.repeat(64) }, command: f.spec.command, cwd: '.' });
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, reordered);
  for (const change of [{ command: [...f.spec.command, 'extra'] }, { shell: false }, { output_dirs: [] }, { cwd: 'src' }, { files: { 'test.mjs': 'b'.repeat(64) } }]) {
    f.put({ ...f.spec, ...change }); assert.notEqual(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  }
});

test('acceptance spec validation refuses malformed fields and paths with a fixed verdict', async t => {
  const f = fixture(t);
  for (const spec of [null, [], {}, { ...f.spec, extra: 1 }, { ...f.spec, command: [] },
    { ...f.spec, command: [''] }, { ...f.spec, command: ['x\0'] }, { ...f.spec, command: 'node test.mjs' },
    { ...f.spec, cwd: undefined }, { ...f.spec, cwd: '../outside' }, { ...f.spec, shell: 'true' },
    { ...f.spec, files: [] }, { ...f.spec, files: { '/absolute': 'a'.repeat(64) } },
    { ...f.spec, files: { '../escape': 'a'.repeat(64) } }, { ...f.spec, files: { 'C:/escape': 'a'.repeat(64) } },
    { ...f.spec, files: { 'a\\b': 'a'.repeat(64) } }, { ...f.spec, files: { 'a\nb': 'a'.repeat(64) } },
    { ...f.spec, files: { './test.mjs': 'a'.repeat(64) } }, { ...f.spec, files: { 'test.mjs': 'A'.repeat(64) } },
    { ...f.spec, files: { 'test.mjs': 123 } }, { ...f.spec, output_dirs: 'out' },
    ...['.', '..', '/out', 'out/../src', '.rulith', '.rulith/acceptance', '.rulith/acceptance/unit.json', 'test.mjs'].map(dir => ({ ...f.spec, output_dirs: [dir] })),
  ]) {
    f.put(spec);
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance spec invalid' });
  }
  for (const text of ['{', '\uFEFF{}', ' '.repeat(16385) + '{}']) {
    f.write('.rulith/acceptance/unit.json', text);
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance spec invalid' });
  }
  f.write('.rulith/acceptance/unit.json', Buffer.concat([
    Buffer.from('{"command":["node","'), Buffer.from([0xff]), Buffer.from('"],"cwd":".","files":{}}'),
  ]));
  assert.throws(() => acceptanceSpec(f.ctx, 'unit'), { message: 'acceptance spec invalid' });
  for (const check of ['', 'A', '../unit', 'x'.repeat(41), 1])
    await assert.rejects(f.call('test_v2', { check }), { message: 'acceptance check invalid' });
  for (const args of [{}, { check: 'unit', command: 'override' }])
    await assert.rejects(f.call('test_v2', args), { message: 'acceptance check invalid' });
  f.put(f.spec, 'a'.repeat(40));
  assert.ok(acceptanceSpec(f.ctx, 'a'.repeat(40)).digest);
  await assert.rejects(f.call('test_v2', { check: 'missing' }), { message: 'acceptance spec invalid' });
});

test('missing or changed dependency refuses before execution, returns no facts and never freezes the spec', async t => {
  const f = fixture(t);
  f.write('test.mjs', "import fs from 'node:fs'; fs.writeFileSync('ran', 'yes');\n");
  for (const mutate of [() => {}, () => fs.unlinkSync(path.join(f.root, 'test.mjs')),
    () => fs.mkdirSync(path.join(f.root, 'test.mjs'))]) {
    mutate();
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance file changed: test.mjs' });
    assert.equal(fs.existsSync(path.join(f.root, 'ran')), false);
    assert.equal(fs.existsSync(f.ctx.stateFile), false);
    assert.deepEqual(fs.readdirSync(path.join(f.home, 'specs')), []);
  }
});

test('every listed file is verified and hashes exact bytes, including line endings', async t => {
  const f = fixture(t);
  f.write('tests/second.mjs', 'test\r\n');
  f.put({ ...f.spec, files: { ...f.spec.files, 'tests/second.mjs': sha('test\n') } });
  await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance file changed: tests/second.mjs' });
  assert.equal(fs.existsSync(f.ctx.stateFile), false);
});

test('a dependency-free spec is valid and discovery reports zero files', async t => {
  const f = fixture(t); f.put({ ...f.spec, files: {} });
  assert.deepEqual((await f.call('acceptance')).rows, [{ check: 'unit',
    spec_digest: acceptanceSpec(f.ctx, 'unit').digest, files: 0 }]);
});

test('the adapter failure envelope preserves the fixed file-change verdict and emits no facts', async t => {
  const f = fixture(t);
  f.write('test.mjs', 'changed\r\n');
  const originalArgv = process.argv, originalCode = process.exitCode;
  const keys = ['RULITH_SOURCE_TYPE', 'RULITH_SOURCE_ACCESS', 'ENG_KIT_HOME'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let stdout = '', stderr = '';
  const out = t.mock.method(process.stdout, 'write', chunk => { stdout += chunk; return true; });
  const err = t.mock.method(process.stderr, 'write', chunk => { stderr += chunk; return true; });
  try {
    for (const key of keys) process.env[key] = f.env[key];
    process.argv = [process.execPath, 'test_v2.mjs', '{"check":"unit"}'];
    await main('test_v2');
    assert.equal(process.exitCode, 2);
    assert.equal(stderr, 'acceptance file changed: test.mjs');
    const receipt = JSON.parse(stdout);
    assert.deepEqual(receipt, { rows: [], verdict: stderr });
    assert.deepEqual(resultFactsFromRows(tools['eng.test@2'], receipt.rows), []);
  } finally {
    out.mock.restore(); err.mock.restore();
    process.argv = originalArgv; process.exitCode = originalCode;
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
  }
});

test('acceptance refuses links in specs and dependency components, and unreadable files', async t => {
  const f = fixture(t), lstat = fs.lstatSync;
  let linked = path.join(f.root, '.rulith/acceptance/unit.json');
  const link = t.mock.method(fs, 'lstatSync', (target, ...args) => target === linked ? { isSymbolicLink: () => true } : lstat(target, ...args));
  assert.throws(() => acceptanceSpec(f.ctx, 'unit'), { message: 'acceptance spec invalid' });
  linked = path.join(f.root, '.rulith');
  await assert.rejects(f.call('acceptance'), { message: 'acceptance spec invalid' });
  linked = path.join(f.root, 'test.mjs');
  await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance file changed: test.mjs' });
  link.mock.restore();
  const open = fs.openSync, read = fs.readSync; let blockedFd;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    const fd = open(target, ...args);
    if (target === path.join(f.root, 'test.mjs')) blockedFd = fd;
    return fd;
  });
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (fd === blockedFd) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return read(fd, ...args);
  });
  await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance file changed: test.mjs' });
});

test('one acceptance spec cannot exclude another spec dependency from tree invalidation', async t => {
  const f = fixture(t);
  f.write('tests/a.mjs', 'first');
  f.put({ ...f.spec, files: { 'tests/a.mjs': sha('first') } }, 'a');
  f.put({ ...f.spec, output_dirs: ['tests'] }, 'b');
  const before = (await f.call('tree_state')).rows[0];
  f.write('tests/a.mjs', 'second version');
  const after = (await f.call('tree_state')).rows[0];
  assert.equal(after.gen, before.gen + 1); assert.notEqual(after.tree_digest, before.tree_digest);
});

test('test@2 receipts name the check and final tree generation; later writes invalidate it', async t => {
  const f = fixture(t);
  f.write('test.mjs', "import fs from 'node:fs'; fs.writeFileSync('generated', 'yes');\n");
  f.put({ ...f.spec, files: { 'test.mjs': sha(fs.readFileSync(path.join(f.root, 'test.mjs'))) } });
  await f.call('tree_state');
  const out = await f.call('test_v2', { check: 'unit' });
  const row = out.rows[0];
  assert.equal(row.check, 'unit'); assert.equal(row.exit_code, 0); assert.equal(row.gen, 1);
  assert.equal(row.spec_digest, acceptanceSpec(f.ctx, 'unit').digest);
  assert.equal(row.tree_digest, (await f.call('tree_state')).rows[0].tree_digest);
  assert.deepEqual([row.from_gen, row.to_gen], [0, 1]);
  assert.deepEqual(resultFactsFromRows(tools['eng.test@2'], out.rows), [
    { predicate: 'eng.test_result', args: { check: 'unit', spec_digest: row.spec_digest, gen: 1, tree_digest: row.tree_digest, exit_code: 0 } },
    { predicate: 'eng.tree_step', args: { from_gen: 0, to_gen: 1 } },
  ]);
  const again = await f.call('test_v2', { check: 'unit' });
  assert.equal(again.rows[0].gen, 1); assert.equal(again.rows.at(-1).from_gen, -1);
  const edit = await f.call('write_file', { path: 'production.txt', expect_digest: '', text: 'changed' });
  assert.ok(edit.rows.some(r => r.from_gen === 1 && r.to_gen === 2));
});

test('named failures report their exit code, and cwd, shell and output_dirs are honored', async t => {
  const f = fixture(t);
  f.write('src/check.mjs', "import fs from 'node:fs'; fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/result', 'result'); process.exitCode = 7;\n");
  f.put({ command: [process.execPath, 'check.mjs'], cwd: 'src', shell: false,
    files: { 'src/check.mjs': sha(fs.readFileSync(path.join(f.root, 'src/check.mjs'))) }, output_dirs: ['src/out'] });
  await f.call('tree_state');
  const failed = await f.call('test_v2', { check: 'unit' });
  assert.equal(failed.rows[0].exit_code, 7); assert.equal(failed.rows[0].gen, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'src/out/result')), true);
  assert.equal(JSON.parse(fs.readFileSync(f.ctx.stateFile)).test_gen, undefined);
  // shell=true actually uses the system shell (redirection is a shell feature).
  fs.mkdirSync(path.join(f.root, 'shell-output'));
  f.put({ ...f.spec, command: ['echo', 'acceptance', '>', 'shell-output/result'], shell: true, output_dirs: ['shell-output'] });
  const shell = await f.call('test_v2', { check: 'unit' });
  assert.equal(shell.rows[0].exit_code, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'shell-output/result'), 'utf8'), /acceptance/);
});

test('a running check cannot change its frozen dependencies or replace its spec and return passing facts', async t => {
  const f = fixture(t);
  for (const [script, message] of [
    ["import fs from 'node:fs'; fs.appendFileSync('test.mjs', '// changed');", 'acceptance file changed: test.mjs'],
    ["import fs from 'node:fs'; fs.writeFileSync('.rulith/acceptance/unit.json', '{}');", 'acceptance spec invalid'],
    ["import fs from 'node:fs'; const p='.rulith/acceptance/unit.json'; const s=JSON.parse(fs.readFileSync(p)); s.shell=false; fs.writeFileSync(p,JSON.stringify(s));", 'acceptance spec changed'],
  ]) {
    f.write('test.mjs', script); f.put({ ...f.spec, files: { 'test.mjs': sha(script) } });
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message });
  }
});

test('test@2 process entry returns the check while the unchanged test@1 still runs its kit-home spec', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'specs/test.json'), JSON.stringify({ command: [process.execPath, 'test.mjs'] }));
  for (const [entry, args, id] of [['test_v2', { check: 'unit' }, 'eng.test@2'], ['test', {}, 'eng.test@1']]) {
    const out = f.cli(entry, args); assert.ifError(out.error); assert.equal(out.status, 0);
    const receipt = JSON.parse(out.stdout);
    assert.equal(receipt.rows[0].check, entry === 'test_v2' ? 'unit' : undefined);
    assert.equal(receipt.rows[0].exit_code, 0);
    assert.equal(resultFactsFromRows(tools[id], receipt.rows)[0].predicate, 'eng.test_result');
  }
});

test('acceptance lists valid and invalid specs without reading dependencies, tree state or Source lock', async t => {
  const f = fixture(t);
  f.put({ ...f.spec, files: { ...f.spec.files, 'another.mjs': 'a'.repeat(64) } }, 'a'); f.write('.rulith/acceptance/bad.json', '{');
  f.write('.rulith/acceptance/INVALID.json', '{}'); f.write('.rulith/acceptance/notes.txt', 'ignored');
  fs.unlinkSync(path.join(f.root, 'test.mjs')); // Listing does not verify dependency content or existence.
  save(`${f.ctx.stateFile}.lock`, { pid: process.pid, startedAt: new Date().toISOString() });
  save(f.ctx.jobFile, { status: 'running' });
  const readdir = fs.readdirSync, read = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (target, ...args) => {
    assert.equal(target, path.join(f.root, '.rulith/acceptance')); return readdir(target, ...args);
  });
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    assert.ok(String(target).startsWith(path.join(f.root, '.rulith/acceptance') + path.sep)); return read(target, ...args);
  });
  const out = await f.call('acceptance');
  assert.deepEqual(out.errors, [{ error: 'acceptance spec invalid' }, { error: 'acceptance spec invalid', check: 'bad' }]);
  assert.deepEqual(out.rows, [{ check: 'a', spec_digest: acceptanceSpec(f.ctx, 'a').digest, files: 2 },
    { check: 'unit', spec_digest: acceptanceSpec(f.ctx, 'unit').digest, files: 1 }]);
  assert.equal(resultFactsFromRows(tools['eng.acceptance@1'], out.rows).length, 2);
  assert.equal(fs.existsSync(f.ctx.stateFile), false);
  assert.equal(fs.existsSync(path.join(f.home, 'tree-cache.json')), false);
  await assert.rejects(f.call('acceptance', { check: 'unit' }), { message: 'acceptance takes no arguments' });
});

test('acceptance listing is empty without a directory and bounds whole rows within the inline receipt', async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, '.rulith/acceptance'), { recursive: true });
  assert.deepEqual(await f.call('acceptance'), { rows: [] });
  for (let i = 0; i < 80; i++) f.put(f.spec, `check-${i}`);
  const out = await f.call('acceptance');
  assert.equal(out.truncated, true); assert.ok(out.rows.length > 0 && out.rows.length < 80);
  assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), facts: resultFactsFromRows(tools['eng.acceptance@1'], out.rows) })) < 8192);
  assert.deepEqual(out.rows.map(r => r.check), out.rows.map(r => r.check).sort());
});

test('v2 native package has ordered criterion args, the freshness rule, a node-bound bridge and all four pins', () => {
  const program = JSON.parse(fs.readFileSync(path.join(repo, 'kits/general/pack/program-v2.json')));
  const sources = JSON.parse(fs.readFileSync(path.join(repo, 'kits/general/pack/sources-v2.json')));
  assert.equal(program.format, 'rulith-domain-program');
  assert.deepEqual(program.meta, { name: 'engineering_work', version: 2 });
  assert.equal(program.vocabulary, undefined);
  const vocab = new Map(program.vocab.map(v => [v.predicate, v.args]));
  assert.deepEqual(vocab.get('eng.check_passed'), ['check', 'spec_digest']);
  assert.equal(program.vocab.find(v => v.predicate === 'eng.check_passed').description, 'The named acceptance check passed on the current tree.');
  assert.deepEqual(vocab.get('eng.test_result'), ['check', 'spec_digest', 'gen', 'tree_digest', 'exit_code']);
  assert.deepEqual(vocab.get('eng.check_spec'), ['check', 'spec_digest', 'files']);
  for (const [id, tool] of Object.entries(tools)) if (id !== 'eng.test@1')
    for (const row of tool.returns) assert.deepEqual(vocab.get(row.predicate), Object.keys(row.args), id);
  assert.deepEqual(program.pins, ['eng.check_passed', 'eng.test_result', 'eng.tree_step', 'eng.check_spec']);
  assert.equal(program.axioms.length, 1);
  assert.equal(program.axioms[0].id, 'ENG_CHECK_PASSED');
  assert.equal(program.axioms[0].tier, 'verified');
  assert.deepEqual(program.axioms[0].when, [
    { predicate: 'eng.test_result', args: { check: '?c', spec_digest: '?d', gen: '?g', exit_code: 0 } },
    { predicate: 'eng.tree_step', args: { from_gen: '?g', to_gen: '?n' }, naf: true },
  ]);
  assert.deepEqual(program.axioms[0].then, [{ predicate: 'eng.check_passed', args: { check: '?c', spec_digest: '?d' } }]);
  assert.equal(program.acceptance.length, 1);
  assert.deepEqual(program.acceptance[0].when, [
    { predicate: 'acceptance', args: { node: '?n', test: '?c' } },
    { predicate: 'eng.check_passed', args: { check: '?c', spec_digest: '?d' } },
  ]);
  assert.deepEqual(program.acceptance[0].then, [{ predicate: 'acceptance_met', args: { node: '?n' } }]);
  assert.deepEqual(program.actions, []);
  assert.deepEqual(sources.meta, { name: 'engineering_work_sources', version: 2 });
  assert.equal(sources.sources[0].name, 'lab');
  assert.deepEqual(sources.sources[0].words, [...vocab.keys()]);
});

test('v1 entry and legacy package bytes stay frozen', () => {
  for (const [name, digest] of [
    ['test.mjs', 'e41ceeeb24eaaeae94cf46f1800d64ea5ba2f30f6e8c5e64325242423099ff25'],
    ['pack/program.json', 'c2f89403a4cca7444613ef74f2925c4caf6e47d0a930985f2fdb73bdbbbb8b36'],
    ['pack/sources.json', '107ba4be2c057c50d8815a5aa7375eb4ea938f90fcdd32251481981984aa9b1f'],
  ]) assert.equal(sha(fs.readFileSync(path.join(repo, 'kits/general', name))), digest, name);
});

test('the builder reproduces the exact native v2 JSON files and refuses incompatible signatures', () => {
  const generated = buildPackages({ tools });
  for (const [key, name] of [['program', 'program-v2.json'], ['sources', 'sources-v2.json']])
    assert.equal(JSON.stringify(generated[key], null, 2) + '\n', fs.readFileSync(path.join(repo, 'kits/general/pack', name), 'utf8'));
  assert.throws(() => buildPackages({ tools: { ...tools, 'bad.tool@1': { returns: [
    { predicate: 'eng.test_result', args: { changed: '$changed' } },
  ] } } }), /two argument lists/);
});
