import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { perform, main } from '../kits/general/adapter.mjs';
import { context, sha, save } from '../kits/general/lib.mjs';
import { acceptanceSpec, canonicalSpec, commandLine } from '../kits/general/acceptance-specs.mjs';
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
  // Spec commands pass eng.run's classifier: the absolute node path lies outside the project.
  const settings = (value = {}) => fs.writeFileSync(path.join(home, 'settings.json'),
    JSON.stringify({ allowedPaths: [path.dirname(process.execPath)], ...value }));
  settings();
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, ENG_KIT_HOME: home };
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  write('test.mjs', 'process.exitCode = 0;\n');
  const spec = { command: [process.execPath, 'test.mjs'], cwd: '.', files: { 'test.mjs': sha('process.exitCode = 0;\n') } };
  const put = (value = spec, check = 'unit') => write(`.rulith/acceptance/${check}.json`, JSON.stringify(value));
  put();
  const call = (tool, args = {}) => perform(tool, args, env);
  return { dir, root, home, env, ctx: context(env), write, spec, put, settings, call,
    tryCall: async (tool, args = {}) => { try { return await call(tool, args); } catch (error) { return { error: error.message }; } },
    cli: (entry, args = {}) => spawnSync(process.execPath, [path.join(repo, `kits/general/${entry}.mjs`), JSON.stringify(args)], { env, encoding: 'utf8', windowsHide: true }),
  };
}
// The package rule ENG_CHECK_PASSED over receipt facts: a passing check_result at g with no tree step leaving g.
const passing = facts => [...new Set(facts.filter(f => f.predicate === 'eng.check_result' && f.args.exit_code === 0
  && !facts.some(s => s.predicate === 'eng.tree_step' && s.args.from_gen === f.args.gen)).map(f => f.args.check))];
const factsOf = (id, out) => resultFactsFromRows(tools[id], out.rows ?? []);
// Reverse of commandLine: a token that starts with `"` is a JSON string, any other token is literal.
const parseLine = line => line.match(/"(?:[^"\\]|\\.)*"|\S+/g).map(token => token.startsWith('"') ? JSON.parse(token) : token);

