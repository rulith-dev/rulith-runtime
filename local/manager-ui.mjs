// SPDX-License-Identifier: Apache-2.0
/**
 * Rulith: the workbench a person actually works in.
 *
 * This page used to be an administration homepage — a card per instance, every operation on
 * the surface, the word "instance" in four places before the first sentence of work. The
 * product it fronts is not an administration console; it is a desk with several Agents on it.
 * So the shell is the desk: the Agents you can pick on the left, the conversation with the one
 * you picked in the middle, and that Agent's Worker on the right. Everything else — signing
 * in, adding an Agent, attaching one that already exists in the cloud, model settings,
 * importing an older installation, identifiers, directories — is a dialog opened when it is
 * wanted and gone again afterwards.
 *
 * The centre is not a reimplementation of the conversation. Each Agent's own host already
 * serves the real one, with its markdown, its tool disclosure, its Trace view, its Case
 * evidence and its composer, and this page embeds that page in an iframe asking it for its
 * embedded presentation. The two documents are different origins and stay that way: no
 * cross-document DOM or control messages. The parent's only statement to the
 * child is the address it loads, and the child's only statement to the parent is that it
 * initialised, through a sender-, origin- and view-checked readiness receipt.
 *
 * One iframe per Agent is created on first selection and then only hidden, never re-created,
 * so moving A → B → A returns to a live conversation rather than a reloaded one. A frame is
 * discarded only when the thing it points at is gone: the host closed, or the host's address
 * changed. Selecting an Agent opens that Agent's host; it does not start the Agent or the
 * Worker, and nothing on this page starts a role without a person pressing a control that
 * says so.
 *
 * Presentation comes from `local/theme.mjs`, the sheet every Rulith page shares, and is
 * imported rather than restated. Only this shell's geometry lives here, and it references the
 * shared tokens instead of naming colours.
 */
import { localThemeCss } from './theme.mjs'

const WORKBENCH_CSS = String.raw`
/* An application shell, not a document: the page never scrolls, its columns do.
 *
 * Two structural columns, not three. The third column — the Cases, the unresolved call, the
 * frontier, the Worker activity of *this conversation* — is not the shell's to draw: the
 * Agent's own page already has it, rendered from the events it is reading, and a copy here
 * would be a second, quieter answer about the same Board. So the stage is one document per
 * Agent that owns both the conversation and the inspector beside it, and this page owns the
 * list of Agents, the account, and the controls for whichever Agent is selected. */
html,body{height:100%}
body{overflow:hidden}
.shell{display:grid;grid-template-columns:250px minmax(0,1fr);height:100vh;min-height:0}
.rail{background:var(--side);display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line)}
.railhead{flex:none;height:56px;display:flex;align-items:center;gap:9px;padding:0 14px;border-bottom:1px solid var(--line);font-weight:650;letter-spacing:.3px}
.railscroll{flex:1;min-height:0;overflow:auto;padding:10px 8px}
.railfoot{flex:none;border-top:1px solid var(--line);padding:10px 12px;display:grid;gap:8px}
.agentrow{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:8px;padding:8px 10px;margin:2px 0;color:var(--dim);font-size:var(--fs-3)}
.agentrow:hover{background:var(--panel2);color:var(--fg);border-color:transparent}
.agentrow[aria-current=true]{background:var(--panel2);color:var(--fg);box-shadow:inset 2px 0 0 var(--accent)}
.agentrow b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agentrow small{display:flex;align-items:center;gap:6px;color:var(--faint);font-size:var(--fs-4)}
.agentrow small span.word{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.dot.on{background:var(--green)}
.dot.wait{background:var(--amber)}
.dot.bad{background:var(--red)}
/* The account sits at the foot of the Agent list, where a person goes looking for it: a small
   avatar carrying its own status, who is signed in, which computer this is, and one mark that
   says there is more behind it. It is one control, not a status line — everything about the
   account is one press away from here. */
.accountbtn{display:flex;align-items:center;gap:9px;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--dim);padding:6px 7px;border-radius:9px;font-size:var(--fs-4)}
.accountbtn:hover{background:var(--panel2);color:var(--fg);border-color:var(--line)}
.accountbtn .avatar{position:relative;flex:none;width:25px;height:25px;border-radius:50%;display:grid;place-items:center;background:var(--panel2);border:1px solid var(--line2);color:var(--fg);font-weight:650;font-size:11.5px}
.accountbtn .avatar .dot{position:absolute;right:-2px;bottom:-2px;width:9px;height:9px;border:2px solid var(--side)}
.acct{min-width:0;display:grid;line-height:1.35}
.acct .word{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#account-line{color:var(--fg);font-weight:600}
#account-sub{color:var(--faint);font-size:11px}
.acct-menu{margin-left:auto;flex:none;color:var(--faint);letter-spacing:1px}
.accountbtn:hover .acct-menu{color:var(--fg)}
.railempty{color:var(--dim);font-size:var(--fs-4);padding:10px}
/* A profile the directory does not claim. It is reachable, and it looks nothing like a row in
   the Agent list, because it is not one of the Agents this account authorizes. */
.profilerow{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 10px;margin:6px 0;color:var(--dim);font-size:var(--fs-4)}
.profilerow:hover{background:var(--panel2);color:var(--fg);border-color:var(--line2)}
.profilerow b{display:block;color:var(--fg);font-weight:600}
.profilerow small{color:var(--faint)}
/* Everything that belongs to the Agent that is selected, directly under the list it was
   selected from: its roles, its tools, its settings. It used to be a rail of its own on the
   far side of the conversation, which made a panel about one Agent look like a panel about
   the product, and pushed the Agent's own Case evidence off the screen to make room. */
.railsel{flex:none;max-height:45vh;overflow:auto;border-top:1px solid var(--line);padding:10px 12px;display:grid;gap:8px}
.railcap{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:11px;letter-spacing:.7px;text-transform:uppercase}
.railrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.railrow button{padding:5px 10px;font-size:var(--fs-4)}
.railsel .iconbtn{width:28px;height:28px;font-size:13px}
.railsel p.muted{margin:0;font-size:11.5px;line-height:1.5}
.railsel details{margin:0}
.railsel summary{font-size:var(--fs-4)}
.railsel .kv{font-size:11.5px;margin:5px 0}
/* The Worker's own failures stay beside the Worker's own controls. */
#worker-notice{margin:0}
#worker-notice:empty{display:none}

.center{display:flex;flex-direction:column;min-width:0;min-height:0}
/* On a desk there is exactly one activity header and it is the Agent's own, inside the stage.
   This bar exists for the widths where the Agent list is a drawer: without it there would be
   no way back to the other Agents once the conversation fills the screen. */
.centerhead{display:none;flex:none;height:56px;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line)}
.centerhead>.heading{min-width:0;flex:0 1 auto}
.title{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.subline{color:var(--dim);font-size:var(--fs-4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spacer{flex:1 1 auto;min-width:0}
.iconbtn{flex:none;width:34px;height:34px;padding:0;display:inline-grid;place-items:center;font-size:15px}
.drawerbtn{display:none}
#notice{flex:none;margin:10px 14px 0}
#notice:empty{display:none}
#connection{flex:none;margin:10px 14px 0}
.stage{position:relative;flex:1;min-height:0;background:var(--bg)}
/* The note sits above a frame that is still loading, so "opening" covers a blank rectangle
   instead of appearing beside one. It comes first in the source, so it needs the z-index. */
.stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:var(--bg);z-index:1}
.stagenote{position:absolute;inset:0;z-index:2;background:var(--bg);display:grid;place-content:center;justify-items:center;gap:10px;padding:32px;text-align:center;color:var(--dim)}
.stagenote h2{color:var(--fg);font-size:20px;margin:0}
.stagenote p{max-width:46ch;margin:0}

/* Dialogs. Everything that is not the work itself lives in one of these. */
.modal[hidden]{display:none}
.modal{position:fixed;inset:0;z-index:60;background:rgb(0 0 0/58%);display:grid;place-items:center;padding:20px}
.modal-card{width:min(560px,96vw);max-height:88vh;overflow:auto;background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);box-shadow:0 18px 48px rgb(0 0 0/55%)}
.modal-wide .modal-card{width:min(680px,96vw)}
.modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;gap:12px;padding:16px 18px;background:var(--panel);border-bottom:1px solid var(--line)}
.modal-head b{font-size:var(--fs-1)}
.modal-head .subline{display:block;white-space:normal}
.modal-close{margin-left:auto;flex:none;width:32px;height:32px;padding:0}
.modal-body{padding:18px}
.modal-body>h3{margin-top:22px}
.modal-body>h3:first-child{margin-top:0}
.dlgnotice{margin:0 0 14px}
.dlgnotice:empty{display:none}
.notes{color:var(--dim);font-size:var(--fs-4);margin:12px 0 0;padding-left:18px}
.notes:empty{display:none}
.inlinefield{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
.inlinefield select{flex:1 1 220px;min-width:0}
.checkline{display:inline-flex;align-items:center;gap:7px;margin:0;color:var(--dim);font-size:var(--fs-4)}
.scrim[hidden]{display:none}
/* Setup and the tools page open here rather than in a window that a pop-up blocker can eat
   without telling anybody. The anchor beside the title is a real link, so a person who wants
   a tab of their own gets one from their own click. */
.modal-page .modal-card{width:min(1040px,96vw);height:min(88vh,940px);display:flex;flex-direction:column;overflow:hidden}
.modal-page .modal-body{position:relative;flex:1;min-height:0;padding:0;display:flex}
.pagestatus{position:absolute;inset:0;z-index:2;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;gap:12px}
.pagestatus[hidden]{display:none}
.modal-page .modal-close{margin-left:8px}
#page-tab{margin-left:auto;flex:none}
.pageframe{flex:1;min-width:0;min-height:0;width:100%;border:0;background:var(--bg)}

/* On a narrow screen the stage is the page and the Agent list becomes a drawer over it, with
   a bar to open it from. The Agent's own evidence does not become this page's problem: the
   document in the stage moves its own sections into its own dialog at its own width. */
@media(max-width:980px){
  .shell{grid-template-columns:minmax(0,1fr)}
  .centerhead{display:flex}
  .drawerbtn{display:inline-grid}
  button.btn.drawerbtn{display:inline-flex}
  .rail{position:fixed;top:0;bottom:0;left:0;z-index:40;width:min(300px,86vw);transform:translateX(-102%);transition:transform .16s ease-out}
  .shell.rail-open .rail{transform:none}
  .scrim{position:fixed;inset:0;z-index:35;background:rgb(0 0 0/48%)}
}
/* A header that cannot wrap pushes its last controls past the right edge of a column that
   never scrolls sideways, and they become unreachable rather than merely cramped. */
@media(max-width:620px){
  .centerhead{height:52px;min-height:52px;padding:8px 12px}
  .centerhead>.heading{flex:1;min-width:0}
  .centerhead .subline{display:none}
}
@media(max-width:480px){.centerhead button{white-space:nowrap}}
@media(prefers-reduced-motion:reduce){.rail{transition:none}}
@media(max-width:560px){
  .modal{padding:0}
  .modal-card{width:100vw;max-height:100vh;border-radius:0;border:0}
}
`

export const managerPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Rulith</title>
<style>` + localThemeCss + WORKBENCH_CSS + String.raw`</style></head><body>
<div class="shell" id="shell">

<aside class="rail" id="rail" aria-label="Agents">
  <div class="railhead"><span class="brand-mark"></span><span>Rulith</span><span class="spacer"></span><button class="iconbtn drawerbtn" id="rail-close" aria-label="Hide the Agent list">×</button></div>
  <div class="railscroll"><div id="agents"></div><p class="railempty" id="agents-empty" hidden></p></div>
  <div class="railsel" id="railsel" hidden>
    <div class="railcap"><span>Selected Agent</span><span class="spacer"></span><button class="iconbtn" id="details-open" aria-label="Agent settings and details" aria-haspopup="dialog">⚙</button></div>
    <div class="railrow"><span class="pill" id="agent-pill" hidden></span><button id="agent-toggle" hidden>Start Agent</button></div>
    <div class="railrow"><span class="pill" id="worker-pill">No Agent selected</span><button id="worker-toggle" hidden>Start Worker</button><button id="tools-open" hidden>Tools</button><button id="authoring-open" hidden>Document assistant</button></div>
    <p class="muted" id="worker-note">Choose an Agent to see the Worker on this computer.</p>
    <div id="worker-notice" class="notice" role="status" aria-live="polite"></div>
    <details id="worker-details"><summary>Connection and details</summary>
      <div class="kv"><span>Attached Agent</span><b id="worker-agent">—</b></div>
      <div class="kv"><span>Connection</span><b id="worker-connection">—</b></div>
      <div class="kv"><span>Local address</span><b id="worker-address">—</b></div>
      <div class="kv"><span>Files</span><b id="worker-dir">—</b></div>
    </details>
  </div>
  <div class="railfoot">
    <button class="accountbtn" id="account-open" aria-haspopup="dialog"><span class="avatar"><span id="account-initial">·</span><span class="dot" id="account-dot"></span></span><span class="acct"><span class="word" id="account-line">Not signed in</span><span class="word" id="account-sub">Sign in with your browser</span></span><span class="acct-menu" aria-hidden="true">⋯</span></button>
  </div>
