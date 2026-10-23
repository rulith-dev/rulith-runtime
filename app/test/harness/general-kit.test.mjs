import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generalKit, runtimeDirectory, kitReady, KIT_SKIP } from '../../harness/runtime-kit.mjs';
import net from 'node:net';
import { installerRefusal, managerListening, refreshGeneralKits } from '../../harness/kit-install.mjs';

const kit = generalKit();
// The published rulith package has no kits/general yet: its tests skip instead of failing to import.
const needsKit = { skip: !kitReady() && KIT_SKIP };
const load = name => import(pathToFileURL(path.join(kit, name)));
const [{ perform }, { sha }, { installGeneral, parseKitInstall }] = kitReady()
  ? await Promise.all(['adapter.mjs', 'lib.mjs', 'installer.mjs'].map(load)) : [{}, {}, {}];
const scratch = new URL('../../.scratch/', import.meta.url);
fs.mkdirSync(scratch, { recursive: true });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t) {
  const dir = fs.mkdtempSync(new URL('general-kit-', scratch));
  const root = path.join(dir, 'project'), home = path.join(dir, 'pins');
  fs.mkdirSync(path.join(root, '.rulith', 'acceptance'), { recursive: true });
  fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, ENG_KIT_HOME: home };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, home, env, call: (tool, args = {}) => perform(tool, args, env) };
}
function check(f, name = 'request') {
  const test = 'check.mjs', code = 'process.exit(0)';
  fs.writeFileSync(path.join(f.root, test), code);
  // A check command is classified like eng.run: Node's absolute path lies outside the project, so the owner allows it.
  json(path.join(f.home, 'settings.json'), { allowedPaths: [path.dirname(process.execPath)] });
  const spec = { command: [process.execPath, test], cwd: '.', files: { [test]: sha(code) } };
  const file = path.join(f.root, '.rulith', 'acceptance', `${name}.json`);
  json(file, spec);
  return { file, spec };
}

test('shipped acceptance discovery returns spec digests and rejects changed dependencies before execution', needsKit, async t => {
  const f = fixture(t); const { file, spec } = check(f);
  const proposed = (await f.call('acceptance')).rows[0];
  fs.writeFileSync(file, JSON.stringify({ files: spec.files, cwd: '.', command: spec.command }, null, 2));
  assert.equal((await f.call('acceptance')).rows[0].spec_digest, proposed.spec_digest);
  fs.writeFileSync(path.join(f.root, 'check.mjs'), 'changed');
  await assert.rejects(f.call('test_v2', { check: 'request' }), /acceptance file changed: check.mjs/);
  spec.files['check.mjs'] = sha('changed'); json(file, spec);
  assert.notEqual((await f.call('acceptance')).rows[0].spec_digest, proposed.spec_digest);
  json(path.join(f.root, '.rulith', 'acceptance', 'invalid.json'), { command: [] });
  const discovered = await f.call('acceptance');
  assert.equal(discovered.rows.length, 1);
  assert.deepEqual(discovered.errors, [{ check: 'invalid', error: 'acceptance spec invalid: command must be an array of words (or one string with shell:true)' }]);
  await assert.rejects(f.call('test_v2', { check: '../escape' }), /acceptance check invalid/);
});

