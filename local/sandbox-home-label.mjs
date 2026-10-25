// SPDX-License-Identifier: Apache-2.0
/**
 * Integrity labels for model-command isolation (D-1024a), applied by the owners of the directories they protect.
 *
 * 中文说明：凭据根（管理器 home、app home、dsh home、设置文件所在位置、`~/.rulith` 兜底）整个目录打上可继承的
 * “中完整性、不可读上行”标签 S:(ML;OICI;NRNW;;;ME)，用 SetNamedSecurityInfo 写入——它会传播到既有子项，之后新写的文件、
 * 原子改写的改名目标、临时文件、备份与任何未知文件名都自动继承，不靠文件名单。受限（低完整性）命令因此读不到其中任何东西；
 * 正常（中完整性）进程照常读写。受限进程要用的东西都在凭据根之外的工作根里（见 worker/adapter-confinement.mjs），所以它
 * 从不需要穿过这些目录。
 *
 * 打开的项目目录在打开期间打可继承的低完整性标签（受限命令可读写）；打开前把目录原本的标签（可能为空）记到管理器 home 下的
 * project-labels（凭据根内，受限命令读写不到），按占用者（实例）计数；最后一个占用者因关闭、移除或 Source 被收回而释放时，
 * 按原样还原并随继承传播到子项。
 *
 * 实现：不在任何适配器进程里加载原生代码——用每台受支持 Windows 都自带的 Windows PowerShell 5.1，`Add-Type` 以 P/Invoke
 * 调 advapi32，一次调用批量处理多条（编译一次约半秒）。非 Windows：无操作。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Inheritable Medium mandatory label with no-read-up and no-write-up: the credential roots. */
export const HOME_LABEL_SDDL = 'S:(ML;OICI;NRNW;;;ME)'
/** The same label on a single file (a credential root that is a file, e.g. a settings file's manager key). */
export const FILE_LABEL_SDDL = 'S:(ML;;NRNW;;;ME)'
/** Inheritable Low mandatory label: what a confined Low adapter may read and write (kit home, opened project). */
export const LOW_LABEL_SDDL = 'S:(ML;OICI;NW;;;LW)'
/** No explicit label at all (the default, which behaves as Medium): what an unlabeled folder is restored to. */
export const NO_LABEL_SDDL = 'S:'

const system32 = (env = process.env) => join(env.SystemRoot || 'C:\\Windows', 'System32')
const powershellExe = (env = process.env) => join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const icaclsExe = (env = process.env) => join(system32(env), 'icacls.exe')

/**
 * The PowerShell 5.1 helper: reads ISO_LABEL_OPS (JSON [{op:'set'|'get'|'verifyTree', path, sddl?}]) and prints
 * ISO_RESULT <json>. `verifyTree` walks everything below a directory (not following reparse points) and answers the first
 * entry whose effective label is not Medium-or-higher no-read-up, or null.
 */
