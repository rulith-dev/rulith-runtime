// SPDX-License-Identifier: Apache-2.0
/**
 * 把编程能力的适配器**进程树**整个关进隔离壳（模型命令隔离，D-1024a）。Worker 用 execFile 启动适配器（见
 * rulith-worker.mjs handRun），模型写下、经编程能力运行的每条命令（含后台作业）都是适配器的后代，继承这层隔离——kit
 * 自身的字节一个都不改（kit 的 Release 摘要不变，已安装的 Agent 不会 worker_tools_mismatch）。
 *
 * 结构（复审后的稳健设计）：
 * - **凭据根是目录，整棵打标签。** 管理器 home、app home、dsh home、设置文件所在位置与 `~/.rulith` 兜底，各由其主人在
 *   启动时用 SetNamedSecurityInfo 打上可继承的“中完整性、不可读上行”标签（S:(ML;OICI;NRNW;;;ME)，会传到既有子项）。
 *   之后在里面新写的文件、原子改写的改名目标、临时文件、备份和任何未知文件名都自动继承，不靠文件名单。
 * - **受限进程要用的东西全都搬到凭据根之外的工作根**（Windows `%LOCALAPPDATA%\Rulith\work\<实例>`，Linux
 *   `$XDG_DATA_HOME/rulith-work/<实例>`）：Worker 根（适配器实现，低完整性只读）、kit home（低完整性可写）及其临时目录
 *   与包缓存、作业状态。低完整性进程在启动和解析路径时会 lstat 祖先目录，所以它绝不能需要穿过不可读上行的目录（实测）。
 * - **每次启动前校验。** Windows 上由启动器在 CreateProcessAsUserW 之前读每个凭据根的标签（`--require-nr`），有一个
 *   没有不可读上行就拒绝（fail-closed）。要校验的根由 Worker 自己推出（实例目录 → 管理器 home、`~/.rulith` 兜底），
 *   再加管理器交来的根；安全性不依赖启动器设的环境变量。标签缺了由中完整性的管理器在下次启动 Worker 前重新打上。
 * - **项目目录不得与凭据根或工作根互相包含**：否则低完整性标签会扩散进凭据，或凭据根被当成项目——一律拒绝。
 *
 * - **Windows**：适配器以低完整性运行。小启动器的 C# 源随 Runtime 发布并按摘要自检，首次用本机 .NET Framework 的
 *   csc.exe 编译进管理器 home 的 bin（凭据根内：受限进程改不了它），每次用前按记录的摘要复核。
 * - **Linux**：适配器在 bwrap 里运行（整根只读；项目与 kit home 可写；凭据根以 tmpfs 遮盖；不断网——web 工具要联网，
 *   本机端口靠命令读不到的机密来挡）。bwrap 不在就拒。新的 pid 命名空间让命令看不到宿主进程（/proc/<pid>/environ 里有
 *   Worker 与 Agent 的凭据），代价是后台作业随发起它的那次工具调用结束——见 docs/model-command-isolation.md。
 * - **macOS**：本批不隔离，命令照常运行（PSC 与确认框如实写明）。
 *
 * 默认在 Windows 与 Linux 上要求隔离；`RULITH_ADAPTER_SANDBOX=off` 只作为负责人持久化在实例 local.json（凭据根内）里的
 * “不隔离运行（不推荐）”设置被采纳，测试用它起裸适配器。
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * off | required. The default on Windows and Linux is required, independent of any environment variable: a parent that
 * strips RULITH_* (the managed instance's isolated environment) cannot turn confinement off by omission. `off` is honored
 * only as an explicit value of the Worker's own environment, which the manager layers from the instance's local.json —
 * inside a no-read-up credential root a confined command can neither read nor write. macOS has no shell this batch.
 */
export function adapterSandboxMode(env = process.env) {
  if (!(process.platform === 'win32' || process.platform === 'linux')) return 'off'
  return (env.RULITH_ADAPTER_SANDBOX ?? '').toLowerCase() === 'off' ? 'off' : 'required'
}

// Production-facing runtime text is English (the user-facing Chinese is rendered by the app layer).
const CONFINE_FAILCLOSED_WIN = 'model-command isolation unavailable: could not prepare the low-integrity launcher'
  + ' (command not run, fail-closed). Reason: '
const CONFINE_FAILCLOSED_LINUX = 'model-command isolation sandbox bubblewrap (bwrap) is unavailable: command not run'
  + ' (fail-closed). Install bubblewrap, or explicitly choose "run without isolation (not recommended)" in settings.'
