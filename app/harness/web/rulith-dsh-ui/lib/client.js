// Rulith, browser half (plain script for dsh's module loader: no build step). The first-run wizard, the one settings page,
// the Agent tree, the composer's two chips and the right sidebar's 任务 panel (with signing a goal's criteria) read and act
// only through /rulith/api on dsh's own server, which forwards to the owner's Rulith Runtime manager and to Rulith's MCP
// authority. No token, key or secret is part of this script, and no key is ever shown back.
//
// 中文说明：本机应用的浏览器一半（设计 §3.1、§3.2，批次 2）：首次使用向导、一处设置、智能体树、输入行的两个开关（档位、
// 模型）与右栏（批次 4：任务面板与签字），全部只经同源的 /rulith/api 读写；页面上不出现任何密钥。
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
    const GREEN = "#3fb950", AMBER = "#d29922", GREY = "#8b949e", RED = "#f85149";

    async function api(path, body) {
      const response = await fetch("/rulith/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-deep-rulith": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return response.json();
    }
    // The English Runtime workbench, kept for diagnosis only (settings → 高级). Its address carries the manager key, so it
    // is fetched on demand through the guarded API and never stored in this page.
    async function openWorkbench() {
      const win = window.open("about:blank", "_blank");
      try {
        const reply = await api("workbench", {});
        if (win && reply.ok && reply.url) { win.opener = null; win.location.replace(reply.url); } else if (win) win.close();
      } catch { if (win) win.close(); }
    }
    // Two parts of the page that poll the same route share one read: the composer and the 任务 panel both read
    // `conversation?session=…`, which reaches the account service. A timer tick reuses a read younger than its own interval;
    // `refresh()` (after an action) always reads anew, and the other part's next tick takes that answer.
    const reads = new Map();   // path -> { at, read }
    const readFresh = (path) => {
      const read = api(path);
      reads.set(path, { at: Date.now(), read });
      read.catch(() => { if (reads.get(path) && reads.get(path).read === read) reads.delete(path); });
      return read;
    };
    const readShared = (path, maxAge) => { const hit = reads.get(path); return hit && Date.now() - hit.at < maxAge ? hit.read : readFresh(path); };
    /** Poll one read route; a null path does not poll (and reads as nothing). */
    function usePoll(path, ms) {
      const [data, setData] = useState(null);
      const load = useCallback(async (reuse) => {
        if (!path) return;
        try { setData(await (reuse === true ? readShared(path, ms - 1000) : readFresh(path))); }
        catch (error) { setData({ ok: false, teaching: String(error) }); }
      }, [path]);
      const refresh = useCallback(() => load(false), [load]);
      useEffect(() => {
        if (!path) return undefined;
        load(true); const timer = setInterval(() => load(true), ms); return () => clearInterval(timer);
      }, [load, ms]);
      return [path ? data : null, refresh, setData];
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const errorText = (error) => String((error && error.message) || error);
    const dot = (color) => h("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, flex: "none" } });
    const button = { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 };
    const primary = { ...button, borderColor: GREEN, color: GREEN };
    const linkButton = { padding: 0, border: "none", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12, opacity: 0.7, textDecoration: "underline" };
    const section = { fontSize: 11, opacity: 0.6, margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: ".04em" };
    const small = { fontSize: 11, opacity: 0.65 };
    const field = { width: "100%", boxSizing: "border-box", padding: "4px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", fontSize: 13 };
    const none = (text) => h("div", { style: { opacity: 0.6, fontSize: 12 } }, text);
    const alertLine = (text, color = AMBER) => h("div", { role: "alert", style: { marginTop: 8, color, fontSize: 12, wordBreak: "break-word" } }, text);
    const backdrop = (z, onClose, child) => h("div", { style: { position: "fixed", inset: 0, zIndex: z, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" },
      onClick: onClose }, child);
    const card = (width) => ({ width, maxWidth: "92vw", maxHeight: "86vh", overflow: "auto", boxSizing: "border-box", padding: 18, borderRadius: 12,
      background: "var(--dsw-alias-bg-layer-2, #1f2328)", color: "var(--dsw-alias-label-primary, inherit)", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", boxShadow: "var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.4))", fontSize: 13, lineHeight: 1.6 });

    // A tiny external store (React's useSyncExternalStore reads it): which settings section is open, from anywhere.
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return { getSnapshot: () => value, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        set: (next) => { value = typeof next === "function" ? next(value) : next; for (const fn of [...listeners]) fn(); } };
    }
    const useStore = (store) => React.useSyncExternalStore((notify) => store.subscribe(notify), () => store.getSnapshot());
    const settingsView = createStore({ open: false, section: "account" });
    // The signing confirmation, drawn in the page's overlay (not inside the right column): { goal, label, leaves, answer }.
    const signView = createStore(null);
    const openSettings = (section) => settingsView.set((view) => ({ open: true, section: section || view.section }));
    const closeSettings = () => settingsView.set((view) => ({ ...view, open: false }));
    // dsh's theme and language services, when they are composed (settings → 外观与语言).
    const shared = { theme: undefined, locale: undefined };

    // ---- Signing in, and this computer's state (design §3.2 账户面板: only the account and this computer).
    /**
     * Sign this computer in: a tab is opened within the click (so no popup blocker), pointed at the approval page, and the
     * approval is polled. Returns the account summary once signed in, else `{ ok: false, teaching }`. Pure apart from its
     * arguments: exported for the harness tests.
     */
    async function signInFlow({ api, openTab = () => window.open("about:blank", "_blank"), wait = sleep, tries = 60 }) {
      let tab = null; try { tab = openTab(); } catch { tab = null; }
      const reply = await api("signin", {});
      if (!reply.ok || !reply.url) { if (tab) tab.close(); return reply; }
      if (tab) tab.location.href = reply.url; else window.open(reply.url, "_blank", "noopener");
      for (let i = 0; i < tries; i++) {
        await wait(3000);
        const polled = await api("signin/poll", {});
        if (polled.ok && polled.signedIn) return polled;
      }
      return { ok: false, teaching: "登录还没有完成：请在打开的 Rulith 页面里批准，再点一次登录。" };
    }
    /** The settings entry's line: the signed-in account and whether this computer's Worker runs for any Agent. Pure. */
    function computerStatus(s) {
      if (!s) return { color: GREY, text: "正在读取…" };
      if (!s.ok) return { color: GREY, text: "本机 Rulith 未连接" };
      if (!s.signedIn) return { color: GREY, text: "未登录 Rulith" };
      const here = (Array.isArray(s.agents) ? s.agents : []).filter((agent) => agent.paired);
      const online = here.some((agent) => agent.worker && agent.worker.state === "online");
      return { color: online ? GREEN : here.length ? AMBER : GREY,
        text: (s.account ? s.account + " · " : "") + (online ? "这台电脑在线" : here.length ? "这台电脑离线" : "这台电脑还没有设置") };
    }
    /** One Agent's state on this computer, in words. Pure. */
    function workerWords(agent) {
      if (!agent || !agent.paired) return { color: GREY, text: "未设置" };
      const worker = agent.worker;
      if (worker && worker.state === "online") return { color: GREEN, text: "在线" };
      if (worker && worker.enabled === false) return { color: AMBER, text: "这台电脑没有为它开启" };
      return { color: AMBER, text: "离线" + (worker && worker.state ? "（" + worker.state + "）" : "") };
    }

    // ---- 「在本机设置」 (PSC 0.2.27 ② ③): one operation, its steps shown as it runs; no restart and no choice.
    // The manager's steps, in the order they run (the kit is installed before the Worker is turned on, so a first setup
    // starts the Worker once), under the words the owner reads.
    const SETUP_GROUPS = [["连接", ["instance", "pair"]], ["安装编程工具", ["kit"]], ["开启这台电脑", ["worker"]],
      ["重新载入", ["reload"]], ["完成", ["ready"]]];
    const SETUP_REASONS = {
      not_signed_in: "这台电脑没有登录 Rulith：先在设置的「账户」里登录。",
      agent_not_in_account: "这个智能体不在当前登录的账户里，或者在 Console 里不再对这台电脑开放。",
      runtime_credential_exists: "这个智能体的 Agent token 正在别处使用（另一台电脑或另一个客户端持有它）。没有替换，什么都没有改。",
      connection_rejected: "Rulith 拒绝了这台电脑的连接凭据（可能在 Console 里轮换或撤销了）。什么都没有改，Worker 也没有重新启动。",
      connection_missing: "这台电脑记着这个智能体，但它的连接凭据不见了。什么都没有改。",
      worker_taken_over: "这个智能体的连接被另一个 Worker 进程接走了，这台电脑的 Worker 已停下、没有重新启动。在设置的「这台电脑」里点「在本机设置」，可以让它在这台电脑上重新启动。",
      // PSC 0.2.27 ②: the Connection this computer would reconnect is in use by a Worker elsewhere: refused, nothing created.
      local_setup_connection_in_use: "这台电脑要接上的这个智能体的连接，正被另一台电脑上的 Worker 使用，所以没有接上，也没有新建连接；这次设置已撤回。等那个 Worker 停下（或它的租约过期）后，再点「在本机设置」。",
      setup_request_conflict: "这次设置和另一次冲突了：再点一次「在本机设置」。",
    };
    /**
     * When a setup stopped because going on would replace this Agent's token (SYS-LOCAL-01), what the owner is asked
     * before it goes on; null otherwise. The manager's own confirmation says the same thing (its 「Replace this Agent's
     * existing key」): the previous key stops working, including in clients still using it. Pure.
     * - runtime_credential_exists: another computer or client holds the token; replacing it sets this computer up with its
     *   own Connection, and that computer's client stops working (its Connection is not taken).
     * - connection_rejected / connection_missing: reconnecting this computer is a new pairing of the same Connection (a new
     *   key delivered here), which also replaces the token.
     */
    function replaceConfirmation(run) {
      const steps = run && run.settled && !run.ok && run.view && Array.isArray(run.view.steps) ? run.view.steps : [];
      const failed = steps.find((step) => step.state === "failed");
      const code = failed && failed.errorCode;
      const consequence = "原来的 Agent token 随即失效：仍在用它的客户端（包括另一台电脑上的）会停止工作，要在那里继续使用，得在那台电脑上重新设置。替换本身不授予任何文件夹或工具的权限。";
      if (code === "runtime_credential_exists") return { code,
        title: "替换这个智能体的 Agent token？",
        lines: ["这个智能体已经有一个有效的 Agent token，正在另一台电脑（或另一个客户端）上使用。",
          "替换后，这台电脑用新的 Agent token 设置好，并有它自己的连接；那台电脑的连接不会被接走。", consequence],
        accept: "替换 Agent token 并继续设置", cancel: "不替换" };
      if (code === "connection_rejected" || code === "connection_missing") return { code,
        title: "重新接上这台电脑？",
        lines: [SETUP_REASONS[code],
          "重新接上会给这台电脑的这条连接换一把新密钥、送到这里；这条连接本身、它的文件夹授权和工具锁定都不变。",
          "这需要同时替换这个智能体的 Agent token。" + consequence],
        accept: "替换 Agent token 并重新接上", cancel: "不重新接上" };
      return null;
    }
    /** The step list as the owner reads it: label, state (pending, running, done, failed) and a failed step's reason. Pure. */
    function setupSteps(view) {
      const steps = view && Array.isArray(view.steps) ? view.steps : [];
      return SETUP_GROUPS.map(([label, names]) => {
        const rows = names.map((name) => steps.find((step) => step.name === name)).filter(Boolean);
        const failed = rows.find((row) => row.state === "failed");
        const state = failed ? "failed" : rows.some((row) => row.state === "running") ? "running"
          : rows.length === names.length && rows.every((row) => row.state === "done") ? "done" : "pending";
        return { label, state, reason: failed ? SETUP_REASONS[failed.errorCode] || failed.reason || "这一步没有完成。" : "" };
      });
    }
    /**
     * Start one setup and follow it to its end, reporting every step list read. Returns `{ settled, ok, view, error }`.
     * Pure apart from its arguments: exported for the harness tests.
     */
    async function runSetup({ api, agentId, mode, replaceAgentToken = false, wait = sleep, report = () => {}, maxPolls = 400 }) {
      const settle = (out) => { const done = { settled: true, ...out }; report(done); return done; };
      report({ settled: false, ok: false, view: null, error: "" });
      try {
        // `replaceAgentToken` only after the owner confirmed it (replaceConfirmation).
        let view = await api("setup", { agentId, ...(mode === "repair" ? { mode: "repair" } : {}),
          ...(replaceAgentToken === true ? { replaceAgentToken: true } : {}) });
        for (let polls = 0; view && view.ok && view.state !== "done" && view.state !== "failed"; polls++) {
          if (polls >= maxPolls) return settle({ ok: false, view, error: "设置还在进行：稍后在设置的「这台电脑」里再看一次。" });
          report({ settled: false, ok: false, view, error: "" });
          await wait(750);
          view = await api("setup?requestId=" + encodeURIComponent(view.requestId));
        }
        if (!view || !view.ok) return settle({ ok: false, view: null, error: SETUP_REASONS[view && view.errorCode] || (view && view.teaching) || "没有设置成功。" });
        return settle({ ok: view.state === "done", view, error: "" });
      } catch (error) {
        return settle({ ok: false, view: null, error: "读不到设置的进度：" + errorText(error) + "。设置可能还在进行，稍后再看一次。" });
      }
    }
    function useSetupRun() {
      const [run, setRun] = useState(null);   // { agentId, settled, ok, view, error }
      const start = (agentId, mode, options = {}) => runSetup({ api, agentId, mode, replaceAgentToken: options.replaceAgentToken === true,
        report: (next) => setRun({ agentId, ...next }) });
      return { run, start, busy: !!(run && !run.settled) };
    }
    const STEP_MARK = { done: ["✓", GREEN], running: ["…", AMBER], failed: ["✕", RED], pending: ["○", GREY] };
    /**
     * A setup's steps. When it stopped because going on would replace the Agent's token and `onReplace` is given, the
     * confirmation (replaceConfirmation) is shown under them; its button calls `onReplace()`, which runs the setup again
     * with the owner's confirmation. 「不替换」 only puts the question away.
     */
    function SetupSteps({ run, onReplace }) {
      const [declined, setDeclined] = useState("");   // the request whose confirmation the owner put away
      if (!run) return null;
      const rows = setupSteps(run.view);
      const asking = onReplace ? replaceConfirmation(run) : null;
      const requestId = (run.view && run.view.requestId) || "";
      return h("div", { role: "status", "data-rulith-setup": run.agentId || "", style: { fontSize: 12, margin: "4px 0 6px" } },
        run.view ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } }, rows.map((row, i) => h("span", { key: row.label,
            "data-step-state": row.state, style: { color: STEP_MARK[row.state][1] } }, (i ? "→ " : "") + STEP_MARK[row.state][0] + " " + row.label)))
          : none("正在开始设置…"),
        rows.filter((row) => row.state === "failed").map((row) => h("div", { key: "why-" + row.label, role: "alert", style: { color: RED, wordBreak: "break-word" } },
          "「" + row.label + "」没有完成：" + row.reason)),
        asking && declined !== requestId ? h("div", { "data-rulith-replace-token": asking.code, style: { margin: "6px 0", padding: "6px 8px",
            border: "1px solid " + AMBER, borderRadius: 6 } },
          h("div", { style: { fontWeight: 600, marginBottom: 4 } }, asking.title),
          asking.lines.map((line, i) => h("div", { key: i, style: { margin: "2px 0", wordBreak: "break-word" } }, line)),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 } },
            h("button", { type: "button", style: button, onClick: () => setDeclined(requestId) }, asking.cancel),
            h("button", { type: "button", style: primary, onClick: () => { setDeclined(requestId); onReplace(); } }, asking.accept))) : null,
        run.error ? alertLine(run.error) : null,
        run.settled && run.ok ? h("div", { style: { color: GREEN } }, "已在这台电脑上设置好，不需要重启。") : null);
    }

    // ---- The model (PSC 0.2.27 ④): the signed-in account's default model; saved, it is used from the next turn.
    /** The model form of the wizard's step ② and of settings → 模型. The key is sent, never shown back. */
    function ModelForm({ onSaved }) {
      const [loaded, reload] = usePoll("model", 60000);
      const [draft, setDraft] = useState(null);     // { url, name } once edited
      const [key, setKey] = useState("");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);   // { ok, text }
      if (!loaded) return none("正在读取模型设置…");
      if (!loaded.ok) return alertLine(loaded.teaching || "读不到模型设置。");
      const m = loaded.model || {};
      const url = draft ? draft.url : m.url || "";
      const name = draft ? draft.name : m.name || "";
      const edit = (which, value) => setDraft({ url, name, [which]: value });
      const save = async () => {
        setBusy(true); setNotice(null);
        try {
          const reply = await api("model", { expectedOrigin: m.expectedOrigin, expectedAccountId: m.expectedAccountId,
            url: url.trim(), name: name.trim(), ...(key.trim() ? { key: key.trim() } : {}) });
          if (!reply.ok) { setNotice({ ok: false, text: reply.teaching || "没有保存。" }); return; }
          setKey(""); setDraft(null); reload();
          const ready = !!(reply.model && reply.model.configured);
          setNotice({ ok: ready, text: ready ? "已保存，从下一轮起生效。" : "已保存，但还不能用：请填写密钥（本机地址的模型可以不填）。" });
          if (ready && onSaved) onSaved(reply.model);
        } catch (error) { setNotice({ ok: false, text: "没有保存：" + errorText(error) }); }
        finally { setBusy(false); }
      };
      const host = (value) => String(value || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const label = (text, input) => h("label", { style: { display: "block", marginTop: 8 } }, h("div", { style: small }, text), input);
      return h("div", { "data-rulith-model-form": "" },
        h("div", null, m.configured ? "现在用的：" + m.name + " · " + host(m.url) : "还没有设置可用的模型。"),
        label("地址", h("input", { value: url, list: "rulith-model-endpoints", placeholder: "https://api.deepseek.com/v1", disabled: busy, style: field,
          onChange: (event) => edit("url", event.target.value) })),
        h("datalist", { id: "rulith-model-endpoints" }, h("option", { value: "https://api.deepseek.com/v1" }), h("option", { value: "https://api.anthropic.com/v1/messages" })),
        label("模型 ID", h("input", { value: name, placeholder: "deepseek-flash", disabled: busy, style: field, onChange: (event) => edit("name", event.target.value) })),
        label("密钥", h("input", { type: "password", value: key, autoComplete: "new-password", disabled: busy, style: field,
          placeholder: m.keyConfigured ? "已保存；留空则不改" : "API 密钥", onChange: (event) => setKey(event.target.value) })),
        h("div", { style: { ...small, marginTop: 6 } }, "OpenAI 兼容的地址，或以 /messages 结尾的 Anthropic 地址；本机的模型可以用 http://127.0.0.1:端口/v1。保存后从下一轮起生效，不需要重启；密钥只留在这台电脑上，不会再显示。"),
        h("div", { style: { marginTop: 10 } }, h("button", { type: "button", style: primary, disabled: busy || !url.trim() || !name.trim(), onClick: save }, busy ? "正在保存…" : "保存")),
        notice ? alertLine(notice.text, notice.ok ? GREEN : AMBER) : null);
    }

    // ---- The right column: the 任务 panel (design §3.2 右栏, §5 d, §6; batch 4, D-1024a). Top to bottom: 待你签字的验收标准
    // (only while a goal has proposed criteria not signed yet), an operation that waits for a person, 任务, 验收标准与状态,
    // 最近操作 and 这台电脑. Every line is in plain words (design §2): no node id, digest, raw state code, tool id or lease
    // detail. It reads the host's cached results of this conversation (`board`; never a Board read of its own, with the
    // Console pages a person may need from it), this conversation's state through the device grant (`conversation`, which
    // carries `awaitingSignature`) and whether this computer is online (`worker`).
    // 中文说明：右栏「任务」面板。签字只在确认框里点「签字」之后发出；同一次确认的重试沿用同一个请求号，新的确认才换新号。
    // 签的叶与 Console 的「Sign these criteria」默认所签相同：这个目标下所有能签作标准（eligible）的叶，按提案顺序，已签的也在内，
    // 所以再次签字不会悄悄丢掉已签的叶（PSC：再次签字取代上一份）。
    const LEVEL = { ok: GREEN, info: GREY, warn: AMBER, error: RED };
    const timeOf = (value) => { const at = new Date(value); return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    const block = (title, extra, body) => h("div", { style: { marginBottom: 14 } },
      h("div", { style: { ...section, display: "flex", justifyContent: "space-between" } }, h("span", null, title), extra ? h("span", { style: { textTransform: "none" } }, extra) : null), body);
    // A value of a map by a key that came from outside (a service answer): own keys only, so "constructor" is no word.
    const own = (map, key) => (typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
    const list = (value) => (Array.isArray(value) ? value : []);
    const words = (value) => (typeof value === "string" ? value.trim() : "");

    // The owner-facing texts of signing (the Chinese rendering of Console Text A, PSC 0.2.28), verbatim.
    const SIGN = {
      title: "待你签字的验收标准", button: "签下这些标准",
      body: "你要把这些标准签为这个目标的验收。它们由智能体提出；签下之后，智能体不能再结束或修改它们，只有在当前状态下每一条都成立，这个目标才算完成。这是你以自己账户做出的决定。",
      accept: "签字", cancel: "先不签", signed: "已签字。", pending: "签字结果还没有确认，稍后会自动刷新。",
      unreadable: "暂时读不到待签字的标准",
    };
    const SIGN_REASONS = {
      unknown_goal: "找不到这个目标", goal_ended: "这个目标已经结束", goal_paused: "这个目标已暂停",
      contract_fixed: "这个目标的验收由能力合同规定，不用签字", leaf_not_proposed: "这些标准已经变了，请看最新的再签",
      criterion_unsupported: "其中有一条不能作为验收标准", goal_pending_obligations: "这个目标还有没办完的事，稍后再签",
    };
    const signReason = (code) => own(SIGN_REASONS, code) || "原因未知，请稍后再试";
    const signRefused = (code) => ({ state: "refused", errorCode: typeof code === "string" ? code : "", text: "没有签下任何标准：" + signReason(code) + "。" });
    /**
     * What one answer of the sign route means. The Gateway answers as Console's control does: `complete` with the Kernel's
     * `result` (`accepted:true` signed; `accepted:false` with its `errorCode` refused, nothing signed), or `pending` (202:
     * send the same request id again). A refusal of the request itself is `ok:false` with its code. `null` is a request that
     * got no answer (the network failed after it was sent), and `signature_unconfirmed` the host's word for the same thing
     * further along (the manager, a 5xx or an answer that is not this request's): both pending, never a refusal, because
     * the criteria may have been signed. Pure.
     */
    function signOutcome(reply) {
      if (!reply) return { state: "pending", text: SIGN.pending };
      if (reply.ok === false) return reply.errorCode === "signature_unconfirmed" ? { state: "pending", text: SIGN.pending } : signRefused(reply.errorCode);
      if (reply.state !== "complete") return { state: "pending", text: SIGN.pending };
      // A complete control record is the Kernel's answer to this request: `answered`.
      const result = reply.result && typeof reply.result === "object" ? reply.result : {};
      return result.accepted === true ? { state: "signed", text: SIGN.signed, answered: true } : { ...signRefused(result.errorCode), answered: true };
    }
    /**
     * Sign these leaves of `goal` once the person confirmed it: one request id for this confirmation, sent again with the
     * same id while the answer is pending (202) or did not arrive, at most `tries` times. Returns the last outcome
     * (signOutcome). Once an attempt of this request went unconfirmed (`unconfirmed`: an earlier run of it already did),
     * only the Kernel's answer can say it was refused: a later attempt refused before it reached the Kernel (the manager not
     * reached, signing out, another control pending, …) leaves the first one possibly completing, so it stays pending.
     * Pure apart from its arguments: exported for the harness tests.
     */
    async function signAcceptanceFlow({ api, sessionId, goal, leaves, requestId, wait = sleep, report = () => {}, tries = 5, unconfirmed = false }) {
      const body = { session: sessionId, goal, leaves: leaves.slice(), requestId };
      for (let attempt = 1; ; attempt++) {
        let reply = null;
        try { reply = await api("conversation/sign-acceptance", body); } catch { reply = null; }
        let outcome = signOutcome(reply);
        if (outcome.state === "refused" && unconfirmed && !outcome.answered) outcome = { state: "pending", text: SIGN.pending };
        if (outcome.state === "pending") unconfirmed = true;
        if (outcome.state !== "pending" || attempt >= tries) return outcome;
        report(outcome);
        await wait(1500 * attempt);
      }
    }
    // Signatures whose outcome is not confirmed, by conversation and goal: { requestId, toSign, leaves } as the person
    // confirmed them. Confirming the same goal again resends exactly that request (its id and the leaves it froze) until the
    // Kernel answers it or a state read shows it settled; a new id could not be the same decision (Console does the same).
    const unconfirmedSignatures = new Map();
    const signatureKey = (sessionId, goal) => sessionId + "\n" + goal;
    /** Forget the unconfirmed signatures a definite state read shows settled: their leaves signed, or the goal gone. */
    function settleUnconfirmed(sessionId, conversation) {
      const c = conversation && conversation.ok && conversation.found === true ? conversation.conversation : null;
      if (!c || !Array.isArray(c.awaitingSignature)) return;
      for (const [key, frozen] of [...unconfirmedSignatures]) {
        if (!key.startsWith(sessionId + "\n")) continue;
        const entry = c.awaitingSignature.find((row) => row && row.goal === frozen.goal);
        const signed = entry && Array.isArray(entry.leaves)
          && frozen.toSign.every((node) => entry.leaves.some((leaf) => leaf && leaf.node === node && leaf.signed === true));
        if (!entry || signed) unconfirmedSignatures.delete(key);
      }
    }
    /**
     * A criterion as small text: the Gateway gives the leaf's desired atoms as Console shows them (their JSON text), read
     * here as `predicate(name: value, …)`, with a long digest shortened; any other text is shown as it is, on one line. Pure.
     */
    function criterionText(value) {
      const text = words(value);
      let atoms;
      try { atoms = JSON.parse(text); } catch { return text.replace(/\s+/g, " "); }
      if (!Array.isArray(atoms) || !atoms.every((atom) => atom && typeof atom.predicate === "string")) return text.replace(/\s+/g, " ");
      const shown = (v) => String(v).replace(/(sha256:)?([0-9a-f]{64})/g, (_m, prefix, hex) => (prefix || "") + hex.slice(0, 8) + "…");
      return atoms.map((atom) => (atom.negated === true ? "not " : "") + atom.predicate + "("
        + Object.entries(atom.args && typeof atom.args === "object" ? atom.args : {}).map(([name, v]) => name + ": " + shown(v)).join(", ") + ")").join("；");
    }

    // An operation of this conversation in plain words (design §2 操作): what it did, then how it ended. The strip's label
    // names only the tool and the Action; a file's name and a test's pass come from its result while the strip carries it.
    const ON_FILE = { read: "读取", read_image: "读取", write_file: "写入", patch_file: "修改" };
    // "Execute worker_<connection>_eng_write_file_1 → goal-3" reads as write_file.
    const actionOf = (label) => {
      const m = /^Execute\s+(\S+)/.exec(String(label || ""));
      return m ? m[1].replace(/^worker_[a-z0-9]+_/, "").replace(/_\d+$/, "").replace(/_[0-9a-f]{12}$/, "").replace(/^eng[._]/, "").replace(/_v\d+$/, "") : "";
    };
    /** The first value under `key` in a result (its JSON text parts read as JSON), a few levels deep. Pure. */
    function fieldOf(value, key, depth = 12) {
      if (depth < 0 || value === null || value === undefined) return undefined;
      if (typeof value === "string") {
        if (value.length > 200000 || !/^\s*[{[]/.test(value)) return undefined;
        try { return fieldOf(JSON.parse(value), key, depth - 1); } catch { return undefined; }
      }
      if (typeof value !== "object") return undefined;
      if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key) && value[key] !== null && typeof value[key] !== "object") return value[key];
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const found = fieldOf(child, key, depth - 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const fileOf = (result) => { const p = fieldOf(result, "path"); return typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() || "" : ""; };
    // Refusal reasons the platform states in fixed sentences or codes (agent-interaction-spec §3.4, §5.2), in plain words.
    const REFUSAL_WORDS = [
      [/source_revoked|withdrew this grant/i, "项目授权已收回"],
      [/worker_offline|execution environment for this Action is offline/i, "这台电脑不在线"],
      [/A person refused this call/i, "你拒绝了这次操作"],
      [/board_sealed|This Board is retired/i, "这个会话已删除"],
      [/goal_paused|Every goal it works for is paused/i, "任务已暂停"],
      [/goal_ended|Every goal it works for has ended/i, "任务已结束"],
      [/needs_setup|Not enabled for this Agent/i, "这个操作还没有开启"],
      [/law_lock|Locked with this Board's rules/i, "规则已上锁"],
      [/governance_pending|configuration is being applied/i, "智能体的设置正在生效"],
      [/board_draining|Writes are paused/i, "现在暂停写入"],
      [/A rule of the installed program blocks it|did not occur/i, "现在的条件不允许"],
    ];
    const refusalWords = (op) => {
      const said = [op.reason, op.summary, fieldOf(op.result, "errorCode")].filter((value) => typeof value === "string").join(" ");
      const hit = REFUSAL_WORDS.find(([pattern]) => pattern.test(said));
      return hit ? hit[1] : "";
    };
    /** One strip entry as one line: { text, detail, tone }. Never a tool id, state code or reason code. Pure. */
    function operationLine(op) {
      const o = op && typeof op === "object" ? op : {};
      const label = String(o.label || ""), tool = String(o.tool || "");
      let verb, action = "";
      if (tool === "Execute" || /^Execute\s/.test(label)) {
        action = actionOf(label);
        const file = own(ON_FILE, action) ? fileOf(o.result) : "";
        verb = file ? ON_FILE[action] + " " + file : own(TOOL_WORDS, action) || "执行一个操作";
      } else if (tool === "Set" || /^Set\b/.test(label)) {
        const summary = String(o.summary || "");
        verb = /\bend_goal\b/.test(label) ? "结束任务" : /^declared goal\b/.test(summary) ? "开始任务"
          : /^completed\b/.test(summary) ? "任务完成（验收通过）" : "记下依据";
      } else verb = tool === "Get" ? "读取结果" : "执行一个操作";
      switch (o.state) {
        case "done": {
          const exit = action === "test" || action === "acceptance" ? fieldOf(o.result, "exit_code") : undefined;
          if (typeof exit === "number") return { text: verb + (exit === 0 ? "：通过" : "：没有通过"), tone: exit === 0 ? "ok" : "warn" };
          return { text: verb, tone: "ok" };
        }
        case "failed": return { text: verb + "：失败", tone: "warn" };
        case "refused": { const why = o.contentWithheld ? "" : refusalWords(o);
          return why ? { text: "被拒绝：" + why, detail: verb, tone: "warn" } : { text: verb + "：被拒绝", tone: "warn" }; }
        case "unknown": return { text: verb + "：结果未知，请在 Console 核对", tone: "error" };
        case "running": return { text: verb + (o.stage === "at_worker" ? "：正在这台电脑上执行" : "：进行中"), tone: "info" };
        case "waiting_for_decision": return { text: verb + "：等你决定", tone: "warn" };
        case "needs_person": return { text: verb + "：需要你在 Console 核对", tone: "error" };
        default: return { text: verb, tone: "info" };
      }
    }

    const GOAL_WORDS = { running: "进行中", paused: "已暂停", completed: "已完成", ended: "已结束" };
    /** A task's status in words: an ended task as it ended, else what it waits for, else running or paused. Pure. */
    function taskStatusText(row, awaitsSignature) {
      if (row.status === "completed" || row.status === "ended") return GOAL_WORDS[row.status];
      if (awaitsSignature || row.awaiting === "acceptance") return "等你签字";
      if (row.awaiting === "decision") return "等你决定";
      return own(GOAL_WORDS, row.status) || "状态未读到";
    }
    const NO_BOARD = "这个会话还没有开始任务。说出你要做的事，开始后这里显示任务、验收标准和最近操作。";
    /**
     * Whether each criterion holds, as this conversation's results showed it, kept while the panel is mounted (each kind of
     * result shows different parts: a goal read has its signed leaves with `met`, a nodes read every goal node with
     * `satisfied`). `holds`: node -> boolean; `signed`: goal -> its signed leaves from a goal read (a capability goal's
     * criteria, which are its contract's, appear only there). Updated by rememberView.
     */
    const panelMemory = () => ({ seenAt: null, holds: new Map(), signed: new Map() });
    function rememberView(memory, board) {
      const view = board && board.view;
      if (!view || typeof view !== "object" || board.seenAt === memory.seenAt) return memory;
      memory.seenAt = board.seenAt;
      for (const row of list(view.goalNodes))
        if (row && typeof row.nodeId === "string" && typeof row.satisfied === "boolean") memory.holds.set(row.nodeId, row.satisfied);
      for (const row of list(view.taskStatus)) {
        if (!row || typeof row.goal !== "string" || !Array.isArray(row.leaves)) continue;
        // A leaf's `goal` is its label (the node id when it has none); `test` is the criterion as the Board shows it.
        memory.signed.set(row.goal, row.leaves.filter((leaf) => leaf && typeof leaf.node === "string").map((leaf) => ({ node: leaf.node,
          label: words(leaf.goal) && leaf.goal !== leaf.node ? words(leaf.goal) : "", criterion: words(leaf.test) })));
        for (const leaf of row.leaves) if (leaf && typeof leaf.node === "string" && typeof leaf.met === "boolean") memory.holds.set(leaf.node, leaf.met);
      }
      return memory;
    }
    /**
     * The goals of `awaitingSignature` as the panel uses them (each goal whose proposed criteria Console shows): its leaves
     * with `signed` and `eligible`, `toSign` (what 签下这些标准 sends: every eligible leaf, in the proposal's order, already
     * signed ones included, as Console's Sign these criteria sends by default), `awaits` (whether it waits for the person:
     * a criterion they can sign that is not signed yet, or, where the goal cannot take a signature now, any unsigned one,
     * so that they see why) and `refusal` (why nothing can be sent now, or ""). Pure.
     */
    function awaitingEntries(value) {
      return list(value).filter((entry) => entry && words(entry.goal) && Array.isArray(entry.leaves)).map((entry) => {
        // As Console marks them: a leaf the Kernel does not take as a criterion, and a signed one that signing again would
        // replace — only while the goal can take a signature at all (otherwise no leaf is eligible, and the reason is the goal's).
        const leaves = entry.leaves.filter((leaf) => leaf && words(leaf.node)).map((leaf) => ({ node: leaf.node, label: words(leaf.label),
          criterion: criterionText(leaf.criterion), signed: leaf.signed === true, eligible: leaf.eligible === true,
          note: entry.signable !== true || leaf.eligible === true ? "" : leaf.signed === true ? "签字后会被替换" : "不能作为验收标准" }));
        const toSign = entry.signable === true ? leaves.filter((leaf) => leaf.eligible).map((leaf) => leaf.node) : [];
        // A list shortened by the service cannot be signed from here: signing it would replace leaves this page never saw.
        const refusal = entry.signable !== true ? "这些标准现在不能签：" + signReason(entry.refusal) + "。"
          : entry.leavesTruncated === true ? "这个目标的标准太多，这里只列出一部分；请在 Console 里签字。" : "";
        return { goal: entry.goal, label: words(entry.label) && entry.label !== entry.goal ? words(entry.label) : "（没有名字的任务）",
          leaves, toSign: refusal ? [] : toSign, refusal, signable: entry.signable === true,
          awaits: entry.signable === true ? leaves.some((leaf) => leaf.eligible && !leaf.signed) : leaves.some((leaf) => !leaf.signed) };
      });
    }
    /**
     * The panel's content from what it read (see above). `kind: "message"` is one sentence instead of the panel (reading,
     * unreadable, not set up, no Board yet); `kind: "panel"` has every section. Pure apart from updating `memory`.
     */
    function taskPanelModel({ board, conversation, worker, health, memory = panelMemory() }) {
      if (!board) return { kind: "message", text: "正在读取…" };
      if (!board.ok) return { kind: "message", text: board.teaching || "读不到 Rulith", tone: "warn" };
      if (!board.available) return { kind: "message", text: "还没有接入 Rulith：先登录，再在左侧为智能体「在本机设置」。" };
      const view = board.view && typeof board.view === "object" ? board.view : null;
      const conv = conversation && conversation.ok ? conversation : null;
      const found = !!(conv && conv.found === true && conv.conversation && typeof conv.conversation === "object");
      // A failed state read (the service unavailable, the manager down, signed out, …) says nothing about the conversation:
      // never "no Board yet" and never "no criteria", only that it cannot be read now. Only found:false means no Board.
      const readFailed = !!(conversation && conversation.ok !== true);
      if (!view && !found && !readFailed) return conv && conv.found === false ? { kind: "message", text: NO_BOARD } : { kind: "message", text: "正在读取…" };
      rememberView(memory, board);
      const link = (value) => (typeof value === "string" && /^https?:\/\//.test(value) ? value : "");
      const directory = view && view.goals && Array.isArray(view.goals.directory)
        ? view.goals.directory.filter((row) => row && words(row.goal)) : [];
      // `awaitingSignature` is null when the service cannot tell now, and absent from a service that does not report it;
      // either, like a failed read, is 「暂时读不到」: nothing is claimed either way.
      const raw = found ? conv.conversation.awaitingSignature : undefined;
      const entries = awaitingEntries(raw);
      const awaiting = entries.filter((entry) => entry.awaits);
      const awaitingUnknown = readFailed || (found && !Array.isArray(raw));
      const awaitsSignature = new Set(awaiting.map((entry) => entry.goal));
      const open = (row) => row.status !== "completed" && row.status !== "ended";
      // A goal waiting for the person's acceptance with nothing proposed to sign here is accepted in Console.
      const inConsole = (row) => open(row) && row.awaiting === "acceptance" && Array.isArray(raw) && !awaitsSignature.has(row.goal);
      const tasks = [...directory.filter(open), ...directory.filter((row) => !open(row))].map((row) => ({ goal: row.goal,
        label: words(row.label) && row.label !== row.goal ? words(row.label) : "（没有名字的任务）",
        status: taskStatusText(row, awaitsSignature.has(row.goal)), fixed: !!row.type,
        console: inConsole(row) ? link(board.casesUrl) || "-" : "" }));
      for (const entry of entries) if (!tasks.some((task) => task.goal === entry.goal))
        tasks.unshift({ goal: entry.goal, label: entry.label, status: entry.awaits ? "等你签字" : "进行中", fixed: false, console: "" });
      const criteria = [];
      for (const task of tasks) {
        const entry = entries.find((e) => e.goal === task.goal);
        const rows = (entry ? entry.leaves : (memory.signed.get(task.goal) || []).map((leaf) => ({ ...leaf, signed: true, eligible: true })))
          .map((leaf) => ({ node: leaf.node, label: leaf.label || "一条验收标准", criterion: leaf.criterion,
            signed: leaf.signed ? (task.fixed ? "由能力合同规定" : "已签字")
              : leaf.note || "未签字",
            holds: memory.holds.has(leaf.node) ? memory.holds.get(leaf.node) : null }));
        if (rows.length) criteria.push({ goal: task.goal, label: task.label, rows });
      }
      const strip = list(board.recent).length ? list(board.recent) : list(board.operations);
      const operations = strip.slice(0, 8).map((op) => ({ ...operationLine(op), at: timeOf(op && (op.since || op.at)) }));
      // An operation that waits for a person: one sentence and the Console page where it is handled.
      const waiting = strip.find((op) => op && (op.state === "waiting_for_decision" || op.state === "needs_person"));
      const deciding = waiting || directory.find((row) => row.awaiting === "decision");
      // The Agent's own pending call, from the manager's Health read: it is there after a restart too, before this
      // conversation's next result (it may be another conversation's of this Agent, so the sentence names the Agent).
      const pending = health && health.ok && health.available && health.pendingCall && health.pendingCall.needsPerson === true ? health.pendingCall : null;
      const decision = deciding ? { text: waiting && waiting.state === "needs_person" ? "有一次操作的结果需要你在 Console 核对。"
        : "有一次操作在等你决定。", url: link(board.consoleUrl) || link(health && health.consoleUrl) }
        : pending ? { text: pending.phase === "waiting" ? "这个智能体有一次操作在等你决定。" : "这个智能体有一次操作的结果需要你在 Console 核对。",
          url: link(health.consoleUrl) || link(board.consoleUrl) } : null;
      // 在线／离线 when the Worker's state was read; 读不到 when it could not be (P3), never 离线 for that.
      const computer = { name: worker && worker.ok && typeof worker.computer === "string" ? worker.computer : "",
        state: !worker ? "reading" : !worker.ok ? "unread" : !worker.available ? "offline" : worker.state === "online" ? "online"
          : worker.state === "unknown" || typeof worker.state !== "string" ? "unread" : "offline" };
      return { kind: "panel", agentName: words(board.agentName), awaiting, awaitingUnknown,
        awaitingTruncated: found && conv.conversation.awaitingSignatureTruncated === true, decision, tasks, tasksUnread: !view,
        tasksReading: !conversation, criteria, operations, computer };
    }

    /** Signing from the panel: the confirmation (in the overlay), then the request; at most one signing at a time. */
    function useSigning(sessionId, afterwards) {
      const [busy, setBusy] = useState("");      // the goal being signed
      const [note, setNote] = useState(null);    // { goal, label, state, text }
      const sign = async (asked) => {
        const key = signatureKey(asked.sessionId, asked.goal);
        // One request id per confirmation, its retries reuse it; a goal with an unconfirmed signature reuses that one.
        const requestId = asked.requestId || newRequestId();
        const report = (outcome) => setNote({ goal: asked.goal, label: asked.label, ...outcome });
        const remember = () => unconfirmedSignatures.set(key, { goal: asked.goal, label: asked.label, requestId, toSign: asked.toSign, leaves: asked.leaves });
        setBusy(asked.goal); report({ state: "pending", text: "正在签字…" });
        try {
          const outcome = await signAcceptanceFlow({ api, sessionId: asked.sessionId, goal: asked.goal, leaves: asked.toSign, requestId,
            unconfirmed: !!asked.requestId, report: (o) => { remember(); report(o); } });
          if (outcome.state === "pending") remember(); else unconfirmedSignatures.delete(key);
          report(outcome);
        } finally { setBusy(""); afterwards(); }
      };
      // Only the dialog's 签字 signs, once: a second click of the same dialog does nothing. What is sent is what the dialog
      // showed, frozen when it opened; for a goal whose signature is not confirmed, the request confirmed before.
      const ask = (entry) => {
        if (busy) return;
        const frozen = unconfirmedSignatures.get(signatureKey(sessionId, entry.goal));
        if (!frozen && !entry.toSign.length) return;
        const asked = frozen ? { sessionId, goal: frozen.goal, label: frozen.label, requestId: frozen.requestId, toSign: frozen.toSign.slice(),
          leaves: frozen.leaves.map((leaf) => ({ ...leaf })) }
          : { sessionId, goal: entry.goal, label: entry.label, toSign: entry.toSign.slice(), leaves: entry.leaves.map((leaf) => ({ ...leaf })) };
        let answered = false;
        signView.set({ ...asked, answer: (yes) => {
          if (answered) return;
          answered = true; signView.set(null);
          if (yes === true) sign(asked);
        } });
      };
      return { busy, note, ask };
    }
    // One proposed criterion: its label, the criterion in small text, and whether it is signed, cannot be signed, or would
    // be replaced by this signature (a signed leaf that is no longer eligible; Console's Will be replaced).
    const leafRow = (leaf) => h("div", { key: leaf.node, "data-rulith-leaf": leaf.node, style: { padding: "2px 0" } },
      h("div", { style: { display: "flex", gap: 6, alignItems: "baseline" } },
        h("span", { style: { flex: 1, wordBreak: "break-word" } }, leaf.label || "一条验收标准"),
        leaf.signed ? h("span", { style: { ...small, flex: "none" }, "data-rulith-leaf-signed": "" }, "已签") : null,
        leaf.note ? h("span", { style: { ...small, flex: "none" }, "data-rulith-leaf-ineligible": "" }, leaf.note) : null),
      leaf.criterion ? h("div", { style: { ...small, wordBreak: "break-all" } }, leaf.criterion) : null);
    /** The signing confirmation (PSC 0.2.28, Console Text A in Chinese): only its 签字 sends anything. */
    function SignDialog() {
      const asking = useStore(signView);
      if (!asking) return null;
      return backdrop(2100, () => asking.answer(false),
        h("div", { role: "dialog", "aria-modal": "true", "data-rulith-sign-dialog": asking.goal, onClick: (event) => event.stopPropagation(), style: card(480) },
          h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8, wordBreak: "break-word" } }, asking.label),
          h("div", { style: { marginBottom: 10 } }, asking.leaves.map(leafRow)),
          h("div", null, SIGN.body),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
            h("button", { type: "button", style: button, "data-rulith-sign-cancel": "", onClick: () => asking.answer(false) }, SIGN.cancel),
            h("button", { type: "button", style: primary, "data-rulith-sign-confirm": "", onClick: () => asking.answer(true) }, SIGN.accept))));
    }

    function RulithColumn({ mountedSession }) {
      // The sidebar's mounted store identifies the conversation this pane belongs to.
      const sessionId = React.useSyncExternalStore(
        (notify) => mountedSession.subscribe(notify), () => mountedSession.getSnapshot());
      // Remount on a session change so its cached view and pending polls cannot leak into the next pane.
      return sessionId === undefined ? null : h(RulithSessionColumn, { key: sessionId, sessionId });
    }
    function RulithSessionColumn({ sessionId }) {
      const q = encodeURIComponent(sessionId);
      // The host's cached results of this conversation; this route never sends a Board read.
      const [board, refreshBoard] = usePoll("board?session=" + q, 6000);
      const [conversation, refreshConversation] = usePoll("conversation?session=" + q, 6000);
      const [worker, refreshWorker] = usePoll("worker?session=" + q, 15000);
      const [health] = usePoll("health?session=" + q, 60000);
      const memory = React.useRef(null);
      if (!memory.current) memory.current = panelMemory();
      const signing = useSigning(sessionId, refreshConversation);
      settleUnconfirmed(sessionId, conversation);
      const model = taskPanelModel({ board, conversation, worker, health, memory: memory.current });
      const frame = (...children) => h("div", { "data-rulith-task-panel": sessionId, style: { padding: 12, fontSize: 13, overflow: "auto", height: "100%", boxSizing: "border-box" } }, ...children);
      if (model.kind === "message") return frame(h("div", { "data-rulith-panel-message": "", style: { color: model.tone === "warn" ? AMBER : "inherit" } }, model.text));
      const reload = () => { refreshBoard(); refreshConversation(); refreshWorker(); };
      const note = signing.note;
      const noteColor = note && (note.state === "signed" ? GREEN : note.state === "refused" ? RED : AMBER);
      const holdsWord = (holds) => (holds === true ? h("span", { style: { color: GREEN } }, "成立") : holds === false ? h("span", { style: { color: AMBER } }, "未成立")
        : h("span", { style: small }, "还没读到是否成立"));
      return frame(
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
          h("span", { style: small }, model.agentName ? "智能体：" + model.agentName : ""),
          h("button", { type: "button", style: { ...button, padding: "1px 8px", fontSize: 11 }, onClick: reload }, "刷新")),
        // Proposed criteria not signed yet: their card goes first.
        model.awaiting.map((entry) => h("div", { key: entry.goal, "data-rulith-awaiting-signature": entry.goal,
            style: { marginBottom: 14, padding: "8px 10px", border: "1px solid " + AMBER, borderRadius: 8 } },
          h("div", { style: { ...section, marginTop: 0 } }, SIGN.title),
          h("div", { style: { fontWeight: 600, marginBottom: 4, wordBreak: "break-word" } }, entry.label),
          entry.leaves.map(leafRow),
          entry.refusal ? h("div", { role: "status", "data-rulith-sign-unavailable": "", style: { ...small, marginTop: 6, opacity: 1, color: AMBER } }, entry.refusal)
            : h("div", { style: { marginTop: 8 } }, h("button", { type: "button", style: primary, "data-rulith-sign": entry.goal,
              disabled: !!signing.busy, onClick: () => signing.ask(entry) }, signing.busy === entry.goal ? "正在签字…" : SIGN.button)))),
        model.awaitingTruncated ? h("div", { style: { ...small, marginBottom: 10 } }, "还有等签字的任务没有列在这里：请在 Console 里查看。") : null,
        model.awaitingUnknown ? h("div", { "data-rulith-awaiting-unknown": "", style: { ...small, marginBottom: 10 } }, SIGN.unreadable) : null,
        note ? h("div", { role: note.state === "refused" ? "alert" : "status", "data-rulith-sign-note": note.state,
          style: { marginBottom: 12, color: noteColor, fontSize: 12, wordBreak: "break-word" } }, note.text) : null,
        model.decision ? h("div", { role: "alert", "data-rulith-decision": "", style: { marginBottom: 12, fontSize: 12, color: AMBER } },
          model.decision.text + " ",
          model.decision.url ? h("a", { href: model.decision.url, target: "_blank", rel: "noopener noreferrer" }, "去 Console 处理")
            : h("span", null, "请在 Console 里处理。")) : null,
        block("任务", "", model.tasksUnread && !model.tasks.length ? none(model.awaitingUnknown && !model.tasksReading ? "暂时读不到这个会话的任务：这个会话的下一个结果到来后，这里显示它。"
          : "这个会话的下一个结果到来后，这里显示它的任务。")
          : model.tasks.length ? h("div", null, model.tasks.slice(0, 6).map((task) => h("div", { key: task.goal, "data-rulith-task": task.goal,
              style: { display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" } },
            h("span", { style: { flex: 1, wordBreak: "break-word" } }, task.label), h("span", { style: { ...small, flex: "none" } }, task.status),
            task.console ? (task.console === "-" ? h("span", { style: { ...small, flex: "none" } }, "在 Console 里验收")
              : h("a", { href: task.console, target: "_blank", rel: "noopener noreferrer", style: { flex: "none", fontSize: 12 } }, "去 Console 处理")) : null)))
          : none("还没有任务：说出你要做的事，开始后这里显示它。")),
        block("验收标准与状态", "", model.criteria.length ? h("div", null, model.criteria.map((group) => h("div", { key: group.goal, style: { marginBottom: 6 } },
            model.criteria.length > 1 ? h("div", { style: { ...small, marginBottom: 2 } }, group.label) : null,
            group.rows.map((row) => h("div", { key: row.node, "data-rulith-criterion": row.node, style: { padding: "2px 0" } },
              h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
                h("span", { style: { flex: 1, wordBreak: "break-word" } }, row.label),
                h("span", { style: { flex: "none", fontSize: 12 } }, holdsWord(row.holds), h("span", { style: small }, " · " + row.signed))),
              row.criterion ? h("div", { style: { ...small, wordBreak: "break-all" } }, row.criterion) : null)))))
          : none(model.awaitingUnknown ? "读到后，这里显示验收标准。" : model.tasksReading ? "正在读取…" : "还没有验收标准。")),
        block("最近操作", model.operations.length ? String(model.operations.length) : "", model.operations.length
          ? h("div", null, model.operations.map((line, i) => h("div", { key: i, "data-rulith-operation": "", style: { display: "flex", gap: 6, alignItems: "baseline", padding: "2px 0", fontSize: 12 } },
            dot(LEVEL[line.tone] || GREY),
            h("span", { style: { flex: 1, wordBreak: "break-word" } }, line.text, line.detail ? h("span", { style: small }, "（" + line.detail + "）") : null),
            line.at ? h("span", { style: { ...small, flex: "none" } }, line.at) : null)))
          : none("还没有操作。")),
        block("这台电脑", "", h("div", { "data-rulith-computer": model.computer.state, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
          dot(model.computer.state === "online" ? GREEN : model.computer.state === "offline" ? AMBER : GREY),
          h("span", { style: { flex: 1 } }, (model.computer.name ? model.computer.name + " · " : "")
            + { reading: "正在读取…", unread: "读不到", online: "在线", offline: "离线" }[model.computer.state]),
          model.computer.state === "offline" ? h("button", { type: "button", style: linkButton, onClick: () => openSettings("computer") }, "在设置里查看") : null)));
    }

    // ---- The composer row (design §3.2 会话的输入行): exactly two chips, 档位 and 模型, and 审查 only when the Agent has a
    // reviewer designated. The browser only sees what the launcher's conversationView picks out; a switch travels
    // manager -> device grant -> Gateway (PSC 0.2.16 ③, 0.2.20, 0.2.27 ①).
    // Exploration tiers, narrow to wide (TOOL-08b/08c), and the Console's approved confirmation texts for widening.
    const MODE_ORDER = ["strict", "derived", "non_strict"];
    const MODE_WORDS = { strict: "严格", derived: "推导", non_strict: "非严格" };
    const MODE_HINTS = { strict: "写入和运行要先有可信的依据", derived: "能从记下的事实推出理由，就可以写入和运行",
      non_strict: "模型给出的命令和参数直接执行；完成仍要你签字验收" };
    const WIDEN_TEXT = {
      non_strict: { title: "Switch to non-strict exploration mode?", accept: "Switch to non-strict", cancel: "Keep strict",
        body: "Write and run actions of this environment's tools will accept inputs the model supplies, even when no trusted fact on the Board backs them. Each such call is marked \"Inputs not grounded\". Calls that need your decision never run without it, writes stay inside the locations you authorized, and tools you have not locked stay unavailable. You can switch back at any time." },
      derived: { title: "Switch to derived exploration mode?", accept: "Switch to derived", cancel: "Keep strict",
        body: "The model will be able to write and run in this environment's workspace whenever it can derive, from facts and rules it writes on the Board, a warrant for that action and its key inputs. Those facts do not have to be trusted evidence. Calls that need your decision never run without it, and writes stay inside the local workspace." },
    };
    /**
     * The one tier a conversation shows (PSC 0.2.27 ①): the strictest of what the Gateway reports — its `explorationMode`,
     * and every per-Connection value an older Gateway sends — never a wider one; `mixed` when they differ. An unknown value
     * makes the tier unreadable rather than guessed. Pure.
     */
    function conversationTier(conversation) {
      const c = conversation || {};
      const perConnection = c.explorationModes && typeof c.explorationModes === "object" ? Object.values(c.explorationModes) : [];
      const all = [...(typeof c.explorationMode === "string" ? [c.explorationMode] : []), ...perConnection];
      const mixed = c.explorationModesMixed === true || new Set(perConnection).size > 1;
      if (!all.length || all.some((mode) => !MODE_ORDER.includes(mode))) return { mode: undefined, mixed };
      return { mode: all.reduce((a, b) => (MODE_ORDER.indexOf(b) < MODE_ORDER.indexOf(a) ? b : a)), mixed };
    }
    function useConversationSettings(sessionId) {
      const [settings, refresh] = usePoll("conversation?session=" + encodeURIComponent(sessionId), 6000);
      const [note, setNote] = useState("");
      // One request per conversation: the Gateway applies the tier to every Connection of its Board.
      const applyMode = async (mode) => {
        setNote("");
        try {
          const reply = await api("conversation/exploration-mode", { session: sessionId, mode });
          // The outcome is `result.accepted`; a pending switch (202) says why it waits.
          if (!reply.ok) setNote(reply.teaching || "没有切换");
          else if (reply.state !== "complete") setNote("已受理，还没有生效" + (reply.teaching ? "：" + reply.teaching : ""));
          else if (reply.result && reply.result.accepted === false)
            setNote(reply.result.teaching || "这次切换没有被接受" + (reply.result.errorCode ? "（" + reply.result.errorCode + "）" : ""));
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
    const menu = { position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 240, maxWidth: 380, padding: 6, borderRadius: 8, zIndex: 20,
      background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #1e1e1e))", color: "var(--dsw-alias-label-primary, inherit)", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", boxShadow: "0 6px 24px rgba(0,0,0,.35)", fontSize: 12 };
    const item = { display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: 6, border: "none", background: "transparent",
      color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 };
    function RulithComposerControls({ sessionId }) {
      const { settings, note, setNote, applyMode, applyReview } = useConversationSettings(sessionId);
      const [model] = usePoll("model?session=" + encodeURIComponent(sessionId), 30000);
      const [open, setOpen] = useState(null);           // null | "tier" | "review"
      const [confirming, setConfirming] = useState(null); // the wider tier awaiting the approved confirmation
      useEffect(() => { setOpen(null); setConfirming(null); setNote(""); }, [sessionId]);
      // Nothing to show until the launcher can read this conversation. Without a Board yet (no Rulith call so far) the
      // tier reads "默认": the first choice opens the Board with the Agent's defaults and then applies.
      if (!settings || !settings.ok) return null;
      // A deleted conversation cannot go on: no tier, model or review to set (its deletion may still be finishing).
      if (settings.conversation && settings.conversation.endedAt)
        return h("span", { "data-rulith-composer": sessionId, "data-rulith-ended": "", style: { ...small, marginLeft: 4 } }, "这个会话已删除，不能再继续");
      const fresh = settings.found === false;
      const tier = fresh ? { mode: undefined, mixed: false } : conversationTier(settings.conversation);
      const close = () => { setOpen(null); setConfirming(null); };
      const choose = (next) => {
        // Narrowing applies at once; widening first shows the approved confirmation (a fresh conversation counts from strict).
        if (MODE_ORDER.indexOf(next) > MODE_ORDER.indexOf(fresh ? "strict" : tier.mode)) { setConfirming(next); return; }
        close(); applyMode(next);
      };
      const tierLabel = "档位：" + (fresh ? "默认" : tier.mode ? MODE_WORDS[tier.mode] + (tier.mixed ? "（各连接不一致）" : "") : "读不准");
      const tierChip = h("span", { key: "tier", style: { position: "relative", display: "inline-flex" }, "data-rulith-tier": fresh ? "default" : tier.mode || "unknown" },
        h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === "tier", title: "这个会话的档位（只改这个会话）",
          onClick: () => { setConfirming(null); setOpen(open === "tier" ? null : "tier"); } }, tierLabel, h("span", { style: { opacity: 0.6 } }, "▾")),
        open === "tier" ? h("div", { role: "menu", style: menu },
          confirming
            ? h("div", { role: "dialog" },
              h("div", { style: { fontWeight: 600, marginBottom: 4 } }, WIDEN_TEXT[confirming].title),
              h("div", { style: { opacity: 0.8, marginBottom: 8 } }, WIDEN_TEXT[confirming].body),
              h("div", { style: { display: "flex", gap: 6 } },
                h("button", { type: "button", style: { ...chip }, onClick: () => { const mode = confirming; close(); applyMode(mode); } }, WIDEN_TEXT[confirming].accept),
                h("button", { type: "button", style: { ...chip }, onClick: () => setConfirming(null) }, WIDEN_TEXT[confirming].cancel)))
            : h("div", null,
              h("div", { style: { ...small, padding: "2px 8px 4px" } }, fresh ? "这个会话还没有用过 Rulith：选一档就生效，默认取智能体的档位；放宽先确认"
                : tier.mixed ? "各连接不一致：显示的是其中最严的一档，再选一次即统一" : "这个会话的档位 · 收窄立即生效，放宽先确认"),
              MODE_ORDER.map((mode) => h("button", { key: mode, type: "button", role: "menuitemradio", "aria-checked": mode === tier.mode,
                style: { ...item, fontWeight: mode === tier.mode ? 600 : 400 }, disabled: (!fresh && !tier.mode) || (mode === tier.mode && !tier.mixed),
                onClick: () => choose(mode) }, (mode === tier.mode ? "● " : "○ ") + MODE_WORDS[mode], h("span", { style: small }, " · " + MODE_HINTS[mode]))))) : null);
      // The model in force for this conversation's Agent; changed on the settings page (one place for the model).
      const current = model && model.ok && model.model ? model.model : null;
      const modelChip = h("button", { key: "model", type: "button", style: chip, "data-rulith-model": current ? current.modelId || "" : "",
        title: current && current.source === "override" ? "这个智能体用它自己的模型设置；点开看账户的模型设置" : "这个会话下一轮用的模型；点开在设置里修改",
        onClick: () => openSettings("model") }, "模型：" + (!current ? "…" : current.configured ? current.modelId || current.name : "未设置"));
      // The post-call review switch exists only when the Agent has a reviewer designated (otherwise it would review nothing).
      const reviewOn = fresh ? true : settings.conversation && settings.conversation.postCallReview === true;
      const review = settings.reviewer ? h("span", { key: "review", style: { position: "relative", display: "inline-flex" }, "data-rulith-review": fresh ? "default" : reviewOn ? "on" : "off" },
        h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === "review", title: "这个会话的事后审查（只改这个会话）",
          onClick: () => setOpen(open === "review" ? null : "review") }, "审查：" + (fresh ? "默认" : reviewOn ? "开" : "关"), h("span", { style: { opacity: 0.6 } }, "▾")),
        open === "review" ? h("div", { role: "menu", style: menu },
          h("div", { style: { ...small, padding: "2px 8px 4px" } }, "这个会话写入调用的事后审查，自下一次调用起"),
          h("button", { type: "button", role: "menuitemradio", "aria-checked": !fresh && reviewOn, style: { ...item, fontWeight: !fresh && reviewOn ? 600 : 400 }, disabled: !fresh && reviewOn,
            onClick: () => { close(); applyReview(true); } }, (!fresh && reviewOn ? "● " : "○ ") + "开：写入调用送审查员"),
          h("button", { type: "button", role: "menuitemradio", "aria-checked": !fresh && !reviewOn, style: { ...item, fontWeight: !fresh && !reviewOn ? 600 : 400 }, disabled: !fresh && !reviewOn,
            onClick: () => { close(); applyReview(false); } }, (!fresh && !reviewOn ? "● " : "○ ") + "关：这个会话不审（推导档下不能关）")) : null) : null;
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4 }, "data-rulith-composer": sessionId },
        tierChip, modelChip, review,
        note ? h("span", { role: "alert", style: { ...small, color: AMBER, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }, title: note }, note) : null);
    }

    // ---- Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01, D-1018b batch 3). The owner picks a folder under an
    // Agent, reads what opening it grants, confirms once, and a new conversation starts in it when it is ready. What is
    // granted (folder, Agent, computer, tools, mode) is the Gateway's answer, shown as it is; the wording is ours.
    const TOOL_WORDS = { read: "读文件", read_image: "读图片", list: "列出文件", glob: "按名称找文件", search: "搜索文件内容",
      tree_state: "查看文件夹的改动", write_file: "写文件", patch_file: "修改文件", apply_patch: "按补丁修改文件", run: "运行命令",
      test: "运行测试", job_start: "在后台运行命令", job_poll: "查看后台命令", job_stop: "停止后台命令", acceptance: "运行验收检查" };
    // A tool in plain words, without its id or version; a tool this page has no words for is named by its id without the
    // version (never left out: the confirmation lists every tool the opening grants).
    const toolWords = (id) => {
      const name = String(id || "").replace(/@\d+$/, "");
      return TOOL_WORDS[name.replace(/^eng\./, "")] || name;
    };
    const unique = (values) => values.filter((value, index) => value && values.indexOf(value) === index);
    // What each mode the Gateway may request means for the owner. A mode this page cannot explain is not offered.
    const MODE_MEANING = {
      non_strict: "这台电脑上之后新开的会话使用「非严格」档：模型给出的命令和参数不再需要事先有依据，就会执行；任务算不算完成，仍然只由你签字的验收合同认定。",
    };
    /**
     * The confirmation for one state reply, or why it cannot be shown. Pure. Everything SYS-LOCAL-01 (PSC 0.2.24) requires
     * the confirmation to list is in view: the folder, the Agent and this computer, what may be done there, the tools it
     * uses (in plain words, with the capability they come from), what the tier means, that "in the folder" is not
     * operating-system isolation, and how to withdraw it. Only the tool ids with their versions, the capability's version
     * and the account are under 「详细」 (design §3.2 打开确认框).
     * 中文说明：规定要列出的各项（含所用工具）都直接显示；「详细」里只有带版本的工具标识、能力版本与账户。
     */
    function projectConfirmation(view) {
      const v = view || {};
      const tools = Array.isArray(v.tools) ? v.tools : [];
      const requested = v.mode && v.mode.requested;
      if (!v.directory || !v.accountId || !v.agentName || !v.computer || !tools.length || !v.authorizationVersion || !requested)
        return { error: "读到的打开内容不完整，不能请你确认。请稍后再试。" };
      if (!MODE_MEANING[requested])
        return { error: "这个版本的 Rulith 应用说明不了要设置的档位（" + requested + "），不能请你确认。请先更新 Rulith 应用。" };
      const capability = v.capability && v.capability.id ? v.capability.id : "";
      return {
        title: "把这个文件夹作为项目打开？",
        rows: [
          ["文件夹", v.directory],
          ["智能体", v.agentName + " · 这台电脑 " + (v.computer.label || "未命名的电脑") + (v.connectionName ? "（本机连接「" + v.connectionName + "」）" : "")],
          ["可以做的事", "在这个文件夹里读文件、写文件、运行命令（包括测试和构建）。"],
          ["所用工具", unique(tools.map((tool) => toolWords(tool.id))).join("、")
            + (capability ? "。来自这个智能体已装的官方编程能力「" + capability + "」。" : "。")],
          ["档位", MODE_MEANING[requested]],
          ["请注意", "「在这个文件夹里」不是操作系统级的隔离：运行的命令，以及它再启动的其他软件，仍然可能读写这个文件夹以外的文件。只打开你愿意让智能体在里面写文件、运行命令的文件夹。"],
          ["怎么收回", "以后要收回，在 Console 里解除这个项目的锁定，或者停用这台电脑的登录。"],
        ],
        details: [
          ["账户", v.accountName || v.accountId],
          ["工具与版本", tools.map((tool) => String(tool.id || "")).join("、")
            + (capability ? "。官方编程能力 " + capability + (v.capability.version ? " " + v.capability.version : "") : "") + "。"],
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
      worker_tools_unavailable: "这台电脑还没有报告要用的工具。请在设置的「这台电脑」里对这个智能体点「在本机设置」，再试一次。",
      worker_tools_mismatch: "这台电脑上的工具和智能体要求的版本不一致。请更新 Rulith 应用后再试。",
      worker_tool_contract_missing: "这台电脑上的工具和智能体要求的版本不一致。请更新 Rulith 应用后再试。",
      worker_tool_not_direct: "这台电脑上的工具和智能体要求的版本不一致。请更新 Rulith 应用后再试。",
      worker_tool_pin_conflict: "这条本机连接上已经钉着同名工具的另一个版本，需要在 Console 里处理。什么都没有改。",
      project_unavailable: "现在确认不了项目的状态。之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。",
      not_signed_in: "这台电脑没有登录 Rulith，或登录已不能使用：先在左下角登录。",
      manager_signing_out: "这台电脑正在退出 Rulith 登录，现在不能打开项目。",
      manager_closing: "本机 Rulith 正在关闭，现在不能打开项目。",
      authorization_changed: "要授予的内容在确认之后又变了。请再打开一次，重新确认。",
      // The setup that runs before opening (repair) stopped where only the owner can decide (SYS-LOCAL-01): the confirmation
      // is under 「在本机设置」.
      runtime_credential_exists: "这个智能体的 Agent token 正在另一台电脑（或另一个客户端）上使用，这台电脑还没有设置好。请在设置的「这台电脑」里对它点「在本机设置」，确认替换后再打开文件夹。什么都没有改。",
      connection_rejected: "Rulith 拒绝了这台电脑的连接凭据（可能在 Console 里轮换或撤销了），这台电脑的 Worker 已停下。请在设置的「这台电脑」里对它点「在本机设置」，确认重新接上后再打开文件夹。什么都没有改。",
      connection_missing: "这台电脑上这个智能体的连接凭据不见了。请在设置的「这台电脑」里对它点「在本机设置」，确认重新接上后再打开文件夹。什么都没有改。",
      worker_taken_over: "这个智能体的连接被另一个 Worker 进程接走了，这台电脑的 Worker 已停下。请在设置的「这台电脑」里对它点「在本机设置」，再打开文件夹。",
      local_setup_connection_in_use: "这个智能体的连接正被另一台电脑上的 Worker 使用，这台电脑没有接上它，也没有新建连接。等那个 Worker 停下（或它的租约过期）后，在设置的「这台电脑」里对它点「在本机设置」，再打开文件夹。",
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
    // A fresh request id per confirmation, for opening a folder and for signing (the page is served from this computer, a
    // secure context).
    const newRequestId = () => {
      const c = window.crypto;
      if (c && c.randomUUID) return c.randomUUID();
      return "req-" + Array.from(c.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
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
    /** The flow with this page's dialog, progress line and 「停止等待」, for the sidebar and the wizard. */
    function useProjectOpening() {
      const [asking, setAsking] = useState(null);   // { view, note, answer } while the confirmation is open
      const [progress, setProgress] = useState("");
      const stopped = React.useRef(false);
      const run = async (agentId, directory) => {
        stopped.current = false;
        try {
          return await openProjectFlow({ api, agentId, directory, newRequestId,
            ui: { confirm: (view, why) => new Promise((answer) => setAsking({ view, note: why, answer })),
              progress: setProgress, wait: sleep, stopped: () => stopped.current } });
        } finally { setProgress(""); setAsking(null); }
      };
      const answer = (yes) => { const pending = asking; setAsking(null); if (pending) pending.answer(yes); };
      return { run, asking, answer, progress, stop: () => { stopped.current = true; } };
    }
    /** The one confirmation of opening a folder as a project (PSC 0.2.24). Its content is the Gateway's answer. */
    function ProjectDialog({ asking, answer }) {
      const confirmation = asking ? projectConfirmation(asking.view) : null;
      if (!confirmation || confirmation.error) return null;
      const line = ([label, value]) => h("div", { key: label, style: { display: "flex", gap: 10, padding: "3px 0" } },
        h("div", { style: { flex: "none", width: 96, opacity: 0.7 } }, label),
        h("div", { style: { flex: 1, wordBreak: "break-word" } }, value));
      return backdrop(2000, () => answer(false),
        h("div", { role: "dialog", "aria-modal": "true", "data-rulith-project-dialog": "", onClick: (event) => event.stopPropagation(), style: card(520) },
          h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, confirmation.title),
          asking.note ? h("div", { role: "alert", style: { color: AMBER, marginBottom: 8 } }, asking.note) : null,
          confirmation.rows.map(line),
          h("details", { "data-rulith-project-details": "", style: { marginTop: 6 } },
            h("summary", { style: { cursor: "pointer", opacity: 0.8 } }, "详细"), confirmation.details.map(line)),
          h("div", { style: { marginTop: 8, opacity: 0.8 } }, confirmation.footer),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
            h("button", { type: "button", style: button, onClick: () => answer(false) }, confirmation.cancel),
            h("button", { type: "button", style: primary, onClick: () => answer(true) }, confirmation.accept))));
    }
    /**
     * 「📂 打开文件夹…」 (design §3.2 打开文件夹): the operating system's folder chooser, opened by the app host; where none can
     * be opened, or on 「手动输入路径」, the folder's full path is typed instead. `onChosen(path)` opens it as a project and
     * resolves true once it is open. Network folders are refused by the opening, as before.
     */
    function FolderChooser({ disabled, onChosen, label = "📂 打开文件夹…", indent = 0 }) {
      const [manual, setManual] = useState(false);
      const [path, setPath] = useState("");
      const [picking, setPicking] = useState(false);
      const [note, setNote] = useState("");
      const choose = async (value) => { if (await onChosen(value)) { setPath(""); setManual(false); setNote(""); } };
      const pick = async () => {
        if (disabled || picking) return;
        setPicking(true); setNote("");
        let reply;
        try { reply = await api("pick-folder", {}); } catch (error) { reply = { ok: false, teaching: errorText(error) }; }
        setPicking(false);
        if (reply.ok && reply.state === "chosen" && reply.path) choose(reply.path);
        else if (!reply.ok || reply.state === "unavailable") { setManual(true); setNote(reply.teaching || "打不开选择文件夹的窗口：请手动输入路径。"); }
      };
      const submit = () => { if (!disabled && path.trim()) choose(path.trim()); };
      return h("div", { "data-rulith-folder-chooser": "", style: { padding: "2px 6px 2px " + (18 + indent) + "px" } },
        manual
          ? h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
            h("input", { value: path, autoFocus: true, placeholder: "文件夹的完整路径，例如 D:\\work\\game 或 /home/you/game", disabled,
              onChange: (event) => setPath(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") submit(); else if (event.key === "Escape" && !disabled) setManual(false); },
              style: { ...field, flex: 1, minWidth: 0, padding: "2px 6px", fontSize: 12 } }),
            h("button", { type: "button", style: { ...button, padding: "1px 8px", fontSize: 11 }, disabled: disabled || !path.trim(), onClick: submit }, "打开"),
            h("button", { type: "button", title: "取消", style: { ...linkButton, textDecoration: "none" }, disabled, onClick: () => { setManual(false); setNote(""); } }, "×"))
          : h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
            h("button", { type: "button", "data-rulith-pick-folder": "", disabled: disabled || picking, title: "用系统的选择文件夹窗口选一个文件夹，作为这个智能体的项目打开",
              style: { ...linkButton, textDecoration: "none", opacity: 0.8, fontSize: 12.5 }, onClick: pick }, picking ? "请在弹出的窗口里选择文件夹…" : label),
            picking ? null : h("button", { type: "button", "data-rulith-type-folder": "", disabled, style: { ...linkButton, fontSize: 11 }, onClick: () => setManual(true) }, "手动输入路径")),
        note ? h("div", { style: { ...small, marginTop: 2 } }, note) : null);
    }
    /** A new conversation in `directory` under `agent`, recorded for that Agent before its first message, and opened. */
    function sessionStarter(services) {
      return async (agent, directory) => {
        let ws = ((services.workspaces.list.getSnapshot() || {}).items || []).find((entry) => samePath(entry.path) === samePath(directory));
        if (!ws) { const made = await services.workspaces.create({ path: directory }); ws = pick(pick(made, "value"), "workspace"); }
        const created = await services.sessions.create({ workspaceId: ws.workspaceId });
        const id = typeof created === "string" ? created : pick(pick(created, "value"), "sessionId");
        const reply = await api("sessions/assign", { session: id, agentId: agent.agentId });
        services.ui.openSession(id);
        return reply.ok ? "" : reply.teaching || "没有记下这个会话的智能体";
      };
    }

    // ---- Sidebar: Agent -> directory -> conversation (owner 2026-10-17). Registered at a lower priority than dsh's own
    // workspace browser, which shadows its view; dsh's navigation service (uiWorkspace) still opens, starts and archives
    // conversations, and dsh's session and workspace stores are read as they are. Directories are the Agent's file
    // Sources on this computer (or its own working directory); a conversation belongs to the Agent recorded for it.
    const COLLAPSE_KEY = "deep-rulith.tree.collapsed";
    const loadCollapsed = () => { try { return JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch { return {}; } };
    const saveCollapsed = (value) => { try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(value)); } catch {} };
    // Deletions that are not finished yet (PSC 0.2.27 ⑤), by conversation, with why: kept on this computer so the row says so
    // and offers 补完删除 after a reload too.
    const UNSETTLED_KEY = "rulith.tree.unsettled";
    const loadUnsettled = () => { try { return JSON.parse(window.localStorage.getItem(UNSETTLED_KEY) || "{}") || {}; } catch { return {}; } };
    const saveUnsettled = (value) => { try { window.localStorage.setItem(UNSETTLED_KEY, JSON.stringify(value)); } catch {} };
    const DELETION_WORDS = { closings_unconfirmed: (n) => (n ? n + " 个" : "有的") + "目标的结案还没有确认", goals_unread: () => "读不到它还开着的目标",
      deleted_before_recording: () => "它是在开始记录删除结果之前删除的",
      // PSC 0.2.28 erratum: every closing is answered and the goals were read; only the finished record is missing (补完删除 records it).
      settlement_unrecorded: () => "删除已办完，还没记下" };
    /**
     * What a deletion's answer means for its row (PSC 0.2.27 ⑤): `settled` — finished, the row goes; otherwise the reasons
     * it is not finished yet, and the row stays with 补完删除 (the same request finishes it). Reads the device answer of
     * `/end` (`settled`, `unconfirmedGoals`, `goalsUnread`, `refusedGoals`) or a conversation state's `deletion`; an older
     * Gateway without `settled` counts as finished only when nothing is unconfirmed or unread. Pure.
     */
    function deletionOutcome(reply) {
      const r = reply || {};
      const d = r.deletion && typeof r.deletion === "object" ? r.deletion : null;
      const refused = Array.isArray(r.refusedGoals) ? r.refusedGoals.length : d && Array.isArray(d.refusedGoals) ? d.refusedGoals.length : 0;
      const reasons = [];
      if (d && Array.isArray(d.reasons)) for (const reason of d.reasons) {
        const words = own(DELETION_WORDS, reason && reason.code);
        reasons.push(words ? words(reason.count) : String((reason && reason.code) || "删除还没有办完"));
      }
      const unconfirmed = Array.isArray(r.unconfirmedGoals) ? r.unconfirmedGoals.length : 0;
      if (!d && unconfirmed) reasons.push(DELETION_WORDS.closings_unconfirmed(unconfirmed));
      if (!d && r.goalsUnread) reasons.push(DELETION_WORDS.goals_unread());
      const settled = typeof r.settled === "boolean" ? r.settled : d && typeof d.settled === "boolean" ? d.settled : reasons.length === 0;
      return { settled, reasons: settled ? [] : reasons.length ? reasons : ["删除还没有办完"], refused };
    }
    const samePath = (p) => String(p || "").replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
    const agoText = (ms) => {
      if (!Number.isFinite(ms)) return "";
      const m = Math.round((Date.now() - ms) / 60000);
      return m < 1 ? "刚刚" : m < 60 ? m + " 分" : m < 1440 ? Math.round(m / 60) + " 时" : Math.round(m / 1440) + " 天";
    };
    const RECENT_MS = 3 * 24 * 3600 * 1000;
    const SHOWN = 5;
    const tiny = { padding: "0 6px", borderRadius: 5, border: "none", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, lineHeight: "18px", opacity: 0.6 };
    const pick = (value, ...keys) => { for (const key of keys) if (value && value[key] !== undefined) return value[key]; return value; };

    /**
     * Group conversations under Agents and directories. Pure: exported for the harness tests. `isDefault` is the account's
     * own default Agent as the service marks it (the 默认 badge); `tree.defaultAgentId` is only the app's fallback Agent
     * for conversations nobody owns, which decides who owns a shared directory.
     */
    function buildTree({ tree, list, workspaces, current, filter, collapsed }) {
      const agents = tree && Array.isArray(tree.agents) ? tree.agents : [];
      const assignments = (tree && tree.assignments) || {};
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const pinned = new Set((workspaces && workspaces.pinnedSessionIds) || []);
      const owners = new Map();
      // A shared directory belongs to the app's fallback Agent when it is one of its owners (same rule as the launcher).
      const byDefault = [...agents].sort((x, y) => (y.agentId === (tree && tree.defaultAgentId)) - (x.agentId === (tree && tree.defaultAgentId)));
      for (const a of byDefault) for (const d of a.directories || []) if (!owners.has(samePath(d.path))) owners.set(samePath(d.path), a.agentId);
      const groups = new Map(agents.map((a) => [a.agentId, { agent: a, dirs: new Map((a.directories || []).map((d) => [samePath(d.path), { dir: d, sessions: [] }])) }]));
      const others = [];
      const q = String(filter || "").trim().toLowerCase();
      for (const id of (list && list.ids) || []) {
        const s = list.byId[id];
        if (!s || archived.has(s.id) || (s.blank && s.id !== current)) continue;
        // Recorded Agent, else the owner of its directory. A conversation with neither (from before the sidebar, or of an
        // Agent since deleted) is not given to anyone: it waits under "未归属的会话".
        const agentId = assignments[s.id] || (s.origin === "subagent" && assignments[s.parentId]) || owners.get(samePath(s.cwd));
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
        out.push({ agent: a, dirs, latest, running, count, hasCurrent, open, isDefault: a.isDefault === true });
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
      const startIn = sessionStarter(services);
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
        const opening = useProjectOpening();
        const setup = useSetupRun();
        const [unsettled, setUnsettled] = useState(loadUnsettled); // { sessionId: reasons } of deletions not finished yet
        if (!wide) return h("button", { type: "button", title: "展开智能体列表", onClick: expandSidebar,
          style: { ...button, display: "block", margin: "8px auto" } }, "☰");
        const current = selection && selection.sessionId;
        const ready = tree && tree.ok;
        const view = buildTree({ tree: ready ? tree : null, list, workspaces, current, filter, collapsed });
        const toggle = (key, open) => { const next = { ...collapsed, [key]: open }; setCollapsed(next); saveCollapsed(next); };
        const open = (id) => { try { services.ui.openSession(id); } catch (error) { setNote(errorText(error)); } };
        const archive = (id) => Promise.resolve(services.ui.archiveSession(id)).catch((error) => setNote(errorText(error)));
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
          } catch (error) { setNote(errorText(error)); }
        };
        // Delete (or finish deleting) one conversation. Its request id is fixed by the conversation (host), so 补完删除 is the
        // same deletion continued. Only a finished deletion takes the row away (PSC 0.2.27 ⑤).
        const endConversation = async (id) => {
          setBusy("delete");
          try {
            const reply = await api("conversation/end", { session: id });
            if (!reply.ok) { setNote(reply.teaching || "没有删除"); return; }
            setDeleting(null);
            const outcome = deletionOutcome(reply);
            if (!outcome.settled) {
              const next = { ...unsettled, [id]: outcome.reasons }; setUnsettled(next); saveUnsettled(next);
              setNote("已删除，但还没有办完：" + outcome.reasons.join("；") + "。点这个会话的「补完删除」接着做。"); refreshTree(); return;
            }
            if (unsettled[id]) { const next = { ...unsettled }; delete next[id]; setUnsettled(next); saveUnsettled(next); }
            if (outcome.refused) setNote("已删除。其中 " + outcome.refused + " 个目标没能结案，留在已结束的会话里，可在 Console 的任务记录里查到。");
            await archive(id);
            refreshTree();
          } catch (error) { setNote(errorText(error)); }
          finally { setBusy(""); }
        };
        const confirmDelete = () => { if (deleting && !busy) return endConversation(deleting.id); };
        const startSession = async (agent, directory) => {
          try { const problem = await startIn(agent, directory); if (problem) setNote(problem); refreshTree(); }
          catch (error) { setNote("新会话没有建成：" + errorText(error)); }
        };
        const newSession = async (agent, dir) => {
          if (busy) return;
          setBusy(agent.agentId); setNote("");
          try { await startSession(agent, dir.path); } finally { setBusy(""); }
        };
        // PSC 0.2.24: open a folder as a project, then start a conversation in it once it is ready (never before: the
        // conversation's Board freezes the Agent's settings when it is made).
        const openFolder = async (agent, directory) => {
          if (busy || !String(directory || "").trim()) return false;
          setBusy("project:" + agent.agentId); setNote("");
          try {
            const result = await opening.run(agent.agentId, String(directory).trim());
            if (result.outcome === "ready") { await startSession(agent, result.directory); return true; }
            if (result.outcome !== "cancelled") setNote(result.text);
            return false;
          } catch (error) { setNote("没有打开项目：" + errorText(error)); return false; }
          finally { setBusy(""); }
        };
        // PSC 0.2.27 ② ③: set the Agent up on this computer in one step, its steps shown under it; no restart. Replacing its
        // Agent token only after the owner confirmed it under the steps (`replace`).
        const setUp = async (agent, replace = false) => {
          if (busy) return;
          setBusy("setup:" + agent.agentId); setNote("");
          try { const result = await setup.start(agent.agentId, "setup", { replaceAgentToken: replace }); if (result.ok) { refreshTree(); setTimeout(refreshTree, 3000); } }
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
        // Design §6: an Agent's name, a folder's name and a conversation's title wrap in the left column; none is cut off.
        const sessionRow = (s, agentName) => h("div", { key: s.id, role: "button", tabIndex: 0, "data-rulith-session": s.id,
            onClick: () => open(s.id), onKeyDown: (event) => { if (event.key === "Enter") open(s.id); },
            style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 34px", borderRadius: 6, cursor: "pointer", fontSize: 13,
              background: s.id === current ? "rgba(127,127,127,.20)" : "transparent" } },
          s.running ? dot(GREEN) : h("span", { style: { width: 8, flex: "none" } }),
          h("span", { title: s.title || "", style: { flex: 1, minWidth: 0, wordBreak: "break-word" } },
            s.blank ? "新会话" : (s.title && s.title.trim()) || "未命名会话"),
          unsettled[s.id] ? h("span", { "data-rulith-unsettled": s.id, title: [].concat(unsettled[s.id]).join("；"),
              style: { ...small, flex: "none", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: AMBER, opacity: 1 } },
              "没删完：" + [].concat(unsettled[s.id]).join("；"))
            : h("span", { style: { ...small, flex: "none" } }, agoText(s.updatedAt)),
          s.origin === "subagent" ? h("span", { style: small }, "历史子会话")
            : unsettled[s.id] ? h("button", { type: "button", "data-rulith-finish-delete": s.id, disabled: !!busy, style: { ...tiny, color: AMBER, opacity: 1 },
                title: "删除还没有办完：" + [].concat(unsettled[s.id]).join("；") + "。同一次删除接着做，不再问。",
                onClick: (event) => { event.stopPropagation(); if (!busy) endConversation(s.id); } }, "补完删除")
            : h("button", { type: "button", title: "删除这个会话", "data-rulith-delete": s.id, style: tiny, onClick: (event) => { event.stopPropagation(); askDelete(s, agentName); } }, "删除"));
        const dirBlock = (entry, d) => {
          const key = "d:" + d.key;
          const shut = collapsed[key] === true && !filter;
          const showAll = !!more[d.key] || !!filter;
          const shown = showAll ? d.sessions : d.sessions.slice(0, SHOWN);
          return h("div", { key: d.key, "data-rulith-directory": d.path },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 6px 2px 18px", fontSize: 12.5, opacity: 0.9 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle(key, !shut) }, shut ? "▸" : "▾"),
              h("span", { title: d.path, style: { flex: 1, minWidth: 0, wordBreak: "break-word" } },
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
          const opensHere = busy === "project:" + a.agentId;
          return h("div", { key: a.agentId, "data-rulith-agent": a.agentId, style: { marginBottom: 4 } },
            // The Agent of the open conversation is highlighted; 默认 marks only the account's default Agent.
            h("div", { "data-rulith-agent-current": entry.hasCurrent ? "" : undefined,
                style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                  background: entry.hasCurrent ? "rgba(127,127,127,.12)" : "transparent" } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14, opacity: 0.8 }, onClick: () => toggle(a.agentId, entry.open) }, entry.open ? "▾" : "▸"),
              dot(!a.attached ? GREY : online ? GREEN : AMBER),
              h("span", { title: a.name, style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, a.name),
              entry.isDefault ? h("span", { "data-rulith-default": "", title: "这个账户的默认智能体", style: { ...small, fontWeight: 400 } }, "默认") : null,
              entry.count ? h("span", { style: { ...small, fontWeight: 400 } }, entry.count) : null,
              !a.attached ? h("button", { type: "button", "data-rulith-setup-agent": a.agentId, disabled: !!busy, style: { ...button, padding: "0 6px", fontSize: 11 }, onClick: () => setUp(a) },
                  busy === "setup:" + a.agentId ? "正在设置…" : "在本机设置")
                : firstDir(entry) ? h("button", { type: "button", title: "在这个智能体下开新会话", disabled: !!busy, style: tiny, onClick: () => newSession(a, firstDir(entry)) }, "+") : null),
            setup.run && setup.run.agentId === a.agentId && !(setup.run.settled && setup.run.ok && a.attached) ? h("div", { style: { padding: "0 6px 0 26px" } }, h(SetupSteps, { run: setup.run, onReplace: () => setUp(a, true) })) : null,
            entry.open && a.attached ? h("div", null, entry.dirs.map((d) => dirBlock(entry, d)),
              // The directory level's last row: open another folder of this computer as one of this Agent's projects.
              h(FolderChooser, { key: "folders-" + a.agentId, disabled: !!busy, onChosen: (directory) => openFolder(a, directory) }),
              opensHere && opening.progress ? h("div", { role: "status", style: { ...small, display: "flex", gap: 6, alignItems: "baseline", padding: "2px 6px 2px 18px" } },
                h("span", { style: { flex: 1 } }, opening.progress),
                h("button", { type: "button", style: { ...tiny, fontSize: 11 }, onClick: opening.stop }, "停止等待")) : null) : null);
        };
        return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, overflow: "auto", padding: "4px 6px" }, "data-rulith-tree": "" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" } },
            h("span", { style: { ...section, margin: 0, flex: 1 } }, "智能体"),
            h("button", { type: "button", title: "在当前智能体与目录下开新会话", disabled: !!busy || !ready, style: tiny, onClick: startHere }, "＋ 新会话")),
          h("input", { value: filter, placeholder: "筛选智能体、目录或会话", onChange: (event) => setFilter(event.target.value),
            style: { margin: "2px 6px 8px", padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12 } }),
          !tree ? none("正在读取智能体…")
            : !ready ? h("div", { style: { ...small, padding: "0 6px 8px" } }, tree.teaching || "读不到智能体：先在左下角的设置里登录 Rulith。") : null,
          view.agents.map(agentBlock),
          view.others.count ? h("div", { style: { marginTop: 6 }, "data-rulith-unowned": "" },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 13, opacity: 0.8 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle("others", view.others.open) }, view.others.open ? "▾" : "▸"),
              h("span", { style: { flex: 1 } }, "未归属的会话"),
              h("span", { style: small }, view.others.count)),
            view.others.open ? view.others.dirs.map((d) => dirBlock({ agent: { attached: false } }, d)) : null) : null,
          note ? h("div", { role: "alert", style: { ...small, color: AMBER, padding: "4px 6px" } }, note) : null,
          deleting ? backdrop(2000, () => { if (!busy) setDeleting(null); },
            h("div", { role: "dialog", "aria-modal": "true", "data-rulith-delete-dialog": deleting.id, onClick: (event) => event.stopPropagation(), style: card(420) },
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
                h("button", { type: "button", style: { ...button, borderColor: RED, color: RED }, disabled: !!busy, onClick: confirmDelete },
                  busy === "delete" ? "正在删除…" : "删除")))) : null,
          h(ProjectDialog, { asking: opening.asking, answer: opening.answer }));
      };
    }

    // ---- First-run wizard (design §3.2 首次打开): ① 登录 ② 选模型并填密钥 ③ 打开文件夹, in place of dsh's "预览版说明".
    /**
     * Which step the wizard shows, each read from the state it names, so it resumes wherever the account is and a returning
     * user who has all three never sees it. `show` is false until what decides the current step has been read. A project
     * counts once one of the account's Agents attached here has a folder Source; while an Agent set up here is not attached
     * yet, step ③ cannot be told and the wizard waits. Pure.
     */
    function wizardSteps({ state, model, tree }) {
      const signedIn = !!(state && state.ok && state.signedIn);
      const modelReady = !!(signedIn && model && model.ok && model.model && model.model.configured);
      const agents = tree && tree.ok && Array.isArray(tree.agents) ? tree.agents : [];
      const folderOpen = agents.some((a) => a.attached && (a.directories || []).some((d) => d.source));
      const steps = [{ id: "signin", label: "登录", done: signedIn }, { id: "model", label: "选模型并填密钥", done: modelReady },
        { id: "folder", label: "打开文件夹", done: modelReady && folderOpen }];
      const current = steps.find((step) => !step.done);
      let show;
      if (!state || !state.ok) show = false;
      else if (!signedIn) show = true;
      else if (!model) show = false;
      else if (!modelReady) show = true;
      else if (!tree || folderOpen) show = false;
      else show = !(tree.ok && agents.some((a) => a.paired && !a.attached));
      return { show, steps, current: current ? current.id : null, account: signedIn ? state.account || "" : "" };
    }
    function makeRulithWizard(services) {
      const startIn = sessionStarter(services);
      return function RulithWizard() {
        const [state, , setState] = usePoll("state", 5000);
        const signedIn = !!(state && state.ok && state.signedIn);
        const [model, refreshModel] = usePoll(signedIn ? "model" : null, 15000);
        const [tree, refreshTree] = usePoll(signedIn ? "tree" : null, 15000);
        const [put, setPut] = useState(null);         // the account the wizard was put away (or finished) for, this page load
        const [working, setWorking] = useState(false); // a step's action runs: the wizard stays until it ends
        const [busy, setBusy] = useState("");
        const [notice, setNotice] = useState("");
        const [chosenAgent, setChosenAgent] = useState("");
        const opening = useProjectOpening();
        const setup = useSetupRun();
        const [retryFolder, setRetryFolder] = useState("");   // the folder chosen when the setup stopped to ask about the token
        const view = wizardSteps({ state, model, tree });
        if (!working && (!view.show || put === view.account)) return null;
        const signIn = async () => {
          setBusy("signin"); setNotice("");
          try { const reply = await signInFlow({ api }); if (reply.ok) setState(reply); else setNotice(reply.teaching || "没有登录成功。"); }
          catch (error) { setNotice(errorText(error)); } finally { setBusy(""); }
        };
        const agents = tree && tree.ok && Array.isArray(tree.agents) ? tree.agents : [];
        // The account's default Agent when the service names it, the only one when there is one; else the owner chooses.
        const named = agents.find((a) => a.isDefault === true) || (agents.length === 1 ? agents[0] : null);
        const agent = named || agents.find((a) => a.agentId === chosenAgent) || null;
        const openFolder = async (directory, replace = false) => {
          if (!agent || working) return false;
          setWorking(true); setNotice("");
          try {
            if (!agent.attached) {
              const done = await setup.start(agent.agentId, "setup", { replaceAgentToken: replace });
              if (!done.ok) { setRetryFolder(directory); return false; }
              // The host attaches the Agent as soon as its setup is done; give it a moment.
              let attached = false;
              for (let i = 0; i < 10 && !attached; i++) {
                const now = await api("tree");
                attached = !!(now.ok && (now.agents || []).some((a) => a.agentId === agent.agentId && a.attached));
                if (!attached) await sleep(1500);
              }
              if (!attached) { setNotice("这个智能体已经在这台电脑上设置好，但还没有接上 Rulith：稍等片刻，再选一次文件夹。"); return false; }
            }
            const result = await opening.run(agent.agentId, directory);
            if (result.outcome === "ready") {
              const problem = await startIn(agent, result.directory);
              if (problem) setNotice(problem);
              setPut(view.account); refreshTree();
              return true;
            }
            if (result.outcome !== "cancelled") setNotice(result.text);
            return false;
          } catch (error) { setNotice("没有打开项目：" + errorText(error)); return false; }
          finally { setWorking(false); }
        };
        // The owner confirmed replacing the Agent's token under the setup's steps: set it up again with that confirmation
        // and go on opening the folder chosen before.
        const replaceAndOpen = () => (retryFolder ? openFolder(retryFolder, true)
          : agent ? setup.start(agent.agentId, "setup", { replaceAgentToken: true }) : undefined);
        let body;
        if (view.current === "signin") body = h("div", null,
          h("div", null, "用你的 Rulith 账户登录这台电脑：会在浏览器里打开 Rulith，批准后回到这里。"),
          state && state.teaching ? h("div", { style: small }, state.teaching) : null,
          h("div", { style: { marginTop: 10 } }, h("button", { type: "button", style: primary, disabled: !!busy, onClick: signIn }, busy === "signin" ? "等待浏览器里批准…" : "登录 Rulith")));
        else if (view.current === "model") body = h("div", null,
          h("div", { style: { marginBottom: 4 } }, "选一个模型服务，填上模型 ID 和密钥。"),
          h(ModelForm, { onSaved: () => refreshModel() }));
        else body = h("div", null,
          h("div", null, "选一个文件夹作为项目：智能体会在里面读写文件、运行命令。打开前会请你确认一次。"),
          !tree ? none("正在读取智能体…")
            : !tree.ok ? alertLine(tree.teaching || "读不到智能体。")
            : !agents.length ? alertLine("这个账户在这台电脑上没有可用的智能体：在 Console 里检查这台电脑的登录授权。")
            : named ? h("div", { style: { ...small, marginTop: 6 } }, "智能体：" + named.name + (named.isDefault ? "（默认）" : ""))
            : h("label", { style: { display: "block", marginTop: 6 } }, h("span", { style: small }, "智能体："),
                h("select", { value: chosenAgent, disabled: working, onChange: (event) => setChosenAgent(event.target.value), style: { ...field, width: "auto" } },
                  h("option", { value: "" }, "选一个智能体"), agents.map((a) => h("option", { key: a.agentId, value: a.agentId }, a.name)))),
          agent ? h("div", { style: { marginTop: 8 } }, h(FolderChooser, { disabled: working, onChosen: openFolder, indent: -18, label: "📂 选择文件夹…" })) : null,
          setup.run && setup.run.agentId === (agent && agent.agentId) ? h(SetupSteps, { run: setup.run, onReplace: replaceAndOpen }) : null,
          opening.progress ? h("div", { role: "status", style: { ...small, display: "flex", gap: 6, marginTop: 6 } },
            h("span", { style: { flex: 1 } }, opening.progress), h("button", { type: "button", style: linkButton, onClick: opening.stop }, "停止等待")) : null);
        return backdrop(1500, undefined,
          h("div", { role: "dialog", "aria-modal": "true", "data-rulith-wizard": view.current || "", style: card(540) },
            h("div", { style: { fontWeight: 700, fontSize: 16, marginBottom: 10 } }, "开始使用 Rulith"),
            h("div", { style: { display: "flex", gap: 14, marginBottom: 14, fontSize: 12 } }, view.steps.map((step, i) => h("span", { key: step.id,
              "data-wizard-step": step.id, "data-done": step.done ? "1" : "0",
              style: { fontWeight: step.id === view.current ? 700 : 400, opacity: step.id === view.current || step.done ? 1 : 0.5, color: step.done ? GREEN : "inherit" } },
              (step.done ? "✓ " : ["①", "②", "③"][i] + " ") + step.label))),
            body,
            notice ? alertLine(notice) : null,
            h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 14 } },
              h("button", { type: "button", style: linkButton, disabled: working, onClick: () => setPut(view.account) }, "稍后再说")),
            h(ProjectDialog, { asking: opening.asking, answer: opening.answer })));
      };
    }

    // ---- One Rulith settings page (design §3.2 设置): 账户, 这台电脑, 模型, 外观与语言, 高级; one entry in the sidebar foot.
    const SETTINGS_SECTIONS = [["account", "账户"], ["computer", "这台电脑"], ["model", "模型"], ["appearance", "外观与语言"], ["advanced", "高级"]];
    const pair = (label, value) => h("div", { style: { display: "flex", gap: 10, padding: "3px 0" } },
      h("div", { style: { flex: "none", width: 72, opacity: 0.7 } }, label), h("div", { style: { flex: 1, wordBreak: "break-word" } }, value));
    function AccountSection({ state, setState }) {
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      if (!state) return none("正在读取…");
      if (!state.ok) return alertLine(state.teaching || "读不到本机 Rulith。");
      const run = async (label, action) => {
        setBusy(label); setNotice("");
        try { const reply = await action(); if (reply && reply.ok === false) setNotice(reply.teaching || "操作没有完成"); else if (reply && reply.ok) setState(reply); }
        catch (error) { setNotice(errorText(error)); } finally { setBusy(""); }
      };
      return h("div", { "data-rulith-settings-account": "" },
        pair("账户", state.signedIn ? state.account || "（未命名的账户）" : "未登录"),
        !state.signedIn && state.teaching ? h("div", { style: small }, state.teaching) : null,
        h("div", { style: { marginTop: 10 } }, state.signedIn
          ? h("button", { type: "button", style: button, disabled: !!busy, onClick: () => run("signout", () => api("signout", {})) }, busy === "signout" ? "正在退出…" : "退出登录")
          : h("button", { type: "button", style: primary, disabled: !!busy, onClick: () => run("signin", () => signInFlow({ api })) }, busy === "signin" ? "等待浏览器里批准…" : "登录 Rulith")),
        notice ? alertLine(notice) : null);
    }
    function ComputerSection({ state, refresh }) {
      const setup = useSetupRun();
      if (!state) return none("正在读取…");
      if (!state.ok) return alertLine(state.teaching || "读不到本机 Rulith。");
      if (!state.signedIn) return none("先在「账户」里登录 Rulith，才能在这台电脑上设置智能体。");
      const agents = Array.isArray(state.agents) ? state.agents : [];
      // Every click is the explicit setup: it checks this computer's Connection, and it may start a Worker that stopped
      // itself (PSC 0.2.27 ③). Replacing the Agent token only after the owner confirmed it under the steps (`replace`).
      const setUp = async (agent, replace = false) => { await setup.start(agent.id, "setup", { replaceAgentToken: replace }); refresh(); };
      return h("div", { "data-rulith-settings-computer": "" },
        pair("这台电脑", state.computer || "未命名的电脑"),
        h("div", { style: { ...small, margin: "4px 0 8px" } }, "「在本机设置」一步完成：接上这台电脑、装好编程工具、开启这台电脑。已经设置过的会检查一遍、补上缺的，不需要重启；设置本身不授予任何文件夹或工具的权限。"),
        agents.length ? agents.map((agent) => {
          const words = workerWords(agent);
          return h("div", { key: agent.id, "data-rulith-computer-agent": agent.id, style: { padding: "4px 0" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, dot(words.color),
              h("span", { style: { flex: 1 } }, agent.name + (agent.isDefault === true ? "（默认）" : "")),
              h("span", { style: small }, words.text),
              h("button", { type: "button", style: button, disabled: setup.busy, onClick: () => setUp(agent) }, "在本机设置")),
            setup.run && setup.run.agentId === agent.id ? h(SetupSteps, { run: setup.run, onReplace: () => setUp(agent, true) }) : null);
        }) : none("这个账户在这台电脑上没有可用的智能体。"));
    }
    function AppearanceSection() {
      const [, setTick] = useState(0);
      const theme = shared.theme, locale = shared.locale;
      const bump = () => setTick((n) => n + 1);
      const select = (value, options, onChange) => h("select", { value, onChange: (event) => onChange(event.target.value), style: { ...field, width: "auto" } },
        options.map(([id, label]) => h("option", { key: id, value: id }, label)));
      const snapshot = locale ? locale.getSnapshot() : null;
      return h("div", { "data-rulith-settings-appearance": "" },
        theme ? pair("外观", select((theme.getTheme() || {}).preference || "system", [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]],
          (id) => { try { theme.setTheme(id); } catch {} bump(); })) : none("这里没有可用的外观设置。"),
        snapshot ? pair("语言", select(snapshot.active, (snapshot.locales || []).map((l) => [l.id, l.label || l.id]),
          (id) => { try { locale.setLocale(id); } catch {} bump(); })) : null,
        snapshot ? h("div", { style: { ...small, marginTop: 6 } }, "语言改变的是界面里其余的文字；Rulith 自己的文字目前只有中文。") : null);
    }
    function AdvancedSection({ state }) {
      let consoleUrl = "";
      try { const origin = new URL(state && state.origin).origin; if (/^https?:/.test(origin)) consoleUrl = origin + "/console/#/agents"; } catch {}
      return h("div", { "data-rulith-settings-advanced": "" },
        h("div", { style: section }, "接入其他客户端"),
        h("div", null, "其他 MCP 客户端（例如 Claude Code）可以用智能体的 MCP 令牌接入同一个智能体。令牌在 Console 里取：打开这个智能体的页面，找「Agent MCP token」。"),
        consoleUrl ? h("a", { href: consoleUrl, target: "_blank", rel: "noopener noreferrer", style: { fontSize: 12 } }, "在 Console 打开智能体") : null,
        h("div", { style: section }, "诊断"),
        h("div", null, "英文的 Runtime 工作台，只用于排查问题。"),
        h("div", { style: { marginTop: 6 } }, h("button", { type: "button", style: button, onClick: openWorkbench }, "打开 Runtime 工作台")));
    }
    function SettingsPage({ section }) {
      const [state, refresh, setState] = usePoll("state", 5000);
      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") closeSettings(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);
      const body = section === "computer" ? h(ComputerSection, { state, refresh })
        : section === "model" ? (state && state.ok && !state.signedIn ? none("先在「账户」里登录 Rulith，再设置模型。") : h(ModelForm, {}))
        : section === "appearance" ? h(AppearanceSection, {})
        : section === "advanced" ? h(AdvancedSection, { state })
        : h(AccountSection, { state, setState });
      return backdrop(1600, closeSettings,
        h("div", { role: "dialog", "aria-modal": "true", "data-rulith-settings": section, onClick: (event) => event.stopPropagation(),
            style: { ...card(720), display: "flex", gap: 16, minHeight: 360, padding: 0 } },
          h("div", { role: "tablist", style: { flex: "none", width: 140, padding: 12, borderRight: "1px solid rgba(127,127,127,.25)" } },
            h("div", { style: { fontWeight: 700, marginBottom: 10 } }, "设置"),
            SETTINGS_SECTIONS.map(([id, label]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": id === section,
              onClick: () => openSettings(id), style: { ...item, fontSize: 13, fontWeight: id === section ? 600 : 400,
                background: id === section ? "rgba(127,127,127,.18)" : "transparent" } }, label))),
          h("div", { style: { flex: 1, minWidth: 0, padding: "12px 16px 16px 0" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              h("b", null, (SETTINGS_SECTIONS.find(([id]) => id === section) || SETTINGS_SECTIONS[0])[1]),
              h("button", { type: "button", "aria-label": "关闭设置", style: { ...linkButton, textDecoration: "none", fontSize: 16 }, onClick: closeSettings }, "×")),
            body)));
    }
    function RulithSettings() {
      const view = useStore(settingsView);
      return view.open ? h(SettingsPage, { section: view.section }) : null;
    }
    /** The sidebar foot's one entry: the account and this computer at a glance; it opens the settings page. */
    function RulithSettingsEntry({ wide }) {
      const [state] = usePoll("state", 5000);
      const status = computerStatus(state);
      return h("button", { type: "button", "data-rulith-settings-entry": "", title: "设置 · " + status.text,
          onClick: () => openSettings(state && state.ok && !state.signedIn ? "account" : undefined),
          style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", marginTop: 6, border: "1px solid rgba(127,127,127,.35)",
            borderRadius: 8, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" } },
        dot(status.color),
        wide ? h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, status.text) : null,
        h("span", { "aria-hidden": "true", style: { opacity: 0.75 } }, "⚙"), wide ? h("span", { style: { opacity: 0.75 } }, "设置") : null);
    }

    // ---- The empty conversation page (design §3.2 首次打开): one line above the input, no brand animation, no preview
    // badge. dsh draws its headline, badge and workspace chip itself; the line is the brand-mark slot's occupant, and the
    // rest of dsh's headline row and its workspace row are hidden (folders are chosen in the sidebar).
    const EMPTY_PAGE_CSS = 'span:has(> [data-slot="conversation.hero.brand.mark"]) + span,div:has(> [data-slot="conversation.hero.workspace"]){display:none!important}';
    function installEmptyPageStyle() {
      if (typeof document === "undefined" || !document.head || document.querySelector("style[data-rulith-empty-page]")) return () => {};
      const tag = document.createElement("style");
      tag.setAttribute("data-rulith-empty-page", "");
      tag.textContent = EMPTY_PAGE_CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }
    function makeEmptyLine(selection) {
      return function RulithEmptyLine() {
        const current = useStore(selection);
        return h("span", { "data-rulith-empty": "" }, current && current.sessionId ? "说出你要做的事" : "在左侧的智能体下开一个新会话");
      };
    }

    const RulithArtwork = () => h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
      borderRadius: 7, background: "#2ea36b", color: "#fff", fontWeight: 800, fontSize: 16 } }, "R");

    // Own the shell, not just the inner brand slots: dsh's shell wraps them in startSession().
    function RulithSidebar({ collapsed, toggleSidebar, renderSlot }) {
      const wide = !collapsed;
      return h("div", { "data-rulith-sidebar": "", style: { height: "100%", display: "flex", flexDirection: "column",
          boxSizing: "border-box", padding: 8, background: "var(--dsw-specific-sidebar-fill)", color: "var(--dsw-alias-label-primary)" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0" } },
          h("span", { "data-rulith-brand": "", style: { display: "inline-flex", alignItems: "center", gap: 8, flex: 1, fontWeight: 700 } },
            h(RulithArtwork), wide ? "Rulith" : null),
          h("button", { type: "button", onClick: toggleSidebar, "aria-label": wide ? "收起侧边栏" : "打开侧边栏", style: tiny }, wide ? "‹" : "›")),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto" } }, renderSlot("sidebar.workspaces", { wide, expandSidebar: () => { if (collapsed) toggleSidebar(); } })),
        renderSlot("sidebar.footer.action", { wide }),
        renderSlot("sidebar.settings", { wide }));
    }

    // dsh 0.2.1-alpha.1 file mention grammar. File contents remain behind Rulith Actions.
    function fileMention(path, directory, quoted) {
      const value = path + (directory ? "/" : "");
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return undefined;
      return quoted || /\s/u.test(value) ? '@"' + value + (directory ? "" : '"') : "@" + value;
    }
    function makeFileReferenceSource(ctx) {
      const fileValue = (label, mention, directory) => JSON.stringify({ kind: "file", label, mention, directory });
      return {
        trigger: "@", name: "reference", showGroupTitle: false,
        async candidates(session, { query, quoted, drilled, signal }) {
          if (ctx.sessions.binding(session.sessionId) === undefined) throw new Error("file references require a retained session");
          const items = await ctx.sessions.using(session.sessionId, { source: "referenceCandidates", signal }, async (reference) => {
            signal.throwIfAborted();
            const state = reference.binding.session.getSnapshot();
            if (state.openState !== "open") throw state.openError || new Error("session is not open");
            const reply = await ctx.remote.fileReferences.list(session.sessionId, query, signal);
            return reply.ok ? reply.value : [];
          });
          if (signal.aborted) return [];
          return items.flatMap((entry) => {
            const directory = entry.kind === "directory", mention = fileMention(entry.path, directory, quoted);
            if (mention === undefined) return [];
            const slash = entry.path.lastIndexOf("/"), label = entry.path.slice(slash + 1);
            return [{ name: label + (directory ? "/" : ""), icon: directory ? "folder" : "file", section: "文件与文件夹",
              ...(!drilled && slash >= 0 ? { description: entry.path.slice(0, slash) } : {}),
              value: fileValue(label, mention, directory), ...(directory ? { drill: true } : {}) }];
          });
        },
        header(_session, { query, quoted, drilled }) {
          if (!drilled || !query.includes("/")) return undefined;
          const parts = query.slice(0, query.lastIndexOf("/")).split("/").filter(Boolean);
          return [{ label: "工作区", value: fileValue("工作区", quoted ? '@"' : "@", true) },
            ...parts.map((label, i) => ({ label, value: fileValue(label, fileMention(parts.slice(0, i + 1).join("/"), true, quoted), true),
              ...(i === parts.length - 1 ? { current: true } : {}) }))];
        },
        onPick({ candidate, action }) {
          const value = candidate.value && JSON.parse(candidate.value);
          if (!value || value.kind !== "file") return undefined;
          if (value.directory && action === "drill") return { text: value.mention, continue: true };
          return { insert: { source: "reference", ref: value.mention, label: value.label + (value.directory ? "/" : ""),
            appearance: value.directory ? "folder" : "file", clipboardText: value.mention } };
        },
        // The document-preview provider is disabled. File chips still insert and serialize normally.
        openReference: () => false,
        codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(ref) }
      };
    }
    // Design §6: the right column opens at most a third of the window wide, and the conversation keeps at least CENTER_MIN
    // px beside the sidebar's default width. dsh opens it at 45 % of the window (dsh-client-ui-layout RIGHTBAR_DEFAULT_RATIO)
    // and has no setting for it, so the app sets that first width once per page load through the layout face's panel
    // actions (dsh 0.2.1-alpha.1, which the app pins); a width the person drags to afterwards stays. 300 px is dsh's own
    // minimum, and dsh itself still keeps 400 px for the conversation when the window is narrow. Pure.
    const CENTER_MIN = 560, SIDEBAR_WIDTH = 280;
    function rightColumnWidth(viewport, sidebar = SIDEBAR_WIDTH) {
      const width = Number(viewport) || 0;
      return Math.max(300, Math.min(Math.floor(width / 3), width - sidebar - CENTER_MIN));
    }
    function fitRightColumn(layout) {
      try {
        const panels = layout && layout.panels;
        if (panels && typeof panels.setRightbar === "function" && typeof window.innerWidth === "number") panels.setRightbar(rightColumnWidth(window.innerWidth));
      } catch (error) { console.warn("Rulith: could not set the right column's width", error); }
    }

    function apply(ctx) {
      ctx.inject(["layout"], (inner) => {
        fitRightColumn(inner.layout);
        const inject = () => ({ toggleSidebar: () => inner.layout.toggleSidebar() });
        inner.slots.inject("sidebar", () => inner.slots.register({ name: "sidebar", inject, children: {
          "sidebar.workspaces": { kind: "single", scope: "root" },
          "sidebar.settings": { kind: "single", scope: "root" },
          "sidebar.footer.action": { kind: "list", scope: "root" }
        } }, RulithSidebar));
        inner.slots.inject("shell.leading", () => inner.slots.register({ name: "shell.leading", inject },
          ({ toggleSidebar }) => h("button", { type: "button", style: tiny, onClick: toggleSidebar, "aria-label": "切换侧边栏" }, "☰")));
      });
      ctx.inject(["inputTriggers", "sessions", "remote.fileReferences"], (inner) => {
        inner.effect(() => inner.inputTriggers.registerSource(makeFileReferenceSource(inner)));
      });
      // dsh's theme and language services for settings → 外观与语言, while they are composed.
      for (const name of ["theme", "locale"]) ctx.inject([name], (inner) => {
        shared[name] = inner[name];
        inner.effect(() => () => { if (shared[name] === inner[name]) shared[name] = undefined; });
      });
      // Historical children remain ordinary transcript views, with no way to restart delegation.
      ctx.slots.inject("conversation.composer", () => ctx.slots.register({ name: "conversation.composer", priority: -10,
        select: (owner) => owner.session?.origin === "subagent" || owner.session?.subagent ? {} : null },
        () => h("div", { "data-rulith-child-history": "", role: "note", style: { padding: 12 } }, "历史子会话（只读）")));
      // Three columns: the Agents and their conversations, the conversation, and on the right its 任务 panel (design §3.1).
      // The 任务 panel is the right sidebar's entry, and every session opens with it.
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "builtin", title: () => "任务",
        guide: [{ id: "rulith", commandId: "rulith.panel", order: 1, title: () => "任务",
          description: () => "任务、验收标准、最近操作和这台电脑", icon: RulithArtwork }] }));
      let revealed = false;
      const ensureColumn = () => setTimeout(() => {
        try {
          const session = ctx.sidebarRight.mounted.getSnapshot();
          if (session === undefined) return;
          if (!ctx.sidebarRight.tabsIn(session).some((tab) => tab.kind === TAB_KIND)) ctx.sidebarRight.openTabIn(session, TAB_KIND, {});
          // Shown once per page load; a person who collapses it keeps it collapsed.
          if (!revealed) { revealed = true; if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); }
        } catch (error) { console.warn("Rulith: could not open the 任务 panel", error); }
      }, 0);
      ctx.effect(() => ctx.sidebarRight.mounted.subscribe(ensureColumn));
      ensureColumn();
      ctx.inject(["shortcuts"], (inner) => {
        inner.effect(() => inner.shortcuts.register({ id: "rulith.panel", label: () => "任务", aliases: ["rulith", "task", "board", "worker"],
          defaults: {}, regions: ["page", "editable", "terminal"], modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element);
            if (target === void 0) return { status: "blocked", reason: "先打开一个会话" };
            return { status: "handled", run: () => ctx.sidebarRight.openTabFromTarget(TAB_KIND, target) };
          } }));
      });
      // The one settings entry (the sidebar foot) and the settings page; dsh's settings shell is off in the overlay.
      ctx.slots.inject("sidebar.settings", () => ctx.slots.register({ name: "sidebar.settings" }, RulithSettingsEntry));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "rulith-settings" }, RulithSettings));
      // The signing confirmation of the 任务 panel, over the whole page.
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "rulith-sign" }, SignDialog));
      ctx.effect(() => installEmptyPageStyle());
      // The Agent -> directory -> conversation browser, the first-run wizard and the empty page's line, once dsh's
      // navigation and stores are up.
      ctx.inject(["uiWorkspace", "sessions", "workspaces"], (inner) => {
        const services = { ui: inner.uiWorkspace, sessions: inner.sessions, workspaces: inner.workspaces };
        const RulithTree = makeRulithTree(services);
        inner.slots.inject("sidebar.workspaces", () => inner.slots.register({ name: "sidebar.workspaces", priority: -1 }, RulithTree));
        const RulithWizard = makeRulithWizard(services);
        inner.slots.inject("shell.overlay", () => inner.slots.register({ name: "shell.overlay", id: "rulith-wizard" }, RulithWizard));
        const RulithEmptyLine = makeEmptyLine(inner.uiWorkspace.selection);
        inner.slots.inject("conversation.hero.brand.mark", () => inner.slots.register({ name: "conversation.hero.brand.mark" }, RulithEmptyLine));
      });
      // Session-scoped slot: dsh hands the registrant the session id positionally.
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "rulith-conversation",
        inject: (sessionId) => ({ sessionId }) }, RulithComposerControls));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID,
        inject: () => ({ mountedSession: ctx.sidebarRight.mounted }) }, RulithColumn));
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID, inject: () => ({}) }, () => h("span", null, "任务")));
    }
    exports.apply = apply;
    exports.buildTree = buildTree;
    exports.makeRulithTree = makeRulithTree;
    exports.makeRulithWizard = makeRulithWizard;
    exports.makeFileReferenceSource = makeFileReferenceSource;
    exports.projectConfirmation = projectConfirmation;
    exports.openProjectFlow = openProjectFlow;
    exports.refusalText = refusalText;
    exports.progressText = progressText;
    exports.deletionOutcome = deletionOutcome;
    exports.wizardSteps = wizardSteps;
    exports.setupSteps = setupSteps;
    exports.replaceConfirmation = replaceConfirmation;
    exports.runSetup = runSetup;
    exports.signInFlow = signInFlow;
    exports.computerStatus = computerStatus;
    exports.workerWords = workerWords;
    exports.conversationTier = conversationTier;
    exports.settingsView = settingsView;
    exports.signView = signView;
    exports.taskPanelModel = taskPanelModel;
    exports.operationLine = operationLine;
    exports.signOutcome = signOutcome;
    exports.signAcceptanceFlow = signAcceptanceFlow;
    exports.unconfirmedSignatures = unconfirmedSignatures;
    exports.rightColumnWidth = rightColumnWidth;
    exports.SIGN = SIGN;
    exports.components = { ModelForm, SetupSteps, FolderChooser, ProjectDialog, AccountSection, ComputerSection, AppearanceSection,
      AdvancedSection, SettingsPage, RulithSettings, RulithSettingsEntry, RulithComposerControls, RulithColumn, RulithSessionColumn, SignDialog };
    exports.SETTINGS_SECTIONS = SETTINGS_SECTIONS;
    exports.EMPTY_PAGE_CSS = EMPTY_PAGE_CSS;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    return module.exports;
  }
});
