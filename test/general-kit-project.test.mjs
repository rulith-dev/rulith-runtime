// The project receipts and the official engineering capability (program v3, Sources v4, official recipe):
// D-1018c supplement (the criterion binds project, check name and spec digest in one key), PSC 0.2.24 ACC-PROJ-05.
// The rules are evaluated here over real receipts by a small interpreter of program-v3.json itself; the Kernel's own
// evaluation of the compiled program is rulith-java's evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { perform } from '../kits/general/adapter.mjs';
import { context, keptProject, projectIdentity, kitId, sha, save, tree, resolveProgram } from '../kits/general/lib.mjs';
import { acceptanceSpec, checkKey, displayRoot } from '../kits/general/acceptance-specs.mjs';
import { buildOfficial, buildPackages, ADOPTED, PROJECT_TOOLS, implementationDigest } from '../kits/general/pack/build-pack.mjs';
import { installGeneral, parseKitInstall } from '../kits/general/installer.mjs';
import { resultFactsFromRows, withImplementationPins, workerToolsOf } from '../worker/rulith-worker.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const kitDir = path.join(repo, 'kits/general');
const packDir = path.join(kitDir, 'pack');
const manifest = JSON.parse(fs.readFileSync(path.join(kitDir, 'worker-tools.json'), 'utf8'));
const tools = manifest.tools;
const committed = name => JSON.parse(fs.readFileSync(path.join(packDir, name), 'utf8'));
const program = committed('program-v3.json');
const ENTRY = { acceptance_v2: 'eng.acceptance@2', test_v3: 'eng.test@3', write_file_v2: 'eng.write_file@2', patch_file_v2: 'eng.patch_file@2',
  apply_patch_v2: 'eng.apply_patch@2', run_v2: 'eng.run@2', job_start_v2: 'eng.job_start@2', job_poll_v2: 'eng.job_poll@2', job_stop_v2: 'eng.job_stop@2',
  test_v2: 'eng.test@2', write_file: 'eng.write_file@1', list: 'eng.list@1' };

function scratchDir(t, prefix) {
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, prefix));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
const passingSpec = { command: [process.execPath, 'test.mjs'], cwd: '.', files: { 'test.mjs': sha('process.exitCode = 0;\n') } };
// One project under a kit home: a passing check `unit`. Several projects may share one kit home.
function project(t, { dir = scratchDir(t, 'project-'), home = path.join(dir, 'home'), name = 'project', source = `src-${name}` } = {}) {
  const root = path.join(dir, name);
  fs.mkdirSync(path.join(root, '.rulith/acceptance'), { recursive: true });
  fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ allowedPaths: [path.dirname(process.execPath)] }));
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, RULITH_SOURCE_NAME: source, ENG_KIT_HOME: home };
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  write('test.mjs', 'process.exitCode = 0;\n');
  const put = (spec = passingSpec, check = 'unit') => write(`.rulith/acceptance/${check}.json`, JSON.stringify(spec));
  put();
  const call = async (entry, args = {}) => {
    const out = await perform(entry, args, env);
    return { out, facts: resultFactsFromRows(tools[ENTRY[entry]], out.rows ?? []) };
  };
  return { dir, root, home, env, ctx: context(env), write, put, call };
}

// program-v3.json evaluated over receipt facts: its rules, then its acceptance bridges (NAF reads receipts only).
function evaluate(facts, acceptance = []) {
  const alias = new Map(program.vocabulary.defines.map(d => [d.id, d.as]));
  const base = [...facts.map(f => ({ predicate: alias.get(f.predicate) ?? f.predicate, args: f.args })), ...acceptance];
  const match = (pattern, fact, bound) => {
    if (fact.predicate !== pattern.predicate) return null;
    const out = { ...bound };
    for (const [name, value] of Object.entries(pattern.args)) {
      if (!Object.hasOwn(fact.args, name)) return null;
      if (typeof value === 'string' && value.startsWith('?')) {
        if (Object.hasOwn(out, value) ? out[value] !== fact.args[name] : (out[value] = fact.args[name], false)) return null;
      } else if (value !== fact.args[name]) return null;
    }
    return out;
  };
  const solve = (known, [first, ...rest], bound) => !first ? [bound]
    : first.naf ? (known.some(f => match(first, f, bound)) ? [] : solve(known, rest, bound))
      : known.flatMap(f => { const next = match(first, f, bound); return next ? solve(known, rest, next) : []; });
  const fire = (known, rules) => rules.flatMap(rule => solve(known, rule.when, {}).flatMap(bound => rule.then.map(head =>
    ({ predicate: head.predicate, args: Object.fromEntries(Object.entries(head.args).map(([k, v]) => [k, bound[v] ?? v])) }))));
  const derived = fire(base, program.rules);
  const bridged = fire([...base, ...derived], program.acceptance);
  return {
    passed: new Set(derived.filter(f => f.predicate === 'eng_check_passed').map(f => f.args.key)),
    met: new Set(bridged.filter(f => f.predicate === 'acceptance_met').map(f => f.args.node)),
  };
}

