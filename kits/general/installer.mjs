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

export function installGeneral(options) {
  const kitHome = plainPath(options['kit-home']);
  if (!fs.statSync(plainPath(path.join(kitHome, 'specs', 'test.json'))).isFile())
    throw new Error('Kit home needs specs/test.json (see pinned-test.example.json)');
  const general = generalSettings(kitHome);
  const runTimeout = workerRunTimeoutSeconds(kitHome);
  const registry = read(path.join(plainPath(options['manager-home']), 'registry.json'));
  const rows = (registry.instances ?? []).filter(row => row.mode === 'local_agent' && !row.signedOutAt && row.agentName === options.agent);
  if (rows.length !== 1) throw new Error(`Expected one paired Agent; found ${rows.length}`);
  const localFile = plainPath(path.join(rows[0].directory, 'local.json'));
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
  return `Installed ${Object.keys(ours.tools).length} general tools for this Agent. Restart its Worker, install the kit Capability, and bind Source "lab" to the project.`;
}