test('shipped acceptance discovery and named checks bind the digest and invalidate on a later write', needsKit, async t => {
  const f = fixture(t); const { file, spec } = check(f);
  const discovery = await f.call('acceptance');
  assert.equal(discovery.rows.length, 1);
  const proposed = discovery.rows[0];
  assert.equal(proposed.check, 'request');
  // The row shows what the digest freezes: the command line, cwd, shell flag and every pinned file digest.
  assert.deepEqual(JSON.parse(proposed.files), [{ path: 'check.mjs', sha256: spec.files['check.mjs'] }]);
  assert.equal(proposed.cwd, '.'); assert.equal(proposed.shell, false); assert.match(proposed.command, /check\.mjs$/);
  assert.match(proposed.spec_digest, /^[a-f0-9]{64}$/);
  // Formatting/order changes leave the signed digest intact.
  fs.writeFileSync(file, JSON.stringify({ files: spec.files, cwd: '.', command: spec.command }, null, 2));
  assert.equal((await f.call('acceptance')).rows[0].spec_digest, proposed.spec_digest);
  const passed = (await f.call('test_v2', { check: 'request' })).rows[0];
  assert.equal(passed.exit_code, 0); assert.equal(passed.spec_digest, proposed.spec_digest);
  const changed = await f.call('write_file', { path: 'implementation.txt', text: 'new tree', expect_digest: '' });
  assert.ok(changed.rows.some(row => row.from_gen === passed.gen && row.to_gen > passed.gen));
  const current = (await f.call('test_v2', { check: 'request' })).rows[0];
  assert.ok(current.gen > passed.gen); assert.equal(current.spec_digest, proposed.spec_digest);
  fs.writeFileSync(path.join(f.root, 'check.mjs'), 'process.exit(1)');
  await assert.rejects(f.call('test_v2', { check: 'request' }), /acceptance file changed: check.mjs/);
  spec.files['check.mjs'] = sha('process.exit(1)'); json(file, spec);
  const revised = (await f.call('acceptance')).rows[0];
  assert.notEqual(revised.spec_digest, proposed.spec_digest, 'changed tests require a new signature');
  const failed = (await f.call('test_v2', { check: 'request' })).rows[0];
  assert.equal(failed.exit_code, 1); assert.equal(failed.spec_digest, revised.spec_digest);
});

test('shipped kit keeps legacy pinned tests, measurements and settings', needsKit, async t => {
  const f = fixture(t);
  json(path.join(f.home, 'settings.json'), { runDeadlineSeconds: 60, pollMaxWaitSeconds: 60, treeExclude: ['out'] });
  fs.writeFileSync(path.join(f.root, 'legacy.mjs'), 'process.exit(0)');
  json(path.join(f.home, 'specs', 'test.json'), { command: [process.execPath, 'legacy.mjs'], output_dirs: ['out'] });
  assert.equal((await f.call('test')).rows[0].exit_code, 0);
  const measure = 'console.log(JSON.stringify({value:1234}))';
  fs.writeFileSync(path.join(f.root, 'measure.mjs'), measure);
  fs.writeFileSync(path.join(f.root, 'workload.txt'), 'work'); fs.writeFileSync(path.join(f.root, 'config.txt'), 'config');
  json(path.join(f.home, 'specs', 'speed.json'), { interpreter: process.execPath, command: [process.execPath, 'measure.mjs'],
    cwd: '.', binary: 'measure.mjs', binary_digest: sha(measure), candidate_binary: 'legacy.mjs',
    workload: 'workload.txt', workload_digest: sha('work'), config: 'config.txt', config_digest: sha('config'),
    parser: { kind: 'json_integer_milli', field: 'value' }, unit: 'ms', repeats: 1, output_dirs: ['out'] });
  assert.ok((await f.call('tree_state')).measure_specs.includes('speed'));
  assert.equal((await f.call('measure_pinned', { spec_id: 'speed' })).rows[0].value_milli, 1234);
});

test('shipped general read/patch tools share tree state and list existing measurement specs', needsKit, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'legacy.mjs'), 'process.exit(0)');
  json(path.join(f.home, 'specs', 'speed.json'), { output_dirs: ['out'] });
  assert.ok((await f.call('tree_state')).measure_specs.includes('speed'));
  assert.ok((await f.call('glob', { pattern: '*.mjs' })).rows.some(row => row.path === 'legacy.mjs'));
  await f.call('apply_patch', { patch: '*** Begin Patch\n*** Add File: added.txt\n+hello\n*** End Patch' });
  assert.equal((await f.call('read_v2', { path: 'added.txt' })).rows[0].digest, sha('hello\n'));
});

