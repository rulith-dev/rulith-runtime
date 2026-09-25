// SPDX-License-Identifier: Apache-2.0
import { renderMarkdown } from './markdown.mjs'
import { localThemeCss, managerReturnHref, workbenchReadyScript } from './theme.mjs'
/** Browser projection for Rulith Local. It contains no Case or Worker authority. */
/**
 * The Cases this conversation is working, as the Agent observed them.
 *
 * A conversation holds a set of acceptance roots, not one active Case, and each root has
 * its own lifecycle. Membership comes from the Agent's `focus` events, which carry the
 * {caseId, root} pairs the authority returned; lifecycle comes from the per-root
 * `case-state` observations. Neither is inferred here — a projection that guessed a
 * status would be a second, quieter source of truth about the Board.
 *
 * A root that has left focus is still listed while the view remembers it, marked as
 * released: leaving focus is not a lifecycle transition, and neither is a reclaimed local
 * conversation.
 */
export function projectCaseRoots(events) {
  const labels = { running: 'Running', paused: 'Paused', closed: 'Closed' }
  const observed = new Map(), order = [], detached = new Set()
  let focus = null
  for (const event of events) {
    if (event.src !== 'agent') continue
    if (event.type === 'focus' && Array.isArray(event.roots)) {
      focus = event.roots.map((row) => String(row?.caseId ?? '')).filter(Boolean)
    }
    const id = String(event.caseId || '')
    if (!id) continue
    if (event.type === 'case-state') observed.set(id, event)
    if (event.type === 'session-detached') detached.add(id)
    if (['case-state', 'case-closed', 'case-pending', 'session-detached', 'case-unfocused'].includes(event.type)
      || (event.type === 'case-open' && event.ok !== false)) {
      if (!order.includes(id)) order.push(id)
    }
  }
  const focused = focus === null ? order : focus
  const ids = [...focused, ...order.filter((id) => !focused.includes(id))]
  return ids.map((caseId) => {
    const snapshot = observed.get(caseId)
    const lifecycle = Object.hasOwn(labels, snapshot?.caseStatus) ? snapshot.caseStatus : 'unavailable'
    return {
      caseId,
      root: String(snapshot?.root || ''),
      focused: focused.includes(caseId),
      lifecycle,
      label: labels[lifecycle] || 'Unavailable',
      gaps: typeof snapshot?.gaps === 'number' ? snapshot.gaps : null,
      observation: detached.has(caseId) ? 'Detached · last observed'
        : snapshot?.contact === 'unknown' ? 'No authoritative response'
          : snapshot?.contact === 'not-refreshed' ? 'Not refreshed by the last bounded answer'
            : lifecycle === 'unavailable' ? 'Unavailable' : 'Last observed',
    }
  })
}

/**
 * What this conversation is waiting for, in plain words.
 *
 * The Agent may be holding a call whose outcome only the authority knows. That is not an
 * error and it is not idleness, and showing it as either is how a person concludes the
 * Runtime is stuck — or, worse, that nothing was ever dispatched. So it gets its own line:
 * the state the authority published, which tool it concerns, and what the host is doing
 * about it. Nothing is inferred; every field comes from an event the Agent emitted.
 *
 * The states are the authority's four, plus the local blocked outcomes that end a turn.
 * `result_ready` is deliberately visible even though it is usually brief: when the read
 * cannot be completed, that brief state is the whole explanation.
 */
export function projectRecovery(events, initial) {
  let current = initial ?? { state: 'none', label: 'No unresolved call', detail: '', tool: '' }
  for (const event of events) {
    if (event.src !== 'agent') continue
    const tool = String(event.tool || current.tool || '')
    if (['spawn', 'exit'].includes(event.type) && current.state !== 'none') {
      current = { state: 'unconfirmed', tool, label: 'Earlier ' + (tool || 'tool') + ' status needs refreshing',
        accountId: current.accountId, agentId: current.agentId, callRef: current.callRef, caseId: current.caseId,
        detail: 'The Agent process changed. Its earlier recovery observation is no longer current; the server must confirm the original call before further work.' }
    }
    if (event.type === 'pending-inherited') {
      current = { state: 'inherited', tool, label: 'Earlier ' + (tool || 'tool') + ' outcome is unknown',
        accountId: String(event.accountId || ''), agentId: String(event.agentId || ''), callRef: '', caseId: '',
        detail: 'This computer recorded an unfinished call from a previous run. Its current server state has not been checked. Open this Agent’s Runtime in Console to inspect it; do not repeat the action.' }
    }
    if (event.type === 'recovery') {
      if (event.state === 'none') {
        // The authority says there is nothing outstanding. Without this branch the panel
        // kept showing the last `waiting` for the rest of the session, which reads as a
        // Runtime that never came back.
        current = { state: 'none', tool: '', label: 'No unresolved call', detail: '' }
      } else if (event.state === 'unreadable') {
        current = { state: 'unreadable', tool, label: 'The authority published no readable recovery record',
          detail: 'This host will not start work while it cannot tell whether a call is outstanding.' }
      } else if (event.state === 'claim_not_honoured') {
        current = { state: 'result_ready', tool, label: 'An earlier ' + (tool || 'tool') + ' result was not delivered',
          detail: 'The authority reports a determined result but ReadOperation did not return that original result. It is being retried.' }
      } else if (event.state === 'waiting') {
        current = { state: 'waiting', tool, label: 'Waiting for an earlier ' + (tool || 'tool') + ' call',
          detail: 'The authority is still executing it. A new user message may request an independent Board observation when the server supports it; the earlier call remains pending.' }
      } else if (event.state === 'result_ready') {
        current = { state: 'result_ready', tool, label: 'Collecting an earlier ' + (tool || 'tool') + ' result',
          detail: 'The outcome is determined and ReadOperation is collecting its public result without a Board command.' }
      } else if (event.state === 'reconciliation_required') {
        current = { state: 'reconciliation_required', tool, label: 'An earlier ' + (tool || 'tool') + ' call needs operator reconciliation',
          detail: 'Reconcile the original call in Console. An independent Board observation can show committed state, but cannot settle the earlier effect.' }
      } else {
        current = { state: 'unreadable', tool: '', label: 'The authority published an unknown recovery state',
          detail: 'This host cannot confirm the original call or its current state. Inspect this Agent in Console before further work.' }
      }
      if (['unreadable', 'claim_not_honoured', 'waiting', 'result_ready', 'reconciliation_required'].includes(event.state)) current = { ...current,
        accountId: String(event.accountId || ''), agentId: String(event.agentId || ''),
        callRef: String(event.callRef || ''), caseId: String(event.caseId || '') }
    }
    if (event.type === 'operation-read' && event.state === 'unavailable') {
      current = { state: 'read_unavailable', tool,
        label: 'Earlier ' + (tool || 'pure read') + ' content is unavailable',
        detail: 'The original read is terminal, but its content was refused under current disclosure. No original result was supplied; the model may decide a new command.' }
    }
    if (event.type === 'handoff' || (event.type === 'operation-read' && event.state === undefined)) {
      current = { state: 'none', tool: '', label: 'No unresolved call',
        detail: 'The public result of an earlier ' + (String(event.tool || 'tool')) + ' call was read for the model, which decides again.' }
    }
    if (event.type === 'queue-suspended') {
      current = { ...current, detail: event.notSent + ' further call(s) proposed in that turn were not sent.' }
    }
    if (event.type === 'recovery-conflict') {
      current = { state: 'unreconciled', tool: String(event.tool || ''),
        label: 'An earlier ' + String(event.tool || 'tool') + ' call needs reconciling',
        detail: 'Its outcome was never learned and the authority reports nothing outstanding. Reconcile request '
          + String(event.requestId || '') + ' in Console; an empty record does not prove the command had no effect.' }
    }
    if (event.type === 'blocked') {
      current = { state: 'blocked', tool, label: 'Turn stopped: ' + String(event.reason || 'unresolved call'),
        detail: String(event.teaching || '') }
    }
    // A model proposal or QueryBoard verdict is no evidence that the original call settled.
  }
  return current
}

/** An actual request/result pair; accepted means admission, never Case certification. */
export function renderToolCall(event, result) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const status = !result ? 'Waiting for result' : result.handedOver ? 'Earlier result returned; this request did not run' : result.refusedLocally ? 'Not sent' : result.readUnavailable ? 'Observation unavailable' : !result.authoritative ? 'Outcome unknown' : result.accepted === false ? 'Rejected' : result.accepted === true ? 'Accepted' : 'Result returned'
  const snapshot = (name, value) => value ? '<div class="call-part"><b>' + name + '</b>' + (value.truncated ? '<p>Display truncated · ' + esc(value.totalBytes) + ' bytes in the original result. This preview is incomplete.</p>' : '') + '<pre>' + esc(value.text) + '</pre></div>' : ''
  // A call is one line of activity — what was asked for, and how it ended — that opens onto
  // the request and the result it actually carried. The status word is the only place colour
  // is spent, and only when the answer was a refusal.
  const refused = Boolean(result) && (result.accepted === false || result.refusedLocally === true)
  return '<div class="message quiet"><details class="activity tool-call" data-call="' + esc(event.callId) + '"><summary>'
    + '<span class="act-ico">›</span><span class="act-text">' + esc(event.cmd) + '</span><span class="act-more"></span>'
    + '<span class="act-state' + (refused ? ' bad' : '') + '">' + esc(status) + '</span></summary>'
    + '<div class="call-content">' + snapshot('Arguments', event.input) + snapshot('Result', result?.output) + '</div></details></div>'
}

export const localPage = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Rulith</title>
<style>
${localThemeCss}
/* The workbench is a fixed three-column application shell, so it opts out of the shared
   document flow: the page itself never scrolls, only the stream and the two rails do. */
html,body{height:100%}body{overflow:hidden}
.app{display:grid;grid-template-columns:250px minmax(460px,1fr) 330px;height:100vh}.sidebar,.inspector{background:var(--side);min-width:0}.sidebar{border-right:1px solid var(--line);display:flex;flex-direction:column}.inspector{border-left:1px solid var(--line);overflow:auto}.brand{height:58px;padding:17px 18px;display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:.2px}.logo{width:14px;height:14px;border-radius:4px;background:var(--brand);flex:none}.mode{font-size:var(--fs-4);color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:2px 8px;margin-left:auto}.new{margin:6px 12px 16px;width:calc(100% - 24px);border:1px solid var(--line2);background:var(--panel);border-radius:8px;padding:9px 12px;text-align:left}.new:hover{background:var(--panel2);border-color:var(--faint)}.side-title{padding:0 16px 7px;color:var(--faint);font-size:var(--fs-4);text-transform:uppercase;letter-spacing:.8px}.cases{overflow:auto;flex:1;padding:0 8px}.case{padding:9px 10px;border-radius:8px;margin:2px 0;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.case:hover{background:var(--panel2);color:var(--fg)}.case.active{background:var(--panel2);color:var(--fg);box-shadow:inset 2px 0 0 var(--accent)}.case small{display:block;color:var(--faint);font-size:var(--fs-4)}.side-foot{border-top:1px solid var(--line);padding:10px 12px}.side-foot .manager-return{display:flex;justify-content:center;margin:2px 0 10px}.runtimeid{display:flex;align-items:center;gap:9px;padding:8px;margin-bottom:5px}.avatar{width:26px;height:26px;flex:0 0 26px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,var(--brand),var(--accent));color:var(--btn-ink);font-weight:700;font-size:var(--fs-4)}.runtimecopy{min-width:0}.runtimecopy b,.runtimecopy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.runtimecopy b{font-size:var(--fs-4)}.runtimecopy small{font-size:11px;color:var(--dim)}.statusline{display:flex;align-items:center;gap:8px;padding:4px 8px;color:var(--dim);font-size:var(--fs-4)}.dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}.dot.on{background:var(--green)}
.main{min-width:0;min-height:0;height:100vh;overflow:hidden;display:flex;flex-direction:column}.top{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 22px;gap:10px}
/* Without this the header's title block refuses to shrink below its own text, the header
   becomes wider than the window, and — because the shell never scrolls horizontally — the
   conversation is silently cut off at the right edge on a narrow screen. */
