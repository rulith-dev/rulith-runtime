// Opening a folder of this computer as a project (PSC 0.2.24 SYS-LOCAL-01, D-1018b batch 3): the host half.
//
// 中文说明：所有者在 Deep Rulith 里选一个文件夹，先读“打开会授予什么”（确认框的内容与它的版本 authorizationVersion），
// 所有者确认后带着这个版本和一个新的请求号去打开。宿主只说四件事——哪个 Agent、它在这台电脑上的哪条连接、哪个文件夹、
// 这台电脑是什么系统；能力、工具、摘要与档位一律由 Gateway 从 Agent 已装的第一方 Release 取，宿主不报。请求经本机
// Runtime 管理器（/manager/projects/*）走这台电脑的设备授权，浏览器只看到这里挑出的字段，看不到任何凭据。
import fs from 'node:fs';
import path from 'node:path';

/** A refusal made here, before anything is sent; its code tells the page that retrying will not help. */
const refused = (code, text) => Object.assign(new Error(text), { errorCode: code });

/** The official engineering capability names a project's Source `project`, then `project-<8 hex>` per further folder. */
export const PROJECT_SOURCE = /^project(-[0-9a-f]{8})?$/;

/**
 * The panel's "needs attention" row for a Source that is not ready. A project Source of the official capability is pointed
 * at a folder, and authorized again after a withdrawal, by opening the folder from the sidebar (PSC 0.2.24); any other
 * Source is still Console's, at `consoleUrl`.
 */
export function sourceAttention(source, consoleUrl) {
  if (PROJECT_SOURCE.test(String(source?.name ?? '')) && (source.state === 'needs_binding' || source.state === 'needs_relock'))
    return { text: source.state === 'needs_binding' ? '还没有打开项目文件夹：在左侧智能体下点「打开文件夹…」'
      : `项目 ${source.name} 的授权已收回：在左侧智能体下重新打开它的文件夹，即可再次授权`, source: source.name };
  return { text: `Source ${source?.name} 未就绪（${source?.state}）`, url: consoleUrl, source: source?.name };
}

/** The platform the Gateway checks a folder against: Windows paths or POSIX paths. */
export const projectPlatform = (platform = process.platform) => (platform === 'win32' ? 'windows' : 'posix');

const LOCAL_FILES = { statSync: fs.statSync, realpathSync: fs.realpathSync.native };
const NETWORK_FOLDER = '这是网络上的文件夹（共享文件夹或映射的网络盘）。在这台电脑上运行命令时不能把它当作工作目录，请选本机磁盘上的文件夹。';
const NETWORK_PATH = /^[\\/]{2}/;

/**
 * The folder as this computer names it: absolute for its system, an existing directory, and its real path (links,
 * junctions, short names and letter case resolved), so the confirmation shows, and the grant names, the folder the
 * commands will actually run in. The Gateway does the canonical checks (whole drives, nesting); this only refuses what
 * cannot be a project folder here, in plain words, before anything is sent.
 *
 * On Windows a network folder is refused, typed as a share or reached through a mapped drive (whose real path is the
 * share): cmd.exe cannot use a network path as its working directory and runs .cmd tools such as npm in C:\Windows
 * instead, so "commands run in this folder" would not be true.
 */
export function localFolder(raw, platform = process.platform, files = LOCAL_FILES) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw refused('folder_invalid', '请填写一个文件夹路径。');
  const windows = platform === 'win32';
  if (windows && NETWORK_PATH.test(value)) throw refused('folder_network', NETWORK_FOLDER);
  if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : !value.startsWith('/'))
    throw refused('folder_invalid', windows ? '请填写完整路径，例如 D:\\work\\project。' : '请填写完整路径，例如 /home/you/project。');
  const resolved = (windows ? path.win32 : path.posix).resolve(value);
  let real = '';
  try { if (files.statSync(resolved).isDirectory()) real = files.realpathSync(resolved); } catch { real = ''; }
  if (!real) throw refused('folder_invalid', '这台电脑上没有这个文件夹：' + resolved);
  if (windows && NETWORK_PATH.test(real)) throw refused('folder_network', NETWORK_FOLDER);
  return real;
}

/**
 * Who opens the project: the signed-in account, the Agent (one of the device grant's) and that Agent's Connection paired
 * on this computer, all read from the manager's own state.
 */