const CONFINE_FAILCLOSED_OTHER = 'model-command isolation has no shell on this platform yet: command not run (fail-closed).'
const CONFINE_OVERLAP = 'model-command isolation refused: the project folder contains, or lies inside, a Rulith credential'
  + ' or work location (command not run). Open a folder that does not hold Rulith\'s own data.'
const CONFINE_WRITABLE_OVERLAP = 'model-command isolation refused: a folder the command would be allowed to write (the kit'
  + ' home) contains, or lies inside, a Rulith credential location (command not run). Move the kit home out of Rulith\'s'
  + ' credential folders.'

// ── Layout ────────────────────────────────────────────────────────────────────
const real = (path) => { try { return realpathSync(path) } catch { return resolve(path) } }
const exists = (path) => { try { statSync(path); return true } catch { return false } }
/** `inner` is `outer` or below it (case-insensitively on Windows). */
export function pathWithin(outer, inner) {
  const fold = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p))
  const rel = relative(fold(outer), fold(inner))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
/** The Rulith home backstop, `~/.rulith` (from the account's home directory, never from a launcher setting). */
export const rulithBackstop = () => join(homedir(), '.rulith')
/** The manager home that owns an instance directory: the nearest ancestor holding the manager's registry.json. */
export function managerHomeOf(instanceDir) {
  if (typeof instanceDir !== 'string' || !isAbsolute(instanceDir)) return undefined
  let dir = resolve(instanceDir)
  for (let i = 0; i < 4; i++) {
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
    if (existsSync(join(dir, 'registry.json'))) return dir
  }
  return undefined
}
/** The instance directory a Worker belongs to, from what its own host set when it spawned it. */
export function instanceDirOf(env = process.env) {
  for (const file of [env.RULITH_LOCAL_CONFIG, env.RULITH_TOOLS_FILE, env.RULITH_SECRETS_FILE]) {
    if (typeof file === 'string' && isAbsolute(file)) return dirname(file)
  }
  return undefined
}
/** Where confined processes' writable state lives: outside every credential root. */
export function workBase(env = process.env) {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Rulith', 'work')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'rulith-work')
}
export const workRootFor = (instanceId, env = process.env) => join(workBase(env), instanceId)

/**
 * Who a Worker is, for confinement: its instance directory (from the files its host gave it), the manager home and the
 * instance id its host named (RULITH_MANAGER_HOME, RULITH_INSTANCE_ID: set by the manager for every Worker it starts, so
 * an instance kept outside the manager home is covered too), falling back to the nearest manager registry above the
 * instance directory and the directory's name. The work root follows the instance id, as the manager's does.
 */
export function confinementIdentity(env = process.env) {
  const instanceDir = instanceDirOf(env)
  const named = typeof env.RULITH_MANAGER_HOME === 'string' && isAbsolute(env.RULITH_MANAGER_HOME) ? resolve(env.RULITH_MANAGER_HOME) : undefined
  const managerHome = named ?? managerHomeOf(instanceDir)
  const instanceId = typeof env.RULITH_INSTANCE_ID === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(env.RULITH_INSTANCE_ID)
    ? env.RULITH_INSTANCE_ID : instanceDir ? basename(instanceDir) : undefined
  return { instanceDir, managerHome, instanceId, workRoot: instanceId ? workRootFor(instanceId, env) : undefined }
}

/**
 * The credential roots a confined adapter must never read: the manager home and the instance directory of the Worker
 * (confinementIdentity), the `~/.rulith` backstop, and the extra roots the manager names in RULITH_CREDENTIAL_ROOTS (dsh
 * home, a settings file's key file or model home). Directories or single files; only existing ones, de-duplicated.
 */
export function credentialRoots(env = process.env) {
  const roots = new Map()
  const add = (path) => { if (typeof path === 'string' && path && isAbsolute(path) && exists(path)) roots.set(process.platform === 'win32' ? real(path).toLowerCase() : real(path), real(path)) }
  const { instanceDir, managerHome } = confinementIdentity(env)
  add(managerHome)
  add(instanceDir)
  add(rulithBackstop())
  let listed = []
  try { const parsed = JSON.parse(env.RULITH_CREDENTIAL_ROOTS ?? '[]'); if (Array.isArray(parsed)) listed = parsed } catch { /* malformed */ }
  for (const dir of listed) add(dir)
  return [...roots.values()]
}

