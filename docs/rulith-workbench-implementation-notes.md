# The Rulith workbench: UI contract and limitations

What the browser page at the manager's loopback address is, what it promises to the pages it
embeds, and what it deliberately does not do. This is a presentation document: every rule of
authority, lifecycle and credential handling is stated by `local/manager-server.mjs`,
`local/instance-manager.mjs` and `local/device-client.mjs`, and the page only reflects them.

Files: `local/manager-ui.mjs` (the workbench), `local/local-ui.mjs` (the conversation, now with
an embedded presentation), `local/theme.mjs` (the shared sheet, unchanged),
`local/setup-ui.mjs` and `local/worker-tools-ui.mjs` (brand only).

## The shape

Three columns, and nothing else on the page.

| Column | What it holds |
| --- | --- |
| Left | The cloud Agents this device is authorized to use, joined to their existing local configuration. An unconfigured Agent opens first-use setup; listing and selection create no credentials or processes. |
| Centre | The chosen Agent's original conversation, activity header, Trace and composer, as its own host serves them. |
| Right | That same conversation's Cases in focus, unresolved call, current frontier and Worker activity. |

The account stays at the lower left. The selected Agent's role controls, Tools and settings
are reachable from the Agent rail. There is no second desktop activity header or separate
Worker management rail. The manager owns two structural columns; its selected iframe owns
the center and right columns together, with no copied business state between documents.

Everything else is a dialog, opened when it is wanted: **Account** (sign in with the browser,
the short code, refresh, sign out, the unusable-authorization path, and local configuration
recovery/import), **Set up on this computer** (first use of the already selected cloud Agent),
**Connect a cloud Agent** (recovery for an imported or unpaired local configuration,
explicit consent to replace an existing credential, and finishing or giving up an interrupted
attempt), and **Agent settings** (setup, model settings copied from another Agent, the
technical details, and removal).

On a screen narrower than 980px the Agent rail becomes a drawer. The conversation page
opens its own evidence panel when its available width cannot fit the inspector. Both have
an explicit close, Escape and keyboard focus handling, with no horizontal scrolling.

## The centre is the real conversation, embedded

The workbench does not re-implement the conversation. It asks the manager for the chosen
Agent's own address and loads that page in an iframe with `embedded=1`:

- `POST /manager/instances/open {instanceId, page:'/'}` returns the host's URL, carrying that
  host's **loopback UI key** — not a cloud token, not the device token. The page adds
  `embedded=1` and **removes `manager=`**. That parameter is the launcher's own address *with
  the manager's browser key in it*; the embedded page renders no way back, so carrying it
  across the origin boundary would hand this page's own authority to another document for no
  benefit. The conversation page drops it too when it is embedded, so a hand-typed address
  cannot put it back, and the settings links it opens in new tabs cannot carry it onward.
  Standalone, `manager=` is unchanged and "Back to agents" works exactly as before.
- `local/local-ui.mjs` reads `embedded=1` from its own address. In that presentation it hides
  only its legacy left sidebar and keeps its real Case inspector beside the conversation.
  It **moves** the conversation list and New conversation button into a dialog reached from
  the activity header. At narrow widths, the same Case evidence sections move into an
  evidence dialog and return to the inspector when widened. They are the same elements with the same
  handlers, so conversation switching, the Case roots, the frontier, the unresolved-call panel,
  Markdown, tool disclosure, Trace, the composer, the session log and Runtime details all
  behave exactly as they do standalone.
- Embedded, the child's Setup and Worker-tools links open in a window of their own, so reaching
  settings never replaces the conversation. Its "Back to agents" link is not rendered: the way
  back is the page it is already inside.
- Embedded, the child's own Runtime start/stop controls are hidden. Starting a role belongs to
  the workbench, which is where a person sees the state that follows from it.
- **The composer answers in the page.** The frame is sandboxed without `allow-modals`, so
  `window.alert()` inside it returns without showing anything. Both ways a send can fail — a
  business key that is not JSON, and a refusal from `POST /cases` — are rendered into
  `#composererr` (`role="alert"`) with the text left in the box, rather than alerted.
  `allow-modals` is deliberately *not* granted: the fix is the page saying what happened, not
  the sandbox letting a dialog through that would be attributed to the workbench.
- The conversation page's three dialogs set `inert` on the rest of its document and trap Tab,
  so `aria-modal="true"` is true of the keyboard as well as of the accessibility tree.