export function labelOpsScript() {
  return [
    "$ErrorActionPreference='Stop'",
    '$ops = ConvertFrom-Json $env:ISO_LABEL_OPS',
    "Add-Type -Namespace Iso -Name Lbl -MemberDefinition @'",
    '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    'public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr psd, out uint size);',
    '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    'public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr psd, uint rev, uint si, out IntPtr str, out uint len);',
    '[DllImport("advapi32.dll", SetLastError=true)]',
    'public static extern bool GetSecurityDescriptorSacl(IntPtr psd, out bool present, out IntPtr psacl, out bool defaulted);',
    '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    'public static extern uint SetNamedSecurityInfoW(string name, int objType, uint secInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);',
    '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    'public static extern uint GetNamedSecurityInfoW(string name, int objType, uint secInfo, IntPtr owner, IntPtr group, IntPtr dacl, out IntPtr sacl, out IntPtr psd);',
    '[DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);',
    '[DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);',
    '[DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);',
    '[DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);',
    // The effective label is the first label ACE that applies to the object itself (not inherit-only).
    'public static bool ReadProtected(string path) {',
    '  IntPtr sacl, sd;',
    '  if (GetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sacl, out sd) != 0) return false;',
    '  try {',
    '    if (sacl == IntPtr.Zero) return false;',
    '    int count = Marshal.ReadInt16(sacl, 4);',
    '    for (int i = 0; i < count; i++) {',
    '      IntPtr ace; if (!GetAce(sacl, i, out ace)) continue;',
    '      byte type = Marshal.ReadByte(ace, 0), flags = Marshal.ReadByte(ace, 1);',
    '      if (type != 0x11 || (flags & 0x08) != 0) continue;',
    '      uint mask = (uint)Marshal.ReadInt32(ace, 4);',
    '      IntPtr sid = new IntPtr(ace.ToInt64() + 8);',
    '      int n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));',
    '      if (n < 1) return false;',
    '      uint rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1)));',
    '      return (mask & 0x2) != 0 && rid >= 0x2000;',
    '    }',
    '    return false;',
    '  } finally { LocalFree(sd); }',
    '}',
    // A directory this process cannot list is not listable by a Low process of the same account either, so it is skipped.
    'public static string FirstUnprotected(string root) {',
    '  var stack = new System.Collections.Generic.Stack<string>(); stack.Push(root);',
    '  while (stack.Count > 0) {',
    '    string[] entries;',
    '    try { entries = System.IO.Directory.GetFileSystemEntries(stack.Pop()); } catch { continue; }',
    '    foreach (var entry in entries) {',
    '      if (!ReadProtected(entry)) return entry;',
    '      var attributes = System.IO.File.GetAttributes(entry);',
    '      if ((attributes & System.IO.FileAttributes.Directory) != 0 && (attributes & System.IO.FileAttributes.ReparsePoint) == 0) stack.Push(entry);',
    '    }',
    '  }',
    '  return null;',
    '}',
    "'@",
    // Setting a mandatory label needs WRITE_OWNER. A folder on a non-system drive often inherits an access list that
    // gives its owner only Modify (no WRITE_OWNER); the owner's implicit WRITE_DAC lets it add one allow entry for
    // itself (TakeOwnership, inherited by what is inside) and then set the label. Objects owned by anyone else are
    // never touched. `ungrant` removes exactly that entry again.
    "function IsDir($p){ [IO.Directory]::Exists($p) }",
    "function AccessOf($p){ if(IsDir $p){ [IO.Directory]::GetAccessControl($p,'Access') } else { [IO.File]::GetAccessControl($p,'Access') } }",
    "function SaveAccess($p,$sec){ if(IsDir $p){ [IO.Directory]::SetAccessControl($p,$sec) } else { [IO.File]::SetAccessControl($p,$sec) } }",
    'function OwnerRule($p){',
    '  $me=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "  $inherit= if(IsDir $p){ [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }",
    '  New-Object Security.AccessControl.FileSystemAccessRule($me,[Security.AccessControl.FileSystemRights]::TakeOwnership,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)',
    '}',
    'function Grant($p){',
    "  $sec= if(IsDir $p){ [IO.Directory]::GetAccessControl($p,'Owner') } else { [IO.File]::GetAccessControl($p,'Owner') }",
    '  $owner=$sec.GetOwner([Security.Principal.SecurityIdentifier]); $me=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '  if($owner.Value -ne $me.Value){ throw "not_owner $($owner.Value)" }',
    '  $acl=AccessOf $p; $acl.AddAccessRule((OwnerRule $p)); SaveAccess $p $acl',
    '}',
    'function Ungrant($p){ $acl=AccessOf $p; [void]$acl.RemoveAccessRule((OwnerRule $p)); SaveAccess $p $acl }',
    'function SetLabel($p,$psacl){ [Iso.Lbl]::SetNamedSecurityInfoW($p,1,0x10,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,$psacl) }',
    '$out=@()',
    'foreach($o in $ops){',
    '  try{',
    "    if($o.op -eq 'verifyTree'){",
    '      $out+=@{path=$o.path;ok=$true;unprotected=[Iso.Lbl]::FirstUnprotected($o.path)}',
    "    } elseif($o.op -eq 'ungrant'){",
    '      Ungrant $o.path',
    '      $out+=@{path=$o.path;ok=$true}',
    "    } elseif($o.op -eq 'get'){",
    '      $sacl=[IntPtr]::Zero;$sd=[IntPtr]::Zero',
    '      $rc=[Iso.Lbl]::GetNamedSecurityInfoW($o.path,1,0x10,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$sacl,[ref]$sd)',
    '      if($rc -ne 0){ throw "get rc=$rc" }',
    '      $str=[IntPtr]::Zero;$len=0',
    "      if(-not [Iso.Lbl]::ConvertSecurityDescriptorToStringSecurityDescriptorW($sd,1,0x10,[ref]$str,[ref]$len)){ throw 'tostring failed' }",
    '      $s=[Runtime.InteropServices.Marshal]::PtrToStringUni($str); [Iso.Lbl]::LocalFree($str)|Out-Null; [Iso.Lbl]::LocalFree($sd)|Out-Null',
    '      $out+=@{path=$o.path;ok=$true;sddl=$s}',
    '    } else {',
    '      $psd=[IntPtr]::Zero;$sz=0',
    "      if(-not [Iso.Lbl]::ConvertStringSecurityDescriptorToSecurityDescriptorW($o.sddl,1,[ref]$psd,[ref]$sz)){ throw 'convert failed' }",
    '      $present=$false;$psacl=[IntPtr]::Zero;$def=$false',
    '      [Iso.Lbl]::GetSecurityDescriptorSacl($psd,[ref]$present,[ref]$psacl,[ref]$def)|Out-Null',
    // SE_FILE_OBJECT = 1, LABEL_SECURITY_INFORMATION = 0x10; inheritable labels are propagated to existing children.
    '      $granted=$false',
    '      try {',
    '        $rc=SetLabel $o.path $psacl',
    // ERROR_ACCESS_DENIED (5): no WRITE_OWNER. With `grant`, add it for the owner and try once more; undo it if that fails.
    '        if($rc -eq 5 -and $o.grant){',
    '          Grant $o.path; $granted=$true',
    '          $rc=SetLabel $o.path $psacl',
    '          if($rc -ne 0){ Ungrant $o.path; $granted=$false }',
    '        }',
    '      } finally { [Iso.Lbl]::LocalFree($psd)|Out-Null }',
    '      if($rc -ne 0){ throw "set rc=$rc" }',
    '      $out+=@{path=$o.path;ok=$true;granted=$granted}',
    '    }',
    '  } catch { $out+=@{path=$o.path;ok=$false;error="$_"} }',
    '}',
    "Write-Output ('ISO_RESULT ' + (ConvertTo-Json -Compress -InputObject @($out)))",
  ].join('\n')
}

