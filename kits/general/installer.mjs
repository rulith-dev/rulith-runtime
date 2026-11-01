import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { workerRunTimeoutSeconds, save } from './lib.mjs';
import { generalSettings } from './general-settings.mjs';

export function parseKitInstall(argv, env = process.env) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--agent', '--kit-home', '--manager-home'].includes(flag) || !argv[i + 1]
      || argv[i + 1].startsWith('--') || options[flag.slice(2)] !== undefined)
      throw new Error('Expected --agent <name> --kit-home <dir> [--manager-home <dir>]');
    options[flag.slice(2)] = argv[i + 1];
  }
  if (!options.agent || !options['kit-home']) throw new Error('--agent and --kit-home are required');
  options['manager-home'] ??= env.RULITH_MANAGER_HOME?.trim() || path.join(os.homedir(), '.rulith', 'manager');
  return options;
}

// Installation never follows links, including an absent path's existing parents.
function plainPath(value) {
  const target = path.resolve(value);
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Installation path contains a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
  return target;
}
const read = file => JSON.parse(fs.readFileSync(plainPath(file), 'utf8'));

export function generalKitCurrent(directory) {
  try {
    const env = read(path.join(directory, 'local.json')).worker?.env ?? {};
    if (!env.ENG_KIT_HOME || env.RULITH_WORKSPACE_TOOLS !== 'read'
      || env.RULITH_WORKER_RUN_TIMEOUT_SECONDS !== String(workerRunTimeoutSeconds(env.ENG_KIT_HOME))) return false;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ours = read(path.join(here, 'worker-tools.json'));
    const general = generalSettings(env.ENG_KIT_HOME);
    if (general.webSearch) ours.tools['web.search@1'].env.pass.push(general.webSearch.keyEnv);
    const manifest = read(env.RULITH_TOOLS_FILE);
    if (!Object.entries(ours.tools).every(([id, definition]) => JSON.stringify(manifest.tools?.[id]) === JSON.stringify(definition))) return false;
    if (Object.keys(manifest.tools).some(id => id.startsWith('eng.') && !ours.tools[id])) return false;
    const target = path.join(env.RULITH_WORKER_ROOT, 'adapters', 'engineering-work');
    return fs.readdirSync(here).filter(n => n.endsWith('.mjs') && !['install.mjs', 'installer.mjs'].includes(n))
      .every(name => fs.readFileSync(plainPath(path.join(target, name))).equals(fs.readFileSync(plainPath(path.join(here, name)))));
  } catch { return false; }
}

// 本机应用给编程工具的缺省设置（批次 C，D-1031a）。库的缺省（每条命令 35 秒、不许安装与删除、依赖目录也进树摘要、不经
// shell）让真实项目在工作那一步就卡住：装依赖、跑测试和构建常常超过 35 秒，npm install 被拒，node_modules 每次都重新哈希，
// Windows 上 npm、npx 是 .cmd 脚本，不经 shell 根本启动不了。这些都是官方编程能力 1.0.0 的工具包本来就读的设置，工具包的
// 字节不变。应用设置一个智能体的 kit home 时，只在那里还没有 settings.json 时写下这份；已有的一个字都不改。
// shell 只在 Windows 上打开（批次 C 审查）：那里 npm、npx 是 .cmd 脚本，只能经 shell 启动；Linux 与 macOS 上它们不需要 shell，
// macOS 又没有隔离，shell 展开的 ~、$HOME 与通配符加上允许删除，会把一次失误变成项目外的真删除。打开 shell 后命令行里的词
// 只是礼貌性的检查：它按字面读词，词里夹的 ^ 或变量、分隔符后面的提权与杀进程命令、powershell 或 bash -c 里的代码都拦不住；
// 真正的边界是模型命令隔离。
// build 不排除：很多项目的 build/ 是源码。
// __pycache__ 按任意深度排除：Python 在每个包目录里写它，只排除根目录的那个等于没排除。
// The app's defaults for the coding tools (batch C, D-1031a). The library's defaults (35 seconds per command, no
// installs or deletions, dependency folders hashed into the tree digest, no shell) stop real projects in the work step:
// installs, tests and builds often take longer than 35 seconds, npm install is refused, node_modules is rehashed on
// every step, and on Windows npm and npx are .cmd scripts that start only through a shell. All of these are settings
// the official engineering capability's 1.0.0 kit already reads; its bytes are unchanged. When the app sets up an
// Agent's kit home it writes these only where that home has no settings.json yet; an existing one is never touched.
// shell only on Windows (batch C review): there npm and npx are .cmd scripts that start only through a shell; on Linux
// and macOS they need none, and macOS has no isolation, where the shell's ~, $HOME and globs together with allowed
// deletions would turn a slip into a real deletion outside the project. With the shell on, the words on the line are a
// courtesy check only: it reads words as written, so a caret or variable inside a word, privilege and process commands
// after a separator, and code inside powershell or bash -c pass it; the boundary is model-command isolation. build is
// not excluded: in many projects build/ is source.
// __pycache__ is excluded at any depth: Python writes one in every package folder.
export const APP_KIT_SETTINGS = Object.freeze({
  runDeadlineSeconds: 600, pollMaxWaitSeconds: 600,
  treeExclude: Object.freeze(['node_modules', '.git', 'dist', '.venv', 'target', '**/__pycache__']),
  allow: Object.freeze(['install', 'delete']), shell: process.platform === 'win32',
});

