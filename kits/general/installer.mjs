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