/** Does `folder` contain, or lie inside, any of `protectedDirs`? (A project must do neither.) */
export function overlapsProtected(folder, protectedDirs) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return false
  return protectedDirs.some((dir) => typeof dir === 'string' && dir && (pathWithin(dir, folder) || pathWithin(folder, dir)))
}

// ── Windows low-integrity launcher ────────────────────────────────────────────
// `low.exe [--require-nr <path>]... [--cwd <dir>] -- <program> [args...]`: refuses (exit 126) unless every --require-nr
// directory or file carries a Medium-or-higher mandatory label with NO_READ_UP; then DuplicateTokenEx → Low → CreateProcessAsUserW
// with the caller's stdio handles, mirroring the child's exit code. Arguments are re-quoted per CommandLineToArgvW.
export const LAUNCHER_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
class LowLauncher {
  const uint TOKEN_DUPLICATE=0x2, TOKEN_QUERY=0x8, TOKEN_ADJUST_DEFAULT=0x80, TOKEN_ASSIGN_PRIMARY=0x1, TOKEN_ADJUST_SESSIONID=0x100;
  const int SecurityImpersonation=2, TokenPrimary=1, TokenIntegrityLevel=25;
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string res1,desktop,title; public int x,y,xs,ys,xcc,ycc,fill,flags; public short sw,cbr; public IntPtr lpr,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint acc,out IntPtr tok);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr t,uint acc,IntPtr sa,int imp,int type,out IntPtr nt);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int cls,ref TOKEN_MANDATORY_LABEL info,int len);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr tok,string app,string cmd,IntPtr pa,IntPtr ta,bool inh,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetAce(IntPtr acl,int index,out IntPtr ace);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string name,int type,uint si,IntPtr owner,IntPtr grp,IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  // True when the object's effective mandatory label (its first label ACE that applies to the object itself, explicit or
  // inherited) is Medium (0x2000) or higher with the NO_READ_UP (0x2) policy. Works for files and directories.
  static bool ReadProtected(string path){
    IntPtr sacl, sd;
    if(GetNamedSecurityInfoW(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out sacl,out sd)!=0) return false;
    try{
      if(sacl==IntPtr.Zero) return false;
      int count=Marshal.ReadInt16(sacl,4);
      for(int i=0;i<count;i++){
        IntPtr ace; if(!GetAce(sacl,i,out ace)) continue;
        byte type=Marshal.ReadByte(ace,0), flags=Marshal.ReadByte(ace,1);
        if(type!=0x11 || (flags & 0x08)!=0) continue;
        uint mask=(uint)Marshal.ReadInt32(ace,4);
        IntPtr sid=new IntPtr(ace.ToInt64()+8);
        int n=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        if(n<1) return false;
        uint rid=(uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(n-1)));
        return (mask & 0x2)!=0 && rid>=0x2000;
      }
      return false;
    } finally { LocalFree(sd); }
  }
  static void ArgvQuote(string arg, StringBuilder cl){
    if(arg.Length>0 && arg.IndexOfAny(new char[]{' ','\t','\n','\v','"'})<0){ cl.Append(arg); return; }
    cl.Append('"');
    for(int i=0;;i++){
      int bs=0;
      while(i<arg.Length && arg[i]=='\\'){ i++; bs++; }
      if(i==arg.Length){ cl.Append('\\',bs*2); break; }
      else if(arg[i]=='"'){ cl.Append('\\',bs*2+1); cl.Append('"'); }
      else { cl.Append('\\',bs); cl.Append(arg[i]); }
    }
    cl.Append('"');
  }
  static int Main(string[] args){
    int sep=Array.IndexOf(args,"--");
    if(sep<0||sep==args.Length-1){ Console.Error.Write("low-launcher: usage [--require-nr path]... [--cwd dir] -- <cmd> [args]"); return 127; }
    string cwd=null; var required=new List<string>();
    for(int i=0;i<sep;i++){
      if(args[i]=="--cwd"&&i+1<sep) cwd=args[++i];
      else if(args[i]=="--require-nr"&&i+1<sep) required.Add(args[++i]);
    }
    foreach(var path in required){
      if(!System.IO.Directory.Exists(path) && !System.IO.File.Exists(path)) continue;
      if(!ReadProtected(path)){ Console.Error.Write("rulith-isolation-refused: "+path+" is not read-protected from model commands."); return 126; }
    }
    var sb=new StringBuilder();
    for(int i=sep+1;i<args.Length;i++){ if(i>sep+1) sb.Append(' '); ArgvQuote(args[i],sb); }
    try{
      IntPtr cur; if(!OpenProcessToken(GetCurrentProcess(),TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_DEFAULT|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_SESSIONID,out cur)) throw new Exception("OpenProcessToken "+Marshal.GetLastWin32Error());
      IntPtr dup; if(!DuplicateTokenEx(cur,TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_DEFAULT|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_SESSIONID,IntPtr.Zero,SecurityImpersonation,TokenPrimary,out dup)) throw new Exception("DuplicateTokenEx "+Marshal.GetLastWin32Error());
      IntPtr lowSid; if(!ConvertStringSidToSid("S-1-16-4096",out lowSid)) throw new Exception("ConvertStringSidToSid "+Marshal.GetLastWin32Error());
      var ml=new TOKEN_MANDATORY_LABEL(); ml.Label.Sid=lowSid; ml.Label.Attributes=0x20;
      int len=Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL))+GetLengthSid(lowSid);
      if(!SetTokenInformation(dup,TokenIntegrityLevel,ref ml,len)) throw new Exception("SetTokenInformation "+Marshal.GetLastWin32Error());
      var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.flags=0x100;
      si.hStdInput=GetStdHandle(-10); si.hStdOutput=GetStdHandle(-11); si.hStdError=GetStdHandle(-12);
      PROCESS_INFORMATION pi;
      if(!CreateProcessAsUser(dup,null,sb.ToString(),IntPtr.Zero,IntPtr.Zero,true,0,IntPtr.Zero,cwd,ref si,out pi)) throw new Exception("CreateProcessAsUser "+Marshal.GetLastWin32Error());
      WaitForSingleObject(pi.hProcess,0xFFFFFFFF); uint code; GetExitCodeProcess(pi.hProcess,out code); return (int)code;
    }catch(Exception e){ Console.Error.Write("low-launcher: "+e.Message); return 127; }
  }
}
`

const cscPath = (env = process.env) => join(env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

/**
 * Compile (once) and verify the low-integrity launcher in `binDir`; return its path. The C# source is checked against
 * the digest of LAUNCHER_SOURCE; the exe is recorded with its own digest and re-verified before each use (a swapped exe
 * is recompiled). `binDir` lies inside a credential root, so a confined process can neither read nor replace it.
 * Compiles to a unique temporary name and renames, so two processes preparing it at once never see a half-written exe.
 */
export function ensureWindowsLauncher(binDir, { env = process.env } = {}) {
  mkdirSync(binDir, { recursive: true })
  const sourcePath = join(binDir, 'rulith-low-launcher.cs')
  const exePath = join(binDir, 'rulith-low-launcher.exe')
  const recordPath = join(binDir, 'rulith-low-launcher.sha256')
  const wantSource = sha256(Buffer.from(LAUNCHER_SOURCE, 'utf8'))
  const current = () => existsSync(exePath) && existsSync(recordPath) && existsSync(sourcePath)
    && sha256(readFileSync(sourcePath)) === wantSource
    && sha256(readFileSync(exePath)) === readFileSync(recordPath, 'utf8').trim()
  if (current()) return exePath
  const csc = cscPath(env)
  if (!existsSync(csc)) throw new Error(`.NET csc not found at ${csc}`)
  const stamp = randomUUID()
  const tmpSource = join(binDir, `launcher-${stamp}.cs`), tmpExe = join(binDir, `launcher-${stamp}.exe`)
  try {
    writeFileSync(tmpSource, LAUNCHER_SOURCE)
    if (sha256(readFileSync(tmpSource)) !== wantSource) throw new Error('launcher source digest mismatch after write')
    const result = spawnSync(csc, ['-nologo', `-out:${tmpExe}`, tmpSource], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0 || !existsSync(tmpExe)) throw new Error(`csc failed: ${String(result.stderr || result.stdout || result.error?.message).slice(0, 200)}`)
    const digest = sha256(readFileSync(tmpExe))
    try { renameSync(tmpExe, exePath) } catch (error) { if (!current()) throw error; return exePath }
    renameSync(tmpSource, sourcePath)
    writeFileSync(recordPath, digest + '\n')
  } finally {
    rmSync(tmpSource, { force: true }); rmSync(tmpExe, { force: true })
  }
  if (!current()) throw new Error('launcher verification failed after compile')
  return exePath
}

// ── Linux bwrap profile ───────────────────────────────────────────────────────
/** bwrap args (excluding `bwrap`), ending with the program. Host read-only; project, kit home and temp writable; the
 *  credential roots masked with tmpfs; a private pid namespace and /proc. The network is NOT unshared. */
export function bwrapAdapterArgv({ execPath, argv, cwd, writableRoots = [], hideRoots = [] }) {
  return [
    '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    ...hideRoots.flatMap((dir) => ['--tmpfs', dir]),
    ...writableRoots.flatMap((dir) => ['--bind', dir, dir]),
    ...(cwd ? ['--chdir', cwd] : []),
    '--', execPath, ...argv,
  ]
}

const resolveBwrap = () => {
  try { if (spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0) return 'bwrap' } catch { /* absent */ }
  return undefined
}

/**
 * Extra env for a confined adapter so it can write temp and package caches: redirected into the kit home in the work
 * root, which is Low-writable. The system temp and the default user caches are Medium, unwritable by the Low adapter.
 */
export function confinedCacheEnv(kitHome) {
  if (typeof kitHome !== 'string' || !kitHome || !isAbsolute(kitHome)) return {}
  const tmp = join(kitHome, 'adapter-tmp'), npm = join(kitHome, 'npm-cache'), pip = join(kitHome, 'pip-cache')
  for (const dir of [tmp, npm, pip]) try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return { TEMP: tmp, TMP: tmp, TMPDIR: tmp, npm_config_cache: npm, PIP_CACHE_DIR: pip }
}

/**
 * How to launch the adapter: the file and args to hand execFile, in place of (execPath, argv). Unconfined mode returns
 * (execPath, argv). Confined: refuse a project that overlaps a credential root or the work root; Windows wraps with the
 * low-integrity launcher, which itself refuses unless every credential root is read-protected; Linux wraps with bwrap,
 * masking every credential root. Fail-closed throws.
 * @param options.binDir   where the Windows launcher is compiled/verified (inside a credential root).
 * @param options.writableRoots  what the adapter may write (project, kit home) — Linux binds them rw.
 * @param options.roots    the credential roots to verify/mask (defaults to credentialRoots(env)).
 * @param options.workRoot the instance's work root (a project may not overlap it).
 * @param options.project  the project folder (checked for overlap).
 */
export function confinedLaunch({ execPath, argv, cwd, binDir, writableRoots = [], roots, workRoot, project, env = process.env }) {
  const mode = adapterSandboxMode(env)
  if (mode === 'off') return { file: execPath, args: argv, confined: false }
  // A refusal the Worker's host recorded when it labelled the credential roots (e.g. a file inside one kept another
  // label). It only ever adds a refusal; the launcher's own per-launch check does not depend on it.
  const recorded = typeof env.RULITH_CONFINEMENT_REFUSAL === 'string' ? env.RULITH_CONFINEMENT_REFUSAL.trim() : ''
  if (recorded) throw new Error(recorded)
  const credRoots = roots ?? credentialRoots(env)
  if (project !== undefined && overlapsProtected(project, [...credRoots, ...(workRoot ? [workRoot] : [])])) throw new Error(CONFINE_OVERLAP)
  // Anything else made writable (the kit home) must not reach into a credential root either: on Linux its rw bind would
  // re-expose what the mask hides.
  if (writableRoots.some((dir) => dir !== project && overlapsProtected(dir, credRoots))) throw new Error(CONFINE_WRITABLE_OVERLAP)
  if (process.platform === 'win32') {
    if (!binDir) throw new Error(CONFINE_FAILCLOSED_WIN + 'no bin directory for the launcher')
    let launcher
    try { launcher = ensureWindowsLauncher(binDir, { env }) } catch (error) { throw new Error(CONFINE_FAILCLOSED_WIN + String(error.message)) }
    return { file: launcher, args: [...credRoots.flatMap((dir) => ['--require-nr', dir]), ...(cwd ? ['--cwd', cwd] : []), '--', execPath, ...argv], confined: true }
  }
  if (process.platform === 'linux') {
    if (!resolveBwrap()) throw new Error(CONFINE_FAILCLOSED_LINUX)
    // Only the outermost roots are masked: a root inside another is already hidden with it.
    const hideRoots = credRoots.filter((dir) => !credRoots.some((other) => other !== dir && pathWithin(other, dir)))
    return { file: 'bwrap', args: bwrapAdapterArgv({ execPath, argv, cwd, writableRoots, hideRoots }), confined: true }
  }
  throw new Error(CONFINE_FAILCLOSED_OTHER)
}