**Readiness only.** The documents remain separate origins; neither reads the other's DOM.
The child sends only `{type:'rulith-ui-ready',view}` to the exact loopback parent origin.
The parent checks the sender window, origin and current view identifier before confirming
the document loaded. No credentials, business content or commands cross this message path.
An HTTP error body cannot emit this receipt, so it remains visibly unconfirmed with a retry.
Host generations also discard stale frames when a restarted host reuses its old port.
The frame is created with `referrerpolicy="no-referrer"` (so the manager's
own key cannot travel to the host in a `Referer`) and a `sandbox` allowing scripts, same-origin
(to *itself*), forms, downloads and pop-ups, but not navigating the top document.

**One frame per Agent.** A frame is created on first selection and afterwards only hidden, so
A → B → A returns to a live conversation rather than a reloaded one, and nothing is started or
stopped by a selection. A frame is discarded only when what it points at is gone: the Agent was
removed, its host was closed, or the host came back on a different port. Selecting an Agent
opens its host; **opening a host starts no role.**

**The centre says what the frame actually did.** The placeholder is not dismissed at
`appendChild` or the frame's `load` event. It stays until the expected page sends its checked
readiness receipt, and explains the missing confirmation with a **Try again** button if an
eight-second watchdog passes first. Try again drops the frame and asks the manager
for the address afresh. A frame that failed is never reported as a closed host.

**Settings do not use `window.open`.** A pop-up opened after an `await` has no user gesture
behind it, is blocked silently, and leaves a button that does nothing forever. Setup and Worker
tools load into a dialog inside the workbench (`#dlg-page`), sandboxed and `no-referrer` like
the workspace frame, with an ordinary `<a target="_blank" rel="noopener noreferrer">` beside
the title for anyone who wants a tab of their own — their click, their gesture. Closing the
dialog sets the frame to `about:blank` so a closed settings page stops polling its host. The
conversation frame is never replaced by any of this.

## What the page promises about state

- **Ground truth is the manager.** Every response includes the whole state and the page renders
  from it. No outcome is inferred from the fact that a request was answered: a role asked to
  stop that has not exited is reported as still running, with the host's own teaching, and an
  incomplete sign-out or an unconfirmed revocation stays signed in and says which step failed.
- **Identity is captured at the moment of the press.** Every write names the `instanceId` read
  when the button was clicked, never a mutable "current Agent", so choosing another Agent while
  a request is in flight cannot redirect it.
- **One in-flight action per scope**, where a scope is one Agent and one thing
  (`role:<id>:agent`, `model:<id>`, `attach:<id>`, `open:<id>:frame`, `open:<id>:settings`,
  `account`, `add`). Opening the workspace and opening settings are separate scopes: sharing
  one meant Tools during a slow frame open did nothing at all, and made the stage claim the
  workspace was opening when it was not. Availability of every control is a pure function of
  the state and the set of in-flight scopes, recomputed on every render — so one action cannot
  leave another action's button enabled, and a slow action on one Agent disables neither
  another Agent's controls nor choosing between Agents. A second press of something already
  working says so instead of returning quietly.
- **Replacement consent does not travel.** "Replace the credential this Agent already has" is
  recorded against the exact pair it was given for — this Agent here, that cloud Agent in the
  list. Selecting another Agent, choosing another cloud Agent, or the offered list changing
  underneath drops it; a poll that finds the same pair keeps it; and `pair` sends
  `replaceAgentToken: true` only if the tick still matches the pair being submitted. It is
  cleared again once used.
- **A manager that stops answering is said so.** A refusal is the manager talking and is shown
  where it was asked for. Silence, or a `401`/`403` that means this page's key is no longer
  accepted, is different: after two in a row a banner appears in the centre and every control
  that changes anything — including opening a workspace, which starts a host — is disabled
  until an answer arrives. The page keeps polling; one answer clears it. Frames already open
  are left alone: they are other servers, and they are still answering.
- **The Worker's failures are shown beside the Worker** (`#worker-notice`), because on a phone
  that panel is a drawer over the centre and a teaching written behind its own scrim is a
  teaching nobody reads.