</aside>

<main class="center" id="center">
  <header class="centerhead">
    <button class="iconbtn drawerbtn" id="rail-open" aria-label="Show the Agent list" aria-expanded="false">☰</button>
    <div class="heading"><div class="title" id="center-title">Rulith</div><div class="subline" id="center-sub">A local working environment for your Agents.</div></div>
  </header>
  <div id="connection" class="notice error" role="status" aria-live="polite" hidden></div>
  <div id="notice" class="notice" role="status" aria-live="polite"></div>
  <div id="agent-readiness" class="notice" role="status" hidden><span id="agent-readiness-copy"></span> <button id="agent-readiness-action" class="btn">Set model</button></div>
  <div class="stage" id="stage">
    <div class="stagenote" id="stage-note">
      <h2 id="stage-title">Welcome to Rulith</h2>
      <p id="stage-copy">Add an Agent to begin.</p>
      <button class="btn" id="stage-action" hidden></button>
    </div>
  </div>
</main>

</div>
<div class="scrim" id="scrim" hidden></div>

<div class="modal" id="dlg-account" role="dialog" aria-modal="true" aria-labelledby="account-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="account-title">Account</b></div><button class="modal-close" id="account-close" aria-label="Close account">×</button></div>
  <div class="modal-body">
    <div id="account-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <div id="signed-out">
      <p>Sign in with your browser to choose which Agents this computer may run.</p>
      <p id="signin-recovery" class="notice" role="status" hidden></p>
      <div class="actions"><button class="btn" id="sign-in">Sign in</button></div>
    </div>
    <div id="pending" hidden>
      <p>Complete sign-in in your browser. Your Agents will appear here automatically.</p>
      <p id="signin-reopen-hint" class="muted">If the page did not open, use the link below.</p>
      <a id="console-link" target="_blank" rel="noopener noreferrer">Reopen sign-in page</a>
      <p id="signin-poll-error" class="notice error" role="alert" hidden></p>
    </div>
    <div id="linked" hidden>
      <div class="row" style="justify-content:space-between"><h3 id="account-name"></h3><span class="pill" id="device-tag"></span></div>
      <p id="agent-summary"></p>
      <p class="muted" id="default-model-summary"></p>
      <div class="actions"><button id="default-model-open">Default model</button></div>
      <div class="actions"><button id="refresh-account">Refresh enabled Agents</button><button class="btn danger" id="sign-out">Sign out and stop this computer</button></div>
      <p id="signout-state" class="muted"></p>
    </div>
    <div id="unusable" hidden>
      <p id="unusable-teaching"></p>
    </div>
    <div id="signin-reset" hidden>
      <p id="signin-reset-copy" class="muted"></p>
      <button class="btn" id="start-over">Reset sign-in</button>
    </div>
    <p id="console-home-line" hidden>New Agents are created in Console: <a id="console-home" target="_blank" rel="noopener noreferrer">open your account</a>.</p>
    <details id="local-settings"><summary>Advanced local settings</summary>
    <div id="signin-settings">
      <label>Console address<input id="console-url" type="url" value="https://console.rulith.ai" autocomplete="url"></label>
      <label>This computer's name<input id="device-name" maxlength="120" placeholder="This computer"></label>
    </div>
    <h3>Local profiles</h3>
    <p class="muted">Profiles on this computer that are not one of the Agents above: not connected yet, imported, or connected under another account or Console. They are kept so nothing is lost, and they are never offered as an Agent this account authorizes.</p>
    <div id="profiles"></div>
    <p class="muted" id="profiles-empty" hidden>No other local profiles.</p>
    <div id="import-block" hidden>
      <h4>Bring across an older installation</h4>
      <p id="import-path"></p>
      <p class="muted">Its model, tool and resource settings are copied into a profile of its own; the original files are never moved or changed. Its existing Agent and Worker credentials stay with the original installation — this profile is connected to an Agent separately.</p>
      <label>Name for the imported profile<input id="import-name" maxlength="80" placeholder="Existing installation"></label>
      <div class="actions"><button id="import">Import</button></div>
      <ul class="notes" id="import-notes"></ul>
    </div>
    </details>
  </div>
</div></div>

<div class="modal" id="dlg-setup" role="dialog" aria-modal="true" aria-labelledby="setup-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="setup-title">Set up on this computer</b><span class="subline" id="setup-sub"></span></div><button class="modal-close" id="setup-close" aria-label="Close set up Agent">×</button></div>
  <div class="modal-body">
    <div id="setup-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p id="setup-blocked" hidden></p>
    <div id="setup-form">
      <p class="muted">This Agent already exists in your account. Setting it up here gives it a profile of its own on this computer and connects that profile to it. Nothing is created in Console, and no other Agent is touched.</p>
      <label for="setup-mode">How should this computer run it?</label>
      <select id="setup-mode" aria-label="How this computer runs this Agent">
        <option value="local_agent">Rulith runs the Agent here, with a model you configure</option>
        <option value="existing_client">Only the Worker runs here, for an MCP client you run yourself</option>
      </select>
      <p class="muted" id="setup-existing" hidden></p>
      <div class="actions"><button class="btn" id="setup-start">Set up on this computer</button></div>
    </div>
  </div>
</div></div>

<div class="modal" id="dlg-attach" role="dialog" aria-modal="true" aria-labelledby="attach-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="attach-title">Connect a cloud Agent</b><span class="subline" id="attach-sub"></span></div><button class="modal-close" id="attach-close" aria-label="Close connect Agent">×</button></div>
  <div class="modal-body">
    <div id="attach-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p id="attach-blocked" hidden>Sign in first; enabled Agents from this account appear here.</p>
    <div id="attach-form">
      <label for="agent-select">Agent</label>
      <div class="inlinefield"><select id="agent-select" aria-label="Agent to connect"></select><button class="btn" id="pair">Connect</button></div>
      <label class="checkline"><input type="checkbox" id="replace">Replace the credential this Agent already has</label>
    </div>
    <div id="attach-pending" hidden>
      <p><span class="pill wait" id="pair-agent"></span></p>
      <p class="muted" id="pair-progress">The connection has not finished. Check again to resume setup.</p>
      <p id="pair-error" class="notice error" role="alert" hidden></p>
      <p id="pair-replacement-pending" class="notice" hidden>You approved replacing this Agent’s previous key. Continuing retries that replacement; clients using the old key will lose access when it completes.</p>
      <div id="pair-conflict" hidden>
        <p>This Agent already has an active key. Replacing it connects this computer and invalidates the previous key, including clients still using it.</p>
        <label class="checkline"><input type="checkbox" id="pair-replace-confirm">Replace this Agent’s existing key</label>
        <button class="btn" id="pair-replace">Replace key and connect</button>
      </div>
      <div class="actions"><button class="btn" id="pair-poll">Check again</button><button id="pair-cancel">Cancel</button></div>
    </div>
  </div>
</div></div>

<div class="modal modal-wide" id="dlg-details" role="dialog" aria-modal="true" aria-labelledby="details-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="details-title">Agent settings</b><span class="subline" id="details-sub"></span></div><button class="modal-close" id="details-close" aria-label="Close Agent settings">×</button></div>
  <div class="modal-body">
    <div id="details-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p class="notice error" id="detail-attention" hidden></p>
      <div class="actions"><button class="btn" id="open-setup">Open setup</button><button id="attach-open">Connect a cloud Agent</button></div>
      <div class="actions"><button id="connection-key-open">Replace Connection key</button></div>
    <div id="model-row">
      <h3>Model settings</h3>
      <p class="muted" id="agent-model-summary"></p>
      <div class="actions"><button id="agent-model-open">Model settings</button></div>
      <details><summary>Copy an existing configuration</summary>
      <p class="muted">Copy another local Agent's model as a separate configuration. Stop this Agent and its Worker first.</p>
      <div class="inlinefield"><label for="model-from" class="checkline">Copy from</label><select id="model-from" aria-label="Agent to copy model settings from"></select><button id="model-copy">Copy</button></div>
      </details>
    </div>
    <details id="detail-advanced"><summary>Technical details</summary>
      <div class="kv"><span>Identifier</span><b id="detail-id">—</b></div>
      <div class="kv"><span>Files</span><b id="detail-dir">—</b></div>
      <div class="kv"><span>Attached Agent</span><b id="detail-agent">—</b></div>
      <div class="kv"><span>Running as</span><b id="detail-running">—</b></div>
      <p class="muted" id="detail-legacy" hidden></p>
      <div class="actions"><button id="start-all">Start Agent and Worker</button><button id="stop-all">Stop everything</button></div>
    </details>
    <h3>Remove</h3>
    <p class="muted">Removes this Agent from the list on this computer. Its folder, settings and credentials are left exactly where they are.</p>
    <div class="actions"><button class="btn danger" id="forget">Remove from Rulith</button></div>
  </div>
</div></div>

<div class="modal" id="dlg-connection-key" role="dialog" aria-modal="true" aria-labelledby="connection-key-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="connection-key-title">Replace Connection key</b><span class="subline" id="connection-key-sub"></span></div><button class="modal-close" id="connection-key-close" aria-label="Close Connection key">×</button></div>
  <div class="modal-body"><div id="connection-key-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p class="muted">Enter the current replacement key from Console. The previous key is invalidated there; it is never displayed or sent to another service.</p>
    <p id="connection-key-blocked" class="notice error" role="alert" hidden></p>
    <label>New Connection key<input id="connection-key-value" type="password" autocomplete="new-password" maxlength="4096"></label>
    <div class="actions"><button class="btn" id="connection-key-save">Replace key</button></div>
  </div>
</div></div>

<div class="modal" id="dlg-model" role="dialog" aria-modal="true" aria-labelledby="model-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="model-title">Model settings</b><span class="subline" id="model-sub"></span></div><button class="modal-close" id="model-close" aria-label="Close model settings">×</button></div>
  <div class="modal-body">
    <div id="model-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p id="model-blocked" class="notice error" role="alert" hidden></p>
    <label id="model-source-label">Model for this Agent<select id="model-source"><option value="default">Use the default model</option><option value="custom">Use a different model</option></select></label>
    <div id="model-inherited"><p id="model-inherited-summary"></p><button id="model-edit-default">Edit default model</button></div>
    <div id="model-fields">
      <p class="muted" id="model-explanation"></p>
      <label>Model endpoint<input id="model-url" type="url" autocomplete="url" placeholder="https://api.deepseek.com/v1"></label>
      <label>Model name<input id="model-name" autocomplete="off" maxlength="256" placeholder="deepseek-flash"></label>
      <label>API key<input id="model-key" type="password" autocomplete="new-password" maxlength="4096"></label>
      <p class="muted" id="model-key-hint"></p>
      <label class="checkline" id="model-clear-label"><input id="model-clear-key" type="checkbox">Remove the saved API key</label>
      <details><summary>Model options</summary><label>Thinking (OpenAI-compatible endpoints)<select id="model-thinking"><option value="standard">Provider default</option><option value="disabled">Off</option><option value="enabled">On</option></select></label></details>
    </div>
    <p class="muted" id="model-effect"></p>
    <div class="actions"><button class="btn" id="model-save">Save</button><button id="model-save-start">Save and start Agent</button></div>
  </div>
</div></div>

<div class="modal modal-page" id="dlg-page" role="dialog" aria-modal="true" aria-labelledby="page-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="page-title">Settings</b><span class="subline" id="page-sub"></span></div>
    <a class="btn s" id="page-tab" target="_blank" rel="noopener noreferrer" hidden>Open in a new tab</a>
    <button class="modal-close" id="page-close" aria-label="Close settings">×</button></div>
  <div class="modal-body"><div class="pagestatus" id="page-status"><p id="page-loading" role="status"></p><p id="page-notice" role="alert"></p><button class="btn" id="page-retry" hidden>Try again</button></div><iframe class="pageframe" id="page-frame" title="Agent settings" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"></iframe></div>
</div></div>

<div class="modal" id="dlg-authoring" role="dialog" aria-modal="true" aria-labelledby="authoring-title" hidden><div class="modal-card">
  <div class="modal-head"><div><b id="authoring-title">Document assistant</b><span class="subline" id="authoring-sub"></span></div><button class="modal-close" id="authoring-close" aria-label="Close document assistant">×</button></div>
  <div class="modal-body"><div id="authoring-notice" class="notice dlgnotice" role="status" aria-live="polite"></div>
    <p id="authoring-copy">Install the Document Authoring Assistant on this Agent and bind its existing Worker to this profile’s material area. Preparation downloads the pinned local checker once for this computer; Java 25 is required. Your Agent uses its configured model.</p>
    <label class="checkline"><input id="authoring-local-read" type="checkbox" checked> Allow local material delivery to this Agent</label><label class="checkline"><input id="authoring-off-machine" type="checkbox"> Allow document text to reach a remote model or an authorized Gateway proxy</label>
    <div class="actions"><button class="btn" id="authoring-prepare">Prepare local assistant</button><button id="authoring-review-open">Review checked draft</button><a class="btn" id="authoring-configure" target="_blank" rel="noopener noreferrer" hidden>Manage installed capabilities</a></div>
    <div id="authoring-review" hidden><h3>Review draft</h3><p class="sub">These are the Worker’s reported draft checks. Review before saving a private draft.</p><div id="authoring-result"></div><label id="authoring-case-row">Certified Case<select id="authoring-case"></select></label><div class="actions"><button class="btn" id="authoring-save">Save private draft</button><a class="btn" id="authoring-publication" target="_blank" rel="noopener noreferrer" hidden>Review publication in Console</a></div></div>
  </div>
