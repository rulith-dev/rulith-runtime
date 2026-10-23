// Deep Rulith, browser half (plain script for dsh's module loader: no build step). The account entry at the sidebar foot
// and the Rulith tab in the right sidebar read and act only through /rulith/api on dsh's own server, which forwards to the
// owner's Rulith Runtime manager and to Rulith's MCP authority. No token, key or secret is part of this script.
window.__ModuleLoader__.load({
  id: "rulith-dsh-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const TAB_ID = "rulith-dsh-ui/board";
    const TAB_KIND = "rulithBoard";
    const GREEN = "#3fb950", AMBER = "#d29922", GREY = "#8b949e";

    async function api(path, body) {
      const response = await fetch("/rulith/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-deep-rulith": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return response.json();
    }
    // The Runtime workbench, for settings Deep Rulith does not show (the model). Its address carries the manager key, so
    // it is fetched on demand through the guarded API and never stored in this page.
    async function openWorkbench() {
      const win = window.open("about:blank", "_blank");
      try {
        const reply = await api("workbench", {});
        if (win && reply.ok && reply.url) { win.opener = null; win.location.replace(reply.url); } else if (win) win.close();
      } catch { if (win) win.close(); }
    }
    function usePoll(path, ms) {
      const [data, setData] = useState(null);
      const refresh = useCallback(async () => {
        try { setData(await api(path)); } catch (error) { setData({ ok: false, teaching: String(error) }); }
      }, [path]);
      useEffect(() => { refresh(); const timer = setInterval(refresh, ms); return () => clearInterval(timer); }, [refresh, ms]);
      return [data, refresh, setData];
    }
    const dot = (color) => h("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, flex: "none" } });
    // Exploration tiers, narrow to wide (TOOL-08b/08c), and the Console's approved confirmation texts for widening.
    const MODE_ORDER = ["strict", "derived", "non_strict"];
    const MODE_WORDS = { strict: "严格", derived: "推导", non_strict: "非严格" };
    const WIDEN_TEXT = {
      non_strict: { title: "Switch to non-strict exploration mode?", accept: "Switch to non-strict", cancel: "Keep strict",
        body: "Write and run actions of this environment's tools will accept inputs the model supplies, even when no trusted fact on the Board backs them. Each such call is marked \"Inputs not grounded\". Calls that need your decision never run without it, writes stay inside the locations you authorized, and tools you have not locked stay unavailable. You can switch back at any time." },
      derived: { title: "Switch to derived exploration mode?", accept: "Switch to derived", cancel: "Keep strict",
        body: "The model will be able to write and run in this environment's workspace whenever it can derive, from facts and rules it writes on the Board, a warrant for that action and its key inputs. Those facts do not have to be trusted evidence. Calls that need your decision never run without it, and writes stay inside the local workspace." },
    };
    const selectedAgent = (s) => (s && s.agents || []).find((a) => a.name === s.selected);
    function health(s) {
      if (!s || !s.ok || !s.signedIn) return { color: GREY, text: s && s.ok === false ? "Rulith 未连接" : "未登录 Rulith" };
      const agent = selectedAgent(s);
      if (!agent) return { color: AMBER, text: "请选择 Agent" };
      const tools = s.tools && s.tools.state === "attached";
      const worker = agent.worker && agent.worker.state === "online";
      return { color: tools && worker ? GREEN : AMBER, text: agent.name + (worker ? " · 本机执行在线" : " · 本机执行未在线") };
    }
    const button = { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 };
    const section = { fontSize: 11, opacity: 0.6, margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: ".04em" };

    function AccountPanel({ state, setState, refresh, openBoard }) {
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      const run = async (label, action) => {
        setBusy(label); setNotice("");
        try { const reply = await action(); if (reply && reply.ok === false) setNotice(reply.teaching || "操作没有完成"); else if (reply && reply.ok) setState(reply); }
        catch (error) { setNotice(String(error)); } finally { setBusy(""); }
      };
      const signIn = () => run("signin", async () => {
        let tab = null; try { tab = window.open("about:blank", "_blank"); } catch (e) { tab = null; }
        const reply = await api("signin", {});
        if (!reply.ok || !reply.url) { if (tab) tab.close(); return reply; }
        if (tab) tab.location.href = reply.url; else window.open(reply.url, "_blank", "noopener");
        for (let i = 0; i < 60; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const polled = await api("signin/poll", {});
          if (polled.ok && polled.signedIn) return polled;
        }
        return { ok: false, teaching: "登录还没有完成：请在打开的 Rulith 页面里批准，再点一次登录。" };
      });
      const s = state || {};
      const agent = selectedAgent(s);
      return h("div", { style: { position: "fixed", left: 8, bottom: 56, width: 320, maxHeight: "70vh", overflow: "auto", zIndex: 1000,
          padding: 12, borderRadius: 10, border: "1px solid rgba(127,127,127,.35)", background: "var(--color-bg-elevated, #1f2328)", boxShadow: "0 8px 24px rgba(0,0,0,.35)", fontSize: 13 } },
        h("div", { style: { fontWeight: 700, marginBottom: 6 } }, "Deep Rulith"),
        h("div", { style: section }, "Rulith 账户"),
        s.signedIn
          ? h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
              h("span", null, s.account), h("button", { style: button, disabled: !!busy, onClick: () => run("signout", () => api("signout", {})) }, "退出登录"))
          : h("button", { style: button, disabled: !!busy, onClick: signIn }, busy === "signin" ? "等待浏览器里批准…" : "登录 Rulith"),
        s.signedIn ? h("div", null,
          h("div", { style: section }, "Agent"),
          (s.agents || []).map((a) => h("label", { key: a.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" } },
            h("input", { type: "radio", name: "deep-rulith-agent", checked: a.name === s.selected, disabled: !!busy,
              onChange: () => run("select", () => api("select", { agentId: a.id })) }),
            h("span", { style: { flex: 1 } }, a.name),
            // An Agent chosen earlier but not set up on this computer (for example after signing in again) cannot be
            // set up by its radio, which is already checked: the row offers the step itself.
            a.paired ? dot(a.worker && a.worker.state === "online" ? GREEN : AMBER)
              : (a.reconnectable || []).length === 0
                ? h("button", { style: { ...button, fontSize: 11 }, disabled: !!busy,
                    onClick: (event) => { event.preventDefault(); run("select", () => api("select", { agentId: a.id, newConnection: true })); } }, "在本机设置")
                : null)),
          // Existing connections of an unpaired Agent can be reconnected: the person chooses explicitly (D-1007b).
          (s.agents || []).filter((a) => !a.paired && (a.reconnectable || []).length > 0).map((a) => h("div", { key: "rc-" + a.id, style: { margin: "4px 0 8px 24px", fontSize: 12 } },
            h("div", { style: { opacity: 0.75, marginBottom: 4 } }, a.name + "：重新接上原来的连接会保留它的 Source 绑定和工具授权，旧密钥随即作废。"),
            (a.reconnectable || []).map((c) => h("button", { key: c.connectionId, style: { ...button, fontSize: 11, marginRight: 6, marginBottom: 4 }, disabled: !!busy,
              onClick: () => run("select", () => api("select", { agentId: a.id, reconnectConnectionId: c.connectionId })) }, "重新接上「" + c.name + "」")),
            h("button", { style: { ...button, fontSize: 11 }, disabled: !!busy,
              onClick: () => run("select", () => api("select", { agentId: a.id, newConnection: true })) }, "新建连接"))),
          agent && agent.instanceId ? h("label", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
            h("input", { type: "checkbox", checked: !!(agent.worker && agent.worker.enabled), disabled: !!busy,
              onChange: (event) => run("worker", () => api("worker", { instanceId: agent.instanceId, enabled: event.target.checked })) }),
            "使用这台电脑的工具和文件（本机 Worker）") : null,
          h("div", { style: section }, "模型"),
          h("div", null, s.model && s.model.configured ? s.model.name + " · " + s.model.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "未设置"),
          h("div", { style: { fontSize: 11, opacity: 0.6 } }, "模型在 Rulith 设置里配置，改动后重启 Deep Rulith 生效。"),
          h("div", { style: section }, "Rulith 工具"),
          h("div", null, s.tools && s.tools.state === "attached" ? "已接入（五个）" : s.tools && s.tools.state === "failed" ? "接入失败：" + (s.tools.error || "") : "未接入"),
        ) : null,
        notice ? h("div", { role: "alert", style: { marginTop: 8, color: AMBER } }, notice) : null,
        h("div", { style: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" } },
          h("button", { style: button, onClick: openBoard }, "打开 Rulith 面板（在对话里）"),
          h("button", { style: button, onClick: refresh }, "刷新"),
          h("button", { style: button, onClick: openWorkbench }, "更多设置")));
    }

    function RulithAccount({ wide, openBoard }) {
      const [state, refresh, setState] = usePoll("state", 5000);
      const [open, setOpen] = useState(false);
      const status = health(state);
      return h("div", { style: { position: "relative", width: "100%" } },
        h("button", { type: "button", title: "Deep Rulith：" + status.text, onClick: () => setOpen(!open),
            style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", border: "1px solid rgba(127,127,127,.35)",
              borderRadius: 8, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" } },
          dot(status.color),
          wide ? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            state && state.signedIn ? state.account + " · " + status.text : status.text) : null),
        open ? h(AccountPanel, { state, setState, refresh, openBoard: () => { openBoard(); setOpen(false); } }) : null);
    }

    function show(value) {
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    const LEVEL = { ok: GREEN, info: GREY, warn: AMBER, error: "#f85149" };
    const small = { fontSize: 11, opacity: 0.65 };
    const timeOf = (value) => { const at = new Date(value); return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    const block = (title, extra, body) => h("div", { style: { marginBottom: 14 } },
      h("div", { style: { ...section, display: "flex", justifyContent: "space-between" } }, h("span", null, title), extra ? h("span", { style: { textTransform: "none" } }, extra) : null), body);
    const none = (text) => h("div", { style: { opacity: 0.6, fontSize: 12 } }, text);
    const OPERATION_WORDS = { running: "进行中", done: "已确认", failed: "失败", refused: "被拒绝", unknown: "结果未知" };
    // "Execute worker_<connection>_eng_read_1" reads as "eng.read"; built-in Source tools lose their id suffix.
    const shortLabel = (label) => String(label || "").replace(/^Execute\s+/, "").replace(/^worker_[a-z0-9]+_/, "").replace(/_\d+$/, "")
      .replace(/_[0-9a-f]{12}$/, "").replace(/^eng_/, "eng.");
    const STAGE_WORDS = { at_worker: "在本机执行", held: "等待决定", dispatched: "已派发" };
    // rulith/v4（A 包）的目标目录：每行 {goal, label, status, type?, deadline?, awaiting?, seat?}。
    const GOAL_WORDS = { running: "进行中", paused: "已暂停", completed: "已完成", ended: "已结束" };
    const AWAITING_WORDS = { decision: "等人决定", sign_off: "等签收", acceptance: "验收待签字／待确认" };

    // The right column is this environment's execution, as the Rulith Runtime shows it beside a conversation:
    // goals, recent operations, the current frontier, and the local Worker's activity.
    function RulithColumn({ mountedSession, useSessions }) {
      // The sidebar's mounted store identifies the conversation this pane belongs to.
      const sessionId = React.useSyncExternalStore(
        (notify) => mountedSession.subscribe(notify), () => mountedSession.getSnapshot());
      // Remount on a session change so its cached view and pending polls cannot leak into the next pane.
      return sessionId === undefined ? null : h(RulithSessionColumn, { key: sessionId, sessionId, useSessions });
    }
    function RulithSessionColumn({ sessionId, useSessions }) {
      const workspace = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
      const [project, refreshProject] = usePoll("project?workspace=" + encodeURIComponent(workspace || "") + "&session=" + encodeURIComponent(sessionId), 6000);
      // Refresh the host's local snapshot; this route never sends a Board Get.
      const [data, refresh] = usePoll("board?session=" + encodeURIComponent(sessionId), 6000);
      const [worker, refreshWorker] = usePoll("worker?session=" + encodeURIComponent(sessionId), 6000);
      const [health, refreshHealth] = usePoll("health?session=" + encodeURIComponent(sessionId), 60000);
      const [trace, setTrace] = useState(true);
      const reload = () => { refresh(); refreshWorker(); refreshHealth(); refreshProject(); };
      if (!data) return h("div", { style: { padding: 12 } }, "正在读取 Rulith…");
      if (!data.ok) return h("div", { style: { padding: 12, color: AMBER } }, data.teaching || "读不到 Rulith");
      if (!data.available) return h("div", { style: { padding: 12 } }, "还没有接入 Rulith：请在左下角登录并选择 Agent。");
      if (!data.view) return h("div", { style: { padding: 12 } }, "还没有 Board 视图。");
      const board = data.view;
      const directory = board.goals && Array.isArray(board.goals.directory) ? board.goals.directory : [];
      const ops = data.operations || [];
      const goals = Array.isArray(board.goalNodes) ? board.goalNodes : [];
      const frontier = Array.isArray(board.frontier) ? board.frontier : Array.isArray(board.gaps) ? board.gaps : [];
      const actions = Array.isArray(board.actions) ? board.actions : [];
      const ready = actions.filter((a) => a.status === "ready").length;
      const w = worker && worker.ok && worker.available ? worker : null;
      const online = w && w.state === "online";

      const goalRows = directory.length ? directory.slice(0, 12).map((g, i) => h("div", { key: i, style: { padding: "3px 0", fontSize: 12 } },
          h("div", null, show(g.goal) + (g.label ? " — " + show(g.label) : "")),
          h("div", { style: small }, [g.type, GOAL_WORDS[g.status] || g.status, AWAITING_WORDS[g.awaiting] || g.awaiting,
            g.deadline === "elapsed" ? "已过期限" : "", g.seat ? "席位 " + g.seat : ""].filter(Boolean).map(show).join(" · "))))
        : none("还没有目标：开始一项任务后，这里显示它的目标。");
      const opRows = ops.length ? ops.slice(0, 12).map((o, i) => h("div", { key: i, style: { padding: "3px 0", fontSize: 12 } },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, dot(o.state === "done" ? GREEN : o.state === "running" ? AMBER : o.state ? "#f85149" : GREY),
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, shortLabel(o.label || o.tool))),
          h("div", { style: small }, [OPERATION_WORDS[o.state] || o.state, STAGE_WORDS[o.stage] || o.stage, o.since ? "自 " + timeOf(o.since) : "", o.summary].filter(Boolean).map(show).join(" · "))))
        : none("还没有操作。");
      const frontierRows = goals.length || frontier.length ? h("div", null,
          goals.slice(0, 12).map((g, i) => h("div", { key: "g" + i, style: { padding: "2px 0", fontSize: 12 } }, (g.met || g.satisfied ? "✓ " : "○ ") + show(g.label || g.goal || g.nodeId || g))),
          frontier.slice(0, 12).map((f, i) => h("div", { key: "f" + i, style: { padding: "2px 0", fontSize: 12 } }, show(f.label || f.predicate || f.gap || f) + (f.action ? " · " + show(f.action) : ""))))
        : none("没有进行中的目标。");

      // Acceptance belongs to this conversation's cached Board view; no additional Board read. The row opens the Agent's
      // cases in Console when the launcher settings name a consoleUrl (health.goalsUrl); otherwise only the local workbench.
      const healthy = health && health.ok && health.available;
      const goalsUrl = healthy && typeof health.goalsUrl === "string" && /^https?:\/\//.test(health.goalsUrl) ? health.goalsUrl : "";
      const needs = [...(healthy && Array.isArray(health.items) ? health.items : []),
        ...directory.filter((goal) => goal.awaiting === "acceptance").map((goal) => {
          const text = "验收待签字／待确认：" + show(goal.label || goal.goal) + " — 在 Console 的目标页签字或验收";
          return goalsUrl ? { text, url: goalsUrl } : { text: text + "（未设置 consoleUrl：这里只能打开本机 Rulith）", fix: "workbench" };
        })];
      let workerBody;
      if (!worker) workerBody = none("正在读取本机执行…");
      else if (!worker.ok) workerBody = h("div", { style: { color: AMBER, fontSize: 12 } }, "读不到本机执行：" + (worker.teaching || ""));
      else if (!worker.available) workerBody = none("还没有选择 Agent。");
      else workerBody = h("div", null,
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } }, dot(online ? GREEN : AMBER),
          h("span", { style: { flex: 1 } }, online ? "在线" : "不在线（" + w.state + "）"),
          h("span", { style: small }, ready + " 个动作就绪")),
        (w.sources || []).map((src, i) => h("div", { key: i, style: { fontSize: 12, marginTop: 4 } },
          h("span", { style: { fontWeight: 600 } }, src.name), h("span", { style: small }, " " + src.type + " → "), h("span", null, src.location || "未绑定位置"))),
        w.stuck ? h("div", { role: "alert", style: { marginTop: 6, color: LEVEL.error, fontSize: 12 } },
          "有调用的结果没有送达：看上面的“需要处理”，或在 Console 里处理这次调用。") : null,
        h("div", { style: { marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("span", { style: small }, "最近的执行"),
          h("button", { style: { ...button, padding: "1px 8px", fontSize: 11 }, onClick: () => setTrace(!trace) }, trace ? "收起" : "展开")),
        trace ? h("div", { style: { marginTop: 4 } }, (w.events || []).length ? w.events.map((e, i) =>
          h("div", { key: i, style: { display: "flex", gap: 6, alignItems: "baseline", padding: "1px 0", fontSize: 12 } },
            h("span", { style: { opacity: 0.5, flex: "none", fontVariantNumeric: "tabular-nums" } }, e.at ? new Date(e.at).toLocaleTimeString() : ""),
            h("span", { style: { color: LEVEL[e.level] || "inherit", wordBreak: "break-word" } }, e.text))) : none("还没有执行记录。")) : null);

      return h("div", { style: { padding: 12, fontSize: 13, overflow: "auto", height: "100%", boxSizing: "border-box" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
          h("b", null, "Rulith · " + (data.agentName || "")), h("button", { style: button, onClick: reload }, "刷新")),
        h("div", { style: { ...small, marginBottom: 10 } }, "最近收到 Board：" + new Date(data.seenAt).toLocaleString()),
        needs.length ? block("需要处理", needs.length + " 项", h("div", null, needs.map((item, i) => h("div", { key: i, role: "alert",
          style: { display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0", fontSize: 12, color: LEVEL.error } },
          h("span", { style: { flex: 1 } }, item.text),
          item.url ? h("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", style: { flex: "none" } }, "在 Console 处理")
            : item.fix === "workbench" ? h("button", { style: { ...button, padding: "1px 8px", fontSize: 11 }, onClick: openWorkbench }, "打开本机 Rulith")
            : null)))) : null,
        block("目标", directory.length ? String(board.goals.total || directory.length) + " 个" : "", goalRows),
        block("最近操作", "", opRows),
        block("当前前沿", "", frontierRows),
        block("本机执行（Worker）", project && project.workspace === workspace && project.project ? project.project.name : "", workerBody));
    }

    // ACC-CONV-05/06, the owner's 10-15 direction ("composer selectors next to model and effort"): this conversation's
    // exploration mode and post-call review switch live in the composer tool row (dsh slot conversation.input.left),
    // next to dsh's own permission and model controls. The browser only sees what the launcher's conversationView
    // picks out; the switch itself travels manager -> device grant -> Gateway (PSC 0.2.16 ③, 0.2.20).
    function useConversationSettings(sessionId) {
      const [settings, refresh] = usePoll("conversation?session=" + encodeURIComponent(sessionId), 6000);
      const [note, setNote] = useState("");
      const applyMode = async (connectionId, mode) => {
        setNote("");
        try {
          const reply = await api("conversation/exploration-mode", { session: sessionId, connectionId, mode });
          if (!reply.ok) setNote(reply.teaching || "没有切换");
          else if (reply.state !== "complete") setNote("已受理，等待 Kernel 确认" + (reply.teaching ? "：" + reply.teaching : ""));
          else if (reply.result && reply.result.accepted === false) setNote(reply.result.teaching || "Core 拒绝了这次切换");
        } catch (error) { setNote(String(error)); }
        refresh();
      };
      const applyReview = async (enabled) => {
        setNote("");
        try {
          const reply = await api("conversation/review", { session: sessionId, enabled });
          if (!reply.ok) setNote(reply.teaching || "没有切换");
        } catch (error) { setNote(String(error)); }
        refresh();
      };
      return { settings, refresh, note, setNote, applyMode, applyReview };
    }
    const chip = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)",
      background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" };
    const menu = { position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 220, maxWidth: 360, padding: 6, borderRadius: 8, zIndex: 20,
      background: "var(--dsh-color-surface, #1e1e1e)", border: "1px solid rgba(127,127,127,.35)", boxShadow: "0 6px 24px rgba(0,0,0,.35)", fontSize: 12 };
    const item = { display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: 6, border: "none", background: "transparent",
      color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 };
    function RulithComposerControls({ sessionId }) {
      const { settings, note, setNote, applyMode, applyReview } = useConversationSettings(sessionId);
      const [open, setOpen] = useState(null);           // null | "mode:<connectionId>" | "review"
      const [confirming, setConfirming] = useState(null); // { connectionId, mode } awaiting the approved confirmation
      useEffect(() => { setOpen(null); setConfirming(null); setNote(""); }, [sessionId]);
      // Nothing to show until the launcher can read this conversation. Without a Board yet (no Rulith call so far) the chips
      // read "默认": the first choice opens the Board with the Agent's defaults and then applies.
      if (!settings || !settings.ok) return null;
      const fresh = settings.found === false;
      const conversation = settings.conversation || {};
      const modes = fresh ? null : (conversation.explorationModes || null);
      const connections = Array.isArray(settings.connections) ? settings.connections : [];
      const close = () => { setOpen(null); setConfirming(null); };
      const chooseMode = (connectionId, currentMode, next) => {
        if (MODE_ORDER.indexOf(next) > MODE_ORDER.indexOf(currentMode)) { setConfirming({ connectionId, mode: next }); return; }
        close(); applyMode(connectionId, next);
      };
      const controls = connections.map((connection) => {
        const currentMode = modes ? modes[connection.connectionId] : undefined;
        const key = "mode:" + connection.connectionId;
        const label = (connections.length > 1 ? (connection.name || connection.connectionId) + " · " : "") + "探索：" + (currentMode ? MODE_WORDS[currentMode] || currentMode : fresh ? "默认" : "读不准");
        return h("span", { key, style: { position: "relative", display: "inline-flex" }, "data-rulith-mode": connection.connectionId },
          h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === key, title: "本会话的探索模式（只改这个会话）",
            onClick: () => setOpen(open === key ? null : key) }, label, h("span", { style: { opacity: 0.6 } }, "▾")),
          open === key ? h("div", { role: "menu", style: menu },
            confirming && confirming.connectionId === connection.connectionId
              ? h("div", { role: "dialog" },
                h("div", { style: { fontWeight: 600, marginBottom: 4 } }, WIDEN_TEXT[confirming.mode].title),
                h("div", { style: { opacity: 0.8, marginBottom: 8 } }, WIDEN_TEXT[confirming.mode].body),
                h("div", { style: { display: "flex", gap: 6 } },
                  h("button", { type: "button", style: { ...chip }, onClick: () => { const c = confirming; close(); applyMode(c.connectionId, c.mode); } }, WIDEN_TEXT[confirming.mode].accept),
                  h("button", { type: "button", style: { ...chip }, onClick: () => setConfirming(null) }, WIDEN_TEXT[confirming.mode].cancel)))
              : h("div", null,
                h("div", { style: { ...small, padding: "2px 8px 4px" } }, fresh ? "本会话还没有 Board：选一档就建板并生效（Agent 的默认档位之外的放宽先确认）" : "本会话的探索模式 · 收窄立即生效，放宽先确认"),
                MODE_ORDER.map((mode) => h("button", { key: mode, type: "button", role: "menuitemradio", "aria-checked": mode === currentMode,
                  style: { ...item, fontWeight: mode === currentMode ? 600 : 400 }, disabled: (!fresh && !currentMode) || mode === currentMode,
                  onClick: () => chooseMode(connection.connectionId, currentMode ?? "strict", mode) }, (mode === currentMode ? "● " : "○ ") + MODE_WORDS[mode] + "探索模式")))) : null);
      });
      const reviewOn = fresh ? true : conversation.postCallReview === true;
      const review = h("span", { style: { position: "relative", display: "inline-flex" }, "data-rulith-review": fresh ? "default" : reviewOn ? "on" : "off" },
        h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === "review", title: "本会话的事后审查（只改这个会话）",
          onClick: () => setOpen(open === "review" ? null : "review") }, "审查：" + (fresh ? "默认" : reviewOn ? "开" : "关"), h("span", { style: { opacity: 0.6 } }, "▾")),
        open === "review" ? h("div", { role: "menu", style: menu },
          h("div", { style: { ...small, padding: "2px 8px 4px" } }, settings.reviewer ? "本会话写入调用的事后审查，自下一次调用起" : "这个 Agent 没有指定审查员：开着也不审"),
          h("button", { type: "button", role: "menuitemradio", "aria-checked": !fresh && reviewOn, style: { ...item, fontWeight: !fresh && reviewOn ? 600 : 400 }, disabled: !fresh && reviewOn,
            onClick: () => { close(); applyReview(true); } }, (!fresh && reviewOn ? "● " : "○ ") + "开：写入调用送审查员"),
          h("button", { type: "button", role: "menuitemradio", "aria-checked": !fresh && !reviewOn, style: { ...item, fontWeight: !fresh && !reviewOn ? 600 : 400 }, disabled: !fresh && !reviewOn,
            onClick: () => { close(); applyReview(false); } }, (!fresh && !reviewOn ? "● " : "○ ") + "关：本会话不审（推导档下不能关）")) : null);
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4 }, "data-rulith-composer": sessionId },
        controls, review,
        note ? h("span", { role: "alert", style: { ...small, color: AMBER, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }, title: note }, note) : null);
    }


    // ---- Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01, D-1018b batch 3). The owner picks a folder under an
    // Agent, reads what opening it grants, confirms once, and a new conversation starts in it when it is ready. What is
    // granted (folder, Agent, computer, tools, mode) is the Gateway's answer, shown as it is; the wording is ours.
    const TOOL_WORDS = { read: "读文件", read_image: "读图片", list: "列出文件", glob: "按名称找文件", search: "搜索文件内容",
      tree_state: "查看文件夹的改动", write_file: "写文件", patch_file: "修改文件", apply_patch: "按补丁修改文件", run: "运行命令",
      test: "运行测试", job_start: "在后台运行命令", job_poll: "查看后台命令", job_stop: "停止后台命令", acceptance: "运行验收检查" };
    const toolText = (id) => {
      const words = TOOL_WORDS[String(id || "").replace(/^eng\./, "").replace(/@\d+$/, "")];
      return words ? words + "（" + id + "）" : String(id || "");
    };
    // What each mode the Gateway may request means for the owner. A mode this page cannot explain is not offered.
    const MODE_MEANING = {
      non_strict: "这台电脑上之后新开的会话使用「非严格」档：模型给出的命令和参数不再需要事先有依据，就会执行；任务算不算完成，仍然只由你签字的验收合同认定。",
    };
    /** The confirmation for one state reply: every item PSC 0.2.24 requires, or why it cannot be shown. Pure. */
    function projectConfirmation(view) {
      const v = view || {};
      const tools = Array.isArray(v.tools) ? v.tools : [];
      const requested = v.mode && v.mode.requested;
      if (!v.directory || !v.accountId || !v.agentName || !v.computer || !tools.length || !v.authorizationVersion || !requested)
        return { error: "读到的打开内容不完整，不能请你确认。请稍后再试。" };
      if (!MODE_MEANING[requested])
        return { error: "这个版本的 Deep Rulith 说明不了要设置的档位（" + requested + "），不能请你确认。请先更新 Deep Rulith。" };
      const capability = v.capability && v.capability.id ? "。这些工具来自这个智能体已装的官方编程能力 " + v.capability.id + (v.capability.version ? " " + v.capability.version : "") : "";
      return {
        title: "把这个文件夹作为项目打开？",
        rows: [
          ["文件夹", v.directory],
          ["账户", v.accountName || v.accountId],
          ["智能体", v.agentName],
          ["这台电脑", (v.computer.label || "未命名的电脑") + (v.connectionName ? "（本机连接「" + v.connectionName + "」）" : "")],
          ["可以做的事", "在这个文件夹里读文件、写文件、运行命令（包括测试和构建）。"],
          ["所用工具", tools.map((tool) => toolText(tool.id)).join("、") + capability + "。"],
          ["档位", MODE_MEANING[requested]],
          ["请注意", "「在这个文件夹里」不是操作系统级的隔离：运行的命令，以及它再启动的其他软件，仍然可能读写这个文件夹以外的文件。只打开你愿意让智能体在里面写文件、运行命令的文件夹。"],
          ["怎么撤销", "以后要收回，在 Console 里解除这个项目的锁定，或者停用这台电脑的登录。"],
        ],
        footer: "已有的会话不受影响。打开完成后，会在这个文件夹里开一个新会话。",
        accept: "打开项目", cancel: "取消",
      };
    }
    // Plain words for every refusal the open-project routes name; anything else shows the service's own words.
    const PROJECT_REFUSALS = {
      not_authorized: "这台电脑的登录没有被授权使用这个智能体。",
      account_changed: "这台电脑现在登录的账户和刚才显示的不一样。请刷新后再打开。",
      connection_not_of_this_device: "这个智能体的本机连接不是这台电脑设置的。请在左侧对这个智能体重新「在本机设置」。",
      connection_not_found: "这个智能体在这台电脑上没有可用的本机连接。请在左侧对它「在本机设置」。",
      agent_not_found: "这个智能体现在不可用。",
      client_authority_refused: "请求里带了只能由服务端决定的内容，已被拒绝。什么都没有改。",
      device_revoked: "这台电脑的登录已经失效。请在左下角重新登录。",
      device_expired: "这台电脑的登录已经过期。请在左下角重新登录。",
      device_unauthenticated: "这台电脑的登录已经失效。请在左下角重新登录。",
      unauthenticated: "这台电脑的登录已经失效。请在左下角重新登录。",
      official_capability_not_installed: "这个智能体没有装官方编程能力，不能打开项目。",
      official_capability_invalid: "这个智能体装的官方编程能力不完整，不能打开项目。",
      project_directory_in_use: "这个文件夹在这台电脑上已经被另一项授权占用，需要在 Console 里处理。什么都没有改。",
      project_nested: "这个文件夹在一个已打开的项目里面，或者包含一个已打开的项目。请选一个不和已打开项目重叠的文件夹。",
      platform_mismatch: "这个路径的写法和这台电脑上已打开的文件夹不一致。",
      worker_tools_unavailable: "这台电脑的本机执行还没有报告要用的工具。请确认左下角「使用这台电脑的工具和文件」已打开、本机执行在线，再试一次。",
      worker_tools_mismatch: "这台电脑上的工具和智能体要求的版本不一致。请更新并重新启动 Deep Rulith 后再试。",
      worker_tool_contract_missing: "这台电脑上的工具和智能体要求的版本不一致。请更新并重新启动 Deep Rulith 后再试。",
      worker_tool_not_direct: "这台电脑上的工具和智能体要求的版本不一致。请更新并重新启动 Deep Rulith 后再试。",
      worker_tool_pin_conflict: "这条本机连接上已经钉着同名工具的另一个版本，需要在 Console 里处理。什么都没有改。",
      project_unavailable: "现在确认不了项目的状态。之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。",
      not_signed_in: "这台电脑没有登录 Rulith，或登录已不能使用：先在左下角登录。",
      manager_signing_out: "这台电脑正在退出 Rulith 登录，现在不能打开项目。",
      manager_closing: "本机 Rulith 正在关闭，现在不能打开项目。",
      authorization_changed: "要授予的内容在确认之后又变了。请再打开一次，重新确认。",
    };
    function refusalText(reply) {
      const code = reply && reply.errorCode;
      if (code && PROJECT_REFUSALS[code]) return PROJECT_REFUSALS[code];
      const said = String((reply && reply.teaching) || "").trim();
      if (code === "bad_command") return "这个文件夹不能作为项目打开" + (said ? "：" + said : "。");
      return "没有打开项目" + (said ? "：" + said : "。");
    }
    // Why the dialog is shown again: this opening reached a state that retrying does not change (409, confirm_again).
    const AGAIN_WORDS = {
      mode_changed: "打开之后，这台电脑的档位又被改回去了（可能是在 Console 里改的）。重试不会替你再放宽；要继续，请再确认一次。",
      opened_elsewhere: "这个文件夹的打开不是在这台电脑上确认的。要在这台电脑上使用，请再确认一次。",
      mode_refused: "把档位设为「非严格」多次没有成功。要继续，请再确认一次。",
      revoked: "这个文件夹的项目授权已经收回。要再次授权，请再确认一次。",
    };
    const againText = (state) => AGAIN_WORDS[state] || "这次打开没有完成。要继续，请再确认一次。";
    function progressText(view) {
      const v = view || {};
      const step = { configuration: "（第 1 步，共 3 步）", program: "（第 2 步，共 3 步）", mode: "（第 3 步，共 3 步）" }[v.stage] || "";
      if (v.waitingFor === "agent_call_pending") return step + "智能体手上还有一次调用没有结束，结束后会接着打开…";
      if (v.state === "mode_refused") return step + "设置档位没有成功，正在重试…";
      if (v.stage === "configuration") return step + "正在记下项目文件夹和要用的工具…";
      if (v.stage === "program") return step + "正在等新的设置生效…";
      if (v.stage === "mode") return step + "正在把这台电脑上新会话的档位设为「非严格」…";
      return "正在打开项目…";
    }
    // A fresh request id per confirmation (the page is served from this computer, a secure context).
    const newProjectRequestId = () => {
      const c = window.crypto;
      if (c && c.randomUUID) return c.randomUUID();
      return "open-" + Array.from(c.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
    };
    // What is true after the page stops following an opening: the first step records nothing, and later steps advance
    // only when the state is read again, so opening the folder again continues from where it is, or asks again.
    const LATER = "之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。";
    const CHANGED = "要授予的内容在你确认之后变了。请再看一遍。";
    /**
     * The whole flow, with the page's dialog, progress line and timer passed in. Pure apart from `api`: exported for the
     * harness tests. Returns { outcome: "ready", directory } once the project is open (the caller then starts a new
     * conversation in it, after the program took effect: a conversation's Board freezes its program when it is made),
     * "cancelled", "stopped", "waiting" (still in progress when the owner's patience or the time limit ran out) or
     * "refused", the last three with plain words in `text`.
     *
     * In progress (recovery "retry") it reads the state again, with short growing pauses. An open without a definite
     * answer (its first step waits and records nothing, or its reply was lost) is resent with the same request id only
     * after a fresh state read still shows the folder not open with the very content the owner confirmed (the same
     * authorizationVersion). Anything else that read shows is handled as such: in progress is followed, a withdrawal or a
     * terminal state of the opening (recovery "confirm_again") or other content shows the dialog again, and a new
     * confirmation is a new request id. So an old confirmation never re-grants what was withdrawn meanwhile.
     * At most three confirmations, and three failed calls in a row, before it says why it stopped.
     */
    async function openProjectFlow({ api, agentId, directory, ui, newRequestId, maxWaitMs = 300000 }) {
      const read = () => settle(() => api("projects/state", { agentId, directory }));
      const settle = (call) => Promise.resolve().then(call).catch((error) => ({ ok: false, teaching: String((error && error.message) || error) }));
      const halted = () => !!(ui.stopped && ui.stopped());
      const STOPPED = { outcome: "stopped", text: "已停止等待。" + LATER };
      let request = null;     // the opening the owner confirmed last
      let unsettled = false;  // its open has no definite answer yet: read the state first, then resend it if still allowed
      let reading = true;     // the last call was a state read
      let note = "", waited = 0, pause = 0, failures = 0, confirmations = 0;
      const resend = () => { unsettled = false; reading = false; return settle(() => api("projects/open", request)); };
      let view = await read();
      for (;;) {
        if (halted()) return STOPPED;
        if (!view || view.ok === false) {
          const code = view && view.errorCode;
          if (code === "authorization_changed" && confirmations < 3) {
            request = null; unsettled = false; note = CHANGED;
            reading = true; view = await read(); continue;
          }
          // No answer, or the service could not confirm the state: read the state again. An open that got no answer is
          // resent only if that read allows it (below).
          if ((!code || code === "project_unavailable") && failures < 3) {
            failures++;
            if (!reading) unsettled = true;
            await ui.wait(1000);
            if (halted()) return STOPPED;
            reading = true; view = await read(); continue;
          }
          return { outcome: "refused", text: refusalText(view) };
        }
        failures = 0;
        if (view.state === "ready") return { outcome: "ready", directory: view.directory || directory };
        if (view.recovery === "console") return { outcome: "refused", text: PROJECT_REFUSALS.project_directory_in_use };
        if (request && unsettled && view.state === "not_open") {
          if (view.authorizationVersion === request.authorizationVersion) { view = await resend(); continue; }
          request = null; note = CHANGED;
        }
        unsettled = false;
        if (view.state === "not_open" || view.recovery === "confirm_again") {
          if (confirmations >= 3) return { outcome: "refused", text: "这个文件夹多次没有打开成功：" + againText(view.state) };
          const shown = projectConfirmation(view);
          if (shown.error) return { outcome: "refused", text: shown.error };
          const accepted = await ui.confirm(view, note || (view.recovery === "confirm_again" ? againText(view.state) : ""));
          if (!accepted) return { outcome: "cancelled" };
          confirmations++; note = ""; waited = 0; pause = 0;
          request = { agentId, directory, requestId: newRequestId(), authorizationVersion: view.authorizationVersion,
            expectedAccountId: view.accountId };
          ui.progress("正在打开项目…");
          view = await resend(); continue;
        }
        if (waited >= maxWaitMs) return { outcome: "waiting", text: "还没有打开完成：" + progressText(view) + " " + LATER };
        ui.progress(progressText(view));
        // The first step waits without recording anything: read the state next, and resend only if it still allows.
        if (request && view.stage === "configuration") unsettled = true;
        pause = Math.min(pause + 500, 2000);
        await ui.wait(pause); waited += pause;
        if (halted()) return STOPPED;
        reading = true; view = await read();
      }
    }

    // ---- Sidebar: Agent -> directory -> conversation (owner 2026-10-17). Registered at a lower priority than dsh's own
    // workspace browser, which shadows its view; dsh's navigation service (uiWorkspace) still opens, starts and archives
    // conversations, and dsh's session and workspace stores are read as they are. Directories are the Agent's file
    // Sources on this computer (or its own working directory); a conversation belongs to the Agent recorded for it.
    const COLLAPSE_KEY = "deep-rulith.tree.collapsed";
    const loadCollapsed = () => { try { return JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch { return {}; } };
    const saveCollapsed = (value) => { try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(value)); } catch {} };
    const samePath = (p) => String(p || "").replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
    const agoText = (ms) => {
      if (!Number.isFinite(ms)) return "";
      const m = Math.round((Date.now() - ms) / 60000);
      return m < 1 ? "刚刚" : m < 60 ? m + " 分" : m < 1440 ? Math.round(m / 60) + " 时" : Math.round(m / 1440) + " 天";
    };
    const RECENT_MS = 3 * 24 * 3600 * 1000;
    const SHOWN = 5;
    const useStore = (store) => React.useSyncExternalStore((notify) => store.subscribe(notify), () => store.getSnapshot());
    const tiny = { padding: "0 6px", borderRadius: 5, border: "none", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, lineHeight: "18px", opacity: 0.6 };
    const pick = (value, ...keys) => { for (const key of keys) if (value && value[key] !== undefined) return value[key]; return value; };

    /** Group conversations under Agents and directories. Pure: exported for the harness tests. */
    function buildTree({ tree, list, workspaces, current, filter, collapsed }) {
      const agents = tree && Array.isArray(tree.agents) ? tree.agents : [];
      const assignments = (tree && tree.assignments) || {};
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const pinned = new Set((workspaces && workspaces.pinnedSessionIds) || []);
      const owners = new Map();
      // A shared directory belongs to the default Agent when it is one of its owners (same rule as the launcher).
      const byDefault = [...agents].sort((x, y) => (y.agentId === (tree && tree.defaultAgentId)) - (x.agentId === (tree && tree.defaultAgentId)));
      for (const a of byDefault) for (const d of a.directories || []) if (!owners.has(samePath(d.path))) owners.set(samePath(d.path), a.agentId);
      const groups = new Map(agents.map((a) => [a.agentId, { agent: a, dirs: new Map((a.directories || []).map((d) => [samePath(d.path), { dir: d, sessions: [] }])) }]));
      const others = [];
      const q = String(filter || "").trim().toLowerCase();
      for (const id of (list && list.ids) || []) {
        const s = list.byId[id];
        if (!s || s.origin === "subagent" || archived.has(s.id) || (s.blank && s.id !== current)) continue;
        // Recorded Agent, else the owner of its directory. A conversation with neither (from before the sidebar, or of an
        // Agent since deleted) is not given to anyone: it waits under "未归属的会话".
        const agentId = assignments[s.id] || owners.get(samePath(s.cwd));
        const group = groups.get(agentId);
        if (!group) { others.push(s); continue; }
        const key = samePath(s.cwd);
        if (!group.dirs.has(key)) group.dirs.set(key, { dir: { path: s.cwd || "", label: baseName(s.cwd) || "其他目录", source: null, extra: true }, sessions: [] });
        group.dirs.get(key).sessions.push(s);
      }
      const order = (a, b) => (pinned.has(b.id) - pinned.has(a.id)) || (b.running - a.running) || ((b.updatedAt || 0) - (a.updatedAt || 0));
      const matches = (s, agent, dir) => !q || [s.title, agent.name, dir.label].some((text) => String(text || "").toLowerCase().includes(q));
      const out = [];
      for (const group of groups.values()) {
        const a = group.agent;
        const dirs = [];
        let latest = 0, running = false, count = 0, hasCurrent = false;
        for (const entry of group.dirs.values()) {
          const sessions = entry.sessions.filter((s) => matches(s, a, entry.dir)).sort(order);
          for (const s of sessions) { latest = Math.max(latest, s.updatedAt || 0); running = running || !!s.running; hasCurrent = hasCurrent || s.id === current; }
          count += sessions.length;
          if (q && !sessions.length && !String(a.name).toLowerCase().includes(q)) continue;
          if (entry.dir.extra && !sessions.length) continue;
          dirs.push({ ...entry.dir, key: a.agentId + "|" + samePath(entry.dir.path), sessions });
        }
        if (q && !count && !String(a.name).toLowerCase().includes(q)) continue;
        const stored = collapsed ? collapsed[a.agentId] : undefined;
        const open = q ? true : stored !== undefined ? !stored : !!(hasCurrent || running || (latest && Date.now() - latest < RECENT_MS));
        out.push({ agent: a, dirs, latest, running, count, hasCurrent, open, isDefault: tree && tree.defaultAgentId === a.agentId });
      }
      // Active first: a running conversation, then the most recent activity; Agents not set up here last.
      out.sort((x, y) => (y.agent.attached - x.agent.attached) || (y.running - x.running) || (y.latest - x.latest)
        || String(x.agent.name).localeCompare(String(y.agent.name)));
      // Unowned conversations by directory; a directory name shared by several is shown with its parent.
      const lastTwo = (p) => String(p || "").split(/[\/]/).filter(Boolean).slice(-2).join("/");
      const otherDirs = new Map();
      for (const s of others.filter((s) => !q || String(s.title || "").toLowerCase().includes(q)).sort(order)) {
        const key = samePath(s.cwd);
        if (!otherDirs.has(key)) otherDirs.set(key, { key: "others|" + key, path: s.cwd || "", label: baseName(s.cwd) || "其他目录", sessions: [] });
        otherDirs.get(key).sessions.push(s);
      }
      const names = new Map();
      for (const d of otherDirs.values()) names.set(d.label, (names.get(d.label) || 0) + 1);
      for (const d of otherDirs.values()) if (names.get(d.label) > 1) d.label = lastTwo(d.path);
      const otherList = [...otherDirs.values()];
      const othersOpen = q ? otherList.length > 0 : collapsed && collapsed["others"] === false;
      return { agents: out, others: { dirs: otherList, count: otherList.reduce((n, d) => n + d.sessions.length, 0), open: !!othersOpen } };
    }

    function makeRulithTree(services) {
      return function RulithTree({ wide, expandSidebar }) {
        const list = useStore(services.sessions.list);
        const workspaces = useStore(services.workspaces.list);
        const selection = useStore(services.ui.selection);
        const [tree, refreshTree] = usePoll("tree", 15000);
        const [filter, setFilter] = useState("");
        const [collapsed, setCollapsed] = useState(loadCollapsed);
        const [more, setMore] = useState({});
        const [busy, setBusy] = useState("");
        const [note, setNote] = useState("");
        const [deleting, setDeleting] = useState(null); // { id, title, agentName, found, goals }
        const [folderFor, setFolderFor] = useState(null);     // the Agent whose "open a folder" input is shown
        const [folderPath, setFolderPath] = useState("");
        const [asking, setAsking] = useState(null);           // { view, note, answer } while the confirmation is open
        const [progress, setProgress] = useState("");
        const stop = React.useRef(false);
        if (!wide) return h("button", { type: "button", title: "展开智能体列表", onClick: expandSidebar,
          style: { ...button, display: "block", margin: "8px auto" } }, "☰");
        const current = selection && selection.sessionId;
        const ready = tree && tree.ok;
        const view = buildTree({ tree: ready ? tree : null, list, workspaces, current, filter, collapsed });
        const toggle = (key, open) => { const next = { ...collapsed, [key]: open }; setCollapsed(next); saveCollapsed(next); };
        const open = (id) => { try { services.ui.openSession(id); } catch (error) { setNote(String(error && error.message || error)); } };
        const archive = (id) => Promise.resolve(services.ui.archiveSession(id)).catch((error) => setNote(String(error && error.message || error)));
        // PSC 0.2.21: deleting asks first. A call still without a result refuses before any dialog.
        const askDelete = async (s, agentName) => {
          if (busy) return;
          setNote("");
          const title = s.blank ? "新会话" : (s.title && s.title.trim()) || "未命名会话";
          try {
            const preview = await api("conversation/end-preview", { session: s.id });
            if (!preview.ok) { setNote(preview.teaching || "读不到这个会话的 Board"); return; }
            if (preview.pendingCall) { setNote("这个会话还有一次没有结果的调用，先在 Console 处理它。"); return; }
            setDeleting({ id: s.id, title, agentName, found: preview.found !== false, goals: Array.isArray(preview.openGoals) ? preview.openGoals.length : 0 });
          } catch (error) { setNote(String(error && error.message || error)); }
        };
        const confirmDelete = async () => {
          const target = deleting;
          if (!target || busy) return;
          setBusy("delete");
          try {
            const reply = await api("conversation/end", { session: target.id });
            if (!reply.ok) { setNote(reply.teaching || "没有删除"); return; }
            const left = Array.isArray(reply.unconfirmedGoals) ? reply.unconfirmedGoals.length : 0;
            setDeleting(null);
            // 目标没有全部结案时不从列表移走：再删一次会补做。
            if (left || reply.goalsUnread) { setNote("已删除，但还有" + (left ? " " + left + " 个" : "") + "目标没能结案：再删除一次会补做。"); refreshTree(); return; }
            await archive(target.id);
            refreshTree();
          } catch (error) { setNote(String(error && error.message || error)); }
          finally { setBusy(""); }
        };
        const startSession = async (agent, directory) => {
          try {
            let ws = ((services.workspaces.list.getSnapshot() || {}).items || []).find((item) => samePath(item.path) === samePath(directory));
            if (!ws) { const made = await services.workspaces.create({ path: directory }); ws = pick(pick(made, "value"), "workspace"); }
            const created = await services.sessions.create({ workspaceId: ws.workspaceId });
            const id = typeof created === "string" ? created : pick(pick(created, "value"), "sessionId");
            const reply = await api("sessions/assign", { session: id, agentId: agent.agentId });
            if (!reply.ok) setNote(reply.teaching || "没有记下这个会话的智能体");
            open(id);
            refreshTree();
          } catch (error) { setNote("新会话没有建成：" + String(error && error.message || error)); }
        };
        const newSession = async (agent, dir) => {
          if (busy) return;
          setBusy(agent.agentId); setNote("");
          try { await startSession(agent, dir.path); } finally { setBusy(""); }
        };
        // PSC 0.2.24: open a folder as a project, then start a conversation in it once it is ready (never before: the
        // conversation's Board freezes the Agent's settings when it is made).
        const openFolder = async (agent, directory) => {
          if (busy || !String(directory || "").trim()) return;
          setBusy("project:" + agent.agentId); setNote(""); stop.current = false;
          try {
            const result = await openProjectFlow({ api, agentId: agent.agentId, directory: String(directory).trim(),
              newRequestId: newProjectRequestId,
              ui: { confirm: (view, why) => new Promise((answer) => setAsking({ view, note: why, answer })),
                progress: setProgress, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), stopped: () => stop.current } });
            setProgress("");
            if (result.outcome === "ready") { setFolderFor(null); setFolderPath(""); await startSession(agent, result.directory); }
            else if (result.outcome !== "cancelled") setNote(result.text);
          } catch (error) { setNote("没有打开项目：" + String(error && error.message || error)); }
          finally { setBusy(""); setProgress(""); setAsking(null); }
        };
        const answerAsking = (yes) => { const pending = asking; setAsking(null); if (pending) pending.answer(yes); };
        const setUp = async (agent) => {
          setBusy(agent.agentId); setNote("");
          try { const reply = await api("select", { agentId: agent.agentId, newConnection: true }); if (!reply.ok) setNote(reply.teaching || "没有设置成功"); refreshTree(); }
          finally { setBusy(""); }
        };
        const firstDir = (entry) => entry.dirs.find((d) => !d.extra) || entry.dirs[0];
        const startHere = () => {
          const own = view.agents.find((entry) => entry.hasCurrent) || view.agents.find((entry) => entry.isDefault) || view.agents[0];
          if (!own || !own.agent.attached) return;
          const s = current && list.byId[current];
          const dir = (s && own.dirs.find((d) => samePath(d.path) === samePath(s.cwd))) || firstDir(own);
          if (dir) newSession(own.agent, dir);
        };
        const sessionRow = (s, agentName) => h("div", { key: s.id, role: "button", tabIndex: 0, "data-rulith-session": s.id,
            onClick: () => open(s.id), onKeyDown: (event) => { if (event.key === "Enter") open(s.id); },
            style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 34px", borderRadius: 6, cursor: "pointer", fontSize: 13,
              background: s.id === current ? "rgba(127,127,127,.20)" : "transparent" } },
          s.running ? dot(GREEN) : h("span", { style: { width: 8, flex: "none" } }),
          h("span", { title: s.title || "", style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            s.blank ? "新会话" : (s.title && s.title.trim()) || "未命名会话"),
          h("span", { style: { ...small, flex: "none" } }, agoText(s.updatedAt)),
          h("button", { type: "button", title: "删除这个会话", "data-rulith-delete": s.id, style: tiny, onClick: (event) => { event.stopPropagation(); askDelete(s, agentName); } }, "🗑"),
          h("button", { type: "button", title: "归档这个会话", style: tiny, onClick: (event) => { event.stopPropagation(); archive(s.id); } }, "×"));
        const dirBlock = (entry, d) => {
          const key = "d:" + d.key;
          const shut = collapsed[key] === true && !filter;
          const showAll = !!more[d.key] || !!filter;
          const shown = showAll ? d.sessions : d.sessions.slice(0, SHOWN);
          return h("div", { key: d.key, "data-rulith-directory": d.path },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 6px 2px 18px", fontSize: 12.5, opacity: 0.9 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle(key, !shut) }, shut ? "▸" : "▾"),
              h("span", { title: d.path, style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                "📁 " + (d.label || baseName(d.path)) + (d.source === null && !d.extra ? "（未绑定目录）" : "")),
              h("span", { style: small }, d.sessions.length || ""),
              entry.agent.attached ? h("button", { type: "button", title: "在这个目录开新会话", disabled: !!busy, style: tiny,
                onClick: () => newSession(entry.agent, d) }, "+") : null),
            shut ? null : h("div", null, shown.map((s) => sessionRow(s, entry.agent.name)),
              d.sessions.length > SHOWN && !filter ? h("button", { type: "button", style: { ...tiny, padding: "1px 34px", fontSize: 12 },
                onClick: () => setMore({ ...more, [d.key]: !showAll }) }, showAll ? "收起" : "更多（" + (d.sessions.length - SHOWN) + "）") : null));
        };
        const agentBlock = (entry) => {
          const a = entry.agent;
          const online = a.worker && a.worker.state === "online";
          return h("div", { key: a.agentId, "data-rulith-agent": a.agentId, style: { marginBottom: 4 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, fontSize: 13, fontWeight: 600 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14, opacity: 0.8 }, onClick: () => toggle(a.agentId, entry.open) }, entry.open ? "▾" : "▸"),
              dot(!a.attached ? GREY : online ? GREEN : AMBER),
              h("span", { title: a.name, style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.name),
              entry.isDefault ? h("span", { style: { ...small, fontWeight: 400 } }, "默认") : null,
              entry.count ? h("span", { style: { ...small, fontWeight: 400 } }, entry.count) : null,
              !a.attached ? h("button", { type: "button", disabled: !!busy, style: { ...button, padding: "0 6px", fontSize: 11 }, onClick: () => setUp(a) }, "在本机设置")
                : firstDir(entry) ? h("button", { type: "button", title: "在这个智能体下开新会话", disabled: !!busy, style: tiny, onClick: () => newSession(a, firstDir(entry)) }, "+") : null),
            entry.open && a.attached ? h("div", null, entry.dirs.map((d) => dirBlock(entry, d)), openFolderRow(a)) : null);
        };
        // The directory level's last row: open another folder of this computer as one of this Agent's projects.
        const openFolderRow = (a) => folderFor !== a.agentId
          ? h("button", { type: "button", "data-rulith-open-folder": a.agentId, disabled: !!busy, title: "把这台电脑上的一个文件夹作为这个智能体的项目打开",
              style: { ...tiny, display: "block", padding: "2px 6px 2px 18px", fontSize: 12.5, textAlign: "left" },
              onClick: () => { setFolderFor(a.agentId); setFolderPath(""); setNote(""); } }, "📂 打开文件夹…")
          : h("div", { "data-rulith-open-folder": a.agentId, style: { padding: "2px 6px 2px 18px" } },
              h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                h("input", { value: folderPath, autoFocus: true, placeholder: "文件夹的完整路径，例如 D:\\work\\game 或 /home/you/game",
                  disabled: !!busy, onChange: (event) => setFolderPath(event.target.value),
                  onKeyDown: (event) => { if (event.key === "Enter") openFolder(a, folderPath); else if (event.key === "Escape" && !busy) setFolderFor(null); },
                  style: { flex: 1, minWidth: 0, padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12 } }),
                h("button", { type: "button", style: { ...button, padding: "1px 8px", fontSize: 11 }, disabled: !!busy || !folderPath.trim(), onClick: () => openFolder(a, folderPath) }, "打开"),
                h("button", { type: "button", title: "取消", style: tiny, disabled: !!busy, onClick: () => setFolderFor(null) }, "×")),
              progress ? h("div", { role: "status", style: { ...small, display: "flex", gap: 6, alignItems: "baseline", marginTop: 4 } },
                h("span", { style: { flex: 1 } }, progress),
                h("button", { type: "button", style: { ...tiny, fontSize: 11 }, onClick: () => { stop.current = true; } }, "停止等待")) : null);
        const confirmation = asking ? projectConfirmation(asking.view) : null;
        return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, overflow: "auto", padding: "4px 6px" }, "data-rulith-tree": "" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" } },
            h("span", { style: { ...section, margin: 0, flex: 1 } }, "智能体"),
            h("button", { type: "button", title: "在当前智能体与目录下开新会话", disabled: !!busy || !ready, style: tiny, onClick: startHere }, "＋ 新会话")),
          h("input", { value: filter, placeholder: "筛选智能体、目录或会话", onChange: (event) => setFilter(event.target.value),
            style: { margin: "2px 6px 8px", padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12 } }),
          !tree ? none("正在读取智能体…")
            : !ready ? h("div", { style: { ...small, padding: "0 6px 8px" } }, tree.teaching || "读不到智能体：在左下角登录 Rulith。") : null,
          view.agents.map(agentBlock),
          view.others.count ? h("div", { style: { marginTop: 6 }, "data-rulith-unowned": "" },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 13, opacity: 0.8 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle("others", view.others.open) }, view.others.open ? "▾" : "▸"),
              h("span", { style: { flex: 1 } }, "未归属的会话"),
              h("span", { style: small }, view.others.count)),
            view.others.open ? view.others.dirs.map((d) => dirBlock({ agent: { attached: false } }, d)) : null) : null,
          note ? h("div", { role: "alert", style: { ...small, color: AMBER, padding: "4px 6px" } }, note) : null,
          deleting ? h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" },
              onClick: () => { if (!busy) setDeleting(null); } },
            h("div", { role: "dialog", "aria-modal": "true", "data-rulith-delete-dialog": deleting.id, onClick: (event) => event.stopPropagation(),
                style: { width: 420, maxWidth: "90vw", padding: 18, borderRadius: 12, background: "var(--color-bg-elevated, #1f2328)", color: "inherit",
                  border: "1px solid rgba(127,127,127,.35)", boxShadow: "0 12px 32px rgba(0,0,0,.4)", fontSize: 13, lineHeight: 1.6 } },
              h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, "删除这个会话？"),
              deleting.found
                ? h("div", null,
                    h("div", null, "会话「" + deleting.title + "」" + (deleting.agentName ? "属于智能体 " + deleting.agentName : "") + "。删除后："),
                    h("div", null, "· 它在 Rulith 上的 Board 封存，这个会话不能再继续；"),
                    deleting.goals ? h("div", null, "· 还开着的 " + deleting.goals + " 个目标会以“放弃”结案；") : null,
                    h("div", null, "· 回执、证明、计费和历史记录都保留，可在 Console 查看。"),
                    h("div", { style: { marginTop: 6 } }, "这一步不能撤销。"))
                : h("div", null, "会话「" + deleting.title + "」还没有用过 Rulith，云上没有它的 Board。删除只会在本机把它移出列表。"),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
                h("button", { type: "button", style: button, disabled: !!busy, onClick: () => setDeleting(null) }, "取消"),
                h("button", { type: "button", style: { ...button, borderColor: "#f85149", color: "#f85149" }, disabled: !!busy, onClick: confirmDelete },
                  busy === "delete" ? "正在删除…" : "删除")))) : null,
          // PSC 0.2.24: the one confirmation of opening a folder as a project. Its content is the Gateway's answer.
          confirmation && !confirmation.error ? h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" },
              onClick: () => answerAsking(false) },
            h("div", { role: "dialog", "aria-modal": "true", "data-rulith-project-dialog": "", onClick: (event) => event.stopPropagation(),
                style: { width: 520, maxWidth: "92vw", maxHeight: "86vh", overflow: "auto", padding: 18, borderRadius: 12, background: "var(--color-bg-elevated, #1f2328)", color: "inherit",
                  border: "1px solid rgba(127,127,127,.35)", boxShadow: "0 12px 32px rgba(0,0,0,.4)", fontSize: 13, lineHeight: 1.6 } },
              h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, confirmation.title),
              asking.note ? h("div", { role: "alert", style: { color: AMBER, marginBottom: 8 } }, asking.note) : null,
              confirmation.rows.map(([label, value]) => h("div", { key: label, style: { display: "flex", gap: 10, padding: "3px 0" } },
                h("div", { style: { flex: "none", width: 96, opacity: 0.7 } }, label),
                h("div", { style: { flex: 1, wordBreak: "break-word" } }, value))),
              h("div", { style: { marginTop: 8, opacity: 0.8 } }, confirmation.footer),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
                h("button", { type: "button", style: button, onClick: () => answerAsking(false) }, confirmation.cancel),
                h("button", { type: "button", style: { ...button, borderColor: GREEN, color: GREEN }, onClick: () => answerAsking(true) }, confirmation.accept)))) : null);
      };
    }

    const RulithArtwork = () => h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
      borderRadius: 7, background: "#2ea36b", color: "#fff", fontWeight: 800, fontSize: 16 } }, "R");
    function apply(ctx) {
      // Deep Rulith keeps the Rulith Runtime's three columns: sessions, the conversation, and on the right the execution
      // in this environment. The Rulith column is the right sidebar's entry, and every session opens with it.
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "builtin", title: () => "Rulith",
        guide: [{ id: "rulith", commandId: "rulith.panel", order: 1, title: () => "Rulith",
          description: () => "目标、最近操作、当前前沿和本机执行", icon: RulithArtwork }] }));
      let revealed = false;
      const ensureColumn = () => setTimeout(() => {
        try {
          const session = ctx.sidebarRight.mounted.getSnapshot();
          if (session === undefined) return;
          if (!ctx.sidebarRight.tabsIn(session).some((tab) => tab.kind === TAB_KIND)) ctx.sidebarRight.openTabIn(session, TAB_KIND, {});
          // Shown once per page load; a person who collapses it keeps it collapsed.
          if (!revealed) { revealed = true; if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); }
        } catch (error) { console.warn("Deep Rulith: could not open the Rulith column", error); }
      }, 0);
      ctx.effect(() => ctx.sidebarRight.mounted.subscribe(ensureColumn));
      ensureColumn();
      ctx.inject(["shortcuts"], (inner) => {
        inner.effect(() => inner.shortcuts.register({ id: "rulith.panel", label: () => "Rulith", aliases: ["rulith", "board", "worker"],
          defaults: {}, regions: ["page", "editable", "terminal"], modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element);
            if (target === void 0) return { status: "blocked", reason: "先打开一个会话" };
            return { status: "handled", run: () => ctx.sidebarRight.openTabFromTarget(TAB_KIND, target) };
          } }));
      });
      const openBoard = () => { try { ctx.sidebarRight.openTab(TAB_KIND, {}); } catch (error) { console.warn("Deep Rulith: could not open the Rulith tab", error); } };
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "rulith-account", inject: () => ({ openBoard }) }, RulithAccount));
      // The Agent -> directory -> conversation browser, once dsh's navigation and stores are up.
      ctx.inject(["uiWorkspace", "sessions", "workspaces"], (inner) => {
        const RulithTree = makeRulithTree({ ui: inner.uiWorkspace, sessions: inner.sessions, workspaces: inner.workspaces });
        inner.slots.inject("sidebar.workspaces", () => inner.slots.register({ name: "sidebar.workspaces", priority: -1 }, RulithTree));
      });
      // Session-scoped slot: dsh hands the registrant the session id positionally.
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "rulith-conversation",
        inject: (sessionId) => ({ sessionId }) }, RulithComposerControls));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID,
        inject: () => ({ mountedSession: ctx.sidebarRight.mounted }) }, RulithColumn));
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID, inject: () => ({}) }, () => h("span", null, "Rulith")));
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
        yield ctx.slots.register({ name: "sidebar.brand.mark" }, ({ size }) => h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: size || 20, height: size || 20, borderRadius: 6, background: "#2ea36b", color: "#fff", fontWeight: 800, fontSize: Math.round((size || 20) * 0.6) } }, "R"));
        yield ctx.slots.register({ name: "sidebar.brand.name" }, () => h("span", { style: { fontWeight: 700 } }, "Deep Rulith"));
      }));
    }
    exports.apply = apply;
    exports.buildTree = buildTree;
    exports.projectConfirmation = projectConfirmation;
    exports.openProjectFlow = openProjectFlow;
    exports.refusalText = refusalText;
    exports.progressText = progressText;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    return module.exports;
  }
});
