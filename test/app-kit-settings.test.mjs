// Batch C (D-1031a): the app's kit defaults (kits/general/installer.mjs APP_KIT_SETTINGS) run through the official
// engineering capability's 1.0.0 kit as it is: no kit byte changes, only settings that kit already reads. The shell is
// on only on Windows, where npm and npx are .cmd scripts that start only through it; with it the classifier's words are
// a courtesy check (a caret inside a word, or a command after a separator, passes them), and the boundary is model-command
// isolation (batch C review).
// 中文说明：批次 C 不改工具包的字节，只给应用设置的 kit home 写 1.0.0 工具包本来就读的设置。shell 只在 Windows 上打开，让
// npm、npx（.cmd 脚本）能启动；打开后命令行里的词只是礼貌性的检查，真正的边界是模型命令隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perform } from '../kits/general/adapter.mjs';
import { classify, context, settings, sha, workerRunTimeoutSeconds } from '../kits/general/lib.mjs';
import { APP_KIT_SETTINGS, writeAppKitSettings } from '../kits/general/installer.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const TEST_JS = "console.log('project test ok');\n";

function fixture(t) {
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'app-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), home = path.join(dir, 'kit');
  fs.mkdirSync(path.join(root, '.rulith', 'acceptance'), { recursive: true });
  // The kit home as the app sets it up: the app's settings.json, and the specs folder the installer makes.
  assert.equal(writeAppKitSettings(home), true);
  fs.mkdirSync(path.join(home, 'specs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(root, 'test.js'), TEST_JS);
  const env = { ...process.env, RULITH_SOURCE_TYPE: 'file', RULITH_SOURCE_ACCESS: root, RULITH_SOURCE_NAME: 'project', ENG_KIT_HOME: home };
  return { root, home, env, ctx: context(env), call: (entry, args = {}) => perform(entry, args, env) };
}
const verdict = (ctx, command) => { try { classify(ctx, command); return 'allowed'; } catch (error) { return error.message; } };

test('the app\'s kit defaults are settings the 1.0.0 kit reads: 600 s, project-local installs and deletions, the shell on Windows only', (t) => {
  const f = fixture(t);
  const read = settings(f.home);
  assert.deepEqual([read.runSeconds, read.pollSeconds, read.shell, [...read.allow].sort(), read.treeExclude],
    [600, 600, windows, ['delete', 'install'], [...APP_KIT_SETTINGS.treeExclude]]);
  // build/ is often source, so only output and dependency folders are left out of the tree (batch C review).
  assert.deepEqual([...APP_KIT_SETTINGS.treeExclude], ['node_modules', '.git', 'dist', '.venv', 'target', '**/__pycache__']);
  assert.equal(workerRunTimeoutSeconds(f.home), 660, 'the Worker\'s deadline follows: 600 s plus its margin');
  assert.equal(writeAppKitSettings(f.home), false, 'an existing settings.json is never replaced');
});

test('with the shell on (Windows), the words the classifier refuses stay refused as written: push, publish, global installs, privilege, service and process control, git config and commit, inline code',
  { skip: !windows && 'the app turns the shell on only on Windows' }, (t) => {
  const f = fixture(t);
  for (const command of ['git push', 'git push origin main', 'npm publish', 'npm install -g left-pad', 'npm i --global x', 'pip install --system x',
    'sudo node test.js', 'runas /user:admin cmd', 'kill 1', 'taskkill /PID 1 /F', 'net stop spooler', 'sc stop spooler', 'systemctl stop nginx',
    'docker stop web', 'powershell Stop-Process -Name node', 'git commit -m x', 'git merge main', 'git rebase main', 'git tag v1', 'git reset --hard',
    'git config user.name x', 'git -c alias.x=!sh x', 'node -e 1', 'python -c 1', 'npx -c "node x"',
    // Inside a shell line the same words are found: a second program after && or inside cmd /c or bash -c.
    'node test.js && git push', 'cmd /c git commit -m x', 'bash -c "git push"', 'npm test || npm publish'])
    assert.equal(verdict(f.ctx, command), 'command refused', command);
  // What the shell newly allows (the classifier is advisory there, kits/general/README.md): pipes, &&, ||, redirects, a
  // shell as the program, variables; and two installs the 1.0.0 classifier does not treat as global.
  for (const command of ['node test.js | more', 'npm test && node test.js', 'npm test || node test.js', 'node test.js > out.txt',
    'bash x.sh', 'pwsh -File build.ps1', 'echo %PATH%', 'node $(echo test.js)', 'cargo install ripgrep', 'pip install --user x', 'npm install left-pad', 'rm out.txt'])
    assert.equal(verdict(f.ctx, command), 'allowed', command);
  // Paths outside the project stay refused as words on the line, and so does a word that looks like one: a Windows
  // switch such as /c or /i is read as a path from the root (cmd /c, findstr /i and dir /s are refused).
  for (const command of ['node ../outside.js', 'cmd /c echo hi', 'findstr /i ok test.js'])
    assert.equal(verdict(f.ctx, command), 'path refused', command);
});

test('Windows: npm --version, npx --version and the project\'s npm test run through the 1.0.0 kit with the app\'s settings',
  { skip: !windows && 'npm and npx are .cmd scripts only on Windows' }, async (t) => {
    const f = fixture(t);
    const saved = process.env.NPM_CONFIG_UPDATE_NOTIFIER;
    process.env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
    t.after(() => { if (saved === undefined) delete process.env.NPM_CONFIG_UPDATE_NOTIFIER; else process.env.NPM_CONFIG_UPDATE_NOTIFIER = saved; });
    for (const command of ['npm --version', 'npx --version']) {
      const out = await f.call('run_v2', { command });
      assert.equal(out.rows[0].exit_code, 0, `${command}: ${out.head}`);
      assert.match(out.head, /^\d+\.\d+\.\d+/m, command);
    }
    const ran = await f.call('run_v2', { command: 'npm test' });
    assert.equal(ran.rows[0].exit_code, 0, ran.head);
    assert.match(ran.head, /project test ok/);
    // A pipe runs through the shell too.
    const piped = await f.call('run_v2', { command: 'node test.js | findstr ok' });
    assert.equal(piped.rows[0].exit_code, 0, piped.head);
    // An acceptance check of npm test: a spec with shell: true, its command one line, as the owner's shell setting allows;
    // it freezes package.json too, which holds the script npm test runs.
    const pkg = fs.readFileSync(path.join(f.root, 'package.json'), 'utf8');
    fs.writeFileSync(path.join(f.root, '.rulith', 'acceptance', 'unit.json'),
      JSON.stringify({ command: 'npm test', shell: true, cwd: '.', files: { 'test.js': sha(TEST_JS), 'package.json': sha(pkg) } }));
    assert.equal((await f.call('acceptance_v2')).rows.length, 1);
    const checked = await f.call('test_v3', { check: 'unit' });
    assert.equal(checked.rows[0].exit_code, 0, checked.head);
    // An argv spec (no shell) does not start npm on Windows with the 1.0.0 kit: the model must write shell: true.
    fs.writeFileSync(path.join(f.root, '.rulith', 'acceptance', 'argv.json'),
      JSON.stringify({ command: ['npm', 'test'], cwd: '.', files: { 'test.js': sha(TEST_JS) } }));
    await assert.rejects(f.call('test_v3', { check: 'argv' }));
  });