</div></div>
<script>
const $=id=>document.getElementById(id), key=new URLSearchParams(location.search).get('k')||'';
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* One manager key, read from this page's own address. The page ships with no secret, and the
   per-Agent loopback keys it never sees: opening an Agent asks the manager for that Agent's
   address and loads it. Nothing is written to storage and no address is logged. */
let state={instances:[],device:{state:'none'},legacyInstall:null},selected='',notes=[],drawer='',pollTimer,signInPollError='',polling=null,pendingReplaceFor='',lastStateRevision=0,lastStateServerId='',requestSequence=0,lastStateRequest=0;
const pendingTarget=row=>row?JSON.stringify([row.id,row.pendingOrigin,row.pendingAccountId,row.pendingAgentId]):'';
/* What this page currently knows about the manager itself. While the connection is lost, the state
   on screen is the last one that arrived and nothing may be changed from it: a control acting
   on a picture that may be minutes old is worse than a control that says why it is waiting. */
let offline='',pollFails=0;
/* The exact (Agent here, cloud Agent) pair the replacement tick was given for. */
let replaceFor='',authoringResult=null,authoringFor='',authoringScope='',authoringPermissionsReady=false,authoringLoad=0;
const pendingStartNotices=new Map();
const shownStartNotices=new Map();
function rememberStartNotice(id,role,noticeId,message){
  pendingStartNotices.set(id+':'+role,{id,role,noticeId,message});
}
function renderStartNotices(){
  for(const [key,pending] of pendingStartNotices){
    const row=rowOf(pending.id);
    if(!row||!row[pending.role]||row.ready?.[pending.role]===true)pendingStartNotices.delete(key);
  }
  for(const noticeId of ['worker-notice','details-notice']){
    const previous=shownStartNotices.get(noticeId),el=$(noticeId);
    const messages=[...pendingStartNotices.values()].filter(p=>p.id===selected&&p.noticeId===noticeId)
      .map(p=>(rowOf(p.id)?.agentName||rowOf(p.id)?.name||p.id)+' · '+p.role+': '+p.message);
    if(previous!==undefined&&el.textContent===previous)say(noticeId,'');
    if(messages.length&&!el.textContent){
      const message=messages.join('\n');say(noticeId,message,true);shownStartNotices.set(noticeId,message);
    }else shownStartNotices.delete(noticeId);
  }
}
const busy=new Set(),frames=new Map(),dialogs=[],lastMarkup={};
const rowOf=id=>(state.instances||[]).find(r=>r.id===id)||null, sel=()=>rowOf(selected);
/* A closed host reports no roles, so what a stopped Agent is *for* comes from its mode; a
   running one reports its own roles and those are what is shown. */
const hasRole=(row,role)=>(row.open&&(row.roles||[]).length?(row.roles||[]).includes(role):(role==='agent'?row.mode!=='existing_client':true));
const running=row=>row.agent===true||row.worker===true;

/* A refusal and a manager that is not there are different answers and are not blurred into
   one: a refusal carries the manager's own teaching and leaves the page working, while no
   answer at all — or an answer that no longer accepts this page's key — means everything on
   screen is a memory. Only the second kind becomes the connection state. */