/**
 * Run label operations in ONE PowerShell process. Windows only; elsewhere every op answers ok (nothing to do).
 * @param ops [{op:'set', path, sddl} | {op:'get', path}]
 * @returns the per-op results, in order; a failed invocation answers every op as not ok.
 */
export function labelOps(ops, { env = process.env, run = execFileSync } = {}) {
  if (ops.length === 0) return []
  if (process.platform !== 'win32') return ops.map((o) => ({ path: o.path, ok: true, skipped: 'label is a win32 mechanism' }))
  try {
    const out = String(run(powershellExe(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', labelOpsScript()],
      { env: { ...env, ISO_LABEL_OPS: JSON.stringify(ops) }, encoding: 'utf8', windowsHide: true }))
    const at = out.indexOf('ISO_RESULT ')
    if (at < 0) throw new Error(out.trim().slice(0, 200))
    const parsed = JSON.parse(out.slice(at + 'ISO_RESULT '.length))
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    return ops.map((o) => ({ path: o.path, ok: false, error: String(error?.message ?? error).slice(0, 200) }))
  }
}

/** The helper's error for a label operation, as an English reason. */
export function labelFailureReason(error) {
  const text = String(error ?? 'unknown')
  const owner = /not_owner (S-[0-9-]+)/.exec(text)
  if (owner) return `it is owned by another account (${owner[1]}), not by you, so Rulith leaves its access settings alone`
  if (/set rc=5\b/.test(text)) return 'Windows denied changing its integrity label (access denied), even after granting you the right to'
  if (/set rc=(50|1|87)\b/.test(text)) return 'its drive does not support integrity labels (use an NTFS drive)'
  return text.slice(0, 200)
}

const labelLine = (path, { env = process.env, run = execFileSync } = {}) => {
  try { return String(run(icaclsExe(env), [path], { encoding: 'latin1', windowsHide: true })).split(/\r?\n/).find((l) => /Mandatory Level/i.test(l)) ?? '' }
  catch { return '' }
}
/** The path carries a Medium (or higher) label with the no-read-up policy (explicit or inherited). Reads `icacls`. */
export function homeLabelVerified(path, options) {
  const line = labelLine(path, options)
  return /(Medium|High) Mandatory Level/i.test(line) && /\bNR\b/.test(line)
}
/** The path carries a Low label. */
export function lowLabelVerified(path, options) { return /Low Mandatory Level/i.test(labelLine(path, options)) }

const isDirectory = (path) => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * Label credential roots (directories: inheritable, propagated to what is already inside; files: on the file) and verify
 * them, in one helper run. A directory is then walked once: if anything inside kept a different label (propagation does
 * not replace an explicit label, e.g. one left by an elevated run), the root's new label is taken off again, so the
 * launcher's per-launch check refuses commands exactly as for an unlabeled root, and the reason names that path.
 * Returns Map(path → { ok, reason? }).
 */
function labelCredentialRoots(paths, options = {}) {
  const outcome = new Map()
  if (paths.length === 0) return outcome
  const plan = paths.map((path) => ({ path, directory: isDirectory(path) }))
  const results = labelOps(plan.flatMap(({ path, directory }) => [{ op: 'set', path, sddl: directory ? HOME_LABEL_SDDL : FILE_LABEL_SDDL, grant: true },
    ...(directory ? [{ op: 'verifyTree', path }] : [])]), options)
  const reverts = []
  let at = 0
  for (const { path, directory } of plan) {
    const set = results[at++], tree = directory ? results[at++] : undefined
    if (!set?.ok) { outcome.set(path, { ok: false, reason: `the label could not be applied: ${labelFailureReason(set?.error)}` }); continue }
    if (!homeLabelVerified(path, options)) { outcome.set(path, { ok: false, reason: 'the label was not present after it was applied' }); continue }
    if (directory && (!tree?.ok || tree.unprotected)) {
      reverts.push({ op: 'set', path, sddl: NO_LABEL_SDDL })
      outcome.set(path, { ok: false, reason: tree?.ok
        ? `${tree.unprotected} inside it keeps a different integrity label, so model commands could read it`
        : `what is inside it could not be checked (${tree?.error ?? 'unknown'})` })
      continue
    }
    outcome.set(path, { ok: true })
  }
  if (reverts.length > 0) labelOps(reverts, options)
  return outcome
}

/** Label one directory (or file) as a credential root and verify it, including everything already inside. Windows only. */
export function ensureHomeLabel(path, options = {}) {
  if (process.platform !== 'win32') return { ok: true, platform: process.platform, skipped: 'label is a win32 mechanism' }
  const result = labelCredentialRoots([resolve(path)], options).get(resolve(path))
  return result.ok ? { ok: true, platform: 'win32' } : { ok: false, platform: 'win32', reason: result.reason }
}

/**
 * Label a directory Low (inheritable, propagated to existing children) and verify it. Windows only. `granted` says the
 * owner was given WRITE_OWNER on it to make that possible (see labelOpsScript); the caller decides whether to undo it.
 */
export function ensureLowLabel(dir, options = {}) {
  if (process.platform !== 'win32') return { ok: true, platform: process.platform, skipped: 'label is a win32 mechanism' }
  const [result] = labelOps([{ op: 'set', path: dir, sddl: LOW_LABEL_SDDL, grant: true }], options)
  if (!result?.ok) return { ok: false, platform: 'win32', reason: labelFailureReason(result?.error) }
  if (!lowLabelVerified(dir, options)) return { ok: false, platform: 'win32', granted: result.granted === true, reason: 'the Low label was not present after it was applied' }
  return { ok: true, platform: 'win32', granted: result.granted === true }
}

/**
 * Make sure every existing directory or file in `paths` is a labeled credential root: those already carrying no-read-up
 * are left alone; the rest are labeled (and, for a directory, checked inside) in one batch. Returns
 * { ok, unlabeled: [paths still not protected], reasons: { path: why } }. With `noteTo` (a manager home) the outcome is
 * noted for Diagnosis. Windows only.
 */
export function ensureCredentialRootLabels(paths, { noteTo, ...options } = {}) {
  if (process.platform !== 'win32') return { ok: true, unlabeled: [], reasons: {} }
  const existing = [...new Set(paths.filter((p) => typeof p === 'string' && p && existsSync(p)).map((p) => resolve(p)))]
  const missing = existing.filter((p) => !homeLabelVerified(p, options))
  const reasons = {}
  for (const [path, result] of labelCredentialRoots(missing, options)) if (!result.ok) reasons[path] = result.reason
  const unlabeled = Object.keys(reasons)
  if (noteTo) noteProtection(noteTo, 'root', existing.map((path) => ({ path, ok: !(path in reasons), reason: reasons[path] })))
  return { ok: unlabeled.length === 0, unlabeled, reasons }
}

/** One English refusal naming every credential root that is not protected and why (empty when all are). */
export function credentialRootRefusal({ unlabeled = [], reasons = {} } = {}) {
  if (unlabeled.length === 0) return ''
  return 'Model-command isolation refused: ' + unlabeled.map((path) => `${path} is not protected from model commands (${reasons[path] ?? 'no label'})`).join('; ')
    + '. Nothing will run until Rulith can protect it; restart Rulith, or repair that location\'s access settings.'
}

// ── Opened project folders ────────────────────────────────────────────────────
/** The explicit part of a label SDDL: inherited label ACEs (flag ID) come from the parent and are not restored by hand. */
const ownLabel = (sddl) => {
  const own = (String(sddl ?? '').match(/\([^)]*\)/g) ?? []).filter((ace) => !/^\(ML;[^;]*ID/.test(ace))
  return own.length ? 'S:' + own.join('') : ''
}
const fold = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
const storeOf = (managerHome) => join(managerHome, 'project-labels')
const recordFile = (managerHome, directory) => join(storeOf(managerHome), createHash('sha256').update(fold(directory)).digest('hex').slice(0, 32) + '.json')
const readRecord = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
const writeRecord = (file, record) => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); renameSync(tmp, file)
}