.top>div{min-width:0}.title{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{color:var(--dim);font-size:var(--fs-4)}.spacer{flex:1}.views{align-self:stretch;display:flex;align-items:flex-end;gap:15px;margin-left:18px}.viewtab{height:38px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--dim);padding:0 2px}.viewtab:hover{color:var(--fg)}.viewtab.active{color:var(--fg);border-bottom-color:var(--accent)}.ghost{border:1px solid var(--line2);background:transparent;border-radius:8px;padding:6px 12px;color:var(--dim);font-size:var(--fs-4);white-space:nowrap}.ghost:hover{color:var(--fg);border-color:var(--faint)}.mobile-settings{display:none}.stream{flex:1;min-height:0;overflow:auto;padding:26px max(24px,calc((100% - 790px)/2)) 130px;overscroll-behavior:contain;scrollbar-gutter:stable}.empty{max-width:640px;margin:16vh auto 0;text-align:center;color:var(--dim)}.empty h1{color:var(--fg);font-size:26px;margin:0 0 10px}.message{max-width:780px;margin:0 auto 18px}.user{display:flex;justify-content:flex-end}.bubble{max-width:78%;background:var(--panel2);border:1px solid var(--line);border-radius:14px 14px 4px 14px;padding:10px 14px;white-space:pre-wrap}.agent-text{white-space:normal;color:var(--fg)}.meta{font-size:var(--fs-4);color:var(--faint);margin-bottom:5px}/* A conversation is prose with things that happened alongside it, and almost all of those
   things are routine: a Case opened, a turn finished, a lease taken. Giving each of them a
   bordered panel made the transcript a stack of boxes in which the one that mattered looked
   exactly like the nine that did not. So the ordinary event is a line of text — an icon
   column, what happened, when — and weight is spent only where something is wrong, waiting,
   or needs a person. Nothing is dropped: a line with more to say opens in place. */
/* Pulled left by its own padding so the icon column starts on the same margin as the prose:
   the hover surface has room, and the transcript still reads as one column of text. */
.note,.activity>summary{display:flex;align-items:baseline;gap:8px;margin-left:-8px;padding:4px 8px;border-radius:8px;color:var(--dim);font-size:var(--fs-4);line-height:1.65}
.note:hover,.activity>summary:hover{background:var(--panel2);color:var(--fg)}
.activity{margin:0;border:0;background:transparent}
.activity>summary{cursor:pointer;list-style:none}
.activity>summary::-webkit-details-marker{display:none}
.activity[open]>summary{color:var(--fg)}
.act-ico{flex:none;width:13px;text-align:center;color:var(--faint)}
.act-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-more{flex:none;color:var(--faint);font-size:11px}
.act-more::before{content:'▸'}
.activity[open] .act-more::before{content:'▾'}
.act-state{margin-left:auto;flex:none;color:var(--faint);white-space:nowrap}
.act-state.bad{color:var(--red)}
/* Evidence stays one click away and reads as what was sent and what came back, indented
   under the line it belongs to rather than boxed off from it. */
.call-content{margin:0 0 10px;padding:2px 8px 0 21px}
.call-part{padding-top:8px}
.call-part b{display:block;color:var(--faint);font-size:11px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:5px}
.call-part p{color:var(--amber);margin:0 0 6px}
/* Wrong, waiting, or needing a person. One accent and a tint — enough to find at a glance in
   a column of quiet lines, without being the same box every routine event used to get. */