const lost=message=>{const error=Object.assign(Error(message),{offline:true});unreachableNow(error);return error;};
async function api(path,body,signal){
  const requestOrder=++requestSequence;
  let r;
  try{
    r=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',signal,
      headers:{'x-rulith-manager':key,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }catch(e){if(signal?.aborted)throw Error('Sign-in took too long. You can retry, or reopen the sign-in page when its link appears.');throw lost('Rulith on this computer did not answer.');}
  const v=await r.json().catch(()=>({}));
  if(r.status===401||r.status===403)throw lost(v.teaching||'This page is no longer authorized for the manager. Open the address it printed at startup.');
  if(v&&Array.isArray(v.instances)){
    const changedServer=v.stateServerId&&v.stateServerId!==lastStateServerId;
    // A fixed manager key can survive a process restart. A new server resets the counter,
    // but an old request completing after that restart cannot switch the page back again.
    if((!changedServer||requestOrder>=lastStateRequest)
      &&(changedServer||!Number.isSafeInteger(v.stateRevision)||v.stateRevision>=lastStateRevision)){
      if(changedServer){lastStateServerId=v.stateServerId;lastStateRevision=0;}
      if(Number.isSafeInteger(v.stateRevision))lastStateRevision=v.stateRevision;
      lastStateRequest=Math.max(lastStateRequest,requestOrder);render(v);
    }
  }
  reachable();
  if(!r.ok||v.ok===false)throw Object.assign(Error(v.teaching||'This step could not be confirmed.'),{state:v.state});
  return v;
}
function connection(){$('connection').hidden=offline==='';$('connection').textContent=offline;}
/* Two answers in a row have to be missing before the page says so: one dropped poll during a
   restart is not a state worth announcing. */
function reachable(){if(pollFails||offline){pollFails=0;offline='';connection();say('page-notice','');renderStage();applyControls();}}
function unreachableNow(error){
  pollFails+=1;
  if(pollFails<2||offline!=='')return;
  offline=error.message+' Nothing can be changed from this page until it answers again; it keeps trying.';
  connection();applyControls();
  if(pageEntry&&!pageEntry.loaded)say('page-notice',offline,true);
}
function say(id,message,bad){const el=$(id);el.textContent=message||'';el.className='notice'+(id==='notice'?'':' dlgnotice')+(bad?' error':'');}
/* One in-flight action per scope. A scope is one Agent and one thing — starting its Worker,
   copying its model settings — so a slow action on one Agent never disables another's
   controls, and never disables choosing a different Agent at all. */
function run(scope,noticeId,fn){
  // A second press while the first is still working says so. Returning quietly is how a
  // control becomes "sometimes it just does nothing".
  if(busy.has(scope)){say(noticeId,'That is still working; it has not finished yet.',false);return Promise.resolve();}
  // Rendered at both ends, so "this is working" is on screen for the whole of it and not
  // only once it finishes.
  busy.add(scope);say(noticeId,'');render();
  return Promise.resolve().then(fn).catch(e=>say(noticeId,e.message,true))
    .finally(()=>{busy.delete(scope);render();});
}
const frameScope=id=>'open:'+id+':frame', windowScope=id=>'open:'+id+':settings';
/* Every control's availability is a function of the state and of what is in flight, so no
   action can leave another action's button enabled, and a poll cannot enable a button the
   state says is unavailable. */
function controlSpec(){
  const row=sel(),device=state.device||{},linked=device.state==='linked';
  const waiting=device.state==='pending'&&Boolean(device.code&&device.consoleUrl);
  const pending=waiting||device.state==='approved';
  const broken=['revoked','expired','unusable','unreadable'].includes(device.state);
  const live=row?running(row):false,agents=device.agents||[];
  return {
    'sign-in':['account',!linked&&!pending&&!broken],
    'refresh-account':['account',linked],
    'default-model-open':['model-settings',linked&&state.modelDefaults?.available===true],
    'sign-out':['account',linked],
    'start-over':['account',broken||(pending&&Boolean(signInPollError))],
    'setup-start':['setup:'+(setupFor?setupFor.id:''),
      setupAuthorized(setupFor)],
    // Once the profile exists its mode is a fact about files on disk, not a choice any more.
    'setup-mode':['setup:'+(setupFor?setupFor.id:''),Boolean(setupFor)&&setupProfile(setupFor)==null],
    'import':['add',state.legacyInstall!=null],
    'pair':['attach:'+selected,Boolean(row)&&linked&&!row.paired&&!row.pendingAgentId&&agents.length>0&&[...$('agent-select').options].some(option=>!option.disabled&&option.value===$('agent-select').value)],
    'pair-poll':['attach:'+selected,Boolean(row&&row.pendingAgentId)],
    'pair-replace':['attach:'+selected,Boolean(linked&&row?.pendingAgentId&&row.pendingError?.code==='runtime_credential_exists'
      &&$('pair-replace-confirm').checked&&pendingReplaceFor===pendingTarget(row))],
    'pair-cancel':['attach:'+selected,Boolean(row&&row.pendingAgentId)],
    'agent-toggle':['role:'+selected+':agent',Boolean(row)&&hasRole(row,'agent')&&!row.orphaned&&(row.agent===true||!row.blocked)],
    'agent-readiness-action':['role:'+selected+':agent',Boolean(row)&&row.mode==='local_agent'&&!row.agent&&!row.orphaned&&!row.blocked],
    'worker-toggle':['role:'+selected+':worker',Boolean(row)&&hasRole(row,'worker')&&!row.orphaned&&(row.worker===true||!row.blocked)],
    'tools-open':[windowScope(selected),Boolean(row)],
    'authoring-open':['authoring:'+selected,Boolean(row)&&row.paired&&hasRole(row,'worker')&&!row.blocked&&!row.orphaned],
    'authoring-prepare':['authoring:'+selected,Boolean(row)&&row.paired&&hasRole(row,'worker')&&!row.blocked&&!row.orphaned&&authoringPermissionsReady],
    'authoring-local-read':['authoring:'+selected,authoringPermissionsReady],
    'authoring-off-machine':['authoring:'+selected,authoringPermissionsReady],
    'authoring-review-open':['authoring:'+selected,Boolean(row)&&row.paired&&!row.blocked&&!row.orphaned],
    'authoring-save':['authoring:'+selected,Boolean(row)&&authoringResult&&String($('authoring-case').value||'')!==''&&String(authoringResult.resultId||'')!==''&&authoringResult.report?.compiled===true&&authoringResult.report?.examples?.total>0&&authoringResult.report?.examples?.passed===authoringResult.report?.examples?.total&&authoringResult.report?.citations?.total>0&&authoringResult.report?.citations?.verified===authoringResult.report?.citations?.total&&!(authoringResult.draft?.questions||[]).length ],
    'page-retry':[windowScope(pageEntry?.id||''),Boolean(pageEntry&&rowOf(pageEntry.id))],
    'open-setup':[windowScope(selected),Boolean(row)],
    'model-copy':['model:'+selected,Boolean(row)&&row.mode==='local_agent'&&!live&&modelSources(row).length>0],
    'agent-model-open':['model-settings',Boolean(row)&&row.mode==='local_agent'&&linked&&!row.blocked],
    'model-source':['model-settings',modelTargetValid()&&!modelTargetRunning()],
    'model-edit-default':['model-settings',modelTargetValid()],
    'model-save':['model-settings',modelTargetValid()&&!modelTargetRunning()],
    'model-save-start':['model-settings',modelTargetValid()&&Boolean(modelTarget?.instanceId)&&!modelTargetRunning()],
    'start-all':['instance:'+selected,Boolean(row)&&!live&&!row.blocked&&!row.orphaned],
    'stop-all':['instance:'+selected,Boolean(row)&&row.open===true],
    'forget':['forget:'+selected,Boolean(row)&&!live],
  };
}
/* Nothing that changes anything is offered while the manager is not answering: every one of
   these writes, and a write decided from a stale picture is the one kind of mistake this page
   can make on its own. */
function applyControls(){const spec=controlSpec();for(const id in spec)$(id).disabled=offline!==''||busy.has(spec[id][0])||spec[id][1]!==true;}

function statusOf(row){
  if(row.orphaned)return{word:'Needs attention',dot:'bad',tone:' bad'};
  if(row.blocked)return{word:'Unavailable',dot:'bad',tone:' bad'};
  if(row.pendingAgentId)return{word:'Connecting',dot:'wait',tone:' wait'};
  if(row.agent&&row.worker)return{word:'Running',dot:'on',tone:' ok'};
  if(row.agent)return{word:'Agent running',dot:'on',tone:' ok'};
  if(row.worker)return{word:'Worker running',dot:'on',tone:' ok'};
  if(!row.paired)return{word:'Not connected',dot:'',tone:''};
  if(row.model&&row.mode==='local_agent'&&!row.model.ready)return{word:'Model needed',dot:'wait',tone:' wait'};
  return{word:'Stopped',dot:'',tone:''};
}
const modeWord=row=>row.mode==='existing_client'?'Worker only':'';
function modelSources(row){return (state.instances||[]).filter(r=>r.id!==row.id&&r.mode==='local_agent');}
/* 模型弹窗绑定打开时的账号及 Agent；轮询只更新状态，不改写正在输入的值。
   默认凭据只在本机管理 API 的写入请求中出现，页面不会读取已保存的密钥。 */
let modelTarget=null,modelOriginal=null;
const modelAccount=()=>{const d=state.device||{};return {origin:d.origin||'',accountId:d.account?.id||''};};
function modelTargetValid(){
  if(!modelTarget||modelTarget.invalidated||state.device?.state!=='linked')return false;
  const scope=modelAccount();
  if(scope.origin!==modelTarget.origin||scope.accountId!==modelTarget.accountId)return false;
  if(!modelTarget.instanceId)return state.modelDefaults?.available===true;
  const row=rowOf(modelTarget.instanceId);
  return Boolean(row)&&row.mode==='local_agent'&&row.origin===scope.origin&&row.accountId===scope.accountId
    &&row.agentId===modelTarget.agentId&&!row.blocked;
}
const modelTargetRunning=()=>Boolean(modelTarget?.instanceId&&rowOf(modelTarget.instanceId)?.agent);
const modelEditsDefault=()=>!modelTarget?.instanceId||($('model-source').value==='default'&&!state.modelDefaults?.configured);
const modelDescription=model=>model?.configured?(model.name+' · '+model.url):'No model configured yet';
function fillModelFields(model){
  $('model-url').value=model?.url||'';$('model-name').value=model?.name||'';
  $('model-key').value='';$('model-clear-key').checked=false;
  $('model-thinking').value=['enabled','disabled'].includes(model?.thinking)?model.thinking:'standard';
  modelOriginal=model||{};
}
function openModel(instanceId=''){
  const row=instanceId?rowOf(instanceId):null,scope=modelAccount();
  if(state.device?.state!=='linked'||(instanceId&&(!row||row.mode!=='local_agent'||row.blocked)))return;
  modelTarget={...scope,instanceId,agentId:row?.agentId||''};
  $('model-source').value=row?.model?.source==='default'?'default':'custom';
  fillModelFields(!instanceId||$('model-source').value==='default'?state.modelDefaults:row.model);
  say('model-notice','');
  if(dialogs.some(d=>d.id==='dlg-model'))render();else openDialog('dlg-model','model-close');
}
let connectionKeyTarget=null;
const connectionKeyTargetValid=()=>{
  const target=connectionKeyTarget,row=target&&rowOf(target.instanceId),device=state.device||{};
  return Boolean(target&&row&&device.state==='linked'&&device.origin===target.origin&&(device.account||{}).id===target.accountId
    &&row.agentId===target.agentId&&row.connectionId===target.connectionId&&!row.worker&&!row.blocked);
};
function openConnectionKey(){
  const row=sel(),device=state.device||{};
  if(!row||!row.paired||!row.connectionId||device.state!=='linked')return;
  connectionKeyTarget={instanceId:row.id,origin:device.origin,accountId:(device.account||{}).id,agentId:row.agentId,connectionId:row.connectionId};
  $('connection-key-value').value='';say('connection-key-notice','');openDialog('dlg-connection-key','connection-key-value');
}
function renderConnectionKey(){
  const valid=connectionKeyTargetValid(),row=connectionKeyTarget&&rowOf(connectionKeyTarget.instanceId);
  $('connection-key-sub').textContent=row?.name||'';
  $('connection-key-blocked').hidden=valid;
  $('connection-key-blocked').textContent=valid?'':'The account, Agent, Connection, or Worker state changed. Close and reopen this dialog.';
  $('connection-key-value').disabled=!valid||busy.has('connection-key');$('connection-key-save').disabled=!valid||busy.has('connection-key');
  if(!valid)$('connection-key-value').value='';
}
function saveConnectionKey(){
  const target=connectionKeyTarget;if(!target||!connectionKeyTargetValid())return Promise.resolve();
  return run('connection-key','connection-key-notice',async()=>{
    if(connectionKeyTarget!==target||!connectionKeyTargetValid())throw Error('The account, Agent, Connection, or Worker state changed. Reopen this dialog.');
    await api('/manager/instances/connection-key',{instanceId:target.instanceId,expectedOrigin:target.origin,expectedAccountId:target.accountId,
      expectedAgentId:target.agentId,expectedConnectionId:target.connectionId,key:$('connection-key-value').value});
    $('connection-key-value').value='';closeDialog('dlg-connection-key');say('details-notice','Connection key replaced on this computer.');
  });
}
function renderModel(){
  if(!modelTarget)return;
  const valid=modelTargetValid(),row=modelTarget.instanceId?rowOf(modelTarget.instanceId):null;
  const inherited=Boolean(modelTarget.instanceId)&&$('model-source').value==='default';
  const editingDefault=modelEditsDefault(),running=modelTargetRunning();
  $('model-title').textContent=modelTarget.instanceId?'Model for '+(row?.name||'this Agent'):'Default model on this computer';
  $('model-sub').textContent=modelTarget.instanceId?'':(state.device?.account?.name||'');
  $('model-source-label').hidden=!modelTarget.instanceId;
  $('model-fields').hidden=inherited&&!editingDefault;
  $('model-inherited').hidden=!inherited||editingDefault;
  $('model-inherited-summary').textContent=modelDescription(state.modelDefaults);
  $('model-explanation').textContent=editingDefault
    ?'Agents set to use the default will use this model. Settings and the key stay on this computer, under this account.'
    :'Only this Agent uses these settings. The key stays on this computer.';
  $('model-key-hint').textContent=modelOriginal?.keyConfigured
    ?'A key is saved. Leave blank to keep it for the same service. Enter a new key when changing services.'
    :'Enter your model API key. A local model on this computer can run without one.';
  $('model-clear-label').hidden=!modelOriginal?.keyConfigured;
  $('model-effect').textContent=editingDefault?'Running Agents keep their current model until restarted.'
    :row?.model?.restartRequired?'Restart this Agent to use the updated default model.':'';
  $('model-save').textContent=editingDefault?'Save default model':'Save';
  $('model-save-start').hidden=!modelTarget.instanceId;
  $('model-blocked').hidden=valid&&!running;
  $('model-blocked').textContent=!valid?'The account or Agent changed. Close and reopen these settings.'
    :running?'Stop this Agent before changing its model.':'';
  if(!valid){modelTarget.invalidated=true;$('model-key').value='';}
  for(const id of ['model-url','model-name','model-key','model-clear-key','model-thinking'])$(id).disabled=!valid||running||busy.has('model-settings');
}
async function saveModel(startAfter){
  const target=modelTarget;if(!target||!modelTargetValid())return;
  const source=$('model-source').value,editingDefault=modelEditsDefault();
  const values={url:$('model-url').value.trim(),name:$('model-name').value.trim(),key:$('model-key').value,
    clearKey:$('model-clear-key').checked,thinking:$('model-thinking').value};
  return run('model-settings','model-notice',async()=>{
    if(modelTarget!==target||!modelTargetValid())throw Error('The account or Agent changed. Reopen model settings.');
    const scope={expectedOrigin:target.origin,expectedAccountId:target.accountId};
    if(editingDefault)await api('/manager/model/default',{...scope,...values});
    if(modelTarget!==target||!modelTargetValid())return;
    if(target.instanceId)await api('/manager/instances/model',{...scope,instanceId:target.instanceId,source,
      ...(source==='custom'?values:{})});
    if(modelTarget!==target||!modelTargetValid())return;
    $('model-key').value='';
    if(startAfter&&target.instanceId){
      const model=rowOf(target.instanceId)?.model;
      if(model&&!model.ready)throw Error(model.reason||'Finish configuring the model before starting this Agent.');
      closeDialog('dlg-model');
      await controlRole(target.instanceId,'agent','start','worker-notice');
    }else {closeDialog('dlg-model');say(target.instanceId?'notice':'account-notice','Model settings saved on this computer.');}
  });
}
function agentOptions(row){
  const taken=(state.instances||[]).filter(r=>r.id!==row.id)
    .flatMap(r=>[r.agentId,r.pendingAgentId]).filter(Boolean);
  return ((state.device||{}).agents||[]).map(a=>'<option value="'+esc(a.id)+'"'+(taken.includes(a.id)?' disabled':'')
    +'>'+esc(a.name)+(taken.includes(a.id)?' · already connected':'')+'</option>').join('');
}
/* Rebuilt only when it changed, so a poll does not drop a selection out from under a
   keyboard, and the option a person had chosen is restored when it is still offered.
   The choice is compared against the options the document now has, not against the markup
   they were built from: an id carrying a quote or an ampersand is escaped on the way in, so a
   substring search for it never matches and the selection silently jumps to the first row. */
function fillSelect(id,markup){
  const el=$(id);if(el.innerHTML===markup)return;
  const keep=el.value;el.innerHTML=markup;
  const options=[...(el.options||[])];
  // An Agent another installation holds is offered as unavailable; falling back to it would
  // put an id in the box that this page has already said cannot be used.
  const wanted=options.find(o=>o.value===keep&&o.disabled!==true)||options.find(o=>o.disabled!==true);
  el.value=wanted?wanted.value:'';
}
/* The list is the account's own directory of Agents, joined to what this computer has
   configured — not a list of local profiles with cloud names attached to them.
 *
 * An entry is one Agent the device grant authorizes. A local profile joins it only when it is
 * attached to that exact Agent, for this account and this Console origin: a profile attached
 * under another account, or to an Agent that has since left the grant, must never appear as
 * one of the Agents this account authorizes. And when the grant is not linked there is no
 * directory at all — a remembered list of names is not an authorization. */
function directory(){
  const device=state.device||{};
  if(device.state!=='linked')return [];
  const accountId=(device.account||{}).id||'',origin=device.origin||'',rows=state.instances||[];
  return (device.agents||[]).map(agent=>({agent,
    row:rows.find(r=>r.paired&&r.agentId===agent.id&&r.origin===origin&&r.accountId===accountId)
      ||rows.find(r=>!r.paired&&r.pendingAgentId===agent.id&&r.pendingOrigin===origin&&r.pendingAccountId===accountId)||null}));
}
/* Everything the directory does not claim: never attached, imported, attached elsewhere, or
   attached to an Agent this device is no longer authorized for. Kept, and kept separate. */
function looseProfiles(){
  const claimed=new Set(directory().map(entry=>entry.row&&entry.row.id).filter(Boolean));
  return (state.instances||[]).filter(row=>!claimed.has(row.id));
}
function renderAgents(){
  const device=state.device||{},linked=device.state==='linked',entries=directory();
  const markup=entries.map(entry=>{
    const agent=entry.agent,row=entry.row;
    if(row&&row.paired){
      const s=statusOf(row),mode=modeWord(row);
      return '<button type="button" class="agentrow" data-instance="'+esc(row.id)+'" aria-current="'+(row.id===selected?'true':'false')+'">'
        +'<b>'+esc(agent.name)+'</b><small><span class="dot '+s.dot+'"></span><span class="word">'+esc(s.word)+(mode?' · '+esc(mode):'')+'</span></small></button>';
    }
    // Not configured here: pressing it opens the first-use dialog and nothing else. No
    // profile is allocated and no credential is asked for until a person presses Set up.
    const attaching=Boolean(row&&row.pendingAgentId===agent.id);
    return '<button type="button" class="agentrow" data-agent="'+esc(agent.id)+'" aria-current="false">'
      +'<b>'+esc(agent.name)+'</b><small><span class="dot '+(attaching?'wait':'')+'"></span><span class="word">'
      +(attaching?(row.pendingReplace?'Key replacement pending':row.pendingError?'Action needed':'Finishing setup'):'Not set up on this computer')+'</span></small></button>';
  }).join('');
  $('agents-empty').hidden=entries.length>0;
  $('agents-empty').textContent=linked
    ?'No enabled Agents are available in this account. Create or enable one in Console, then refresh.'
    :'Sign in to see this account’s enabled Agents.';
  if(markup===lastMarkup.agents)return;
  // Whoever had focus is on a node this replacement is about to remove, so the key is read
  // first and the same row is given focus back once the list exists again.
  const active=document.activeElement&&document.activeElement.dataset?document.activeElement.dataset:{};
  const focused=(active.instance||'')+'/'+(active.agent||'');
  lastMarkup.agents=markup;$('agents').innerHTML=markup;
  for(const node of $('agents').querySelectorAll('[data-instance],[data-agent]')){
    const id=node.dataset.instance||'',agentId=node.dataset.agent||'';
    node.onclick=()=>choose(id||agentId);
    // Never into a closed drawer: focus that cannot be seen is focus nobody can get back.
    if(focused===id+'/'+agentId&&focused!=='/'&&node.focus&&$('rail').inert!==true)node.focus();
  }
}
/* First use of an enabled Agent on this computer. The target is captured when the dialog
   opens and never re-chosen: a person picks the Agent once, in the list, and chooses only how
   this computer should run it. */
let setupFor=null;const setupProfiles=new Map();
const setupIdentity=agent=>JSON.stringify([agent.origin,agent.accountId,agent.id]);
const setupAuthorized=agent=>{const device=state.device||{};return Boolean(agent)&&device.state==='linked'
  &&device.origin===agent.origin&&(device.account||{}).id===agent.accountId
  &&(device.agents||[]).some(a=>a.id===agent.id);};
function setupProfile(agent){
  const rows=state.instances||[],remembered=setupProfiles.get(setupIdentity(agent));
  const mine=remembered?rows.find(r=>r.id===remembered&&!r.paired):null;
  // A reservation the manager already made for this exact Agent is finished, never doubled:
  // pairing it again continues the same attempt, which is what its poll is for.
  return mine||rows.find(r=>!r.paired&&r.pendingAgentId===agent.id&&r.pendingOrigin===agent.origin&&r.pendingAccountId===agent.accountId)
    ||rows.find(r=>!r.paired&&!r.pendingAgentId&&r.setupTarget&&r.setupTarget.agentId===agent.id&&r.setupTarget.origin===agent.origin&&r.setupTarget.accountId===agent.accountId)||null;
}
function openSetup(agentId){
  const device=state.device||{},agent=(device.agents||[]).find(a=>a.id===agentId);
  if(!agent||device.state!=='linked')return;
  setupFor={id:agent.id,name:agent.name,origin:device.origin,accountId:(device.account||{}).id};
  const pending=setupProfile(setupFor);
  if(pending&&pending.pendingAgentId){selected=pending.id;render();openDialog('dlg-attach','attach-close');return;}
  openDialog('dlg-setup','setup-close');
}
function renderSetup(){
  const agent=setupFor,device=state.device||{},linked=device.state==='linked';
  $('setup-sub').textContent=agent?agent.name:'';
  const known=setupAuthorized(agent);
  const reason=!agent?''
    :!linked?'This computer is not signed in to an account any more. Sign in again before setting up an Agent.'
      :!known?'This Agent is no longer enabled in this account. Refresh Agents and choose again.':'';
  $('setup-blocked').hidden=reason==='';$('setup-blocked').textContent=reason;
  $('setup-form').hidden=!agent||reason!=='';
  const existing=agent?setupProfile(agent):null;
  $('setup-existing').hidden=existing==null;
  if(existing){
    $('setup-existing').textContent='A profile for this Agent already exists on this computer ('+existing.name
      +'). Setting up again finishes that one rather than creating a second.';
    $('setup-mode').value=existing.mode;
  }
}
let lastSignInAttempt='';
function renderAccount(){
  const device=state.device||{state:'none'},linked=device.state==='linked';
  const incomplete=device.state==='pending'&&!(device.code&&device.consoleUrl);
  const pending=(device.state==='pending'&&!incomplete)||device.state==='approved';
  const broken=['revoked','expired','unusable','unreadable'].includes(device.state);
  $('signed-out').hidden=linked||pending||broken;$('pending').hidden=!pending;$('linked').hidden=!linked;$('unusable').hidden=!broken;
  const who=linked?(device.account&&device.account.name||'Signed in'):broken?'Authorization unusable':pending?'Signing in…':incomplete?'Sign-in incomplete':'Sign in';
  $('account-line').textContent=who;
  $('account-dot').className='dot '+(linked?'on':broken?'bad':pending?'wait':'');
  // The avatar is the account's initial once there is an account, and a placeholder before
  // there is one; the second line says which computer this is, or what is waiting to happen.
  $('account-initial').textContent=linked?(who.trim().charAt(0).toUpperCase()||'?'):pending?'…':broken?'!':'·';
  $('account-sub').textContent=linked?(device.deviceName||'This computer')
    :broken?'Reset sign-in':pending?'Continue in your browser':incomplete?'Retry sign-in':'Connect your account';
  $('signin-recovery').hidden=!incomplete;
  $('signin-recovery').textContent=incomplete?(device.teaching||'Sign-in did not finish. Check the Console address and retry.'):'';
  if($('signin-poll-error').textContent!==signInPollError)$('signin-poll-error').textContent=signInPollError;
  $('signin-poll-error').hidden=!signInPollError;
  $('signin-reset').hidden=!(broken||(pending&&Boolean(signInPollError)));
  $('signin-reset-copy').textContent=device.state==='pending'?'Resetting clears this sign-in request.':device.state==='approved'?'Resetting stops local Agents and revokes this computer\'s authorization before clearing it.':'Resetting stops local Agents and clears this computer\'s stored authorization.';
  $('sign-in').textContent=incomplete?'Retry sign-in':'Sign in';
  $('signin-settings').hidden=linked||pending||broken;
  const attempt=JSON.stringify([device.origin,device.deviceName]);
  if(incomplete&&attempt!==lastSignInAttempt){
    $('console-url').value=device.origin||'';$('device-name').value=device.deviceName||'';lastSignInAttempt=attempt;
  }
  if(device.consoleUrl)$('console-link').href=device.consoleUrl;else $('console-link').removeAttribute('href');
  $('console-link').hidden=!device.consoleUrl;
  $('signin-reopen-hint').hidden=!device.consoleUrl;
  $('account-name').textContent=device.account?device.account.name:'';
  $('device-tag').textContent=device.deviceName?('This computer: '+device.deviceName):'';
  $('agent-summary').textContent=(device.agents||[]).length
    ?'Agents you may run here: '+device.agents.map(a=>a.name).join(', ')
    :'No enabled Agents are available in this account.';
  $('signout-state').textContent=device.signOut&&device.signOut.state==='incomplete'
    ?'Sign-out is incomplete at the '+device.signOut.step+' step. It is still signed in; retry uses the same revoke request.':'';
  $('unusable-teaching').textContent=device.teaching||'This authorization is no longer accepted by the account service.';
  $('default-model-summary').textContent='Default model: '+modelDescription(state.modelDefaults);
}
/* Why a profile is not in the Agent list, in its own words. A person who imported something,
   or signed into a different account, must be able to find what they had. */
function profileReason(row){
  const device=state.device||{},accountId=(device.account||{}).id||'',origin=device.origin||'';
  if(row.pendingAgentId)return 'Finishing setup for '+(row.pendingAgentName||row.pendingAgentId);
  if(!row.paired)return row.legacyImport?'Imported; not connected to an Agent yet':'Not connected to an Agent yet';
  if(row.origin!==origin||row.accountId!==accountId)return 'Connected under another account or Console address';
  return 'Connected to '+(row.agentName||row.agentId)+', which is not enabled in this account now';
}
function renderProfiles(){
  const legacy=state.legacyInstall,rows=looseProfiles();
  $('local-settings').hidden=rows.length===0&&legacy==null&&$('signin-settings').hidden;
  $('import-block').hidden=legacy==null;
  if(legacy)$('import-path').innerHTML='Found <code>'+esc(legacy.configFile)+'</code>'+(legacy.imported?' · already imported once':'');
  $('import-notes').innerHTML=notes.map(n=>'<li>'+esc(n)+'</li>').join('');
  const markup=rows.map(row=>'<button type="button" class="profilerow" data-profile="'+esc(row.id)+'">'
    +'<b>'+esc(row.name)+'</b><small>'+esc(profileReason(row))+'</small></button>').join('');
  $('profiles-empty').hidden=rows.length>0;
  if(markup!==lastMarkup.profiles){
    lastMarkup.profiles=markup;$('profiles').innerHTML=markup;
    for(const node of $('profiles').querySelectorAll('[data-profile]')){
      // Selecting one opens its settings, which is where connecting, model settings and
      // removal already live. Nothing is started and no host is opened by choosing it.
      node.onclick=()=>{const id=node.dataset.profile;if(!rowOf(id))return;selected=id;render();
        closeDialog('dlg-account');openDialog('dlg-details','details-close');};
    }
  }
  const origin=(state.device||{}).origin||'';
  const usable=(state.device||{}).state==='linked'&&/^https?:\/\//.test(origin);
  $('console-home-line').hidden=!usable;
  if(usable)$('console-home').href=origin;
}
/* Replacing an Agent's existing credential is consent for one Agent here and one cloud Agent,
   and it does not travel. The tick records the exact pair it was given for; any change of
   either — another Agent selected, another cloud Agent chosen in the list, the list changing
   under it — drops it. A poll that finds the same pair leaves it alone. */
const attachTarget=()=>selected+' '+$('agent-select').value;
function syncReplace(){
  if($('replace').checked&&replaceFor!==attachTarget()){$('replace').checked=false;}
  if(!$('replace').checked)replaceFor='';
}
function renderAttach(){
  const row=sel();
  $('attach-sub').textContent=row?row.name:'';
  const linked=(state.device||{}).state==='linked',offers=((state.device||{}).agents||[]).length>0;
  /* A control that is simply unavailable teaches nothing, so the one reason it is unavailable
     is written out: gone, not signed in, nothing authorized, or already connected. */
  const reason=!row?'This Agent is no longer on this computer. Close this and choose another.'
    :row.pendingAgentId?''
      :row.paired?'This Agent is already connected to '+(row.agentName||row.agentId||'a cloud Agent')
        +'. One cloud Agent runs in one Agent here; add another instead.'
          :!linked?'Sign in first; this account’s enabled Agents appear here.'
          :!offers?'No enabled Agents are available in this account. Create or enable one in Console, then refresh it here.':'';
  $('attach-blocked').hidden=reason==='';
  $('attach-blocked').textContent=reason;
  $('attach-form').hidden=!row||Boolean(row.pendingAgentId)||reason!=='';
  $('attach-pending').hidden=!row||!row.pendingAgentId;
  const conflict=Boolean(row?.pendingAgentId&&row.pendingError?.code==='runtime_credential_exists');
  $('pair-error').hidden=!row?.pendingError;$('pair-error').textContent=row?.pendingError?.teaching||'';
  $('pair-conflict').hidden=!conflict;$('pair-progress').hidden=conflict||Boolean(row?.pendingReplace);
  $('pair-replacement-pending').hidden=!row?.pendingReplace;
  $('pair-poll').hidden=false;$('pair-poll').textContent=row?.pendingReplace?'Continue key replacement':'Check again';
  if(!conflict||pendingReplaceFor!==pendingTarget(row)){$('pair-replace-confirm').checked=false;pendingReplaceFor='';}
  // The Agent's own name when the reservation carries one; its identifier is a fallback, not
  // the thing a person recognises.
  if(row&&row.pendingAgentId)$('pair-agent').textContent='Connecting to '+(row.pendingAgentName||row.pendingAgentId);
  if(row)fillSelect('agent-select',agentOptions(row));
  syncReplace();
}
function renderDetails(){
  const row=sel();
  $('details-sub').textContent=row?row.name:'';
  const attention=!row?'This Agent is no longer on this computer. Close this and choose another.'
    :row.orphaned?'Processes from a manager that is gone are still running: '
      +((row.orphaned.children||[]).map(c=>c.role+' pid '+c.pid).join(', '))+'. Stop them before using this Agent.'
    :row.blocked?row.blocked:'';
  $('detail-attention').hidden=attention==='';
  $('detail-attention').textContent=attention;
  $('detail-id').textContent=row?row.id:'—';
  $('detail-dir').textContent=row?row.directory:'—';
  $('detail-agent').textContent=row?(row.agentName||row.agentId||'Not connected'):'—';
  $('detail-running').textContent=row&&row.runningAgentId&&row.runningAgentId!=='unconfigured'?row.runningAgentId:'—';
  const legacy=row?row.legacyImport:null;
  $('detail-legacy').hidden=legacy==null;
  if(legacy)$('detail-legacy').textContent='Imported from '+legacy.configFile
    +((legacy.credentialsLeftInPlace||[]).length?'. Its original credentials ('+legacy.credentialsLeftInPlace.join(', ')
      +') stayed with that installation and are not covered by signing this computer out.':'.');
  $('model-row').hidden=!row||row.mode!=='local_agent';
  $('connection-key-open').hidden=!row||!row.paired||!row.connectionId;
  $('connection-key-open').disabled=Boolean(row?.worker)||Boolean(row?.blocked);
  $('agent-model-summary').textContent=row?.model
    ?(row.model.source==='default'?'Using the default model. ':'')+modelDescription(row.model)
      +(row.model.restartRequired?' Restart this Agent to apply the updated default.':'')
    :'Configure the model this Agent uses on this computer.';
  if(row&&row.mode==='local_agent')fillSelect('model-from',modelSources(row).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.name)+'</option>').join(''));
}
function renderCenter(){
  const row=sel();
  const needsStart=Boolean(row?.model&&row.mode==='local_agent'&&!row.agent&&!row.blocked&&!row.orphaned&&row.paired);
  $('agent-readiness').hidden=!needsStart;
  $('agent-readiness-copy').textContent=row?.model?.ready?'Ready to chat. Start this Agent when you are ready.':'Choose a model before starting this Agent.';
  $('agent-readiness-action').textContent=row?.model?.ready?'Start Agent':'Set model';
  $('center-title').textContent=row?row.name:'Rulith';
  $('center-sub').textContent=row
    ?(row.mode==='existing_client'?'This computer does the work for an Agent you run elsewhere.'
      :row.agentName||row.agentId||'Not connected to a cloud Agent yet.')
    :((state.instances||[]).length?'Choose an Agent to open its workspace.':'A local working environment for your Agents.');
  // The controls for one Agent exist only while there is one selected; an empty panel of
  // disabled buttons is a panel that has to be read before it can be ignored.
  $('railsel').hidden=!row;
  const isAgent=Boolean(row)&&hasRole(row,'agent');
  $('agent-pill').hidden=!row;
  if(row){
    const s=statusOf(row);
    $('agent-pill').textContent=row.mode==='existing_client'?'Worker only':row.agent?'Agent running':s.word==='Stopped'?'Agent stopped':s.word;
    $('agent-pill').className='pill'+(row.mode==='existing_client'?'':s.tone);
  }
  $('agent-toggle').hidden=!isAgent;
  if(isAgent)$('agent-toggle').textContent=row.agent?'Stop Agent':row.model&&!row.model.ready?'Set model':'Start Agent';
}
function renderWorker(){
  const row=sel();
  $('worker-toggle').hidden=!row;$('tools-open').hidden=!row;$('authoring-open').hidden=!row;
  if(!row){
    $('worker-pill').textContent='No Agent selected';$('worker-pill').className='pill';
    $('worker-note').textContent='Choose an Agent to see the Worker on this computer.';
    for(const id of ['worker-agent','worker-connection','worker-address','worker-dir'])$(id).textContent='—';
    return;
  }
  const has=hasRole(row,'worker');
  $('worker-toggle').hidden=!has;
  $('worker-pill').textContent=!has?'Not on this computer'
    :row.orphaned?'Needs attention':row.blocked?'Unavailable':row.worker?'Running':'Stopped';
  $('worker-pill').className='pill'+(!has?'':row.orphaned||row.blocked?' bad':row.worker?' ok':'');
  $('worker-note').textContent=!has?'This Agent does not run a Worker on this computer.'
    :row.orphaned?'Processes from a manager that is gone are still running. Open settings for what is still there.'
      :row.blocked?row.blocked
        :row.worker&&row.model?.workerRestartRequired?'Model service changed. Stop and start this Worker before using new attachments.'
        :row.worker?'Doing the work this Agent asks for on this computer.'
          :'Start the Worker when this Agent should use the tools and files on this computer.';
  if(has)$('worker-toggle').textContent=row.worker?'Stop Worker':'Start Worker';
  $('worker-agent').textContent=row.agentName||row.agentId||'Not connected';
  $('worker-connection').textContent=row.connectionId||'Not authorized yet';
  $('worker-address').textContent=row.open&&row.hostPort?('127.0.0.1:'+row.hostPort):'Not open';
  $('worker-dir').textContent=row.directory||'—';
}
function renderAuthoring(){
  const current=sel();if(authoringFor!==selected||authoringScope!==(current?.origin||'')+'/'+(current?.accountId||'')){
    authoringResult=null;authoringPermissionsReady=false;
    $('authoring-local-read').checked=false;$('authoring-off-machine').checked=false;
    say('authoring-notice','The selected Agent changed. Close this dialog and choose the Agent again.');
  }
  const row=sel();$('authoring-sub').textContent=row?.name||'';
  const ready=authoringResult&&typeof authoringResult==='object';$('authoring-review').hidden=!ready;
  $('authoring-publication').hidden=!(ready&&authoringResult.savedPackId);
  if(ready&&authoringResult.savedPackId)$('authoring-publication').href=new URL('/console/#/studio?localAuthoringDraft='+encodeURIComponent(authoringResult.savedPackId)+'&publish=1',current.origin).href;else $('authoring-publication').removeAttribute('href');
  if(!ready)return;
  const report=authoringResult.report||{},checks=[report.compiled===true?'Compiled':'Not compiled','Examples: '+(report.examples?.passed??0)+'/'+(report.examples?.total??0),'Citations: '+(report.citations?.verified??0)+'/'+(report.citations?.total??0)],questions=Array.isArray(authoringResult.draft?.questions)?authoringResult.draft.questions:[];
  const program=authoringResult.draft?.program||{},rules=Array.isArray(program.rules)?program.rules:[],citations=Array.isArray(authoringResult.draft?.citations)?authoringResult.draft.citations:[],examples=Array.isArray(authoringResult.draft?.examples)?authoringResult.draft.examples:[];
  $('authoring-result').innerHTML='<p><b>'+esc(program.title||program.id||'Checked draft')+'</b></p>'
    +(rules.length?'<h4>Rules</h4><ul>'+rules.map(r=>'<li>'+esc(r.label||r.id||JSON.stringify(r))+'</li>').join('')+'</ul>':'<p class="notice error">No draft rules were reported.</p>')
    +'<p class="sub">'+citations.length+' citation(s) · '+examples.length+' example(s)</p>'
    +(checks.length?'<h4>Checks</h4><ul>'+checks.map(c=>'<li>'+esc(typeof c==='string'?c:(c.title||c.teaching||JSON.stringify(c)))+'</li>').join('')+'</ul>':'<p class="sub">No checks were reported.</p>')
    +(questions.length?'<h4>Questions</h4><ul>'+questions.map(q=>'<li>'+esc(typeof q==='string'?q:(q.question||q.title||JSON.stringify(q)))+'</li>').join('')+'</ul>':'')
    +(!report.compiled||questions.length?'<p class="notice error">Resolve failed checks and questions in the local conversation before saving.</p>':'');
  const prior=$('authoring-case').value,cases=Array.isArray(authoringResult.cases)?authoringResult.cases:[];$('authoring-case-row').hidden=cases.length===0;
  $('authoring-case').innerHTML=cases.map(c=>'<option value="'+esc(c.caseId||c.id||'')+'">'+esc(c.title||c.caseId||c.id)+'</option>').join('');
  if(cases.some(c=>(c.caseId||c.id||'')===prior))$('authoring-case').value=prior;
  if(cases.length===0)$('authoring-result').innerHTML+='<p class="notice error">Continue the local conversation until it completes a certified Case for this document.</p>';
}
/* What the centre says about a frame is what the frame has actually done: asked for, arrived,
   taken too long, or failed. A frame that was appended and never loaded is a blank rectangle,
   and calling that "open" — or worse, "closed" — is a guess this page has no business making. */