test('project receipts: eng.acceptance@2 and eng.test@3 carry the check key; every project tool reports its project', async t => {
  const p = project(t, { source: 'project-alpha' });
  const digest = acceptanceSpec(p.ctx, 'unit').digest;
  assert.equal(keptProject(p.ctx), undefined, 'a project identity before any project tool ran');
  const listed = await p.call('acceptance_v2');
  // The first project tool fixes the identity (kit-id and the identity spelling of the root) and records it.
  const id = keptProject(p.ctx);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, sha(`${kitId(p.home)}\n${p.ctx.folded}`));
  const key = `${id}:unit:${digest}`;
  assert.equal(checkKey(id, 'unit', digest), key);
  assert.deepEqual(listed.facts.map(f => [f.predicate, Object.keys(f.args)]),
    [['eng.check_spec', ['key', 'source_name', 'project_root', 'check', 'spec_digest', 'command', 'cwd', 'shell', 'files']]]);
  assert.equal(listed.facts[0].args.key, key);
  // The signer reads which project the key names: the Source and the root, not only a digest.
  assert.equal(listed.facts[0].args.source_name, 'project-alpha');
  assert.equal(listed.facts[0].args.project_root, displayRoot(p.ctx.canonical));
  assert.ok(listed.facts[0].args.project_root.endsWith('/project'));
  const ran = await p.call('test_v3', { check: 'unit' });
  assert.deepEqual(ran.facts, [
    { predicate: 'eng.check_result', args: { key, project: id, check: 'unit', spec_digest: digest, gen: 0, tree_digest: ran.out.rows[0].tree_digest, exit_code: 0 } },
    { predicate: 'eng.tree_step', args: { project: id, from_gen: -1, to_gen: -1 } },
  ]);
  const wrote = await p.call('write_file_v2', { path: 'a.txt', text: 'a', expect_digest: '' });
  assert.deepEqual(wrote.facts.filter(f => f.predicate === 'eng.tree_step').map(f => f.args), [{ project: id, from_gen: 0, to_gen: 1 }]);
  // Later receipts also replay the first step after the passing check (0 -> 1), with the project too.
  const patched = await p.call('patch_file_v2', { path: 'a.txt', old_text: 'a', text: 'b', expect_digest: sha('a') });
  assert.deepEqual(patched.facts.filter(f => f.predicate === 'eng.tree_step').map(f => f.args),
    [{ project: id, from_gen: 0, to_gen: 1 }, { project: id, from_gen: 1, to_gen: 2 }]);
  const patch = await p.call('apply_patch_v2', { patch: '*** Begin Patch\n*** Add File: c.txt\n+c\n*** End Patch' });
  assert.deepEqual(patch.facts.filter(f => f.predicate === 'eng.tree_step').map(f => f.args),
    [{ project: id, from_gen: 0, to_gen: 1 }, { project: id, from_gen: 2, to_gen: 3 }]);
  const node = `"${process.execPath}" test.mjs`;
  const run = await p.call('run_v2', { command: node, cwd: '.' });
  assert.deepEqual(run.facts.filter(f => f.predicate === 'eng.tree_step').map(f => f.args),
    [{ project: id, from_gen: 0, to_gen: 1 }, { project: id, from_gen: -1, to_gen: -1 }]);
  // Every row of a project receipt names the project, so every eng.tree_step fact does.
  for (const receipt of [ran, wrote, patched, patch, run]) assert.ok(receipt.out.rows.every(row => row.project === id));
  // The versions without a project keep their receipts exactly (on a root no project tool has used).
  const plain = project(t, { name: 'plain' });
  const legacy = await plain.call('test_v2', { check: 'unit' });
  assert.ok(legacy.out.rows.every(row => Object.keys(row).sort().join() === 'check,exit_code,from_gen,gen,spec_digest,to_gen,tree_digest'));
  assert.deepEqual([...new Set(legacy.facts.map(f => Object.keys(f.args).join()))], ['check,spec_digest,gen,tree_digest,exit_code', 'from_gen,to_gen']);
  assert.equal(keptProject(plain.ctx), undefined);
  // Jobs: the job tools of a project share its job file and report its steps.
  const job = await p.call('job_start_v2', { command: node, cwd: '.' });
  assert.equal(job.out.rows[0].project, id);
  let polled;
  for (let i = 0; i < 50 && (!polled || polled.out.rows[0].status !== 'done'); i++) polled = await p.call('job_poll_v2', { job_id: job.out.rows[0].job_id, wait_s: 1 });
  assert.equal(polled.out.rows[0].status, 'done');
  assert.ok(polled.facts.filter(f => f.predicate === 'eng.tree_step').every(f => f.args.project === id));
  await assert.rejects(p.call('job_stop_v2', { job_id: 'another' }), /job refused/);
});

test('the key binds the spec: a looser spec written after signing has another key and cannot fulfil the signed leaf', async t => {
  const p = project(t);
  const signed = (await p.call('acceptance_v2')).facts[0].args.key;
  const strict = await p.call('test_v3', { check: 'unit' });
  assert.deepEqual([...evaluate(strict.facts, [{ predicate: 'acceptance', args: { node: 'leaf', test: signed } }]).met], ['leaf']);
  // The model weakens the check under the same name: a command that always passes, another spec digest.
  p.write('pass.mjs', 'process.exitCode = 0;\n');
  p.put({ command: [process.execPath, 'pass.mjs'], cwd: '.', files: { 'pass.mjs': sha('process.exitCode = 0;\n') } });
  const looser = (await p.call('acceptance_v2')).facts[0].args.key;
  assert.notEqual(looser, signed);
  assert.deepEqual(looser.split(':').slice(0, 2), signed.split(':').slice(0, 2), 'same project and check name');
  // The weakening is a write: it withdraws the strict pass; the loose pass is current but of another key.
  const write = await p.call('write_file_v2', { path: 'note.txt', text: 'x', expect_digest: '' });
  const loose = await p.call('test_v3', { check: 'unit' });
  assert.equal(loose.facts[0].args.key, looser);
  const board = evaluate([...strict.facts, ...write.facts, ...loose.facts], [{ predicate: 'acceptance', args: { node: 'leaf', test: signed } }]);
  assert.deepEqual([...board.passed], [looser]);
  assert.deepEqual([...board.met], [], 'a pass of the looser spec fulfilled the leaf signed for the strict one');
});

