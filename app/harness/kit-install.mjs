import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeDirectory } from './runtime-kit.mjs';

const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const runInstaller = (node, argv, options) => {
  // Older Runtime CLIs do not know this subcommand. Refuse before invoking one, so a
  // default manager command can never be mistaken for successful kit installation.
  if (!fs.existsSync(path.resolve(path.dirname(argv[0]), '../kits/general/installer.mjs')))
    return { status: 2, missingKit: true };
  return spawnSync(node, argv, options);
};
// The Runtime installer's fixed refusal words (kits/general/installer.mjs, general-settings.mjs and the CLI's
// subcommand check). Only a last stderr line matching one of them is shown: other lines (a JSON parse error, a
// file-system error) can carry paths or instance data and stay unprinted.
const INSTALLER_WORDS = [
  /^Expected --agent <name> --kit-home <dir> \[--manager-home <dir>\]$/, /^--agent and --kit-home are required$/,
  /^Installation path contains a link$/, /^Expected one paired Agent; found \d+$/,
  /^Pair the Agent and enable its Worker once first$/, /^Worker paths must be absolute$/,
  /^Invalid Worker tool manifest$/, /^settings refused$/, /^Expected rulith kit install general$/,
];
export function installerRefusal(stderr) {
  const last = String(stderr ?? '').trim().split(/\r?\n/).pop()?.trim() ?? '';
  return INSTALLER_WORDS.some(words => words.test(last)) ? last : '';
}

// Whether a manager already serves this port. Several launchers may share one manager home; the first one started the
// manager, and its Workers are running on the files a refresh would rewrite.
export const managerListening = (port, timeoutMs = 1000) => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.on('connect', () => done(true));
  socket.on('error', () => done(false));
});

// Refresh the paired Agent(s) that already have an engineering kit home: only `agent` when the launcher names one,
// every paired Agent otherwise. With `kitHome` (the app home's kit, when the launcher has no settings file), an Agent
// whose Worker is enabled but has no kit home yet is installed there: the first paired Agent gets the kit at the next
// start without any setting. The Runtime installer overwrites the legacy adapters at the same adapters/engineering-work
// paths, merges its manifest and writes local.json by temp file + rename. It owns Worker env/timeouts; settings.json and
// pinned specs stay in their old home. This runs before the manager/Workers start; it neither pairs nor starts anything.
export function refreshGeneralKits(managerHome, { agent, kitHome, env = process.env, run = runInstaller, readJson = read } = {}) {
  const rows = (readJson(path.join(managerHome, 'registry.json'))?.instances ?? [])
    .filter(row => row.mode === 'local_agent' && !row.signedOutAt && (!agent || row.agentName === agent));
  let count = 0;
  for (const row of rows) {
    const worker = readJson(path.join(row.directory, 'local.json'))?.worker?.env;
    const home = worker?.ENG_KIT_HOME || kitHome;
    if (!home || !worker?.RULITH_WORKER_ROOT || !worker.RULITH_TOOLS_FILE) continue;
    const entry = path.join(runtimeDirectory(env), 'local', 'rulith-local.mjs');
    const result = run(process.execPath, [entry, 'kit', 'install', 'general', '--agent', row.agentName,
      '--kit-home', home, '--manager-home', managerHome],
    { env, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    if (result.missingKit)
      throw new Error('Deep Rulith: general kit installation failed; use a Runtime with kits/general (RULITH_RUNTIME_DIR).');
    if (result.error || result.status !== 0) {
      const refusal = installerRefusal(result.stderr);
      throw new Error(`Deep Rulith: general kit installation failed for Agent "${row.agentName}"${refusal ? `: ${refusal}` : ''}.`);
    }
    count++;
  }
  return count;
}