function renderStage(){
  const row=sel(),note=$('stage-note'),action=$('stage-action');
  const opening=busy.has(frameScope(selected)),frame=frames.get(selected);
  let title='',copy='',label='',mode='';
  // What a selected Agent is doing always wins: a profile reached from the account settings is
  // selected without being one of the directory rows, and it still has a workspace to open.
  const entries=directory();
  if(!row&&entries.length===0&&(state.device||{}).state!=='linked'){title='Welcome to Rulith';
    copy='Sign in with your browser to see the Agents your account authorizes for this computer.';label='Account';mode='account';}
  else if(!row&&entries.length===0){title='No enabled Agents yet';
    copy='Agents are created and enabled in Console. Refresh this account when one is ready.';label='Account';mode='account';}
  else if(!row){title='Choose an Agent';copy='Your Agents are listed beside this conversation.';label='Show Agents';mode='rail';}
  else if(row.pendingAgentId){title='Finish connecting '+(row.pendingAgentName||row.name);
    copy=row.pendingError?.teaching||'This Agent is not connected on this computer yet.';label='Review connection';mode='attach';}
  else if(frame&&frame.failed){title=row.name;copy=frame.failed;label='Try again';mode='retry';}
  else if(frame&&frame.loaded){note.hidden=true;action.hidden=true;showFrames();return;}
  else if(frame&&frame.slow){title='Workspace not ready';copy='The workspace has not confirmed it is ready. It may be unavailable or failed to initialise. Try again.';label='Try again';mode='retry';}
  else if(frame){title='Opening '+row.name;copy='Loading the workspace…';label='';mode='';}
  else if(opening){title='Opening '+row.name;copy='';label='';mode='';}
  else{title=row.name;copy='Opening the workspace does not start the Agent or the Worker.';label='Open workspace';mode='open';}
  note.hidden=false;action.hidden=label==='';
  $('stage-title').textContent=title;$('stage-copy').textContent=copy;
  // Opening a workspace starts a host, so it is withheld with the rest while the manager is
  // not answering; showing the Agent list is not a change to anything and stays.
  action.disabled=offline!==''&&mode!=='rail';
  action.textContent=label;action.className='btn'+(mode==='rail'?' drawerbtn':'');
  action.dataset.mode=mode;
  showFrames();
}
function showFrames(){for(const entry of frames)entry[1].el.hidden=entry[0]!==selected||Boolean(sel()?.pendingAgentId);}
/* A frame is kept for the life of its host, so A → B → A returns to a live conversation.
   It is discarded only when what it points at is gone: the Agent was removed, its host was
   closed, or the host came back at a different address with a different key. */