test('acceptance digest hashes compact recursively sorted JSON with defaults written out', t => {
  const f = fixture(t);
  const a = acceptanceSpec(f.ctx, 'unit');
  const expected = `{"command":${JSON.stringify(f.spec.command)},"cwd":".","files":{"test.mjs":"${f.spec.files['test.mjs']}"},"output_dirs":[],"shell":false}`;
  assert.equal(a.digest, sha(Buffer.from(expected, 'utf8')));
  f.write('.rulith/acceptance/unit.json', JSON.stringify({ files: f.spec.files, cwd: '.', command: f.spec.command }, null, 4) + '\r\n');
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  f.put({ ...f.spec, files: { 'z.mjs': 'a'.repeat(64), 'test.mjs': f.spec.files['test.mjs'] } });
  const reordered = acceptanceSpec(f.ctx, 'unit').digest;
  f.put({ files: { 'test.mjs': f.spec.files['test.mjs'], 'z.mjs': 'a'.repeat(64) }, command: f.spec.command, cwd: '.' });
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, reordered);
  // Defaults are written out, so the digest is a function of the eng.check_spec fact.
  for (const same of [{ shell: false }, { output_dirs: [] }, { shell: false, output_dirs: [] }]) {
    f.put({ ...f.spec, ...same }); assert.equal(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  }
  for (const change of [{ command: [...f.spec.command, 'extra'] }, { shell: true }, { output_dirs: ['out'] }, { cwd: 'src' }, { files: { 'test.mjs': 'b'.repeat(64) } }]) {
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
    ...['.', '..', '/out', 'out/../src', '.rulith', '.rulith/acceptance', '.rulith/acceptance/unit.json', 'test.mjs']
      .map(dir => ({ ...f.spec, output_dirs: [dir] })),
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

test('check names start with a letter, so the Kernel keeps the leaf first argument as text', async t => {
  const f = fixture(t);
  for (const check of ['1', '0abc', '2024', '-x', '_x']) {
    f.put(f.spec, check);
    await assert.rejects(f.call('test_v2', { check }), { message: 'acceptance check invalid' });
  }
  const listed = await f.call('acceptance');
  assert.deepEqual(listed.rows.map(r => r.check), ['unit']);
  assert.equal(listed.errors.length, 5); // Listed as text-only rows: no fact, and no check name echoed.
  assert.ok(listed.errors.every(e => e.error === 'acceptance spec invalid' && e.check === undefined));
  f.put(f.spec, 'a0'); assert.ok(acceptanceSpec(f.ctx, 'a0').digest);
});

test('output_dirs are literal paths: wildcards in any component are refused', async t => {
  const f = fixture(t);
  for (const dir of ['**/acceptance', '**/tests', 'out*', 'a/?/b', '*', 'build/**']) {
    f.put({ ...f.spec, output_dirs: [dir] });
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance spec invalid' }, dir);
  }
});

test('a spec with a repeated key has two readings and is refused', async t => {
  const f = fixture(t);
  const body = JSON.stringify(f.spec).slice(1, -1);
  const digest = 'a'.repeat(64);
  for (const text of [`{${body},"cwd":"."}`, `{${body},"c\\u0077d":"."}`,
    `{${body.replace('"files":{', `"files":{"test.mjs":"${digest}",`)}}`]) {
    assert.doesNotThrow(() => JSON.parse(text));
    f.write('.rulith/acceptance/unit.json', text);
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance spec invalid' }, text);
  }
  // The same key in sibling objects and key-like text inside strings are fine.
  f.put({ ...f.spec, command: [process.execPath, 'test.mjs', '{"cwd":1,"cwd":2}'] });
  assert.ok(acceptanceSpec(f.ctx, 'unit').digest);
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

test('eng.check_spec carries everything the digest denotes, so the digest is recomputable from the fact', async t => {
  const f = fixture(t);
  f.write('tests/a b.mjs', 'x');
  const spec = { command: [process.execPath, 'test.mjs', '--name', 'two words', 'quote"d', ''], cwd: '.', shell: false,
    files: { 'tests/a b.mjs': sha('x'), 'test.mjs': f.spec.files['test.mjs'] }, output_dirs: ['out', 'tmp/cache'] };
  // An empty word is invalid in a spec; drop it from this fixture.
  spec.command.pop();
  f.put(spec);
  const out = await f.call('acceptance');
  const [fact] = factsOf('eng.acceptance@1', out);
  assert.equal(fact.predicate, 'eng.check_spec');
  assert.deepEqual(Object.keys(fact.args), ['check', 'spec_digest', 'command', 'cwd', 'shell', 'output_dirs', 'files']);
  assert.equal(fact.args.command, commandLine(spec.command));
  assert.match(fact.args.command, / --name "two words" "quote\\"d"$/);
  assert.deepEqual(JSON.parse(fact.args.files), [{ path: 'test.mjs', sha256: spec.files['test.mjs'] },
    { path: 'tests/a b.mjs', sha256: sha('x') }]);
  // Console renders this fact beside the proposed leaf: the person reads what the digest freezes.
  const rebuilt = { command: parseLine(fact.args.command), cwd: fact.args.cwd, shell: fact.args.shell,
    output_dirs: JSON.parse(fact.args.output_dirs),
    files: Object.fromEntries(JSON.parse(fact.args.files).map(file => [file.path, file.sha256])) };
  assert.deepEqual(rebuilt.command, spec.command);
  assert.equal(sha(canonicalSpec(rebuilt)), fact.args.spec_digest);
  assert.equal(fact.args.spec_digest, acceptanceSpec(f.ctx, 'unit').digest);
});

test('a spec over 32 files or over the inline receipt is listed as an error and cannot pass', async t => {
  const f = fixture(t);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`t${i}.mjs`, 'a'.repeat(64)]));
  f.put({ ...f.spec, files: many }, 'many');
  await assert.rejects(f.call('test_v2', { check: 'many' }), { message: 'acceptance spec invalid' });
  // 32 files with long paths fit the file limit but not one receipt row.
  const long = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`tests/${'x'.repeat(200)}-${i}.mjs`, sha('x')]));
  for (const name of Object.keys(long)) f.write(name, 'x');
  f.put({ ...f.spec, files: long }, 'large');
  await assert.rejects(f.call('test_v2', { check: 'large' }), { message: 'acceptance spec too large' });
  assert.equal(fs.existsSync(f.ctx.stateFile), false);
  const out = await f.call('acceptance');
  assert.deepEqual(out.errors, [{ error: 'acceptance spec too large', check: 'large' }, { error: 'acceptance spec invalid', check: 'many' }]);
  assert.deepEqual(factsOf('eng.acceptance@1', out).map(fact => fact.args.check), ['unit']);
  const cli = f.cli('test_v2', { check: 'large' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'acceptance spec too large');
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
  assert.deepEqual(await f.call('acceptance'), { rows: [], errors: [{ error: 'acceptance directory unreadable' }] });
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

test('a broken acceptance directory blocks no tree-walking tool and is reported by eng.acceptance', async t => {
  // Reviewer PoC 3: a file at .rulith/acceptance used to make every tree walk, including its repair, fail.
  const f = fixture(t);
  fs.rmSync(path.join(f.root, '.rulith/acceptance'), { recursive: true });
  const created = await f.call('write_file', { path: '.rulith/acceptance', expect_digest: '', text: 'x' });
  assert.equal(created.rows[0].path, '.rulith/acceptance');
  assert.ok(fs.statSync(path.join(f.root, '.rulith/acceptance')).isFile());
  assert.equal((await f.call('tree_state')).rows[0].gen, 1);
  assert.equal((await f.call('read', { path: 'test.mjs' })).rows[0].path, 'test.mjs');
  assert.equal((await f.call('write_file', { path: 'repair.txt', expect_digest: '', text: 'y' })).rows[0].path, 'repair.txt');
  assert.equal((await f.call('run', { command: 'node --version' })).rows[0].exit_code, 0);
  assert.deepEqual(await f.call('acceptance'), { rows: [], errors: [{ error: 'acceptance directory unreadable' }] });
  await assert.rejects(f.call('test_v2', { check: 'unit' }), { message: 'acceptance spec invalid' });
});

test('a project spec output_dirs never hides changes from other tools (reviewer PoC 1 and 4)', async t => {
  const f = fixture(t);
  // PoC 1: an unsigned spec whose only purpose is output_dirs ["src"] must not hide the code under test.
  f.write('src/value.mjs', 'export const VALUE = 0;\n');
  const ta = "import { VALUE } from './src/value.mjs'; process.exitCode = VALUE === 1 ? 0 : 1;\n";
  const tb = "import { VALUE } from './src/value.mjs'; process.exitCode = VALUE === 2 ? 0 : 1;\n";
  f.write('ta.mjs', ta); f.write('tb.mjs', tb);
  f.put({ command: [process.execPath, 'ta.mjs'], cwd: '.', files: { 'ta.mjs': sha(ta) } }, 'a');
  f.put({ command: [process.execPath, 'tb.mjs'], cwd: '.', files: { 'tb.mjs': sha(tb) } }, 'b');
  const facts = [];
  const record = (id, out) => { facts.push(...factsOf(id, out)); return out; };
  record('eng.tree_state@1', await f.call('tree_state'));
  record('eng.write_file@1', await f.call('write_file', { path: '.rulith/acceptance/zz-hide.json', expect_digest: '',
    text: JSON.stringify({ command: [process.execPath, '--version'], cwd: '.', files: {}, output_dirs: ['src'] }) }));
  record('eng.write_file@1', await f.call('write_file', { path: 'src/value.mjs', expect_digest: sha('export const VALUE = 0;\n'), text: 'export const VALUE = 1;\n' }));
  record('eng.test@2', await f.call('test_v2', { check: 'a' }));
  record('eng.write_file@1', await f.call('write_file', { path: 'src/value.mjs', expect_digest: sha('export const VALUE = 1;\n'), text: 'export const VALUE = 2;\n' }));
  record('eng.test@2', await f.call('test_v2', { check: 'b' }));
  // Only b holds on the current tree: the write that made b pass left a's generation.
  assert.deepEqual(passing(facts), ['b']);
  // PoC 4 (shape now refused, see the wildcard test): a plain output dir of one spec hides nothing from tree_state.
  f.write('tests/a.mjs', 'first');
  f.put({ ...f.spec, output_dirs: ['tests', '.rulith-out'] }, 'c');
  const t0 = (await f.call('tree_state')).rows[0];
  f.write('tests/a.mjs', 'second');
  const t1 = (await f.call('tree_state')).rows[0];
  assert.equal(t1.gen, t0.gen + 1); assert.notEqual(t1.tree_digest, t0.tree_digest);
  f.put({ command: ['anything-else'], cwd: '.', files: {} }, 'a');
  assert.equal((await f.call('tree_state')).rows[0].gen, t1.gen + 1);
});

test('a check output_dirs cover only its own run: generation kept, post-run digest saved, later edits seen', async t => {
  const f = fixture(t);
  const script = "import fs from 'node:fs'; fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/result', String(Date.now()));\n";
  f.write('test.mjs', script);
  f.put({ ...f.spec, files: { 'test.mjs': sha(script) }, output_dirs: ['out'] });
  assert.equal((await f.call('tree_state')).rows[0].gen, 0);
  const run = await f.call('test_v2', { check: 'unit' });
  assert.equal(run.rows[0].gen, 0); assert.deepEqual([run.rows[0].from_gen, run.rows[0].to_gen], [-1, -1]);
  assert.ok(fs.existsSync(path.join(f.root, 'out/result')));
  const seen = (await f.call('tree_state')).rows[0];
  assert.deepEqual([seen.gen, seen.tree_digest], [0, run.rows[0].tree_digest]);
  // Every other tool hashes the directory: a write there is a step that leaves the passing generation.
  const edit = await f.call('write_file', { path: 'out/other', expect_digest: '', text: 'x' });
  assert.ok(edit.rows.some(r => r.from_gen === 0 && r.to_gen === 1));
  // A run that also writes outside its output_dirs is a step and stamps the final generation.
  const wide = "import fs from 'node:fs'; fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/result', 'r'); fs.writeFileSync('elsewhere', String(Date.now()));\n";
  f.write('test.mjs', wide);
  f.put({ ...f.spec, files: { 'test.mjs': sha(wide) }, output_dirs: ['out'] });
  const before = (await f.call('tree_state')).rows[0].gen;
  const widened = await f.call('test_v2', { check: 'unit' });
  assert.equal(widened.rows[0].gen, before + 1);
  // A change made before the run is a step even when the run itself writes only its output.
  f.write('test.mjs', script); f.put({ ...f.spec, files: { 'test.mjs': sha(script) }, output_dirs: ['out'] });
  const start = (await f.call('tree_state')).rows[0].gen;
  f.write('unseen.txt', 'changed outside the kit');
  const after = await f.call('test_v2', { check: 'unit' });
  assert.equal(after.rows[0].gen, start + 1); assert.ok(after.rows.some(r => r.from_gen === start && r.to_gen === start + 1));
});

test('spec commands pass the eng.run classifier and cannot widen the owner shell setting (reviewer PoC 2)', async t => {
  const f = fixture(t);
  f.settings({ shell: false });
  const outside = path.join(f.dir, 'outside.txt');
  const code = `require('fs').writeFileSync(${JSON.stringify(outside)}, 'written outside the project')`;
  const refusedRun = await f.tryCall('run', { command: `node -e "${code.replaceAll('"', '\\"')}"` });
  assert.equal(refusedRun.error, 'command refused');
  for (const command of [[process.execPath, '-e', code], ['node', '--eval', code], ['python', '-c', 'print(1)'],
    ['cmd', '/c', 'echo hi'], ['git', 'push'], ['npm', 'publish'], ['sudo', 'node'], ['npm', 'install', '-g', 'x'],
    ['node', 'test.mjs', '|', 'findstr', 'x'], ['node', 'test.mjs', '>', 'out.txt']]) {
    f.put({ ...f.spec, command });
    assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'command refused', command.join(' '));
  }
  assert.equal(fs.existsSync(outside), false);
  // Absolute paths outside the project need the owner's allowedPaths, as for eng.run.
  f.settings({ allowedPaths: [] });
  f.put(f.spec);
  assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'path refused');
  f.settings();
  f.put({ ...f.spec, command: ['echo', 'piped', '|', 'findstr', 'piped', '>', 'shell-out.txt'], shell: true });
  assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'acceptance shell refused');
  assert.equal(fs.existsSync(path.join(f.root, 'shell-out.txt')), false);
  const cli = f.cli('test_v2', { check: 'unit' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'acceptance shell refused');
  // The owner's shell setting enables it; push/publish stay refused even then.
  f.settings({ shell: true });
  fs.mkdirSync(path.join(f.root, 'shell-output'));
  f.put({ ...f.spec, command: ['echo', 'acceptance', '>', 'shell-output/result'], shell: true, output_dirs: ['shell-output'] });
  assert.equal((await f.call('test_v2', { check: 'unit' })).rows[0].exit_code, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'shell-output/result'), 'utf8'), /acceptance/);
  f.put({ ...f.spec, command: ['git', 'push'], shell: true });
  assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'command refused');
  // Without shell in the spec, the owner's shell setting does not route the spec command through a shell.
  f.put({ ...f.spec, command: [process.execPath, 'test.mjs', '>', 'not-redirected'] });
  assert.equal((await f.call('test_v2', { check: 'unit' })).rows[0].exit_code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'not-redirected')), false);
});