.alert{border-left:2px solid var(--line2);background:var(--panel);border-radius:0 8px 8px 0;padding:9px 13px;color:var(--dim);font-size:var(--fs-4)}
.alert b{display:flex;gap:10px;align-items:baseline;color:var(--fg);font-size:var(--fs-3);font-weight:650}
.alert b .right{margin-left:auto;color:var(--faint);font-size:var(--fs-4);font-weight:400;white-space:nowrap}
.alert-body{margin-top:4px;white-space:pre-wrap;overflow:auto;max-height:230px}
.alert.bad{border-left-color:var(--red);background:rgb(247 123 134/7%)}
.alert.wait{border-left-color:var(--amber);background:rgb(237 182 66/7%)}
.composer{position:absolute;left:250px;right:330px;bottom:0;padding:14px 24px 20px;background:linear-gradient(transparent,var(--bg) 25%);display:flex;justify-content:center}.composebox{position:relative;width:min(790px,100%);background:var(--panel);border:1px solid var(--line2);border-radius:14px;padding:11px 12px;box-shadow:0 12px 35px rgb(0 0 0/28%)}.composebox>textarea{display:block;width:100%;resize:none;min-height:30px;max-height:150px;border:0;outline:0;border-radius:0;padding:0;font:inherit;background:transparent}.composebar{display:flex;align-items:center;gap:7px;margin-top:8px}.roundbtn{flex:0 0 30px;width:30px;height:30px;padding:0;border:1px solid var(--line2);border-radius:50%;background:transparent;color:var(--dim);font-size:18px;line-height:1}.roundbtn:hover{color:var(--fg)}.toolbarbadge,.modelbadge{height:30px;display:inline-flex;align-items:center;min-width:0;border:0;padding:0;background:transparent;color:var(--dim);font-size:var(--fs-4)}.modelbadge{max-width:185px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px}.modelbadge:hover{color:var(--fg)}.case-pop[hidden]{display:none}.case-pop{position:absolute;left:8px;bottom:54px;width:min(410px,calc(100% - 16px));z-index:3;background:var(--panel);border:1px solid var(--line2);border-radius:10px;padding:14px;box-shadow:0 15px 44px rgb(0 0 0/45%)}.case-pop label{display:block;color:var(--dim);font-size:var(--fs-4);margin:0 0 10px}.case-pop label:last-child{margin-bottom:0}.case-pop input{display:block;width:100%;margin-top:4px;background:var(--field);border:1px solid var(--line2);border-radius:7px;padding:8px}.send{margin-left:auto;flex:0 0 32px;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:var(--btn-fg);color:var(--btn-ink);font-weight:800}.send:hover{filter:brightness(.94)}.send:disabled{opacity:.35}.worker-only .composer{display:none}.worker-only .stream{padding-bottom:24px}
.inspect-head{height:58px;border-bottom:1px solid var(--line);padding:18px 16px;font-weight:650}.section{padding:16px}.section+.section{border-top:1px solid var(--line)}.section h3{font-size:var(--fs-4);text-transform:uppercase;letter-spacing:.75px;color:var(--faint);margin:0 0 10px}.frontier,.workers{display:grid;gap:7px}.item{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 10px;color:var(--dim);font-size:var(--fs-4);overflow-wrap:anywhere}.item small{display:block;color:var(--faint);margin-top:3px}.settingsopen{width:100%;border:1px solid var(--line2);background:var(--panel);border-radius:8px;padding:9px 11px;text-align:left}.settingsopen:hover{background:var(--panel2);border-color:var(--faint)}.sidelink{display:block;margin-top:8px;color:var(--accent);font-size:var(--fs-4);text-decoration:none}.sidelink:hover{text-decoration:underline}.settingsopen.sidelink{color:var(--fg);font-size:var(--fs-3)}.modal[hidden]{display:none}.modal{position:fixed;inset:0;z-index:50;background:rgb(0 0 0/55%);display:grid;grid-template-columns:minmax(0,1fr);place-items:center;padding:24px}.modal-card{width:min(820px,96vw);max-width:100%;max-height:88vh;overflow:auto;background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);box-shadow:0 18px 48px rgb(0 0 0/55%)}.modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:16px 18px;background:var(--panel);border-bottom:1px solid var(--line)}.modal-head b{font-size:var(--fs-1)}.modal .sub{display:block}.modal-head .sub{display:block;margin-top:4px}.modal-close{margin-left:auto;flex:none;width:32px;height:32px;padding:0;border:1px solid var(--line2);background:transparent;border-radius:8px}.runtimegrid{display:grid;grid-template-columns:1fr 1fr}.runtimepane{padding:18px}.runtimepane+.runtimepane{border-left:1px solid var(--line)}.runtimepane h3{margin:0 0 10px}.runtimepane code{color:var(--fg)}.runtimepane .kv>span{flex:none}.runtimepane .kv b{min-width:0}.runtimecontrols{display:flex;gap:8px;margin-top:14px}.runtimecontrols button{padding:7px 12px;color:var(--fg)}.runtimefoot{padding:14px 18px;border-top:1px solid var(--line);color:var(--dim);font-size:var(--fs-4)}.runtimefoot code{color:var(--fg)}.runtimefoot .manager-return{display:flex;width:max-content;margin:12px 0 0}
@media(max-width:1050px){.app{grid-template-columns:220px minmax(420px,1fr)}.inspector{display:none}.composer{left:220px;right:0}}@media(max-width:720px){.app{display:block}.sidebar{display:none}.main{height:100vh}.composer{left:0;padding:10px 14px 16px}.top{height:auto;min-height:52px;padding:8px 14px;gap:8px}.sub{display:none}.stream{padding-left:16px;padding-right:16px}.mobile-settings{display:inline-block}.runtimegrid{grid-template-columns:1fr}.runtimepane+.runtimepane{border-left:0;border-top:1px solid var(--line)}.views{margin-left:6px;gap:12px;align-items:center}.viewtab{height:32px}.sessionlog{display:none}.composebar{gap:6px}.toolbarbadge,.modelbadge{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.agent-text p{margin:0 0 14px}.agent-text h1,.agent-text h2,.agent-text h3{margin:20px 0 10px;font-size:1.2em}.agent-text ul,.agent-text ol{padding-left:24px}.agent-text li{margin:5px 0}.agent-text a{color:var(--accent)}.agent-text blockquote{border-left:3px solid var(--line2);padding-left:15px;margin-left:0;color:var(--dim)}.agent-text code{background:var(--field);border:1px solid var(--line);border-radius:4px;padding:1px 5px}.agent-text pre,.call-part pre{overflow:auto;white-space:pre;max-height:380px;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:12px;font:var(--fs-4)/1.6 var(--mono)}.markdown-table{overflow:auto;margin:14px 0}.markdown-table table{border-collapse:collapse;min-width:100%}.markdown-table th,.markdown-table td{border:1px solid var(--line);padding:8px 12px;text-align:left;min-width:100px;vertical-align:top}.markdown-table th{background:var(--panel2);color:var(--fg)}.message.quiet{margin-bottom:0}
.message.quiet+.message:not(.quiet){margin-top:14px}
.agent-text pre code{background:none;border:0;padding:0}.markdown-table th{white-space:normal}
/* The composer answers in the composer. A browser dialog is not available to this page when
   it is a sandboxed frame — alert() there returns without showing anything — so a refused
   send would be silent exactly where sending is the whole product. */
.composererr{margin:8px 2px 0;color:var(--red);font-size:var(--fs-4);white-space:pre-wrap}
.composererr:empty{display:none}
/* A header that cannot wrap is a header whose last buttons leave the window: .main never
   scrolls sideways, so Clear view and Runtime details simply stop existing. */
.top{flex-wrap:wrap;row-gap:6px;height:auto;min-height:58px}
/* Embedded in the Rulith workbench. The surrounding page already shows which Agent this is,
   which other Agents there are, and what its Worker is doing, so the two rails here would be
   a second copy of both. They are not deleted — the conversation list and the Case evidence
   are the same elements, moved into dialogs the centre can open — because every one of their
   behaviours (switching conversation, starting a new one, the live Case roots, the frontier,
   the unresolved call) is expected to keep working exactly as it does standalone. */
.app.embedded .top{height:auto;min-height:56px;padding:8px 14px}
.app.embedded{display:grid;grid-template-columns:minmax(0,1fr) 330px}.app.embedded .sidebar{display:none}.app.embedded .inspector{display:block}.app.embedded .composer{left:0;right:330px}
/* Only when the frame itself is too narrow to hold both does the inspector fold away, and its
   sections move into the Evidence dialog — the same nodes, so the same live rendering keeps
   writing to them — and move back when there is room again. */
@media(max-width:900px){.app.embedded{grid-template-columns:minmax(0,1fr)}.app.embedded .inspector{display:none}.app.embedded .composer{right:0}}
/* Files a person adds to a message are materials: bytes this computer keeps, named by a local
   material id. A chip therefore says the filename and how far along it is, and nothing else —
   the digest and the byte count are the material service's business, not something a reader
   has to carry. Nothing here is an attestation about the file, and nothing here clears it for
   any use: it is a file that was added, and the Agent's authorized tools are what read it. */
.attach{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.attach[hidden]{display:none}
.chip{display:flex;align-items:center;gap:8px;max-width:100%;background:var(--panel2);border:1px solid var(--line2);border-radius:99px;padding:4px 6px 4px 12px;font-size:var(--fs-4)}
.chip-name{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip-state{color:var(--faint)}
.chip.bad{border-color:var(--red)}.chip.bad .chip-state{color:var(--red)}
.chip-drop{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dim);line-height:1}
.chip-drop:hover{background:var(--panel);color:var(--fg)}
.attachnote{display:block;margin:0 2px 8px;color:var(--faint);font-size:11px}
.attachnote[hidden]{display:none}
.attachsent{margin:6px 2px 0;color:var(--faint);font-size:var(--fs-4)}
.attachsent:empty{display:none}
.attach-menu[hidden]{display:none}
.attach-menu{position:absolute;left:8px;bottom:54px;width:min(300px,calc(100% - 16px));z-index:3;background:var(--panel);border:1px solid var(--line2);border-radius:10px;padding:6px;box-shadow:0 15px 44px rgb(0 0 0/45%)}
.attach-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:8px;padding:9px 11px;color:var(--fg)}
.attach-menu button:hover{background:var(--panel2)}
.attach-menu small{display:block;color:var(--faint);font-size:11px}
/* Case preferences are still here and still work; they are simply not what the control is for
   most of the time, so they read as the advanced option they are. */
.attach-menu .advanced{margin-top:4px;padding-top:9px;border-top:1px solid var(--line);border-radius:0 0 8px 8px;color:var(--dim);font-size:var(--fs-4)}
.composer.dragging .composebox{border-color:var(--accent)}
.dropzone{border:1px dashed var(--line2);border-radius:var(--radius);padding:18px;text-align:center;color:var(--dim)}
.dropzone.dragging{border-color:var(--accent);background:var(--panel2)}
.dropzone small{display:block;margin-top:6px;color:var(--faint);font-size:11px}
.filesnote{margin:10px 2px 0;color:var(--red);font-size:var(--fs-4)}
.filesnote:empty{display:none}
.filesbody .attach{margin:14px 0 0}
.bubble-files{margin-top:6px;color:var(--faint);font-size:var(--fs-4)}
#historybar:not([hidden]){display:block;padding:8px 20px}#historybar button{margin:2px 4px 2px 0}.exportnote{padding:8px 20px;color:var(--dim);font-size:12px}#composertarget{display:block;color:var(--dim);margin:0 8px 6px}#composertarget[hidden]{display:none}@media(max-width:720px){#convopen.embedded-only{display:inline-block}}.runtimecontrols[hidden]{display:none}.embedded-only{display:none}.app.embedded .embedded-only{display:inline-block}.panelmodal .modal-card{width:min(560px,96vw)}.panelbody{padding:14px 16px}.panelbody .new{width:100%;margin:0 0 12px}.panelbody .cases{padding:0;max-height:56vh;overflow:auto}.panelbody .case{white-space:normal}.panelbody .section{padding:14px 0}.panelbody .section:first-child{padding-top:0;border-top:0}
</style></head><body><div class="app" id="app">
<aside class="sidebar"><div class="brand"><span class="logo"></span>Rulith<span class="mode" id="mode">…</span></div><button class="new" id="newcase">＋ New conversation</button><div class="side-title">Activity</div><div class="cases" id="cases"><div class="case active" data-case="">All activity</div></div><div class="side-foot" id="sidefoot"><div class="runtimeid"><span class="avatar">A</span><span class="runtimecopy"><b id="agentname">Configured Agent</b><small id="agentidentity">loading…</small></span></div><button class="settingsopen" id="runtimeopen">◎ Runtime details</button><div class="statusline"><span class="dot" id="agentdot"></span>Agent <span id="agentstate">off</span></div><div class="statusline"><span class="dot" id="workerdot"></span>Worker <span id="workerstate">off</span></div></div></aside>
<main class="main"><header class="top"><div><div class="title" id="title">Local activity</div><div class="sub" id="subtitle">Conversation with optional Rulith Case tools</div></div><nav class="views" aria-label="Activity view"><button class="viewtab active" data-view="case">Conversation</button><button class="viewtab" data-view="trace">Trace</button></nav><span class="spacer"></span><button class="ghost embedded-only" id="convopen" aria-haspopup="dialog">Conversations</button><button class="ghost" id="evidenceopen" aria-haspopup="dialog" hidden>Evidence</button><button class="ghost sessionlog" id="exportlog" title="Download loaded events in this view; not a complete history or Case proof">Export view ↓</button><button class="ghost mobile-settings" id="mobileruntime" title="Runtime details">◎</button><button class="ghost" id="clear">Clear view</button></header><div id="exportnote" class="exportnote" role="status" hidden></div><div id="connectionnotice" class="sub" role="status" hidden></div><div id="historybar" class="sub" hidden><button class="ghost" id="loadolder" hidden>Load earlier messages</button><button class="ghost" id="archivehistory">Archive conversation</button><span id="historystate"></span><button class="ghost" id="historyconsent" hidden>Use this model for earlier messages</button><button class="ghost" id="newattempt" hidden>Send as a new message</button></div><div class="stream" id="stream"><div class="empty" id="empty"><h1>What would you like to discuss or handle?</h1><p>Chat normally. The Agent will use Rulith when governed work, evidence, or an auditable Case is useful.</p></div></div></main>
<aside class="inspector" id="inspector" tabindex="-1" aria-label="Rulith Cases"><div class="inspect-head">Rulith Cases</div><section class="section"><h3>Cases in focus</h3><div class="kv"><span>Acceptance roots</span><b id="casecount">Not in use</b></div><div class="frontier" id="roots"><div class="item">Rulith has not been used for this conversation.</div></div></section><section class="section"><h3>Unresolved call</h3><div class="frontier" id="recovery"><div class="item">No unresolved call</div></div></section><section class="section"><h3>Current frontier</h3><div class="frontier" id="frontier"><div class="item">Rulith has not been used for this conversation.</div></div></section><section class="section"><h3>Worker activity</h3><div class="workers" id="workers"><div class="item">No Worker activity for this conversation.</div></div></section></aside>
<form class="composer" id="composer"><div class="composebox"><div class="attach" id="attachlist" hidden aria-live="polite" aria-label="Files added to this message"></div><small class="attachnote" id="attachnote" hidden>Files are kept on this computer. Reading them requires the Agent’s authorized tools. Content sent to your selected model follows its data permissions.</small><small id="composertarget" hidden></small><textarea id="prompt" placeholder="Message the Agent…" rows="1"></textarea><p class="composererr" id="composererr" role="alert" aria-live="assertive"></p><p class="attachsent" id="attachsent" role="status"></p><div class="case-pop" id="casepopover" hidden><label>Preferred Case Type if Rulith is used<input id="casetype" value="" placeholder="Automatic" aria-label="Case Type"></label><label>Business key JSON (optional)<input id="businesskey" placeholder='{"job_id":"..."}' aria-label="Business key JSON"></label></div><div class="attach-menu" id="attachmenu" role="menu" aria-label="Add to this message" hidden><button type="button" id="attachfiles" role="menuitem">Add files<small>Up to 8 files, 8 MiB each</small></button><button type="button" class="advanced" id="attachprefs" role="menuitem">Advanced · Case preferences</button></div><input type="file" id="fileinput" multiple hidden aria-hidden="true" tabindex="-1"><div class="composebar"><button type="button" class="roundbtn" id="caseoptions" title="Add files" aria-label="Add files or Case preferences" aria-haspopup="menu" aria-expanded="false">＋</button><span class="toolbarbadge" id="toolbadge">Rulith available</span><button type="button" class="modelbadge" id="modelbadge" title="Runtime details">Model</button><span class="toolbarbadge" id="thinkingbadge">Provider default</span><button class="send" id="send" title="Send message">↑</button></div></div></form>
</div><div class="modal" id="runtimemodal" role="dialog" aria-modal="true" aria-labelledby="runtimetitle" hidden><div class="modal-card"><div class="modal-head"><div><b id="runtimetitle">Runtime details</b><span class="sub">Read-only projection of the single-Agent Runtime configuration. Edit the configuration file or secret manager, then restart the process.</span></div><button class="modal-close" id="runtimeclose" aria-label="Close Runtime details">×</button></div><div class="runtimegrid"><section class="runtimepane"><h3>Agent</h3><div class="kv"><span>Cloud Agent</span><b id="detailagent">—</b></div><div class="kv"><span>Credential</span><b id="detailagentkey">—</b></div><div class="kv"><span>Model service</span><b><code id="detailmodelurl">—</code></b></div><div class="kv"><span>Model</span><b id="detailmodel">—</b></div><div class="kv"><span>Model key</span><b id="detailmodelkey">—</b></div><div class="kv"><span>Reasoning</span><b id="detailthinking">—</b></div><div class="kv"><span>Case calls</span><b id="detailconcurrency">—</b></div><div class="runtimecontrols"><button data-control="agent" data-operation="stop">Stop Agent</button><button data-control="agent" data-operation="start">Start Agent</button></div></section><section class="runtimepane"><h3>Worker</h3><div class="kv"><span>Connection</span><b id="detailconnection">—</b></div><div class="kv"><span>Credential</span><b id="detailworkerkey">—</b></div><div class="kv"><span>Workspace tools</span><b id="detailtools">—</b></div><div class="kv"><span>Tool manifest</span><b><code id="detailtoolsfile">—</code></b></div><div class="kv"><span>Source vault</span><b><code id="detailsourcesfile">—</code></b></div><div class="runtimecontrols"><button data-control="worker" data-operation="stop">Stop Worker</button><button data-control="worker" data-operation="start">Start Worker</button></div></section></div><div class="runtimefoot">Configuration: <code id="detailconfig">—</code><div id="runtimemsg"></div></div></div></div>
<div class="modal panelmodal" id="convmodal" role="dialog" aria-modal="true" aria-labelledby="convtitle" hidden><div class="modal-card"><div class="modal-head"><div><b id="convtitle">Conversations</b><span class="sub">Conversations available on this computer.</span></div><button class="modal-close" id="convclose" aria-label="Close conversations">×</button></div><div class="panelbody" id="convbody"><div><button class="ghost" id="historyactive">Active</button><button class="ghost" id="historyarchived">Archived</button><button class="ghost" id="historymore" hidden>More conversations</button></div><p id="historynotice" class="sub" role="status"></p><button class="ghost" id="exportviewmobile">Export loaded view ↓</button></div></div></div>
<div class="modal panelmodal" id="filesmodal" role="dialog" aria-modal="true" aria-labelledby="filestitle" hidden><div class="modal-card"><div class="modal-head"><div><b id="filestitle">Add files</b><span class="sub">Files are kept on this computer. Reading them requires the Agent’s authorized tools. Content sent to your selected model follows its data permissions.</span></div><button class="modal-close" id="filesclose" aria-label="Close Add files">×</button></div><div class="panelbody filesbody"><div class="dropzone" id="filesdrop">Drop files here, or <button type="button" class="ghost" id="filespick">Choose files</button><small>Up to 8 files, 8 MiB each. Files added here go with your next message.</small></div><div class="attach" id="fileslist" aria-live="polite" aria-label="Files added to this message"></div><p class="filesnote" id="filesnote" role="alert"></p></div></div></div>
<div class="modal panelmodal" id="evidencemodal" role="dialog" aria-modal="true" aria-labelledby="evidencetitle" hidden><div class="modal-card"><div class="modal-head"><div><b id="evidencetitle">Case evidence</b><span class="sub">What this conversation is working on the Board, as the Agent observed it.</span></div><button class="modal-close" id="evidenceclose" aria-label="Close Case evidence">×</button></div><div class="panelbody" id="evidencebody"></div></div></div>
<script>
${projectCaseRoots.toString()}
${projectRecovery.toString()}
${renderMarkdown.toString()}
${renderToolCall.toString()}
${managerReturnHref.toString()}
const K=new URLSearchParams(location.search).get('k')||'', $=(id)=>document.getElementById(id)
/* Embedded means this page is the conversation inside the Rulith workbench rather than a
   window of its own. It changes presentation only: no state, no route and no behaviour here
   depends on the surrounding page. Only a bounded readiness receipt crosses its origin. */
const EMBEDDED=new URLSearchParams(location.search).get('embedded')==='1'
const state={status:null,events:[],cases:new Map(),active:'',view:'case',session:'',fresh:false,lastCases:'',lastStream:'',lastRoots:'',lastRecovery:'',lastFrontier:'',lastWorkers:''}
const history={available:false,items:[],archived:false,offset:0,before:null,selectedArchived:false,request:0,listRequest:0,confirmedFor:'',expectedModel:'',caseBase:'',busy:false}
async function historyList(more=false){
  const filter=history.archived,offset=more?history.items.length:0,request=++history.listRequest
  if(!history.available)$('historynotice').textContent='Loading conversations…'
  try{const r=await fetch('/conversations?k='+encodeURIComponent(K)+'&archived='+filter+'&offset='+offset).then(x=>x.json());if(filter!==history.archived||request!==history.listRequest)return
    if(!r.ok)throw new Error(r.teaching||'Conversation history could not be read.')
    if(!r.available){history.available=false;$('historynotice').textContent='Saved conversation history is available after connecting an account and Agent.';return}
    history.available=true;history.items=more?[...history.items,...r.items]:r.items;history.offset=offset
    $('historymore').hidden=!r.hasMore;$('historynotice').textContent=r.total+' '+(filter?'archived':'active')+' conversation(s). Archiving keeps the conversation and does not cancel any Case.'
    state.lastCases='';renderCases()
  }catch(e){if(request===history.listRequest)$('historynotice').textContent=e.message}
}
function mergeEvent(e){
  if(e.src==='local'&&e.type==='runtime-recovery'&&!e.historical){state.runtimeRecovery=e.recovery;return}
  const at=e.historyKey?state.events.findIndex(x=>x.historyKey===e.historyKey):-1
  if(at>=0){if(!state.events[at].historical&&e.historical)return;state.events[at]=e}
  else if(!e.sequence||!state.events.some(x=>x.sequence===e.sequence&&x.t===e.t))state.events.push(e)
  else return
  // Recovery belongs to this Agent process, not the selected transcript. Clearing
  // or loading conversation history must not erase or resurrect an unresolved call.
  if(!e.historical)state.runtimeRecovery=projectRecovery([e],state.runtimeRecovery)
  remember(e)
}
function historyControls(){
  const retry=pendingSends.get(draftOwner())?.interrupted===true
  $('newattempt').hidden=!retry
  $('historybar').hidden=(state.fresh||!state.active)&&!history.selectedArchived&&!retry&&!(history.expectedModel&&history.confirmedFor!==history.expectedModel)
  $('loadolder').hidden=!history.before
  $('archivehistory').hidden=!history.available
  $('archivehistory').disabled=history.busy
  $('archivehistory').textContent=history.selectedArchived?'Restore conversation':'Archive conversation'
  $('historystate').textContent=history.selectedArchived?'Archived. Restore before sending.':history.expectedModel&&history.confirmedFor!==history.expectedModel?'Earlier messages will be sent to '+history.expectedModel+'. Files require current access.':''
  $('historyconsent').hidden=!history.expectedModel||history.confirmedFor===history.expectedModel
}
async function readHistory(key,older=false){
  const request=++history.request
  if(!key){history.before=null;historyControls();return}
  try{const r=await fetch('/conversation?k='+encodeURIComponent(K)+'&sessionKey='+encodeURIComponent(key)+(older&&history.before?'&before='+encodeURIComponent(history.before):'')).then(x=>x.json());if(request!==history.request||key!==state.active)return
    if(!r.ok)throw new Error(r.teaching||'Conversation history could not be read.')
    if(!r.available)return
    history.before=r.before;history.selectedArchived=r.archived;history.caseBase=r.caseBase||''
    const current=String(state.status?.runtime?.agent?.modelService||'').replace(/\\/+$/,'').toLowerCase()
    history.expectedModel=r.modelServices?.some(v=>v!==current)?current:''
    for(const e of r.events||[])mergeEvent(e)
    state.events.sort((a,b)=>(a.t||a.at||0)-(b.t||b.at||0));render(!older);historyControls()
  }catch(e){if(request===history.request){$('historystate').textContent=e.message;$('historybar').hidden=false}}
}
async function selectConversation(key){
  saveComposer();$('exportnote').hidden=true;state.fresh=false;state.active=key;if(key)state.session=key
  restoreComposer()
  history.before=null;if(key||!state.session){history.expectedModel='';history.confirmedFor='';history.selectedArchived=false}
  showNotes();renderAttachments();render(true);closeModal('convmodal');await readHistory(key)
}

const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const caseOf=(e)=>e.type==='start'?'':String(e.session||e.sessionKey||e.caseId||e.task||(e.type&&e.type.startsWith('task-')?e.id:'')||'')
const timeOf=(e)=>new Date(e.at||e.t||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
function remember(e){const id=caseOf(e);if(!id)return;const prior=state.cases.get(id)||{id,title:id,status:'Ready',caseId:'',roots:0};if(e.text)prior.title=String(e.text).slice(0,70);if(e.type==='task-start'&&prior.status==='Waiting')prior.status=prior.caseId?'Case active':'Ready';if(e.type==='case-state'){prior.caseId=e.caseId||prior.caseId;if(e.caseStatus==='closed'){prior.status='Ready';prior.caseId=''}else if(e.caseStatus==='paused')prior.status='Case paused';else if(e.caseStatus==='unavailable')prior.status='Case state unavailable';else if(e.caseStatus==='running')prior.status='Case active'}if(e.type==='focus'){const rs=Array.isArray(e.roots)?e.roots:[];prior.roots=rs.length;if(rs.length===0){if(prior.status!=='Detached'&&prior.status!=='Waiting'){prior.status='Ready';prior.caseId=''}}else prior.caseId=String(rs[0].caseId||prior.caseId)}if(e.type==='case-unfocused'&&prior.caseId===e.caseId){prior.caseId='';if(prior.status!=='Detached'&&prior.status!=='Waiting')prior.status='Ready'}if(e.type==='case-open'&&e.ok!==false){prior.status='Case active';prior.caseId=e.caseId||''}if(e.type==='case-pending'){prior.status='Waiting';prior.caseId=e.caseId||prior.caseId}if(e.type==='session-detached'){prior.status='Detached';prior.caseId=e.caseId||prior.caseId}if(e.type==='case-closed'){prior.status='Ready';prior.caseId=''}if(e.type==='task-done'&&['interrupted','not-started'].includes(e.outcome)){prior.status='Interrupted';prior.caseId=''}else if(e.type==='task-done'&&e.activeCaseId){if(prior.caseId!==e.activeCaseId)prior.status='Case active';prior.caseId=e.activeCaseId}else if(e.type==='task-done'&&!prior.caseId)prior.status='Ready';state.cases.set(id,prior)}
function renderCases(){
 const root=$('cases'),oldTop=root.scrollTop
 let html='<div class="case '+(state.active===''&&!state.fresh?'active':'')+'" data-case="">All activity</div>'
 if(!history.archived)for(const [key,draft] of drafts)if(key.startsWith('new:')&&(draft.text?.trim()||draft.rows.length||draft.caseType||draft.businessKey))html+='<div class="case '+(state.fresh&&newDraftKey===key?'active':'')+'" data-draft="'+esc(key)+'"><span>'+esc(draft.text?.trim().slice(0,70)||draft.rows[0]?.name||'New conversation')+'</span><small>Unsent draft</small></div>'
 const rows=history.available?history.items.map(c=>({id:c.sessionKey,title:c.title,status:c.archived?'Archived':c.state==='interrupted'?'Interrupted':'Saved'})):[...state.cases.values()].reverse()
 for(const c of rows)html+='<div class="case '+(state.active===c.id?'active':'')+'" data-case="'+esc(c.id)+'"><span>'+esc(c.title)+'</span><small>'+esc(c.status)+'</small></div>'
 if(html===state.lastCases)return
 root.innerHTML=html;state.lastCases=html;root.scrollTop=oldTop
 root.querySelectorAll('[data-case]').forEach(n=>n.onclick=()=>selectConversation(n.dataset.case))
 root.querySelectorAll('[data-draft]').forEach(n=>n.onclick=()=>selectDraft(n.dataset.draft))
}
function eventBody(e){if(e.type==='model-usage'||e.type==='model-summary')return (e.calls?e.calls+' model call(s) · ':'')+(Number(e.durationMs||0)/1000).toFixed(2)+' s · '+(e.inputTokens===null||e.outputTokens===null?'Token usage not reported':e.inputTokens+' input / '+e.outputTokens+' output tokens reported')+(e.unknownUsageCalls?' · '+e.unknownUsageCalls+' call(s) without complete token counts':'');if(e.type==='tool-timing')return e.tool+' · '+(Number(e.durationMs||0)/1000).toFixed(2)+' s'+(e.outcome==='failed'?' · adapter failed':'');if(e.type==='tool-call')return e.input?.text||'';if(e.type==='tool-result')return e.output?.text||'';if(e.type==='case-state')return 'Case lifecycle: '+(e.caseStatus||'unavailable')+(e.root?' · root '+e.root:'')+(typeof e.gaps==='number'?' · '+e.gaps+' open gap(s)':'');if(e.type==='focus')return (e.roots||[]).length?'In focus: '+(e.roots||[]).map((r)=>r.caseId+' ('+r.status+')').join(' · '):'No Case is in focus.';if(e.type==='case-unfocused')return 'Released from this conversation\\'s focus. Its lifecycle on the Board is unchanged.';if(e.type==='affected')return (e.affectedCases||[]).length?'Affected Cases: '+e.affectedCases.join(' · '):'No live acceptance root advanced.';if(e.type==='recovery')return projectRecovery([{...e,src:'agent'}]).label;if(e.type==='operation-read')return e.state==='unavailable'?'The earlier '+(e.tool||'pure read')+' content could not be disclosed; no original result was supplied.':'The public result of an earlier '+(e.tool||'tool')+' call was read for the model.';if(e.type==='handoff')return 'The outcome of an earlier '+(e.tool||'tool')+' call was handed to the model. That request executed nothing.';if(e.type==='blocked')return e.teaching||'This turn stopped without asking the model.';if(e.type==='queue-suspended')return e.notSent+' further call(s) proposed in that turn were not sent: an earlier call had an unknown outcome.';if(e.type==='artifact-read')return 'Artifact '+(e.ref||'')+' · '+(e.complete?'final fragment':'fragment')+(e.truncated?' · truncated at the read limit':'')+(e.mediaType?' · '+e.mediaType:'');if(e.type==='worker-activity-unavailable')return e.note||'This Runtime cannot yet report a dispatched invocation: the Agent Profile result has no published field carrying it. Follow the Action in Console.';if(e.type==='loss')return 'Bounded view: '+(e.omitted===undefined?'rows were':e.omitted+' row(s) were')+' omitted ('+(e.reason||'limit')+'). This answer is partial.';if(e.type==='propose')return e.say||JSON.stringify(e.tool||e.cmds||e.ops||{},null,2);if(e.type==='verdict')return e.accepted?'Accepted by Board'+(e.cmd?' · '+e.cmd:''):(e.teaching||'Rejected by Board');if(e.type==='source-plan')return (e.plans||[]).map((p)=>p.action+' via '+p.source+' → '+p.predicate).join('\\n');if(e.type==='claimed')return (e.kind||'work')+' · '+(e.id||'claimed');if(e.type==='reported')return (e.kind||'work')+' · '+(e.id||'')+' · '+(e.landed?'receipt committed':'receipt not committed')+(e.result?'\\n'+e.result:'')+(e.reason?'\\n'+e.reason:'');if(e.type==='case-open')return e.ok===false?'Case could not be opened':'Case Type '+(e.caseType||'exploration');if(e.type==='case-closed')return 'Disposition: '+(e.disposition||'closed');if(e.type==='model-error')return e.teaching||'The model response could not be completed.';if(e.type==='case-pending')return e.reason||e.note||'Waiting for evidence';if(e.type==='session-detached')return e.note||'The local conversation was reclaimed; its Rulith Case remains on the Board.';if(e.type==='log')return e.line||'';return e.note||e.text||''}
/* The words each event gets. A label a person can read is the whole of what most events
   need to contribute; the rest of the transcript is the conversation itself. */
const EVENT_LABELS={'pending-inherited':'Earlier call awaiting recovery','case-state':'Case lifecycle','focus':'Cases in focus','case-unfocused':'Case released from focus','affected':'Affected Cases','loss':'Bounded view','recovery':'Unresolved call','handoff':'Earlier outcome handed over','operation-read':'Original operation read','blocked':'Turn stopped','model-error':'Model response failed','queue-suspended':'Remaining calls not sent','artifact-read':'Artifact fragment read','worker-activity-unavailable':'Invocation reporting unavailable','case-open':'Rulith Case opened','case-closed':'Rulith Case closed','case-pending':'Rulith Case pending','session-detached':'Conversation detached','source-plan':'Source route','verdict':'Board decision','claimed':'Worker claimed','reported':'Worker receipt','task-done':'Agent turn finished','task-start':'Message','task-queued':'Message queued','slot-open':'Capacity available','up':'Runtime online','spawn':'Process started','exit':'Process exited','round':'Agent turn','log':'Runtime log','error':'Runtime error'}
EVENT_LABELS['board-observation-unavailable'] = 'Board observation unavailable'
/* Which events are allowed to raise their voice. A refusal, a stopped turn, a Case waiting on
   evidence and a conversation that was detached are the states a person has to act on; a
   lease, an accepted call and a finished turn are not, however many of them arrive. */
function eventLevel(e){
  if(e.type==='pending-inherited')return 'wait'
  if(e.accepted===false||e.landed===false||e.type==='error'||e.type==='blocked'||e.type==='model-error'||e.type==='recovery-conflict')return 'bad'
  if(e.type==='recovery')return e.state&&e.state!=='none'?'wait':''
  if(e.type==='task-done'&&['interrupted','not-started'].includes(e.outcome))return 'wait'
  if(['case-pending','queue-suspended','session-detached','worker-activity-unavailable','loss'].includes(e.type))return 'wait'
  return ''
}
/* A stable name for a quiet line that can be opened, so that expanding one and then receiving
   another event does not close it again. */
const noteKey=(e)=>'note:'+e.type+':'+(e.at||e.t||'')+':'+(e.callId||e.caseId||e.id||'')
function recoveryActions(rec,link=true){
  if(!rec||rec.state==='none')return ''
  const call=rec.callRef?'<small>Original call: <code>'+esc(rec.callRef)+'</code></small>'
    :'<small>Original call reference unavailable.</small>'
  if(!link)return call
  const binding=state.status?.runtime?.console,agentId=state.status?.runtime?.agent?.id
  if(!binding?.accountId||!agentId||binding.agentId!==agentId||rec.agentId!==agentId
    ||rec.accountId!==binding.accountId)
    return call+'<small>Console destination unavailable until this account and Agent are confirmed.</small>'
  let origin
  try{const url=new URL(binding.origin);if(!['https:','http:'].includes(url.protocol))return call;origin=url.origin}catch{return call}
  const runtime=origin+'/console/#/agents/'+encodeURIComponent(agentId)+'?tab=runtime'
  const caseLink=rec.caseId?'<a class="sidelink" target="_blank" rel="noopener noreferrer" href="'
    +esc(origin+'/console/#/cases/'+encodeURIComponent(agentId)+'/'+encodeURIComponent(rec.caseId))+'">Open original Case in Console</a>':''
  return call+'<a class="sidelink" target="_blank" rel="noopener noreferrer" href="'+esc(runtime)
    +'">Open Agent Runtime in Console</a>'+caseLink
}
/* What a person's message carried, when the event says so.
   Only what the event itself published is shown, and only the filenames: a material id is a
   local handle and the bytes are not in this page at all, so there is nothing here that
   reconstructs what any model was given. An event that names no file, but says a count, says
   the count — inventing a filename would be a claim about a file nobody recorded. */
function attachedFiles(e){
  const rows=Array.isArray(e.attachments)?e.attachments:[]
  if(!rows.length)return ''
  const names=rows.map((row)=>row&&typeof row==='object'?String(row.name||''):'').filter(Boolean)
  return '<div class="bubble-files">'+esc(names.length?'Attached · '+names.join(' · ')
    :rows.length+' file'+(rows.length===1?'':'s')+' attached')+'</div>'
}
function card(e,trace=false){
  const body=e.type==='pending-inherited'?projectRecovery([{...e,src:'agent'}]).detail:eventBody(e)
  if(e.type==='history-cases')return '<div class="message quiet">Historical Cases: '+(e.caseIds||[]).map(id=>'<a target="_blank" rel="noopener noreferrer" href="'+esc(history.caseBase+encodeURIComponent(id))+'">'+esc(id)+'</a>').join(' · ')+'<small> Open Console to read their current state.</small></div>'
  if(!trace&&e.type==='tool-result')return ''
  if(!trace&&e.type==='verdict'&&e.callId)return ''
  if(!trace&&e.type==='tool-call')return renderToolCall(e,state.toolResults?.get(e.callId))
  if(!trace&&['case-state','focus','case-unfocused','affected','spawn','exit','up','log','start','round','task-queued','slot-open'].includes(e.type))return ''
  if(!trace&&(e.type==='task-start'||(e.type==='user'&&!e.interject)))return '<div class="message user"><div class="bubble">'+esc(e.text||'')+attachedFiles(e)+'</div></div>'
  if(!trace&&e.type==='propose'&&e.say)return '<div class="message"><div class="meta">Agent · '+timeOf(e)+'</div><div class="agent-text">'+renderMarkdown(e.say)+'</div></div>'
  const label=e.type==='task-done'&&['interrupted','not-started'].includes(e.outcome)?'Agent turn interrupted':EVENT_LABELS[e.type]||e.type.replaceAll('-',' ')
  const when='<span class="act-state">'+esc(e.src||'')+' · '+timeOf(e)+'</span>'
  const level=eventLevel(e)
  if(level!=='')return '<div class="message"><div class="alert '+level+'"><b>'+esc(label)+'<span class="right">'+esc(e.src||'')+' · '+timeOf(e)+'</span></b>'+(body?'<div class="alert-body">'+esc(body)+'</div>':'')+((e.type==='recovery'||e.type==='pending-inherited')?recoveryActions(projectRecovery([{...e,src:'agent'}]),false):'')+'</div></div>'
  const NL=String.fromCharCode(10),first=String(body||'').split(NL)[0]
  const head='<span class="act-ico">'+(e.src==='worker'?'⚙':'◇')+'</span><span class="act-text">'+esc(label)+(first?' · '+esc(first):'')+'</span>'
  if(!body||(body.length<=110&&body.indexOf(NL)<0))return '<div class="message quiet"><div class="note">'+head+when+'</div></div>'
  return '<div class="message quiet"><details class="activity" data-call="'+esc(noteKey(e))+'"><summary>'+head+'<span class="act-more"></span>'+when+'</summary><div class="call-content"><div class="call-part"><pre>'+esc(body)+'</pre></div></div></details></div>'
}
function renderInspector(filtered){const reversed=[...filtered].reverse();const rows=projectCaseRoots(filtered),rec=state.runtimeRecovery??projectRecovery(filtered),recMarkup='<div class="item">'+esc(rec.label)+(rec.detail?'<small>'+esc(rec.detail)+'</small>':'')+recoveryActions(rec)+'</div>';if(recMarkup!==state.lastRecovery){$('recovery').innerHTML=recMarkup;state.lastRecovery=recMarkup}const inFocus=rows.filter((r)=>r.focused),hasCase=rows.length>0;const countText=!hasCase?'Not in use':inFocus.length+' in focus'+(rows.length>inFocus.length?' · '+(rows.length-inFocus.length)+' released':'');if($('casecount').textContent!==countText)$('casecount').textContent=countText;const rootsMarkup=hasCase?rows.map((r)=>'<div class="item">'+esc(r.caseId)+' — '+esc(r.label)+'<small>'+(r.root?'root '+esc(r.root)+' · ':'')+esc(r.observation)+(r.gaps===null?'':' · '+r.gaps+' open gap(s)')+(r.focused?'':' · released from focus')+'</small></div>').join(''):'<div class="item">Rulith has not been used for this conversation.</div>';if(rootsMarkup!==state.lastRoots){$('roots').innerHTML=rootsMarkup;state.lastRoots=rootsMarkup}const plan=reversed.find((e)=>e.type==='source-plan'),frontierMarkup=plan&&plan.plans?.length?plan.plans.map((p)=>'<div class="item">'+esc(p.predicate)+'<small>'+esc(p.action)+' via '+esc(p.source)+'</small></div>').join(''):hasCase?'<div class="item">No frontier has been reported.</div>':'<div class="item">Rulith has not been used for this conversation.</div>';if(frontierMarkup!==state.lastFrontier){$('frontier').innerHTML=frontierMarkup;state.lastFrontier=frontierMarkup}const worker=filtered.filter((e)=>(e.src==='worker'&&(['claimed','reported','error','skip','up'].includes(e.type)||(e.type==='log'&&e.stderr)))||(e.src==='agent'&&e.type==='worker-activity-unavailable')).slice(-8).reverse(),workerMarkup=worker.length?worker.map((e)=>'<div class="item">'+esc(e.type==='up'?'Worker online':e.type==='worker-activity-unavailable'?'Invocation reporting unavailable · '+eventBody(e):eventBody(e))+'<small>'+timeOf(e)+'</small></div>').join(''):'<div class="item">No Worker activity for this conversation.</div>';if(workerMarkup!==state.lastWorkers){$('workers').innerHTML=workerMarkup;state.lastWorkers=workerMarkup}}
function render(forceTail){historyControls();$('composertarget').hidden=state.fresh||!!state.active||!state.session;$('composertarget').textContent='Message to: '+(state.cases.get(state.session)?.title||state.session);const stream=$('stream'),oldTop=stream.scrollTop,stick=forceTail===true||stream.scrollHeight-stream.scrollTop-stream.clientHeight<80;renderCases();const filtered=state.fresh?[]:state.events.filter((e)=>!state.active||caseOf(e)===state.active);state.toolResults=new Map(filtered.filter(e=>e.type==='tool-result').map(e=>[e.callId,e]));const cards=filtered.map((e)=>card(e,state.view==='trace')).filter(Boolean).join('');$('title').textContent=state.active?(state.cases.get(state.active)?.title||state.active):state.status?.mode==='worker'?'Worker activity':'Local activity';$('subtitle').textContent=state.active?state.active:'Conversation with optional Rulith Case tools';document.querySelectorAll('[data-view]').forEach((button)=>button.classList.toggle('active',button.dataset.view===state.view));const needsSetup=state.status&&(state.status.roles.includes('agent')?!state.status.agent:state.status.roles.includes('worker')&&!state.status.worker);const initializing=state.status?.agent&&state.status.ready?.agent===false;const heading=initializing?'Agent readiness is not confirmed':needsSetup?'Runtime is not ready':state.status?.mode==='worker'?'Worker is ready for governed work':'What would you like to discuss or handle?',copy=initializing?'The process is running. You can try sending a message; a connection failure will appear here.':needsSetup?(state.status.roles.includes('agent')?'Configure and start the Agent to begin a conversation.':'Start the Worker to handle authorized tool requests.'):state.status?.mode==='worker'?'Claims, Tool execution, and receipts will appear here.':'Chat normally. The Agent will use Rulith when governed work, evidence, or an auditable Case is useful.',markup=cards||'<div class="empty"><h1>'+heading+'</h1><p>'+copy+'</p></div>';const open=new Set(markup===state.lastStream?[]:[...stream.querySelectorAll('details[data-call][open]')].map(e=>e.dataset.call));if(markup!==state.lastStream){stream.innerHTML=markup;for(const detail of stream.querySelectorAll('details[data-call]'))detail.open=open.has(detail.dataset.call);state.lastStream=markup;stream.scrollTop=stick?stream.scrollHeight:oldTop}else if(stick)stream.scrollTop=stream.scrollHeight;renderInspector(filtered)}
function showRuntime(r){const a=r.runtime?.agent||{},w=r.runtime?.worker||{};$('agentname').textContent='Agent Runtime';$('agentidentity').textContent=a.id||'not configured';$('modelbadge').textContent=a.model||'No model';$('thinkingbadge').textContent=a.thinking==='disabled'?'Thinking off':a.thinking==='extended'?'Thinking on':'Provider default';$('toolbadge').textContent=r.roles.includes('worker')?'Rulith + Worker '+(w.workspaceTools||'read'):'Rulith MCP';$('detailagent').textContent=a.id||'—';$('detailagentkey').textContent=a.credentialConfigured?'Configured':'Missing';$('detailmodelurl').textContent=a.modelService||'—';$('detailmodel').textContent=a.model||'—';$('detailmodelkey').textContent=a.modelKeyConfigured?'Configured':'Not configured';$('detailthinking').textContent=a.thinking==='disabled'?'Off':a.thinking==='extended'?'On':'Provider default';$('detailconcurrency').textContent='serial · one connection';$('detailconnection').textContent=w.connection||'—';$('detailworkerkey').textContent=w.credentialConfigured?'Configured':'Missing';$('detailtools').textContent=w.workspaceTools||'read';$('detailtoolsfile').textContent=w.toolsFile||'built-in only';$('detailsourcesfile').textContent=w.sourcesFile||'none';$('detailconfig').textContent=r.runtime?.configFile||'—';document.querySelectorAll('[data-control]').forEach((button)=>button.hidden=EMBEDDED||!r.roles.includes(button.dataset.control))}
async function refresh(){const response=await fetch('/status?k='+encodeURIComponent(K)).catch(()=>null);if(response?.status===401||response?.status===403){location.reload();return}const r=await response?.json().catch(()=>null);if(!r||!r.ok)return;state.status=r;$('mode').textContent=r.mode;$('agentstate').textContent=r.roles.includes('agent')?(r.agent?'local online':'local off'):'not local';$('workerstate').textContent=r.roles.includes('worker')?(r.worker?'local online':'local off'):'not local';$('agentdot').className='dot '+(r.agent?'on':'');$('workerdot').className='dot '+(r.worker?'on':'');$('newcase').hidden=!r.roles.includes('agent');$('composer').hidden=!r.roles.includes('agent');$('app').classList.toggle('worker-only',r.mode==='worker');showRuntime(r);render()}
const es=new EventSource('/events?k='+encodeURIComponent(K)+'&history=paged')
es.onmessage=(m)=>{const e=JSON.parse(m.data);mergeEvent(e);state.events.sort((a,b)=>(a.t||a.at||0)-(b.t||b.at||0));render();if(e.type==='task-done')void historyList()}
es.onerror=()=>{$('connectionnotice').hidden=false;$('connectionnotice').textContent='Connection interrupted. Reconnecting; no message has been resent.'}
es.onopen=()=>{$('connectionnotice').hidden=true;void historyList();if(state.active)void readHistory(state.active)}

const pendingSends=new Map()
/* Both ways a send can fail are answered in the page itself, never through a browser dialog:
   embedded in the workbench this document is a sandboxed frame without allow-modals, where
   alert() returns immediately and shows nothing — so the message that explains why nothing
   was sent would be the one message that never arrives. The text typed is left where it is,
   so the refusal costs nothing but the reading. */
/* Files a person adds are materials and nothing more: bytes this computer keeps, named by a
   local material id. Adding one is never a statement that a person attested to anything, and
   never clearance for any use — what may read a material is the Agent's authorized tools.
   Only the id is ever sent with a message; the bytes went to this computer's own material
   service and the path they came from is not something the conversation carries.
   A draft is one conversation being composed in: its files, and the two answers the composer
   gives about them. It is named by an identity of its own rather than by the session key,
   because a conversation that has not been sent yet has no key — the draft is renamed when the
   host answers with one, so what was composed stays with the conversation it was composed in
   wherever the person happens to be by then. Everything a send does afterwards is addressed to
   that draft, never to whatever is selected now: a request that is still open is not a claim on
   the next conversation the person opens. */
const MAX_FILES=8,MAX_BYTES=8*1024*1024,ATTACH_SAID={adding:'Adding…',ready:'Ready'}
const drafts=new Map();let attachSeq=0,newDrafts=0,newDraftKey='new:0'
const draftOwner=()=>state.session?'session:'+state.session:newDraftKey
function draftOf(owner){const key=owner===undefined?draftOwner():owner,held=drafts.get(key)
  if(held)return held
  const made={rows:[],error:'',sent:'',text:'',caseType:'',businessKey:''};drafts.set(key,made);return made}
const attachRows=(owner)=>draftOf(owner).rows

// 一份草稿持有文字、选项和附件；切换只更换投影，不把上一份输入带给下一会话。
function saveComposer(){const draft=draftOf();draft.text=$('prompt').value;draft.caseType=$('casetype').value;draft.businessKey=$('businesskey').value}
function restoreComposer(){const draft=draftOf();$('prompt').value=draft.text||'';$('casetype').value=draft.caseType||'';$('businesskey').value=draft.businessKey||''}
function selectDraft(key){
  if(!drafts.has(key)||!key.startsWith('new:'))return
  saveComposer();$('exportnote').hidden=true;history.request++;state.fresh=true;state.active='';state.session='';newDraftKey=key
  history.before=null;history.expectedModel='';history.confirmedFor='';history.selectedArchived=false
  restoreComposer();showNotes();renderAttachments();render(true);closeModal('convmodal')
}

/* The draft a new conversation was composed in is the conversation the host just named, so it
   keeps its files and its answer under the key it was given. The record itself is moved, not
   copied: an upload still in flight holds it, and a copy would strand that upload. */
function adoptDraft(from,to){const moved=draftOf(from),held=drafts.get(to)
  if(held&&held!==moved){
    // Both records can receive next-message input before the first send is acknowledged.
    // Keep two independently edited drafts, instead of merging two unsent messages.
    if((moved.text?.trim()||moved.rows.length)&&(held.text?.trim()||held.rows.length))return
    if(held.text?.trim()||held.rows.length){Object.assign(moved,{text:held.text,caseType:held.caseType,businessKey:held.businessKey,error:held.error});moved.rows.push(...held.rows)}
  }
  drafts.set(to,moved);drafts.delete(from)}
/* Both answers the composer gives belong to the draft they are about, so a send that fails
   after the person moved on says so in the conversation it was sent from — not over the top of
   what the conversation they are now reading is saying. */
function showNotes(){const note=draftOf();$('composererr').textContent=note.error;$('attachsent').textContent=note.sent}
function sayIn(owner,patch){Object.assign(draftOf(owner),patch);if(owner===draftOwner())showNotes()}
const sayCompose=(message,owner)=>sayIn(owner===undefined?draftOwner():owner,{error:message||''})
const saySent=(message,owner)=>sayIn(owner===undefined?draftOwner():owner,{sent:message||''})
function sayFiles(message){$('filesnote').textContent=message||'';sayCompose(message||'')}
/* Chips are built as elements rather than assigned as markup: the remove control has to be a
   real button a keyboard can reach, and a filename is text, never something escaped into
   markup and hoped for. */
function chipInto(row,host){
  const chip=document.createElement('div');chip.className='chip'+(row.status==='error'?' bad':'')
  const name=document.createElement('span');name.className='chip-name';name.textContent=row.name;chip.appendChild(name)
  const said=document.createElement('span');said.className='chip-state'
  said.textContent=row.status==='error'?(row.reason||'Could not be added'):ATTACH_SAID[row.status];chip.appendChild(said)
  if(row.status==='error'&&row.file&&row.retryable!==false){const retry=document.createElement('button');retry.type='button';retry.className='ghost';retry.textContent='Add again';retry.title='Try storing this file again. A previously unconfirmed local copy may remain.';retry.setAttribute('aria-label','Add '+row.name+' again');retry.onclick=()=>retryMaterial(row.key);chip.appendChild(retry)}
  const drop=document.createElement('button');drop.type='button';drop.className='chip-drop';drop.textContent='×'
  drop.setAttribute('aria-label','Remove '+row.name);drop.dataset.attach=row.key
  drop.onclick=()=>removeAttachment(row.key);chip.appendChild(drop)
  host.appendChild(chip)
}
function renderAttachments(){
  const rows=attachRows()
  for(const host of [$('attachlist'),$('fileslist')]){host.replaceChildren();for(const row of rows)chipInto(row,host)}
  $('attachlist').hidden=rows.length===0;$('attachnote').hidden=rows.length===0
}
function base64(buffer){const bytes=new Uint8Array(buffer);let binary='';for(let at=0;at<bytes.length;at+=0x8000)binary+=String.fromCharCode.apply(null,bytes.subarray(at,at+0x8000));return btoa(binary)}
/* The one way bytes leave this page, for both entry points. The answer is the material this
   computer stored; a row that was removed while its bytes were being read stays removed, and
   a row belongs to the draft it was added to whatever is selected when the answer arrives. */
async function addMaterial(file,row,into){
  let answer=null
  try{
    /* Storing bytes is a mutating route, so it is asked for the way Setup and Worker tools ask:
       the page key in the header as well as the address, on this page's own origin. */
    answer=await fetch('/materials?k='+encodeURIComponent(K),{method:'POST',headers:{'x-rulith-local':K,'content-type':'application/json'},
      body:JSON.stringify({name:row.name,mediaType:String(file.type||'application/octet-stream'),modelDestination:row.destination,bytes:base64(await file.arrayBuffer())})})
      .then((x)=>x.json()).catch(()=>null)
  }catch{answer=null}
  /* The draft record itself, not its name: a new conversation that was given a key while this
     was in flight is the same draft under a different name, and this row is still in it. */
  if(into.rows.indexOf(row)<0)return
  if(answer&&answer.ok&&answer.material&&answer.material.id){row.status='ready';row.id=String(answer.material.id);delete row.file}
  else{row.status='error';row.retryable=answer?.errorCode!=='material_destination_changed';row.reason=answer&&answer.teaching?String(answer.teaching):'Could not be added'}
  if(into===draftOf()||attachRows().includes(row))renderAttachments()
}
function retryMaterial(key){const into=draftOf(),row=into.rows.find(r=>r.key===key);if(!row||row.status!=='error'||!row.file||row.retryable===false)return;row.status='adding';row.reason='';sayFiles('');renderAttachments();void addMaterial(row.file,row,into)}
function addFiles(list){
  const chosen=[...(list||[])];if(!chosen.length)return
  if(!state.status||!state.status.runtime?.agent?.modelService?.trim()){sayFiles('Model settings are not available yet. Wait for the connection, then choose the files again.');return}
  const into=draftOf(),rows=into.rows;let refused=''
  for(const file of chosen){
    if(rows.length>=MAX_FILES){refused='Up to '+MAX_FILES+' files can go with one message. The rest were not added.';break}
    if(Number(file.size)>MAX_BYTES){refused=String(file.name)+' is larger than 8 MiB and was not added.';continue}
    attachSeq+=1
    const row={key:'a'+attachSeq,name:String(file.name||'file'),status:'adding',id:'',reason:'',file,destination:String(state.status?.runtime?.agent?.modelService||'')}
    rows.push(row);addMaterial(file,row,into)
  }
  saySent('');sayFiles(refused);renderAttachments()
}
/* Removing is immediate and final for that row, including while its bytes are still being
   read: the answer, when it comes, finds the row is no longer in the draft and stops there. */
function removeAttachment(key){
  const rows=attachRows(),at=rows.findIndex((row)=>row.key===key)
  if(at<0)return
  rows.splice(at,1);sayFiles('');renderAttachments()
  const back=$('filesmodal').hidden?$('caseoptions'):$('filespick')
  if(back&&back.focus)back.focus()
}
$('composer').addEventListener('submit',async(ev)=>{
  ev.preventDefault();sayCompose('');if(history.selectedArchived&&!state.fresh){sayCompose('Restore this archived conversation before sending.');return}
  /* What this send is about, captured before anything can be waited on: which draft it came
     from, what was selected, and the exact text that went. A person is free to move, type and
     add files while the request is open, and none of it belongs to this send. */
  saveComposer()
  const typed=$('prompt').value,text=typed.trim(),owner=draftOwner(),selection=state.active,rows=attachRows(owner)
  /* A file that is not stored yet has no id to send, and a file that failed has nothing to
     send at all. Either one stops the send and says which file it is, rather than quietly
     sending a message the person believes carried their file. */
  if(rows.some((row)=>row.status==='adding')){sayCompose('Still adding '+rows.filter((row)=>row.status==='adding').map((row)=>row.name).join(', ')+'. Send when it is ready, or remove it.');return}
  const failed=rows.filter((row)=>row.status==='error')
  if(failed.length){sayCompose(failed.map((row)=>row.name).join(', ')+' could not be added: '+(failed[0].reason||'the material service refused it')+'. Remove it or try again.');return}
  const ready=rows.filter((row)=>row.status==='ready')
  if(!text&&!ready.length)return
  let businessKey;const raw=$('businesskey').value.trim()
  if(raw){try{businessKey=JSON.parse(raw)}catch{sayCompose('Business key must be valid JSON.');$('casepopover').hidden=false;$('businesskey').focus();return}}
  if($('send').disabled)return
  const submission={text,...(history.confirmedFor?{historyModelDestination:history.confirmedFor}:{}),...($('casetype').value.trim()?{caseType:$('casetype').value.trim()}:{}),sessionKey:state.session||('ctx-'+crypto.randomUUID()),...(businessKey===undefined?{}:{businessKey}),...(ready.length?{attachments:ready.map((row)=>row.id)}:{})}
  const previous=pendingSends.get(owner)
  if(previous)submission.sessionKey=previous.body.sessionKey
  const {historyModelDestination:confirmedDestination,...identity}=submission
  const signature=JSON.stringify(identity)
  const pending=previous&&previous.signature===signature?previous:{signature,body:{...submission,requestId:crypto.randomUUID()}}
  pendingSends.set(owner,pending)
  if(confirmedDestination)pending.body.historyModelDestination=confirmedDestination
  $('send').disabled=true;$('send').textContent='…'
  const r=await fetch('/cases?k='+encodeURIComponent(K),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pending.body)}).then((x)=>x.json()).catch(()=>null)
  $('send').disabled=false;$('send').textContent='↑'
  /* Whether the person is still in the draft this was sent from. Everything below is decided
     by it, and it is read once, here, before anything is moved. */
  const here=draftOwner()===owner
  /* A refused send keeps both halves of what was composed, and says so where it was composed.
     Dropping the files here would mean adding them again to retry a message the host never
     accepted; saying it in the composer they are reading now would attach the failure to a
     conversation that had nothing to do with it. */
  if(!r?.ok){sayCompose(r?.teaching||'The message outcome is not confirmed. Reconnect and retry this same message; your draft has been kept.',owner)
    pending.interrupted=r?.state==='interrupted';if(here){$('newattempt').hidden=!pending.interrupted;if(r?.state==='model-confirmation'){history.expectedModel=r.modelService;historyControls()}$('historybar').hidden=false}return}
  $('newattempt').hidden=true

  /* Only the rows that actually went are taken out, one by one: a file added while the request
     was open was never part of this message and is still waiting to be sent. */
  pendingSends.delete(owner)
  const sentDraft=draftOf(owner);if(sentDraft.text===typed)sentDraft.text=''
  const kept=attachRows(owner)
  for(const row of ready){const at=kept.indexOf(row);if(at>=0)kept.splice(at,1)}
  sayIn(owner,{error:'',sent:ready.length?'Sent with '+ready.length+' file'+(ready.length===1?'':'s')+': '+ready.map((row)=>row.name).join(', '):''})
  // A new conversation has just been given its key, so its draft takes that name.
  if(r.sessionKey&&owner.indexOf('new:')===0)adoptDraft(owner,'session:'+r.sessionKey)
  if(!here){render();return}
  /* Still in the draft that was sent. The box is emptied only if what is in it is still what
     went — anything typed since is the next message, not this one — and the selection follows
     the new conversation only if the person has not chosen a different one meanwhile. */
  if($('prompt').value===typed)$('prompt').value=''
  $('casepopover').hidden=true
  if(r.sessionKey){state.fresh=false;state.session=r.sessionKey;if(state.active===selection)state.active=r.sessionKey}
  restoreComposer();showNotes();renderAttachments();render(true)})
/* Starting a new conversation starts a new draft, and not the one a previous new conversation
   left behind: without a name of its own, every unsent conversation is the same one. */
$('newcase').onclick=()=>{saveComposer();$('exportnote').hidden=true;history.request++;history.selectedArchived=false;history.before=null;history.expectedModel='';history.confirmedFor='';$('newattempt').hidden=true;state.session='';state.active='';state.fresh=true;state.view='case';newDrafts+=1;newDraftKey='new:'+newDrafts;restoreComposer();showNotes();renderAttachments();render(true);closeModal('convmodal');$('prompt').focus()};$('clear').onclick=()=>{state.events=[];render(true)};$('prompt').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit()}});$('prompt').addEventListener('input',()=>{saveComposer();sayCompose('');saySent('');renderCases()});
/* The composer's ＋ is about the thing people reach for: adding files. Case preferences did not
   move away — they are the second entry in the same menu, named as the advanced option they
   are, and the popover they open is unchanged. */