function dropFrame(id){
  const frame=frames.get(id);if(!frame)return;
  if(frame.timer)clearTimeout(frame.timer);
  if(frame.el.remove)frame.el.remove();
  frames.delete(id);
}
function pruneFrames(){
  for(const entry of [...frames]){
    const row=rowOf(entry[0]),frame=entry[1];
    const stale=row==null||(row.open===false&&!busy.has(frameScope(entry[0])))
      ||(row.hostPort>0&&frame.hostPort>0&&row.hostPort!==frame.hostPort)
      ||(row.hostGeneration&&frame.hostGeneration&&row.hostGeneration!==frame.hostGeneration);
    if(stale)dropFrame(entry[0]);
  }
}
function render(next){
  const signedIn=next?.device?.state==='linked'&&['pending','approved'].includes(state.device?.state);
  if(next!==undefined)state={instances:next.instances||[],device:next.device||{state:'none'},modelDefaults:next.modelDefaults||null,legacyInstall:next.legacyInstall==null?null:next.legacyInstall};
  if(signedIn){signInPollError='';say('account-notice','');closeDialog('dlg-account');say('notice','Signed in as '+(state.device.account?.name||'your account')+'.');}
  if(selected&&!rowOf(selected))selected='';
  renderStartNotices();
  pruneFrames();renderAgents();renderCenter();renderWorker();renderStage();
  renderAccount();renderProfiles();renderSetup();renderAttach();renderDetails();renderModel();renderConnectionKey();renderAuthoring();applyControls();
  if(pageEntry&&!rowOf(pageEntry.id)){$('page-status').hidden=false;$('page-loading').hidden=false;$('page-loading').textContent='This Agent is no longer available. Close this panel and select another Agent.';$('page-retry').disabled=true;}
}

/* The address an Agent's page is loaded at carries that host's own loopback key, exactly as
   it would in the address bar of a window opened for it. It is never written into text, never
   stored and never logged, and the frame sends no referrer, so this page's own key cannot
   travel to the host in a request header.
 *
 * The way back the manager offers every page it opens is removed here, and that is the point:
 * the embedded conversation renders no return link — it is already inside the workbench — so
 * carrying the manager's own browser key across the origin boundary would hand this page's
 * authority to a different document for no benefit at all. It is dropped from the settings
 * pages too, because a link in one of those would carry it onward into a new tab. */
function withoutManager(url){
  try{const u=new URL(url);u.searchParams.delete('manager');return u.toString();}
  catch(e){return String(url).split(/[?&]manager=/)[0];}
}
function frameUrl(url){
  try{const u=new URL(url);u.searchParams.delete('manager');u.searchParams.set('embedded','1');return u.toString();}
  catch(e){const bare=withoutManager(url);return bare+(bare.indexOf('?')<0?'?':'&')+'embedded=1';}
}
let viewSequence=0,pageEntry=null;
function readyUrl(url,entry){const u=new URL(url);entry.view=String(++viewSequence);entry.origin=u.origin;u.searchParams.set('view',entry.view);u.searchParams.set('parentOrigin',location.origin);return u.toString();}
function acceptReady(event){
  if(!event.data||event.data.type!=='rulith-ui-ready')return;
  for(const entry of [...frames.values(),...(pageEntry?[pageEntry]:[])]){
    if(event.source!==entry.el.contentWindow||event.origin!==entry.origin||event.data.view!==entry.view)continue;
    if(entry===pageEntry&&!rowOf(entry.id))continue;
    entry.loaded=true;entry.slow=false;entry.failed='';if(entry.timer)clearTimeout(entry.timer);
    if(entry===pageEntry){$('page-status').hidden=true;$('page-loading').textContent='';$('page-loading').hidden=true;$('page-retry').hidden=true;}
    else render();
  }
}
window.addEventListener('message',acceptReady);
function ensureFrame(id,retry){
  if(frames.has(id)&&retry!==true){showFrames();return Promise.resolve();}
  const row=rowOf(id);if(!row)return Promise.resolve();
  const name=row.name;
  if(retry===true)dropFrame(id);
  return run(frameScope(id),'notice',async()=>{
    const v=await api('/manager/instances/open',{instanceId:id,page:'/'});
    if(!rowOf(id)||frames.has(id))return;
    const el=document.createElement('iframe');
    el.setAttribute('title','Workspace of '+name);
    el.setAttribute('referrerpolicy','no-referrer');
    el.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox');
    const entry={el:el,hostPort:Number(v.hostPort||0),hostGeneration:v.hostGeneration||'',loaded:false,slow:false,failed:''};
    // Listening before the address is set, and setting it before insertion, so the first
    // navigation replaces about:blank instead of pushing a history entry nobody asked for.
    // A 401 JSON body fires load too. Only the expected page's ready receipt confirms it.
    el.onload=()=>render();
    el.onerror=()=>{entry.failed='The workspace did not load. The Agent host may have stopped.';render();};
    entry.timer=setTimeout(()=>{if(!entry.loaded){entry.slow=true;render();}},8000);
    el.src=readyUrl(frameUrl(v.url),entry);
    frames.set(id,entry);
    $('stage').appendChild(el);
  });
}
function choose(id){
  if(!rowOf(id)){
    /* One entry point for choosing a row. A row that names an Agent the account authorizes but
       this computer has not configured opens first use and does nothing else: no profile is
       allocated and no credential is asked for until a person presses Set up. */
    if(((state.device||{}).agents||[]).some(a=>a.id===id))openSetup(id);
    return Promise.resolve();
  }
  selected=id;closeDrawers();render();
  return ensureFrame(id);
}
/* Setup and the tools page open in a dialog here, with a real anchor to the same address for
   anyone who wants a tab of their own. A window.open() after an await is a pop-up without a
   user gesture behind it: blocked silently, with nothing for this page to detect and nothing
   for a person to act on. */