test('two projects under one kit home keep separate generations and keys; only a step of the same project withdraws a pass', async t => {
  const dir = scratchDir(t, 'projects-');
  const p1 = project(t, { dir, name: 'one' }), p2 = project(t, { dir, name: 'two' });
  assert.equal(p1.home, p2.home);
  assert.notEqual(p1.ctx.stateFile, p2.ctx.stateFile);
  assert.notEqual(p1.ctx.cacheFile, p2.ctx.cacheFile);
  // The same spec bytes in both projects: one spec digest, two keys.
  const [k1, k2] = [(await p1.call('acceptance_v2')).facts[0].args.key, (await p2.call('acceptance_v2')).facts[0].args.key];
  const [id1, id2] = [keptProject(p1.ctx), keptProject(p2.ctx)];
  assert.notEqual(id1, id2);
  assert.equal(k1.split(':')[2], k2.split(':')[2]);
  assert.notEqual(k1, k2);
  const leaves = [{ predicate: 'acceptance', args: { node: 'L1', test: k1 } }, { predicate: 'acceptance', args: { node: 'L2', test: k2 } }];
  const r1 = await p1.call('test_v3', { check: 'unit' }), r2 = await p2.call('test_v3', { check: 'unit' });
  // Both counters start at generation 0: before, a step at 0 in one project withdrew the other's pass at 0.
  assert.deepEqual([r1.facts[0].args.gen, r2.facts[0].args.gen], [0, 0]);
  let facts = [...r1.facts, ...r2.facts];
  assert.deepEqual([...evaluate(facts, leaves).met].sort(), ['L1', 'L2']);
  // P1's check result does not fulfil P2's leaf: with P2's pass absent only L1 holds.
  assert.deepEqual([...evaluate(r1.facts, leaves).met], ['L1']);
  // And the other way round: P2's check result does not fulfil P1's leaf.
  assert.deepEqual([...evaluate(r2.facts, leaves).met], ['L2']);
  // A write in P2 steps P2 from 0 and withdraws P2's pass only.
  const w2 = await p2.call('write_file_v2', { path: 'x.txt', text: 'x', expect_digest: '' });
  assert.deepEqual(w2.facts.find(f => f.predicate === 'eng.tree_step').args, { project: id2, from_gen: 0, to_gen: 1 });
  facts = [...facts, ...w2.facts];
  assert.deepEqual([...evaluate(facts, leaves).met], ['L1']);
  assert.equal(JSON.parse(fs.readFileSync(p1.ctx.stateFile, 'utf8')).gen, 0, 'P2 moved P1 generation counter');
  // P1's own write withdraws P1's pass.
  const w1 = await p1.call('write_file_v2', { path: 'y.txt', text: 'y', expect_digest: '' });
  assert.deepEqual(w1.facts.find(f => f.predicate === 'eng.tree_step').args, { project: id1, from_gen: 0, to_gen: 1 });
  assert.deepEqual([...evaluate([...facts, ...w1.facts], leaves).met], []);
  // The other way round: with P1's step alone, only P1's pass is withdrawn and P2's leaf still holds.
  assert.deepEqual([...evaluate([...r1.facts, ...r2.facts, ...w1.facts], leaves).met], ['L2']);
});

test('two kit homes give one directory two identities; kit-id is written whole by rename, and a damaged or lost one is rewritten', async t => {
  const dir = scratchDir(t, 'homes-');
  const a = project(t, { dir, home: path.join(dir, 'home-a') });
  const b = project(t, { dir, home: path.join(dir, 'home-b') });
  assert.equal(a.root, b.root);
  assert.equal(fs.existsSync(path.join(a.home, 'kit-id')), false, 'context alone made a kit identity');
  await a.call('acceptance_v2'); await b.call('acceptance_v2');
  assert.notEqual(keptProject(b.ctx), keptProject(a.ctx), 'one directory under two kit homes (or the same path on two devices) is one project');
  // kit-id never appears partly written: it is written to a temporary file and renamed, never written in place.
  const c = path.join(dir, 'home-c'); fs.mkdirSync(c);
  const target = path.join(c, 'kit-id'), write = fs.writeFileSync, rename = fs.renameSync, link = fs.linkSync;
  const direct = [];
  fs.writeFileSync = (file, ...rest) => { if (path.resolve(String(file)) === target) direct.push(file); return write(file, ...rest); };
  fs.linkSync = () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); };
  let crashed = false;
  fs.renameSync = (from, to) => { if (!crashed && path.resolve(String(to)) === target) { crashed = true; throw Object.assign(new Error('fixture crash'), { code: 'EIO' }); } return rename(from, to); };
  try {
    assert.throws(() => kitId(c), /fixture crash/);
    assert.deepEqual(fs.readdirSync(c), [], 'a crash left a partial identity or its temporary file');
    // The next use is not wedged: it writes a whole identity.
    const id = kitId(c);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(kitId(c), id);
  } finally { fs.writeFileSync = write; fs.renameSync = rename; fs.linkSync = link; }
  assert.deepEqual(direct, [], 'kit-id was written in place');
  assert.deepEqual(fs.readdirSync(c), ['kit-id']);
  // A damaged kit-id is rewritten when a new project needs it; the identity already fixed for a project does not change.
  const fixed = keptProject(a.ctx);
  fs.writeFileSync(path.join(a.home, 'kit-id'), 'not an identity');
  await a.call('acceptance_v2');
  assert.equal(keptProject(a.ctx), fixed);
  const later = project(t, { dir, home: a.home, name: 'later' });
  await later.call('acceptance_v2');
  assert.match(fs.readFileSync(path.join(a.home, 'kit-id'), 'utf8'), /^[0-9a-f-]{36}$/);
  assert.equal(keptProject(later.ctx), sha(`${kitId(a.home)}\n${later.ctx.folded}`));
  // Tools without a project never need the identity.
  const plain = project(t, { name: 'plain' });
  fs.rmSync(path.join(plain.home, 'kit-id'), { force: true });
  await perform('write_file', { path: 'z.txt', text: 'z', expect_digest: '' }, plain.env);
  assert.equal(fs.existsSync(path.join(plain.home, 'kit-id')), false);
});