test('test@2 receipts land eng.check_result with the final tree generation; later writes invalidate it', async t => {
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
  assert.deepEqual(factsOf('eng.test@2', out), [
    { predicate: 'eng.check_result', args: { check: 'unit', spec_digest: row.spec_digest, gen: 1, tree_digest: row.tree_digest, exit_code: 0 } },
    { predicate: 'eng.tree_step', args: { from_gen: 0, to_gen: 1 } },
  ]);
  const again = await f.call('test_v2', { check: 'unit' });
  assert.equal(again.rows[0].gen, 1); assert.equal(again.rows.at(-1).from_gen, -1);
  const edit = await f.call('write_file', { path: 'production.txt', expect_digest: '', text: 'changed' });
  assert.ok(edit.rows.some(r => r.from_gen === 1 && r.to_gen === 2));
});

test('named failures report their exit code and honor cwd', async t => {
  const f = fixture(t);
  f.write('src/check.mjs', "process.exitCode = 7;\n");
  f.put({ command: [process.execPath, 'check.mjs'], cwd: 'src', shell: false,
    files: { 'src/check.mjs': sha(fs.readFileSync(path.join(f.root, 'src/check.mjs'))) } });
  await f.call('tree_state');
  const failed = await f.call('test_v2', { check: 'unit' });
  assert.equal(failed.rows[0].exit_code, 7); assert.equal(failed.rows[0].gen, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.ctx.stateFile)).test_gen, undefined);
  assert.deepEqual(passing(factsOf('eng.test@2', failed)), []);
});