function openSettings(id,page,noticeId){
  const row=rowOf(id);if(!row){say(noticeId,'This Agent is no longer available. Close this panel and select another Agent.',true);return Promise.resolve();}
  const name=row.name,label=page==='/setup'?'Setup':'Worker tools';
  return run(windowScope(id),noticeId,async()=>{
    const v=await api('/manager/instances/open',{instanceId:id,page:page});
    const url=withoutManager(v.url);
    $('page-title').textContent=label;
    $('page-sub').textContent=name;
    $('page-frame').setAttribute('title',label+' for '+name);
    $('page-tab').href=url;$('page-tab').hidden=false;
    if(pageEntry?.timer)clearTimeout(pageEntry.timer);
    pageEntry={el:$('page-frame'),loaded:false,id,page,noticeId};
    const entry=pageEntry;
    $('page-status').hidden=false;$('page-loading').hidden=false;$('page-loading').textContent='Opening '+label+'…';$('page-retry').hidden=true;say('page-notice','');
    entry.timer=setTimeout(()=>{if(pageEntry===entry&&!entry.loaded){$('page-loading').textContent='This page has not confirmed that it loaded. Its host may have stopped. Try again or open it in a new tab.';$('page-retry').hidden=false;}},8000);
    $('page-frame').src=readyUrl(url,entry);
    openDialog('dlg-page','page-close');
  });
}
$('page-retry').onclick=()=>{if(offline){say('page-notice',offline,true);return Promise.resolve();}if(pageEntry)return openSettings(pageEntry.id,pageEntry.page,'page-notice');};
/* What a control reports is the state that came back, not the fact that a request was
   answered: a role that was asked to stop and has not exited is still running, and saying
   otherwise would be a claim about a process this page cannot see. */
function controlRole(id,role,operation,noticeId){
  const word=role==='agent'?'Agent':'Worker',name=(rowOf(id)||{}).name||'';
  pendingStartNotices.delete(id+':'+role);
  return run('role:'+id+':'+role,noticeId,async()=>{
    let answer;
    try{answer=await api('/manager/instances/control',{instanceId:id,role:role,operation:operation});}
    catch(e){
      if(operation==='start'&&e.state==='unconfirmed'){
        if(rowOf(id)?.ready?.[role]===true)return;
        rememberStartNotice(id,role,noticeId,e.message);return;
      }
      throw e;
    }
    const row=rowOf(id),outcome=answer&&typeof answer.control==='object'&&answer.control?answer.control:answer||{};
    const still=row?row[role]===true:false,where=id===selected?'':name+': ';
    if(operation==='start'&&!still)say(noticeId,where+word+' did not report that it started'
      +(outcome.state?' ('+outcome.state+')':'')+'.'+(outcome.teaching?' '+outcome.teaching:''),true);
    else if(operation==='stop'&&still)say(noticeId,where+word+' was asked to stop and has not exited yet.'
      +(outcome.teaching?' '+outcome.teaching:''),true);
    else say(noticeId,'');
  });
}

/* Dialogs. Each remembers what had focus, takes focus itself, and gives it back. */
function openDialog(id,focusId){
  if(dialogs.some(d=>d.id===id))return;
  if(dialogs.length)$(dialogs[dialogs.length-1].id).hidden=true;
  dialogs.push({id:id,prior:document.activeElement});
  $('shell').inert=true;$(id).hidden=false;render();
  const first=focusId?$(focusId):null;if(first&&first.focus)first.focus();
}
function closeDialog(id){
  if(id==='dlg-attach'){$('pair-replace-confirm').checked=false;pendingReplaceFor='';}
  const at=dialogs.map(d=>d.id).indexOf(id);if(at<0)return;
  const entry=dialogs.splice(at,1)[0];$(id).hidden=true;
  if(id==='dlg-model'){$('model-key').value='';modelTarget=null;modelOriginal=null;}
  if(id==='dlg-connection-key'){$('connection-key-value').value='';connectionKeyTarget=null;}
  // A settings page left loaded in a closed dialog keeps polling its own host. It is let go,
  // and reopened fresh next time, which is also what an operator expects of a closed window.
  if(id==='dlg-page'){if(pageEntry?.timer)clearTimeout(pageEntry.timer);pageEntry=null;$('page-frame').src='about:blank';$('page-tab').href='';$('page-tab').hidden=true;}
  if(dialogs.length)$(dialogs[dialogs.length-1].id).hidden=false;
  $('shell').inert=dialogs.length>0;
  if(entry.prior&&entry.prior.focus)entry.prior.focus();
}
function closeDrawers(){drawer='';applyShell();}
/* A drawer that is off-screen is still in the document: without inert, Tab from the stage
   walks into an Agent list nobody can see. And a window widened past the breakpoint has no
   drawer at all, so the one that was open stops being open rather than staying "open" behind
   a layout that no longer has the concept. */
const narrowNow=()=>typeof window.matchMedia==='function'?window.matchMedia('(max-width:980px)').matches===true:!(Number(window.innerWidth)>980);
function applyShell(){
  const narrow=narrowNow();
  if(!narrow&&drawer!=='')drawer='';
  $('shell').className='shell'+(drawer?' '+drawer+'-open':'');
  $('scrim').hidden=drawer==='';
  $('rail').inert=narrow&&drawer!=='rail';
  $('rail-open').setAttribute('aria-expanded',drawer==='rail'?'true':'false');
}
if(typeof window.matchMedia==='function'){
  const query=window.matchMedia('(max-width:980px)');
  if(query.addEventListener)query.addEventListener('change',()=>applyShell());
  else if(query.addListener)query.addListener(()=>applyShell());
}
for(const pair of [['dlg-account','account-close'],['dlg-setup','setup-close'],['dlg-attach','attach-close'],['dlg-details','details-close'],['dlg-connection-key','connection-key-close'],['dlg-model','model-close'],['dlg-page','page-close'],['dlg-authoring','authoring-close']]){
  $(pair[1]).onclick=()=>closeDialog(pair[0]);
  $(pair[0]).onclick=event=>{if(event.target===$(pair[0]))closeDialog(pair[0]);};
}
document.addEventListener('keydown',event=>{
  if(event.key==='Tab'&&dialogs.length){
    // iframe is in this list on purpose: the settings dialog is a page, and a trap that could
    // not tab into it would make that page unreachable from the keyboard.
    const modal=$(dialogs[dialogs.length-1].id),items=[...modal.querySelectorAll('button,a[href],input,select,textarea,summary,iframe')]
      .filter(el=>!el.disabled&&el.getClientRects().length>0);
    if(items.length){const first=items[0],last=items[items.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    return;
  }
  if(event.key!=='Escape')return;
  event.preventDefault();
  if(dialogs.length)closeDialog(dialogs[dialogs.length-1].id);
  else if(drawer)closeDrawers();
});
$('account-open').onclick=()=>openDialog('dlg-account','account-close');
$('details-open').onclick=()=>openDialog('dlg-details','details-close');
$('default-model-open').onclick=()=>openModel();
$('agent-model-open').onclick=()=>openModel(selected);
$('connection-key-open').onclick=openConnectionKey;
$('connection-key-save').onclick=saveConnectionKey;
$('model-edit-default').onclick=()=>openModel();
$('model-source').onchange=()=>{
  const row=modelTarget?.instanceId?rowOf(modelTarget.instanceId):null;
  fillModelFields($('model-source').value==='default'?state.modelDefaults:row?.model?.source==='custom'?row.model
    :{url:row?.model?.url||'',name:row?.model?.name||'',thinking:row?.model?.thinking||'standard'});
  render();
};
$('model-save').onclick=()=>saveModel(false);
$('model-save-start').onclick=()=>saveModel(true);
$('attach-open').onclick=()=>openDialog('dlg-attach','attach-close');
$('rail-open').onclick=()=>{drawer=drawer==='rail'?'':'rail';applyShell();};
$('rail-close').onclick=closeDrawers;$('scrim').onclick=closeDrawers;
$('stage-action').onclick=()=>{
  const mode=$('stage-action').dataset.mode,id=selected;
  if(mode==='account')return void $('account-open').onclick();
  if(mode==='rail'){drawer='rail';applyShell();return;}
  if(mode==='attach'&&id){openDialog('dlg-attach','attach-close');return;}
  if(mode==='retry'&&id)return void ensureFrame(id,true);
  if(mode==='open'&&id)ensureFrame(id);
};

/* Reserve the browser tab inside the click, before the network round trip consumes the
   user gesture. It cannot reach this local page; a blocked or closed tab leaves a normal
   link to the same authorization attempt. Merely loading the workbench never opens it. */
function signIn(){
  if(busy.has('account')){say('account-notice','Sign-in is already starting.');return Promise.resolve();}
  if($('sign-in').disabled)return Promise.resolve();
  signInPollError='';
  let tab=null;
  try{tab=window.open('about:blank','_blank');if(tab)tab.opener=null;}catch(e){if(tab)tab.close();tab=null;}
  const request={consoleUrl:$('console-url').value,name:$('device-name').value};
  return run('account','account-notice',async()=>{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
    try{
      const reply=await api('/manager/device/start',request,controller.signal);
      const url=reply.device?.consoleUrl;
      if(!url)throw Error('The sign-in page is not available yet. Please retry.');
      let target;try{target=new URL(url);}catch(e){throw Error('The sign-in page address is invalid.');}
      if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)))throw Error('The sign-in page address is invalid.');
      if(tab&&!tab.closed){
        try{tab.location.replace(url);}catch(e){tab.close();say('account-notice','Open the sign-in page using the link below.');}
      }else say('account-notice','Open the sign-in page using the link below.');
      schedule();
    }catch(e){if(tab&&!tab.closed)tab.close();throw e;}finally{clearTimeout(timeout);}
  });
}
$('sign-in').onclick=signIn;
$('refresh-account').onclick=()=>run('account','account-notice',()=>api('/manager/device/refresh',{}).then(v=>{
  const added=(v.addedAgents||[]).map(a=>a.name||a.id), removed=(v.removedAgents||[]).map(a=>a.name||a.id), stopped=(v.stoppedInstances||[]).map(i=>i.name), stopping=(v.stoppingInstances||[]).map(i=>i.name);
  const parts=[];if(added.length)parts.push('Added: '+added.join(', ')+'.');if(removed.length)parts.push('No longer enabled: '+removed.join(', ')+'.');if(stopped.length)parts.push('Stopped on this computer: '+stopped.join(', ')+'.');if(stopping.length)parts.push('Stopping: '+stopping.join(', ')+'.');
  say('account-notice',parts.join(' ')||'Enabled Agent list is up to date.',stopping.length>0);
}));
$('start-over').onclick=()=>run('account','account-notice',()=>api(state.device?.state==='approved'?'/manager/device/signout':'/manager/device/forget',{}).then(v=>{
  say('account-notice',v.state==='incomplete'?(v.teaching||'Some Agents are still running.')
    :v.revoke==='unconfirmed'?(v.teaching||'Cleared on this computer; the revocation was not confirmed.')
      :'This authorization was cleared. Sign in again to choose Agents.',v.state==='incomplete'||v.revoke==='unconfirmed');}));
$('sign-out').onclick=()=>run('account','account-notice',()=>api('/manager/device/signout',{}).then(v=>{
  say('account-notice',v.state==='signed_out'
    ?(v.alreadyRevoked?'Signed out. Every Agent was stopped; this computer had already been revoked in Console.':'Signed out. Every Agent was stopped and this computer was revoked.')
    :(v.teaching||'Sign-out is incomplete.'),v.state!=='signed_out');}));