test('an identity change never leaves a pass current: removing kit-id or the state file still withdraws it on the next step', async t => {
  const p = project(t);
  const key = (await p.call('acceptance_v2')).facts[0].args.key, id = keptProject(p.ctx);
  const leaf = [{ predicate: 'acceptance', args: { node: 'leaf', test: key } }];
  const pass = await p.call('test_v3', { check: 'unit' });
  let facts = [...pass.facts];
  assert.deepEqual([...evaluate(facts, leaf).met], ['leaf']);
  // kit-id removed (or replaced): the identity stays with the counter, so the next write still names it.
  fs.rmSync(path.join(p.home, 'kit-id'));
  assert.equal((await p.call('acceptance_v2')).facts[0].args.key, key, 'removing kit-id gave the project a new key');
  const w1 = await p.call('write_file_v2', { path: 'a.txt', text: 'a', expect_digest: '' });
  assert.deepEqual(w1.facts.find(f => f.predicate === 'eng.tree_step').args, { project: id, from_gen: 0, to_gen: 1 });
  facts = [...facts, ...w1.facts];
  assert.deepEqual([...evaluate(facts, leaf).met], [], 'the pass outlived a write after kit-id was removed');
  // A new pass, then the state file is lost (and kit-id too): the root record keeps the identity and the last
  // generation, and the next receipt steps out of that generation instead of restarting at 0.
  const again = await p.call('test_v3', { check: 'unit' });
  assert.equal(again.facts[0].args.gen, 1);
  facts = [...facts, ...again.facts];
  assert.deepEqual([...evaluate(facts, leaf).met], ['leaf']);
  fs.rmSync(p.ctx.stateFile); fs.rmSync(path.join(p.home, 'kit-id'), { force: true });
  const w2 = await p.call('write_file_v2', { path: 'b.txt', text: 'b', expect_digest: '' });
  assert.deepEqual(w2.facts.filter(f => f.predicate === 'eng.tree_step').map(f => f.args), [{ project: id, from_gen: 1, to_gen: 2 }]);
  facts = [...facts, ...w2.facts];
  assert.deepEqual([...evaluate(facts, leaf).met], [], 'the pass outlived a lost state file');
  assert.equal(keptProject(p.ctx), id);
  // Even a read first after the loss records the step, and the next receipt replays it.
  const third = await p.call('test_v3', { check: 'unit' });
  fs.rmSync(p.ctx.stateFile);
  await p.call('list', { path: '.' });
  const w3 = await p.call('write_file_v2', { path: 'c.txt', text: 'c', expect_digest: '' });
  assert.ok(w3.facts.some(f => f.predicate === 'eng.tree_step' && f.args.project === id && f.args.from_gen === third.facts[0].args.gen));
});

test('Windows: a case-only rename and other spellings of one directory are one project with one counter',
  { skip: process.platform !== 'win32' && 'paths ignore case on Windows only' }, async t => {
    const dir = scratchDir(t, 'case-');
    const p = project(t, { dir, name: 'CaseRoot' });
    const key = (await p.call('acceptance_v2')).facts[0].args.key, id = keptProject(p.ctx);
    const pass = await p.call('test_v3', { check: 'unit' });
    // Renamed on disk to another case: the native spelling changes, the identity spelling does not.
    const renamed = path.join(dir, 'caseroot');
    fs.renameSync(p.root, renamed);
    const env = { ...p.env, RULITH_SOURCE_ACCESS: renamed };
    const ctx = context(env);
    assert.notEqual(ctx.canonical, p.ctx.canonical);
    assert.equal(ctx.stateFile, p.ctx.stateFile);
    assert.equal(keptProject(ctx), id);
    assert.equal(resultFactsFromRows(tools['eng.acceptance@2'], (await perform('acceptance_v2', {}, env)).rows)[0].args.key, key);
    const write = await perform('write_file_v2', { path: 'n.txt', text: 'n', expect_digest: '' }, env);
    const facts = [...pass.facts, ...resultFactsFromRows(tools['eng.write_file@2'], write.rows)];
    assert.deepEqual([...evaluate(facts, [{ predicate: 'acceptance', args: { node: 'leaf', test: key } }]).met], [], 'the pass outlived the rename');
    // Another spelling of the same directory (upper case, as a caller may pass it) is the same project too.
    const upper = context({ ...env, RULITH_SOURCE_ACCESS: renamed.toUpperCase() });
    assert.equal(upper.stateFile, ctx.stateFile);
    assert.equal(projectIdentity(upper), id);
  });