- **The three-second poll changes nothing a person is holding**: fields being typed, checkbox
  state, a chosen option that is still offered, the selection, open dialogs and disclosures, the
  showing frame, and focus all survive it. The Agent list is rebuilt only when its markup
  actually changed, and focus is returned to the same row. The poll stands aside while an action
  is in flight.
- **No secret is rendered.** The page reads the manager key from its own address and never
  writes it anywhere; per-Agent host keys exist only inside a frame's `src` or an opened
  window's address, exactly as they would in an address bar. Nothing is written to
  `localStorage`, `sessionStorage` or the console.

## Routes

The page drives the existing manager API unchanged: `/manager/state`, `/manager/device/{start,
poll,refresh,signout,forget}`, `/manager/instances/{create,import,pair,pair/poll,model/copy,
open,start,stop,forget}`. All writes are `POST` JSON with the `x-rulith-manager` header taken
from this page's address.

The integrated manager server implements both additional lifecycle routes:

| Route | Used for |
| --- | --- |
| `POST /manager/instances/control {instanceId, role, operation}` | Start or stop **one** role of the selected Agent from its controls in the Agent rail. |
| `POST /manager/instances/pair/cancel {instanceId}` | Giving up an interrupted attachment. |

The server authorizes both operations using the selected instance's normal policy. Errors display the server's actual teaching beside the control. There is deliberately **no
fallback** onto `/manager/instances/start`: that route starts every role of an instance, and
quietly starting a Worker because someone pressed "Start Agent" would be a false statement
about the computer. `/manager/instances/{start,stop}` remain reachable, as "Start Agent and
Worker" and "Stop everything", inside the settings dialog's technical disclosure.

The control response is read defensively: an optional `control` object contributes a state word
and a teaching to the message, but whether a role is running is taken from the refreshed state
in the same response, never from the shape of the outcome.

## Limitations

- The workbench cannot know which conversation is open inside a frame, and does not try to.
  Conversations belong to the embedded page and are reached from its own header.
- Nothing is persisted across a reload of the workbench: no selection, no frame. Reloading it
  closes every frame and re-opens the one that is chosen next.
- `hasRole` falls back to the mode (`existing_client` → Worker only) while a host is closed,
  because a closed host reports no roles. A running host's reported roles always win. An
  imported profile with unusual roles is therefore described by its mode until it is opened.
- The embedded presentation is chosen by a query parameter, which means a person who opens the
  address by hand can see either. That is a presentation choice and carries no authority.
- The eight-second watchdog is a judgement, not a measurement: a host that is simply slow will
  say "still opening" and then load normally. It never cancels anything.
- An `<iframe>` can fire `load` for a refusal page. Only the exact expected document's
  readiness receipt confirms it is usable; an error document remains behind the retry panel.
- A drawer's `inert` is applied from `matchMedia('(max-width:980px)')`, the same breakpoint the
  sheet uses. The two are stated twice and could drift; the browser arm at 390px is what would
  catch it.
- While focus is **inside** the settings frame, Escape belongs to that page: a cross-origin
  document does not hand its keys to this one. Tab moves into the frame (the dialog's focus
  trap includes it, so the settings page is reachable) and back out to the close button, where
  Escape works again. The close button is always visible.

## Checks

- `test/local-manager-page.test.mjs` — the workbench's own logic against the document its
  script touches: routes, escaping, one account state at a time, the frame lifecycle (A → B → A
  opens once), per-role control and honest stop reporting, scoped busy-ness, poll preservation,
  Escape and focus, and that a host address never lands in rendered text.
- `test/local-workbench-embedded.test.mjs` — the contract between the two pages: the parameter
  both sides name, the legacy sidebar hidden and the real inspector retained, panels moved rather than
  rebuilt, settings opening beside the conversation, and a bounded readiness receipt across origins.
- `test/local-style.test.mjs` — unchanged, and still passing: one shared sheet, no second
  palette, no retired literal, and the return-link rules.
- `test/browser/workbench-ui.browser.mjs` — the arms a shim cannot decide, in Chromium against
  a fixture (`test/browser/mock-manager.mjs`) that serves the real pages from two loopback
  servers per Agent: a refused send answered inside the sandboxed frame, the manager key absent
  from the frame's address and from every link inside it, the standalone way back still working,
  A → B → A keeping unsent text, no clipping or sideways scroll at 1000px and 390px, a closed
  drawer being genuinely unfocusable and a resize past the breakpoint clearing it, a dialog in
  the frame holding Tab, settings opening without a pop-up, a `<select>` value that had to be
  escaped surviving a rebuild, and a silenced manager disabling every write.
  It is **not** in `npm test`: it sits outside the `test/*.test.mjs` glob and needs a Playwright
  that is not a dependency of this package. Run it with
  `node --test test/browser/workbench-ui.browser.mjs`; it resolves Playwright from
  `rulith-java/console-web/node_modules` and a Chromium from the shared `ms-playwright` cache,
  and every arm skips with a reason if either is absent.
