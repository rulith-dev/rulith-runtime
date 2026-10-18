import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { perform, main } from '../kits/general/adapter.mjs';
import { context, sha, save, classify, exclusions, tree, fileDigest } from '../kits/general/lib.mjs';
import { acceptanceSpec, canonicalSpec, commandLine } from '../kits/general/acceptance-specs.mjs';
import { buildPackages, PROJECT_TOOLS } from '../kits/general/pack/build-pack.mjs';
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

test('acceptance digest hashes compact recursively sorted JSON with its default written out', t => {
  const f = fixture(t);
  const a = acceptanceSpec(f.ctx, 'unit');
  const expected = `{"command":${JSON.stringify(f.spec.command)},"cwd":".","files":{"test.mjs":"${f.spec.files['test.mjs']}"},"shell":false}`;
  assert.equal(a.digest, sha(Buffer.from(expected, 'utf8')));
  f.write('.rulith/acceptance/unit.json', JSON.stringify({ files: f.spec.files, cwd: '.', command: f.spec.command }, null, 4) + '\r\n');
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  f.put({ ...f.spec, files: { 'z.mjs': 'a'.repeat(64), 'test.mjs': f.spec.files['test.mjs'] } });
  const reordered = acceptanceSpec(f.ctx, 'unit').digest;
  f.put({ files: { 'test.mjs': f.spec.files['test.mjs'], 'z.mjs': 'a'.repeat(64) }, command: f.spec.command, cwd: '.' });
  assert.equal(acceptanceSpec(f.ctx, 'unit').digest, reordered);
  // Defaults are written out, so the digest is a function of the eng.check_spec fact.
  for (const same of [{ shell: false }]) {
    f.put({ ...f.spec, ...same }); assert.equal(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  }
  for (const change of [{ command: [...f.spec.command, 'extra'] }, { shell: true, command: 'node test.mjs' }, { cwd: 'src' }, { files: { 'test.mjs': 'b'.repeat(64) } }]) {
    f.put({ ...f.spec, ...change }); assert.notEqual(acceptanceSpec(f.ctx, 'unit').digest, a.digest);
  }
});

test('files may be written as the eng.check_spec array: one digest for both spellings (live run 2026-10-16)', async t => {
  const f = fixture(t);
  f.write('tests/acceptance/runner.mjs', 'process.exitCode = 0;\n');
  const files = { 'tests/acceptance/runner.mjs': sha('process.exitCode = 0;\n'), 'test.mjs': f.spec.files['test.mjs'] };
  const command = [process.execPath, 'tests/acceptance/runner.mjs'];
  // The spec as the model wrote it: mirroring the receipt's files array, plus two fields a spec does not have.
  const array = Object.keys(files).map(name => ({ path: name, sha256: files[name] }));
  f.put({ check: 'stock-cli', command, cwd: '.', files: array, expect_exit: 0 }, 'stock-cli');
  const unknown = 'acceptance spec invalid: unknown field check';
  await assert.rejects(f.call('test_v2', { check: 'stock-cli' }), { message: unknown });
  assert.deepEqual((await f.call('acceptance')).errors, [{ error: unknown, check: 'stock-cli' }]);
  const cli = f.cli('test_v2', { check: 'stock-cli' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, unknown);
  f.put({ command, cwd: '.', files: array, expect_exit: 0 }, 'stock-cli');
  assert.deepEqual(JSON.parse(f.cli('acceptance').stdout).errors,
    [{ error: 'acceptance spec invalid: unknown field expect_exit', check: 'stock-cli' }]);
  // Without the extra fields the array spelling is valid and denotes exactly the object spelling.
  f.put({ command, cwd: '.', files: array }, 'stock-cli');
  const fromArray = acceptanceSpec(f.ctx, 'stock-cli');
  const rowArray = (await f.call('acceptance')).rows.find(r => r.check === 'stock-cli');
  f.put({ command, cwd: '.', files }, 'stock-cli');
  const fromObject = acceptanceSpec(f.ctx, 'stock-cli');
  assert.equal(fromArray.digest, fromObject.digest);
  assert.deepEqual(fromArray.spec, fromObject.spec);
  assert.deepEqual(Object.keys(fromArray.spec.files), ['test.mjs', 'tests/acceptance/runner.mjs']);
  assert.deepEqual((await f.call('acceptance')).rows.find(r => r.check === 'stock-cli'), rowArray);
  // Array order does not matter either, and the check runs.
  f.put({ command, cwd: '.', files: [...array].reverse() }, 'stock-cli');
  assert.equal(acceptanceSpec(f.ctx, 'stock-cli').digest, fromObject.digest);
  const out = await f.call('test_v2', { check: 'stock-cli' });
  assert.equal(out.rows[0].exit_code, 0); assert.equal(out.rows[0].spec_digest, fromObject.digest);
});

test('acceptance spec validation refuses malformed fields and paths, naming the problem in fixed words', async t => {
  const f = fixture(t);
  const COMMAND = 'acceptance spec invalid: command must be an array of words (or one string with shell:true)';
  const FILES = 'acceptance spec invalid: files must map each path to its sha256';
  for (const [spec, message] of [
    [null, 'acceptance spec invalid'], [[], 'acceptance spec invalid'], [{}, COMMAND],
    [{ ...f.spec, extra: 1 }, 'acceptance spec invalid: unknown field extra'],
    [{ ...f.spec, 'a b': 1 }, 'acceptance spec invalid'], // a name unsafe to echo falls back to the bare verdict
    [{ ...f.spec, command: [] }, COMMAND], [{ ...f.spec, command: [''] }, COMMAND], [{ ...f.spec, command: ['x\0'] }, COMMAND],
    [{ ...f.spec, command: 'node test.mjs' }, COMMAND],
    [{ ...f.spec, cwd: undefined }, 'acceptance spec invalid: cwd'], [{ ...f.spec, cwd: '../outside' }, 'acceptance spec invalid: cwd'],
    [{ ...f.spec, shell: 'true' }, 'acceptance spec invalid'],
    [{ ...f.spec, files: undefined }, FILES], [{ ...f.spec, files: null }, FILES], [{ ...f.spec, files: 'test.mjs' }, FILES],
    [{ ...f.spec, files: { '/absolute': 'a'.repeat(64) } }, 'acceptance spec invalid: files'],
    [{ ...f.spec, files: { '../escape': 'a'.repeat(64) } }, 'acceptance spec invalid: files'],
    [{ ...f.spec, files: { 'C:/escape': 'a'.repeat(64) } }, 'acceptance spec invalid: files'],
    [{ ...f.spec, files: { 'a\\b': 'a'.repeat(64) } }, 'acceptance spec invalid: files'],
    [{ ...f.spec, files: { './test.mjs': 'a'.repeat(64) } }, 'acceptance spec invalid: files'],
    [{ ...f.spec, files: { 'test.mjs': 'A'.repeat(64) } }, FILES], [{ ...f.spec, files: { 'test.mjs': 123 } }, FILES],
    // The array spelling: exactly {path, sha256} per item, each path once.
    [{ ...f.spec, files: ['test.mjs'] }, FILES], [{ ...f.spec, files: [{ path: 'test.mjs' }] }, FILES],
    [{ ...f.spec, files: [{ path: 'test.mjs', sha256: 'a'.repeat(64), size: 1 }] }, FILES],
    [{ ...f.spec, files: [{ path: 1, sha256: 'a'.repeat(64) }] }, FILES],
    [{ ...f.spec, files: [{ path: 'test.mjs', sha256: 'a'.repeat(64) }, { path: 'test.mjs', sha256: 'a'.repeat(64) }] }, FILES],
    [{ ...f.spec, files: [{ path: '../escape', sha256: 'a'.repeat(64) }] }, 'acceptance spec invalid: files'],
    // With shell the command is one string; without it, an argv array.
    [{ ...f.spec, shell: true }, COMMAND], [{ ...f.spec, shell: true, command: '' }, COMMAND],
    [{ ...f.spec, shell: true, command: ['node test.mjs'] }, COMMAND],
  ]) {
    f.put(spec);
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message }, JSON.stringify(spec));
    assert.deepEqual((await f.call('acceptance')).errors, [{ error: message, check: 'unit' }], JSON.stringify(spec));
  }
  for (const [text, message] of [['{', 'acceptance spec invalid: not JSON'], ['\uFEFF{}', 'acceptance spec invalid: not JSON'],
    [' '.repeat(16385) + '{}', 'acceptance spec invalid']]) {
    f.write('.rulith/acceptance/unit.json', text);
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message });
  }
  f.write('.rulith/acceptance/unit.json', Buffer.concat([
    Buffer.from('{"command":["node","'), Buffer.from([0xff]), Buffer.from('"],"cwd":".","files":{}}'),
  ]));
  assert.throws(() => acceptanceSpec(f.ctx, 'unit'), { message: 'acceptance spec invalid: not JSON' });
  // An empty dependency list is one meaning in either spelling.
  f.put({ ...f.spec, files: {} }); const empty = acceptanceSpec(f.ctx, 'unit').digest;
  f.put({ ...f.spec, files: [] }); assert.equal(acceptanceSpec(f.ctx, 'unit').digest, empty);
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