test('Windows: a counter and a running job kept under the caller\'s former spelling are continued and still found',
  { skip: process.platform !== 'win32' && 'the root spelling differs from its identity spelling on Windows only' }, async t => {
    const p = project(t);
    assert.ok(p.ctx.spelledStateFile && p.ctx.spelledJobFile, 'the fixture root is already in its identity spelling');
    // Upgrade: the counter kept under the spelling the Source used before is continued, not restarted at 0.
    save(p.ctx.spelledStateFile, { gen: 7, digest: tree(p.ctx).digest });
    const step = await p.call('write_file_v2', { path: 'n.txt', text: 'n', expect_digest: '' });
    assert.deepEqual([step.out.rows[0].from_gen, step.out.rows[0].to_gen], [7, 8]);
    assert.equal(JSON.parse(fs.readFileSync(p.ctx.stateFile, 'utf8')).gen, 8);
    // A job still running under the former spelling keeps writes and runs out, and poll reaches it.
    const job = { id: '11111111-1111-4111-8111-111111111111', status: 'running', command: ['x'], before: '', exit_code: -1 };
    save(p.ctx.spelledJobFile, job);
    await assert.rejects(p.call('write_file_v2', { path: 'm.txt', text: 'm', expect_digest: '' }), /job live/);
    const polled = await p.call('job_poll_v2', { job_id: job.id, wait_s: 0 });
    assert.equal(polled.out.rows[0].status, 'running');
  });

test('Windows: a pre-upgrade state file left beside the root record never outranks it; it is retired once migrated',
  { skip: process.platform !== 'win32' && 'the root spelling differs from its identity spelling on Windows only' }, async t => {
    const p = project(t);
    assert.ok(p.ctx.spelledStateFile, 'the fixture root is already in its identity spelling');
    // Upgrade: the former spelling's counter (generation 3) is migrated, then retired.
    save(p.ctx.spelledStateFile, { gen: 3, digest: tree(p.ctx).digest });
    const key = (await p.call('acceptance_v2')).facts[0].args.key;
    const pass = await p.call('test_v3', { check: 'unit' });
    assert.equal(pass.facts[0].args.gen, 3);
    assert.equal(fs.existsSync(p.ctx.spelledStateFile), false, 'the migrated state under the former spelling was kept');
    // A leftover with a smaller generation reappears (an older copy, a restore) and the current state is lost.
    save(p.ctx.spelledStateFile, { gen: 1, digest: tree(p.ctx).digest });
    fs.rmSync(p.ctx.stateFile);
    const write = await p.call('write_file_v2', { path: 'n.txt', text: 'n', expect_digest: '' });
    assert.deepEqual(write.facts.filter(f => f.predicate === 'eng.tree_step').map(f => [f.args.from_gen, f.args.to_gen]), [[3, 4]]);
    assert.deepEqual([...evaluate([...pass.facts, ...write.facts], [{ predicate: 'acceptance', args: { node: 'leaf', test: key } }]).met], [],
      'the pass outlived a write because a leftover counter replaced the lost one');
    // A leftover with a larger generation wins the other way: the counter resumes above both.
    save(p.ctx.spelledStateFile, { gen: 9, digest: tree(p.ctx).digest });
    fs.rmSync(p.ctx.stateFile);
    const again = await p.call('write_file_v2', { path: 'm.txt', text: 'm', expect_digest: '' });
    assert.deepEqual(again.facts.filter(f => f.predicate === 'eng.tree_step').map(f => [f.args.from_gen, f.args.to_gen]), [[9, 10]]);
  });