test('a running check cannot change its frozen dependencies or replace its spec and return passing facts', async t => {
  const f = fixture(t);
  for (const [script, message] of [
    ["import fs from 'node:fs'; fs.appendFileSync('test.mjs', '// changed');", 'acceptance file changed: test.mjs'],
    ["import fs from 'node:fs'; fs.writeFileSync('.rulith/acceptance/unit.json', '{}');", 'acceptance spec invalid'],
    ["import fs from 'node:fs'; const p='.rulith/acceptance/unit.json'; const s=JSON.parse(fs.readFileSync(p)); s.output_dirs=['x']; fs.writeFileSync(p,JSON.stringify(s));", 'acceptance spec changed'],
  ]) {
    f.write('test.mjs', script); f.put({ ...f.spec, files: { 'test.mjs': sha(script) } });
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message });
  }
});

test('test@2 process entry returns eng.check_result while the unchanged test@1 still returns its 4-argument eng.test_result', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'specs/test.json'), JSON.stringify({ command: [process.execPath, 'test.mjs'] }));
  for (const [entry, args, id, predicate] of [['test_v2', { check: 'unit' }, 'eng.test@2', 'eng.check_result'], ['test', {}, 'eng.test@1', 'eng.test_result']]) {
    const out = f.cli(entry, args); assert.ifError(out.error); assert.equal(out.status, 0, out.stderr);
    const receipt = JSON.parse(out.stdout);
    assert.equal(receipt.rows[0].check, entry === 'test_v2' ? 'unit' : undefined);
    assert.equal(receipt.rows[0].exit_code, 0);
    const [fact] = resultFactsFromRows(tools[id], receipt.rows);
    assert.equal(fact.predicate, predicate);
    assert.deepEqual(Object.keys(fact.args), predicate === 'eng.test_result'
      ? ['spec_digest', 'gen', 'tree_digest', 'exit_code'] : ['check', 'spec_digest', 'gen', 'tree_digest', 'exit_code']);
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
  assert.deepEqual(out.rows.map(r => [r.check, r.spec_digest, JSON.parse(r.files).length]), [
    ['a', acceptanceSpec(f.ctx, 'a').digest, 2], ['unit', acceptanceSpec(f.ctx, 'unit').digest, 1]]);
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
  assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), reason: '', facts: resultFactsFromRows(tools['eng.acceptance@1'], out.rows) })) <= 7168);
  assert.deepEqual(out.rows.map(r => r.check), out.rows.map(r => r.check).sort());
});