function openAttachMenu(){$('casepopover').hidden=true;$('attachmenu').hidden=false;$('caseoptions').setAttribute('aria-expanded','true');if($('attachfiles').focus)$('attachfiles').focus()}
function closeAttachMenu(back){if($('attachmenu').hidden)return;$('attachmenu').hidden=true;$('caseoptions').setAttribute('aria-expanded','false');if(back&&$('caseoptions').focus)$('caseoptions').focus()}
$('caseoptions').onclick=()=>{if($('attachmenu').hidden)openAttachMenu();else closeAttachMenu(true)};
$('attachfiles').onclick=()=>{closeAttachMenu(true);openFiles()};
$('attachprefs').onclick=()=>{closeAttachMenu(true);$('casepopover').hidden=false;if($('casetype').focus)$('casetype').focus()};
/* Add files is a dialog rather than only a picker, so it can be opened again in the middle of
   a turn to add supplemental materials. It asks the model for nothing and invents no event:
   what it does is add materials to the draft, which go with the next message. */
function openFiles(){openModal('filesmodal');sayFiles('');renderAttachments();if($('filespick').focus)$('filespick').focus()}
$('filesclose').onclick=()=>closeModal('filesmodal');$('filespick').onclick=()=>$('fileinput').click()
$('fileinput').addEventListener('change',()=>{addFiles($('fileinput').files);$('fileinput').value=''})
/* Dropping on the composer is the same act as choosing in the dialog, and goes the same way. */
for(const id of ['composer','filesdrop']){
  const host=$(id)
  host.addEventListener('dragover',(event)=>{event.preventDefault();host.classList.add('dragging')})
  host.addEventListener('dragleave',()=>host.classList.remove('dragging'))
  host.addEventListener('drop',(event)=>{event.preventDefault();host.classList.remove('dragging');const dropped=event.dataTransfer&&event.dataTransfer.files;if(dropped&&dropped.length)addFiles(dropped)})
}
/* The click that opened the popover is still travelling when this runs, so the menu it came
   from counts as inside: without that, choosing Case preferences opens the popover and closes
   it again in the same click. */