test('nested project roots under one kit home are refused, either way round; a refused root leaves no record behind', async t => {
  const dir = scratchDir(t, 'nested-');
  const outer = project(t, { dir, name: 'wrap/outer' });
  await outer.call('acceptance_v2');
  const innerRoot = path.join(outer.root, 'pkg'); fs.mkdirSync(innerRoot);
  const inner = { ...outer.env, RULITH_SOURCE_ACCESS: innerRoot };
  const records = () => fs.readdirSync(outer.home).filter(name => name.startsWith('root-')).sort();
  const before = records();
  assert.throws(() => context(inner), /project root overlaps another project/);
  await assert.rejects(perform('write_file_v2', { path: 'x.txt', text: 'x', expect_digest: '' }, inner), /project root overlaps another project/);
  // Older tool versions are refused there too, and the refusal is the adapter's visible verdict.
  const cli = spawnSync(process.execPath, [path.join(kitDir, 'write_file.mjs'), JSON.stringify({ path: 'x.txt', text: 'x', expect_digest: '' })],
    { env: inner, encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(cli.stdout).verdict, 'project root overlaps another project');
  assert.deepEqual(records(), before, 'a refused root left its record');
  assert.equal(fs.existsSync(path.join(innerRoot, 'x.txt')), false);
  // The outer project still works; a root around a recorded one is refused as well.
  await outer.call('write_file_v2', { path: 'y.txt', text: 'y', expect_digest: '' });
  const wrapper = { ...outer.env, RULITH_SOURCE_ACCESS: path.join(dir, 'wrap') };
  assert.throws(() => context(wrapper), /project root overlaps another project/);
  // A sibling is no overlap; once the owner removes the outer record, the inner directory may become a project.
  project(t, { dir, name: 'wrap-sibling' });
  fs.rmSync(outer.ctx.rootFile);
  assert.equal(context(inner).root, fs.realpathSync(innerRoot));
});

test('once a root has a project identity, older versions that write, run or test are refused; reads still work', async t => {
  const p = project(t);
  const key = (await p.call('acceptance_v2')).facts[0].args.key;
  const pass = await p.call('test_v3', { check: 'unit' });
  for (const [entry, args] of [['write_file', { path: 'a.txt', text: 'a', expect_digest: '' }], ['test_v2', { check: 'unit' }],
    ['run', { command: `"${process.execPath}" test.mjs`, cwd: '.' }], ['apply_patch', { patch: '*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch' }]])
    await assert.rejects(perform(entry, args, p.env), /project tools required/, entry);
  assert.equal(fs.existsSync(path.join(p.root, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(p.root, 'b.txt')), false);
  assert.equal((await p.call('list', { path: '.' })).out.rows.some(row => row.path === 'test.mjs'), true);
  // The pass therefore still describes the tree it was made on.
  assert.deepEqual([...evaluate(pass.facts, [{ predicate: 'acceptance', args: { node: 'leaf', test: key } }]).met], ['leaf']);
  assert.equal(tree(p.ctx).digest, pass.out.rows[0].tree_digest);
});

test('a spec command that finds a program inside the project needs that program in files', async t => {
  const p = project(t);
  const exe = process.platform === 'win32' ? '.exe' : '';
  p.write(`bin/probe${exe}`, 'not a program\n');
  if (!exe) fs.chmodSync(path.join(p.root, 'bin/probe'), 0o755); // execvp only runs executable files
  const digest = sha('not a program\n');
  // Named with a path: resolved against the spec cwd.
  p.put({ command: [`bin/probe${exe}`, 'test.mjs'], cwd: '.', files: passingSpec.files });
  await assert.rejects(p.call('test_v3', { check: 'unit' }), { message: 'acceptance spec invalid: command program must be listed in files' });
  p.put({ command: [`bin/probe${exe}`, 'test.mjs'], cwd: '.', files: { ...passingSpec.files, [`bin/probe${exe}`]: digest } });
  await assert.rejects(p.call('test_v3', { check: 'unit' }), error => error.message !== 'acceptance spec invalid: command program must be listed in files');
  // A bare name found on a PATH entry inside the project counts the same.
  const env = { ...p.env, PATH: `${path.join(p.root, 'bin')}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}` };
  delete env.Path;
  p.put({ command: ['probe', 'test.mjs'], cwd: '.', files: passingSpec.files });
  const saved = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    assert.equal(resolveProgram('probe', p.root), fs.realpathSync(path.join(p.root, `bin/probe${exe}`)));
    await assert.rejects(perform('test_v3', { check: 'unit' }, env), { message: 'acceptance spec invalid: command program must be listed in files' });
  } finally { process.env.PATH = saved; }
  // A program outside the project (node itself) needs nothing more.
  p.put();
  assert.equal((await p.call('test_v3', { check: 'unit' })).out.rows[0].exit_code, 0);
});

// PATH for one call: the adapter resolves and runs with this process's environment.
async function withPath(entries, action) {
  const saved = process.env.PATH;
  process.env.PATH = [...entries, saved ?? ''].join(path.delimiter);
  try { return await action(); } finally { process.env.PATH = saved; }
}

test('Windows: without a shell a bare name is found as libuv finds it (.com, .exe; never .cmd), so the program that runs is the one checked',
  { skip: process.platform !== 'win32' && 'PATHEXT and .com/.exe lookup are Windows only' }, async t => {
    const dir = scratchDir(t, 'lookup-');
    const p = project(t, { dir, name: 'proj' });
    // Earlier on PATH, outside the project: probe.cmd, which cmd.exe would run but libuv never does. Later, inside
    // the project: probe.exe, which libuv runs.
    const outside = path.join(dir, 'tools'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'probe.cmd'), '@exit 0\r\n');
    p.write('bin/probe.exe', 'not a program\n');
    p.write('bin/lone.cmd', '@exit 0\r\n');
    p.put({ command: ['probe', 'test.mjs'], cwd: '.', files: passingSpec.files });
    await withPath([outside, path.join(p.root, 'bin')], async () => {
      assert.equal(resolveProgram('probe', p.root), fs.realpathSync(path.join(p.root, 'bin/probe.exe')));
      assert.equal(resolveProgram('lone', p.root), undefined, 'a .cmd file found by PATHEXT, which libuv would not start');
      await assert.rejects(p.call('test_v3', { check: 'unit' }), { message: 'acceptance spec invalid: command program must be listed in files' });
    });
  });

test('with shell: true every word of the line is checked against every program it could start', async t => {
  const p = project(t);
  fs.writeFileSync(path.join(p.home, 'settings.json'), JSON.stringify({ allowedPaths: [path.dirname(process.execPath)], shell: true }));
  const windows = process.platform === 'win32';
  const name = windows ? 'bin/probe.cmd' : 'bin/probe';
  p.write(name, windows ? '@exit 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!windows) fs.chmodSync(path.join(p.root, name), 0o755);
  // The second program of the line, by bare name on a PATH entry inside the project.
  const line = `"${process.execPath}" test.mjs && probe`;
  p.put({ command: line, shell: true, cwd: '.', files: passingSpec.files });
  await withPath([path.join(p.root, 'bin')], async () => {
    await assert.rejects(p.call('test_v3', { check: 'unit' }), { message: 'acceptance spec invalid: command program must be listed in files' });
    // Listed, its bytes are frozen: the check runs.
    p.put({ command: line, shell: true, cwd: '.', files: { ...passingSpec.files, [name]: sha(fs.readFileSync(path.join(p.root, name))) } });
    assert.equal((await p.call('test_v3', { check: 'unit' })).out.rows[0].exit_code, 0);
  });
});

test('Windows: a program in the check\'s working directory never stands in for one on PATH',
  { skip: process.platform !== 'win32' && 'only Windows looks up programs in the current directory' }, async t => {
    const p = project(t);
    // node.exe in the project root is another program (hostname.exe), whose run would not exit 0.
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), path.join(p.root, 'node.exe'));
    p.put({ command: ['node', 'test.mjs'], cwd: '.', files: passingSpec.files });
    // The adapter as the Worker starts it, from an environment that does not already switch the lookup off.
    const env = Object.fromEntries(Object.entries(p.env).filter(([name]) => name.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
    const run = spawnSync(process.execPath, [path.join(kitDir, 'test_v3.mjs'), JSON.stringify({ check: 'unit' })], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).rows[0].exit_code, 0, 'the project node.exe ran in place of node');
  });