test('start dispatches kit-install arguments to the shipped installer and preserves pinned specs/settings', needsKit, async t => {
  const f = fixture(t);
  const manager = path.join(f.dir, 'manager'), instance = path.join(f.dir, 'instance');
  const worker = path.join(f.dir, 'worker'), toolsFile = path.join(worker, 'tools.json');
  fs.mkdirSync(manager); fs.mkdirSync(instance); fs.mkdirSync(path.join(worker, 'adapters', 'engineering-work'), { recursive: true });
  fs.writeFileSync(path.join(worker, 'adapters', 'engineering-work', 'adapter.mjs'), 'retired adapter');
  json(toolsFile, { format: 'rulith-worker-tools/1', tools: { 'owner.tool@1': { kind: 'read' }, 'eng.obsolete@1': {} } });
  const settings = '{"runDeadlineSeconds":600,"pollMaxWaitSeconds":600,"treeExclude":["out"],"webSearch":{"provider":"deepseek","keyEnv":"SEARCH_TEST_KEY"}}';
  fs.writeFileSync(path.join(f.home, 'settings.json'), settings);
  const pinned = '{"command":["node","check.mjs"]}'; fs.writeFileSync(path.join(f.home, 'specs', 'test.json'), pinned);
  json(path.join(manager, 'registry.json'), { instances: [{ mode: 'local_agent', directory: instance, agentName: 'fixture' }] });
  // Synthetic installer fixture: contains no credentials and never starts a Worker or manager.
  const local = path.join(instance, 'local.json');
  json(local, { worker: { env: { ENG_KIT_HOME: f.home, RULITH_WORKER_ROOT: worker, RULITH_TOOLS_FILE: toolsFile } } });
  // Exercise the same dispatch/installer as the Runtime CLI without launching any service/process.
  const run = (_node, argv) => {
    assert.deepEqual(argv.slice(1, 4), ['kit', 'install', 'general']);
    installGeneral(parseKitInstall(argv.slice(4)));
    return { status: 0 };
  };
  assert.equal(refreshGeneralKits(manager, { run }), 1);
  assert.equal(refreshGeneralKits(manager, { run }), 1, 'every start refreshes the shipped files');
  const installed = JSON.parse(fs.readFileSync(toolsFile));
  for (const id of ['eng.test@1', 'eng.test@2', 'eng.acceptance@1', 'eng.glob@1', 'eng.apply_patch@1', 'eng.read_image@1', 'eng.read@2', 'web.fetch@1', 'web.search@1'])
    assert.ok(installed.tools[id], id);
  assert.ok(installed.tools['owner.tool@1']); assert.equal(installed.tools['eng.obsolete@1'], undefined);
  assert.ok(installed.tools['web.search@1'].env.pass.includes('SEARCH_TEST_KEY'));
  assert.equal(fs.readFileSync(path.join(worker, 'adapters', 'engineering-work', 'adapter.mjs'), 'utf8'), fs.readFileSync(path.join(kit, 'adapter.mjs'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(f.home, 'settings.json'), 'utf8'), settings);
  assert.equal(fs.readFileSync(path.join(f.home, 'specs', 'test.json'), 'utf8'), pinned);
  const env = JSON.parse(fs.readFileSync(local)).worker.env;
  assert.equal(env.ENG_KIT_HOME, f.home); assert.equal(env.RULITH_WORKSPACE_TOOLS, 'read');
  assert.equal(env.RULITH_WORKER_RUN_TIMEOUT_SECONDS, '660');
});

test('kit refresh isolates agents, skips unprepared/signed-out entries, and stops on install failure', () => {
  const rows = ['one', 'two', 'unprepared', 'out'].map(agentName => ({ agentName, directory: `/${agentName}`, mode: 'local_agent', ...(agentName === 'out' ? { signedOutAt: 'then' } : {}) }));
  const reads = [], calls = [];
  const readJson = file => {
    reads.push(file);
    if (file.endsWith('registry.json')) return { instances: rows };
    if (file.includes('unprepared')) return {};
    const name = file.includes('one') ? 'one' : 'two';
    return { worker: { env: { ENG_KIT_HOME: `/${name}-pins`, RULITH_WORKER_ROOT: `/${name}-worker`, RULITH_TOOLS_FILE: `/${name}-tools` } } };
  };
  const env = { RULITH_RUNTIME_DIR: 'D:/local runtime' };
  assert.equal(runtimeDirectory(env), path.resolve(env.RULITH_RUNTIME_DIR));
  assert.equal(refreshGeneralKits('/manager', { env, readJson, run: (...args) => { calls.push(args); return { status: 0 }; } }), 2);
  assert.deepEqual(calls.map(c => c[1]), ['one', 'two'].map(name => [path.join(runtimeDirectory(env), 'local', 'rulith-local.mjs'),
    'kit', 'install', 'general', '--agent', name, '--kit-home', `/${name}-pins`, '--manager-home', '/manager']));
  assert.ok(!reads.some(file => file.includes('/out/')));
  // A launcher that names its Agent refreshes only that Agent.
  calls.length = 0;
  assert.equal(refreshGeneralKits('/manager', { agent: 'two', env, readJson, run: (...args) => { calls.push(args); return { status: 0 }; } }), 1);
  assert.deepEqual(calls.map(c => c[1][5]), ['two']);
  assert.equal(refreshGeneralKits('/manager', { agent: 'absent', env, readJson, run: () => assert.fail('no row') }), 0);
  // A refusal names the Agent; only the installer's fixed words are shown, never other child output.
  assert.throws(() => refreshGeneralKits('/manager', { env, readJson, run: () => ({ status: 1, stderr: 'D:/private/local.json: private material' }) }),
    /^Error: Deep Rulith: general kit installation failed for Agent "one"\.$/);
  assert.throws(() => refreshGeneralKits('/manager', { env, readJson, run: () => ({ status: 1, stderr: 'warning\nsettings refused\n' }) }),
    /^Error: Deep Rulith: general kit installation failed for Agent "one": settings refused\.$/);
  assert.throws(() => refreshGeneralKits('/manager', { env, readJson, run: () => ({ status: 2, missingKit: true }) }),
    /^Error: Deep Rulith: general kit installation failed; use a Runtime with kits\/general \(RULITH_RUNTIME_DIR\)\.$/);
  for (const words of ['Expected one paired Agent; found 0', 'Pair the Agent and enable its Worker once first', 'Invalid Worker tool manifest',
    'Installation path contains a link', 'Worker paths must be absolute', '--agent and --kit-home are required'])
    assert.equal(installerRefusal(`${words}\r\n`), words);
  for (const other of ['', 'Unexpected token } in JSON at position 3', "ENOENT: no such file or directory, open 'D:/x/registry.json'", 'settings refused: D:/x'])
    assert.equal(installerRefusal(other), '');
});

test('a manager already listening on the port is detected so the launcher skips the refresh', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await managerListening(port), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await managerListening(port), false);
});

test('an old Runtime without the general kit is refused before its CLI can run', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'local'));
  fs.writeFileSync(path.join(f.dir, 'local', 'rulith-local.mjs'), 'throw new Error("CLI must never run")');
  const readJson = file => file.endsWith('registry.json')
    ? { instances: [{ mode: 'local_agent', agentName: 'fixture', directory: f.dir }] }
    : { worker: { env: { ENG_KIT_HOME: f.home, RULITH_WORKER_ROOT: f.dir, RULITH_TOOLS_FILE: 'unused' } } };
  assert.throws(() => refreshGeneralKits(f.dir, { env: { RULITH_RUNTIME_DIR: f.dir }, readJson }), /general kit installation failed/);
});