document.addEventListener('click',(event)=>{if(!$('casepopover').hidden&&!$('casepopover').contains(event.target)&&!$('attachmenu').contains(event.target)&&event.target!==$('caseoptions'))$('casepopover').hidden=true;if(!$('attachmenu').hidden&&!$('attachmenu').contains(event.target)&&event.target!==$('caseoptions'))closeAttachMenu(false)});document.querySelectorAll('[data-view]').forEach((button)=>button.onclick=()=>{state.view=button.dataset.view;render(true)});$('exportlog').onclick=()=>{
  const events=state.fresh?[]:state.events.filter(e=>!state.active||caseOf(e)===state.active)
  const exported={format:'rulith-local-view/1',exportedAt:new Date().toISOString(),mode:state.status?.mode,
    scope:{conversationId:state.active||null,newConversation:state.fresh},
    coverage:{completeHistory:false,includesTraceEvents:true,earlierMessagesAvailable:state.active?!!history.before:null,note:'Loaded local events only. Not a complete history, material contents, or Board proof.'},events}
  let url='',a
  try{
    url=URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}))
    a=document.createElement('a');a.href=url;a.download='rulith-view-'+new Date().toISOString().replaceAll(':','-')+'.json'
    document.body.appendChild(a);a.click()
    $('exportnote').textContent='Download requested: '+events.length+' loaded events, including trace details. This is a partial local record.'
  }catch{$('exportnote').textContent='The download could not be started. Try exporting this view again.'}
  finally{a?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);$('exportnote').hidden=false}
}
$('exportviewmobile').onclick=()=>{closeModal('convmodal');$('exportlog').onclick()}
/* Four dialogs now — Runtime details, Conversations, Case evidence and Add files — so opening
   one is one function: it remembers what had focus, moves focus into the dialog, and gives it
   back on close. Escape closes whichever is open. */
