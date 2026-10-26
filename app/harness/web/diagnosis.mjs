// The one settings page's Diagnosis (design §3.2 设置 → 高级 → 诊断; batch 7): the versions running, whether model commands
// are isolated on this computer, and where Rulith keeps its files. It replaces the retired English workbench as the place
// to look when something is wrong. Read only, and nothing secret: versions, paths, Agent names and a status sentence.
//
// 中文说明：设置页「高级 → 诊断」的数据：版本、本机模型命令隔离状态、各文件夹位置。只读，不含任何密钥。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rulithBackstop, workBase } from '../../../worker/adapter-confinement.mjs';
import { homeLabelVerified, protectionProblems } from '../../../local/sandbox-home-label.mjs';
import { say } from './ui-texts.mjs';

const require = createRequire(import.meta.url);
const versionAt = (file) => { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version ?? ''); } catch { return ''; } };

/**
 * Whether model commands run isolated here, as the Worker decides it (worker/adapter-confinement.mjs, PSC 0.2.31): on
 * Windows at low integrity with Rulith's credential folders read-protected, on Linux under bubblewrap, nowhere else yet.
 * `roots` are the credential folders the Worker checks before every command; one that is not protected means commands
 * are refused (fail-closed), which is what this says. `offFor` names the Agents whose isolation is switched off: the
 * switch is per Agent (RULITH_ADAPTER_SANDBOX=off in its instance's Worker environment), never the app's. `problems` are
 * what the labelling code noted it could not protect, and why (sandbox-home-label.mjs noteProtection): the reason is
 * shown next to a root that is still unprotected, and every project folder that could not be made writable (or put back)
 * is listed in `problems` of the answer.
 */
export function isolationStatus({ platform = process.platform, roots = [], offFor = [], problems = [], protectedRoot = homeLabelVerified,
  bwrap = () => spawnSync('bwrap', ['--version'], { windowsHide: true }).status === 0 } = {}) {
  if (platform !== 'win32' && platform !== 'linux')
    return { state: 'unavailable', text: say('isolation.unavailable') };
  let status;
  if (platform === 'linux') {
    status = bwrap()
      ? { state: 'on', text: say('isolation.linuxOn') }
      : { state: 'refusing', text: say('isolation.noBwrap') };
  } else {
    const unprotected = roots.filter((root) => {
      try { return fs.existsSync(root) && !protectedRoot(root); } catch { return true; }
    });
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const reasonOf = (root) => problems.find((row) => row.kind === 'root' && same(row.path, root))?.reason;
    status = unprotected.length
      ? { state: 'refusing', text: say(unprotected.length === 1 ? 'isolation.refusingOne' : 'isolation.refusingMany',
        { roots: unprotected.map((root) => (reasonOf(root) ? `${root} (${reasonOf(root)})` : root)).join(', ') }) }
      : { state: 'on', text: say('isolation.windowsOn') };
    // Root problems noted earlier but fixed since are not shown; project problems are.
    const shown = problems.filter((row) => row.kind === 'project' || (row.kind === 'root' && unprotected.some((root) => same(root, row.path))))
      .map(({ kind, path: where, reason }) => ({ kind, path: where, reason }));
    if (shown.length) status.problems = shown;
  }
  if (!offFor.length) return status;
  return { state: status.state === 'on' ? 'partly-off' : status.state,
    text: say('isolation.offFor', { status: status.text, agents: offFor.join(', ') }) };
}

/**
 * The Agents set up here whose isolation is switched off: `RULITH_ADAPTER_SANDBOX=off` in their instance's Worker
 * environment. Only that one field of each instance's local.json is read; nothing else of it leaves this function.
 */
export function isolationOffFor(managerHome) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(path.join(managerHome, 'registry.json'), 'utf8')).instances ?? []; } catch { return []; }
  return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.directory === 'string' && !row.signedOutAt).filter((row) => {
    try {
      const env = JSON.parse(fs.readFileSync(path.join(row.directory, 'local.json'), 'utf8'))?.worker?.env;
      return String(env?.RULITH_ADAPTER_SANDBOX ?? '').toLowerCase() === 'off';
    } catch { return false; }
  }).map((row) => String(row.agentName || row.name || row.id));
}

/** The Diagnosis report for the page. `legacyWorkbench` is what the launcher found (app-home.mjs legacyWorkbench). */
export function diagnosisReport({ managerHome, dshHome, appHome, kitHome, keyFile, legacyWorkbench = null, env = process.env,
  isolation = isolationStatus } = {}) {
  let listed = [];
  try { const parsed = JSON.parse(env.RULITH_CREDENTIAL_ROOTS ?? '[]'); if (Array.isArray(parsed)) listed = parsed.filter((p) => typeof p === 'string'); } catch { listed = []; }
  const roots = [...new Set([managerHome, dshHome, keyFile, rulithBackstop(), ...listed].filter((p) => typeof p === 'string' && p).map((p) => path.resolve(p)))];
  const folders = [
    ['folders.files', appHome], ['folders.manager', managerHome], ['folders.conversations', dshHome],
    ['folders.logs', dshHome ? path.join(dshHome, 'logs') : ''], ['folders.kit', kitHome], ['folders.work', workBase(env)],
  ].filter(([, where]) => typeof where === 'string' && where).map(([key, where]) => ({ label: say(key), path: path.resolve(where) }));
  return {
    versions: {
      rulith: versionAt(new URL('../../../package.json', import.meta.url)),
      dsh: (() => { try { return versionAt(require.resolve('@deepseek-ai/dsh/package.json')); } catch { return ''; } })(),
      node: process.version, platform: `${process.platform}-${process.arch}`,
    },
    isolation: isolation({ roots, offFor: typeof managerHome === 'string' && managerHome ? isolationOffFor(managerHome) : [],
      problems: typeof managerHome === 'string' && managerHome ? protectionProblems(managerHome) : [] }),
    folders,
    ...(legacyWorkbench ? { legacyWorkbench } : {}),
  };
}

/** The launcher's finding, as it was handed on (a JSON object with `home` and `agents`), or null. */
export function legacyFromEnv(env = process.env) {
  try {
    const value = JSON.parse(env.RULITH_DSH_LEGACY_WORKBENCH ?? 'null');
    return value && typeof value.home === 'string' && Number.isSafeInteger(value.agents) && value.agents > 0 ? { home: value.home, agents: value.agents } : null;
  } catch { return null; }
}
