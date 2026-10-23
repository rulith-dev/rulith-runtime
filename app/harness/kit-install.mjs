// The first-party general kit on this computer (PSC 0.2.27 ③): installed and refreshed only by the Runtime manager's
// "set up this Agent on this computer" operation (local/setup-local.mjs), never by copying files beside a running
// Worker. The app's start asks that operation, in repair mode, to refresh the kit of every Agent set up here whose
// Worker is on and that already has the kit (a kit home, `generalKit` in the manager's state) — also when another
// launcher already runs the manager — so a Runtime update reaches the Agents' kits: the manager drains each Worker
// before it replaces adapter bytes, then reloads it. An Agent whose kit is current is left as it is. The start never
// makes a first install: that is an explicit 「在本机设置」 or opening a folder. A launcher whose settings name its Agent
// (`agentName`) refreshes that one only, kit or not: naming it is the launcher's own choice.
//
// 中文说明：工具包只由管理器的"在本机设置"操作安装与更新（排空 Worker 后再替换文件、重新载入）。应用启动时只对本机已设置、
// Worker 开着、并且已经装过工具包的 Agent 以 repair 模式各跑一次；从没装过的不在启动时装（第一次安装只经明确的
// 「在本机设置」或打开文件夹）。设置文件指名了 Agent 的启动器只处理那一个。已是最新的什么都不动。

/**
 * Refresh the general kit of every Agent set up on this computer with its Worker on and a kit already installed (only
 * `agentName`'s when given). `manager` is the host's manager call and `setup` the host's setup routes
 * (web/local-setup.mjs). Resolves once each has been tried; a failure is printed with its step's reason (never a
 * credential) and does not stop the others. Rejects only when the manager cannot be read, so the caller tries again later.
 * @returns the number of Agents tried.
 */
export async function refreshGeneralKits(manager, setup, { agentName, log = (line) => console.error(line) } = {}) {
  const state = await manager('/manager/state');
  if (state.device?.state !== 'linked') return 0;
  const granted = new Set((state.device.agents ?? []).map((agent) => agent.id));
  // A launcher whose settings name its Agent refreshes only that one (D-1016a): other launchers share this manager.
  const rows = (state.instances ?? []).filter((row) => row.mode === 'local_agent' && row.paired && !row.signedOutAt
    && row.workerSetting?.enabled === true && granted.has(row.agentId)
    && (agentName ? row.agentName === agentName : row.generalKit === true));
  for (const row of rows) {
    try { await setup.ready({ agentId: row.agentId, mode: 'repair' }); }
    catch (error) {
      log(`[rulith setup] The general kit of ${row.agentName || row.agentId} could not be refreshed: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }
  return rows.length;
}