test('each project root keeps its own tree cache, so alternating projects do not evict each other', async t => {
  const dir = scratchDir(t, 'cache-');
  const p1 = project(t, { dir, name: 'one' }), p2 = project(t, { dir, name: 'two' });
  p1.write('only-one.txt', '1'); p2.write('only-two.txt', '2');
  tree(p1.ctx); tree(p2.ctx);
  assert.notEqual(p1.ctx.cacheFile, p2.ctx.cacheFile);
  const cached = file => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(cached(p1.ctx.cacheFile).includes('only-one.txt'), 'walking another project evicted this one');
  assert.ok(cached(p2.ctx.cacheFile).includes('only-two.txt'));
  assert.equal(cached(p1.ctx.cacheFile).includes('only-two.txt'), false);
});

test('a spec whose eng.check_spec row no longer fits the receipt once it carries the key is refused by eng.test@3 too', async t => {
  const p = project(t);
  const spec = pad => ({ ...passingSpec, command: [...passingSpec.command, 'x'.repeat(pad)] });
  const listed = async (entry, pad) => { p.put(spec(pad)); return (await perform(entry, {}, p.env)).rows.length === 1; };
  // The longest padding eng.acceptance@1 still reports in full.
  let low = 1, high = 8000;
  assert.ok(await listed('acceptance', low) && !(await listed('acceptance', high)));
  while (high - low > 1) { const middle = (low + high) >> 1; if (await listed('acceptance', middle)) low = middle; else high = middle; }
  p.put(spec(low));
  assert.deepEqual((await perform('acceptance_v2', {}, p.env)).errors, [{ error: 'acceptance spec too large', check: 'unit' }]);
  await assert.rejects(p.call('test_v3', { check: 'unit' }), /acceptance spec too large/);
});

test('a project patch counts its project in the inline receipt budget and is refused before writing when it would not fit', async t => {
  const dir = scratchDir(t, 'budget-');
  // The version without a project runs on a root no project tool has used; the project version on a project root.
  const p = project(t, { dir, name: 'proj' }), bare = project(t, { dir, name: 'bare' });
  await p.call('acceptance_v2');
  const id = keptProject(p.ctx);
  let attempts = 0;
  // Four files, an invalidation replay and the mutation: two edges per file, as the preflight budgets.
  const attempt = async (entry, length, f = entry === 'apply_patch' ? bare : p) => {
    const names = Array.from({ length: 4 }, (_, i) => `${String(attempts).padStart(3, '0')}${i}-${'x'.repeat(length)}`);
    attempts++;
    for (const name of names) f.write(name, 'a\n');
    save(f.ctx.stateFile, { gen: 1, digest: tree(f.ctx).digest, test_gen: 0, invalidation: { from_gen: 0, to_gen: 1 } });
    const patch = `*** Begin Patch\n${names.map(name => `*** Update File: ${name}\n@@\n-a\n+b`).join('\n')}\n*** End Patch`;
    try { return await perform(entry, { patch }, f.env); }
    catch (error) {
      assert.match(error.message, /patch file count refused/);
      for (const name of names) { assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), 'a\n'); fs.rmSync(path.join(f.root, name)); }
      return null;
    }
  };
  // The longest file names each version admits.
  const longest = async entry => {
    let low = 1, high = 200, out = await attempt(entry, low);
    assert.ok(out && !(await attempt(entry, high)), 'the search range does not straddle the budget');
    while (high - low > 1) {
      const middle = (low + high) >> 1, admitted = await attempt(entry, middle);
      if (admitted) { low = middle; out = admitted; } else high = middle;
    }
    return { length: low, out };
  };
  const plain = await longest('apply_patch'), projected = await longest('apply_patch_v2');
  assert.ok(projected.length < plain.length, 'the project rows cost nothing in the preflight budget');
  const { out } = projected;
  assert.equal(out.rows.length, 8);
  assert.ok(out.rows.every(row => row.project === id));
  const facts = resultFactsFromRows(tools['eng.apply_patch@2'], out.rows);
  assert.ok(Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), facts })) < 8192);
});

test('build-pack is deterministic; program-v3, sources-v4 and the official recipe are its committed output; v2 bytes unchanged', () => {
  const once = buildOfficial(manifest, kitDir), twice = buildOfficial(structuredClone(manifest), kitDir);
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  for (const [name, value] of [['program-v3.json', once.program], ['sources-v4.json', once.sources], ['official-recipe.json', once.recipe]])
    assert.equal(fs.readFileSync(path.join(packDir, name), 'utf8'), JSON.stringify(value, null, 2) + '\n', `${name} is stale: run node kits/general/pack/build-pack.mjs`);
  const v2 = buildPackages(manifest);
  assert.equal(fs.readFileSync(path.join(packDir, 'program-v2.json'), 'utf8'), JSON.stringify(v2.program, null, 2) + '\n');
  assert.equal(fs.readFileSync(path.join(packDir, 'sources-v3.json'), 'utf8'), JSON.stringify(v2.sources, null, 2) + '\n');
  assert.deepEqual(once.recipe.program, once.program);
  assert.deepEqual(once.recipe.sources, once.sources);
  assert.deepEqual(Object.keys(once.recipe), ['provenance', 'capability', 'program', 'sources']);
  assert.deepEqual(Object.keys(once.recipe.capability), ['id', 'version', 'title', 'summary']);
  assert.equal(once.recipe.capability.id, once.program.id);
  assert.equal(once.recipe.capability.summary, once.program.summary);
});