/**
 * Open a project folder for confined use: record its prior label once (the first holder), add `holder`, and give it the
 * Low label (propagated). The record lives in the manager home (a credential root), so a confined command cannot forge
 * what the folder is restored to. When the label needed the owner to be granted WRITE_OWNER on the folder first, the
 * record says so (`granted`), and the last release takes exactly that entry away again. If the folder cannot be
 * labelled, this holder is taken off again and the reason is returned (the caller refuses the open). The outcome is
 * noted for Diagnosis. Windows only; elsewhere a no-op.
 */
export function labelProjectOpen({ managerHome, directory, holder }, options = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: 'label is a win32 mechanism' }
  if (!managerHome || !directory || !holder) return { ok: false, reason: 'manager home, folder and holder are required' }
  const file = recordFile(managerHome, directory)
  let record = readRecord(file)
  // Already held by this holder and still Low: nothing to do (no helper run).
  if (record?.holders?.includes(holder) && lowLabelVerified(directory, options)) return { ok: true, prior: record.prior, granted: record.granted === true }
  const fresh = record === undefined
  if (fresh) {
    const [prior] = labelOps([{ op: 'get', path: directory }], options)
    if (!prior?.ok) {
      const reason = `its current label could not be read: ${labelFailureReason(prior?.error)}`
      noteProtection(managerHome, 'project', [{ path: resolve(directory), ok: false, reason }])
      return { ok: false, reason }
    }
    record = { directory: resolve(directory), prior: ownLabel(prior.sddl), holders: [], granted: false }
  }
  const added = !record.holders.includes(holder)
  if (added) record.holders.push(holder)
  record.openedAt = new Date().toISOString()
  writeRecord(file, record)
  const result = ensureLowLabel(directory, options)
  if (result.granted) { record.granted = true; writeRecord(file, record) }
  if (!result.ok) {
    if (added) record.holders = record.holders.filter((h) => h !== holder)
    if (record.holders.length === 0) {
      // Nothing holds it: put back what was there (label, and the entry this attempt may have added).
      labelOps([{ op: 'set', path: record.directory, sddl: record.prior || NO_LABEL_SDDL, grant: true }, ...(record.granted ? [{ op: 'ungrant', path: record.directory }] : [])], options)
      rmSync(file, { force: true })
    } else writeRecord(file, record)
    noteProtection(managerHome, 'project', [{ path: record.directory, ok: false, reason: result.reason }])
    return { ok: false, reason: result.reason }
  }
  noteProtection(managerHome, 'project', [{ path: record.directory, ok: true }])
  return { ok: true, prior: record.prior, granted: record.granted === true }
}