/* aria-modal says the rest of the document is not there; inert is what makes that true.
   Without both, Tab from a dialog walks into the composer and the stream behind the scrim,
   which is exactly the mismatch a screen-reader user is told does not exist. */
const MODALS=['runtimemodal','convmodal','evidencemodal','filesmodal'];let lastFocus=null,openModalId=''
function openModal(id){lastFocus=document.activeElement;openModalId=id;$(id).hidden=false;$('app').inert=true;const close=$(id).querySelector('.modal-close');if(close)close.focus()}
function closeModal(id){if($(id).hidden)return;$(id).hidden=true;if(openModalId===id)openModalId='';$('app').inert=MODALS.some((other)=>!$(other).hidden);if(lastFocus&&lastFocus.focus)lastFocus.focus();lastFocus=null}
function trapTab(event){
  if(event.key!=='Tab'||!openModalId||$(openModalId).hidden)return
  const items=[...$(openModalId).querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])')]
    .filter((el)=>!el.disabled&&el.getClientRects().length>0)
  if(!items.length)return
  const first=items[0],last=items[items.length-1]
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
document.addEventListener('keydown',trapTab)
const openRuntime=()=>{openModal('runtimemodal');$('runtimemsg').textContent='';refresh()},closeRuntime=()=>closeModal('runtimemodal')
$('runtimeopen').onclick=openRuntime;$('mobileruntime').onclick=openRuntime;$('modelbadge').onclick=openRuntime;$('runtimeclose').onclick=closeRuntime
$('convopen').onclick=()=>{openModal('convmodal');void historyList()};$('convclose').onclick=()=>closeModal('convmodal')
$('evidenceopen').onclick=()=>openModal('evidencemodal');$('evidenceclose').onclick=()=>closeModal('evidencemodal')
for(const id of MODALS)$(id).onclick=(event)=>{if(event.target===$(id))closeModal(id)}
document.addEventListener('keydown',(event)=>{if(event.key!=='Escape')return;closeAttachMenu(true);for(const id of MODALS)closeModal(id)})
/* A start waits for the role to report that it finished initializing, which can take seconds.
   Say so while it is happening: a button that goes quiet for that long reads as a hung page,
   and the answer that follows is the host's own state word, not a guess made here. */