// The Gateway installs only the authoring format: AuthorPackage.parse -> DomainAuthoringCompiler
// (rulith-java gateway/src/main/java/ai/rulith/gateway/authoring). These are its field and symbol rules.
const SYSTEM_IMPORTS = new Set(['acceptance', 'acceptance_met']);
function authoringErrors(program) {
  const errors = [];
  const only = (value, keys, at) => Object.keys(value ?? {}).forEach(key => { if (!keys.includes(key)) errors.push(`${at} has ${key}`); });
  only(program, ['id', 'title', 'summary', 'judges', 'vocabulary', 'rules', 'pins', 'actions', 'acceptance'], 'package');
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(program.id)) errors.push('id');
  if (typeof program.title !== 'string' || !program.title.trim()) errors.push('title');
  only(program.vocabulary, ['defines', 'imports'], 'vocabulary');
  const symbols = new Map(), namespaces = new Set();
  for (const row of program.vocabulary.defines) {
    only(row, ['id', 'as', 'args'], 'defines');
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(row.id)) errors.push(`canonical ${row.id}`);
    if (!Array.isArray(row.args) || row.args.some(a => typeof a !== 'string')) errors.push(`args ${row.id}`);
    namespaces.add(row.id.slice(0, row.id.lastIndexOf('.')));
    const alias = row.as ?? row.id.slice(row.id.lastIndexOf('.') + 1);
    if (!/^[a-z][a-z0-9_]*$/.test(alias) || symbols.has(alias)) errors.push(`alias ${alias}`);
    symbols.set(alias, { id: row.id, defined: true, args: row.args });
  }
  if (namespaces.size !== 1) errors.push(`namespaces ${[...namespaces]}`);
  for (const row of program.vocabulary.imports) {
    only(row, ['id', 'as'], 'imports');
    if (!SYSTEM_IMPORTS.has(row.id)) errors.push(`import ${row.id}`);
    symbols.set(row.as ?? row.id, { id: row.id, defined: false });
  }
  const pins = new Set();
  for (const pin of program.pins) {
    if (!symbols.get(pin)?.defined) errors.push(`pin ${pin}`);
    if (pins.has(pin)) errors.push(`pin repeated ${pin}`); pins.add(pin);
  }
  const variable = value => typeof value === 'string' && /^\?[A-Za-z0-9_]+$/.test(value);
  for (const section of ['rules', 'acceptance']) program[section].forEach((rule, i) => {
    const at = `${section}[${i}]`;
    only(rule, ['id', 'label', 'when', 'then'], at);
    if (!rule.id || !rule.label) errors.push(`${at} id/label`);
    const bound = new Set();
    for (const [field, head] of [['when', false], ['then', true]]) {
      if (!Array.isArray(rule[field]) || !rule[field].length) errors.push(`${at}.${field}`);
      for (const atom of rule[field]) {
        only(atom, ['predicate', 'args', 'naf', 'negated'], `${at}.${field}`);
        const symbol = symbols.get(atom.predicate);
        if (!symbol) errors.push(`${at} unknown ${atom.predicate}`);
        else if (head && section === 'rules' && !symbol.defined) errors.push(`${at} writes import ${atom.predicate}`);
        if (atom.naf !== undefined && atom.naf !== true) errors.push(`${at} naf`);
        if (head && atom.naf) errors.push(`${at} naf head`);
        if (symbol?.args && Object.keys(atom.args).some(name => !symbol.args.includes(name))) errors.push(`${at} args ${atom.predicate}`);
        for (const value of Object.values(atom.args)) {
          if (!['string', 'number', 'boolean'].includes(typeof value)) errors.push(`${at} scalar`);
          if (!head && !atom.naf && variable(value)) bound.add(value);
          if (head && variable(value) && !bound.has(value)) errors.push(`${at} unbound ${value}`);
        }
      }
    }
  });
  if (program.actions.length) errors.push('actions');
  return errors;
}

