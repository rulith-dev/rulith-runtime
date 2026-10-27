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

    // ---- Every word the app shows, one table per language (D-1025b, 2026-10-25): English is the default and the normative
    // text (PSC 0.2.32; docs/ui-texts-english.md lists it), Chinese a rendering shown when the browser's language is
    // Chinese. Where Console already has an approved English sentence for the same meaning it is used verbatim, so the
    // app and Console say the same thing: signing is Console Text A, widening is Text 9 and the non-strict confirmation,
    // the post-call review chip and deleting a conversation follow Console's Conversations texts. `{name}` marks a value
    // filled in when the text is shown (fill). The model's own texts (persona, addendum, tool texts) are not here and
    // do not change with the language.
    // 中文说明：页面上的每一句话都在这张表里，英文是默认与规范文字，中文只在浏览器语言为中文时显示，不再逐字固定。
    const TEXTS = {
      en: {
        // Punctuation the page puts between its own words and a service's (a reason after a sentence, a list).
        p: { colon: ": ", stop: ".", semi: "; ", list: ", ", open: " (", close: ")", dot: " · " },
        common: { reading: "Reading…", connectError: "Could not reach Rulith on this computer", unnamedComputer: "unnamed computer",
          default: " (default)" },
        signIn: { notFinished: "Sign-in has not finished: approve it on the Rulith page that opened, then choose Sign in again.",
          failed: "Sign-in did not succeed.", waiting: "Waiting for approval in the browser…", button: "Sign in to Rulith" },
        status: { notConnected: "Rulith on this computer is not connected", notSignedIn: "Not signed in to Rulith",
          online: "This computer is online", offline: "This computer is offline", notSetUp: "This computer is not set up yet" },
        worker: { notSetUp: "Not set up", online: "Online", notEnabled: "Not turned on for it on this computer", offline: "Offline" },
        setup: {
          steps: { connect: "Connect to Rulith", kit: "Install the coding tools", worker: "Turn on this computer", reload: "Reload", ready: "Done" },
          reasons: {
            not_signed_in: "This computer is not signed in to Rulith: sign in under Account in Settings first.",
            agent_not_in_account: "This Agent is not in the signed-in account, or Console no longer opens it to this computer.",
            runtime_credential_exists: "This Agent's key is in use elsewhere (another computer or another client holds it). It was not replaced, and nothing was changed.",
            connection_rejected: "Rulith no longer accepts the key this computer saved for this Agent (it may have been replaced or revoked in Console). Nothing was changed, and this computer did not turn it on again.",
            connection_missing: "This computer remembers this Agent, but the key it saved for it is gone. Nothing was changed.",
            worker_taken_over: "Another process took over this Agent's work on this computer, so this computer stopped it and did not turn it on again. Choose “Set up on this computer” under This computer in Settings to turn it on here again.",
            local_setup_connection_in_use: "This Agent is working on another computer, so this computer did not connect to it and did not create another copy; this setup was withdrawn. Once that computer stops (or its hold expires), choose “Set up on this computer” again.",
            setup_request_conflict: "This setup conflicted with another one: choose “Set up on this computer” again.",
          },
          consequence: "The Agent's previous key stops working at once: clients still using it (including on another computer) stop working, and must be set up again there to go on. Replacing it grants no folder or tool permission.",
          inUseTitle: "Replace this Agent's key?",
          inUseLines: ["This Agent already has a valid key, in use on another computer (or another client).",
            "After replacing it, this computer is set up with the new key and a connection of its own; that computer's connection is not taken."],
          inUseAccept: "Replace the key and go on", inUseCancel: "Don't replace",
          reconnectTitle: "Reconnect this computer?",
          reconnectLine: "Reconnecting gives this computer a new key, delivered here; the projects open on this computer and their grants stay as they are.",
          reconnectAlso: "This also replaces this Agent's key. {consequence}",
          reconnectAccept: "Replace the key and reconnect", reconnectCancel: "Don't reconnect",
          stillRunning: "Setup is still running: look again later under This computer in Settings.",
          failed: "Setup did not succeed.",
          progressUnread: "Could not read the setup's progress: {error}. Setup may still be running; look again later.",
          starting: "Starting setup…", stepFailed: "“{step}” did not finish", done: "Set up on this computer; no restart needed.",
          setUp: "Set up on this computer", settingUp: "Setting up…",
        },
        model: {
          reading: "Reading the model settings…", unreadable: "Could not read the model settings.", notSaved: "Not saved.",
          saved: "Saved. It applies from the next turn.", savedNoKey: "Saved, but not usable yet: enter the key (a model at a local address may need none).",
          notSavedError: "Not saved: {error}", current: "In use: {name} · {host}", none: "No usable model is set yet.",
          address: "Address", modelId: "Model ID", key: "Key", keySaved: "Saved; leave empty to keep it", keyPlaceholder: "API key",
          hint: "An OpenAI-compatible address, or an Anthropic address ending in /messages; a model on this computer can use http://127.0.0.1:port/v1. Saved, it applies from the next turn without a restart; the key stays on this computer and is never shown again.",
          saving: "Saving…", save: "Save",
          // The context window the model's conversations are measured against (0.19.3) and where it comes from.
          window: "Context window: {tokens} tokens ({source})",
          windowSources: { detected: "detected from the model server", set: "set by you", developer: "from the settings file",
            assumed: "assumed: the model server did not report it", default: "the default" },
          windowAssumed: "Enter the context size this model server allows per request, so Rulith shortens the conversation before the server refuses it.",
          windowField: "Context window (tokens)", windowEmpty: "Leave empty to use {tokens}",
          windowTooSmall: "Rulith needs a context window of at least {min} tokens, so this one is too small. Raise the context size on the model server (llama.cpp -c, Ollama num_ctx, the context length in LM Studio), then save the model again.",
        },
        // Signing proposed criteria: Console Text A (PSC 0.2.17), verbatim where Console has the sentence.
        sign: {
          title: "Proposed acceptance criteria", button: "Sign these criteria",
          body: "You are signing these criteria as the acceptance for this goal. The Agent proposed them; from now on it cannot end or change them, and the goal completes only when every criterion holds on the current state. This is your decision under your account.",
          accept: "Sign", cancel: "Not yet", signed: "Signed.", pending: "The signature's result is not confirmed yet; this refreshes on its own.",
          unreadable: "The criteria awaiting your signature cannot be read right now", signing: "Signing…",
          refused: "Nothing was signed: {teaching}.", unavailable: "These criteria cannot be signed for this goal: {category}.",
          truncated: "This task has too many criteria to list here; sign them in Console.",
          moreInConsole: "More tasks await your signature than are listed here: see them in Console.",
          replaced: "Will be replaced", notCriterion: "Not a criterion", unknownReason: "the reason is unknown; try again later",
          stale: "The previous signature's result is not confirmed yet; it signed the earlier criteria.", signedMark: "Signed",
        },
        // Why nothing was signed, by the Kernel's refusal code ({teaching} and {category} above).
        signReasons: {
          unknown_goal: "this task was not found", goal_ended: "this task has ended", goal_paused: "this task is paused",
          contract_fixed: "this task's acceptance criteria are set by its capability and need no signature",
          leaf_not_proposed: "these criteria have changed; look at the latest ones and sign again",
          criterion_unsupported: "one of them cannot be an acceptance criterion",
          goal_pending_obligations: "this task still has unfinished work; sign later",
        },
        // An operation in plain words (the task panel's recent operations and the conversation's tool-call lines).
        ops: {
          onFile: { read: "Read {file}", read_image: "Read {file}", write_file: "Write {file}", patch_file: "Edit {file}" },
          refusals: { sourceRevoked: "the project's grant was withdrawn", workerOffline: "this computer is offline", personRefused: "you refused this operation",
            boardSealed: "this conversation is deleted", goalPaused: "the task is paused", goalEnded: "the task has ended",
            needsSetup: "this operation is not turned on yet", lawLock: "the rules are locked", governancePending: "the Agent's settings are taking effect",
            boardDraining: "writes are paused now", ruleBlocks: "the current conditions do not allow it", reviewBlocked: "the review did not pass" },
          execute: "Run an operation", endTask: "End the task", startTask: "Start a task", startTaskNamed: "Start the task “{label}”",
          completed: "Task completed (acceptance passed)", record: "Record evidence", readResult: "Read a result", viewProgress: "Check progress",
          proposeCriteria: "Propose acceptance criteria", breakDown: "Break the task down", preparing: "Preparing an operation…",
          error: "{verb}: error", passed: "{verb}: passed", notPassed: "{verb}: did not pass", failed: "{verb}: failed",
          failedWhy: "{verb}: failed ({why})", refusedWhy: "Refused: {why}", refused: "{verb}: refused",
          unknown: "{verb}: result unknown, reconcile it in Console", atWorker: "{verb}: running on this computer", running: "{verb}: in progress",
          waiting: "{verb}: waiting for your decision", needsPerson: "{verb}: needs you to reconcile it in Console", stopped: "{verb}: stopped",
          showEvidence: "Show evidence", hideEvidence: "Hide evidence", reason: "Reason", receipt: "Receipt", result: "Result",
          thisCall: "This call", raw: "Full original text", empty: "(empty)",
        },
        // The tools of the official engineering capability, in plain words (operation lines and the project confirmation).
        tools: { read: "read files", read_image: "read images", list: "list files", glob: "find files by name", search: "search file contents",
          tree_state: "see the folder's changes", write_file: "write files", patch_file: "edit files", apply_patch: "edit files by patch",
          run: "run commands", test: "run tests", job_start: "run commands in the background", job_poll: "check background commands",
          job_stop: "stop background commands", acceptance: "run acceptance checks" },
        // The right column's task panel.
        panel: {
          unreadable: "Could not read Rulith",
          notConnected: "Rulith is not connected yet: sign in, then choose “Set up on this computer” for an Agent on the left.",
          noBoard: "This conversation has not started a task yet. Say what you want done; once it starts, its task, acceptance criteria and recent operations show here.",
          deleted: "This conversation is deleted and cannot continue. Its receipts and records are kept and can be read in Console's task records.",
          unnamedTask: "(Unnamed task)",
          goal: { running: "Running", paused: "Paused", completed: "Completed (acceptance passed)", ended: "Ended" },
          awaitingSignature: "Waiting for your signature", awaitingDecision: "Waiting for your decision", statusUnread: "Status not read",
          aCriterion: "An acceptance criterion", byCapability: "Set by the capability", signed: "Signed", unsigned: "Not signed",
          decisionConsole: "An operation's result needs you to reconcile it in Console.", decisionWaiting: "An operation is waiting for your decision.",
          agentWaiting: "This Agent has an operation waiting for your decision.", agentConsole: "An operation of this Agent needs you to reconcile its result in Console.",
          agent: "Agent: {name}", refresh: "Refresh", goConsole: "Handle in Console", inConsole: "Handle it in Console.",
          tasks: "Tasks", tasksUnreadable: "This conversation's tasks cannot be read right now: they show here once its next result arrives.",
          tasksNext: "This conversation's tasks show here once its next result arrives.", acceptInConsole: "Accept in Console",
          noTasks: "No tasks yet: say what you want done; once it starts, it shows here.",
          criteria: "Acceptance criteria and status", holds: "Holds", notHolds: "Does not hold", holdsUnread: "Not read yet whether it holds",
          criteriaLater: "Acceptance criteria show here once they are read.", noCriteria: "No acceptance criteria yet.",
          recent: "Recent operations", noOps: "No operations yet.", computer: "This computer",
          computerStates: { reading: "Reading…", unread: "Could not be read", online: "Online", offline: "Offline" }, viewInSettings: "View in Settings",
        },
        // The composer's chips: exploration mode (Console's names), model and post-call review.
        tier: { label: "Mode: ", fresh: "Default", unreadable: "Unconfirmed", mixed: " (mixed)",
          menu: "This conversation's exploration mode · narrowing applies at once, widening asks first",
          menuMixed: "This conversation's exploration modes differ: the strictest is shown; choose one to make them the same",
          menuFresh: "This conversation has not used Rulith yet: the mode you choose applies, starting from the Agent's mode; widening asks first",
          accepted: "Accepted, not in effect yet", betweenCalls: "Accepted, not in effect yet: it takes effect when this call ends",
          later: "Accepted, not in effect yet; look again later", notSwitched: "Not switched", notAccepted: "This switch was not accepted",
          title: "This conversation's exploration mode (changes only this conversation)" },
        modeWords: { strict: "Strict", derived: "Derived", non_strict: "Non-strict" },
        modeHints: { strict: "Writes and runs need trusted facts first", derived: "Writes and runs go ahead when a rule derives a warrant for them",
          non_strict: "The model's commands and inputs run as given; completion still needs your signature" },
        // Widening: Console's non-strict confirmation and Text 9 (PSC 0.2.5, 0.2.9), verbatim.
        widen: {
          non_strict: { title: "Switch to non-strict exploration mode?", accept: "Switch to non-strict", cancel: "Keep strict",
            body: "Write and run actions of this environment's tools will accept inputs the model supplies, even when no trusted fact on the Board backs them. Each such call is marked \"Inputs not grounded\". Calls that need your decision never run without it, writes stay inside the locations you authorized, and tools you have not locked stay unavailable. You can switch back at any time." },
          derived: { title: "Switch to derived exploration mode?", accept: "Switch to derived", cancel: "Keep strict",
            body: "The model will be able to write and run in this environment's workspace whenever it can derive, from facts and rules it writes on the Board, a warrant for that action and its key inputs. Those facts do not have to be trusted evidence. Calls that need your decision never run without it, and writes stay inside the local workspace." },
        },
        // Why a mode or review switch was refused, by the code its route returns (shared by both switches).
        switchRefusals: {
          exploration_control_pending: "This conversation's exploration mode is still narrowing. Nothing was changed; try again later.",
          control_pending: "The previous setting has not finished. Nothing was changed; try again later.",
          agent_call_pending: "The Agent still has a call that has not ended or awaits reconciliation; change this after it ends. Nothing was changed.",
          observation_in_progress: "An observation has no result yet; try again once it does. Nothing was changed.",
          configuration_unconfirmed: "The Agent's settings are taking effect; try again later. Nothing was changed.",
          conversation_ended: "This conversation is deleted and can no longer be changed.",
          board_unavailable: "This conversation's record cannot be read. Nothing was changed; try again later.",
          request_conflict: "This request conflicted with an earlier one. Nothing was changed; choose again.",
          exploration_mode_unconfirmed: "This conversation's current exploration mode cannot be read. Nothing was changed; try again later.",
          conversations_unavailable: "The conversation setting's result could not be confirmed; try again.",
          device_revoked: "This computer's sign-in is no longer valid; sign in again at the bottom left.",
          device_unauthenticated: "This computer's sign-in is no longer valid; sign in again at the bottom left.",
          unauthenticated: "This computer's sign-in is no longer valid; sign in again at the bottom left.",
          not_authorized: "This computer's sign-in is not authorized to use this Agent.",
          agent_not_found: "This Agent is not available now.",
          not_signed_in: "This computer is not signed in to Rulith: sign in at the bottom left first.",
          manager_signing_out: "This computer is signing out of Rulith, so this cannot be changed now.",
          manager_closing: "Rulith on this computer is closing, so this cannot be changed now.",
        },
        // Only on the mode switch. D-1026a: derived mode no longer needs post-call review or a reviewer, so the only reason
        // left is that the model may not write rules.
        tierRefusals: { derived_mode_unavailable: "Derived mode needs permission for the model to write rules." },
        composer: { ended: "This conversation is deleted and cannot continue",
          modelTitleOverride: "This Agent uses its own model setting; opens the account's model settings",
          modelTitle: "The model this conversation uses next turn; opens Settings to change it", model: "Model: {name}", modelNotSet: "not set",
          reviewTitle: "This conversation's post-call review (changes only this conversation)", review: "Review: {state}",
          reviewDefault: "Default", reviewOn: "On", reviewOff: "Off", reviewMenu: "Post-call review of this conversation's write calls, from the next call",
          reviewOnItem: "On: write calls go to the reviewer", reviewOffItem: "Off: this conversation is not reviewed" },
        // Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01): the confirmation, why it was refused, and its progress.
        project: {
          incomplete: "What was read about this opening is incomplete, so you cannot be asked to confirm it. Try again later.",
          unexplained: "This version of the Rulith app cannot explain the mode it would set, so you cannot be asked to confirm it. Update the Rulith app first.",
          modeMeaning: { non_strict: "New conversations on this computer use Non-strict mode by default: the model's commands and inputs run without needing evidence first; whether a task is done is still decided only by the acceptance criteria you sign." },
          title: "Open this folder as a project?", folder: "Folder", agent: "Agent", agentValue: "{agent} · this computer {computer}",
          canDo: "What it may do", canDoValue: "Read files, write files and run commands (including tests and builds) in this folder.",
          tools: "Tools used", fromCapability: "From this Agent's installed official engineering capability.", mode: "Exploration mode",
          // PSC 0.2.31 ④ (in force), verbatim: it replaces the 0.2.24 sentence that the folder is not OS-level isolation.
          note: "Note", noteValue: "On this computer, reading, writing and running commands in this project folder are carried out by the Agent's engineering capability. Commands run without this computer's keys or tokens in their environment, and tool access to loopback and private network addresses (including this computer's manager and app ports) is refused. By system: on Windows, commands run at low integrity and cannot read the folders where Rulith keeps its credentials; this folder is writable for commands while it is open, and its previous setting is restored when it is revoked or this computer is deactivated. On Linux, commands can write only this project folder and their tool folder, the system is read-only, Rulith's credential folders are hidden, the network stays available, and background jobs end with the tool call that started them. On macOS, commands are not yet isolated on this computer. If isolation cannot be set up, commands do not run (unless you chose \"Run without isolation (not recommended)\" in Settings). The non-strict tier means the commands and arguments the model gives no longer need grounds on the Board; whether the work is done is still certified only by the acceptance contract you sign. To revoke: unlock this project in Console, or deactivate this computer.",
          withdraw: "How to withdraw", withdrawValue: "To withdraw it later, withdraw the grant on this project's row of this Agent's page in Console, or revoke this computer's sign-in.",
          account: "Account", toolsVersions: "Tools and versions", capability: "Official engineering capability {id}", connection: "Local connection",
          footer: "Existing conversations are not affected. Once it is open, a new conversation starts in this folder.",
          accept: "Open project", cancel: "Cancel", details: "Details",
          refusals: {
            not_authorized: "This computer's sign-in is not authorized to use this Agent.",
            account_changed: "The account this computer is signed in to is not the one shown a moment ago. Refresh, then open it again.",
            connection_not_of_this_device: "This Agent's connection on this computer was not set up by this computer. Choose “Set up on this computer” for this Agent on the left again.",
            connection_not_found: "This Agent is not set up on this computer yet. Choose “Set up on this computer” for it on the left.",
            agent_not_found: "This Agent is not available now.",
            client_authority_refused: "The request carried something only the service may decide, so it was refused. Nothing was changed.",
            device_revoked: "This computer's sign-in is no longer valid. Sign in again at the bottom left.",
            device_expired: "This computer's sign-in has expired. Sign in again at the bottom left.",
            device_unauthenticated: "This computer's sign-in is no longer valid. Sign in again at the bottom left.",
            unauthenticated: "This computer's sign-in is no longer valid. Sign in again at the bottom left.",
            official_capability_not_installed: "This Agent does not have the official engineering capability installed, so it cannot open projects.",
            official_capability_invalid: "The official engineering capability this Agent has installed is incomplete, so it cannot open projects.",
            project_directory_in_use: "This folder is already held by another grant on this computer; this needs handling in Console. Nothing was changed.",
            project_nested: "This folder is inside an open project, or contains one. Choose a folder that does not overlap an open project.",
            platform_mismatch: "This path is not written the way the folders open on this computer are.",
            worker_tools_unavailable: "This computer has not reported the tools it needs yet. Choose “Set up on this computer” for this Agent under This computer in Settings, then try again.",
            worker_tools_mismatch: "The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.",
            worker_tool_contract_missing: "The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.",
            worker_tool_not_direct: "The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.",
            worker_tool_pin_conflict: "Another version of a tool with the same name is already locked on this computer; this needs handling in Console. Nothing was changed.",
            project_unavailable: "The project's state cannot be confirmed now. You can open this folder again on the left later: it continues from where it is, or asks you to confirm again.",
            not_signed_in: "This computer is not signed in to Rulith, or its sign-in can no longer be used: sign in at the bottom left first.",
            manager_signing_out: "This computer is signing out of Rulith, so it cannot open projects now.",
            manager_closing: "Rulith on this computer is closing, so it cannot open projects now.",
            authorization_changed: "What would be granted changed after you confirmed. Open it again and confirm again.",
            runtime_credential_exists: "This Agent's key is in use on another computer (or another client), and this computer is not set up yet. Choose “Set up on this computer” for it under This computer in Settings, confirm the replacement, then open the folder again. Nothing was changed.",
            connection_rejected: "Rulith no longer accepts the key this computer saved for this Agent (it may have been replaced or revoked in Console), and this computer stopped it. Choose “Set up on this computer” for it under This computer in Settings, confirm reconnecting, then open the folder again. Nothing was changed.",
            connection_missing: "The key this computer saved for this Agent is gone. Choose “Set up on this computer” for it under This computer in Settings, confirm reconnecting, then open the folder again. Nothing was changed.",
            worker_taken_over: "Another process took over this Agent's work on this computer, and this computer stopped it. Choose “Set up on this computer” for it under This computer in Settings, then open the folder again.",
            local_setup_connection_in_use: "This Agent is working on another computer; this computer did not connect to it and did not create another copy. Once that computer stops (or its hold expires), choose “Set up on this computer” for it under This computer in Settings, then open the folder again.",
          },
          // Why the service refuses a folder (Gateway ProjectDirectory's fixed sentences), in the page's words.
          folderWords: {
            wholeDrive: "A whole drive or share cannot be opened as a project; choose a folder in it.",
            root: "The filesystem root cannot be opened as a project; choose a folder.",
            colon: "A folder name cannot contain a colon.",
            loopback: "This network path points back at this computer or at an administrative share; use the folder's ordinary path, such as D:\\folder.",
            backslash: "A backslash in this path names another folder on Windows; choose a folder whose path has no backslash.",
            slashes: "A path starting with // is a network share on Windows; write it as \\\\server\\share\\folder.",
            device: "A device path cannot be opened as a project; use the folder's ordinary path, such as D:\\folder.",
            share: "A network path must name a server and a share.",
            windows: "This computer runs Windows; choose a folder such as D:\\folder.",
            notWindows: "This computer is not Windows; choose a folder such as /home/you/folder.",
          },
          badFolder: "This folder cannot be opened as a project", notOpened: "Project not opened",
          again: {
            mode_changed: "After opening, this computer's exploration mode was changed back (perhaps in Console). Retrying would not widen it for you; to go on, confirm again.",
            opened_elsewhere: "This folder's opening was not confirmed on this computer. To use it here, confirm again.",
            mode_refused: "Setting the exploration mode to Non-strict did not succeed several times. To go on, confirm again.",
            revoked: "This folder's project grant has been withdrawn. To grant it again, confirm again.",
            other: "This opening did not finish. To go on, confirm again.",
          },
          step: "(step {n} of 3) ", agentCall: "The Agent still has a call that has not ended; opening goes on once it ends…",
          modeRetry: "Setting the mode did not succeed; retrying…", configuration: "Recording the project folder and the tools it uses…",
          program: "Waiting for the new settings to take effect…", modeStage: "Setting new conversations on this computer to Non-strict…",
          opening: "Opening the project…",
          later: "You can open this folder again on the left later: it continues from where it is, or asks you to confirm again.",
          changed: "What would be granted changed after you confirmed. Look at it again.", stopped: "Stopped waiting. {later}",
          manyTimes: "This folder did not open after several tries: {again}", notYet: "Not open yet: {progress} {later}",
          assignFailed: "Could not record this conversation's Agent",
        },
        folder: { open: "📂 Open folder…", choose: "📂 Choose folder…", pickerUnavailable: "Could not open the folder chooser: type the path instead.",
          path: "The folder's full path, such as D:\\work\\game or /home/you/game", openButton: "Open", cancel: "Cancel",
          pickTitle: "Choose a folder with the system's folder chooser and open it as this Agent's project",
          picking: "Choose the folder in the window that opened…", typePath: "Type the path", stopWaiting: "Stop waiting" },
        // The left column: Agents, their folders and conversations, and deleting a conversation (Console's Conversations texts).
        tree: {
          otherFolder: "Other folder", ago: { now: "just now", minutes: "{n} min", hours: "{n} h", days: "{n} d" },
          newConversation: "New conversation", untitled: "Untitled conversation", recordUnreadable: "Could not read this conversation's record",
          deletePending: "This conversation still has a call without a result. Settle it first; nothing was changed.",
          notDeleted: "Not deleted", partial: "Not deleted yet: {reasons}. Choose “Finish deleting” on this conversation to go on.",
          deletedRefused: "Deleted. Core refused to close {n} of its goals; they stay open on its ended Board.",
          newFailed: "The new conversation was not created: {error}", projectNotOpened: "Project not opened: {error}",
          notProject: " (not a project yet)", newInFolder: "Start a new conversation in this folder", less: "Show less", more: "More ({n})",
          unsettled: "Not fully deleted: {reasons}", subConversation: "Earlier sub-conversation",
          finishTitle: "The deletion is not finished: {reasons}. The same deletion goes on, without asking again.", finish: "Finish deleting",
          deleteTitle: "Delete this conversation", delete: "Delete", defaultTitle: "This account's default Agent", default: "Default",
          newUnderAgent: "Start a new conversation under this Agent", agents: "Agents",
          newHereTitle: "Start a new conversation under the current Agent and folder", newHere: "+ New conversation",
          filter: "Filter Agents, folders or conversations", readingAgents: "Reading Agents…",
          agentsUnreadable: "Could not read the Agents: sign in to Rulith in Settings at the bottom left first.",
          unowned: "Conversations without an Agent", expand: "Show the Agent list",
          dialogTitle: "Delete this conversation?", introAgent: "Conversation “{title}” belongs to Agent {agent}. Deleting it:",
          intro: "Conversation “{title}”. Deleting it:", sealed: "Its Board is sealed and the conversation cannot continue.",
          goals: "{n} open goals will be closed as abandoned.", kept: "Receipts, proofs, billing and history are kept and stay visible in the Console.",
          undone: "This cannot be undone.",
          notFound: "Conversation “{title}” has not used Rulith yet, so Rulith has no record of it. Deleting only removes it from the list on this computer.",
          keep: "Keep", deleting: "Deleting…",
        },
        // Why a deletion is not finished yet (Console's Conversations texts, PSC 0.2.27 ⑤ and its 0.2.28 erratum).
        deletion: { closings: "{n} goal closings are not confirmed yet", someClosings: "some goal closings are not confirmed yet",
          goalsUnread: "its open goals could not be read", deletedBeforeRecording: "it was deleted before deletions were recorded as finished",
          settlementUnrecorded: "its deletion is not recorded as finished yet", unfinished: "its deletion is not finished yet" },
        wizard: { title: "Get started with Rulith", steps: { signin: "Sign in", model: "Choose a model and enter its key", folder: "Open a folder" },
          notAttached: "This Agent is set up on this computer but not connected to Rulith yet: wait a moment, then choose the folder again.",
          signinLine: "Sign this computer in with your Rulith account: Rulith opens in your browser; approve it there, then come back here.",
          modelLine: "Choose a model service, then enter the model ID and key.",
          folderLine: "Choose a folder as the project: the Agent reads and writes files and runs commands in it. You confirm once before it opens.",
          agentsUnreadable: "Could not read the Agents.",
          noAgents: "This account has no Agent available on this computer: check this computer's sign-in authorization in Console.",
          agent: "Agent: {name}", agentLabel: "Agent: ", chooseAgent: "Choose an Agent", later: "Later" },
        settings: {
          title: "Settings", close: "Close settings", entry: "Settings · {status}",
          sections: { account: "Account", computer: "This computer", model: "Model", appearance: "Appearance and language", advanced: "Advanced" },
          localUnreadable: "Could not read Rulith on this computer.", actionFailed: "The operation did not finish",
          account: "Account", unnamedAccount: "(Unnamed account)", notSignedIn: "Not signed in", signingOut: "Signing out…", signOut: "Sign out",
          computerSignInFirst: "Sign in to Rulith under Account first to set up Agents on this computer.",
          computer: "This computer", unnamedComputer: "Unnamed computer",
          setupHint: "“Set up on this computer” does it in one step: connect this computer, install the coding tools and turn this computer on. One already set up is checked and anything missing is added, with no restart; setting up grants no folder or tool permission.",
          noAgents: "This account has no Agent available on this computer.",
          modelSignInFirst: "Sign in to Rulith under Account first, then set the model.",
          appearance: "Appearance", system: "Follow the system", light: "Light", dark: "Dark", noAppearance: "No appearance setting is available here.",
          language: "Language", languageValue: "English, from your browser's language",
          languageNote: "Rulith and the rest of the page use your browser's language: Chinese when it is Chinese, otherwise English.",
          otherClients: "Other clients",
          otherClientsLine: "Other MCP clients (Claude Code, for example) can reach the same Agent with the Agent's MCP token. Get the token in Console: open this Agent's page and find “Agent MCP token”.",
          openInConsole: "Open the Agent in Console",
        },
        legacy: { one: "1 Agent", many: "{n} Agents",
          notice: "{count} set up by the retired Rulith workbench ({home}) no longer start their Workers with rulith. Run \"rulith manager\" to keep them running, or set each Agent up again here; that replaces its Agent token, and Sources bound to its old Connection must be bound again in Console." },
        // Settings → Advanced: the owner's "Run without isolation (not recommended)" per Agent and its confirmation
        // (PSC 0.2.31 ③ ④, verbatim).
        isolationSwitch: { title: "Model-command isolation", label: "Run without isolation (not recommended)",
          confirmTitle: "Run model commands without isolation?",
          confirmBody: "Commands the model runs through the engineering capability will be able to read everything your account can read on this computer, including Rulith's own credentials. Turn this on only if isolation cannot work here and you accept that risk.",
          accept: "Run without isolation", cancel: "Keep isolation",
          restarting: "Saved. {agent} restarts on this computer to apply it, once any command it is running finishes.",
          nextStart: "Saved. It applies the next time {agent} starts on this computer.", notSaved: "Not saved",
          stopped: "Stopped what model commands had started without isolation: {names}.",
          notStopped: "Could not stop what model commands started without isolation: {names}. Stop them yourself, or restart this computer.",
          notChecked: "Could not check what model commands started without isolation left running: {reason}." },
        // Settings → Advanced → Post-call review (D-1026a): each Agent's default for new conversations, its reviewer and
        // review deadline; `designated` is also the composer's notice when turning review on made this computer the reviewer.
        reviewSettings: { title: "Post-call review",
          explain: "The reviewer reads each write call after it runs and may add advice to its result; it never blocks a call.",
          newConversations: "Review new conversations", reviewer: "Reviewer: {name}", thisComputer: "This computer",
          otherComputer: "Another computer", none: "None",
          useThisComputer: "Use this computer", remove: "Remove reviewer", deadline: "Review deadline (seconds)", save: "Save",
          deadlineRange: "The review deadline is a whole number of seconds from 60 to 300.",
          notHere: "To review on this computer, set this Agent up under This computer first.",
          designated: "This computer now reviews this Agent's write calls, with the Agent's own model.",
          saved: "Saved.", notSaved: "Not saved", unreadable: "Could not read this Agent's review settings." },
        diagnosis: { title: "Diagnosis", reading: "Reading…", unreadable: "Rulith could not read its diagnosis.",
          versions: "Rulith {rulith} · DeepSeek Harness {dsh} · Node.js {node} · {platform}", computer: "This computer: {name} · {signedIn}",
          unnamed: "unnamed", signedIn: "signed in", notSignedIn: "not signed in", starting: "starting", off: "off", notSetUp: "not set up",
          isolation: "Model-command isolation: {text}", unknown: "unknown",
          projectNotProtected: "Project folder not protected: {path} ({reason})", notProtected: "Not protected: {path} ({reason})" },
        shell: { toggleSidebar: "Toggle the sidebar", collapseSidebar: "Collapse the sidebar", openSidebar: "Open the sidebar",
          childHistory: "Earlier sub-conversation (read only)", panel: "Tasks", panelGuide: "Tasks, acceptance criteria, recent operations and this computer",
          openFirst: "Open a conversation first", emptySession: "Say what you want done", emptyNone: "Start a new conversation under an Agent on the left",
          files: "Files and folders", project: "Project" },
        // dsh's own sentences the app replaces (installTextOverrides).
        dsh: {
          "chat:chat.deepDiving": "Working…",
          "chat:chat.deepDivingFor": "Working for {duration} ···",
          "chat:message.failure.accountSignedOut": "Stopped because you signed out.",
          "chat:message.failure.accountSignInRequired": "Sign in first, and make sure the request address supports account authentication.",
          "conversation:placeholder.default": "Say what you want done",
          "conversation:placeholder.hero": "",
          "conversation:placeholder.workspace": "Start a conversation on the left first",
          "conversation:hero.headline": "",
          "conversation:hero.preview": "",
        },
      },
      zh: {
        p: { colon: "：", stop: "。", semi: "；", list: "、", open: "（", close: "）", dot: " · " },
        common: { reading: "正在读取…", connectError: "连接本机 Rulith 时出错", unnamedComputer: "未命名的电脑", default: "（默认）" },
        signIn: { notFinished: "登录还没有完成：请在打开的 Rulith 页面里批准，再点一次登录。", failed: "没有登录成功。",
          waiting: "等待浏览器里批准…", button: "登录 Rulith" },
        status: { notConnected: "本机 Rulith 未连接", notSignedIn: "未登录 Rulith", online: "这台电脑在线", offline: "这台电脑离线", notSetUp: "这台电脑还没有设置" },
        worker: { notSetUp: "未设置", online: "在线", notEnabled: "这台电脑没有为它开启", offline: "离线" },
        setup: {
          steps: { connect: "接上 Rulith", kit: "安装编程工具", worker: "开启这台电脑", reload: "重新载入", ready: "完成" },
          reasons: {
            not_signed_in: "这台电脑没有登录 Rulith：先在设置的「账户」里登录。",
            agent_not_in_account: "这个智能体不在当前登录的账户里，或者在 Console 里不再对这台电脑开放。",
            runtime_credential_exists: "这个智能体的密钥正在别处使用（另一台电脑或另一个客户端持有它）。没有替换，什么都没有改。",
            connection_rejected: "Rulith 不再接受这台电脑为这个智能体保存的密钥（可能在 Console 里换过或撤销了）。什么都没有改，这台电脑也没有重新为它开启。",
            connection_missing: "这台电脑记着这个智能体，但为它保存的密钥不见了。什么都没有改。",
            worker_taken_over: "这个智能体在这台电脑上的工作被另一个进程接走了，这台电脑已为它停下，没有重新开启。在设置的「这台电脑」里点「在本机设置」，可以让它在这台电脑上重新开启。",
            local_setup_connection_in_use: "这个智能体正在另一台电脑上工作，所以这台电脑没有接上它，也没有另建一份；这次设置已撤回。等那台电脑停下（或它的占用过期）后，再点「在本机设置」。",
            setup_request_conflict: "这次设置和另一次冲突了：再点一次「在本机设置」。",
          },
          consequence: "原来的智能体密钥随即失效：仍在用它的客户端（包括另一台电脑上的）会停止工作，要在那里继续使用，得在那台电脑上重新设置。替换本身不授予任何文件夹或工具的权限。",
          inUseTitle: "替换这个智能体的密钥？",
          inUseLines: ["这个智能体已经有一把有效的密钥，正在另一台电脑（或另一个客户端）上使用。",
            "替换后，这台电脑用新的密钥设置好，有它自己的一份接入；那台电脑的接入不会被接走。"],
          inUseAccept: "替换密钥并继续设置", inUseCancel: "不替换",
          reconnectTitle: "重新接上这台电脑？",
          reconnectLine: "重新接上会给这台电脑换一把新密钥、送到这里；这台电脑已打开的项目和它们的授权都不变。",
          reconnectAlso: "这需要同时替换这个智能体的密钥。{consequence}",
          reconnectAccept: "替换密钥并重新接上", reconnectCancel: "不重新接上",
          stillRunning: "设置还在进行：稍后在设置的「这台电脑」里再看一次。",
          failed: "没有设置成功。",
          progressUnread: "读不到设置的进度：{error}。设置可能还在进行，稍后再看一次。",
          starting: "正在开始设置…", stepFailed: "「{step}」没有完成", done: "已在这台电脑上设置好，不需要重启。",
          setUp: "在本机设置", settingUp: "正在设置…",
        },
        model: {
          reading: "正在读取模型设置…", unreadable: "读不到模型设置。", notSaved: "没有保存。",
          saved: "已保存，从下一轮起生效。", savedNoKey: "已保存，但还不能用：请填写密钥（本机地址的模型可以不填）。",
          notSavedError: "没有保存：{error}", current: "现在用的：{name} · {host}", none: "还没有设置可用的模型。",
          address: "地址", modelId: "模型 ID", key: "密钥", keySaved: "已保存；留空则不改", keyPlaceholder: "API 密钥",
          hint: "OpenAI 兼容的地址，或以 /messages 结尾的 Anthropic 地址；本机的模型可以用 http://127.0.0.1:端口/v1。保存后从下一轮起生效，不需要重启；密钥只留在这台电脑上，不会再显示。",
          saving: "正在保存…", save: "保存",
          window: "上下文窗口：{tokens} token（{source}）",
          windowSources: { detected: "从模型服务读到", set: "由你设定", developer: "来自设置文件",
            assumed: "估计值：模型服务没有告知", default: "默认值" },
          windowAssumed: "请填写这个模型服务每个请求允许的上下文大小，好让 Rulith 在服务拒绝之前先缩短对话。",
          windowField: "上下文窗口（token）", windowEmpty: "留空则用 {tokens}",
          windowTooSmall: "Rulith 需要至少 {min} token 的上下文窗口，这个太小了。请在模型服务上调大上下文（llama.cpp 的 -c、Ollama 的 num_ctx、LM Studio 里的上下文长度），然后再保存一次模型。",
        },
        sign: {
          title: "待你签字的验收标准", button: "签下这些标准",
          body: "你要把这些标准签为这个任务的验收。它们由智能体提出；签下之后，智能体不能再结束或修改它们，只有在当前状态下每一条都成立，这个任务才算完成。这是你以自己账户做出的决定。",
          accept: "签字", cancel: "先不签", signed: "已签字。", pending: "签字结果还没有确认，稍后会自动刷新。",
          unreadable: "暂时读不到待签字的标准", signing: "正在签字…",
          refused: "没有签下任何标准：{teaching}。", unavailable: "这些标准现在不能签：{category}。",
          truncated: "这个任务的标准太多，这里只列出一部分；请在 Console 里签字。",
          moreInConsole: "还有等签字的任务没有列在这里：请在 Console 里查看。",
          replaced: "签字后会被替换", notCriterion: "不能作为验收标准", unknownReason: "原因未知，请稍后再试",
          stale: "上一次签字的结果还没有确认，那次签的是之前的标准。", signedMark: "已签",
        },
        signReasons: {
          unknown_goal: "找不到这个任务", goal_ended: "这个任务已经结束", goal_paused: "这个任务已暂停",
          contract_fixed: "这个任务的验收标准由能力规定，不用签字", leaf_not_proposed: "这些标准已经变了，请看最新的再签",
          criterion_unsupported: "其中有一条不能作为验收标准", goal_pending_obligations: "这个任务还有没办完的事，稍后再签",
        },
        ops: {
          onFile: { read: "读取 {file}", read_image: "读取 {file}", write_file: "写入 {file}", patch_file: "修改 {file}" },
          refusals: { sourceRevoked: "项目授权已收回", workerOffline: "这台电脑不在线", personRefused: "你拒绝了这次操作", boardSealed: "这个会话已删除",
            goalPaused: "任务已暂停", goalEnded: "任务已结束", needsSetup: "这个操作还没有开启", lawLock: "规则已上锁", governancePending: "智能体的设置正在生效",
            boardDraining: "现在暂停写入", ruleBlocks: "现在的条件不允许", reviewBlocked: "审查没有通过" },
          execute: "执行一个操作", endTask: "结束任务", startTask: "开始任务", startTaskNamed: "开始任务「{label}」",
          completed: "任务完成（验收通过）", record: "记下依据", readResult: "读取结果", viewProgress: "查看进展",
          proposeCriteria: "提出验收标准", breakDown: "细分任务", preparing: "正在准备一次操作…",
          error: "{verb}：出错", passed: "{verb}：通过", notPassed: "{verb}：没有通过", failed: "{verb}：失败",
          failedWhy: "{verb}：失败（{why}）", refusedWhy: "被拒绝：{why}", refused: "{verb}：被拒绝",
          unknown: "{verb}：结果未知，请在 Console 核对", atWorker: "{verb}：正在这台电脑上执行", running: "{verb}：进行中",
          waiting: "{verb}：等你决定", needsPerson: "{verb}：需要你在 Console 核对", stopped: "{verb}：已停止",
          showEvidence: "查看依据", hideEvidence: "收起依据", reason: "原因", receipt: "回执", result: "结果",
          thisCall: "这次调用", raw: "完整原文", empty: "（没有内容）",
        },
        tools: { read: "读文件", read_image: "读图片", list: "列出文件", glob: "按名称找文件", search: "搜索文件内容",
          tree_state: "查看文件夹的改动", write_file: "写文件", patch_file: "修改文件", apply_patch: "按补丁修改文件", run: "运行命令",
          test: "运行测试", job_start: "在后台运行命令", job_poll: "查看后台命令", job_stop: "停止后台命令", acceptance: "运行验收检查" },
        panel: {
          unreadable: "读不到 Rulith",
          notConnected: "还没有接入 Rulith：先登录，再在左侧为智能体「在本机设置」。",
          noBoard: "这个会话还没有开始任务。说出你要做的事，开始后这里显示任务、验收标准和最近操作。",
          deleted: "这个会话已删除，不能再继续。它的回执和记录仍保留，可在 Console 的任务记录里查看。",
          unnamedTask: "（没有名字的任务）",
          goal: { running: "进行中", paused: "已暂停", completed: "已完成（验收通过）", ended: "已结束" },
          awaitingSignature: "等你签字", awaitingDecision: "等你决定", statusUnread: "状态未读到",
          aCriterion: "一条验收标准", byCapability: "由能力规定", signed: "已签字", unsigned: "未签字",
          decisionConsole: "有一次操作的结果需要你在 Console 核对。", decisionWaiting: "有一次操作在等你决定。",
          agentWaiting: "这个智能体有一次操作在等你决定。", agentConsole: "这个智能体有一次操作的结果需要你在 Console 核对。",
          agent: "智能体：{name}", refresh: "刷新", goConsole: "去 Console 处理", inConsole: "请在 Console 里处理。",
          tasks: "任务", tasksUnreadable: "暂时读不到这个会话的任务：这个会话的下一个结果到来后，这里显示它。",
          tasksNext: "这个会话的下一个结果到来后，这里显示它的任务。", acceptInConsole: "在 Console 里验收",
          noTasks: "还没有任务：说出你要做的事，开始后这里显示它。",
          criteria: "验收标准与状态", holds: "成立", notHolds: "未成立", holdsUnread: "还没读到是否成立",
          criteriaLater: "读到后，这里显示验收标准。", noCriteria: "还没有验收标准。",
          recent: "最近操作", noOps: "还没有操作。", computer: "这台电脑",
          computerStates: { reading: "正在读取…", unread: "读不到", online: "在线", offline: "离线" }, viewInSettings: "在设置里查看",
        },
        tier: { label: "档位：", fresh: "默认", unreadable: "读不准", mixed: "（不一致）",
          menu: "这个会话的档位 · 收窄立即生效，放宽先确认", menuMixed: "这个会话的档位不一致：显示的是其中最严的一档，再选一次即统一",
          menuFresh: "这个会话还没有用过 Rulith：选一档就生效，默认取智能体的档位；放宽先确认",
          accepted: "已受理，还没有生效", betweenCalls: "已受理，还没有生效：会在这次调用结束后生效", later: "已受理，还没有生效，稍后再看一次",
          notSwitched: "没有切换", notAccepted: "这次切换没有被接受", title: "这个会话的档位（只改这个会话）" },
        modeWords: { strict: "严格", derived: "推导", non_strict: "宽松" },
        modeHints: { strict: "写入和运行要先有可信的依据", derived: "能从记下的事实推出理由，就可以写入和运行",
          non_strict: "模型给出的命令和参数直接执行；完成仍要你签字验收" },
        widen: {
          non_strict: { title: "切换到宽松档？", accept: "切换到宽松", cancel: "先不切换",
            body: "这个环境的工具在写入和运行时，会接受模型给出的输入，即使这次会话的依据里没有可信的事实支持它们。这样的每一次调用都会在记录里注明：它的输入没有可信的依据。需要你决定的调用不会在你决定之前运行；写入仍只在你授权的位置之内；你没有锁定的工具仍然不能用。你随时可以切换回来。" },
          derived: { title: "切换到推导档？", accept: "切换到推导", cancel: "先不切换",
            body: "只要模型能从它记在这次会话依据里的事实和规则，推出这次操作和它关键输入的理由，就可以在这个环境的工作区里写入和运行。那些事实不必是可信的证据。需要你决定的调用不会在你决定之前运行；写入仍只在本机的工作区之内。" },
        },
        switchRefusals: {
          exploration_control_pending: "这个会话的档位还在收窄，什么都没有改；稍后再试。",
          control_pending: "上一次的设置还没有完成，什么都没有改；稍后再试。",
          agent_call_pending: "智能体手上还有一次调用没有结束或待核对，结束后才能改；什么都没有改。",
          observation_in_progress: "还有一次观察没有结果，有了结果再试；什么都没有改。",
          configuration_unconfirmed: "智能体的设置正在生效，稍后再试；什么都没有改。",
          conversation_ended: "这个会话已删除，不能再改。",
          board_unavailable: "读不到这个会话的记录，什么都没有改；稍后再试。",
          request_conflict: "这次请求和之前的一次冲突了，什么都没有改；请再选一次。",
          exploration_mode_unconfirmed: "读不到这个会话现在的档位，什么都没有改；稍后再试。",
          conversations_unavailable: "会话设置的结果没能确认，请再试一次。",
          device_revoked: "这台电脑的登录已经失效，请在左下角重新登录。",
          device_unauthenticated: "这台电脑的登录已经失效，请在左下角重新登录。",
          unauthenticated: "这台电脑的登录已经失效，请在左下角重新登录。",
          not_authorized: "这台电脑的登录没有被授权使用这个智能体。",
          agent_not_found: "这个智能体现在不可用。",
          not_signed_in: "这台电脑没有登录 Rulith：先在左下角登录。",
          manager_signing_out: "这台电脑正在退出 Rulith 登录，现在不能改。",
          manager_closing: "本机 Rulith 正在关闭，现在不能改。",
        },
        tierRefusals: { derived_mode_unavailable: "推导档需要允许模型写规则。" },
        composer: { ended: "这个会话已删除，不能再继续",
          modelTitleOverride: "这个智能体用它自己的模型设置；点开看账户的模型设置", modelTitle: "这个会话下一轮用的模型；点开在设置里修改",
          model: "模型：{name}", modelNotSet: "未设置", reviewTitle: "这个会话的事后审查（只改这个会话）", review: "审查：{state}",
          reviewDefault: "默认", reviewOn: "开", reviewOff: "关", reviewMenu: "这个会话写入调用的事后审查，自下一次调用起",
          reviewOnItem: "开：写入调用送审查员", reviewOffItem: "关：这个会话不审" },
        project: {
          incomplete: "读到的打开内容不完整，不能请你确认。请稍后再试。",
          unexplained: "这个版本的 Rulith 应用说明不了要设置的档位，不能请你确认。请先更新 Rulith 应用。",
          modeMeaning: { non_strict: "这台电脑上之后新开的会话默认用「宽松」档：模型给出的命令和参数不需要事先有依据，就会执行；任务算不算完成，仍然只由你签字的验收标准认定。" },
          title: "把这个文件夹作为项目打开？", folder: "文件夹", agent: "智能体", agentValue: "{agent} · 这台电脑 {computer}",
          canDo: "可以做的事", canDoValue: "在这个文件夹里读文件、写文件、运行命令（包括测试和构建）。",
          tools: "所用工具", fromCapability: "来自这个智能体已装的官方编程能力。", mode: "档位",
          // docs/model-command-isolation.md §7 中文对照。
          note: "请注意", noteValue: "在这台电脑上，这个项目目录里的读、写和运行命令由智能体的编程能力执行。命令的环境里不带本机的密钥或令牌，通过工具访问本机与私有网络地址（含本机的管理器与应用端口）会被拒绝。按系统不同：在 Windows 上，命令以低完整性运行，读不到 Rulith 存放凭据的目录；这个目录在打开期间命令可读写，收回或停用这台电脑时还原原有设置。在 Linux 上，命令只能写这个项目目录与它的工具目录，系统只读，看不到 Rulith 存放凭据的目录，网络保留，后台任务随发起它的那次工具调用结束。在 macOS 上，命令目前不受本机隔离限制。隔离无法启用时命令不会运行（除非你在设置里选了“不隔离运行（不推荐）”）。宽松档意味着模型给出的命令与参数不再需要事先有依据，是否完成仍只由你签字的验收标准认证。撤销：在 Console 解除这个项目的锁定，或停用这台电脑。",
          withdraw: "怎么收回", withdrawValue: "以后要收回，在 Console 这个智能体页面上这个项目的一行里收回授权，或者停用这台电脑的登录。",
          account: "账户", toolsVersions: "工具与版本", capability: "官方编程能力 {id}", connection: "本机连接",
          footer: "已有的会话不受影响。打开完成后，会在这个文件夹里开一个新会话。",
          accept: "打开项目", cancel: "取消", details: "详细",
          refusals: {
            not_authorized: "这台电脑的登录没有被授权使用这个智能体。",
            account_changed: "这台电脑现在登录的账户和刚才显示的不一样。请刷新后再打开。",
            connection_not_of_this_device: "这个智能体在这台电脑上的接入不是这台电脑自己设置的。请在左侧对这个智能体重新「在本机设置」。",
            connection_not_found: "这个智能体还没有在这台电脑上设置好。请在左侧对它「在本机设置」。",
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
            worker_tool_pin_conflict: "这台电脑上已经锁定了同名工具的另一个版本，需要在 Console 里处理。什么都没有改。",
            project_unavailable: "现在确认不了项目的状态。之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。",
            not_signed_in: "这台电脑没有登录 Rulith，或登录已不能使用：先在左下角登录。",
            manager_signing_out: "这台电脑正在退出 Rulith 登录，现在不能打开项目。",
            manager_closing: "本机 Rulith 正在关闭，现在不能打开项目。",
            authorization_changed: "要授予的内容在确认之后又变了。请再打开一次，重新确认。",
            runtime_credential_exists: "这个智能体的密钥正在另一台电脑（或另一个客户端）上使用，这台电脑还没有设置好。请在设置的「这台电脑」里对它点「在本机设置」，确认替换后再打开文件夹。什么都没有改。",
            connection_rejected: "Rulith 不再接受这台电脑为这个智能体保存的密钥（可能在 Console 里换过或撤销了），这台电脑已为它停下。请在设置的「这台电脑」里对它点「在本机设置」，确认重新接上后再打开文件夹。什么都没有改。",
            connection_missing: "这台电脑上为这个智能体保存的密钥不见了。请在设置的「这台电脑」里对它点「在本机设置」，确认重新接上后再打开文件夹。什么都没有改。",
            worker_taken_over: "这个智能体在这台电脑上的工作被另一个进程接走了，这台电脑已为它停下。请在设置的「这台电脑」里对它点「在本机设置」，再打开文件夹。",
            local_setup_connection_in_use: "这个智能体正在另一台电脑上工作，这台电脑没有接上它，也没有另建一份。等那台电脑停下（或它的占用过期）后，在设置的「这台电脑」里对它点「在本机设置」，再打开文件夹。",
          },
          folderWords: {
            wholeDrive: "整个磁盘或共享不能作为项目打开，请选其中的一个文件夹。",
            root: "文件系统的根目录不能作为项目打开，请选一个文件夹。",
            colon: "文件夹的名字里不能有冒号。",
            loopback: "这个网络路径指回这台电脑或管理共享，请用文件夹的普通路径，例如 D:\\folder。",
            backslash: "这个路径里的反斜杠在 Windows 上会指向另一个文件夹，请选路径里没有反斜杠的文件夹。",
            slashes: "以 // 开头的路径在 Windows 上是网络共享，请写成 \\\\server\\share\\folder。",
            device: "设备路径不能作为项目打开，请用文件夹的普通路径，例如 D:\\folder。",
            share: "网络路径要写出服务器名和共享名。",
            windows: "这台电脑是 Windows，请选 D:\\folder 这样的文件夹。",
            notWindows: "这台电脑不是 Windows，请选 /home/you/folder 这样的文件夹。",
          },
          badFolder: "这个文件夹不能作为项目打开", notOpened: "没有打开项目",
          again: {
            mode_changed: "打开之后，这台电脑的档位又被改回去了（可能是在 Console 里改的）。重试不会替你再放宽；要继续，请再确认一次。",
            opened_elsewhere: "这个文件夹的打开不是在这台电脑上确认的。要在这台电脑上使用，请再确认一次。",
            mode_refused: "把档位设为「宽松」多次没有成功。要继续，请再确认一次。",
            revoked: "这个文件夹的项目授权已经收回。要再次授权，请再确认一次。",
            other: "这次打开没有完成。要继续，请再确认一次。",
          },
          step: "（第 {n} 步，共 3 步）", agentCall: "智能体手上还有一次调用没有结束，结束后会接着打开…",
          modeRetry: "设置档位没有成功，正在重试…", configuration: "正在记下项目文件夹和要用的工具…",
          program: "正在等新的设置生效…", modeStage: "正在把这台电脑上新会话的档位设为「宽松」…",
          opening: "正在打开项目…",
          later: "之后可以在左侧再次打开这个文件夹：会从当前进度继续，或重新请你确认。",
          changed: "要授予的内容在你确认之后变了。请再看一遍。", stopped: "已停止等待。{later}",
          manyTimes: "这个文件夹多次没有打开成功：{again}", notYet: "还没有打开完成：{progress} {later}",
          assignFailed: "没有记下这个会话的智能体",
        },
        folder: { open: "📂 打开文件夹…", choose: "📂 选择文件夹…", pickerUnavailable: "打不开选择文件夹的窗口：请手动输入路径。",
          path: "文件夹的完整路径，例如 D:\\work\\game 或 /home/you/game", openButton: "打开", cancel: "取消",
          pickTitle: "用系统的选择文件夹窗口选一个文件夹，作为这个智能体的项目打开",
          picking: "请在弹出的窗口里选择文件夹…", typePath: "手动输入路径", stopWaiting: "停止等待" },
        tree: {
          otherFolder: "其他目录", ago: { now: "刚刚", minutes: "{n} 分", hours: "{n} 时", days: "{n} 天" },
          newConversation: "新会话", untitled: "未命名会话", recordUnreadable: "读不到这个会话的记录",
          deletePending: "这个会话还有一次没有结果的调用，先在 Console 处理它。",
          notDeleted: "没有删除", partial: "已删除，但还没有办完：{reasons}。点这个会话的「补完删除」接着做。",
          deletedRefused: "已删除。其中 {n} 个任务没能结案，留在已结束的会话里，可在 Console 的任务记录里查到。",
          newFailed: "新会话没有建成：{error}", projectNotOpened: "没有打开项目：{error}",
          notProject: "（还不是项目）", newInFolder: "在这个目录开新会话", less: "收起", more: "更多（{n}）",
          unsettled: "没删完：{reasons}", subConversation: "历史子会话",
          finishTitle: "删除还没有办完：{reasons}。同一次删除接着做，不再问。", finish: "补完删除",
          deleteTitle: "删除这个会话", delete: "删除", defaultTitle: "这个账户的默认智能体", default: "默认",
          newUnderAgent: "在这个智能体下开新会话", agents: "智能体",
          newHereTitle: "在当前智能体与目录下开新会话", newHere: "＋ 新会话",
          filter: "筛选智能体、目录或会话", readingAgents: "正在读取智能体…",
          agentsUnreadable: "读不到智能体：先在左下角的设置里登录 Rulith。",
          unowned: "未归属的会话", expand: "展开智能体列表",
          dialogTitle: "删除这个会话？", introAgent: "会话「{title}」属于智能体 {agent}。删除后：", intro: "会话「{title}」。删除后：",
          sealed: "它在 Rulith 上的记录封存，这个会话不能再继续；", goals: "还开着的 {n} 个任务会以“放弃”结案；",
          kept: "回执、证明、计费和历史记录都保留，可在 Console 查看。", undone: "这一步不能撤销。",
          notFound: "会话「{title}」还没有用过 Rulith，云上没有它的记录。删除只会在本机把它移出列表。",
          keep: "取消", deleting: "正在删除…",
        },
        deletion: { closings: "{n} 个任务的结案还没有确认", someClosings: "有的任务的结案还没有确认", goalsUnread: "读不到它还开着的任务",
          deletedBeforeRecording: "它是在开始记录删除结果之前删除的", settlementUnrecorded: "删除已办完，还没记下", unfinished: "删除还没有办完" },
        wizard: { title: "开始使用 Rulith", steps: { signin: "登录", model: "选模型并填密钥", folder: "打开文件夹" },
          notAttached: "这个智能体已经在这台电脑上设置好，但还没有接上 Rulith：稍等片刻，再选一次文件夹。",
          signinLine: "用你的 Rulith 账户登录这台电脑：会在浏览器里打开 Rulith，批准后回到这里。",
          modelLine: "选一个模型服务，填上模型 ID 和密钥。",
          folderLine: "选一个文件夹作为项目：智能体会在里面读写文件、运行命令。打开前会请你确认一次。",
          agentsUnreadable: "读不到智能体。",
          noAgents: "这个账户在这台电脑上没有可用的智能体：在 Console 里检查这台电脑的登录授权。",
          agent: "智能体：{name}", agentLabel: "智能体：", chooseAgent: "选一个智能体", later: "稍后再说" },
        settings: {
          title: "设置", close: "关闭设置", entry: "设置 · {status}",
          sections: { account: "账户", computer: "这台电脑", model: "模型", appearance: "外观与语言", advanced: "高级" },
          localUnreadable: "读不到本机 Rulith。", actionFailed: "操作没有完成",
          account: "账户", unnamedAccount: "（未命名的账户）", notSignedIn: "未登录", signingOut: "正在退出…", signOut: "退出登录",
          computerSignInFirst: "先在「账户」里登录 Rulith，才能在这台电脑上设置智能体。",
          computer: "这台电脑", unnamedComputer: "未命名的电脑",
          setupHint: "「在本机设置」一步完成：接上这台电脑、装好编程工具、开启这台电脑。已经设置过的会检查一遍、补上缺的，不需要重启；设置本身不授予任何文件夹或工具的权限。",
          noAgents: "这个账户在这台电脑上没有可用的智能体。",
          modelSignInFirst: "先在「账户」里登录 Rulith，再设置模型。",
          appearance: "外观", system: "跟随系统", light: "浅色", dark: "深色", noAppearance: "这里没有可用的外观设置。",
          language: "语言", languageValue: "中文，跟随浏览器的语言",
          languageNote: "Rulith 和页面其余部分都跟随浏览器的语言：浏览器是中文时用中文，否则用英文。",
          otherClients: "接入其他客户端",
          otherClientsLine: "其他 MCP 客户端（例如 Claude Code）可以用智能体的 MCP 令牌接入同一个智能体。令牌在 Console 里取：打开这个智能体的页面，找「Agent MCP token」。",
          openInConsole: "在 Console 打开智能体",
        },
        legacy: { one: "1 个智能体", many: "{n} 个智能体",
          notice: "已停用的 Rulith 工作台（{home}）设置的 {count}不再随 rulith 在这台电脑上开启。运行 \"rulith manager\" 让它们继续运行，或在这里重新设置每个智能体；这会替换它的智能体密钥，绑定在它旧接入上的 Source 要在 Console 里重新绑定。" },
        isolationSwitch: { title: "模型命令隔离", label: "不隔离运行（不推荐）",
          confirmTitle: "不隔离运行模型命令？",
          confirmBody: "模型经编程能力运行的命令将能读取你的账户在这台电脑上能读的一切，包括 Rulith 自己的凭据。只有在这里无法隔离、且你接受这个风险时才打开。",
          accept: "不隔离运行", cancel: "保持隔离",
          restarting: "已保存。{agent} 会在手头的命令结束后在这台电脑上重新开启，用上这个设置。",
          nextStart: "已保存。{agent} 下次在这台电脑上开启时生效。", notSaved: "没有保存",
          stopped: "已结束模型命令在不隔离时启动的进程：{names}。",
          notStopped: "没能结束模型命令在不隔离时启动的进程：{names}。请自己结束它们，或重启这台电脑。",
          notChecked: "没能检查模型命令在不隔离时启动、仍在运行的进程：{reason}。" },
        reviewSettings: { title: "事后审查",
          explain: "审查员在每次写入调用执行后读它，可以在结果里附上建议；它从不拦下调用。",
          newConversations: "新会话默认审查", reviewer: "审查员：{name}", thisComputer: "这台电脑", otherComputer: "另一台电脑", none: "无",
          useThisComputer: "用这台电脑", remove: "取消审查员", deadline: "审查期限（秒）", save: "保存",
          deadlineRange: "审查期限是 60 到 300 之间的整数秒。",
          notHere: "要在这台电脑上审查，先在「这台电脑」里设置这个智能体。",
          designated: "这台电脑现在用这个智能体自己的模型审查它的写入调用。",
          saved: "已保存。", notSaved: "没有保存", unreadable: "读不到这个智能体的审查设置。" },
        diagnosis: { title: "诊断", reading: "正在读取…", unreadable: "Rulith 读不到它的诊断。",
          versions: "Rulith {rulith} · DeepSeek Harness {dsh} · Node.js {node} · {platform}", computer: "这台电脑：{name} · {signedIn}",
          unnamed: "未命名", signedIn: "已登录", notSignedIn: "未登录", starting: "正在启动", off: "关闭", notSetUp: "未设置",
          isolation: "模型命令隔离：{text}", unknown: "未知",
          projectNotProtected: "项目文件夹没有受保护：{path}（{reason}）", notProtected: "没有受保护：{path}（{reason}）" },
        shell: { toggleSidebar: "切换侧边栏", collapseSidebar: "收起侧边栏", openSidebar: "打开侧边栏",
          childHistory: "历史子会话（只读）", panel: "任务", panelGuide: "任务、验收标准、最近操作和这台电脑",
          openFirst: "先打开一个会话", emptySession: "说出你要做的事", emptyNone: "在左侧的智能体下开一个新会话",
          files: "文件与文件夹", project: "项目" },
        dsh: {
          "chat:chat.deepDiving": "正在处理…",
          "chat:chat.deepDivingFor": "正在处理，用时 {duration} ···",
          "chat:message.failure.accountSignedOut": "任务已因退出登录而停止。",
          "chat:message.failure.accountSignInRequired": "请先登录，并确认请求地址支持账号认证。",
          "conversation:placeholder.default": "说出你要做的事",
          "conversation:placeholder.hero": "",
          "conversation:placeholder.workspace": "先在左侧开一个新会话",
          "conversation:hero.headline": "",
          "conversation:hero.preview": "",
        },
      },
    };
    /**
     * The page's language, chosen once when the script loads: Chinese when the browser's language is Chinese
     * (navigator.language starting with "zh"), else English. dsh's own words follow it (followLocale), and every request
     * to the host carries it (`x-rulith-locale`), so the host's sentences are in the same language.
     */
    const LOCALE = (() => {
      try { const nav = window.navigator; return nav && /^zh/i.test(String(nav.language || "")) ? "zh" : "en"; } catch { return "en"; }
    })();
    const T = TEXTS[LOCALE];
    /** A text with its `{name}` parts filled in; a part not given stays as it is. Pure. */
    const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (whole, name) =>
      (values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole));
    /** A phrase that starts a line: its first letter in capitals (English; Chinese has none). Pure. */
    const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

    async function api(path, body) {
      const response = await fetch("/rulith/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-deep-rulith": "1", "x-rulith-locale": LOCALE, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return response.json();
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
    // Design §1 and the batch 5 review: the host's own sentences (it marks them `own`; they are written for the person in
    // the page's language, which every request names) are shown as they are. A reason the page has no words of its own for
    // is never hidden: the page's sentence comes first and the service's original text follows it (the local Runtime
    // manager's or the Gateway's words, a raw error). A Chinese sentence on a Chinese page is shown as it is too.
    // `said` is a reply (its `teaching` and `own`) or a text.
    const CJK = /[㐀-鿿]/;
    function plain(said, fallback) {
      const reply = said && typeof said === "object" ? said : null;
      const text = (reply ? (typeof reply.teaching === "string" ? reply.teaching : "") : typeof said === "string" ? said : "").trim();
      if (!text || (reply && reply.own === true) || (LOCALE === "zh" && CJK.test(text))) return text || fallback;
      return fallback ? fallback.replace(/[。.]$/, "") + T.p.colon + text : text;
    }
    const errorText = (error) => plain(String((error && error.message) || error), T.common.connectError);
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
      return { ok: false, own: true, teaching: T.signIn.notFinished };
    }
    /** The settings entry's line: the signed-in account and whether this computer's Worker runs for any Agent. Pure. */
    function computerStatus(s) {
      if (!s) return { color: GREY, text: T.common.reading };
      if (!s.ok) return { color: GREY, text: T.status.notConnected };
      if (!s.signedIn) return { color: GREY, text: T.status.notSignedIn };
      const here = (Array.isArray(s.agents) ? s.agents : []).filter((agent) => agent.paired);
      const online = here.some((agent) => agent.worker && agent.worker.state === "online");
      return { color: online ? GREEN : here.length ? AMBER : GREY,
        text: (s.account ? s.account + T.p.dot : "") + (online ? T.status.online : here.length ? T.status.offline : T.status.notSetUp) };
    }
    /** One Agent's state on this computer, in words. Pure. */
    function workerWords(agent) {
      if (!agent || !agent.paired) return { color: GREY, text: T.worker.notSetUp };
      const worker = agent.worker;
      if (worker && worker.state === "online") return { color: GREEN, text: T.worker.online };
      if (worker && worker.enabled === false) return { color: AMBER, text: T.worker.notEnabled };
      return { color: AMBER, text: T.worker.offline };
    }

    // ---- 「在本机设置」 (PSC 0.2.27 ② ③): one operation, its steps shown as it runs; no restart and no choice.
    // The manager's steps, in the order they run (the kit is installed before the Worker is turned on, so a first setup
    // starts the Worker once), under the words the owner reads.
    // Design §2: the Connection, the Worker and the Agent token are 这台电脑 and 智能体的密钥 here; lease, credential and
    // Connection stay out of these sentences.
    const SETUP_GROUPS = [[T.setup.steps.connect, ["instance", "pair"]], [T.setup.steps.kit, ["kit"]], [T.setup.steps.worker, ["worker"]],
      [T.setup.steps.reload, ["reload"]], [T.setup.steps.ready, ["ready"]]];
    // Why a setup stopped, by the manager's code. local_setup_connection_in_use (PSC 0.2.27 ②): the Connection this
    // computer would reconnect is in use by a Worker elsewhere: refused, nothing created.
    const SETUP_REASONS = T.setup.reasons;
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
      const consequence = T.setup.consequence;
      if (code === "runtime_credential_exists") return { code,
        title: T.setup.inUseTitle,
        lines: [...T.setup.inUseLines, consequence],
        accept: T.setup.inUseAccept, cancel: T.setup.inUseCancel };
      if (code === "connection_rejected" || code === "connection_missing") return { code,
        title: T.setup.reconnectTitle,
        lines: [SETUP_REASONS[code], T.setup.reconnectLine, fill(T.setup.reconnectAlso, { consequence })],
        accept: T.setup.reconnectAccept, cancel: T.setup.reconnectCancel };
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
        return { label, state, reason: failed ? own(SETUP_REASONS, failed.errorCode) || plain(failed.reason, "") : "" };
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
          if (polls >= maxPolls) return settle({ ok: false, view, error: T.setup.stillRunning });
          report({ settled: false, ok: false, view, error: "" });
          await wait(750);
          view = await api("setup?requestId=" + encodeURIComponent(view.requestId));
        }
        if (!view || !view.ok) return settle({ ok: false, view: null, error: own(SETUP_REASONS, view && view.errorCode) || plain(view, T.setup.failed) });
        return settle({ ok: view.state === "done", view, error: "" });
      } catch (error) {
        return settle({ ok: false, view: null, error: fill(T.setup.progressUnread, { error: errorText(error) }) });
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
          : none(T.setup.starting),
        rows.filter((row) => row.state === "failed").map((row) => h("div", { key: "why-" + row.label, role: "alert", style: { color: RED, wordBreak: "break-word" } },
          fill(T.setup.stepFailed, { step: row.label }) + (row.reason ? T.p.colon + row.reason : T.p.stop))),
        asking && declined !== requestId ? h("div", { "data-rulith-replace-token": asking.code, style: { margin: "6px 0", padding: "6px 8px",
            border: "1px solid " + AMBER, borderRadius: 6 } },
          h("div", { style: { fontWeight: 600, marginBottom: 4 } }, asking.title),
          asking.lines.map((line, i) => h("div", { key: i, style: { margin: "2px 0", wordBreak: "break-word" } }, line)),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 } },
            h("button", { type: "button", style: button, onClick: () => setDeclined(requestId) }, asking.cancel),
            h("button", { type: "button", style: primary, onClick: () => { setDeclined(requestId); onReplace(); } }, asking.accept))) : null,
        run.error ? alertLine(run.error) : null,
        run.settled && run.ok ? h("div", { style: { color: GREEN } }, T.setup.done) : null);
    }

    // ---- The model (PSC 0.2.27 ④): the signed-in account's default model; saved, it is used from the next turn.
    /** A whole number of tokens with thousands separators (262,144), the same in both languages. Pure. */
    const tokenCount = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    /**
     * The model form of the wizard's step ② and of settings → 模型. The key is sent, never shown back. Once a usable
     * model is saved it also shows the context window its conversations are measured against and where it comes from
     * (0.19.3: detected from a local model server, set by the person, from the settings file, assumed, or a hosted model's
     * default), with a field for the person's own window; emptied, the detected or default one applies again. Saving the
     * window alone does not save the model again.
     */
    function ModelForm({ onSaved }) {
      const [loaded, reload] = usePoll("model", 60000);
      const [draft, setDraft] = useState(null);     // { url, name } once edited
      const [key, setKey] = useState("");
      const [windowDraft, setWindowDraft] = useState(null);   // the window field's text once edited
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);   // { ok, text }
      if (!loaded) return none(T.model.reading);
      if (!loaded.ok) return alertLine(plain(loaded, T.model.unreadable));
      const m = loaded.model || {};
      const url = draft ? draft.url : m.url || "";
      const name = draft ? draft.name : m.name || "";
      const edit = (which, value) => setDraft({ url, name, [which]: value });
      const cw = m.configured && m.contextWindow && typeof m.contextWindow === "object" ? m.contextWindow : null;
      const windowSet = cw && cw.set !== undefined ? String(cw.set) : "";
      const windowText = windowDraft !== null ? windowDraft : windowSet;
      const windowChanged = !!cw && windowDraft !== null && windowDraft.trim() !== windowSet;
      const modelChanged = draft !== null || key.trim() !== "";
      /** The person's window for the model in force; `true` when it was saved. */
      const saveWindow = async () => {
        const reply = await api("model/context-window", { expectedOrigin: m.expectedOrigin, expectedAccountId: m.expectedAccountId,
          contextWindow: windowDraft.trim() });
        if (!reply.ok) { setNotice({ ok: false, text: plain(reply, T.model.notSaved) }); return false; }
        setWindowDraft(null);
        return true;
      };
      const save = async () => {
        setBusy(true); setNotice(null);
        try {
          if (windowChanged && !modelChanged) {
            if (await saveWindow()) { reload(); setNotice({ ok: true, text: T.model.saved }); }
            return;
          }
          const reply = await api("model", { expectedOrigin: m.expectedOrigin, expectedAccountId: m.expectedAccountId,
            url: url.trim(), name: name.trim(), ...(key.trim() ? { key: key.trim() } : {}) });
          if (!reply.ok) { setNotice({ ok: false, text: plain(reply, T.model.notSaved) }); return; }
          setKey(""); setDraft(null);
          const ready = !!(reply.model && reply.model.configured);
          if (windowChanged && ready && !(await saveWindow())) { reload(); return; }
          reload();
          setNotice({ ok: ready, text: ready ? T.model.saved : T.model.savedNoKey });
          if (ready && onSaved) onSaved(reply.model);
        } catch (error) { setNotice({ ok: false, text: fill(T.model.notSavedError, { error: errorText(error) }) }); }
        finally { setBusy(false); }
      };
      const host = (value) => String(value || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const label = (text, input) => h("label", { style: { display: "block", marginTop: 8 } }, h("div", { style: small }, text), input);
      const source = cw && Object.prototype.hasOwnProperty.call(T.model.windowSources, cw.source) ? T.model.windowSources[cw.source] : "";
      return h("div", { "data-rulith-model-form": "" },
        h("div", null, m.configured ? fill(T.model.current, { name: m.name, host: host(m.url) }) : T.model.none),
        cw ? h("div", { "data-rulith-context-window": cw.source || "", style: { marginTop: 4 } },
          fill(T.model.window, { tokens: tokenCount(cw.tokens), source })) : null,
        cw && cw.source === "assumed" ? h("div", { style: { ...small, opacity: 1, color: AMBER, marginTop: 2 } }, T.model.windowAssumed) : null,
        cw && cw.tooSmall ? h("div", { role: "alert", "data-rulith-context-window-small": "", style: { ...small, opacity: 1, color: AMBER, marginTop: 2 } },
          fill(T.model.windowTooSmall, { min: tokenCount(cw.minimum) })) : null,
        label(T.model.address, h("input", { value: url, list: "rulith-model-endpoints", placeholder: "https://api.deepseek.com/v1", disabled: busy, style: field,
          onChange: (event) => edit("url", event.target.value) })),
        h("datalist", { id: "rulith-model-endpoints" }, h("option", { value: "https://api.deepseek.com/v1" }), h("option", { value: "https://api.anthropic.com/v1/messages" })),
        label(T.model.modelId, h("input", { value: name, placeholder: "deepseek-flash", disabled: busy, style: field, onChange: (event) => edit("name", event.target.value) })),
        label(T.model.key, h("input", { type: "password", value: key, autoComplete: "new-password", disabled: busy, style: field,
          placeholder: m.keyConfigured ? T.model.keySaved : T.model.keyPlaceholder, onChange: (event) => setKey(event.target.value) })),
        cw ? label(T.model.windowField, h("input", { value: windowText, inputMode: "numeric", disabled: busy, style: field,
          "data-rulith-context-window-field": "", placeholder: fill(T.model.windowEmpty, { tokens: tokenCount(cw.fallback) }),
          onChange: (event) => setWindowDraft(event.target.value) })) : null,
        h("div", { style: { ...small, marginTop: 6 } }, T.model.hint),
        h("div", { style: { marginTop: 10 } }, h("button", { type: "button", style: primary, disabled: busy || !url.trim() || !name.trim(), onClick: save }, busy ? T.model.saving : T.model.save)),
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

    // The owner-facing texts of signing: Console Text A (PSC 0.2.17) where Console has the sentence, with the page's own
    // sentences in Console's words (PSC 0.2.32, D-1025b). `stale`: an earlier signature of this task is still unconfirmed
    // and froze other criteria than the card shows now; Sign these criteria resends that earlier request as it was
    // confirmed (its dialog shows those criteria), never the new ones under its id.
    const SIGN = T.sign;
    const SIGN_REASONS = T.signReasons;
    // Why nothing was signed: the Kernel's refusal code in words; a refusal without a code says the service's own reason
    // (Console Text A's {teaching}), and only a code this page has no words for is "unknown".
    const signReason = (code, teaching) => own(SIGN_REASONS, code)
      || (!code && words(teaching) ? words(teaching).replace(/[.。]$/, "") : "") || SIGN.unknownReason;
    const signRefused = (code, teaching) => ({ state: "refused", errorCode: typeof code === "string" ? code : "", text: fill(SIGN.refused, { teaching: signReason(code, teaching) }) });
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
      if (reply.ok === false) return reply.errorCode === "signature_unconfirmed" ? { state: "pending", text: SIGN.pending } : signRefused(reply.errorCode, reply.teaching);
      if (reply.state !== "complete") return { state: "pending", text: SIGN.pending };
      // A complete control record is the Kernel's answer to this request: `answered`.
      const result = reply.result && typeof reply.result === "object" ? reply.result : {};
      return result.accepted === true ? { state: "signed", text: SIGN.signed, answered: true } : { ...signRefused(result.errorCode, result.teaching), answered: true };
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
    // Batch 5 (batch 4 P3): kept in this tab's session storage too, so after a reload of the page the next confirmation of
    // the same goal still resends that request; a new tab starts empty. Only goal and leaf ids, labels and the request id
    // are kept, nothing secret; a state read that settles a signature removes it there as well.
    // 中文说明：未确认的签字记在本标签页的 sessionStorage 里，刷新页面后再次确认同一任务仍沿用原请求号；读到已结清就删掉。
    const SIGN_STORE_KEY = "rulith.sign.unconfirmed";
    const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
    const frozenSignature = (value) => !!value && typeof value === "object" && typeof value.goal === "string" && typeof value.requestId === "string"
      && /^[A-Za-z0-9._:-]{8,128}$/.test(value.requestId) && strings(value.toSign) && Array.isArray(value.leaves);
    class StoredSignatures extends Map {
      constructor(storage) {
        super();
        this.storage = storage || null;
        try {
          const saved = JSON.parse((this.storage && this.storage.getItem(SIGN_STORE_KEY)) || "{}") || {};
          for (const [key, value] of Object.entries(saved)) if (frozenSignature(value)) super.set(key, value);
        } catch {}
      }
      set(key, value) { super.set(key, value); this.save(); return this; }
      delete(key) { const had = super.delete(key); if (had) this.save(); return had; }
      clear() { super.clear(); this.save(); }
      save() {
        try {
          if (!this.storage) return;
          if (this.size) this.storage.setItem(SIGN_STORE_KEY, JSON.stringify(Object.fromEntries(this)));
          else this.storage.removeItem(SIGN_STORE_KEY);
        } catch {}
      }
    }
    const tabStorage = (() => { try { return window.sessionStorage || null; } catch { return null; } })();
    const unconfirmedSignatures = new StoredSignatures(tabStorage);
    const signatureKey = (sessionId, goal) => sessionId + "\n" + goal;
    /** Whether this task's unconfirmed signature froze other criteria than the card shows now (it is resent as it was). */
    function staleSignature(sessionId, entry) {
      const frozen = unconfirmedSignatures.get(signatureKey(sessionId, entry.goal));
      return !!frozen && frozen.toSign.join("\n") !== entry.toSign.join("\n");
    }
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
        + Object.entries(atom.args && typeof atom.args === "object" ? atom.args : {}).map(([name, v]) => name + ": " + shown(v)).join(", ") + ")").join(T.p.semi);
    }

    // An operation of this conversation in plain words (design §2 操作): what it did, then how it ended. The strip's label
    // names only the tool and the Action; a file's name and a test's pass come from its result while the strip carries it.
    const ON_FILE = T.ops.onFile;
    // "Execute worker_<connection>_eng_write_file_1 → goal-3" reads as write_file.
    const actionOf = (label) => {
      const m = /^Execute\s+(\S+)/.exec(String(label || ""));
      return m ? m[1].replace(/@\d+$/, "").replace(/^worker_[a-z0-9]+_/, "").replace(/_\d+$/, "").replace(/_[0-9a-f]{12}$/, "").replace(/^eng[._]/, "").replace(/_v\d+$/, "") : "";
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
      [/source_revoked|withdrew this grant/i, T.ops.refusals.sourceRevoked],
      [/worker_offline|execution environment for this Action is offline/i, T.ops.refusals.workerOffline],
      [/A person refused this call/i, T.ops.refusals.personRefused],
      [/board_sealed|This Board is retired/i, T.ops.refusals.boardSealed],
      [/goal_paused|Every goal it works for is paused/i, T.ops.refusals.goalPaused],
      [/goal_ended|Every goal it works for has ended/i, T.ops.refusals.goalEnded],
      [/needs_setup|Not enabled for this Agent/i, T.ops.refusals.needsSetup],
      [/law_lock|Locked with this Board's rules/i, T.ops.refusals.lawLock],
      [/governance_pending|configuration is being applied/i, T.ops.refusals.governancePending],
      [/board_draining|Writes are paused/i, T.ops.refusals.boardDraining],
      [/A rule of the installed program blocks it|did not occur/i, T.ops.refusals.ruleBlocks],
      [/review_blocked/i, T.ops.refusals.reviewBlocked],
    ];
    const refusalWords = (op) => {
      const said = [op.reason, op.summary, fieldOf(op.result, "errorCode")].filter((value) => typeof value === "string").join(" ");
      const hit = REFUSAL_WORDS.find(([pattern]) => pattern.test(said));
      return hit ? hit[1] : "";
    };
    /**
     * One strip entry as one line: { text, detail, tone }. Never a tool id, state code or reason code. Pure. A conversation's
     * tool-call row passes the call's own arguments too (`args`: a file named there when the result does not name one) and,
     * for Set and Get, the words of what the call asked (`verb`).
     */
    function operationLine(op) {
      const o = op && typeof op === "object" ? op : {};
      const label = String(o.label || ""), tool = String(o.tool || "");
      let verb, action = "";
      if (tool === "Execute" || /^Execute\s/.test(label)) {
        action = actionOf(label);
        const file = own(ON_FILE, action) ? fileOf(o.result) || fileOf(o.args) : "";
        verb = file ? fill(ON_FILE[action], { file }) : capital(own(TOOL_WORDS, action)) || T.ops.execute;
      } else if (tool === "Set" || /^Set\b/.test(label)) {
        const summary = String(o.summary || "");
        verb = typeof o.verb === "string" && o.verb ? o.verb : /\bend_goal\b/.test(label) ? T.ops.endTask : /^declared goal\b/.test(summary) ? T.ops.startTask
          : /^completed\b/.test(summary) ? T.ops.completed : T.ops.record;
      } else verb = typeof o.verb === "string" && o.verb ? o.verb : tool === "Get" ? T.ops.readResult : T.ops.execute;
      const say = (template, why) => fill(template, { verb, why });
      switch (o.state) {
        case "done": {
          const exit = action === "test" || action === "acceptance" || action === "run" ? fieldOf(o.result, "exit_code") : undefined;
          if (typeof exit === "number" && action === "run") return exit === 0 ? { text: verb, tone: "ok" } : { text: say(T.ops.error), tone: "warn" };
          if (typeof exit === "number") return { text: say(exit === 0 ? T.ops.passed : T.ops.notPassed), tone: exit === 0 ? "ok" : "warn" };
          return { text: verb, tone: "ok" };
        }
        case "failed": { const why = refusalWords(o); return { text: say(why ? T.ops.failedWhy : T.ops.failed, why), tone: "warn" }; }
        case "refused": { const why = o.contentWithheld ? "" : refusalWords(o);
          return why ? { text: say(T.ops.refusedWhy, why), detail: verb, tone: "warn" } : { text: say(T.ops.refused), tone: "warn" }; }
        case "unknown": return { text: say(T.ops.unknown), tone: "error" };
        case "running": return { text: say(o.stage === "at_worker" ? T.ops.atWorker : T.ops.running), tone: "info" };
        case "waiting_for_decision": return { text: say(T.ops.waiting), tone: "warn" };
        case "needs_person": return { text: say(T.ops.needsPerson), tone: "error" };
        default: return { text: verb, tone: "info" };
      }
    }

    const GOAL_WORDS = T.panel.goal;
    /** A task's status in words: an ended task as it ended, else what it waits for, else running or paused. Pure. */
    function taskStatusText(row, awaitsSignature) {
      if (row.status === "completed" || row.status === "ended") return GOAL_WORDS[row.status];
      if (awaitsSignature || row.awaiting === "acceptance") return T.panel.awaitingSignature;
      if (row.awaiting === "decision") return T.panel.awaitingDecision;
      return own(GOAL_WORDS, row.status) || T.panel.statusUnread;
    }
    const NO_BOARD = T.panel.noBoard;
    const DELETED = T.panel.deleted;
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
          note: entry.signable !== true || leaf.eligible === true ? "" : leaf.signed === true ? SIGN.replaced : SIGN.notCriterion }));
        const toSign = entry.signable === true ? leaves.filter((leaf) => leaf.eligible).map((leaf) => leaf.node) : [];
        // A list shortened by the service cannot be signed from here: signing it would replace leaves this page never saw.
        const refusal = entry.signable !== true ? fill(SIGN.unavailable, { category: signReason(entry.refusal) })
          : entry.leavesTruncated === true ? SIGN.truncated : "";
        return { goal: entry.goal, label: words(entry.label) && entry.label !== entry.goal ? words(entry.label) : T.panel.unnamedTask,
          leaves, toSign: refusal ? [] : toSign, refusal, signable: entry.signable === true,
          awaits: entry.signable === true ? leaves.some((leaf) => leaf.eligible && !leaf.signed) : leaves.some((leaf) => !leaf.signed) };
      });
    }
    /**
     * The panel's content from what it read (see above). `kind: "message"` is one sentence instead of the panel (reading,
     * unreadable, not set up, no Board yet); `kind: "panel"` has every section. Pure apart from updating `memory`.
     */
    function taskPanelModel({ board, conversation, worker, health, memory = panelMemory() }) {
      if (!board) return { kind: "message", text: T.common.reading };
      if (!board.ok) return { kind: "message", text: plain(board, T.panel.unreadable), tone: "warn" };
      if (!board.available) return { kind: "message", text: T.panel.notConnected };
      const view = board.view && typeof board.view === "object" ? board.view : null;
      const conv = conversation && conversation.ok ? conversation : null;
      const found = !!(conv && conv.found === true && conv.conversation && typeof conv.conversation === "object");
      // A failed state read (the service unavailable, the manager down, signed out, …) says nothing about the conversation:
      // never "no Board yet" and never "no criteria", only that it cannot be read now. Only found:false means no Board.
      const readFailed = !!(conversation && conversation.ok !== true);
      // A deleted conversation (PSC 0.2.21) gets no further result: the panel says it is deleted (batch 4 P3) rather than
      // waiting for "the next result".
      if (found && conv.conversation.endedAt) return { kind: "message", text: DELETED };
      if (!view && !found && !readFailed) return conv && conv.found === false ? { kind: "message", text: NO_BOARD } : { kind: "message", text: T.common.reading };
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
        label: words(row.label) && row.label !== row.goal ? words(row.label) : T.panel.unnamedTask,
        status: taskStatusText(row, awaitsSignature.has(row.goal)), fixed: !!row.type,
        console: inConsole(row) ? link(board.casesUrl) || "-" : "" }));
      for (const entry of entries) if (!tasks.some((task) => task.goal === entry.goal))
        tasks.unshift({ goal: entry.goal, label: entry.label, status: entry.awaits ? T.panel.awaitingSignature : GOAL_WORDS.running, fixed: false, console: "" });
      const criteria = [];
      for (const task of tasks) {
        const entry = entries.find((e) => e.goal === task.goal);
        const rows = (entry ? entry.leaves : (memory.signed.get(task.goal) || []).map((leaf) => ({ ...leaf, signed: true, eligible: true })))
          .map((leaf) => ({ node: leaf.node, label: leaf.label || T.panel.aCriterion, criterion: leaf.criterion,
            signed: leaf.signed ? (task.fixed ? T.panel.byCapability : T.panel.signed)
              : leaf.note || T.panel.unsigned,
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
      const decision = deciding ? { text: waiting && waiting.state === "needs_person" ? T.panel.decisionConsole
        : T.panel.decisionWaiting, url: link(board.consoleUrl) || link(health && health.consoleUrl) }
        : pending ? { text: pending.phase === "waiting" ? T.panel.agentWaiting : T.panel.agentConsole,
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
        setBusy(asked.goal); report({ state: "pending", text: SIGN.signing });
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
        h("span", { style: { flex: 1, wordBreak: "break-word" } }, leaf.label || T.panel.aCriterion),
        leaf.signed ? h("span", { style: { ...small, flex: "none" }, "data-rulith-leaf-signed": "" }, SIGN.signedMark) : null,
        leaf.note ? h("span", { style: { ...small, flex: "none" }, "data-rulith-leaf-ineligible": "" }, leaf.note) : null),
      leaf.criterion ? h("div", { style: { ...small, wordBreak: "break-all" } }, leaf.criterion) : null);
    /** The signing confirmation (PSC 0.2.28; Console Text A): only its Sign sends anything. */
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

    // ---- Rulith's tool calls in the conversation (design §3.2 工具调用行, §2 操作): one line in plain words (写入 fizzbuzz.py,
    // 运行测试：通过, 被拒绝：项目授权已收回) and 「查看依据」 on the right, which opens the call's receipt, what the call asked
    // and the whole answer. It replaces dsh's generic row (「工具调用 · 查看」, the raw JSON of the call and of the whole view)
    // for Rulith's three tools; the words come from operationLine, as in the 任务 panel's 最近操作.
    // 中文说明：会话里 Rulith 三个工具的每次调用只显示一句人话；回执、调用内容与原文收在「查看依据」里，默认不展开。
    const RULITH_TOOLS = ["Get", "Set", "Execute"];
    const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
    const blockText = (block) => list(block && block.content)
      .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
    /**
     * Rulith's answer in a call's result text. The host gives the person the MCP result as its JSON, whose content text is
     * the answer, and the reviewer's notes on further lines (board-channel.mjs renderChannelResult); a call the bridge
     * failed carries the result in its error text. Null when no answer can be read. Pure.
     */
    function rulithAnswer(text) {
      const raw = String(text || "");
      const brace = raw.indexOf("{");
      for (const candidate of [raw, raw.split("\n")[0], brace > 0 ? raw.slice(brace) : ""]) {
        const value = candidate ? parseJson(candidate) : undefined;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        if (Array.isArray(value.content)) {
          const inner = parseJson(blockText(value));
          if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
          continue;
        }
        if ("accepted" in value || "operations" in value) return value;
      }
      return null;
    }
    /** The call's arguments, from the block of any stage (preparing has none). Pure. */
    function callArgs(block) {
      const raw = !block || typeof block !== "object" ? undefined : "kind" in block ? block.call && block.call.argsRaw : block.argsRaw;
      const value = typeof raw === "string" ? parseJson(raw) : undefined;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    /** What a Set asked, in words: ending a task, starting one, proposing criteria, breaking one down, or recording. Pure. */
    function setWords(args) {
      const ops = list(args.operations).filter((op) => op && typeof op === "object");
      if (ops.some((op) => op.op === "end_goal")) return T.ops.endTask;
      const root = ops.find((op) => op.op === "declare_goal" && !op.parent);
      if (root) return words(root.label) ? fill(T.ops.startTaskNamed, { label: words(root.label) }) : T.ops.startTask;
      const children = ops.filter((op) => op.op === "declare_goal");
      if (children.length) return children.every((op) => list(op.desired).some((atom) => atom && atom.predicate === "eng.check_passed"))
        ? T.ops.proposeCriteria : T.ops.breakDown;
      return T.ops.record;
    }
    /**
     * This call's own entry of the operations strip: an Execute's newest entry for its Action, or the outcome the host
     * delivered for a call it waited on (board-channel.mjs). Set and Get are judged by the answer alone (several Sets share
     * one label). Pure.
     */
    function ownOperation(tool, args, answer) {
      if (!answer || typeof answer !== "object") return null;
      if (answer.tool === tool && typeof answer.state === "string")
        return { state: answer.state, ...(answer.result !== undefined ? { result: answer.result } : {}),
          ...(typeof answer.summary === "string" ? { summary: answer.summary } : {}), ...(typeof answer.teaching === "string" ? { reason: answer.teaching } : {}),
          ...(answer.contentWithheld !== undefined ? { contentWithheld: answer.contentWithheld } : {}) };
      if (tool !== "Execute" || typeof args.action !== "string") return null;
      const rows = list(answer.operations).filter((entry) => entry && entry.tool === "Execute" && (entry.seat === undefined || entry.seat === "main")
        && String(entry.label || "").split(/\s+/)[1] === args.action);
      return rows.length ? { ...rows.reduce((a, b) => (String(b.at || "") > String(a.at || "") ? b : a)) } : null;
    }
    /**
     * One Rulith tool call as the conversation shows it: { text, detail, tone, state, evidence }, where `evidence` (null
     * while the call runs) is what 「查看依据」 opens: the receipt, the reason of a refusal, what the call asked and the whole
     * answer. Never a tool id, state code or node id in `text`. Pure.
     */
    function toolCallLine({ toolName, phase, block }) {
      const tool = String(toolName || "");
      const args = callArgs(block);
      const verb = tool === "Set" ? setWords(args) : tool === "Get" ? (args.artifact ? T.ops.readResult : T.ops.viewProgress) : undefined;
      const base = { tool, label: tool === "Execute" && typeof args.action === "string" ? "Execute " + args.action : tool, args: args.args, verb };
      if (phase === "preparing" || !block || typeof block !== "object") return { text: T.ops.preparing, tone: "info", state: "preparing", evidence: null };
      if (!("kind" in block)) return { ...operationLine({ ...base, state: "running" }), state: "running", evidence: null };
      const raw = blockText(block) || (block.error && typeof block.error.message === "string" ? block.error.message : "");
      const answer = rulithAnswer(raw);
      // A refusal answer names no operation of its own (only an outcome the host waited for has tool and state): the
      // strip's newest entry for the same Action is another call, so its receipt and file are not this call's.
      const delivered = !!answer && answer.tool === tool && typeof answer.state === "string";
      const own = answer && answer.accepted === false && !delivered ? null : ownOperation(tool, args, answer);
      const why = (a) => [a.teaching, a.errorCode].filter((value) => typeof value === "string" && value).join(" ");
      let op;
      if (block.error && block.error.code === "interrupted") op = { ...base, state: "stopped" };
      else if (answer && answer.accepted === false) op = { ...base, ...(own || {}), args: args.args, verb, state: "refused",
        reason: [own && own.reason, delivered ? "" : why(answer)].filter(Boolean).join(" ") || why(answer) };
      else if (own) op = { ...base, ...own, args: args.args, verb };
      else if (answer) op = { ...base, state: "done" };
      else if (block.isError) op = { ...base, state: /outcome is unknown/i.test(raw) ? "unknown" : "failed", reason: raw };
      else op = { ...base, state: "done" };
      const line = op.state === "stopped" ? { text: fill(T.ops.stopped, { verb: operationLine({ ...base, state: "done" }).text }), tone: "warn" } : operationLine(op);
      const call = tool === "Execute" ? { action: args.action, ...(args.args !== undefined ? { args: args.args } : {}), ...(args.target !== undefined ? { target: args.target } : {}) } : args;
      return { text: line.text, detail: line.detail, tone: line.tone, state: op.state, evidence: {
        reason: op.state === "refused" || op.state === "failed" || op.state === "unknown" ? words(op.reason) : "",
        receipt: own && own.result !== undefined ? own.result : undefined,
        summary: own && typeof own.summary === "string" ? own.summary : "",
        call, raw } };
    }
    // JSON text inside a receipt (a result's content text) is shown as the JSON it is, not as one escaped string.
    const unfolded = (value, depth = 6) => {
      if (depth < 0) return value;
      if (typeof value === "string" && value.length < 200000 && /^\s*[{[]/.test(value)) { const inner = parseJson(value); return inner === undefined ? value : unfolded(inner, depth - 1); }
      if (Array.isArray(value)) return value.map((item) => unfolded(item, depth - 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unfolded(item, depth - 1)]));
      return value;
    };
    const shownJson = (value) => (typeof value === "string" ? value : JSON.stringify(unfolded(value), null, 2));
    const evidenceText = { margin: "4px 0 0", padding: "6px 8px", maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
      fontSize: 11.5, lineHeight: 1.45, borderRadius: 6, background: "var(--dsw-alias-markdown-code-block, rgba(127,127,127,.08))",
      fontFamily: "var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)" };
    /** The conversation's row of one Rulith tool call (dsh's keyed `tool.call.toolview`, props of dsh-client-ui-tool). */
    function RulithToolRow(props) {
      const [localOpen, setLocalOpen] = useState(false);
      const disclosure = typeof props.useDisclosure === "function" ? props.useDisclosure() : null;
      const kept = !!(disclosure && typeof disclosure.toggle === "function");
      const open = kept ? disclosure.expanded === true : localOpen;
      const toggle = kept ? () => disclosure.toggle() : () => setLocalOpen(!localOpen);
      const line = toolCallLine(props);
      const evidence = line.evidence;
      const part = (title, body) => h("div", { style: { marginTop: 6 } }, h("div", { style: small }, title), body);
      return h("div", { "data-rulith-call": props.toolName || "", "data-rulith-call-state": line.state, style: { padding: "1px 0", fontSize: 13 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, minHeight: 24, color: "var(--dsw-alias-label-secondary, inherit)" } },
          dot(LEVEL[line.tone] || GREY),
          h("span", { "data-rulith-call-line": "", style: { flex: 1, minWidth: 0, wordBreak: "break-word" } }, line.text,
            line.detail ? h("span", { style: small }, T.p.open + line.detail + T.p.close) : null),
          evidence ? h("button", { type: "button", "data-rulith-call-evidence": "", "aria-expanded": open, style: { ...linkButton, flex: "none" }, onClick: toggle },
            open ? T.ops.hideEvidence : T.ops.showEvidence) : null),
        open && evidence ? h("div", { "data-rulith-call-detail": "", style: { margin: "2px 0 6px 14px" } },
          evidence.reason ? part(T.ops.reason, h("div", { style: { fontSize: 12, wordBreak: "break-word" } }, evidence.reason)) : null,
          evidence.receipt !== undefined ? part(T.ops.receipt, h("pre", { style: evidenceText }, shownJson(evidence.receipt))) : null,
          evidence.summary ? part(T.ops.result, h("div", { style: { fontSize: 12, wordBreak: "break-word" } }, evidence.summary)) : null,
          part(T.ops.thisCall, h("pre", { style: evidenceText }, shownJson(evidence.call))),
          h("details", { style: { marginTop: 6 } }, h("summary", { style: { ...small, cursor: "pointer" } }, T.ops.raw),
            h("pre", { style: evidenceText }, evidence.raw || T.ops.empty))) : null);
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
      const holdsWord = (holds) => (holds === true ? h("span", { style: { color: GREEN } }, T.panel.holds) : holds === false ? h("span", { style: { color: AMBER } }, T.panel.notHolds)
        : h("span", { style: small }, T.panel.holdsUnread));
      return frame(
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
          h("span", { style: small }, model.agentName ? fill(T.panel.agent, { name: model.agentName }) : ""),
          h("button", { type: "button", style: { ...button, padding: "1px 8px", fontSize: 11 }, onClick: reload }, T.panel.refresh)),
        // Proposed criteria not signed yet: their card goes first.
        model.awaiting.map((entry) => h("div", { key: entry.goal, "data-rulith-awaiting-signature": entry.goal,
            style: { marginBottom: 14, padding: "8px 10px", border: "1px solid " + AMBER, borderRadius: 8 } },
          h("div", { style: { ...section, marginTop: 0 } }, SIGN.title),
          h("div", { style: { fontWeight: 600, marginBottom: 4, wordBreak: "break-word" } }, entry.label),
          entry.leaves.map(leafRow),
          staleSignature(sessionId, entry) ? h("div", { role: "status", "data-rulith-sign-stale": "", style: { ...small, marginTop: 6, opacity: 1, color: AMBER } }, SIGN.stale) : null,
          entry.refusal ? h("div", { role: "status", "data-rulith-sign-unavailable": "", style: { ...small, marginTop: 6, opacity: 1, color: AMBER } }, entry.refusal)
            : h("div", { style: { marginTop: 8 } }, h("button", { type: "button", style: primary, "data-rulith-sign": entry.goal,
              disabled: !!signing.busy, onClick: () => signing.ask(entry) }, signing.busy === entry.goal ? SIGN.signing : SIGN.button)))),
        model.awaitingTruncated ? h("div", { style: { ...small, marginBottom: 10 } }, SIGN.moreInConsole) : null,
        model.awaitingUnknown ? h("div", { "data-rulith-awaiting-unknown": "", style: { ...small, marginBottom: 10 } }, SIGN.unreadable) : null,
        note ? h("div", { role: note.state === "refused" ? "alert" : "status", "data-rulith-sign-note": note.state,
          style: { marginBottom: 12, color: noteColor, fontSize: 12, wordBreak: "break-word" } }, note.text) : null,
        model.decision ? h("div", { role: "alert", "data-rulith-decision": "", style: { marginBottom: 12, fontSize: 12, color: AMBER } },
          model.decision.text + " ",
          model.decision.url ? h("a", { href: model.decision.url, target: "_blank", rel: "noopener noreferrer" }, T.panel.goConsole)
            : h("span", null, T.panel.inConsole)) : null,
        block(T.panel.tasks, "", model.tasksUnread && !model.tasks.length ? none(model.awaitingUnknown && !model.tasksReading ? T.panel.tasksUnreadable
          : T.panel.tasksNext)
          : model.tasks.length ? h("div", null, model.tasks.slice(0, 6).map((task) => h("div", { key: task.goal, "data-rulith-task": task.goal,
              style: { display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" } },
            h("span", { style: { flex: 1, wordBreak: "break-word" } }, task.label), h("span", { style: { ...small, flex: "none" } }, task.status),
            task.console ? (task.console === "-" ? h("span", { style: { ...small, flex: "none" } }, T.panel.acceptInConsole)
              : h("a", { href: task.console, target: "_blank", rel: "noopener noreferrer", style: { flex: "none", fontSize: 12 } }, T.panel.goConsole)) : null)))
          : none(T.panel.noTasks)),
        block(T.panel.criteria, "", model.criteria.length ? h("div", null, model.criteria.map((group) => h("div", { key: group.goal, style: { marginBottom: 6 } },
            model.criteria.length > 1 ? h("div", { style: { ...small, marginBottom: 2 } }, group.label) : null,
            group.rows.map((row) => h("div", { key: row.node, "data-rulith-criterion": row.node, style: { padding: "2px 0" } },
              h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
                h("span", { style: { flex: 1, wordBreak: "break-word" } }, row.label),
                h("span", { style: { flex: "none", fontSize: 12 } }, holdsWord(row.holds), h("span", { style: small }, T.p.dot + row.signed))),
              row.criterion ? h("div", { style: { ...small, wordBreak: "break-all" } }, row.criterion) : null)))))
          : none(model.awaitingUnknown ? T.panel.criteriaLater : model.tasksReading ? T.common.reading : T.panel.noCriteria)),
        block(T.panel.recent, model.operations.length ? String(model.operations.length) : "", model.operations.length
          ? h("div", null, model.operations.map((line, i) => h("div", { key: i, "data-rulith-operation": "", style: { display: "flex", gap: 6, alignItems: "baseline", padding: "2px 0", fontSize: 12 } },
            dot(LEVEL[line.tone] || GREY),
            h("span", { style: { flex: 1, wordBreak: "break-word" } }, line.text, line.detail ? h("span", { style: small }, T.p.open + line.detail + T.p.close) : null),
            line.at ? h("span", { style: { ...small, flex: "none" } }, line.at) : null)))
          : none(T.panel.noOps)),
        block(T.panel.computer, "", h("div", { "data-rulith-computer": model.computer.state, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
          dot(model.computer.state === "online" ? GREEN : model.computer.state === "offline" ? AMBER : GREY),
          h("span", { style: { flex: 1 } }, (model.computer.name ? model.computer.name + T.p.dot : "")
            + T.panel.computerStates[model.computer.state]),
          model.computer.state === "offline" ? h("button", { type: "button", style: linkButton, onClick: () => openSettings("computer") }, T.panel.viewInSettings) : null)));
    }

    // ---- The composer row (design §3.2 会话的输入行): the chips 档位, 模型 and 审查. Post-call review is optional in every
    // exploration mode (D-1026a), so its chip is always there. The browser only sees what the launcher's conversationView
    // picks out; a switch travels manager -> device grant -> Gateway (PSC 0.2.16 ③, 0.2.20, 0.2.27 ①).
    // Exploration tiers, narrow to wide (TOOL-08b/08c), and the Console's approved confirmation texts for widening.
    const MODE_ORDER = ["strict", "derived", "non_strict"];
    // Design §2: the three tiers are named only in this menu and in the project confirmation, each with one plain
    // sentence, by Console's names (Strict, Derived, Non-strict). The widening confirmations are Console's approved texts
    // (the non-strict confirmation, PSC 0.2.5, and Text 9, PSC 0.2.9), verbatim.
    const MODE_WORDS = T.modeWords;
    const MODE_HINTS = T.modeHints;
    const WIDEN_TEXT = T.widen;
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
    // The tier chip's words.
    const TIER = T.tier;
    // Why a tier or review switch was refused: the codes the Gateway's local-device conversation routes, its control store
    // and the local manager return there (GatewayConversationController, GatewayControlService, AgentControlStore), in plain
    // words that keep each teaching's meaning and the action to take. A code not listed shows TIER.notSwitched followed by
    // the service's own text (plain), never nothing.
    const SWITCH_REFUSALS = T.switchRefusals;
    const TIER_REFUSALS = { ...SWITCH_REFUSALS, ...T.tierRefusals };
    // D-1026a: review no longer depends on the mode, so the review switch has no refusals of its own.
    const REVIEW_REFUSALS = SWITCH_REFUSALS;
    /** A refused switch in words: its code's sentence, else the generic one followed by the service's own text. Pure. */
    const switchRefusal = (table, answer, generic) => own(table, answer && answer.errorCode)
      || plain(answer && answer.teaching ? answer : (answer && answer.errorCode) || "", generic);
    function useConversationSettings(sessionId) {
      const [settings, refresh] = usePoll("conversation?session=" + encodeURIComponent(sessionId), 6000);
      const [note, setNote] = useState("");
      // One request per conversation: the Gateway applies the tier to every Connection of its Board.
      const applyMode = async (mode) => {
        setNote("");
        try {
          const reply = await api("conversation/exploration-mode", { session: sessionId, mode });
          // The outcome is `result.accepted`; a pending switch (202) says why it waits.
          if (!reply.ok) setNote(switchRefusal(TIER_REFUSALS, reply, TIER.notSwitched));
          else if (reply.state !== "complete") {
            const why = String(reply.teaching || "");
            setNote(/between calls/i.test(why) ? TIER.betweenCalls : why ? plain(why, TIER.accepted) : TIER.later);
          } else if (reply.result && reply.result.accepted === false) setNote(switchRefusal(TIER_REFUSALS, reply.result, TIER.notAccepted));
        } catch (error) { setNote(errorText(error)); }
        refresh();
      };
      // Turning review on for an Agent with no reviewer makes this computer its reviewer first (the host does it). Says
      // whether it did, so the page can say that this computer now reviews, with the Agent's own model.
      const applyReview = async (enabled) => {
        setNote("");
        let designated = false;
        try {
          const reply = await api("conversation/review", { session: sessionId, enabled });
          if (!reply.ok) setNote(switchRefusal(REVIEW_REFUSALS, reply, TIER.notSwitched));
          // Said also when the switch itself was then refused: this computer is the reviewer either way.
          designated = reply.designated === true;
        } catch (error) { setNote(errorText(error)); }
        refresh();
        return designated;
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
      // A line that is not a refusal: turning review on made this computer the Agent's reviewer (D-1026a).
      const [info, setInfo] = useState("");
      useEffect(() => { setOpen(null); setConfirming(null); setNote(""); setInfo(""); }, [sessionId]);
      // Nothing to show until the launcher can read this conversation. Without a Board yet (no Rulith call so far) the
      // tier reads "默认": the first choice opens the Board with the Agent's defaults and then applies.
      if (!settings || !settings.ok) return null;
      // A deleted conversation cannot go on: no tier, model or review to set (its deletion may still be finishing).
      if (settings.conversation && settings.conversation.endedAt)
        return h("span", { "data-rulith-composer": sessionId, "data-rulith-ended": "", style: { ...small, marginLeft: 4 } }, T.composer.ended);
      const fresh = settings.found === false;
      const tier = fresh ? { mode: undefined, mixed: false } : conversationTier(settings.conversation);
      const close = () => { setOpen(null); setConfirming(null); setInfo(""); };
      const choose = (next) => {
        // Narrowing applies at once; widening first shows the approved confirmation (a fresh conversation counts from strict).
        if (MODE_ORDER.indexOf(next) > MODE_ORDER.indexOf(fresh ? "strict" : tier.mode)) { setConfirming(next); return; }
        close(); applyMode(next);
      };
      const tierLabel = TIER.label + (fresh ? TIER.fresh : tier.mode ? MODE_WORDS[tier.mode] + (tier.mixed ? TIER.mixed : "") : TIER.unreadable);
      const tierChip = h("span", { key: "tier", style: { position: "relative", display: "inline-flex" }, "data-rulith-tier": fresh ? "default" : tier.mode || "unknown" },
        h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === "tier", title: TIER.title,
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
              h("div", { style: { ...small, padding: "2px 8px 4px" } }, fresh ? TIER.menuFresh : tier.mixed ? TIER.menuMixed : TIER.menu),
              MODE_ORDER.map((mode) => h("button", { key: mode, type: "button", role: "menuitemradio", "aria-checked": mode === tier.mode,
                style: { ...item, fontWeight: mode === tier.mode ? 600 : 400 }, disabled: (!fresh && !tier.mode) || (mode === tier.mode && !tier.mixed),
                onClick: () => choose(mode) }, (mode === tier.mode ? "● " : "○ ") + MODE_WORDS[mode], h("span", { style: small }, T.p.dot + MODE_HINTS[mode]))))) : null);
      // The model in force for this conversation's Agent; changed on the settings page (one place for the model).
      const current = model && model.ok && model.model ? model.model : null;
      const modelChip = h("button", { key: "model", type: "button", style: chip, "data-rulith-model": current ? current.modelId || "" : "",
        title: current && current.source === "override" ? T.composer.modelTitleOverride : T.composer.modelTitle,
        onClick: () => openSettings("model") }, fill(T.composer.model, { name: !current ? "…" : current.configured ? current.modelId || current.name : T.composer.modelNotSet }));
      // The post-call review switch, in every mode (D-1026a). A conversation with no Board yet shows the Agent's default for
      // new conversations (an older service that does not say it: "Default"); the first choice opens its Board, as for the
      // tier. Turning it on when the Agent has no reviewer makes this computer the reviewer (useConversationSettings).
      const freshDefault = typeof settings.reviewNewConversations === "boolean" ? settings.reviewNewConversations : undefined;
      const reviewOn = fresh ? freshDefault : !!(settings.conversation && settings.conversation.postCallReview === true);
      const marked = (on) => reviewOn === on;
      const review = h("span", { key: "review", style: { position: "relative", display: "inline-flex" }, "data-rulith-review": reviewOn === undefined ? "default" : reviewOn ? "on" : "off" },
        h("button", { type: "button", style: chip, "aria-haspopup": "menu", "aria-expanded": open === "review", title: T.composer.reviewTitle,
          onClick: () => setOpen(open === "review" ? null : "review") }, fill(T.composer.review, { state: reviewOn === undefined ? T.composer.reviewDefault : reviewOn ? T.composer.reviewOn : T.composer.reviewOff }), h("span", { style: { opacity: 0.6 } }, "▾")),
        open === "review" ? h("div", { role: "menu", style: menu },
          h("div", { style: { ...small, padding: "2px 8px 4px" } }, T.composer.reviewMenu),
          [[true, T.composer.reviewOnItem], [false, T.composer.reviewOffItem]].map(([on, words]) => h("button", { key: String(on), type: "button", role: "menuitemradio",
            "aria-checked": marked(on), style: { ...item, fontWeight: marked(on) ? 600 : 400 }, disabled: !fresh && marked(on),
            onClick: async () => { close(); if (await applyReview(on)) setInfo(T.reviewSettings.designated); } }, (marked(on) ? "● " : "○ ") + words))) : null);
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4 }, "data-rulith-composer": sessionId },
        tierChip, modelChip, review,
        note ? h("span", { role: "alert", style: { ...small, color: AMBER, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }, title: note }, note) : null,
        info ? h("span", { role: "status", "data-rulith-review-designated": "", style: { ...small, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }, title: info }, info) : null);
    }

    // ---- Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01, D-1018b batch 3). The owner picks a folder under an
    // Agent, reads what opening it grants, confirms once, and a new conversation starts in it when it is ready. What is
    // granted (folder, Agent, computer, tools, mode) is the Gateway's answer, shown as it is; the wording is ours.
    const TOOL_WORDS = T.tools;
    // A tool in plain words, without its id or version; a tool this page has no words for is named by its id without the
    // version (never left out: the confirmation lists every tool the opening grants).
    const toolWords = (id) => {
      const name = String(id || "").replace(/@\d+$/, "");
      return TOOL_WORDS[name.replace(/^eng\./, "")] || name;
    };
    const unique = (values) => values.filter((value, index) => value && values.indexOf(value) === index);
    // What each mode the Gateway may request means for the owner. A mode this page cannot explain is not offered.
    const MODE_MEANING = T.project.modeMeaning;
    /**
     * The confirmation for one state reply, or why it cannot be shown. Pure. Everything SYS-LOCAL-01 (PSC 0.2.24) requires
     * the confirmation to list is in view: the folder, the Agent and this computer, what may be done there, the tools it
     * uses (in plain words, with the capability they come from), what the tier means, that "in the folder" is not
     * operating-system isolation, and how to withdraw it. The tool ids with their versions, the capability's id and version,
     * the Connection's name and the account are under 「详细」 (design §3.2 打开确认框, §2: no internal word in view).
     * 中文说明：规定要列出的各项（含所用工具）都直接显示；带版本的工具标识、能力标识与版本、本机连接名和账户只在「详细」里。
     */
    function projectConfirmation(view) {
      const v = view || {};
      const tools = Array.isArray(v.tools) ? v.tools : [];
      const requested = v.mode && v.mode.requested;
      if (!v.directory || !v.accountId || !v.agentName || !v.computer || !tools.length || !v.authorizationVersion || !requested)
        return { error: T.project.incomplete };
      if (!own(MODE_MEANING, requested))
        return { error: T.project.unexplained };
      const capability = v.capability && v.capability.id ? v.capability.id : "";
      const P = T.project;
      // The tools in plain words; the list starts a sentence unless its first entry is a tool this page has no words for.
      const named = unique(tools.map((tool) => toolWords(tool.id)));
      const toolList = Object.values(TOOL_WORDS).includes(named[0]) ? capital(named.join(T.p.list)) : named.join(T.p.list);
      return {
        title: P.title,
        rows: [
          [P.folder, v.directory],
          [P.agent, fill(P.agentValue, { agent: v.agentName, computer: v.computer.label || T.common.unnamedComputer })],
          [P.canDo, P.canDoValue],
          [P.tools, toolList + T.p.stop + (capability ? (LOCALE === "en" ? " " : "") + P.fromCapability : "")],
          [P.mode, MODE_MEANING[requested]],
          [P.note, P.noteValue],
          [P.withdraw, P.withdrawValue],
        ],
        details: [
          [P.account, v.accountName || v.accountId],
          [P.toolsVersions, tools.map((tool) => String(tool.id || "")).join(T.p.list)
            + (capability ? T.p.stop + (LOCALE === "en" ? " " : "") + fill(P.capability, { id: capability + (v.capability.version ? " " + v.capability.version : "") }) : "") + T.p.stop],
          ...(v.connectionName ? [[P.connection, v.connectionName]] : []),
        ],
        footer: P.footer,
        accept: P.accept, cancel: P.cancel,
      };
    }
    // Plain words for every refusal the open-project routes name; anything else shows the service's own words.
    // The setup that runs before opening (repair) stopped where only the owner can decide (SYS-LOCAL-01): the confirmation
    // is under “Set up on this computer” (runtime_credential_exists, connection_rejected, connection_missing, worker_taken_over,
    // local_setup_connection_in_use).
    const PROJECT_REFUSALS = T.project.refusals;
    // Why the service refuses a folder (Gateway ProjectDirectory's fixed sentences), in plain words.
    const FOLDER_WORDS = [
      [/whole drive or share/i, T.project.folderWords.wholeDrive],
      [/filesystem root/i, T.project.folderWords.root],
      [/contain a colon/i, T.project.folderWords.colon],
      [/points back at this computer|administrative share/i, T.project.folderWords.loopback],
      [/backslash in this path/i, T.project.folderWords.backslash],
      [/starting with \/\//i, T.project.folderWords.slashes],
      [/device path/i, T.project.folderWords.device],
      [/name a server and a share/i, T.project.folderWords.share],
      [/This computer runs Windows/i, T.project.folderWords.windows],
      [/This computer is not Windows/i, T.project.folderWords.notWindows],
    ];
    function refusalText(reply) {
      const code = reply && reply.errorCode;
      if (code && own(PROJECT_REFUSALS, code)) return PROJECT_REFUSALS[code];
      const teaching = String((reply && reply.teaching) || "");
      const folder = code === "bad_command" ? FOLDER_WORDS.find(([pattern]) => pattern.test(teaching)) : undefined;
      const said = folder ? folder[1] : plain(teaching, "");
      return (code === "bad_command" ? T.project.badFolder : T.project.notOpened) + (said ? T.p.colon + said : T.p.stop);
    }
    // Why the dialog is shown again: this opening reached a state that retrying does not change (409, confirm_again).
    const AGAIN_WORDS = T.project.again;
    const againText = (state) => own(AGAIN_WORDS, state) || AGAIN_WORDS.other;
    function progressText(view) {
      const v = view || {};
      const n = { configuration: 1, program: 2, mode: 3 }[v.stage];
      const at = n ? fill(T.project.step, { n }) : "";
      if (v.waitingFor === "agent_call_pending") return at + T.project.agentCall;
      if (v.state === "mode_refused") return at + T.project.modeRetry;
      if (v.stage === "configuration") return at + T.project.configuration;
      if (v.stage === "program") return at + T.project.program;
      if (v.stage === "mode") return at + T.project.modeStage;
      return T.project.opening;
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
    const LATER = T.project.later;
    const CHANGED = T.project.changed;
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
      const STOPPED = { outcome: "stopped", text: fill(T.project.stopped, { later: LATER }) };
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
          if (confirmations >= 3) return { outcome: "refused", text: fill(T.project.manyTimes, { again: againText(view.state) }) };
          const shown = projectConfirmation(view);
          if (shown.error) return { outcome: "refused", text: shown.error };
          const accepted = await ui.confirm(view, note || (view.recovery === "confirm_again" ? againText(view.state) : ""));
          if (!accepted) return { outcome: "cancelled" };
          confirmations++; note = ""; waited = 0; pause = 0;
          request = { agentId, directory, requestId: newRequestId(), authorizationVersion: view.authorizationVersion,
            expectedAccountId: view.accountId };
          ui.progress(T.project.opening);
          view = await resend(); continue;
        }
        if (waited >= maxWaitMs) return { outcome: "waiting", text: fill(T.project.notYet, { progress: progressText(view), later: LATER }) };
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
            h("summary", { style: { cursor: "pointer", opacity: 0.8 } }, T.project.details), confirmation.details.map(line)),
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
    function FolderChooser({ disabled, onChosen, label = T.folder.open, indent = 0 }) {
      const [manual, setManual] = useState(false);
      const [path, setPath] = useState("");
      const [picking, setPicking] = useState(false);
      const [note, setNote] = useState("");
      const choose = async (value) => { if (await onChosen(value)) { setPath(""); setManual(false); setNote(""); } };
      const pick = async () => {
        if (disabled || picking) return;
        setPicking(true); setNote("");
        let reply;
        try { reply = await api("pick-folder", {}); } catch (error) { reply = { ok: false, own: true, teaching: errorText(error) }; }
        setPicking(false);
        if (reply.ok && reply.state === "chosen" && reply.path) choose(reply.path);
        else if (!reply.ok || reply.state === "unavailable") { setManual(true); setNote(plain(reply, T.folder.pickerUnavailable)); }
      };
      const submit = () => { if (!disabled && path.trim()) choose(path.trim()); };
      return h("div", { "data-rulith-folder-chooser": "", style: { padding: "2px 6px 2px " + (18 + indent) + "px" } },
        manual
          ? h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
            h("input", { value: path, autoFocus: true, placeholder: T.folder.path, disabled,
              onChange: (event) => setPath(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") submit(); else if (event.key === "Escape" && !disabled) setManual(false); },
              style: { ...field, flex: 1, minWidth: 0, padding: "2px 6px", fontSize: 12 } }),
            h("button", { type: "button", style: { ...button, padding: "1px 8px", fontSize: 11 }, disabled: disabled || !path.trim(), onClick: submit }, T.folder.openButton),
            h("button", { type: "button", title: T.folder.cancel, style: { ...linkButton, textDecoration: "none" }, disabled, onClick: () => { setManual(false); setNote(""); } }, "×"))
          : h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
            h("button", { type: "button", "data-rulith-pick-folder": "", disabled: disabled || picking, title: T.folder.pickTitle,
              style: { ...linkButton, textDecoration: "none", opacity: 0.8, fontSize: 12.5 }, onClick: pick }, picking ? T.folder.picking : label),
            picking ? null : h("button", { type: "button", "data-rulith-type-folder": "", disabled, style: { ...linkButton, fontSize: 11 }, onClick: () => setManual(true) }, T.folder.typePath)),
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
        return reply.ok ? "" : plain(reply, T.project.assignFailed);
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
    const DELETION_WORDS = { closings_unconfirmed: (n) => (n ? fill(T.deletion.closings, { n }) : T.deletion.someClosings),
      goals_unread: () => T.deletion.goalsUnread, deleted_before_recording: () => T.deletion.deletedBeforeRecording,
      // PSC 0.2.28 erratum: every closing is answered and the goals were read; only the finished record is missing (补完删除 records it).
      settlement_unrecorded: () => T.deletion.settlementUnrecorded, unfinished: () => T.deletion.unfinished };
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
      // Why it is not finished, as codes (`{ code, count }`): kept on this computer as they are and put into words when
      // shown, in the page's language of that moment (deletionWords).
      const codes = [];
      if (d && Array.isArray(d.reasons)) for (const reason of d.reasons)
        codes.push({ code: String((reason && reason.code) || "unfinished"), ...(Number.isSafeInteger(reason && reason.count) ? { count: reason.count } : {}) });
      const unconfirmed = Array.isArray(r.unconfirmedGoals) ? r.unconfirmedGoals.length : 0;
      if (!d && unconfirmed) codes.push({ code: "closings_unconfirmed", count: unconfirmed });
      if (!d && r.goalsUnread) codes.push({ code: "goals_unread" });
      const settled = typeof r.settled === "boolean" ? r.settled : d && typeof d.settled === "boolean" ? d.settled : codes.length === 0;
      const kept = settled ? [] : codes.length ? codes : [{ code: "unfinished" }];
      return { settled, reasons: deletionWords(kept), codes: kept, refused };
    }
    /** Stored reasons in words: a code in the page's language (a code this page has no words for as it is), an older
     * entry kept as words as it was. Pure. */
    function deletionWords(reasons) {
      return [].concat(reasons || []).map((reason) => {
        if (typeof reason === "string") return reason;
        const code = reason && typeof reason.code === "string" ? reason.code : "unfinished";
        const words = own(DELETION_WORDS, code);
        return words ? words(reason.count) : code;
      });
    }
    const samePath = (p) => String(p || "").replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
    const agoText = (ms) => {
      if (!Number.isFinite(ms)) return "";
      const m = Math.round((Date.now() - ms) / 60000);
      const ago = T.tree.ago;
      return m < 1 ? ago.now : fill(m < 60 ? ago.minutes : m < 1440 ? ago.hours : ago.days, { n: m < 60 ? m : m < 1440 ? Math.round(m / 60) : Math.round(m / 1440) });
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
        if (!group.dirs.has(key)) group.dirs.set(key, { dir: { path: s.cwd || "", label: baseName(s.cwd) || T.tree.otherFolder, source: null, extra: true }, sessions: [] });
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
        if (!otherDirs.has(key)) otherDirs.set(key, { key: "others|" + key, path: s.cwd || "", label: baseName(s.cwd) || T.tree.otherFolder, sessions: [] });
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
        if (!wide) return h("button", { type: "button", title: T.tree.expand, onClick: expandSidebar,
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
          const title = s.blank ? T.tree.newConversation : (s.title && s.title.trim()) || T.tree.untitled;
          try {
            const preview = await api("conversation/end-preview", { session: s.id });
            if (!preview.ok) { setNote(plain(preview, T.tree.recordUnreadable)); return; }
            if (preview.pendingCall) { setNote(T.tree.deletePending); return; }
            setDeleting({ id: s.id, title, agentName, found: preview.found !== false, goals: Array.isArray(preview.openGoals) ? preview.openGoals.length : 0 });
          } catch (error) { setNote(errorText(error)); }
        };
        // Delete (or finish deleting) one conversation. Its request id is fixed by the conversation (host), so 补完删除 is the
        // same deletion continued. Only a finished deletion takes the row away (PSC 0.2.27 ⑤).
        const endConversation = async (id) => {
          setBusy("delete");
          try {
            const reply = await api("conversation/end", { session: id });
            if (!reply.ok) { setNote(plain(reply, T.tree.notDeleted)); return; }
            setDeleting(null);
            const outcome = deletionOutcome(reply);
            if (!outcome.settled) {
              const next = { ...unsettled, [id]: outcome.codes }; setUnsettled(next); saveUnsettled(next);
              setNote(fill(T.tree.partial, { reasons: outcome.reasons.join(T.p.semi) })); refreshTree(); return;
            }
            if (unsettled[id]) { const next = { ...unsettled }; delete next[id]; setUnsettled(next); saveUnsettled(next); }
            if (outcome.refused) setNote(fill(T.tree.deletedRefused, { n: outcome.refused }));
            await archive(id);
            refreshTree();
          } catch (error) { setNote(errorText(error)); }
          finally { setBusy(""); }
        };
        const confirmDelete = () => { if (deleting && !busy) return endConversation(deleting.id); };
        const startSession = async (agent, directory) => {
          try { const problem = await startIn(agent, directory); if (problem) setNote(problem); refreshTree(); }
          catch (error) { setNote(fill(T.tree.newFailed, { error: errorText(error) })); }
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
          } catch (error) { setNote(fill(T.tree.projectNotOpened, { error: errorText(error) })); return false; }
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
            s.blank ? T.tree.newConversation : (s.title && s.title.trim()) || T.tree.untitled),
          unsettled[s.id] ? h("span", { "data-rulith-unsettled": s.id, title: deletionWords(unsettled[s.id]).join(T.p.semi),
              style: { ...small, flex: "none", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: AMBER, opacity: 1 } },
              fill(T.tree.unsettled, { reasons: deletionWords(unsettled[s.id]).join(T.p.semi) }))
            : h("span", { style: { ...small, flex: "none" } }, agoText(s.updatedAt)),
          s.origin === "subagent" ? h("span", { style: small }, T.tree.subConversation)
            : unsettled[s.id] ? h("button", { type: "button", "data-rulith-finish-delete": s.id, disabled: !!busy, style: { ...tiny, color: AMBER, opacity: 1 },
                title: fill(T.tree.finishTitle, { reasons: deletionWords(unsettled[s.id]).join(T.p.semi) }),
                onClick: (event) => { event.stopPropagation(); if (!busy) endConversation(s.id); } }, T.tree.finish)
            : h("button", { type: "button", title: T.tree.deleteTitle, "data-rulith-delete": s.id, style: tiny, onClick: (event) => { event.stopPropagation(); askDelete(s, agentName); } }, T.tree.delete));
        const dirBlock = (entry, d) => {
          const key = "d:" + d.key;
          const shut = collapsed[key] === true && !filter;
          const showAll = !!more[d.key] || !!filter;
          const shown = showAll ? d.sessions : d.sessions.slice(0, SHOWN);
          return h("div", { key: d.key, "data-rulith-directory": d.path },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 6px 2px 18px", fontSize: 12.5, opacity: 0.9 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle(key, !shut) }, shut ? "▸" : "▾"),
              h("span", { title: d.path, style: { flex: 1, minWidth: 0, wordBreak: "break-word" } },
                "📁 " + (d.label || baseName(d.path)) + (d.source === null && !d.extra ? T.tree.notProject : "")),
              h("span", { style: small }, d.sessions.length || ""),
              entry.agent.attached ? h("button", { type: "button", title: T.tree.newInFolder, disabled: !!busy, style: tiny,
                onClick: () => newSession(entry.agent, d) }, "+") : null),
            shut ? null : h("div", null, shown.map((s) => sessionRow(s, entry.agent.name)),
              d.sessions.length > SHOWN && !filter ? h("button", { type: "button", style: { ...tiny, padding: "1px 34px", fontSize: 12 },
                onClick: () => setMore({ ...more, [d.key]: !showAll }) }, showAll ? T.tree.less : fill(T.tree.more, { n: d.sessions.length - SHOWN })) : null));
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
              entry.isDefault ? h("span", { "data-rulith-default": "", title: T.tree.defaultTitle, style: { ...small, fontWeight: 400 } }, T.tree.default) : null,
              entry.count ? h("span", { style: { ...small, fontWeight: 400 } }, entry.count) : null,
              !a.attached ? h("button", { type: "button", "data-rulith-setup-agent": a.agentId, disabled: !!busy, style: { ...button, padding: "0 6px", fontSize: 11 }, onClick: () => setUp(a) },
                  busy === "setup:" + a.agentId ? T.setup.settingUp : T.setup.setUp)
                : firstDir(entry) ? h("button", { type: "button", title: T.tree.newUnderAgent, disabled: !!busy, style: tiny, onClick: () => newSession(a, firstDir(entry)) }, "+") : null),
            setup.run && setup.run.agentId === a.agentId && !(setup.run.settled && setup.run.ok && a.attached) ? h("div", { style: { padding: "0 6px 0 26px" } }, h(SetupSteps, { run: setup.run, onReplace: () => setUp(a, true) })) : null,
            entry.open && a.attached ? h("div", null, entry.dirs.map((d) => dirBlock(entry, d)),
              // The directory level's last row: open another folder of this computer as one of this Agent's projects.
              h(FolderChooser, { key: "folders-" + a.agentId, disabled: !!busy, onChosen: (directory) => openFolder(a, directory) }),
              opensHere && opening.progress ? h("div", { role: "status", style: { ...small, display: "flex", gap: 6, alignItems: "baseline", padding: "2px 6px 2px 18px" } },
                h("span", { style: { flex: 1 } }, opening.progress),
                h("button", { type: "button", style: { ...tiny, fontSize: 11 }, onClick: opening.stop }, T.folder.stopWaiting)) : null) : null);
        };
        return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, overflow: "auto", padding: "4px 6px" }, "data-rulith-tree": "" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" } },
            h("span", { style: { ...section, margin: 0, flex: 1 } }, T.tree.agents),
            h("button", { type: "button", title: T.tree.newHereTitle, disabled: !!busy || !ready, style: tiny, onClick: startHere }, T.tree.newHere)),
          h("input", { value: filter, placeholder: T.tree.filter, onChange: (event) => setFilter(event.target.value),
            style: { margin: "2px 6px 8px", padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit", fontSize: 12 } }),
          !tree ? none(T.tree.readingAgents)
            : !ready ? h("div", { style: { ...small, padding: "0 6px 8px" } }, plain(tree, T.tree.agentsUnreadable)) : null,
          view.agents.map(agentBlock),
          view.others.count ? h("div", { style: { marginTop: 6 }, "data-rulith-unowned": "" },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 13, opacity: 0.8 } },
              h("button", { type: "button", style: { ...tiny, padding: 0, width: 14 }, onClick: () => toggle("others", view.others.open) }, view.others.open ? "▾" : "▸"),
              h("span", { style: { flex: 1 } }, T.tree.unowned),
              h("span", { style: small }, view.others.count)),
            view.others.open ? view.others.dirs.map((d) => dirBlock({ agent: { attached: false } }, d)) : null) : null,
          note ? h("div", { role: "alert", style: { ...small, color: AMBER, padding: "4px 6px" } }, note) : null,
          deleting ? backdrop(2000, () => { if (!busy) setDeleting(null); },
            h("div", { role: "dialog", "aria-modal": "true", "data-rulith-delete-dialog": deleting.id, onClick: (event) => event.stopPropagation(), style: card(420) },
              h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, T.tree.dialogTitle),
              deleting.found
                ? h("div", null,
                    h("div", null, fill(deleting.agentName ? T.tree.introAgent : T.tree.intro, { title: deleting.title, agent: deleting.agentName })),
                    h("div", null, "· " + T.tree.sealed),
                    deleting.goals ? h("div", null, "· " + fill(T.tree.goals, { n: deleting.goals })) : null,
                    h("div", null, "· " + T.tree.kept),
                    h("div", { style: { marginTop: 6 } }, T.tree.undone))
                : h("div", null, fill(T.tree.notFound, { title: deleting.title })),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
                h("button", { type: "button", style: button, disabled: !!busy, onClick: () => setDeleting(null) }, T.tree.keep),
                h("button", { type: "button", style: { ...button, borderColor: RED, color: RED }, disabled: !!busy, onClick: confirmDelete },
                  busy === "delete" ? T.tree.deleting : T.tree.delete)))) : null,
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
      const steps = [{ id: "signin", label: T.wizard.steps.signin, done: signedIn }, { id: "model", label: T.wizard.steps.model, done: modelReady },
        { id: "folder", label: T.wizard.steps.folder, done: modelReady && folderOpen }];
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
          try { const reply = await signInFlow({ api }); if (reply.ok) setState(reply); else setNotice(plain(reply, T.signIn.failed)); }
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
              if (!attached) { setNotice(T.wizard.notAttached); return false; }
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
          } catch (error) { setNotice(fill(T.tree.projectNotOpened, { error: errorText(error) })); return false; }
          finally { setWorking(false); }
        };
        // The owner confirmed replacing the Agent's token under the setup's steps: set it up again with that confirmation
        // and go on opening the folder chosen before.
        const replaceAndOpen = () => (retryFolder ? openFolder(retryFolder, true)
          : agent ? setup.start(agent.agentId, "setup", { replaceAgentToken: true }) : undefined);
        let body;
        if (view.current === "signin") body = h("div", null,
          h("div", null, T.wizard.signinLine),
          state && plain(state, "") ? h("div", { style: small }, plain(state, "")) : null,
          h("div", { style: { marginTop: 10 } }, h("button", { type: "button", style: primary, disabled: !!busy, onClick: signIn }, busy === "signin" ? T.signIn.waiting : T.signIn.button)));
        else if (view.current === "model") body = h("div", null,
          h("div", { style: { marginBottom: 4 } }, T.wizard.modelLine),
          h(ModelForm, { onSaved: () => refreshModel() }));
        else body = h("div", null,
          h("div", null, T.wizard.folderLine),
          !tree ? none(T.tree.readingAgents)
            : !tree.ok ? alertLine(plain(tree, T.wizard.agentsUnreadable))
            : !agents.length ? alertLine(T.wizard.noAgents)
            : named ? h("div", { style: { ...small, marginTop: 6 } }, fill(T.wizard.agent, { name: named.name + (named.isDefault ? T.common.default : "") }))
            : h("label", { style: { display: "block", marginTop: 6 } }, h("span", { style: small }, T.wizard.agentLabel),
                h("select", { value: chosenAgent, disabled: working, onChange: (event) => setChosenAgent(event.target.value), style: { ...field, width: "auto" } },
                  h("option", { value: "" }, T.wizard.chooseAgent), agents.map((a) => h("option", { key: a.agentId, value: a.agentId }, a.name)))),
          agent ? h("div", { style: { marginTop: 8 } }, h(FolderChooser, { disabled: working, onChosen: openFolder, indent: -18, label: T.folder.choose })) : null,
          setup.run && setup.run.agentId === (agent && agent.agentId) ? h(SetupSteps, { run: setup.run, onReplace: replaceAndOpen }) : null,
          opening.progress ? h("div", { role: "status", style: { ...small, display: "flex", gap: 6, marginTop: 6 } },
            h("span", { style: { flex: 1 } }, opening.progress), h("button", { type: "button", style: linkButton, onClick: opening.stop }, T.folder.stopWaiting)) : null);
        return backdrop(1500, undefined,
          h("div", { role: "dialog", "aria-modal": "true", "data-rulith-wizard": view.current || "", style: card(540) },
            h("div", { style: { fontWeight: 700, fontSize: 16, marginBottom: 10 } }, T.wizard.title),
            h("div", { style: { display: "flex", gap: 14, marginBottom: 14, fontSize: 12 } }, view.steps.map((step, i) => h("span", { key: step.id,
              "data-wizard-step": step.id, "data-done": step.done ? "1" : "0",
              style: { fontWeight: step.id === view.current ? 700 : 400, opacity: step.id === view.current || step.done ? 1 : 0.5, color: step.done ? GREEN : "inherit" } },
              (step.done ? "✓ " : ["①", "②", "③"][i] + " ") + step.label))),
            body,
            h(LegacyWorkbenchNotice, { legacy: state && state.legacyWorkbench }),
            notice ? alertLine(notice) : null,
            h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 14 } },
              h("button", { type: "button", style: linkButton, disabled: working, onClick: () => setPut(view.account) }, T.wizard.later)),
            h(ProjectDialog, { asking: opening.asking, answer: opening.answer })));
      };
    }

    // ---- One Rulith settings page (design §3.2 设置): 账户, 这台电脑, 模型, 外观与语言, 高级; one entry in the sidebar foot.
    const SETTINGS_SECTIONS = ["account", "computer", "model", "appearance", "advanced"].map((id) => [id, T.settings.sections[id]]);
    const pair = (label, value) => h("div", { style: { display: "flex", gap: 10, padding: "3px 0" } },
      h("div", { style: { flex: "none", width: 72, opacity: 0.7 } }, label), h("div", { style: { flex: 1, wordBreak: "break-word" } }, value));
    function AccountSection({ state, setState }) {
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      if (!state) return none(T.common.reading);
      if (!state.ok) return alertLine(plain(state, T.settings.localUnreadable));
      const run = async (label, action) => {
        setBusy(label); setNotice("");
        try { const reply = await action(); if (reply && reply.ok === false) setNotice(plain(reply, T.settings.actionFailed));  else if (reply && reply.ok) setState(reply); }
        catch (error) { setNotice(errorText(error)); } finally { setBusy(""); }
      };
      return h("div", { "data-rulith-settings-account": "" },
        pair(T.settings.account, state.signedIn ? state.account || T.settings.unnamedAccount : T.settings.notSignedIn),
        !state.signedIn && plain(state, "") ? h("div", { style: small }, plain(state, "")) : null,
        h("div", { style: { marginTop: 10 } }, state.signedIn
          ? h("button", { type: "button", style: button, disabled: !!busy, onClick: () => run("signout", () => api("signout", {})) }, busy === "signout" ? T.settings.signingOut : T.settings.signOut)
          : h("button", { type: "button", style: primary, disabled: !!busy, onClick: () => run("signin", () => signInFlow({ api })) }, busy === "signin" ? T.signIn.waiting : T.signIn.button)),
        notice ? alertLine(notice) : null);
    }
    function ComputerSection({ state, refresh }) {
      const setup = useSetupRun();
      if (!state) return none(T.common.reading);
      if (!state.ok) return alertLine(plain(state, T.settings.localUnreadable));
      if (!state.signedIn) return none(T.settings.computerSignInFirst);
      const agents = Array.isArray(state.agents) ? state.agents : [];
      // Every click is the explicit setup: it checks this computer's Connection, and it may start a Worker that stopped
      // itself (PSC 0.2.27 ③). Replacing the Agent token only after the owner confirmed it under the steps (`replace`).
      const setUp = async (agent, replace = false) => { await setup.start(agent.id, "setup", { replaceAgentToken: replace }); refresh(); };
      return h("div", { "data-rulith-settings-computer": "" },
        pair(T.settings.computer, state.computer || T.settings.unnamedComputer),
        h("div", { style: { ...small, margin: "4px 0 8px" } }, T.settings.setupHint),
        agents.length ? agents.map((agent) => {
          const words = workerWords(agent);
          return h("div", { key: agent.id, "data-rulith-computer-agent": agent.id, style: { padding: "4px 0" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, dot(words.color),
              h("span", { style: { flex: 1 } }, agent.name + (agent.isDefault === true ? T.common.default : "")),
              h("span", { style: small }, words.text),
              h("button", { type: "button", style: button, disabled: setup.busy, onClick: () => setUp(agent) }, T.setup.setUp)),
            setup.run && setup.run.agentId === agent.id ? h(SetupSteps, { run: setup.run, onReplace: () => setUp(agent, true) }) : null);
        }) : none(T.settings.noAgents));
    }
    // The page's language is the browser's (LOCALE), and dsh's own words follow it (followLocale): there is no second
    // language choice here that would change only part of the page.
    function AppearanceSection() {
      const [, setTick] = useState(0);
      const theme = shared.theme;
      const bump = () => setTick((n) => n + 1);
      const select = (value, options, onChange) => h("select", { value, onChange: (event) => onChange(event.target.value), style: { ...field, width: "auto" } },
        options.map(([id, label]) => h("option", { key: id, value: id }, label)));
      const S = T.settings;
      return h("div", { "data-rulith-settings-appearance": "" },
        theme ? pair(S.appearance, select((theme.getTheme() || {}).preference || "system", [["system", S.system], ["light", S.light], ["dark", S.dark]],
          (id) => { try { theme.setTheme(id); } catch {} bump(); })) : none(S.noAppearance),
        pair(S.language, h("span", { "data-rulith-language": LOCALE }, S.languageValue)),
        h("div", { style: { ...small, marginTop: 6 } }, S.languageNote));
    }
    function AdvancedSection({ state, refresh }) {
      let consoleUrl = "";
      try { const origin = new URL(state && state.origin).origin; if (/^https?:/.test(origin)) consoleUrl = origin + "/console/#/agents"; } catch {}
      return h("div", { "data-rulith-settings-advanced": "" },
        h("div", { style: section }, T.settings.otherClients),
        h("div", null, T.settings.otherClientsLine),
        consoleUrl ? h("a", { href: consoleUrl, target: "_blank", rel: "noopener noreferrer", style: { fontSize: 12 } }, T.settings.openInConsole) : null,
        h(ReviewSection, { state }),
        h(IsolationSection, { state, refresh }),
        h(DiagnosisSection, { state }));
    }
    // Settings → Advanced → Post-call review (D-1026a, owner 2026-10-26): review is optional in every exploration mode and
    // needs no Console. For each Agent of the account: whether new conversations are reviewed (the composer's chip changes
    // one conversation), who reviews (this computer, another computer, or none) with "Use this computer", and
    // the review deadline in seconds (60–300), sent with the designation, so it is changed here only while this computer
    // reviews. Turning the default on for an Agent with no reviewer makes this computer its reviewer (the host does it).
    // The reviewer reads each write call after it runs and may add advice to its result; it never blocks a call. Read and
    // set through /rulith/api/review (local-setup.mjs reviewRoutes); no Connection id reaches the page.
    // 中文说明：事后审查在每个档位都可选，不需要 Console；这里设每个智能体的新会话默认值、审查员和审查期限。
    function ReviewSection({ state }) {
      if (!state || !state.ok || !state.signedIn) return null;
      const agents = Array.isArray(state.agents) ? state.agents : [];
      if (!agents.length) return null;
      const R = T.reviewSettings;
      return h("div", { "data-rulith-settings-review": "" },
        h("div", { style: section }, R.title),
        h("div", { style: { ...small, marginBottom: 4 } }, R.explain),
        agents.map((agent) => h(AgentReview, { key: agent.id, agent })));
    }
    /** A deadline as typed: a whole number of seconds from 60 to 300, else null. Pure. */
    const reviewSeconds = (value) => (/^\s*\d+\s*$/.test(String(value)) && Number(value) >= 60 && Number(value) <= 300 ? Number(value) : null);
    function AgentReview({ agent }) {
      const [view, refresh] = usePoll("review?agentId=" + encodeURIComponent(agent.id), 60000);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [typed, setTyped] = useState(null);
      const R = T.reviewSettings;
      const head = h("div", { style: { fontWeight: 600, marginTop: 6 } }, agent.name + (agent.isDefault === true ? T.common.default : ""));
      if (!view) return h("div", { "data-rulith-review-agent": agent.id }, head, none(T.common.reading));
      if (!view.ok) return h("div", { "data-rulith-review-agent": agent.id }, head, alertLine(plain(view, R.unreadable)));
      const deadline = typed !== null ? typed : String(view.reviewSeconds || 60);
      const run = async (route, body) => {
        setBusy(true); setNotice(null);
        let reply;
        try { reply = await api(route, body); } catch (error) { reply = { ok: false, own: true, teaching: errorText(error) }; }
        setBusy(false);
        if (reply && reply.ok) setTyped(null);
        // "This computer now reviews…" only when this request made it the reviewer (the host says so); else just saved.
        setNotice(reply && reply.ok ? { ok: true, text: reply.designated === true ? R.designated : R.saved }
          : { ok: false, text: plain(reply, R.notSaved) });
        refresh();
      };
      // This computer becomes the reviewer with the deadline in the field (also how the deadline is changed while it reviews).
      const useHere = () => {
        const seconds = reviewSeconds(deadline);
        if (seconds === null) { setNotice({ ok: false, text: R.deadlineRange }); return undefined; }
        return run("review/reviewer", { agentId: agent.id, reviewer: "this", reviewSeconds: seconds });
      };
      const who = view.reviewer === "this" ? R.thisComputer : view.reviewer === "other" ? R.otherComputer : R.none;
      const row = { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", flexWrap: "wrap" };
      return h("div", { "data-rulith-review-agent": agent.id, style: { paddingBottom: 4 } },
        head,
        h("label", { style: { ...row, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: view.reviewNewConversations === true, disabled: busy || typeof view.reviewNewConversations !== "boolean",
            onChange: () => run("review/default", { agentId: agent.id, enabled: view.reviewNewConversations !== true }) }),
          h("span", null, R.newConversations)),
        h("div", { style: row, "data-rulith-reviewer": view.reviewer },
          h("span", { style: { flex: 1 } }, fill(R.reviewer, { name: who })),
          view.reviewer !== "this" && view.thisComputer ? h("button", { type: "button", style: button, disabled: busy, onClick: useHere }, R.useThisComputer) : null,
          view.reviewer !== "none" ? h("button", { type: "button", style: button, disabled: busy,
            onClick: () => run("review/reviewer", { agentId: agent.id, reviewer: "none" }) }, R.remove) : null),
        !view.thisComputer && view.reviewer !== "this" ? h("div", { style: small }, R.notHere) : null,
        h("div", { style: row },
          h("label", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", null, R.deadline),
            h("input", { type: "number", min: 60, max: 300, step: 1, value: deadline, disabled: busy || view.reviewer === "other",
              onChange: (event) => setTyped(event.target.value), style: { ...field, width: 80 } })),
          view.reviewer === "this" ? h("button", { type: "button", style: button, disabled: busy, onClick: useHere }, R.save) : null),
        notice ? (notice.ok ? h("div", { role: "status", style: small }, notice.text) : alertLine(notice.text)) : null);
    }
    // Settings → Advanced: the owner's "Run without isolation (not recommended)" for each Agent set up on this computer
    // (PSC 0.2.31 ③), off by default, shown only where model commands can be isolated (Windows, Linux). Turning it on asks
    // first, with the PSC's confirmation verbatim, and only "Run without isolation" sends it (with `confirmed`); turning it
    // off sends at once. The manager saves it in that Agent's own files on this computer and restarts its Worker with it;
    // the line under the switches says when it applies. When isolation is required again, what that Agent's commands
    // started without isolation and left running is ended before it starts isolated; under its switch the page names what
    // was stopped, and what could not be.
    const processNames = (rows) => (Array.isArray(rows) ? rows : []).map((row) => (row.name || "?") + T.p.open + row.pid + T.p.close).join(T.p.list);
    /** What was ended, or could not be, when isolation was required again for one Agent. Pure. */
    function sweepLines(sweep) {
      if (!sweep || typeof sweep !== "object") return null;
      const S = T.isolationSwitch, lines = [];
      if (sweep.stopped && sweep.stopped.length)
        lines.push(h("div", { key: "stopped", "data-rulith-isolation-sweep": "stopped", style: small }, fill(S.stopped, { names: processNames(sweep.stopped) })));
      if (sweep.failed && sweep.failed.length)
        lines.push(h("div", { key: "failed", "data-rulith-isolation-sweep": "failed", role: "alert", style: { fontSize: 12, color: AMBER } },
          fill(S.notStopped, { names: processNames(sweep.failed) })));
      if (sweep.error)
        lines.push(h("div", { key: "error", "data-rulith-isolation-sweep": "error", role: "alert", style: { fontSize: 12, color: AMBER } },
          fill(S.notChecked, { reason: sweep.error })));
      return lines.length ? lines : null;
    }
    function IsolationSection({ state, refresh }) {
      const [asking, setAsking] = useState(null);
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState(null);
      if (!state || !state.ok || !state.signedIn || state.isolationAvailable !== true) return null;
      const agents = (Array.isArray(state.agents) ? state.agents : []).filter((agent) => agent.paired && typeof agent.runWithoutIsolation === "boolean");
      if (!agents.length) return null;
      const S = T.isolationSwitch;
      const save = async (agent, on) => {
        setAsking(null); setBusy(agent.id); setNotice(null);
        let reply;
        try { reply = await api("isolation", on ? { agentId: agent.id, runWithoutIsolation: true, confirmed: true } : { agentId: agent.id, runWithoutIsolation: false }); }
        catch (error) { reply = { ok: false, own: true, teaching: errorText(error) }; }
        setBusy("");
        setNotice(reply && reply.ok ? { ok: true, text: fill(reply.restarting ? S.restarting : S.nextStart, { agent: agent.name }) }
          : { ok: false, text: plain(reply, S.notSaved) });
        if (refresh) refresh();
      };
      return h("div", { "data-rulith-settings-isolation": "" },
        h("div", { style: section }, S.title),
        agents.map((agent) => h("div", { key: agent.id, "data-rulith-isolation-agent": agent.id },
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" } },
            h("input", { type: "checkbox", checked: agent.runWithoutIsolation, disabled: !!busy,
              onChange: () => (agent.runWithoutIsolation ? save(agent, false) : setAsking(agent)) }),
            h("span", { style: { flex: 1 } }, S.label),
            h("span", { style: small }, agent.name + (agent.isDefault === true ? T.common.default : ""))),
          sweepLines(agent.isolationSweep))),
        notice ? (notice.ok ? h("div", { role: "status", style: { ...small, marginTop: 4 } }, notice.text) : alertLine(notice.text)) : null,
        asking ? backdrop(2000, () => setAsking(null),
          h("div", { role: "alertdialog", "aria-modal": "true", "data-rulith-isolation-dialog": asking.id, onClick: (event) => event.stopPropagation(), style: card(480) },
            h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } }, S.confirmTitle),
            h("div", null, S.confirmBody),
            h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 } },
              h("button", { type: "button", style: primary, onClick: () => setAsking(null) }, S.cancel),
              h("button", { type: "button", style: { ...button, borderColor: AMBER, color: AMBER }, onClick: () => save(asking, true) }, S.accept)))) : null);
    }
    // Agents the retired English workbench set up on this computer (the host's `legacyWorkbench`): their Workers do not
    // start with the app. Shown in the wizard and under Diagnosis.
    function LegacyWorkbenchNotice({ legacy }) {
      if (!legacy || !legacy.home) return null;
      const count = legacy.agents === 1 ? T.legacy.one : fill(T.legacy.many, { n: legacy.agents });
      return h("div", { "data-rulith-legacy-workbench": "", role: "note", style: { ...small, marginTop: 8, color: AMBER, wordBreak: "break-word" } },
        fill(T.legacy.notice, { count, home: legacy.home }));
    }
    // Settings → Advanced → Diagnosis (design §3.2 设置; batch 7 replaces the retired English workbench with it): versions,
    // this computer, model-command isolation and folders, from /rulith/api/diagnosis (whose sentences and folder names
    // the host gives in the page's language).
    function DiagnosisSection({ state }) {
      const [report] = usePoll("diagnosis", 60000);
      const agents = state && state.ok && Array.isArray(state.agents) ? state.agents : [];
      const line = (text, key) => h("div", { key, style: { padding: "2px 0", wordBreak: "break-word" } }, text);
      const D = T.diagnosis;
      let body;
      if (!report) body = none(D.reading);
      else if (!report.ok) body = alertLine(plain(report, D.unreadable));
      else {
        const v = report.versions || {};
        body = h("div", { "data-rulith-diagnosis": (report.isolation && report.isolation.state) || "" },
          line(fill(D.versions, { rulith: v.rulith || "?", dsh: v.dsh || "?", node: v.node || "?", platform: v.platform || "?" }), "versions"),
          line(fill(D.computer, { name: (state && state.computer) || D.unnamed, signedIn: state && state.signedIn ? D.signedIn : D.notSignedIn })
            + (agents.length ? T.p.dot + agents.map((a) => a.name + T.p.colon + (a.worker ? a.worker.state || (a.worker.enabled ? D.starting : D.off) : D.notSetUp)).join(T.p.list) : ""), "computer"),
          line(fill(D.isolation, { text: (report.isolation && report.isolation.text) || D.unknown }), "isolation"),
          // What could not be protected, and why (a credential folder, or a project folder that could not be made writable).
          ((report.isolation && report.isolation.problems) || []).map((p) => h("div", { key: "problem:" + p.kind + ":" + p.path, "data-rulith-isolation-problem": p.kind,
            style: { padding: "2px 0", wordBreak: "break-word", color: AMBER } },
            fill(p.kind === "project" ? D.projectNotProtected : D.notProtected, { path: p.path, reason: p.reason }))),
          (report.folders || []).map((f) => line(f.label + T.p.colon + f.path, "folder:" + f.label)),
          h(LegacyWorkbenchNotice, { legacy: report.legacyWorkbench }));
      }
      return h("div", { "data-rulith-settings-diagnosis": "" }, h("div", { style: section }, D.title), body);
    }
    function SettingsPage({ section }) {
      const [state, refresh, setState] = usePoll("state", 5000);
      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") closeSettings(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);
      const body = section === "computer" ? h(ComputerSection, { state, refresh })
        : section === "model" ? (state && state.ok && !state.signedIn ? none(T.settings.modelSignInFirst) : h(ModelForm, {}))
        : section === "appearance" ? h(AppearanceSection, {})
        : section === "advanced" ? h(AdvancedSection, { state, refresh })
        : h(AccountSection, { state, setState });
      return backdrop(1600, closeSettings,
        h("div", { role: "dialog", "aria-modal": "true", "data-rulith-settings": section, onClick: (event) => event.stopPropagation(),
            style: { ...card(720), display: "flex", gap: 16, minHeight: 360, padding: 0 } },
          h("div", { role: "tablist", style: { flex: "none", width: 140, padding: 12, borderRight: "1px solid rgba(127,127,127,.25)" } },
            h("div", { style: { fontWeight: 700, marginBottom: 10 } }, T.settings.title),
            SETTINGS_SECTIONS.map(([id, label]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": id === section,
              onClick: () => openSettings(id), style: { ...item, fontSize: 13, fontWeight: id === section ? 600 : 400,
                background: id === section ? "rgba(127,127,127,.18)" : "transparent" } }, label))),
          h("div", { style: { flex: 1, minWidth: 0, padding: "12px 16px 16px 0" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              h("b", null, (SETTINGS_SECTIONS.find(([id]) => id === section) || SETTINGS_SECTIONS[0])[1]),
              h("button", { type: "button", "aria-label": T.settings.close, style: { ...linkButton, textDecoration: "none", fontSize: 16 }, onClick: closeSettings }, "×")),
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
      return h("button", { type: "button", "data-rulith-settings-entry": "", title: fill(T.settings.entry, { status: status.text }),
          onClick: () => openSettings(state && state.ok && !state.signedIn ? "account" : undefined),
          style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", marginTop: 6, border: "1px solid rgba(127,127,127,.35)",
            borderRadius: 8, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" } },
        dot(status.color),
        wide ? h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, status.text) : null,
        h("span", { "aria-hidden": "true", style: { opacity: 0.75 } }, "⚙"), wide ? h("span", { style: { opacity: 0.75 } }, T.settings.title) : null);
    }

    // ---- The empty conversation page (design §3.2 首次打开): one line above the input, no brand animation, no preview
    // badge. dsh draws its headline, badge and workspace chip itself; the line is the brand-mark slot's occupant, and the
    // rest of dsh's headline row and its workspace row are hidden (folders are chosen in the sidebar).
    const EMPTY_PAGE_CSS = 'span:has(> [data-slot="conversation.hero.brand.mark"]) + span,div:has(> [data-slot="conversation.hero.workspace"]){display:none!important}';
    // Design §3.2 状态文字 (batch 5): dsh's running line shows DeepSeek's whale before its words (dsh-client-ui-chat
    // RunningStatus: the status for screen readers, a divider, then the whale and the shimmering text); the whale is hidden
    // and the words are the app's (TEXT below).
    const RUNNING_CSS = '[data-chat-running]>span:last-child>span[aria-hidden="true"]:first-child{display:none!important}';
    function installEmptyPageStyle() {
      if (typeof document === "undefined" || !document.head || document.querySelector("style[data-rulith-empty-page]")) return () => {};
      const tag = document.createElement("style");
      tag.setAttribute("data-rulith-empty-page", "");
      tag.textContent = EMPTY_PAGE_CSS + RUNNING_CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    // ---- The app's name and words in dsh's own surfaces (design §3.2 页面标题、状态文字、首次打开; batch 5).
    // dsh's layout sets the tab title to "<conversation> — DeepSeek Harness" with the product name built in; the title is
    // kept as Rulith's whenever it changes (the host serves the page with Rulith's title and icon, see web/brand.mjs).
    const PRODUCT = "Rulith";
    const brandedTitle = (title) => String(title || "").replace(/DeepSeek Harness/g, PRODUCT);
    function installTitle() {
      if (typeof document === "undefined") return () => {};
      const keep = () => { const next = brandedTitle(document.title); if (next !== document.title) document.title = next; };
      keep();
      if (typeof MutationObserver === "undefined" || !document.head) return () => {};
      const observer = new MutationObserver(keep);
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      return () => observer.disconnect();
    }
    // dsh's own sentences the app replaces, by dsh namespace and key: the running status (深度求索中 → 正在处理…), the
    // composer's placeholders (they advertised "/ 调用指令, @ 文件或对话": dsh's commands and cross-conversation @ are not the
    // app's way, design §3.2 跨会话引用), the empty page's headline and preview badge, and two DeepSeek account messages.
    // A dsh dictionary cannot be registered twice, so these live in the app's own namespace and the locale service looks
    // there first for exactly these keys; every other key is dsh's, unchanged.
    // 中文说明：dsh 的词典不能重复注册，所以改写的这几条放在应用自己的命名空间里，只对这几个键先查这里。
    const TEXT_NS = "rulith-text";
    // Both languages are registered (dsh's dictionaries take both); dsh draws the one of its active locale, which follows
    // the page's (followLocale).
    const TEXT = { zh: TEXTS.zh.dsh, en: TEXTS.en.dsh };
    /** Route the keys of TEXT to the app's namespace in dsh's locale service; returns the undo. */
    function installTextOverrides(locale) {
      if (!locale || typeof locale.translate !== "function" || typeof locale.register !== "function" || locale.rulithText) return () => {};
      const original = locale.translate;
      const translate = function (ns, key, params) {
        const ours = ns + ":" + key;
        return Object.prototype.hasOwnProperty.call(TEXT.zh, ours) ? original.call(this, TEXT_NS, ours, params) : original.call(this, ns, key, params);
      };
      locale.translate = translate;
      locale.rulithText = true;
      let unregister = () => {};
      // Registering a dictionary publishes the locale snapshot: what is on screen is drawn again with these words.
      try { unregister = locale.register(TEXT_NS, TEXT); }
      catch (error) { locale.translate = original; delete locale.rulithText; console.warn("Rulith: could not register the app's words", error); return () => {}; }
      return () => { if (locale.translate === translate) locale.translate = original; delete locale.rulithText; unregister(); };
    }
    /**
     * dsh's own words in the page's language (D-1025b). dsh picks its language from the browser as well, but a language
     * chosen earlier in its settings (kept in the app's dsh home) or a browser whose first language is neither English nor
     * Chinese can make it differ; then the page's language is chosen for it (dsh keeps that choice), whenever it differs.
     * Returns the undo.
     */
    function followLocale(locale) {
      if (!locale || typeof locale.getSnapshot !== "function" || typeof locale.setLocale !== "function") return () => {};
      const align = () => {
        let snapshot;
        try { snapshot = locale.getSnapshot(); } catch { return; }
        const active = String((snapshot && snapshot.active) || "").toLowerCase().split("-")[0];
        if (active === LOCALE || !list(snapshot && snapshot.locales).some((entry) => entry && entry.id === LOCALE)) return;
        try { locale.setLocale(LOCALE); } catch (error) { console.warn("Rulith: could not set dsh's language", error); }
      };
      align();
      if (typeof locale.subscribe !== "function") return () => {};
      const unsubscribe = locale.subscribe(align);
      return typeof unsubscribe === "function" ? unsubscribe : () => {};
    }
    function makeEmptyLine(selection) {
      return function RulithEmptyLine() {
        const current = useStore(selection);
        return h("span", { "data-rulith-empty": "" }, current && current.sessionId ? T.shell.emptySession : T.shell.emptyNone);
      };
    }

    // Rulith's mark, the same as Console's icon and the app's tab icon (web/brand.mjs).
    const RulithArtwork = () => h("svg", { viewBox: "0 0 32 32", width: 28, height: 28, "aria-hidden": "true", "data-rulith-mark": "", style: { flex: "none" } },
      h("rect", { width: 32, height: 32, rx: 7, fill: "#172f2b" }),
      h("path", { d: "M9 7h8c5 0 7 2 7 6 0 3-1 5-4 6l5 7h-6l-5-7h-1v7H9zm4 4v4h4c2 0 3-1 3-2s-1-2-3-2z", fill: "#d5f0df" }));

    // Own the shell, not just the inner brand slots: dsh's shell wraps them in startSession().
    function RulithSidebar({ collapsed, toggleSidebar, renderSlot }) {
      const wide = !collapsed;
      return h("div", { "data-rulith-sidebar": "", style: { height: "100%", display: "flex", flexDirection: "column",
          boxSizing: "border-box", padding: 8, background: "var(--dsw-specific-sidebar-fill)", color: "var(--dsw-alias-label-primary)" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0" } },
          h("span", { "data-rulith-brand": "", style: { display: "inline-flex", alignItems: "center", gap: 8, flex: 1, fontWeight: 700 } },
            h(RulithArtwork), wide ? "Rulith" : null),
          h("button", { type: "button", onClick: toggleSidebar, "aria-label": wide ? T.shell.collapseSidebar : T.shell.openSidebar, style: tiny }, wide ? "‹" : "›")),
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
            return [{ name: label + (directory ? "/" : ""), icon: directory ? "folder" : "file", section: T.shell.files,
              ...(!drilled && slash >= 0 ? { description: entry.path.slice(0, slash) } : {}),
              value: fileValue(label, mention, directory), ...(directory ? { drill: true } : {}) }];
          });
        },
        header(_session, { query, quoted, drilled }) {
          if (!drilled || !query.includes("/")) return undefined;
          const parts = query.slice(0, query.lastIndexOf("/")).split("/").filter(Boolean);
          return [{ label: T.shell.project, value: fileValue(T.shell.project, quoted ? '@"' : "@", true) },
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
          ({ toggleSidebar }) => h("button", { type: "button", style: tiny, onClick: toggleSidebar, "aria-label": T.shell.toggleSidebar }, "☰")));
      });
      ctx.inject(["inputTriggers", "sessions", "remote.fileReferences"], (inner) => {
        inner.effect(() => inner.inputTriggers.registerSource(makeFileReferenceSource(inner)));
      });
      // dsh's theme and language services for settings → 外观与语言, while they are composed.
      for (const name of ["theme", "locale"]) ctx.inject([name], (inner) => {
        shared[name] = inner[name];
        inner.effect(() => () => { if (shared[name] === inner[name]) shared[name] = undefined; });
      });
      // The app's words in dsh's surfaces, and Rulith's name in the tab title (batch 5).
      ctx.inject(["locale"], (inner) => { inner.effect(() => followLocale(inner.locale)); inner.effect(() => installTextOverrides(inner.locale)); });
      ctx.effect(() => installTitle());
      // Rulith's three tools in the conversation: one plain line each, with 「查看依据」 (design §3.2 工具调用行).
      for (const tool of RULITH_TOOLS)
        ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: tool }, RulithToolRow));
      // Historical children remain ordinary transcript views, with no way to restart delegation.
      ctx.slots.inject("conversation.composer", () => ctx.slots.register({ name: "conversation.composer", priority: -10,
        select: (owner) => owner.session?.origin === "subagent" || owner.session?.subagent ? {} : null },
        () => h("div", { "data-rulith-child-history": "", role: "note", style: { padding: 12 } }, T.shell.childHistory)));
      // Three columns: the Agents and their conversations, the conversation, and on the right its 任务 panel (design §3.1).
      // The 任务 panel is the right sidebar's entry, and every session opens with it.
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "builtin", title: () => T.shell.panel,
        guide: [{ id: "rulith", commandId: "rulith.panel", order: 1, title: () => T.shell.panel,
          description: () => T.shell.panelGuide, icon: RulithArtwork }] }));
      let revealed = false;
      const ensureColumn = () => setTimeout(() => {
        try {
          const session = ctx.sidebarRight.mounted.getSnapshot();
          if (session === undefined) return;
          if (!ctx.sidebarRight.tabsIn(session).some((tab) => tab.kind === TAB_KIND)) ctx.sidebarRight.openTabIn(session, TAB_KIND, {});
          // Shown once per page load; a person who collapses it keeps it collapsed.
          if (!revealed) { revealed = true; if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); }
        } catch (error) { console.warn("Rulith: could not open the task panel", error); }
      }, 0);
      ctx.effect(() => ctx.sidebarRight.mounted.subscribe(ensureColumn));
      ensureColumn();
      ctx.inject(["shortcuts"], (inner) => {
        inner.effect(() => inner.shortcuts.register({ id: "rulith.panel", label: () => T.shell.panel, aliases: ["rulith", "task", "board", "worker"],
          defaults: {}, regions: ["page", "editable", "terminal"], modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element);
            if (target === void 0) return { status: "blocked", reason: T.shell.openFirst };
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
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID, inject: () => ({}) }, () => h("span", null, T.shell.panel)));
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
    exports.deletionWords = deletionWords;
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
      AdvancedSection, ReviewSection, AgentReview, IsolationSection, DiagnosisSection, LegacyWorkbenchNotice, SettingsPage, RulithSettings, RulithSettingsEntry, RulithComposerControls, RulithColumn, RulithSessionColumn, SignDialog };
    exports.SETTINGS_SECTIONS = SETTINGS_SECTIONS;
    exports.EMPTY_PAGE_CSS = EMPTY_PAGE_CSS;
    exports.RUNNING_CSS = RUNNING_CSS;
    exports.TEXT = TEXT;
    exports.installTextOverrides = installTextOverrides;
    exports.followLocale = followLocale;
    exports.TEXTS = TEXTS;
    exports.LOCALE = LOCALE;
    exports.fill = fill;
    exports.brandedTitle = brandedTitle;
    exports.toolCallLine = toolCallLine;
    exports.rulithAnswer = rulithAnswer;
    exports.RulithToolRow = RulithToolRow;
    exports.RULITH_TOOLS = RULITH_TOOLS;
    exports.plain = plain;
    exports.SIGN_REASONS = SIGN_REASONS;
    exports.TIER = TIER;
    exports.MODE_WORDS = MODE_WORDS;
    exports.MODE_HINTS = MODE_HINTS;
    exports.WIDEN_TEXT = WIDEN_TEXT;
    exports.TIER_REFUSALS = TIER_REFUSALS;
    exports.REVIEW_REFUSALS = REVIEW_REFUSALS;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    return module.exports;
  }
});