/**
 * Release `holder`'s use of a project folder; when no holder is left, restore the recorded prior label (propagated) and
 * forget the record. Called when the instance is removed (manager) and when the Worker sees the folder's Source revoked
 * (there is no separate local "close project": revoking the Source in Console, or deactivating the device, is the close).
 * A no-op when the folder has no record.
 */
export function releaseProjectLabel({ managerHome, directory, holder }, options = {}) {
  if (process.platform !== 'win32' || !managerHome || !directory) return { ok: true, skipped: 'nothing to restore' }
  const file = recordFile(managerHome, directory)
  const record = readRecord(file)
  if (record === undefined) return { ok: true, skipped: 'no record' }
  record.holders = record.holders.filter((h) => h !== holder)
  if (record.holders.length > 0) { writeRecord(file, record); return { ok: true, remaining: record.holders.length } }
  // The label first (it still needs the WRITE_OWNER entry, if one was added), then the entry this record added.
  const [result, ungrant] = labelOps([{ op: 'set', path: record.directory, sddl: record.prior || NO_LABEL_SDDL, grant: true },
    ...(record.granted ? [{ op: 'ungrant', path: record.directory }] : [])], options)
  if (!result?.ok || (record.granted && !ungrant?.ok)) {
    const reason = !result?.ok ? `its previous label could not be restored: ${labelFailureReason(result?.error)}`
      : `the access entry Rulith added could not be removed: ${labelFailureReason(ungrant?.error)}`
    writeRecord(file, record)
    noteProtection(managerHome, 'project', [{ path: record.directory, ok: false, reason }])
    return { ok: false, reason }
  }
  rmSync(file, { force: true })
  noteProtection(managerHome, 'project', [{ path: record.directory, ok: true }])
  return { ok: true, restored: record.prior || NO_LABEL_SDDL, ungranted: record.granted === true }
}