test('v2 is an authoring-format package the Gateway installs: criterion, freshness rule, node-bound bridge, four pins', () => {
  const program = JSON.parse(fs.readFileSync(path.join(repo, 'kits/general/pack/program-v2.json')));
  const sources = JSON.parse(fs.readFileSync(path.join(repo, 'kits/general/pack/sources-v3.json')));
  assert.deepEqual(authoringErrors(program), []);
  assert.equal(program.format, undefined); assert.equal(program.meta, undefined); assert.equal(program.vocab, undefined);
  assert.equal(program.id, 'engineering_work');
  const defines = new Map(program.vocabulary.defines.map(d => [d.id, d]));
  assert.deepEqual(defines.get('eng.check_passed').args, ['check', 'spec_digest']);
  assert.deepEqual(defines.get('eng.check_result').args, ['check', 'spec_digest', 'gen', 'tree_digest', 'exit_code']);
  // eng.test@1's predicate keeps its four arguments: a legacy call on a v2 Board has no vocabulary clash.
  assert.deepEqual(defines.get('eng.test_result').args, ['spec_digest', 'gen', 'tree_digest', 'exit_code']);
  assert.deepEqual(defines.get('eng.check_spec').args, ['check', 'spec_digest', 'command', 'cwd', 'shell', 'output_dirs', 'files']);
  for (const [id, tool] of Object.entries(tools)) for (const row of tool.returns) {
    if (row.predicate.startsWith('web.')) { assert.equal(defines.has(row.predicate), false); continue; }
    assert.deepEqual(defines.get(row.predicate).args, Object.keys(row.args), id);
  }
  const alias = id => defines.get(id).as;
  assert.deepEqual(program.pins, ['eng.check_passed', 'eng.check_result', 'eng.check_spec', 'eng.tree_step'].map(alias));
  assert.deepEqual(program.rules, [{ id: 'ENG_CHECK_PASSED', label: program.rules[0].label,
    when: [{ predicate: alias('eng.check_result'), args: { check: '?c', spec_digest: '?d', gen: '?g', exit_code: 0 } },
      { predicate: alias('eng.tree_step'), args: { from_gen: '?g', to_gen: '?n' }, naf: true }],
    then: [{ predicate: alias('eng.check_passed'), args: { check: '?c', spec_digest: '?d' } }] }]);
  assert.deepEqual(program.acceptance, [{ id: 'ENG_CHECK_ACCEPTANCE', label: program.acceptance[0].label,
    when: [{ predicate: 'acceptance', args: { node: '?n', test: '?c' } },
      { predicate: alias('eng.check_passed'), args: { check: '?c', spec_digest: '?d' } }],
    then: [{ predicate: 'acceptance_met', args: { node: '?n' } }] }]);
  assert.deepEqual(program.actions, []);
  assert.deepEqual(sources.meta, { name: 'engineering_work_sources', version: 3 });
  assert.equal(sources.sources[0].name, 'lab');
  const receiptWords = [...new Set(Object.values(tools).flatMap(tool => tool.returns.map(row => row.predicate)))].sort();
  assert.deepEqual(sources.sources[0].words, receiptWords);
  assert.equal(sources.sources[0].words.includes('eng.check_passed'), false);
  for (const word of ['eng.check_result', 'eng.check_spec', 'web.page', 'web.search']) assert.ok(sources.sources[0].words.includes(word));
  // The former native shape and a second namespace are what the compiler refuses.
  assert.notDeepEqual(authoringErrors({ ...program, vocabulary: { ...program.vocabulary,
    defines: [...program.vocabulary.defines, { id: 'web.page', as: 'web_page', args: ['url'] }] } }), []);
});

