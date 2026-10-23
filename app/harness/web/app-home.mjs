// Where the launcher's settings come from (start-deep-rulith.mjs). Two ways, one launcher:
//   · a settings file (`node start-deep-rulith.mjs <deep-rulith.json> [dsh web flags]`, or DEEP_RULITH_SETTINGS): read as
//     it is, nothing added (developers and the owner's own launchers);
//   · no settings file (the installed command with no arguments, or only dsh web flags): everything this computer's Deep
//     Rulith keeps lives in one app home directory, and every setting is derived from it (D-1018b batch 1).
// The launcher does the same thing with either; nothing here starts a process.
//
// 中文说明：零配置时只有一个目录（app home，默认 ~/.rulith/app，可用 RULITH_APP_HOME 改）。里面是管理器目录 manager、
// 管理器密钥 manager.key（第一次运行时随机生成，此后原样复用，从不打印）、dsh 的目录 dsh（profile 由启动器自动创建）、
// 通用工具包目录 kit。路径全部由它推出；dsh 与 Runtime 从本包的依赖里找，不用配置。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { acquireWorkbenchLease } from 'rulith/local/manager-registry.mjs';

export const APP_HOME_ENV = 'RULITH_APP_HOME';
// The ports the owner's settings have always used; another free one is taken only when one of these is busy.
export const PREFERRED_PORTS = Object.freeze({ manager: 7790, web: 3080 });
// The Runtime manager accepts a fixed key of 16-128 of these characters (rulith-local.mjs, RULITH_MANAGER_KEY).
const MANAGER_KEY = /^[A-Za-z0-9_-]{16,128}$/;

const require = createRequire(import.meta.url);
/** The file a dependency's package.json names as its command (`bin`), resolved where this package is installed. */
function dependencyBin(name, command) {
  const manifest = require.resolve(`${name}/package.json`);
  const bin = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin;
  return path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin[command]);
}

/** The app home: RULITH_APP_HOME when set, else `.rulith/app` in the user's home directory. */
export function appHome(env = process.env, home = os.homedir()) {
  const chosen = env[APP_HOME_ENV]?.trim();
  return path.resolve(chosen || path.join(home, '.rulith', 'app'));
}

/**
 * Settings from the arguments: a settings file when one is named (DEEP_RULITH_SETTINGS, or a first argument that is not a
 * flag), exactly as before: the file's settings, and the launcher's own arguments after the file. Otherwise the app home's
 * derived settings, with every argument passed on. `home` is set only in the second case.
 */
export async function launcherSettings(argv = process.argv, env = process.env, { ports } = {}) {
  const file = env.DEEP_RULITH_SETTINGS || (argv[2] && !argv[2].startsWith('-') ? argv[2] : undefined);
  if (file) return { settings: JSON.parse(fs.readFileSync(file, 'utf8')), args: argv.slice(3) };
  const home = appHome(env);
  return { settings: await appSettings(home, { ports }), args: argv.slice(2), home };
}

/**
 * Create (first run) or reuse the app home and derive the launcher settings from it. The directories and the key are made
 * only when absent; an existing key is reused as it is. The key is read here only to check it, and never printed.
 * The dsh profile is not made here: the launcher creates it from dsh's web template when it is missing.
 */
export async function appSettings(home, { ports = freePorts } = {}) {
  const at = (name) => path.join(home, name);
  for (const dir of [home, at('manager'), at('dsh'), at('kit')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = at('manager.key');
  // 密钥只在第一次生成：先以 wx 建一个空文件（绝不覆盖已有的），收紧权限，再写入密钥。POSIX 上是 0600；Windows 没有
  // 权限位，改为去掉继承的访问控制、只留当前用户一项（ownerOnly）。
  let created = true;
  try { fs.writeFileSync(keyFile, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; created = false; }
  if (created) {
    ownerOnly(keyFile);
    fs.writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`);
  }
  if (!MANAGER_KEY.test(fs.readFileSync(keyFile, 'utf8').trim()))
    throw new Error(`Deep Rulith: ${keyFile} does not hold a valid manager key; remove the file and start again`);
  const [managerPort, webPort] = await ports([PREFERRED_PORTS.manager, PREFERRED_PORTS.web]);
  // No cwd: like `dsh web`, the folder the command runs in is the default workspace of new conversations (not a grant).
  return {
    dshBin: dependencyBin('@deepseek-ai/dsh', 'dsh'), dshHome: at('dsh'),
    managerHome: at('manager'), managerPort, keyFile,
    runtimeEntry: dependencyBin('rulith', 'rulith'), persona: fileURLToPath(new URL('../runtime-persona.txt', import.meta.url)),
    webPort, kitHome: at('kit'),
  };
}

/**
 * Windows has no permission bits, so the file's inherited access list is replaced by one entry: this user, by SID (the
 * system's own whoami and icacls, never whichever a PATH finds first). A file system without access lists (FAT, some
 * shares) keeps its folder's access, and the start goes on with a warning.
 */
function ownerOnly(file) {
  if (process.platform !== 'win32') return;
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  try {
    const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
      .trim().split(',').pop().replace(/"/g, '');
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('no SID');
    execFileSync(path.join(system, 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`], { stdio: 'ignore', windowsHide: true });
  } catch {
    console.error(`Deep Rulith: could not limit ${file} to this user; it keeps its folder's access.`);
  }
}

const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server));
});
/**
 * One free loopback port per preferred port: the preferred one when it can be bound, else one the system picks. All probes
 * are held until every port is chosen, so two answers never coincide. The manager and dsh bind 127.0.0.1 themselves.
 */
export async function freePorts(preferred) {
  const servers = [];
  try {
    for (const port of preferred) {
      servers.push(await listen(port).catch((error) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') return listen(0);
        throw error;
      }));
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

/**
 * One Deep Rulith per app home, held until this process exits. A second one would start a second manager on the same
 * manager home (the Runtime refuses it, after this launcher had already refreshed the kit under the first one's Workers)
 * and a second dsh on the same profile. The Runtime's own lease is used: it proves a recorded holder gone (pid reuse
 * included) before it takes a lock over.
 */
export async function holdAppHome(home) {
  try {
    const lease = await acquireWorkbenchLease(path.join(home, 'launcher.lock'));
    process.on('exit', lease.release);
    return lease.release;
  } catch (error) {
    if (error?.name !== 'WorkbenchBusyError') throw error;
    throw new Error(`Deep Rulith is already running from ${home} (${error.detail}). Use its browser tab, or stop it and start again.`);
  }
}