// ── What could not be protected, for Diagnosis ────────────────────────────────
// 中文说明：哪些凭据根、项目目录没能保护以及原因，记在管理器 home 的 isolation-status.json（凭据根内），供设置页「诊断」显示。
// 只是说明，不是安全判断的依据：拒绝运行由启动器每次自己核验。
const statusFile = (managerHome) => join(managerHome, 'isolation-status.json')
/**
 * Note the outcome of protecting credential roots (`kind` 'root') or project folders ('project'): an entry that is not
 * ok is kept with its reason and time, an ok one is cleared. Best-effort; never throws.
 */
export function noteProtection(managerHome, kind, outcomes) {
  if (typeof managerHome !== 'string' || !managerHome || !Array.isArray(outcomes) || outcomes.length === 0) return
  try {
    const file = statusFile(managerHome)
    let state = {}
    try { state = JSON.parse(readFileSync(file, 'utf8')) } catch { state = {} }
    const rows = Array.isArray(state.problems) ? state.problems : []
    const key = (row) => `${row.kind}:${fold(row.path)}`
    const byKey = new Map(rows.filter((row) => row && typeof row.path === 'string').map((row) => [key(row), row]))
    const at = new Date().toISOString()
    for (const { path, ok, reason } of outcomes) {
      if (typeof path !== 'string' || !path) continue
      const row = { kind, path: resolve(path) }
      if (ok) byKey.delete(key(row))
      else byKey.set(key(row), { ...row, reason: String(reason ?? 'unknown').slice(0, 400), at })
    }
    if (!existsSync(managerHome)) return
    writeRecord(file, { problems: [...byKey.values()] })
  } catch { /* diagnosis only */ }
}
/** What could not be protected, as noted: [{ kind, path, reason, at }]. */
export function protectionProblems(managerHome) {
  try {
    const rows = JSON.parse(readFileSync(statusFile(managerHome), 'utf8')).problems
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.path === 'string' && typeof row.reason === 'string') : []
  } catch { return [] }
}

/** The project folders `holder` holds, with when one was last opened: [{ directory, openedAt }]. */
export function projectFoldersHeld({ managerHome, holder }) {
  const store = storeOf(managerHome ?? '')
  if (!managerHome || !existsSync(store) || !statSync(store).isDirectory()) return []
  return readdirSync(store).filter((n) => n.endsWith('.json')).flatMap((name) => {
    const record = readRecord(join(store, name))
    return record?.holders?.includes(holder) ? [{ directory: record.directory, openedAt: record.openedAt ?? '' }] : []
  })
}

/** Release every folder `holder` holds (an instance being removed). */
export function releaseAllProjectLabels({ managerHome, holder }, options = {}) {
  return projectFoldersHeld({ managerHome, holder }).map(({ directory }) => releaseProjectLabel({ managerHome, directory, holder }, options))
}
