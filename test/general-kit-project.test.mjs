// The project receipts and the official engineering capability (program v3, Sources v4, official recipe):
// D-1018c supplement (the criterion binds project, check name and spec digest in one key), PSC 0.2.24 ACC-PROJ-05.
// The rules are evaluated here over real receipts by a small interpreter of program-v3.json itself; the Kernel's own
// evaluation of the compiled program is rulith-java's evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perform } from '../kits/general/adapter.mjs';
import { context, projectId, kitId, sha, save, tree } from '../kits/general/lib.mjs';
import { acceptanceSpec, checkKey } from '../kits/general/acceptance-specs.mjs';
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
  test_v2: 'eng.test@2', write_file: 'eng.write_file@1' };

function scratchDir(t, prefix) {
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, prefix));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
const passingSpec = { command: [process.execPath, 'test.mjs'], cwd: '.', files: { 'test.mjs': sha('process.exitCode = 0;\n') } };
// One project under a kit home: a passing check `unit`. Several projects may share one kit home.
function project(t, { dir = scratchDir(t, 'project-'), home = path.join(dir, 'home'), name = 'project' } = {}) {
  const root = path.join(dir, name);
  fs.mkdirSync(path.join(root, '.rulith/acceptance'), { recursive: true });
  fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ allowedPaths: [path.dirname(process.execPath)] }));
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, ENG_KIT_HOME: home };
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
  const p = project(t);
  const id = projectId(p.ctx), digest = acceptanceSpec(p.ctx, 'unit').digest;
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, sha(`${kitId(p.home)}\n${p.ctx.canonical}`));
  const key = `${id}:unit:${digest}`;
  assert.equal(checkKey(id, 'unit', digest), key);
  const listed = await p.call('acceptance_v2');
  assert.deepEqual(listed.facts.map(f => [f.predicate, Object.keys(f.args)]),
    [['eng.check_spec', ['key', 'check', 'spec_digest', 'command', 'cwd', 'shell', 'files']]]);
  assert.equal(listed.facts[0].args.key, key);
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
  // The versions without a project keep their receipts exactly.
  const legacy = await p.call('test_v2', { check: 'unit' });
  assert.ok(legacy.out.rows.every(row => Object.keys(row).sort().join() === 'check,exit_code,from_gen,gen,spec_digest,to_gen,tree_digest'));
  assert.deepEqual([...new Set(legacy.facts.map(f => Object.keys(f.args).join()))], ['check,spec_digest,gen,tree_digest,exit_code', 'from_gen,to_gen']);
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
  const [id1, id2] = [projectId(p1.ctx), projectId(p2.ctx)];
  assert.notEqual(id1, id2);
  // The same spec bytes in both projects: one spec digest, two keys.
  const [k1, k2] = [(await p1.call('acceptance_v2')).facts[0].args.key, (await p2.call('acceptance_v2')).facts[0].args.key];
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
});

test('a project is the kit home identity with the canonical root: two kit homes differ; kit-id is made once, a damaged one refused', async t => {
  const dir = scratchDir(t, 'homes-');
  const a = project(t, { dir, home: path.join(dir, 'home-a') });
  const b = project(t, { dir, home: path.join(dir, 'home-b') });
  assert.equal(a.root, b.root);
  assert.equal(fs.existsSync(path.join(a.home, 'kit-id')), false, 'context alone made a kit identity');
  const first = projectId(a.ctx);
  assert.match(fs.readFileSync(path.join(a.home, 'kit-id'), 'utf8'), /^[0-9a-f-]{36}$/);
  assert.equal(projectId(a.ctx), first);
  assert.notEqual(projectId(b.ctx), first, 'one directory under two kit homes (or the same path on two devices) is one project');
  // A concurrent first call that links its identity first wins: this one reads it, keeps nothing of its own.
  const c = path.join(dir, 'home-c'); fs.mkdirSync(c);
  const winner = '00000000-0000-4000-8000-000000000000', link = fs.linkSync;
  fs.linkSync = (from, to) => { fs.writeFileSync(to, winner, { flag: 'wx' }); return link(from, to); };
  try { assert.equal(kitId(c), winner); } finally { fs.linkSync = link; }
  assert.equal(kitId(c), winner);
  assert.deepEqual(fs.readdirSync(c), ['kit-id'], 'a temporary identity file was left behind');
  fs.writeFileSync(path.join(a.home, 'kit-id'), 'not an identity');
  await assert.rejects(a.call('acceptance_v2'), /pin directory refused/);
  // Tools without a project never need the identity.
  fs.rmSync(path.join(b.home, 'kit-id'));
  await perform('write_file', { path: 'z.txt', text: 'z', expect_digest: '' }, b.env);
  assert.equal(fs.existsSync(path.join(b.home, 'kit-id')), false);
});

test('Windows: two spellings of one directory are one project and one counter; a counter kept under the old spelling continues',
  { skip: process.platform !== 'win32' && 'the root spelling is canonicalized on Windows only' }, async t => {
    const p = project(t);
    const spelled = p.root.toUpperCase();
    assert.notEqual(spelled, p.root);
    const other = context({ ...p.env, RULITH_SOURCE_ACCESS: spelled });
    assert.equal(other.root, spelled, 'fs.realpathSync canonicalizes now: this test no longer shows anything');
    assert.equal(other.stateFile, p.ctx.stateFile);
    assert.equal(projectId(other), projectId(p.ctx));
    assert.equal(other.spelledStateFile, path.join(p.home, `tree-${sha(spelled)}.json`));
    // Upgrade: the counter kept under the spelling the Source used before is continued, not restarted at 0.
    save(other.spelledStateFile, { gen: 7, digest: tree(other).digest });
    const step = await perform('write_file_v2', { path: 'n.txt', text: 'n', expect_digest: '' }, { ...p.env, RULITH_SOURCE_ACCESS: spelled });
    assert.deepEqual([step.rows[0].from_gen, step.rows[0].to_gen], [7, 8]);
    assert.equal(JSON.parse(fs.readFileSync(p.ctx.stateFile, 'utf8')).gen, 8);
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
  const p = project(t);
  const id = projectId(p.ctx);
  let attempts = 0;
  // Four files, an invalidation replay and the mutation: two edges per file, as the preflight budgets.
  const attempt = async (entry, length) => {
    const names = Array.from({ length: 4 }, (_, i) => `${String(attempts).padStart(3, '0')}${i}-${'x'.repeat(length)}`);
    attempts++;
    for (const name of names) p.write(name, 'a\n');
    save(p.ctx.stateFile, { gen: 1, digest: tree(p.ctx).digest, test_gen: 0, invalidation: { from_gen: 0, to_gen: 1 } });
    const patch = `*** Begin Patch\n${names.map(name => `*** Update File: ${name}\n@@\n-a\n+b`).join('\n')}\n*** End Patch`;
    try { return await perform(entry, { patch }, p.env); }
    catch (error) {
      assert.match(error.message, /patch file count refused/);
      for (const name of names) { assert.equal(fs.readFileSync(path.join(p.root, name), 'utf8'), 'a\n'); fs.rmSync(path.join(p.root, name)); }
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