/** The general kit installed by the real installer into a fresh Worker root, as `rulith kit install general` does. */
function installedKit(t) {
  const dir = scratchDir(t, 'install-');
  const manager = path.join(dir, 'manager'), agent = path.join(dir, 'agent'), worker = path.join(dir, 'worker'), home = path.join(dir, 'kit-home');
  for (const directory of [manager, agent, worker, path.join(home, 'specs')]) fs.mkdirSync(directory, { recursive: true });
  const toolsFile = path.join(worker, 'worker-tools.json');
  fs.writeFileSync(path.join(manager, 'registry.json'), JSON.stringify({ instances: [{ mode: 'local_agent', agentName: 'Fixture', directory: agent }] }));
  fs.writeFileSync(path.join(agent, 'local.json'), JSON.stringify({ worker: { env: { RULITH_WORKER_ROOT: worker, RULITH_TOOLS_FILE: toolsFile } } }));
  installGeneral(parseKitInstall(['--agent', 'Fixture', '--kit-home', home, '--manager-home', manager]));
  return { worker, manifest: JSON.parse(fs.readFileSync(toolsFile, 'utf8')) };
}

test('the recipe adopts the current tools for direct use; each digest is what the Worker advertises for the installed kit', t => {
  const recipe = committed('official-recipe.json');
  const [template, ...others] = recipe.sources.sources;
  assert.deepEqual(others, []);
  assert.equal(template.name, 'project'); assert.equal(template.type, 'file'); assert.deepEqual(template.accessModes, []);
  assert.deepEqual(template.toolAdoption.map(row => row.id), ADOPTED);
  assert.equal(ADOPTED.length, 15);
  for (const id of ['eng.read@1', 'eng.test@1', 'eng.test@2', 'eng.measure_pinned@1', 'web.fetch@1', 'web.search@1', 'eng.write_file@1', 'eng.run@1', 'eng.acceptance@1'])
    assert.equal(ADOPTED.includes(id), false, id);
  for (const id of PROJECT_TOOLS) assert.ok(ADOPTED.includes(id), id);
  assert.ok(template.toolAdoption.every(row => row.directUse === true && /^[0-9a-f]{64}$/.test(row.digest)));
  // The Source accredits exactly the adopted tools' receipt words.
  assert.deepEqual(template.words, [...new Set(ADOPTED.flatMap(id => tools[id].returns.map(row => row.predicate)))].sort());
  // The real installer, then the Worker's own pinning at start: the advertised digest of every adopted tool.
  const { worker, manifest: installed } = installedKit(t);
  const refused = [];
  const advertised = withImplementationPins(workerToolsOf(installed), worker, (id, error) => refused.push(`${id}: ${error.message}`));
  assert.deepEqual(refused, []);
  for (const row of template.toolAdoption) assert.equal(advertised[row.id].digest, row.digest, `${row.id}: the recipe digest is not what the Worker advertises`);
  assert.equal(implementationDigest(tools['eng.test@3'], kitDir), advertised['eng.test@3'].digest);
  // The pin covers the bytes: an installed kit with one changed library byte no longer matches the recipe.
  const lib = path.join(worker, 'adapters/engineering-work/lib.mjs');
  fs.appendFileSync(lib, '\n');
  const changed = withImplementationPins(workerToolsOf(installed), worker);
  for (const row of template.toolAdoption) assert.notEqual(changed[row.id].digest, row.digest, row.id);
});

test('program v3: a one-key criterion; pass rule and bridge join on the key and the project; every predicate they read is pinned', () => {
  const alias = id => program.vocabulary.defines.find(d => d.id === id).as;
  const args = id => program.vocabulary.defines.find(d => d.id === id).args;
  assert.equal(program.id, 'engineering_work');
  assert.deepEqual(args('eng.check_passed'), ['key']);
  assert.equal(args('eng.check_result')[0], 'key'); assert.ok(args('eng.check_result').includes('project'));
  assert.equal(args('eng.check_spec')[0], 'key');
  assert.deepEqual(args('eng.tree_step'), ['project', 'from_gen', 'to_gen']);
  assert.deepEqual(program.rules, [{ id: 'ENG_CHECK_PASSED', label: program.rules[0].label,
    when: [{ predicate: alias('eng.check_result'), args: { key: '?k', project: '?p', gen: '?g', exit_code: 0 } },
      { predicate: alias('eng.tree_step'), args: { project: '?p', from_gen: '?g', to_gen: '?n' }, naf: true }],
    then: [{ predicate: alias('eng.check_passed'), args: { key: '?k' } }] }]);
  assert.deepEqual(program.acceptance, [{ id: 'ENG_CHECK_ACCEPTANCE', label: program.acceptance[0].label,
    when: [{ predicate: 'acceptance', args: { node: '?n', test: '?k' } }, { predicate: alias('eng.check_passed'), args: { key: '?k' } }],
    then: [{ predicate: 'acceptance_met', args: { node: '?n' } }] }]);
  // The Kernel signs a leaf only if the bridge's read set, closed over the package rules, is pinned (PSC 0.2.19).
  const reads = new Set(), pending = program.acceptance.flatMap(rule => rule.when.map(atom => atom.predicate));
  while (pending.length) {
    const read = pending.pop();
    if (read === 'acceptance' || reads.has(read)) continue;
    reads.add(read);
    for (const rule of program.rules) if (rule.then.some(head => head.predicate === read)) pending.push(...rule.when.map(atom => atom.predicate));
  }
  for (const read of reads) assert.ok(program.pins.includes(read), `${read} is read by the bridge and not pinned`);
  assert.deepEqual(program.actions, []);
  // The criterion is no receipt word: only the package rule derives it.
  assert.equal(committed('sources-v4.json').sources[0].words.includes('eng.check_passed'), false);
});
