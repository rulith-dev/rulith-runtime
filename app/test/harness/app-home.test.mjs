import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_HOME_ENV, PREFERRED_PORTS, appHome, appSettings, freePorts, holdAppHome, launcherSettings } from '../../harness/web/app-home.mjs';
import { refreshGeneralKits } from '../../harness/kit-install.mjs';

// Batch 1 of the public entry (D-1018b): with no settings file every launcher setting is derived from one app home; with
// a settings file the settings are the file's, as before.

const repo = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(repo, 'harness', 'web');
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-app-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const fixedPorts = async () => [17790, 13080];
// Everything this process writes while `action` runs, so a test can show that a value was never printed.
async function printed(action) {
  const out = [], { stdout, stderr } = process;
  const write = (chunk) => { out.push(String(chunk)); return true; };
  const saved = [stdout.write, stderr.write];
  stdout.write = write; stderr.write = write;
  try { return { value: await action(), text: out.join('') }; } finally { [stdout.write, stderr.write] = saved; }
}

test('an empty app home gets its directories, a manager key and settings derived from it alone', async (t) => {
  const home = path.join(temp(t), 'nested', 'app');
  const { value: s, text } = await printed(() => appSettings(home, { ports: fixedPorts }));
  for (const dir of ['manager', 'dsh', 'kit']) assert.ok(fs.statSync(path.join(home, dir)).isDirectory(), dir);
  assert.deepEqual(Object.keys(s).sort(), ['dshBin', 'dshHome', 'keyFile', 'kitHome', 'managerHome', 'managerPort', 'persona',
    'runtimeEntry', 'webPort']);
  assert.equal(s.dshHome, path.join(home, 'dsh'));
  assert.equal(s.managerHome, path.join(home, 'manager'));
  assert.equal(s.kitHome, path.join(home, 'kit'));
  assert.equal(s.keyFile, path.join(home, 'manager.key'));
  assert.deepEqual([s.managerPort, s.webPort], [17790, 13080]);
  // dsh and the Runtime come from this package's own dependencies; the persona ships beside the launcher.
  assert.equal(s.dshBin, path.join(repo, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assert.equal(s.runtimeEntry, path.join(repo, 'node_modules', 'rulith', 'local', 'rulith-local.mjs'));
  assert.equal(s.persona, path.join(repo, 'harness', 'runtime-persona.txt'));
  for (const file of [s.dshBin, s.runtimeEntry, s.persona]) assert.ok(fs.existsSync(file), file);
  // No cwd: the command's own folder is the default workspace, as with `dsh web`.
  assert.equal(Object.hasOwn(s, 'cwd'), false);
  const key = fs.readFileSync(s.keyFile, 'utf8').trim();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, 'a 32-byte random key in the characters the manager accepts');
  if (process.platform === 'win32') {
    // One access entry (this user), none inherited from the folder.
    const acl = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [s.keyFile], { encoding: 'utf8' }).stdout;
    assert.equal(acl.split(/\r?\n/).filter((line) => line.includes(':(')).length, 1, 'one access entry');
    assert.equal(acl.includes('(I)'), false, 'nothing inherited');
    assert.doesNotMatch(text, /could not limit/);
  } else {
    assert.equal(fs.statSync(s.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  }
  // The key travels only as a file: it is in no setting and was never printed.
  assert.ok(!JSON.stringify(s).includes(key));
  assert.ok(!text.includes(key));
});

test('a second run reuses the app home as it is: the same key and the same settings', async (t) => {
  const home = temp(t);
  const first = await appSettings(home, { ports: fixedPorts });
  const key = fs.readFileSync(first.keyFile, 'utf8');
  const { value: second, text } = await printed(() => appSettings(home, { ports: fixedPorts }));
  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(first.keyFile, 'utf8'), key);
  assert.ok(!text.includes(key.trim()));
  // A key file that is not a manager key refuses the start and names the file, never its content.
  fs.writeFileSync(first.keyFile, 'short');
  await assert.rejects(appSettings(home, { ports: fixedPorts }), (error) =>
    error.message.includes(first.keyFile) && !error.message.includes('short') && /not hold a valid manager key/.test(error.message));
});

test('ports: the preferred ones when free, another free one when busy, never the same one twice', async () => {
  assert.deepEqual(PREFERRED_PORTS, { manager: 7790, web: 3080 });
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const taken = busy.address().port;
  try {
    const [instead] = await freePorts([taken]);
    assert.notEqual(instead, taken);
    assert.ok(instead > 0);
  } finally { await new Promise((resolve) => busy.close(resolve)); }
  const [free] = await freePorts([taken]);
  assert.equal(free, taken, 'a free preferred port is used');
  const [one, two] = await freePorts([taken, taken]);
  assert.equal(one, taken);
  assert.notEqual(two, taken);
});

test('the app home is RULITH_APP_HOME when set, else .rulith/app in the user home', () => {
  assert.equal(APP_HOME_ENV, 'RULITH_APP_HOME');
  assert.equal(appHome({}, '/users/someone'), path.resolve('/users/someone', '.rulith', 'app'));
  assert.equal(appHome({ RULITH_APP_HOME: '  ' }, '/users/someone'), path.resolve('/users/someone', '.rulith', 'app'));
  assert.equal(appHome({ RULITH_APP_HOME: '/elsewhere/rulith' }, '/users/someone'), path.resolve('/elsewhere/rulith'));
});

test('a settings file gives exactly its own settings and the launcher arguments after it, as before', async (t) => {
  const dir = temp(t);
  const example = path.join(repo, 'deep-rulith.example.json');
  const before = JSON.parse(fs.readFileSync(example, 'utf8'));
  const named = await launcherSettings(['node', 'start-deep-rulith.mjs', example, '--port', '4000'], {});
  assert.deepEqual(named, { settings: before, args: ['--port', '4000'] });
  assert.equal(Object.hasOwn(named.settings, 'kitHome'), false, 'nothing is added to a settings file');
  assert.deepEqual((await launcherSettings(['node', 'start-deep-rulith.mjs', example, '--init'], {})).args, ['--init']);
  // DEEP_RULITH_SETTINGS names the file; the launcher arguments still start at the third word, as before.
  const viaEnv = await launcherSettings(['node', 'start-deep-rulith.mjs', 'ignored', '--no-open'], { DEEP_RULITH_SETTINGS: example });
  assert.deepEqual(viaEnv, { settings: before, args: ['--no-open'] });
  // Without one, every argument is the launcher's and the settings come from the app home.
  const home = path.join(dir, 'app');
  const derived = await launcherSettings(['node', 'deep-rulith', '--no-open'], { [APP_HOME_ENV]: home }, { ports: fixedPorts });
  assert.equal(derived.home, home);
  assert.deepEqual(derived.args, ['--no-open']);
  assert.deepEqual(derived.settings, await appSettings(home, { ports: fixedPorts }));
  assert.deepEqual((await launcherSettings(['node', 'deep-rulith'], { [APP_HOME_ENV]: home }, { ports: fixedPorts })).args, []);
});

test('one launcher per app home: a second one is refused while the first holds it, and a dead holder releases it', async (t) => {
  const home = temp(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const { holdAppHome } = await import(${JSON.stringify(pathToFileURL(path.join(web, 'app-home.mjs')).href)});
     await holdAppHome(${JSON.stringify(home)}); console.log('held'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(); });
    holder.once('exit', () => reject(new Error('the holder exited')));
  });
  await assert.rejects(holdAppHome(home), /^Error: Deep Rulith is already running from .* Use its browser tab, or stop it and start again\.$/);
  holder.kill();
  await new Promise((resolve) => holder.once('exit', resolve));
  const release = await holdAppHome(home);
  release();
  assert.equal(fs.existsSync(path.join(home, 'launcher.lock')), false);
});