/** Write {@link APP_KIT_SETTINGS} into `kitHome` unless it has a settings.json already (never overwritten). True when written. */
export function writeAppKitSettings(kitHome) {
  const home = plainPath(kitHome);
  fs.mkdirSync(home, { recursive: true });
  try {
    fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify(APP_KIT_SETTINGS, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export const generalToolIds = () => Object.keys(read(path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker-tools.json')).tools);

export function installGeneral(options) {
  const registry = read(path.join(plainPath(options['manager-home']), 'registry.json'));
  const rows = (registry.instances ?? []).filter(row => row.mode === 'local_agent' && !row.signedOutAt && row.agentName === options.agent);
  if (rows.length !== 1) throw new Error(`Expected one paired Agent; found ${rows.length}`);
  const result = installGeneralForInstance({ directory: rows[0].directory, kitHome: options['kit-home'] });
  return `Installed ${result.toolIds.length} general tools for this Agent. Reload its Worker to advertise them; installation grants no permissions.`;
}

// The manager calls this only after its instance's Worker has drained and exited.
// The CLI and running-manager setup share exactly the same installer.
export function installGeneralForInstance({ directory, kitHome: requestedHome }) {
  const kitHome = plainPath(requestedHome);
  fs.mkdirSync(plainPath(path.join(kitHome, 'specs')), { recursive: true });
  const general = generalSettings(kitHome);
  const runTimeout = workerRunTimeoutSeconds(kitHome);
  const localFile = plainPath(path.join(directory, 'local.json'));
  const local = read(localFile);
  const env = local.worker?.env ?? {};
  if (!env.RULITH_WORKER_ROOT || !env.RULITH_TOOLS_FILE) throw new Error('Pair the Agent and enable its Worker once first');
  if (!path.isAbsolute(env.RULITH_WORKER_ROOT) || !path.isAbsolute(env.RULITH_TOOLS_FILE)) throw new Error('Worker paths must be absolute');
  const target = plainPath(path.join(env.RULITH_WORKER_ROOT, 'adapters', 'engineering-work'));
  const toolsFile = plainPath(env.RULITH_TOOLS_FILE);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ours = read(path.join(here, 'worker-tools.json'));
  if (general.webSearch) ours.tools['web.search@1'].env.pass.push(general.webSearch.keyEnv);
  const manifest = fs.existsSync(toolsFile) ? read(toolsFile) : { format: ours.format, tools: {} };
  if (manifest.format !== ours.format || !manifest.tools || Array.isArray(manifest.tools)) throw new Error('Invalid Worker tool manifest');
  for (const id of Object.keys(manifest.tools)) if (id.startsWith('eng.')) delete manifest.tools[id];
  manifest.tools = { ...manifest.tools, ...ours.tools };
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(here).filter(n => n.endsWith('.mjs') && !['install.mjs', 'installer.mjs'].includes(n)))
    fs.copyFileSync(plainPath(path.join(here, name)), plainPath(path.join(target, name)));
  save(toolsFile, manifest);
  local.worker.env = { ...env, ENG_KIT_HOME: kitHome, RULITH_WORKSPACE_TOOLS: 'read', RULITH_WORKER_RUN_TIMEOUT_SECONDS: String(runTimeout) };
  save(localFile, local);
  return { toolIds: Object.keys(ours.tools), kitHome };
}