/* Only the states that answer ok:true need a word here; every other outcome carries the host's
   own teaching and that is what is printed. The unconfirmed and cancelled entries were
   unreachable for exactly that reason — and the cancelled one still said "was stopped", the
   claim the host teaching was corrected not to make about a process that has not exited.
   (No backticks in here: this whole script lives inside a template literal.) */
var CONTROL_SAID={ready:'started and reported ready.',stopped:'stopped.',stopping:'was sent the stop signal and has not exited yet.'}
document.querySelectorAll('[data-control]').forEach((button)=>button.onclick=async()=>{button.disabled=true;$('runtimemsg').textContent=button.dataset.operation==='start'?'Starting '+button.dataset.control+'; waiting for it to report ready…':'Stopping '+button.dataset.control+'…';const result=await fetch('/control?k='+encodeURIComponent(K),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:button.dataset.control,operation:button.dataset.operation})}).then((x)=>x.json()).catch(()=>null);$('runtimemsg').textContent=result?.ok?button.dataset.control+' '+(CONTROL_SAID[result.state]||(button.dataset.operation+'ed.')):(result?.teaching||'Runtime control failed.');button.disabled=false;setTimeout(refresh,300)})
/* Where "back" goes is the launcher's statement, never this page's assumption: a manager
   listens on a port it chose, and a Local opened on its own has nowhere to return to. The
   address arrives in the optional manager parameter, is accepted only as a loopback
   http(s) origin, and is carried on to the sibling Local pages so the way back survives
   navigation. Only the manager's loopback browser key is retained; the cloud device token
   is never in the browser. The sidebar copy disappears with the sidebar on a
   phone, so the Runtime details dialog carries the same link. */