- `test/support/mini-dom.mjs` gained what the new page needs, additively: element creation and
  removal (so a frame the script makes is a thing a test can see), focus and `activeElement`,
  document-level key events, a tolerant export list instead of a fixed one, elements that start
  hidden when the markup says they do, `<option>` values decoded the way a parser would decode
  them, and a `matchMedia` a test can answer so the drawer rules can be exercised. It is used
  only by `test/local-manager-page.test.mjs`.
- The unit arms need no dependencies: `node --test test/local-manager-page.test.mjs
  test/local-workbench-embedded.test.mjs test/local-style.test.mjs test/local-presentation.test.mjs`
  runs them without browser dependencies. The rest of the suite needs
  `npm install` first.

Root integration: both routes are live. Real browser verification against Java Gateway/Core
passes concurrent two-Agent calls, retained iframe drafts, scoped Worker stop/start,
reusable return links, nested dialogs, desktop/mobile rendering and device sign-out.
Model replies are deterministic fixtures for isolation, not a live LLM quality claim.

Final main-tree validation, 2026-09-21: `npm run check` passes; `npm test` reports
676 passed, 1 existing platform skip, 0 failures. Thirty Chromium browser checks pass,
including the original Case inspector, conversation switching, narrow-screen evidence
access, focus across resizing, Agent directory and explicit first-use setup.

Real Java Gateway/Core integration passes 10 groups. Two actual Agent/Worker processes
have separate credentials, ports, session stores and Core Boards; one completes while
the other waits. First-use setup does not start either role; the management page sends
no `/mcp` or `/work` request. Sign-out observes process exit before credentials are
cleared and the Gateway refuses their reuse. These use a controlled model endpoint,
not a live model quality test. Final screenshots:
`rulith-java/gateway/target/local-manager-acceptance-9FkFs2/` (1440/1000/390 pixels).

First-use allocation records a non-secret `(origin, accountId, agentId)` intent under
the registry transaction. Reloading before pairing and concurrent retries resume the
same profile. This intent grants no attachment or execution authority. Restart and
wrong-account/origin/scope checks pass. Claude independently reviewed this flow; its
P2 recovery finding is closed and no P0/P1 remains in that review.

No npm publication, production deployment or migration of user files is included.

## Sign-in walkthrough follow-up, 2026-09-21

The user's first-run attempt exposed a gap the happy-path acceptance did not cover:
an undeployed Console returned 404, leaving a pending device record with no code. The
page falsely showed approval controls and hid its address/retry form. Incomplete starts
now show editable address/name, Retry sign-in and persisted failure teaching; they refresh
local state instead of polling approval without a device id. Same-target retries keep the
original request and possession proof, including a lost reply after the server effect.
Old installation imports are under Advanced local settings. A running Agent no longer
claims to be unready solely because its optional Worker is stopped.

Actual in-app browser walkthrough used a local isolated Console account, approved two
Agents, configured the running local Qwen3.8-Flash-Next endpoint, started an Agent, made
three accepted QueryBoard calls, and received the correct remembered marker in a second
turn. Worker startup was independently confirmed. The browser control tool could not
act inside the setup iframe, so the same setup page was opened through its standalone
URL; the workbench mirrored the conversation and role states. No business Actions were
installed in that test Agent, so this is not a business workflow completion claim.

Final npm tests: 679 pass, 1 existing platform skip. One initial concurrent run timed out
in an existing Agent serve test; the isolated test and the full rerun passed without
changing that harness or increasing its timeout. Browser tests: 32 pass. Real isolated
Gateway/Core manager acceptance: 10 groups pass. Claude's background-poll P2 is closed;
closure review reports no regression. `npm run check` and 36 artifact hashes pass.
Manual walkthrough notes remain under `.git/signin-manual-acceptance.md`; no production
deployment or npm publication is included.