/* A new Agent cannot work until a cloud Agent is connected to it, so the next step is offered
   rather than left to be found. Its workspace is not opened: there is nothing in it yet, and
   opening one would start a host for an Agent that cannot run. */
/* Setting an enabled Agent up here, in one press: a profile named after the Agent it is
   for, then the ordinary pairing against that exact Agent. Never a replacement — first use
   mints this profile's own credential, and replacing an existing one stays the deliberate,
   separately consented step it always was.
 *
 * The scope makes a second press say so rather than starting a second attempt, and the
 * profile is looked up again before each try, so a run that failed after creating but before
 * pairing finishes that same profile instead of leaving a spare behind. */
$('setup-start').onclick=()=>{
  const agent=setupFor;if(!agent)return;
  run('setup:'+agent.id,'setup-notice',async()=>{
    if(!setupAuthorized(agent))throw Error('The account changed or this Agent is no longer enabled. Close this panel and choose again.');
    const existing=setupProfile(agent);
    let id=existing?existing.id:'';
    if(id===''){
      const created=await api('/manager/instances/create',{name:agent.name,mode:$('setup-mode').value,setupTarget:{origin:agent.origin,accountId:agent.accountId,agentId:agent.id}});
      id=String((created||{}).id||'');
      if(id==='')throw Error('This computer did not name the profile it created for that Agent.');
      setupProfiles.set(setupIdentity(agent),id);
    }
    if(!setupAuthorized(agent))throw Error('The account changed or this Agent is no longer enabled. The unconnected profile remains in this computer settings.');
    try{await api('/manager/instances/pair',{instanceId:id,agentId:agent.id,replaceAgentToken:false});}
    catch(error){
      if(rowOf(id)?.pendingAgentId&&setupFor===agent&&!$('dlg-setup').hidden){
        selected=id;closeDialog('dlg-setup');render();openDialog('dlg-attach','attach-close');say('attach-notice',error.message,true);
      }
      throw error;
    }
    if(!rowOf(id))throw Error('That profile is no longer on this computer.');
    if(setupFor!==agent||$('dlg-setup').hidden)return;
    selected=id;render();
    // The outcome proof is the one the attach dialog already carries: a pairing that has not
    // been confirmed is checked again or cancelled there, never assumed to have worked.
    if((rowOf(id)||{}).pendingAgentId){closeDialog('dlg-setup');openDialog('dlg-attach','attach-close');return;}
    setupProfiles.delete(setupIdentity(agent));
    closeDialog('dlg-setup');
    await ensureFrame(id);
    if(selected===id&&setupFor===agent&&setupAuthorized(agent)){
      const row=rowOf(id);
      if(row?.mode==='local_agent'&&row.model){
        openModel(id);
      }else await openSettings(id,'/setup','notice');
    }
  });
};
$('import').onclick=()=>run('add','account-notice',()=>api('/manager/instances/import',{sourceConfigFile:state.legacyInstall.configFile,name:$('import-name').value})
  .then(v=>{notes=v.notes||[];render();say('account-notice','Imported as a profile that is not connected yet. The original installation was not changed and keeps its own credentials.');}));
/* The replacement is sent only if the tick still belongs to exactly this Agent and exactly
   this cloud Agent — the pair that was on screen when it was ticked. Anything else and it is
   somebody's old intent applied to a credential they were not looking at. */
$('replace').onchange=()=>{replaceFor=$('replace').checked?attachTarget():'';};
$('agent-select').onchange=()=>{syncReplace();};
$('pair').onclick=()=>{const id=selected,agentId=$('agent-select').value;
  const replace=$('replace').checked&&replaceFor===id+' '+agentId;
  run('attach:'+id,'attach-notice',()=>api('/manager/instances/pair',
    {instanceId:id,agentId:agentId,replaceAgentToken:replace})
    .then(()=>{$('replace').checked=false;replaceFor='';}));};
async function showConnected(id){
  if(selected===id&&rowOf(id)?.paired){closeDialog('dlg-attach');await ensureFrame(id);}
}
$('pair-poll').onclick=()=>{const id=selected;return run('attach:'+id,'attach-notice',async()=>{
  await api('/manager/instances/pair/poll',{instanceId:id});await showConnected(id);
});};
$('pair-replace-confirm').onchange=()=>{pendingReplaceFor=$('pair-replace-confirm').checked?pendingTarget(sel()):'';applyControls();};
$('pair-replace').onclick=()=>{
  if($('pair-replace').disabled)return;
  const row=sel(),id=selected,agentId=row.pendingAgentId,origin=row.pendingOrigin,accountId=row.pendingAccountId;
  return run('attach:'+id,'attach-notice',async()=>{
    // A confirmed cancellation is the only way to release the old non-replacement request.
    // If it was already approved, no replacement starts and its original delivery survives.
    await api('/manager/instances/pair/cancel',{instanceId:id});
    const device=state.device||{};
    if(device.state!=='linked'||device.origin!==origin||device.account?.id!==accountId
      ||!(device.agents||[]).some(a=>a.id===agentId))throw Error('The account or Agent changed. Choose the Agent again.');
    await api('/manager/instances/pair',{instanceId:id,agentId,replaceAgentToken:true});
    await showConnected(id);
  });
};
$('pair-cancel').onclick=()=>{const id=selected;run('attach:'+id,'attach-notice',()=>api('/manager/instances/pair/cancel',{instanceId:id})
  .then(()=>say('attach-notice','The connection attempt was cancelled.')));};
$('model-copy').onclick=()=>{const id=selected;run('model:'+id,'details-notice',()=>api('/manager/instances/model/copy',{instanceId:id,fromInstanceId:$('model-from').value})
  .then(v=>say('details-notice','Model settings copied: '+v.model+' at '+v.modelService+(v.modelKeyCopied?' (including its key)':' (no key was set)')+'.')));};
$('forget').onclick=()=>{const id=selected;run('forget:'+id,'details-notice',()=>api('/manager/instances/forget',{instanceId:id})
  .then(v=>{closeDialog('dlg-details');say('notice','Removed from Rulith. Its files remain at '+v.directory+'.');}));};
$('start-all').onclick=()=>{const id=selected,row=rowOf(id);
  if(row?.mode==='local_agent'&&row.model&&!row.model.ready)return void openModel(id);
  run('instance:'+id,'details-notice',()=>api('/manager/instances/start',{instanceId:id}).then(v=>{
  for(const r of v.results||[])if(r.state==='unconfirmed')rememberStartNotice(id,r.role,'details-notice',r.teaching||r.state);
  const failed=(v.results||[]).filter(r=>!r.ok&&r.state!=='unconfirmed');
  say('details-notice',failed.map(r=>r.role+': '+(r.teaching||r.state)).join('\n'),failed.length>0);}));};
$('stop-all').onclick=()=>{const id=selected;for(const role of ['agent','worker'])pendingStartNotices.delete(id+':'+role);run('instance:'+id,'details-notice',()=>api('/manager/instances/stop',{instanceId:id}).then(v=>{
  const failed=(v.results||[]).filter(r=>!r.ok);
  say('details-notice',failed.length?failed.map(r=>r.role+': '+(r.teaching||r.state)).join('\n')
    :v.stopped?'':'Some roles were asked to stop and have not exited yet.',!v.stopped);}));};
$('agent-toggle').onclick=()=>{const id=selected,row=rowOf(id);if(!row)return;
  if(!row.agent&&row.model&&!row.model.ready)return void openModel(id);
  controlRole(id,'agent',row.agent?'stop':'start','worker-notice');};
$('agent-readiness-action').onclick=()=>$('agent-toggle').onclick();
/* Both role controls live in the Agent rail. Their answers stay beside those controls,
   including while that rail covers the conversation on a phone. */
$('worker-toggle').onclick=()=>{const id=selected,row=rowOf(id);if(row)controlRole(id,'worker',row.worker?'stop':'start','worker-notice');};
$('tools-open').onclick=()=>openSettings(selected,'/worker-tools','worker-notice');
$('authoring-open').onclick=()=>{
  const row=sel(),id=selected,scope=(row?.origin||'')+'/'+(row?.accountId||''),load=++authoringLoad;
  authoringFor=id;authoringScope=scope;authoringResult=null;authoringPermissionsReady=false;
  $('authoring-configure').hidden=true;$('authoring-configure').removeAttribute('href');
  $('authoring-local-read').checked=false;$('authoring-off-machine').checked=false;
  say('authoring-notice','Reading this Agent’s current material permissions…');
  openDialog('dlg-authoring','authoring-close');applyControls();
  const current=()=>load===authoringLoad&&selected===id&&authoringScope===scope
    &&(sel()?.origin||'')+'/'+(sel()?.accountId||'')===scope;
  return api('/manager/authoring/status',{instanceId:id}).then(v=>{
    if(!current())return;
    const p=v.materialPermissions;
    if(typeof p?.localRead!=='boolean'||typeof p?.offMachine!=='boolean')throw Error('Current material permissions could not be confirmed. Reopen this dialog to retry.');
    $('authoring-local-read').checked=p.localRead;$('authoring-off-machine').checked=p.offMachine;
    authoringPermissionsReady=v.bindingMatches===true&&v.preparationBlocked!==true;
    if(v.preparationBlocked===true&&row?.origin&&row?.agentId){$('authoring-configure').href=new URL('/console/#/agents/'+encodeURIComponent(row.agentId)+'?tab=configuration',row.origin).href;$('authoring-configure').hidden=false;}
    say('authoring-notice',v.teaching||(v.configured?'Saved material choices loaded. Prepare to apply them to this Worker binding.':'Choose the material permissions for this Agent.'),!authoringPermissionsReady);
  }).catch(e=>{if(current())say('authoring-notice',e.message,true);}).finally(()=>{if(current())applyControls();});
};
$('authoring-prepare').onclick=()=>{const id=selected;run('authoring:'+id,'authoring-notice',()=>api('/manager/authoring/prepare',{instanceId:id,materialPermissions:{localRead:$('authoring-local-read').checked,offMachine:$('authoring-off-machine').checked}}).then(v=>say('authoring-notice',v.teaching||('Assistant state: '+v.stage+'.'))));};
$('authoring-review-open').onclick=()=>{const id=selected;run('authoring:'+id,'authoring-notice',()=>api('/manager/authoring/review',{instanceId:id}).then(v=>{authoringResult=v;renderAuthoring();say('authoring-notice','Read and verified the immutable local check result.');}));};
$('authoring-case').onchange=()=>applyControls();
$('authoring-save').onclick=()=>{const id=selected,v=authoringResult;if(!v)return;run('authoring:'+id,'authoring-notice',()=>api('/manager/authoring/save',{instanceId:id,resultId:v.resultId,caseId:$('authoring-case').value}).then(saved=>{if(!saved.entry||!saved.packId||!saved.caseId)throw Error('The private-draft receipt was incomplete.');if(selected===id&&authoringResult===v){v.savedPackId=saved.packId;renderAuthoring();say('authoring-notice','Private draft saved: '+saved.packId+'. Review publication in Console when ready.');}}));};
$('open-setup').onclick=()=>openSettings(selected,'/setup','details-notice');

/* A poll refreshes the state and nothing else: it never replaces a field being typed in, a
   checkbox, an open dialog, a disclosure, the selection, or the frame that is showing. It
   stands aside while an action is in flight so a stale answer cannot overwrite a fresh one. */
function awaitingSignIn(){const device=state.device||{};return (device.state==='pending'&&device.code&&device.consoleUrl)||device.state==='approved';}
function poll(){
  if(polling)return polling;
  const canCheck=Boolean(awaitingSignIn());
  const step=canCheck?api('/manager/device/poll',{}):api('/manager/state');
  // Sign-in has no manual poll button: refusals need their own visible teaching and reset
  // path. Keep retrying the same request; a transient failure can still recover by itself.
  polling=step.then(()=>{if(canCheck&&signInPollError){signInPollError='';render();}}).catch(error=>{
    if(canCheck){signInPollError=error.message;render();}
  }).finally(()=>{polling=null;});
  return polling;
}
function schedule(){clearTimeout(pollTimer);pollTimer=setTimeout(()=>{
  // The browser sign-in page waits for the device delivery acknowledgement. That must
  // still be collected while this workbench is behind it; other refreshes stay idle.
  const expires=Date.parse(state.device?.codeExpiresAt||'');
  // Once credentials are stored, the one-time code is no longer exposed. Finish the
  // acknowledgement even then; code expiry bounds only the pending authorization.
  const signingIn=state.device?.state==='approved'||(awaitingSignIn()&&Number.isFinite(expires)&&expires>Date.now());
  if(busy.size===0&&(!document.hidden||signingIn))poll().then(schedule,schedule);
  else schedule();},3000);}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&busy.size===0&&['pending','approved'].includes(state.device?.state)){
    clearTimeout(pollTimer);poll().then(schedule,schedule);
  }
});
applyShell();
run('boot','notice',()=>api('/manager/state')).then(schedule);
</script></body></html>`