/* Embedded, this page has no way back to render and therefore no reason to hold the
   launcher's address at all — and every reason not to: it carries the manager's own browser
   key, and anything this document links to would carry it onward into a top-level tab. The
   workbench strips the parameter before loading this page; dropping it here as well means a
   hand-typed address cannot put it back. Standalone is unchanged. */
var MANAGER=EMBEDDED?'':managerReturnHref(location.search), LINKQ=(path)=>path+'?k='+encodeURIComponent(K)+(MANAGER?'&manager='+encodeURIComponent(MANAGER):'')
/* Embedded, the way back is the page this one is inside: a link here would put the workbench
   inside the workbench. */
if(MANAGER&&!EMBEDDED){const back=document.createElement('a');back.id='managerreturn';back.className='manager-return';back.textContent='← Back to agents';back.href=MANAGER;$('sidefoot').prepend(back);const narrow=back.cloneNode(true);narrow.removeAttribute('id');$('runtimemsg').before(narrow)}
const setupLink=document.createElement('a');setupLink.textContent='Setup wizard';setupLink.href=LINKQ('/setup');setupLink.className='sidelink';$('runtimeopen').after(setupLink);
const toolLink=document.createElement('a');toolLink.textContent='Worker tools · manage';toolLink.href=LINKQ('/worker-tools');toolLink.className='settingsopen sidelink';$('runtimeopen').after(toolLink);const mobileToolLink=toolLink.cloneNode(true);$('runtimemsg').before(mobileToolLink)
/* The two rails move into dialogs rather than being rebuilt: the same elements, the same
   handlers, the same rendering. Setup and the tools page open in a window of their own so
   that reaching them never replaces the conversation the workbench is showing. */
/* Embedded, this page keeps its own Case inspector: it is the right-hand column of the
   workbench, rendered from the events this conversation is reading, and switching Agent or
   conversation moves it because it is the same projection that moves. Only when the frame is
   too narrow to hold it do the very same section nodes move into the Evidence dialog, and
   they move back — in their original order, with the dialog closed and focus returned first —
   as soon as there is room. Nothing is copied and nothing is re-rendered from a second store. */
const evidenceSections=[],evidenceBreakpoint=EMBEDDED?900:1050,evidenceQuery='(max-width:'+evidenceBreakpoint+'px)'
const evidenceNarrow=()=>typeof window.matchMedia==='function'
  ?window.matchMedia(evidenceQuery).matches===true:!(Number(window.innerWidth)>evidenceBreakpoint)
// CSS can hide the focused inspector before the media-query callback runs. Keep its last
// meaningful focus so that this browser-induced blur does not lose the user's place.
let evidenceHadFocus=false
document.addEventListener('focusin',event=>{
  if(event.target!==document.body)evidenceHadFocus=$('inspector').contains(event.target)
})
function syncEvidence(){
  const narrow=evidenceNarrow(),host=narrow?$('evidencebody'):$('inspector')
  const foldingFocus=narrow&&(evidenceHadFocus||$('inspector').contains(document.activeElement))
  const wasOpen=!narrow&&!$('evidencemodal').hidden
  if(wasOpen)closeModal('evidencemodal')
  for(const section of evidenceSections)if(section.parentNode!==host)host.appendChild(section)
  $('evidenceopen').hidden=!narrow
  /* The control that opened the dialog does not exist at this width, so returning focus to it
     would drop focus onto the document body — the reader loses their place and has to Tab in
     from the start. Focus follows the evidence into the column it just moved back to. */
  if(wasOpen&&$('inspector').focus)$('inspector').focus()
  if(foldingFocus)$('evidenceopen').focus()
}
if(EMBEDDED){
  $('app').classList.add('embedded')
  for(const controls of document.querySelectorAll('.runtimecontrols'))controls.hidden=true
  for(const link of document.querySelectorAll('a.sidelink')){link.target='_blank';link.rel='noopener noreferrer'}
}
const conversationQuery=window.matchMedia?.('(max-width:720px)')
function syncConversations(){
  if(EMBEDDED||conversationQuery?.matches){$('convbody').appendChild($('newcase'));$('convbody').appendChild($('cases'))}
  else{const wasOpen=!$('convmodal').hidden;closeModal('convmodal');document.querySelector('.side-title').before($('newcase'));$('sidefoot').before($('cases'));if(wasOpen)$('newcase').focus()}
}
syncConversations()
if(conversationQuery?.addEventListener)conversationQuery.addEventListener('change',syncConversations)
else conversationQuery?.addListener?.(syncConversations)
for(const section of document.querySelectorAll('.inspector .section'))evidenceSections.push(section)
syncEvidence()
if(typeof window.matchMedia==='function'){
  const query=window.matchMedia(evidenceQuery)
  if(query.addEventListener)query.addEventListener('change',()=>syncEvidence())
  else if(query.addListener)query.addListener(()=>syncEvidence())
}
$('loadolder').onclick=()=>readHistory(state.active,true)
$('historyactive').onclick=()=>{history.archived=false;void historyList()}
$('historyarchived').onclick=()=>{history.archived=true;void historyList()}
$('historymore').onclick=()=>historyList(true)
$('historyconsent').onclick=()=>{history.confirmedFor=history.expectedModel;historyControls();$('prompt').focus()}
$('newattempt').onclick=()=>{const owner=draftOwner(),p=pendingSends.get(owner);if(!p?.interrupted)return;pendingSends.delete(owner);$('newattempt').hidden=true;$('composer').requestSubmit()}
$('archivehistory').onclick=async()=>{
 const key=state.active||state.session,archived=!history.selectedArchived;if(!key||history.busy)return
 history.busy=true;historyControls()
 try{const r=await fetch('/conversation/archive?k='+encodeURIComponent(K),{method:'POST',headers:{'content-type':'application/json','x-rulith-local':K},body:JSON.stringify({sessionKey:key,archived})}).then(x=>x.json());if(!r.ok)throw new Error(r.teaching||'The archive operation could not be confirmed.');if(state.session===key)history.selectedArchived=archived;await historyList()}
 catch(e){sayCompose(e.message,'session:'+key)}finally{history.busy=false;historyControls()}
}
void historyList();refresh();setInterval(refresh,2500)
${workbenchReadyScript}
</script></body></html>`