test('a spec has no output_dirs: any value, even an empty list, makes it invalid (review 2 P1)', async t => {
  const f = fixture(t);
  for (const dirs of [[], ['out'], ['src'], ['**/acceptance']]) {
    f.put({ ...f.spec, output_dirs: dirs });
    const message = 'acceptance spec invalid: unknown field output_dirs';
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message }, JSON.stringify(dirs));
    assert.deepEqual(await f.call('acceptance'), { rows: [], errors: [{ error: message, check: 'unit' }] });
  }
  assert.equal(fs.existsSync(f.ctx.stateFile), false);
});

test('a spec with a repeated key has two readings and is refused', async t => {
  const f = fixture(t);
  const body = JSON.stringify(f.spec).slice(1, -1);
  const digest = 'a'.repeat(64);
  for (const [text, key] of [[`{${body},"cwd":"."}`, 'cwd'], [`{${body},"c\\u0077d":"."}`, 'cwd'],
    [`{${body.replace('"files":{', `"files":{"test.mjs":"${digest}",`)}}`, 'test.mjs'], [`{${body},"a b":1,"a b":2}`, undefined]]) {
    assert.doesNotThrow(() => JSON.parse(text));
    f.write('.rulith/acceptance/unit.json', text);
    const message = key ? `acceptance spec invalid: duplicate key ${key}` : 'acceptance spec invalid';
    await assert.rejects(f.call('test_v2', { check: 'unit' }), { message }, text);
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
    files: { 'tests/a b.mjs': sha('x'), 'test.mjs': f.spec.files['test.mjs'] } };
  // An empty word is invalid in a spec; drop it from this fixture.
  spec.command.pop();
  f.put(spec);
  const out = await f.call('acceptance');
  const [fact] = factsOf('eng.acceptance@1', out);
  assert.equal(fact.predicate, 'eng.check_spec');
  assert.deepEqual(Object.keys(fact.args), ['check', 'spec_digest', 'command', 'cwd', 'shell', 'files']);
  assert.equal(fact.args.command, commandLine(spec.command));
  assert.match(fact.args.command, / --name "two words" "quote\\"d"$/);
  assert.deepEqual(JSON.parse(fact.args.files), [{ path: 'test.mjs', sha256: spec.files['test.mjs'] },
    { path: 'tests/a b.mjs', sha256: sha('x') }]);
  // Console renders this fact beside the proposed leaf: the person reads what the digest freezes.
  const rebuilt = { command: parseLine(fact.args.command), cwd: fact.args.cwd, shell: fact.args.shell,
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

test('a check run that rewrites code is a step: a signed check stops passing (review 2 PoC p1-absorb)', async t => {
  const f = fixture(t);
  f.write('src/value.mjs', 'export const VALUE = 1;\n');
  const ta = "import { VALUE } from './src/value.mjs'; process.exitCode = VALUE === 1 ? 0 : 1;\n";
  f.write('ta.mjs', ta);
  f.put({ command: [process.execPath, 'ta.mjs'], cwd: '.', files: { 'ta.mjs': sha(ta) } }, 'a');
  const facts = [];
  const record = (id, out) => { facts.push(...factsOf(id, out)); return out; };
  record('eng.tree_state@1', await f.call('tree_state'));
  record('eng.test@2', await f.call('test_v2', { check: 'a' }));
  assert.deepEqual(passing(facts), ['a']); // The signed check passes on the current tree.
  // The model writes a rewriting script and an unsigned spec for it (both visible steps), then re-runs a.
  const rw = "require('fs').writeFileSync('src/value.mjs', 'export const VALUE = 666;');";
  record('eng.write_file@1', await f.call('write_file', { path: 'rw.cjs', expect_digest: '', text: rw }));
  // The former output_dirs ["src"] is refused; the same spec without it is valid and its run is an ordinary step.
  const gen = { command: [process.execPath, 'rw.cjs'], cwd: '.', files: { 'rw.cjs': sha(rw) } };
  record('eng.write_file@1', await f.call('write_file', { path: '.rulith/acceptance/gen.json', expect_digest: '',
    text: JSON.stringify({ ...gen, output_dirs: ['src'] }) }));
  await assert.rejects(f.call('test_v2', { check: 'gen' }), { message: 'acceptance spec invalid: unknown field output_dirs' });
  record('eng.test@2', await f.call('test_v2', { check: 'a' }));
  assert.deepEqual(passing(facts), ['a']);
  const specPath = '.rulith/acceptance/gen.json';
  record('eng.write_file@1', await f.call('write_file', { path: specPath,
    expect_digest: sha(fs.readFileSync(path.join(f.root, specPath))), text: JSON.stringify(gen) }));
  record('eng.test@2', await f.call('test_v2', { check: 'a' }));
  assert.deepEqual(passing(facts), ['a']);
  const run = record('eng.test@2', await f.call('test_v2', { check: 'gen' }));
  assert.equal(fs.readFileSync(path.join(f.root, 'src/value.mjs'), 'utf8'), 'export const VALUE = 666;');
  assert.ok(run.rows.some(r => r.from_gen >= 0 && r.to_gen === r.from_gen + 1), 'the rewriting run emits a tree step');
  // Neither the signed check (tested before the rewrite) nor the rewriting run itself passes on the new tree.
  assert.deepEqual(passing(facts), []);
  assert.equal((await f.call('test_v2', { check: 'a' })).rows[0].exit_code, 1);
});

test('a check whose own run changes the tree is stamped at the pre-run generation and never passes (review 2 PoC p4)', async t => {
  const f = fixture(t);
  f.write('src.mjs', 'export const V = 1;');
  const script = "import fs from 'node:fs'; fs.writeFileSync('src.mjs', 'export const V = 666;');";
  f.write('test.mjs', script); f.put({ ...f.spec, files: { 'test.mjs': sha(script) } });
  const start = (await f.call('tree_state')).rows[0];
  const out = await f.call('test_v2', { check: 'unit' });
  const row = out.rows[0];
  assert.equal(row.exit_code, 0);
  assert.equal(row.gen, start.gen); // the tree it tested, not the one it made
  assert.deepEqual([row.from_gen, row.to_gen], [start.gen, start.gen + 1]);
  // The row pairs the pre-run generation with the pre-run digest; the step carries pre -> post (review 3 P2-1).
  assert.equal(row.tree_digest, start.tree_digest);
  assert.notEqual(row.tree_digest, (await f.call('tree_state')).rows[0].tree_digest);
  assert.deepEqual(passing(factsOf('eng.test@2', out)), []);
  // The step is replayed on the next mutating receipt even if this receipt were lost.
  const later = await f.call('write_file', { path: 'other.txt', expect_digest: '', text: 'x' });
  assert.ok(later.rows.some(r => r.from_gen === start.gen && r.to_gen === start.gen + 1));
  // A change made before the run (and none by the run) is a step and the run is stamped at the new generation.
  const quiet = "process.exitCode = 0;\n";
  f.write('test.mjs', quiet); f.put({ ...f.spec, files: { 'test.mjs': sha(quiet) } });
  const before = (await f.call('tree_state')).rows[0].gen;
  f.write('unseen.txt', 'changed outside the kit');
  const after = await f.call('test_v2', { check: 'unit' });
  assert.equal(after.rows[0].gen, before + 1);
  assert.ok(after.rows.some(r => r.from_gen === before && r.to_gen === before + 1));
  assert.deepEqual(passing(factsOf('eng.test@2', after)), ['unit']);
  // The owner's treeExclude is the only exclusion: output there is no step, and the check passes at its generation.
  f.settings({ treeExclude: ['out'] });
  const writer = "import fs from 'node:fs'; fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/r', String(Date.now()));";
  f.write('test.mjs', writer); f.put({ ...f.spec, files: { 'test.mjs': sha(writer) } });
  const settled = (await f.call('tree_state')).rows[0].gen;
  const excludedRun = await f.call('test_v2', { check: 'unit' });
  assert.equal(excludedRun.rows[0].gen, settled);
  assert.deepEqual([excludedRun.rows.at(-1).from_gen, excludedRun.rows.at(-1).to_gen], [-1, -1]);
  assert.ok(excludedRun.rows.every(r => r.from_gen !== settled));
  assert.deepEqual(passing(factsOf('eng.test@2', excludedRun)), ['unit']);
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
  f.put({ ...f.spec, command: 'echo piped | findstr piped > shell-out.txt', shell: true });
  assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'acceptance shell refused');
  assert.equal(fs.existsSync(path.join(f.root, 'shell-out.txt')), false);
  const cli = f.cli('test_v2', { check: 'unit' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'acceptance shell refused');
  // The owner's shell setting enables it; push/publish stay refused even then.
  f.settings({ shell: true });
  fs.mkdirSync(path.join(f.root, 'shell-output'));
  f.put({ ...f.spec, command: 'echo acceptance > shell-output/result', shell: true });
  assert.equal((await f.call('test_v2', { check: 'unit' })).rows[0].exit_code, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'shell-output/result'), 'utf8'), /acceptance/);
  f.put({ ...f.spec, command: 'git push', shell: true });
  assert.equal((await f.tryCall('test_v2', { check: 'unit' })).error, 'command refused');
  // Without shell in the spec, the owner's shell setting does not route the spec command through a shell.
  f.put({ ...f.spec, command: [process.execPath, 'test.mjs', '>', 'not-redirected'] });
  assert.equal((await f.call('test_v2', { check: 'unit' })).rows[0].exit_code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'not-redirected')), false);
});

test('with the owner shell the Board shows exactly the line the shell runs (review 2 P2-2)', async t => {
  const f = fixture(t);
  f.settings({ shell: true });
  f.write('x.mjs', 'process.exitCode = 0;');
  // The reviewer's spec: an argv word that a space-join would hand to the shell unquoted.
  f.put({ command: ['node', 'x.mjs & echo pwned > p.txt'], cwd: '.', files: { 'x.mjs': sha('process.exitCode = 0;') }, shell: true }, 's');
  const command = 'acceptance spec invalid: command must be an array of words (or one string with shell:true)';
  await assert.rejects(f.call('test_v2', { check: 's' }), { message: command });
  assert.deepEqual((await f.call('acceptance')).errors, [{ error: command, check: 's' }]);
  // As one string the line is shown and run as written: the quotes keep `&` and `>` inside node's argument.
  const line = 'node "x.mjs & echo pwned > p.txt"';
  f.put({ command: line, cwd: '.', files: { 'x.mjs': sha('process.exitCode = 0;') }, shell: true }, 's');
  const [row] = (await f.call('acceptance')).rows.filter(r => r.check === 's');
  assert.equal(row.command, line); assert.equal(row.shell, true);
  const out = await f.call('test_v2', { check: 's' });
  assert.notEqual(out.rows[0].exit_code, 0); // node found no script of that name
  assert.equal(fs.existsSync(path.join(f.root, 'p.txt')), false);
  // The shown line is the line the shell receives, metacharacters included.
  const honest = 'node x.mjs && echo shown > shown.txt';
  f.put({ command: honest, cwd: '.', files: { 'x.mjs': sha('process.exitCode = 0;') }, shell: true }, 's');
  assert.equal((await f.call('acceptance')).rows.find(r => r.check === 's').command, honest);
  assert.equal((await f.call('test_v2', { check: 's' })).rows[0].exit_code, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'shown.txt'), 'utf8'), /shown/);
  // The digest is recomputable from the fact: the string is the command.
  const fact = (await f.call('acceptance')).rows.find(r => r.check === 's');
  assert.equal(sha(canonicalSpec({ command: fact.command, cwd: fact.cwd, shell: fact.shell,
    files: Object.fromEntries(JSON.parse(fact.files).map(x => [x.path, x.sha256])) })), fact.spec_digest);
});