export function projectTarget(state, agentId) {
  if (state?.device?.state !== 'linked') throw refused('not_signed_in', '这台电脑没有登录 Rulith：先在左下角登录。');
  const accountId = String(state.device.account?.id ?? '');
  if (!accountId || !(state.device.agents ?? []).some((agent) => agent.id === agentId))
    throw refused('agent_not_in_account', '这个智能体不在当前登录的账户里。');
  const instance = (state.instances ?? []).find((row) => row.agentId === agentId && row.mode === 'local_agent'
    && !row.signedOutAt && row.paired && row.connectionId);
  if (!instance) throw refused('agent_not_set_up', '这个智能体还没有在这台电脑上设置：先在左侧点「在本机设置」。');
  return { accountId, accountName: String(state.device.account?.name ?? ''), agentId, connectionId: String(instance.connectionId),
    instanceId: instance.id };
}

/**
 * What the page may see of a project reply: the confirmation's content (from the Gateway, the source of truth for what
 * is granted), the opening's progress and outcome. The manager appends its own full state to every answer; none of it
 * passes, and neither do tool digests, device or Connection ids.
 */
export function projectView(reply) {
  const out = {};
  for (const field of ['state', 'stage', 'waitingFor', 'recovery', 'teaching', 'accountId', 'agentId', 'agentName',
    'connectionName', 'directory', 'authorizationVersion', 'requestId', 'alreadyOpen', 'changed'])
    if (reply?.[field] !== undefined) out[field] = reply[field];
  if (reply?.computer && typeof reply.computer === 'object') out.computer = { label: String(reply.computer.label ?? '') };
  if (reply?.capability && typeof reply.capability === 'object')
    out.capability = { id: String(reply.capability.id ?? ''), version: String(reply.capability.version ?? '') };
  if (Array.isArray(reply?.tools)) out.tools = reply.tools.map((tool) => ({ id: String(tool?.id ?? ''), directUse: tool?.directUse === true }));
  if (reply?.mode && typeof reply.mode === 'object') {
    out.mode = {};
    for (const field of ['requested', 'state', 'current']) if (typeof reply.mode[field] === 'string') out.mode[field] = reply.mode[field];
  }
  return out;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * The two routes. `manager(route, body)` is the host's manager call; `onReady(instanceId)` lets the host drop what it
 * cached about the Agent's Sources, so the new project folder shows in the sidebar at once.
 */
export function projectRoutes({ manager: call, platform = process.platform, files = LOCAL_FILES, onReady = () => {} }) {
  // A manager without these routes (Runtime 0.17.2 and earlier) answers 404 without a code: say what to do about it.
  const manager = (route, body) => call(route, body).catch((error) => {
    if (error?.status === 404 && !error.errorCode && route.startsWith('/manager/projects/'))
      throw refused('runtime_unsupported', '这台电脑上的 Rulith Runtime 版本太旧，还不能打开项目：请更新 Deep Rulith 后再试。');
    throw error;
  });
  const request = async (body) => {
    const agentId = String(body?.agentId ?? '');
    const target = projectTarget(await manager('/manager/state'), agentId);
    return { target, directory: localFolder(body?.directory, platform, files) };
  };
  // The account the authorization belongs to, by the name this computer shows for it, only when the Gateway answered for
  // that same account.
  const answer = (target, reply) => {
    if (reply?.state === 'ready') onReady(target.instanceId);
    const view = projectView(reply);
    if (target.accountName && view.accountId === target.accountId) view.accountName = target.accountName;
    return view;
  };
  return {
    state: async (body) => {
      const { target, directory } = await request(body);
      return answer(target, await manager('/manager/projects/state', { expectedAccountId: target.accountId,
        agentId: target.agentId, connectionId: target.connectionId, directory, platform: projectPlatform(platform) }));
    },
    // The request id comes from the page: a reply lost on the way back is retried with the same id, which continues the
    // same opening on the Gateway instead of starting another. The account is the one the confirmation was shown for.
    open: async (body) => {
      const { target, directory } = await request(body);
      const requestId = String(body?.requestId ?? ''), authorizationVersion = String(body?.authorizationVersion ?? '');
      if (!REQUEST_ID.test(requestId)) throw refused('open_request_invalid', '这次打开缺少有效的请求号，请重新确认。');
      if (!authorizationVersion) throw refused('open_request_invalid', '这次打开缺少确认过的内容版本，请重新确认。');
      return answer(target, await manager('/manager/projects/open', { requestId,
        expectedAccountId: String(body?.expectedAccountId ?? ''), agentId: target.agentId, connectionId: target.connectionId,
        directory, platform: projectPlatform(platform), authorizationVersion }));
    },
  };
}