test('the kit refresh installs the app home kit for a paired Agent whose Worker has none yet, and only with it', () => {
  const rows = ['fresh', 'kept', 'noworker'].map((agentName) => ({ agentName, directory: `/${agentName}`, mode: 'local_agent' }));
  const readJson = (file) => {
    if (file.endsWith('registry.json')) return { instances: rows };
    if (file.includes('noworker')) return { agent: {} };
    const worker = { RULITH_WORKER_ROOT: '/worker', RULITH_TOOLS_FILE: '/tools.json' };
    return { worker: { env: file.includes('kept') ? { ...worker, ENG_KIT_HOME: '/own-kit' } : worker } };
  };
  const calls = [];
  const run = (_node, argv) => { calls.push([argv[5], argv[7]]); return { status: 0 }; };
  assert.equal(refreshGeneralKits('/manager', { kitHome: '/app/kit', readJson, run }), 2);
  assert.deepEqual(calls, [['fresh', '/app/kit'], ['kept', '/own-kit']]);
  // A settings file without kitHome: as before, only Agents that already have a kit home.
  calls.length = 0;
  assert.equal(refreshGeneralKits('/manager', { readJson, run }), 1);
  assert.deepEqual(calls, [['kept', '/own-kit']]);
});

// The launcher with a stand-in for dsh that records each invocation: a start without a profile first does what --init
// does, then starts; a start with one only starts.
test('the launcher creates a missing dsh profile from the web template before it starts, and only when missing', (t) => {
  const dir = temp(t);
  const calls = path.join(dir, 'calls.jsonl');
  const fakeDsh = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(fakeDsh, "import fs from 'node:fs';\nfs.appendFileSync(process.env.FAKE_DSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  const s = { dshBin: fakeDsh, dshHome: path.join(dir, 'dsh-home'), cwd: dir, managerHome: path.join(dir, 'manager-home'),
    managerPort: 1, keyFile: path.join(dir, 'key.txt'), runtimeEntry: path.join(dir, 'runtime.mjs'), persona: path.join(dir, 'persona.txt') };
  fs.mkdirSync(s.managerHome);
  const file = path.join(dir, 'deep-rulith.json');
  fs.writeFileSync(file, JSON.stringify(s));
  const start = () => {
    fs.rmSync(calls, { force: true });
    const run = spawnSync(process.execPath, [path.join(web, 'start-deep-rulith.mjs'), file, '--no-open'],
      { env: { ...process.env, FAKE_DSH_CALLS: calls }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    return { run, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
  };
  const overlay = path.join(web, 'rulith-web.cordis.yml');
  const first = start();
  assert.deepEqual(first.calls, [
    ['--profile', 'rulith', '--from-default-profile', 'web', '--patch', overlay, '--dump-config'],
    ['--profile', 'rulith', '--patch', overlay, '--no-open'],
  ]);
  assert.match(first.run.stdout, /Deep Rulith profile "rulith" created in /);
  assert.ok(fs.existsSync(path.join(s.dshHome, 'profiles', 'rulith', 'node_modules', 'rulith-dsh-ui', 'package.json')));
  // dsh marks a created profile with its package.json; the stand-in did not write one, so write it as dsh would.
  fs.writeFileSync(path.join(s.dshHome, 'profiles', 'rulith', 'package.json'), '{}');
  assert.deepEqual(start().calls, [['--profile', 'rulith', '--patch', overlay, '--no-open']]);
});