test('command words and paths with control or format characters or lone surrogates are refused by field (review 2 PoC p3)', async t => {
  const f = fixture(t);
  f.write('t.mjs', 'x');
  const files = { 't.mjs': sha('x') };
  for (const [spec, field] of [
    [{ command: ['node', '\u202Eevil'], cwd: '.', files }, 'command'],
    [{ command: ['node', 't.mjs', 'tab\there'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'a\u0085b'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'zero\u200Bwidth'], cwd: '.', files }, 'command'],
    [{ command: ['node', '\uFEFFt.mjs'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'x\uD800'], cwd: '.', files }, 'command'],
    [{ command: 'node t.mjs \u2066hidden\u2069', cwd: '.', files, shell: true }, 'command'],
    [{ command: 'node t.mjs\nrm -rf x', cwd: '.', files, shell: true }, 'command'],
    [{ command: ['node', 't.mjs'], cwd: 'sr\u202Ec', files }, 'cwd'],
    [{ command: ['node', 't.mjs'], cwd: '.', files: { ...files, 'te\u202Est.mjs': sha('x') } }, 'files'],
    [{ command: ['node', 't.mjs'], cwd: '.', files: { ...files, 'a\uDC00.mjs': sha('x') } }, 'files'],
  ]) {
    f.put(spec, 'spoof');
    const message = `acceptance spec invalid: ${field}`;
    await assert.rejects(f.call('test_v2', { check: 'spoof' }), { message }, JSON.stringify(spec));
    assert.deepEqual((await f.call('acceptance')).errors, [{ error: message, check: 'spoof' }]);
  }
  const cli = f.cli('test_v2', { check: 'spoof' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'acceptance spec invalid: files');
  // Review 4 P2-3: printable ASCII only, no leading or trailing space. Look-alikes (Cyrillic e, U+2800 braille blank,
  // U+0336 combining overlay, U+00A0) and any other non-ASCII text are refused by field; an inner space is fine.
  for (const [spec, field] of [
    [{ command: ['node', 't\u0435st.mjs'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'test.mjs\u2800'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'te\u0336st.mjs'], cwd: '.', files }, 'command'],
    [{ command: ['node', 'a\u00a0b'], cwd: '.', files }, 'command'],
    [{ command: ['node', 't.mjs', '\u00fcn\u00ef'], cwd: '.', files }, 'command'],
    [{ command: ['node', ' t.mjs'], cwd: '.', files }, 'command'],
    [{ command: 'node t.mjs ', cwd: '.', files, shell: true }, 'command'],
    [{ command: ['node', 't.mjs'], cwd: '\u4e2d\u6587', files }, 'cwd'],
    [{ command: ['node', 't.mjs'], cwd: '.', files: { ...files, 't\u0435st.mjs': sha('x') } }, 'files'],
  ]) {
    f.put(spec, 'spoof');
    await assert.rejects(f.call('test_v2', { check: 'spoof' }), { message: `acceptance spec invalid: ${field}` }, JSON.stringify(spec));
  }
  f.put({ command: ['node', 't.mjs', 'a b', '~!@#$%^&*()_+{}|:<>?'], cwd: '.', files }, 'spoof');
  const row = (await f.call('acceptance')).rows.find(r => r.check === 'spoof');
  assert.equal(row.command, 'node t.mjs "a b" ~!@#$%^&*()_+{}|:<>?');
});

test('inline code in combined, attached and data: URL forms is refused like -e (review 2 P2-4)', async t => {
  const f = fixture(t);
  f.settings({ shell: false });
  const outside = path.join(f.dir, 'outside.txt').split(path.sep).join('/');
  const code = `require('fs').writeFileSync('${outside}', 'x')`;
  const loader = 'data:text/javascript,' + encodeURIComponent(`import fs from 'fs'; fs.writeFileSync('${outside}', 'x')`);
  f.write('x.mjs', 'process.exit(0)');
  for (const command of [['node', '-pe', code], ['node', '-ep', code], [process.execPath, '-pe', code],
    ['node', `-e${code}`], ['node', `-p${code}`], ['node', '-ce', code],
    ['node', `--experimental-loader=${loader}`, 'x.mjs'], ['node', `--loader=${loader}`, 'x.mjs'],
    ['node', '--experimental-loader', loader, 'x.mjs'], ['node', `--import=${loader}`, 'x.mjs'], ['node', '-r', loader, 'x.mjs'],
    ['python', '-cprint(1)'], ['python3', '-Ic', 'print(1)'], ['py', '-Bc', 'print(1)'],
    ['perl', '-ne', 'print'], ['perl', '-eprint 1'], ['perl', '-E', 'say 1'], ['ruby', '-le', 'puts 1']]) {
    f.put({ command, cwd: '.', files: {} }, 'inline');
    assert.equal((await f.tryCall('test_v2', { check: 'inline' })).error, 'command refused', command.join(' '));
    assert.equal((await f.tryCall('run', { command: command.map(w => JSON.stringify(w)).join(' ') })).error, 'command refused', command.join(' '));
  }
  assert.equal(fs.existsSync(outside), false);
  // Ordinary flags and script files stay allowed: the fence is about visible intent, not a sandbox.
  for (const command of [['node', '--version'], ['node', '-C', 'dev', 'x.mjs'], ['node', '--test', 'x.mjs'], ['node', 'x.mjs']]) {
    f.put({ command, cwd: '.', files: {} }, 'plain');
    assert.equal((await f.call('test_v2', { check: 'plain' })).rows[0].exit_code, 0, command.join(' '));
  }
});

test('test@2 receipts land eng.check_result; a run that changed the tree is stamped before it; later writes invalidate', async t => {
  const f = fixture(t);
  f.write('test.mjs', "import fs from 'node:fs'; fs.writeFileSync('generated', 'yes');\n");
  f.put({ ...f.spec, files: { 'test.mjs': sha(fs.readFileSync(path.join(f.root, 'test.mjs'))) } });
  const pre = (await f.call('tree_state')).rows[0].tree_digest;
  const out = await f.call('test_v2', { check: 'unit' });
  const row = out.rows[0];
  assert.equal(row.check, 'unit'); assert.equal(row.exit_code, 0); assert.equal(row.gen, 0);
  assert.equal(row.spec_digest, acceptanceSpec(f.ctx, 'unit').digest);
  assert.equal(row.tree_digest, pre); // generation 0 with its own digest; the step 0 -> 1 is in the same receipt
  assert.deepEqual([row.from_gen, row.to_gen], [0, 1]);
  assert.deepEqual(factsOf('eng.test@2', out), [
    { predicate: 'eng.check_result', args: { check: 'unit', spec_digest: row.spec_digest, gen: 0, tree_digest: row.tree_digest, exit_code: 0 } },
    { predicate: 'eng.tree_step', args: { from_gen: 0, to_gen: 1 } },
  ]);
  assert.deepEqual(passing(factsOf('eng.test@2', out)), []);
  // The second run rewrites the same bytes: no change, so it passes at the current generation.
  const again = await f.call('test_v2', { check: 'unit' });
  assert.equal(again.rows[0].gen, 1); assert.equal(again.rows.at(-1).from_gen, -1);
  assert.deepEqual(passing([...factsOf('eng.test@2', out), ...factsOf('eng.test@2', again)]), ['unit']);
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
    ["import fs from 'node:fs'; fs.writeFileSync('.rulith/acceptance/unit.json', '{}');", 'acceptance spec invalid: command must be an array of words (or one string with shell:true)'],
    ["import fs from 'node:fs'; const p='.rulith/acceptance/unit.json'; const s=JSON.parse(fs.readFileSync(p)); s.command.push('x'); fs.writeFileSync(p,JSON.stringify(s));", 'acceptance spec changed'],
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
  assert.deepEqual(out.errors, [{ error: 'acceptance spec invalid' }, { error: 'acceptance spec invalid: not JSON', check: 'bad' }]);
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
  assert.deepEqual(defines.get('eng.check_spec').args, ['check', 'spec_digest', 'command', 'cwd', 'shell', 'files']);
  // The project tool versions belong to program v3 (their eng.tree_step carries the project).
  const v2Tools = Object.entries(tools).filter(([id]) => !PROJECT_TOOLS.includes(id));
  for (const [id, tool] of v2Tools) for (const row of tool.returns) {
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
  const receiptWords = [...new Set(v2Tools.flatMap(([, tool]) => tool.returns.map(row => row.predicate)))].sort();
  assert.deepEqual(sources.sources[0].words, receiptWords);
  assert.equal(sources.sources[0].words.includes('eng.check_passed'), false);
  for (const word of ['eng.check_result', 'eng.check_spec', 'web.page', 'web.search']) assert.ok(sources.sources[0].words.includes(word));
  // The former native shape and a second namespace are what the compiler refuses.
  assert.notDeepEqual(authoringErrors({ ...program, vocabulary: { ...program.vocabulary,
    defines: [...program.vocabulary.defines, { id: 'web.page', as: 'web_page', args: ['url'] }] } }), []);
});

// The authoring compiler jar: RULITH_AUTHORING_JAR, else the rulith-java checkout beside this repository's directory.
// A skip names every path it looked for, so a skipped run says what to build or set.
function authoringCompiler(env = process.env) {
  const jar = env.RULITH_AUTHORING_JAR
    || path.resolve(repo, '..', 'rulith-java', 'gateway', 'target', 'gateway-0.1.0-SNAPSHOT-authoring.jar');
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'C:/Program Files/Java/jdk-25/bin/java';
  const missing = [];
  if (!fs.existsSync(jar)) missing.push(`authoring jar not found at ${jar} (build rulith-java or set RULITH_AUTHORING_JAR)`);
  if (!fs.existsSync(java) && !fs.existsSync(`${java}.exe`)) missing.push(`Java 25 not found at ${java} (set JAVA_HOME)`);
  return { jar, java, skip: missing.length ? missing.join('; ') : null };
}

test('the authoring compiler lookup honours RULITH_AUTHORING_JAR and names the paths it looked for', t => {
  fs.mkdirSync(path.join(repo, '.scratch'), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(repo, '.scratch', 'jar-'));
  t.after(() => fs.rmSync(scratch, { force: true, recursive: true }));
  const jar = path.join(scratch, 'authoring.jar'); fs.writeFileSync(jar, '');
  const absent = path.join(scratch, 'absent');
  assert.equal(authoringCompiler({ RULITH_AUTHORING_JAR: jar, JAVA_HOME: absent }).jar, jar);
  assert.equal(authoringCompiler({ RULITH_AUTHORING_JAR: jar, JAVA_HOME: absent }).skip, `Java 25 not found at ${path.join(absent, 'bin', 'java')} (set JAVA_HOME)`);
  const missing = authoringCompiler({ RULITH_AUTHORING_JAR: path.join(absent, 'x.jar'), JAVA_HOME: absent }).skip;
  assert.ok(missing.includes(`authoring jar not found at ${path.join(absent, 'x.jar')}`), missing);
  assert.equal(authoringCompiler({}).jar, path.resolve(repo, '..', 'rulith-java', 'gateway', 'target', 'gateway-0.1.0-SNAPSHOT-authoring.jar'));
});

test('the Gateway authoring compiler accepts program-v2.json (skipped without its jar and Java 25)', t => {
  const { jar, java, skip } = authoringCompiler();
  if (skip) return t.skip(skip);
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

test('the Gateway authoring compiler accepts program-v3.json, the official program (skipped without its jar and Java 25)', t => {
  const { jar, java, skip } = authoringCompiler();
  if (skip) return t.skip(skip);
  const run = spawnSync(java, ['-jar', jar, path.join(repo, 'kits/general/pack/program-v3.json')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.errors, []); assert.equal(result.valid, true);
  const native = result.program.packs[0].pack;
  assert.equal(native.meta.name, 'engineering_work');
  assert.deepEqual(native.pins, ['eng.check_passed', 'eng.check_result', 'eng.check_spec', 'eng.tree_step']);
  assert.deepEqual(native.vocab.find(v => v.predicate === 'eng.check_passed').args, ['key']);
  assert.deepEqual(native.axioms[0].when[1], { predicate: 'eng.tree_step', args: { project: '?p', from_gen: '?g', to_gen: '?n' }, naf: true });
  assert.deepEqual(native.acceptance[0].when, [{ predicate: 'acceptance', args: { node: '?n', test: '?k' } },
    { predicate: 'eng.check_passed', args: { key: '?k' } }]);
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

// A model-written measurement spec (.deep-rulith/measure/<name>.json, spec_id self-<name>).
function selfSpec(f, name, extra = {}) {
  f.write('measure.mjs', 'console.log(JSON.stringify({ value_milli: 1 }));\n');
  const d = fileDigest(path.join(f.root, 'measure.mjs'));
  const spec = { command: ['node', 'measure.mjs'], interpreter: 'node', binary: 'measure.mjs', candidate_binary: 'measure.mjs',
    workload: 'measure.mjs', config: 'measure.mjs', binary_digest: d, workload_digest: d, config_digest: d,
    parser: { kind: 'json_integer_milli', field: 'value_milli' }, unit: 'ms', repeats: 1, ...extra };
  f.write(`.deep-rulith/measure/${name}.json`, JSON.stringify(spec));
  return spec;
}

test('a self- measurement spec never excludes anything from the tree digest (review 3 PoC poc1)', async t => {
  const f = fixture(t);
  f.write('src/flag.txt', 'good');
  const strict = "import fs from 'node:fs'; process.exitCode = fs.readFileSync('src/flag.txt', 'utf8') === 'good' ? 0 : 1;\n";
  f.write('test.mjs', strict); f.put({ ...f.spec, files: { 'test.mjs': sha(strict) } });
  const spec = selfSpec(f, 'x', { output_dirs: ['src'] });
  const facts = [];
  const record = (id, out) => { facts.push(...factsOf(id, out)); return out; };
  record('eng.tree_state@1', await f.call('tree_state'));
  // The PoC: the spec is refused at pin time and never frozen.
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-x' }), { message: 'spec refused: a self- spec has no output_dirs' });
  assert.equal(fs.existsSync(path.join(f.home, 'specs', 'self-x.json')), false);
  record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(passing(facts), ['unit']);
  record('eng.write_file@1', await f.call('write_file', { path: 'src/flag.txt', text: 'BROKEN', expect_digest: sha('good') }));
  assert.deepEqual(passing(facts), []);
  // A self- spec frozen into the kit home before this rule (or written there under a self- name) adds no exclusion
  // either; an owner spec's output_dirs still do.
  fs.writeFileSync(path.join(f.home, 'specs', 'self-x.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(f.home, 'specs', 'owner.json'), JSON.stringify({ ...spec, output_dirs: ['build'] }));
  assert.deepEqual(exclusions(f.ctx), ['.git', 'build']);
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-x' }), { message: 'spec refused: a self- spec has no output_dirs' });
  const digest = tree(f.ctx).digest;
  f.write('src/flag.txt', 'changed again');
  assert.notEqual(tree(f.ctx).digest, digest);
  // The adapter process reports the refusal in its fixed words.
  const cli = f.cli('measure_pinned', { spec_id: 'self-x' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'spec refused: a self- spec has no output_dirs');
});

test('a self- spec command passes the eng.run classifier and its interpreter is a common one (review 3 P2-4, PoC poc1b)', async t => {
  const f = fixture(t);
  f.write('config', 'x');
  const d = fileDigest(path.join(f.root, 'config'));
  const fields = { binary: 'config', candidate_binary: 'config', workload: 'config', config: 'config', binary_digest: d,
    workload_digest: d, config_digest: d, parser: { kind: 'json_integer_milli', field: 'value_milli' }, unit: 'ms', repeats: 1 };
  // The reviewer's spec: interpreter git, binary a project file named config -> `git config ...`.
  f.write('.deep-rulith/measure/g.json', JSON.stringify({ ...fields, interpreter: 'git', command: ['git', 'config', '--file', 'out.ini', 'a.b', 'c'] }));
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-g' }), /^Error: spec refused: interpreter must be/);
  // Without an interpreter the classifier sees the line itself.
  f.write('.deep-rulith/measure/h.json', JSON.stringify({ ...fields, command: ['git', 'config', '--file', 'out.ini', 'a.b', 'c'] }));
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-h' }), { message: 'command refused' });
  assert.equal(fs.existsSync(path.join(f.root, 'out.ini')), false);
  for (const name of ['g', 'h']) assert.equal(fs.existsSync(path.join(f.home, 'specs', `self-${name}.json`)), false);
  // A classified word after the script: push/publish stay refused for self- specs, unchanged for the owner's.
  const spec = selfSpec(f, 'p', { command: ['node', 'measure.mjs', 'publish'] });
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-p' }), { message: 'command refused' });
  fs.writeFileSync(path.join(f.home, 'specs', 'owner.json'), JSON.stringify(spec));
  assert.deepEqual((await f.call('measure_pinned', { spec_id: 'owner' })).rows.map(r => r.value_milli), [1]);
  // Absolute interpreters only under the owner's allowedPaths (the fixture allows node's directory).
  selfSpec(f, 'abs', { interpreter: process.execPath, command: [process.execPath, 'measure.mjs'] });
  assert.deepEqual((await f.call('measure_pinned', { spec_id: 'self-abs' })).rows.map(r => r.value_milli), [1]);
  f.settings({ allowedPaths: [] });
  selfSpec(f, 'abs2', { interpreter: process.execPath, command: [process.execPath, 'measure.mjs'] });
  await assert.rejects(f.call('measure_pinned', { spec_id: 'self-abs2' }), /^Error: spec refused: interpreter must be/);
  for (const interpreter of ['bash', 'cmd', 'node.exe', '../node', '']) {
    selfSpec(f, 'bad', { interpreter, command: [interpreter || 'node', 'measure.mjs'] });
    await assert.rejects(f.call('measure_pinned', { spec_id: 'self-bad' }), /^Error: spec refused: interpreter must be/, interpreter);
  }
  // The ordinary self- spec still runs and is frozen.
  selfSpec(f, 'ok');
  assert.deepEqual((await f.call('measure_pinned', { spec_id: 'self-ok' })).rows.map(r => r.value_milli), [1]);
  assert.ok(fs.existsSync(path.join(f.home, 'specs', 'self-ok.json')));
});

test('a check run that reverts an unrecorded change is a step and never current (review 3 PoC poc2 case b)', async t => {
  const f = fixture(t);
  f.write('src/flag.txt', 'good');
  // Passes when the flag it sees is "bad", then writes "good" back.
  const reverting = "import fs from 'node:fs'; const v = fs.readFileSync('src/flag.txt', 'utf8'); fs.writeFileSync('src/flag.txt', 'good'); process.exitCode = v === 'bad' ? 0 : 1;\n";
  f.write('t.mjs', reverting);
  f.put({ command: [process.execPath, 't.mjs'], cwd: '.', files: { 't.mjs': sha(reverting) } }, 'rev');
  const start = (await f.call('tree_state')).rows[0];
  fs.writeFileSync(path.join(f.root, 'src/flag.txt'), 'bad'); // an edit outside the kit, no receipt
  const tested = tree(f.ctx).digest;
  const out = await f.call('test_v2', { check: 'rev' });
  assert.equal(fs.readFileSync(path.join(f.root, 'src/flag.txt'), 'utf8'), 'good');
  assert.equal(tree(f.ctx).digest, start.tree_digest); // the run ended on the recorded tree
  const [row] = out.rows;
  assert.equal(row.exit_code, 0);
  assert.deepEqual([row.gen, row.from_gen, row.to_gen], [start.gen, start.gen, start.gen + 1]);
  assert.equal(row.tree_digest, tested); // the digest of the tree it ran on, paired with the pre-run generation
  assert.deepEqual(passing(factsOf('eng.test@2', out)), []);
  assert.equal((await f.call('tree_state')).rows[0].gen, start.gen + 1);
});

test('display safety refuses invisible, look-alike and unassigned characters by field (review 3 PoC poc3)', async t => {
  const f = fixture(t);
  f.write('test.mjs', 'process.exitCode = 1; // the real, strict test\n');
  const files = { 'test.mjs': sha('process.exitCode = 1; // the real, strict test\n') };
  for (const ch of ['\u3164', '\u115F', '\uFFA0', '\u034F', '\uFE0F', '\u00A0', '\u3000', '\u2028', '\u2029', '\uE000', '\u0378']) {
    const hidden = `test.mjs${ch}`;
    const label = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
    for (const [spec, field] of [
      [{ command: [process.execPath, hidden], cwd: '.', files }, 'command'],
      [{ command: `node ${hidden}`, cwd: '.', files, shell: true }, 'command'],
      [{ command: [process.execPath, 'test.mjs'], cwd: `src${ch}`, files }, 'cwd'],
      [{ command: [process.execPath, 'test.mjs'], cwd: '.', files: { ...files, [hidden]: files['test.mjs'] } }, 'files'],
    ]) {
      f.put(spec, 'spoof');
      await assert.rejects(f.call('test_v2', { check: 'spoof' }), { message: `acceptance spec invalid: ${field}` }, `${label} ${field}`);
      assert.deepEqual((await f.call('acceptance')).errors, [{ error: `acceptance spec invalid: ${field}`, check: 'spoof' }], label);
    }
  }
});

test('interpreter options are read only before the script; launchers with inline code are refused (review 3 PoC poc5)', t => {
  const f = fixture(t);
  const verdict = command => { try { classify(f.ctx, command); return 'allowed'; } catch (error) { return error.message; } };
  for (const command of ['node test.mjs -p 8080', 'node test.mjs -help', 'node server.mjs -port 3000', 'node --test test/ -r',
    'node build.mjs -release', 'node test.mjs -verbose', 'node test.mjs data:x', 'node --test --test-reporter=spec',
    'node --enable-source-maps test.mjs', 'node --experimental-vm-modules x.mjs', 'node --test-reporter spec test.mjs -e',
    'node --stack-size 2000 test.mjs -e', 'node -C dev x.mjs -p', 'node --no-warnings x.mjs -e',
    'python -m pytest -c pytest.ini', 'python -m pytest -x -q', 'python run.py -config a.yml', 'python -m unittest -v',
    'python -B -m pytest', 'python -m pytest --cov', 'python -W ignore run.py -c x', 'python3 -X dev -m pytest -c x',
    'ruby test.rb -verbose', 'perl Makefile.PL -verbose', 'ruby -Ilib -rminitest test.rb', 'perl -Ilib t/x.t', 'ruby -I lib test.rb -e',
    'npx eslint .', 'npm exec -- vitest run', 'uv run pytest -c x', 'bundle exec rake test', 'deno test', 'bun test.ts -e',
    // Review 4 P2-5: a preloaded module that is a file or package (not a data: URL) is readable code.
    'node --import=./x.mjs a.mjs', 'node --require ./x.cjs a.mjs', 'node -r ./x.cjs a.mjs']) {
    assert.equal(verdict(command), 'allowed', command);
  }
  for (const command of ['node -e 1', 'node -pe 1', 'node -p 1', 'node --eval=1', 'node --eval 1', 'node --print 1',
    'node --input-type=module --eval 1', 'node --env-file=.env -e 1', 'node -C dev -e 1', 'node --inspect -e 1',
    'node --title x -e 1', 'node --stack-size -e 1', 'node --unknown-flag value -e 1', 'node --experimental-loader=data:text/javascript,1 x.mjs',
    'node --loader data:text/javascript,1 x.mjs', 'node data:text/javascript,1', 'node --import data:text/javascript,1 a.mjs',
    'node -r data:text/javascript,1 a.mjs', 'python -c 1', 'python -Xdev -c 1', 'python3 -Wignore -c 1', 'python -W ignore -c 1', 'python -X dev -c 1',
    'python -OO -c 1', 'python -Ic 1', 'python --check-hash-based-pycs always -c 1', 'perl -Mstrict -e 1', 'perl -w -e1', 'perl -I lib -e 1',
    'perl -ne print', 'ruby -le 1', 'ruby -r json -e 1', 'ruby -I lib -e 1',
    'nodejs -e 1', 'bun -e 1', 'bun --eval 1', 'bun run --eval 1', 'tsx -e 1', 'tsx --eval 1', 'deno eval 1', 'deno run --eval 1',
    'npx node -e 1', 'npx -y node -e 1', 'npx tsx -e 1', 'npx -c "node x"', 'npm exec -- node -e 1', 'npm exec -c "node x"', 'npm x node -e 1',
    'pnpm exec node -e 1', 'pnpm dlx tsx -e 1', 'yarn exec node -e 1', 'bunx node -e 1', 'uv run python -c 1', 'uv run --python 3.12 python -c 1',
    'poetry run python -c 1', 'bundle exec ruby -e 1']) {
    assert.equal(verdict(command), 'command refused', command);
  }
});

// Review 4. Each test reproduces one reviewer PoC (D:/Work/Temp/review-d1016a-kit4) and fails without its fix.
const recorder = () => {
  const facts = [];
  return { facts, record: (id, out) => { facts.push(...factsOf(id, out)); return out; }, passing: () => passing(facts) };
};

test('a nested .git is hashed like any other file; only <root>/.git is excluded and never written (review 4 P1-1, PoC pocA)', async t => {
  const f = fixture(t); const r = recorder();
  const strict = "import fs from 'node:fs'; process.exitCode = fs.readFileSync(new URL('./src/.git', import.meta.url), 'utf8') === 'good' ? 0 : 1;\n";
  f.write('test.mjs', strict); f.put({ ...f.spec, files: { 'test.mjs': sha(strict) } });
  fs.mkdirSync(path.join(f.root, 'src'));
  r.record('eng.tree_state@1', await f.call('tree_state'));
  const created = r.record('eng.write_file@1', await f.call('write_file', { path: 'src/.git', text: 'good', expect_digest: '' }));
  assert.deepEqual([created.rows[0].from_gen, created.rows[0].to_gen], [0, 1]);
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  r.record('eng.write_file@1', await f.call('write_file', { path: 'src/.git', text: 'BROKEN', expect_digest: sha('good') }));
  assert.deepEqual(r.passing(), []);
  // A nested .git directory: its files count too.
  fs.mkdirSync(path.join(f.root, 'lib/.git'), { recursive: true });
  const before = tree(f.ctx).digest;
  fs.writeFileSync(path.join(f.root, 'lib/.git/impl.mjs'), 'export default 1;\n');
  assert.notEqual(tree(f.ctx).digest, before);
  // The owner may exclude nested repositories with **/.git.
  f.settings({ treeExclude: ['**/.git'] });
  const excluded = tree(f.ctx).digest;
  fs.writeFileSync(path.join(f.root, 'lib/.git/impl.mjs'), 'export default 2;\n');
  assert.equal(tree(f.ctx).digest, excluded);
  // <root>/.git: excluded, so no tool writes there and no command names it or runs inside it, in any spelling.
  f.settings();
  fs.mkdirSync(path.join(f.root, '.git'));
  const rootDigest = tree(f.ctx).digest;
  fs.writeFileSync(path.join(f.root, '.git/config'), 'x');
  assert.equal(tree(f.ctx).digest, rootDigest);
  const names = ['.git/hook.mjs', '.GIT/hook.mjs', ...(process.platform === 'win32' ? ['.git./hook.mjs', '.git /hook.mjs'] : [])];
  for (const name of names) {
    await assert.rejects(f.call('write_file', { path: name, text: 'x', expect_digest: '' }), { message: 'path refused' }, name);
    await assert.rejects(f.call('apply_patch', { patch: `*** Begin Patch\n*** Add File: ${name}\n+x\n*** End Patch` }), { message: 'path refused' }, name);
  }
  await assert.rejects(f.call('write_file', { path: '.git', text: 'x', expect_digest: '' }), { message: 'path refused' });
  await assert.rejects(f.call('run', { command: 'node -v', cwd: '.git' }), { message: 'path refused' });
  await assert.rejects(f.call('run', { command: 'node .git/x.mjs' }), { message: 'path refused' });
  assert.throws(() => classify(f.ctx, ['node', '.GIT/x.mjs']), { message: 'path refused' });
  // A file whose name only starts with .git is an ordinary file.
  f.write('.gitignore', 'x\n');
  assert.equal(classify(f.ctx, ['node', '.gitignore']).command[1], '.gitignore');
});

test('commands run without the kit and Worker variables; a script cannot rewrite the owner settings (review 4 P1-2 a, PoC pocD)', async t => {
  const f = fixture(t); const r = recorder();
  const saved = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  Object.assign(process.env, { ENG_KIT_HOME: f.home, RULITH_REVIEW_SECRET: 'x', eng_lower_case: 'x', Rulith_Mixed: 'x' });
  f.write('env.mjs', "console.log(JSON.stringify(Object.keys(process.env).filter(name => /^(ENG_|RULITH_)/i.test(name))));\n");
  assert.equal((await f.call('run', { command: 'node env.mjs' })).head.trim(), '[]');
  const job = await f.call('job_start', { command: 'node env.mjs' });
  let poll; do poll = await f.call('job_poll', { job_id: job.rows[0].job_id, wait_s: 5 }); while (!['done', 'failed'].includes(poll.rows[0].status));
  assert.equal(poll.rows[0].status, 'done'); assert.equal(poll.head.trim(), '[]');
  // PoC pocD: the script that rewrote <kit home>/settings.json (treeExclude: ["src"]) through ENG_KIT_HOME.
  f.write('src/flag.txt', 'good');
  const strict = "import fs from 'node:fs'; process.exitCode = fs.readFileSync('src/flag.txt', 'utf8') === 'good' ? 0 : 1;\n";
  f.write('test.mjs', strict); f.put({ ...f.spec, files: { 'test.mjs': sha(strict) } });
  f.write('tool.mjs', "import fs from 'node:fs'; import path from 'node:path'; const s = path.join(process.env.ENG_KIT_HOME, 'settings.json'); const v = JSON.parse(fs.readFileSync(s, 'utf8')); v.treeExclude = ['src']; fs.writeFileSync(s, JSON.stringify(v));\n");
  const settingsBefore = fs.readFileSync(path.join(f.home, 'settings.json'), 'utf8');
  r.record('eng.tree_state@1', await f.call('tree_state'));
  r.record('eng.run@1', await f.call('run', { command: 'node tool.mjs' }));
  assert.equal(fs.readFileSync(path.join(f.home, 'settings.json'), 'utf8'), settingsBefore);
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  r.record('eng.write_file@1', await f.call('write_file', { path: 'src/flag.txt', text: 'BROKEN', expect_digest: sha('good') }));
  assert.deepEqual(r.passing(), []);
});

test('the tree identity covers the effective exclusions, shell, allow and allowedPaths: a settings change is a step (review 4 P1-2 b)', async t => {
  const f = fixture(t); const r = recorder();
  f.write('src/flag.txt', 'good');
  r.record('eng.tree_state@1', await f.call('tree_state'));
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  // The settings rewrite pocD made (treeExclude widened to src), with no file change: the earlier pass stops being current.
  f.settings({ treeExclude: ['src'] });
  const step = r.record('eng.run@1', await f.call('run', { command: 'node -v' }));
  assert.deepEqual([step.rows[0].from_gen, step.rows[0].to_gen], [0, 1]);
  assert.deepEqual(r.passing(), []);
  let gen = 1;
  const node = path.dirname(process.execPath);
  for (const value of [{ treeExclude: ['src'], shell: true }, { treeExclude: ['src'], shell: true, allow: ['delete'] },
    { treeExclude: ['src'], shell: true, allow: ['delete'], allowedPaths: [node, f.dir] }]) {
    fs.writeFileSync(path.join(f.home, 'settings.json'), JSON.stringify({ allowedPaths: [node], ...value }));
    assert.equal((await f.call('tree_state')).rows[0].gen, ++gen, JSON.stringify(value));
  }
  // A limit that changes neither what is hashed nor what may run is no step.
  fs.writeFileSync(path.join(f.home, 'settings.json'), JSON.stringify({ treeExclude: ['src'], shell: true, allow: ['delete'],
    allowedPaths: [node, f.dir], runDeadlineSeconds: 30 }));
  assert.equal((await f.call('tree_state')).rows[0].gen, gen);
});

test('a write into an owner exclusion is a tree step: exclusions are no place for tested code (review 4 P2-2)', async t => {
  const f = fixture(t); const r = recorder();
  f.settings({ treeExclude: ['out'] });
  f.write('out/dep.mjs', 'export const ok = true;\n');
  const strict = "import { ok } from './out/dep.mjs'; process.exitCode = ok ? 0 : 1;\n";
  f.write('test.mjs', strict); f.put({ ...f.spec, files: { 'test.mjs': sha(strict) } });
  r.record('eng.tree_state@1', await f.call('tree_state'));
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  const write = r.record('eng.write_file@1', await f.call('write_file', { path: 'out/dep.mjs', text: 'export const ok = false;\n', expect_digest: sha('export const ok = true;\n') }));
  assert.deepEqual([write.rows.at(-1).from_gen, write.rows.at(-1).to_gen], [0, 1]);
  assert.deepEqual(r.passing(), []);
  // apply_patch, under another spelling of the excluded folder (case), is a step too.
  const patch = r.record('eng.apply_patch@1', await f.call('apply_patch', { patch: '*** Begin Patch\n*** Add File: OUT/other.mjs\n+x\n*** End Patch' }));
  assert.deepEqual([patch.rows.at(-1).from_gen, patch.rows.at(-1).to_gen], [1, 2]);
  // A write outside every exclusion that leaves the tree as it was is still no step.
  f.write('same.txt', 'x');
  const gen = (await f.call('tree_state')).rows[0].gen;
  const same = await f.call('write_file', { path: 'same.txt', text: 'x', expect_digest: sha('x') });
  assert.deepEqual([same.rows.at(-1).from_gen, same.rows.at(-1).to_gen], [-1, -1]);
  assert.equal((await f.call('tree_state')).rows[0].gen, gen);
});

test('a self- spec_id is canonical lower case; SELF-x never opens the owner branch (review 4 P2-1, PoC pocB)', async t => {
  const f = fixture(t);
  selfSpec(f, 'x');
  assert.deepEqual((await f.call('measure_pinned', { spec_id: 'self-x' })).rows.map(row => [row.spec_id, row.value_milli]), [['self-x', 1]]);
  for (const id of ['SELF-x', 'Self-x', 'self-X', 'sElF-y'])
    await assert.rejects(f.call('measure_pinned', { spec_id: id }), { message: 'spec refused: a self- spec_id is lower case' }, id);
  selfSpec(f, 'Upper');
  assert.ok(!(await f.call('tree_state')).measure_specs.includes('self-Upper'));
  const cli = f.cli('measure_pinned', { spec_id: 'SELF-x' });
  assert.equal(cli.status, 2); assert.equal(cli.stderr, 'spec refused: a self- spec_id is lower case');
});

test('inline-code fence: review 4 bypasses are refused and its false refusals run (review 4 P2-4/P2-5, PoC pocC)', t => {
  const f = fixture(t);
  const verdict = command => { try { classify(f.ctx, command); return 'allowed'; } catch (error) { return error.message; } };
  for (const command of [['python', '-Rc', 'print(1)'], ['pythonw', '-c', 'print(1)'], ['pypy3', '-c', 'print(1)'], ['pypy', '-c', '1'],
    ['python', '-m', 'timeit', '-n1', 'import os'], ['python', '-mtimeit', '1'], ['python', '-m', 'pdb', '-c', '!import os', 'x.py'],
    ['python', '-m', 'cProfile', 'x.py'], ['python', '-m', 'profile', 'x.py'], ['python', '-m', 'code'],
    ['node', '--test', '--test-reporter=data:text/javascript,export default async function*(){}', 't/'], ['node', '--anything=DATA:x', 'a.mjs'],
    ['ts-node', '-e', '1'], ['npx', 'ts-node', '-e', '1'], ['deno', 'run', 'data:application/javascript,console.log(1)'],
    ['deno', 'run', '-A', 'DATA:application/javascript,1'], ['deno', 'repl', '--eval', '1'],
    ['npx', '-p', 'cowsay', '-c', 'git pu""sh'], ['npm', 'exec', '--package', 'x', '-c', 'echo hi'], ['pnpm', 'exec', '--shell-mode', 'echo hi'],
    ['yarn', 'exec', 'echo hi'], ['npx', 'bash', 'x.sh'], ['git', '-c', 'alias.y=!git pu""sh', 'y'], ['git', '-C', 'src', '-c', 'core.pager=x', 'log'],
    ['git', '--config-env=alias.y=V', 'y'], ['conda', 'run', 'python', '-c', '1'], ['conda', 'run', '-n', 'env', 'python', '-c', '1'],
    ['uvx', 'python', '-c', '1'], ['uv', 'tool', 'run', 'python', '-c', '1'], ['pipx', 'run', 'x', 'python', '-c', '1'], ['timeout', '5', 'node', '-e', '1'],
    ['php', '-r', 'echo(1)'], ['Rscript', '-e', '1'], ['R', '--vanilla', '-e', '1'], ['awk', 'BEGIN{system("calc")}'], ['gawk', '-f', 'p.awk', '-e', '1'],
    ['ruby', '-wE', 'UTF-8', '-e', '1'], ['npx', 'npx', 'npx', 'npx', 'npx', 'npx', 'x']]) {
    assert.equal(verdict(command), 'command refused', JSON.stringify(command));
  }
  for (const command of [['node', '--import', 'tsx', 'x.ts'], ['node', '-r', 'ts-node/register', 'x.ts'], ['ruby', '-E', 'UTF-8', 'x.rb'],
    ['deno', 'run', '-A', 'main.ts', '-p', '8080'], ['deno', 'test', '--filter', 'eval'], ['node', '--expose-internals', 'x.js', '-p', '1'],
    ['awk', '-f', 'p.awk', 'data.txt'], ['git', '-C', 'src', 'log'], ['git', 'switch', '-c', 'topic'], ['npx', 'jest', '-c', 'jest.config.js'],
    ['python', '-m', 'pytest', '-c', 'x'], ['php', 'x.php', '-r'], ['Rscript', 'x.R', '-e']]) {
    assert.equal(verdict(command), 'allowed', JSON.stringify(command));
  }
});

test('a path with a colon is refused by every tool: an NTFS stream is invisible to the tree walk (review 5 P1-1, PoC pocG)', async t => {
  const f = fixture(t); const r = recorder();
  f.write('src/impl.txt', 'host');
  // The tested code reads the stream; a stream write the tree cannot see must never leave this pass current.
  const strict = "import fs from 'node:fs'; let v = ''; try { v = fs.readFileSync('src/impl.txt:code', 'utf8'); } catch {} process.exitCode = v === 'BAD' ? 1 : 0;\n";
  f.write('test.mjs', strict); f.put({ ...f.spec, files: { 'test.mjs': sha(strict) } });
  r.record('eng.tree_state@1', await f.call('tree_state'));
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  await assert.rejects(f.call('write_file', { path: 'src/impl.txt:code', text: 'BAD', expect_digest: '' }), { message: 'path refused' });
  await assert.rejects(f.call('patch_file', { path: 'src/impl.txt:code', old_text: 'host', text: 'BAD', expect_digest: sha('host') }), { message: 'path refused' });
  for (const [tool, args] of [['read', { path: 'src/impl.txt:code' }], ['read_v2', { path: 'src/impl.txt::$DATA' }], ['list', { path: 'src:x' }],
    ['search', { path: 'src/impl.txt:code', query: 'x' }], ['run', { command: 'node -v', cwd: 'src:x' }], ['read_image', { path: 'a.png:x' }]])
    await assert.rejects(f.call(tool, args), { message: 'path refused' }, tool);
  assert.ok(!fs.readdirSync(path.join(f.root, 'src')).some(name => name.includes(':')));
  if (process.platform === 'win32') assert.throws(() => fs.readFileSync(path.join(f.root, 'src/impl.txt:code')), { code: 'ENOENT' });
  assert.deepEqual(r.passing(), ['unit']);
  // An absolute project path (a drive letter on Windows) is unaffected.
  assert.equal((await f.call('read', { path: path.join(f.root, 'src/impl.txt') })).head, 'host');
});

test('the first measurement of a new self- spec is no tree step; an owner spec change still is (review 5 P2-1, PoC pocI)', async t => {
  const f = fixture(t); const r = recorder();
  selfSpec(f, 'x'); selfSpec(f, 'y');
  r.record('eng.tree_state@1', await f.call('tree_state'));
  r.record('eng.test@2', await f.call('test_v2', { check: 'unit' }));
  assert.deepEqual(r.passing(), ['unit']);
  for (const id of ['self-x', 'self-x', 'self-y']) {
    r.record('eng.measure_pinned@1', await f.call('measure_pinned', { spec_id: id }));
    assert.equal((await f.call('tree_state')).rows[0].gen, 0, id);
  }
  assert.ok(fs.existsSync(path.join(f.home, 'specs/self-x.json')));
  assert.deepEqual(r.passing(), ['unit']);
  fs.writeFileSync(path.join(f.home, 'specs/owner.json'), JSON.stringify({ command: ['node', 'measure.mjs'] }));
  const step = r.record('eng.run@1', await f.call('run', { command: 'node -v' }));
  assert.deepEqual([step.rows[0].from_gen, step.rows[0].to_gen], [0, 1]);
  assert.deepEqual(r.passing(), []);
});

test('a job command cannot read the kit home from its supervisor command line (review 5 P2-2)', { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  const f = fixture(t);
  f.write('probe.mjs', process.platform === 'win32'
    ? "import { execFileSync } from 'node:child_process'; console.log(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.ppid}').CommandLine`]).toString());\n"
    : "import fs from 'node:fs'; console.log(fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').replaceAll('\0', ' '));\n");
  const job = await f.call('job_start', { command: 'node probe.mjs' });
  let poll; do poll = await f.call('job_poll', { job_id: job.rows[0].job_id, wait_s: 5 }); while (!['done', 'failed'].includes(poll.rows[0].status));
  assert.equal(poll.rows[0].status, 'done');
  assert.match(poll.head, /supervisor\.mjs/);
  assert.ok(!poll.head.includes(path.basename(f.home)) && !/job-[0-9a-f]{64}/.test(poll.head), poll.head);
});

test('an acceptance spec naming the root .git is refused by field when parsed (review 5 cosmetic)', t => {
  const f = fixture(t);
  for (const cwd of ['.git', '.GIT', '.git/hooks', '.git./x'])
    { f.put({ ...f.spec, cwd }); assert.throws(() => acceptanceSpec(f.ctx, 'unit'), { message: 'acceptance spec invalid: cwd' }, cwd); }
  for (const name of ['.git/config', '.Git/HEAD'])
    { f.put({ ...f.spec, files: { ...f.spec.files, [name]: 'a'.repeat(64) } }); assert.throws(() => acceptanceSpec(f.ctx, 'unit'), { message: 'acceptance spec invalid: files' }, name); }
  f.put({ ...f.spec, files: { ...f.spec.files, '.gitignore': 'a'.repeat(64), 'src/.git/x': 'a'.repeat(64) } });
  assert.equal(Object.keys(acceptanceSpec(f.ctx, 'unit').spec.files).length, 3);
});

test('the README states what a pass means: a fence, not a sandbox (review 5 P2-2, P2-3)', () => {
  const readme = fs.readFileSync(path.join(repo, 'kits/general/README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## What a pass means'), readme.indexOf('## Behaviour'));
  for (const claim of [/fence, not a sandbox/, /forge currency/, /tree cache/, /only as trustworthy as the project scripts/,
    /owner exclusion or the root `\.git`/, /core\.fsmonitor/, /git <alias>/, /not on the list/, /`shell: true` the classifier is advisory/, /printable ASCII/])
    assert.match(section, claim);
  assert.doesNotMatch(readme, /protected by its location/);
});