test('the Gateway authoring compiler accepts program-v2.json (skipped without its jar and Java 25)', t => {
  const jar = process.env.RULITH_AUTHORING_JAR
    ?? fileURLToPath(new URL('../../rulith-java/gateway/target/gateway-0.1.0-SNAPSHOT-authoring.jar', import.meta.url));
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'C:/Program Files/Java/jdk-25/bin/java';
  if (!fs.existsSync(jar) || !(fs.existsSync(java) || fs.existsSync(`${java}.exe`))) return t.skip('authoring jar or Java 25 not found');
  const run = spawnSync(java, ['-jar', jar, path.join(repo, 'kits/general/pack/program-v2.json')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.errors, []); assert.equal(result.valid, true);
  const native = result.program.packs[0].pack;
  assert.equal(native.format, 'rulith-domain-program'); assert.equal(native.meta.name, 'engineering_work');
  assert.deepEqual(native.pins, ['eng.check_passed', 'eng.check_result', 'eng.check_spec', 'eng.tree_step']);
  assert.deepEqual(native.vocab.find(v => v.predicate === 'eng.check_passed').args, ['check', 'spec_digest']);
  assert.deepEqual(native.axioms[0].when[1], { predicate: 'eng.tree_step', args: { from_gen: '?g', to_gen: '?n' }, naf: true });
  assert.deepEqual(native.acceptance[0].when[1].predicate, 'eng.check_passed');
});

test('v1 entry and legacy package bytes stay frozen', () => {
  for (const [name, digest] of [
    ['test.mjs', 'e41ceeeb24eaaeae94cf46f1800d64ea5ba2f30f6e8c5e64325242423099ff25'],
    ['pack/program.json', 'c2f89403a4cca7444613ef74f2925c4caf6e47d0a930985f2fdb73bdbbbb8b36'],
    ['pack/sources.json', '107ba4be2c057c50d8815a5aa7375eb4ea938f90fcdd32251481981984aa9b1f'],
  ]) assert.equal(sha(fs.readFileSync(path.join(repo, 'kits/general', name))), digest, name);
});

test('the builder reproduces the exact v2 package files and refuses incompatible signatures', () => {
  const generated = buildPackages({ tools });
  for (const [key, name] of [['program', 'program-v2.json'], ['sources', 'sources-v3.json']])
    assert.equal(JSON.stringify(generated[key], null, 2) + '\n', fs.readFileSync(path.join(repo, 'kits/general/pack', name), 'utf8'));
  assert.throws(() => buildPackages({ tools: { ...tools, 'bad.tool@1': { returns: [
    { predicate: 'eng.check_result', args: { changed: '$changed' } },
  ] } } }), /two argument lists/);
  assert.throws(() => buildPackages({ tools: { ...tools, 'bad.tool@1': { returns: [
    { predicate: 'acme.other', args: { x: '$x' } },
  ] } } }), /outside eng and web/);
});
