# Changelog

All notable changes to the local runtime are documented here.

## 0.8.8 - 2026-09-23

- Browse conversation history in pages and archive or restore completed conversations.
  Archiving preserves messages and request receipts, and does not cancel a Board Case.
- Store changes per turn; keep the original history during migration and reject duplicate
  or damaged records without silently dropping them. Read history on a separate thread.
- Require an explicit new submission after an interrupted attempt, and explicit consent
  before sending an existing conversation to a different model service.
- Show reconnection state, measured model and Worker adapter time, and provider-reported
  token counts. These are diagnostic measurements, not billing or proof of completion.

## 0.8.7 - 2026-09-22

- Preserve account- and Agent-scoped conversation text across workbench restarts,
  including attachment names. Continue explicitly without restoring Board authority
  or replaying interrupted tasks.
- Save accepted messages before acknowledging them and deduplicate retries. Interrupted
  submissions keep the user's draft and explain why they were not replayed.
- Merge restored and live messages without duplicates; show interrupted turns clearly
  and keep runtime startup out of the conversation list.
- Show earlier document assistant installation conflicts before local preparation,
  with a direct link to the selected Agent's capability configuration.

## 0.8.6 - 2026-09-22

- Load saved document material choices for the selected Agent and Worker binding before
  enabling preparation. Failed or stale reads cannot overwrite existing choices.
- Open a visibly empty new conversation while keeping All activity and earlier sessions
  available for inspection.
- Keep delayed startup notices with their own Agent and role, and clear them only after
  a real readiness receipt or stop. Custom Agent processes without readiness events
  remain usable and are shown as unconfirmed rather than ready.

## 0.8.5 - 2026-09-22

- Let the Agent choose an installed Case Type by default. A hidden `exploration`
  preference no longer overrides document authoring; an explicit user preference still applies.
- Include the rule format and published built-ins in local compilation failure reports so
  the model can correct a draft through the existing checker and artifact tools.
- Report empty or truncated model responses as recoverable failures. Never execute their
  partial tool calls or claim an answer was delivered; preserve existing Case outcomes.
- Distinguish provider-default thinking from an explicit Off or On choice. Preserve that
  choice through account defaults, Agent overrides, copying, and process restarts.

## 0.8.4 - 2026-09-22

- Show an existing Agent key as an actionable connection conflict, including after reopening
  the workbench. Explicit replacement first confirms cancellation of the unapproved attempt;
  an unknown or already approved attempt cannot silently replace another credential.
- Make **Check again** resume interrupted device approval and collect issued credentials.
  Preserve the proof and selected Agent; restart an expired, unapproved request only after
  confirmed cancellation. Open the Agent's workspace once connected.
- Keep pending connections out of the chat frame, and prevent late state responses from
  overwriting the enabled-Agent directory returned by **Refresh enabled Agents**.

## 0.8.3 - 2026-09-22

- Add the local Document assistant workflow with the ordinary `official_authoring@2.0.0`
  capability. The selected Agent uses its own model; the Worker reads UTF-8 text/Markdown
  material and runs pinned Java 25 authoring/kernel checkers on this computer.
- Review immutable checked drafts locally and explicitly save them to the account's private
  authoring library. The control plane verifies the matching certified Case, material and
  proposal; this does not publish a Release or certify business meaning.

- Synchronize the signed-in account's full current enabled-Agent directory. Refresh reports
  newly enabled and disabled Agents, and safely stops local roles for an Agent that was disabled;
  accounts with no enabled Agents remain signed in. Existing profiles, model defaults,
  conversations and Worker isolation remain separate.
- Add **Replace Connection key** for an attached Worker's existing Connection. It requires a
  stopped Worker, verifies the replacement at the fixed Console origin and Agent/Connection
  identity before an atomic local save, and never returns the submitted or prior key.

## 0.8.2 - 2026-09-21

- Configure a default model from the local account menu and optionally override it
  for each Agent. Defaults stay on this computer, scoped to the account and Console;
  existing profiles retain their model settings. Saved API keys never return to the page.
  Switching from inheritance to a separate remote model requires entering its key;
  the account default key is never copied implicitly into that Agent's configuration.
- Guide first use directly to model configuration, with an explicit **Save and start
  Agent** action. Default changes apply when an inheriting Agent next starts; running
  Agents keep their current configuration and Workers never receive model credentials.
- Preserve account and Agent scope across model-editor polling, errors and delayed
  responses. Copying settings resolves the source Agent's effective model configuration.
- When a running Worker's material binding still targets a previous model service,
  ask for a Worker restart before using new attachments. Existing attachments keep
  the model destination originally approved for them.

## 0.8.1 - 2026-09-21

- Simplify browser sign-in: Rulith opens the authorization request directly and
  collects approved credentials automatically, including while the workbench is
  in the background. Operators can reopen the same request when a browser tab is
  blocked or closed; approval codes no longer need to be copied or checked manually.
- Preserve safe recovery when sign-in or acknowledgement fails. Surface the actual
  polling error, retain an unfinished request for retry, and require confirmed
  sign-out before clearing delivered credentials.
- This browser flow requires the matching Gateway deployment's standalone
  **Sign in to Rulith** page. Account login still does not start an Agent or
  authorize a tool.

## 0.8.0 - 2026-09-21

- Add chat attachments and a file picker backed by immutable, per-profile Worker
  material storage. Messages carry metadata; the Agent obtains contents through an
  authorized Action and the existing `ReadArtifact` tool.
- Keep Artifact originals with the Worker. Support negotiated local delivery and
  separately authorized bounded Gateway proxy reads, with current credential/lease
  checks, chunk integrity, explicit offline failures and per-account delivery limits.
  Reading material does not attest its business meaning or authorize remote models.
- Require the matching 0.8.0 Gateway deployment for device management and material
  delivery. Gateway payload storage and its upload route are retired; historical
  Artifact payloads are not migrated. Existing account identities are preserved.
- Handle maximum binary and UTF-8 material response windows, reject corrupt UTF-8
  tails and redirected material directories, and clear confirmed local Agent identity
  when its process exits. PDF/DOCX extraction and the complete local document-authoring
  assistant workflow are not included in this release.

- Recover incomplete device sign-in with an editable Console address and an explicit retry; retain request proof, show useful errors, and avoid polling approval before a code arrives. Keep old installation imports in advanced local settings.
- Treat a running Agent as ready for conversation while its optional Worker is stopped.

- Rename the local product to **Rulith**, a local multi-agent workbench. Keep the
  original three-column interaction: Agents on the left, the selected conversation
  in the middle, and its Case and Worker activity on the right. Both content columns
  switch together; the selected Agent's controls live in the left rail. Adopt Console's
  gray surfaces, blue accents and restrained controls.
- Anchor the account entry at the lower left. Present conversation as prose and compact
  expandable activity lines; reserve stronger containers for errors and required input.
  Embedded pages confirm their own readiness instead of treating any HTTP body as a
  loaded workspace, and stopped/replaced hosts do not retain stale conversation frames.
- List the device's authorized cloud Agents directly. First-use setup belongs to the
  selected Agent; local configuration recovery and legacy import live in account settings.
  Directory and device management stay on the control plane, separate from `/mcp` and `/work`.
- `rulith` opens one page for a browser-assisted account sign-in
  and for independent Agent instances on one computer. Each instance keeps its own
  configuration directory, MCP state, tool manifest, workspace, unresolved-call store,
  ports and loopback key; selecting one never starts, stops or re-keys another, and a
  running process never changes identity. Starting a role and changing its setup are
  checked against the current device grant, including from the instance's own page.
  Signing out stops every child, revokes the device grant, then clears the credentials
  that grant issued — and reports an unfinished step as incomplete rather than as a
  sign-out. Copy model settings between instances without re-entering a provider account.
- Start or stop the selected Agent and Worker independently. One workbench owns an
  installation directory; shutdown rejects new work and waits for already admitted
  operations. Surviving children block credential cleanup until their exit is observed.
- Offer to import an existing single-instance installation as an unpaired profile in its
  own directory: its model, tool, MCP and resource settings are copied, its Agent and
  Worker credentials are not. Those stay with the original installation, which keeps
  running under `rulith start --legacy` under its own authority — revoking this device
  does not revoke them. The original is never moved, rewritten or deleted.
- End the Agent and the Worker when the Rulith Local host that launched them exits, so a
  killed host cannot leave an authenticated role running that nothing on the machine
  knows about. Nothing in flight is reported as cancelled.
- Refuse a configured MCP server whose working directory, executable or file/directory argument
  overlaps Rulith's own configuration and credentials — in the stdio and registry options
  as well as the Filesystem one, which alone used to check. Rulith runs tool servers as the
  operator and cannot confine them; this closes a configuration bypass and says so rather
  than claiming to be a sandbox.
- Keep the single-instance mode reachable by the command an existing deployment already
  runs: `--legacy`, `--config <file>`, `RULITH_LOCAL_CONFIG`, or naming roles with
  `--role`.

- Clarify that an announced action must include its actual tool call and that
  tool results should lead to an answer, a concrete blocker, or a necessary question.
  Answer greetings and general questions directly; preserve the existing multi-turn
  transcript, serial tool loop, and unresolved-call recovery behavior.

## 0.7.5 - 2026-09-16

- Add `rulith setup`: pair Local with a Console-approved Agent using a short-lived
  code, then review resource and tool authorization separately in Console.
  Support both a locally configured model and an existing MCP client.
- Render conversation Markdown and show expandable actual tool arguments and
  results, with explicit unknown outcomes, handoffs and bounded previews.
- Refresh authorized Source metadata before claiming work for a newly bound
  Source, so Worker can start before resource authorization completes.
- Require the matching Gateway/Console cross-end setup release (`3826121`).
  Preserve existing Local identities and require explicit Agent token replacement.

- Preserve OpenAI-compatible provider reasoning continuation across tool calls and
  subsequent turns. Honor explicit thinking disablement; malformed conversation errors
  no longer silently switch the Agent into emulated tools. DeepSeek Flash uses this path.

- Refuse required JSON inputs before saving automatically generated grounded MCP
  write/run Actions; explain the affected parameter and preserve JSON reads and
  optional scalar inputs. Show the same limitation for built-in and manifest tools.
- Disable unsupported write/run choices during discovery without reclassifying
  tools or changing capability-authored contracts. Requires the matching Gateway
  authorization correction; existing installed releases are unchanged.

## 0.7.4 - 2026-09-15

- Manage every Worker tool from one Local page: built-ins, manifest definitions and
  selected MCP tools, with validation and stale-edit protection.
- Search the official MCP Registry, inspect supported setup, and install pinned npm
  services or connect supported HTTP services. Filesystem uses the same configuration flow.
- Show package download periods, installation requirements and Registry update dates;
  filtering and sorting apply only to loaded results, with unavailable metrics explicit.
- Keep MCP configuration and credentials local. Operators review tool classification
  and authorize the downloaded Source definition in the matching Cloud Console.
- Require the Gateway/Console generic MCP Source support introduced in `87058e6`.
  Raw MCP output remains material; installation does not certify facts or authorize writes.
- Include the outbound MCP transport work prepared under the existing 0.7.3 source tag;
  that tag is preserved and does not identify this release's expanded Local interface.

## 0.7.3 - 2026-09-14

- Implement outbound MCP initialization and session reuse with the pinned official SDK,
  local stdio processes, Streamable HTTP JSON/SSE, paginated discovery and structured results.
- Keep process configuration and credentials in the local Source vault. Apply bounded
  time/bytes across each operation and refuse protocol-header overrides and redirects.
- Preserve unknown executions when MCP replies are lost or cannot supply required facts;
  never automatically resend an external call. Close managed MCP processes on Local stop.
- Verify interoperability against independent SDK servers and the actual Java/Local chain.

## 0.7.2 - 2026-09-14

- Renew the current Worker lease while an idle long Poll waits. Poll admission reuses
  the existing lease; it does not extend its expiry. Quiet model thinking must not
  leave the Worker without a lease just as verification work arrives.
- Refuse a late Poll answer after a concurrent renewal lost the lease. No work is
  claimed from that answer, and existing unknown executions remain unresolved.

## 0.7.1 - 2026-09-14

- Read Java Gateway Board Views without losing other focused Cases.
- Preserve each accepted Case closure in CLI, conversation and Local task summaries;
  a final cancellation no longer hides an earlier completion. Mixed outcomes remain explicit.
- Remove obsolete exploration-only rule permission and lifetime claims from the model prompt.
- Report a Case closed on the final conversational round without a false round-limit warning.
- Present concrete schema field shapes to Chat Completions model services, preserving
  the original MCP constraints, recursive references and exact-number guards.

- Align Verified Calculation onboarding with platform Capability 1.0.2 and declared Board
  bindings. Remove the obsolete client-owned recipe; published releases remain immutable.
- Send Worker v2 verification reports using outcome alone, without the retired ok field.
- Use the existing `setup.mjs` as the single example preparation entry. It verifies and copies
  bundled assets when run from npm, or downloads only the five example assets when standalone.
  Agent, Worker and Local continue to run from the complete npm package.
- Prepare one empty, private Local configuration beside the example data directory, with
  absolute Worker and manifest paths. Existing files and credentials are never overwritten.
- Retire the separate `prepare-runtime.mjs` and `prepare-local.mjs` helpers. The guide now
  starts the Worker before Source binding, then restarts it with the Agent to run the Case.
- Correct the Worker manifest error example to use `sourceTypes`.
- Restrict the example Source to its three Capability Actions; generic file browsing is not enabled.

## 0.7.0 - 2026-09-04

Published to npm with immutable tag `v0.7.0`. This is a breaking
change to the model surface: an integration that scripted the previous fenced-JSON
dialect will not work against this runtime.

- Local action Adapters receive `RULITH_EXECUTION_KEY`: `rulith-execution/1:` followed by
  SHA-256 of the UTF-8 JSON array `[boardId, invocationId]` from the authenticated work item.
  It is stable across retries and Worker replacement, and separates Board-local invocation
  names in shared business storage. The raw invocation ID remains available; neither identity
  grants permission or selects a Case. No model tool or Worker wire field is added.

- A database run Adapter receives its selected Source's local DSN through the existing
  `RULITH_SOURCE_ACCESS` context. The DSN is no longer rewritten as a filesystem path;
  Source-free actions receive neither a borrowed DSN nor a Source type.

- Worker action rows now require the actual Source's Artifact permission and the deployment's
  bounded storage policy. Large results are uploaded through the private Worker data path before
  a receipt references them; required business facts retain their original values. Upload failure
  and output capture overflow leave the invocation unresolved for fenced manual reconciliation.
  The former silent 4,000-character result truncation is removed. Gateway adoption is required.

- **Rulith Local confirms a role start; it no longer times one.** `/control` used to sleep a
  fixed 350 ms and then ask whether the child was still running. That answered the wrong
  question in both directions: on a busy machine a child that exits immediately has not exited
  yet at 350 ms, so the operator was told `200 {ok:true}` about a role that was already dying;
  and a role that legitimately took longer than 350 ms to finish initializing was never
  confirmed, only assumed. The evidence is now the readiness event each role already sends —
  the Agent's `start` once its task endpoint is listening, the Worker's `up` once its Tool
  Manifest is loaded — raced against the child's own exit. Each role's own answer is taken as
  it is: a Worker whose Source fetch fails comes up anyway and is confirmed started, while the
  Agent establishes its MCP session before it serves and an unreachable Gateway therefore
  arrives as `exited during startup`. A program that neither reports nor exits is answered
  `202` with `state: "unconfirmed"` rather than as either success or failure, because an
  operator may point `paths.*` at anything and neither verdict would be true.
- **A stop is a request, and Rulith Local no longer reports it as an outcome.** `child.kill()`
  sends a signal; on POSIX the child decides what to do with it and may keep running. Three
  statements were wrong whenever it did. A stop answered `state: "stopped"` the moment the
  signal was sent, so a child that ignored it was reported as stopped and still listed as
  running one refresh later. A child that answered the signal by sending its **readiness**
  event confirmed the very start the operator had just cancelled — `200 {state:"ready"}` for a
  process that was going nowhere. And the cancellation teaching said the role "is not running"
  without having seen it exit. Now the exit this host already receives is what decides: a stop
  that observes one answers `stopped`, one that does not answers `stopping` and says so;
  readiness is no longer recorded for a child whose stop has been requested, so a late report
  confirms nothing; and every teaching distinguishes what was asked from what was observed.
  **Nothing is escalated** — no second signal, no forced kill, no supervisor. Whether a process
  that refuses to leave should be forced is a decision this host does not make, and reporting
  it accurately is what lets somebody else make it.
- Local separates Case lifecycle, acceptance and observation freshness. These fields
  come from one bounded authority response, not conversation completion events. A
  detached conversation keeps its last observed Case state; transport ambiguity and
  missing fields are shown explicitly. Refused openings cannot select a new Case.
- An MCP result reporting a lost upstream response preserves the original request
  identity on an identical retry, just like an HTTP transport failure.
- The model now speaks six tools as ordinary MCP tools — `OpenCase`, `ApplyBatch`,
  `ApplyAction`, `CloseCase`, `QueryBoard`, and the artifact read `ReadArtifact` — and
  nothing else. Membership, dispatch targets, the protocol version, the metadata namespace,
  the declared client capability and the recovery states are all **generated from
  `protocol/mcp-contract.json`**: the contract bundle exported from a named commit of the
  contract repository and verified against its Git objects before vendoring. The Agent
  ships as one file, so the projection is compiled in rather than read from a sibling at
  startup, and `npm run check` regenerates it and fails on drift. A missing bundle is an
  error; there is no hand-written membership to fall back to. The retired handwritten
  `agentVerb` / `agentRead` membership fields are gone. The Runtime performs
  the MCP handshake, reads `tools/list`, and offers exactly those six; a tool call by any
  other name is refused locally and never reaches Cloud. `ReadArtifact` is served by the
  Gateway's result data plane rather than by a Board operation: it returns a bounded
  fragment, a media type, a continuation position and an end/truncated state, and it
  creates no Case, writes nothing and changes no focus.
- The protocol baseline is **MCP 2025-11-25**, and it is a contract rather than a
  greeting: an endpoint that negotiates another version is refused at the handshake,
  before any business runs. The client declares what it actually implements in
  `initialize.capabilities.experimental["rulith/v1"] = {serialRecovery: 1}` — a
  compatibility declaration, not an authorization.
- Streamable HTTP responses are **resumable**. Each SSE event's `id:` is kept as a cursor,
  and a stream that breaks before the answer is reopened with `Last-Event-ID` so the
  original answer comes back; the request is never re-issued, because re-issuing would turn
  one command into two. A stream that cannot be replayed leaves the outcome unknown, which
  is what it is — never an empty answer.
- `HTTP 409` with JSON-RPC `-32000` and `data.reason = "connection_replaced"` is read as
  what it is: another authenticated client is now this Agent's one effective client. The
  Runtime stops with its own exit status and does not reconnect. A 409 for any other reason
  is not read as a takeover, and `HTTP 404` — the transport session is gone — is answered by
  initializing a new session, which says nothing about whether the call made under the old
  one executed.
- The fenced-JSON grammar is gone: no `{"tool":"rulith",…}` envelope, no first-block-wins
  parsing, no `DONE:` / `STOP:` / `VIEW:` reply protocol, no `start_case` / `apply_batch` /
  `request_action` / `finish_case` / `read_case` / `pause_case` / `resume_case`. Pause and
  resume remain host features, reached through `--case` and the Local UI.
- Native tool use on both provider shapes: Anthropic Messages (`tools` with
  `input_schema`, `tool_use` blocks, `tool_result` replies) and OpenAI Chat Completions
  (`tools` with `function.parameters`, `tool_calls`, role `tool` replies). An endpoint
  that rejects tool definitions gets the same schemas described in the prompt and answers
  with one JSON object; `RULITH_MODEL_TOOLS=emulated` selects that transport up front.
- Conversation and `--task` autopilot are one loop with two policies rather than two
  loops with two grammars. Autopilot nudges once with the lifecycle the Board reported,
  and stops when no focused root is still running, on an explicit close, or on the round
  budget. Deterministic discharge, bounded waiting and closure mechanics belong to Cloud
  and the Board; the Runtime runs no second wait or discharge state machine, so
  `RULITH_AUTO_DISCHARGE` and `RULITH_SETTLE_WAIT_MS` are gone.
- Every tool result carries the bounded Board View, so the Runtime no longer keeps a
  projection of its own, no longer budgets attention locally (`RULITH_ATTENTION_FACTS` is
  gone), and no longer ranks the grounding floor against a local table of tiers — an
  unknown tier used to read as the weakest, which is a silent downgrade.
- One system prompt of about 150 words replaces three prompt families and their guides.
  It carries no JSON templates; the advertised schemas are the templates. Available
  Actions and Source routes reach the model through the Case View instead of a
  prompt-side catalogue that was a second, staler copy of the Board.
- A one-shot run now prints its own verdict on the terminal, and reports success from the
  loop's outcome rather than from the wording of that sentence.
- A JSON-RPC answer is checked against the request it answers: `jsonrpc` must be `"2.0"` and
  the id must match by type as well as value. A response under a different id used to be
  consumed as the answer to the handshake and the run continued to the model. SSE bodies are
  read as Streamable HTTP specifies — one event ends at a blank line, its `data:` lines are
  joined, server-initiated messages ahead of the response are skipped, and the read finishes
  on the matched event rather than waiting for a close the spec only recommends.
- The advertised tool membership is a contract. An extra, duplicated, missing or retired name
  is now a refused protocol mismatch that names both surfaces; it used to be filtered down to
  the approved list in silence, which is a client deciding for itself what the server meant.
  The list is read to the end when the endpoint answers `tools/list` in pages, so a paged
  surface is not judged from its first page.
- A session id is adopted only from an answer this client could read and correlate, and only
  during the handshake. A command sent under one authenticated session and answered under
  another leaves its outcome **unknown** — that is not a metadata refresh, and treating it as
  one made an unresolved write look settled.
- A local read limit and a mis-addressed answer are reported as their own kinds of unknown
  (`response_too_large`, `response_not_correlated`) rather than as "the authority never
  answered". All three hold the request identity and none of them is a refusal.
- An unresolved request identity is never evicted to make room. The ledger used to drop its
  oldest key, and since resolved entries leave immediately the oldest was always something
  still in flight — a retry then minted a fresh id and a write that may have landed could be
  applied twice. At the ceiling the runtime now refuses to send. Unresolved identities are
  persisted (write-then-rename) and **named** at the next startup; nothing is re-dispatched
  automatically, and with `RULITH_SESSION_FILE=off` the runtime says plainly that an
  interrupted write must be resolved in Console instead.
- Host metadata is projected out of advertised schemas at the envelope boundary only. The
  previous depth-first strip deleted business properties that merely shared a name — a
  business `sessionId` inside a batch operation, a business `case` inside an Action's
  arguments — so the model could not send an argument the authority required, while a model
  that nested the same name one level down was not refused either. A server schema that makes
  host metadata *required* is now refused rather than quietly rewritten.
- One endpoint, `/mcp`, for every client. The host-only surface one path deeper is
  physically gone, and with it the bounded-view host tool and the protocol passthrough
  that reached the whole Board operation registry under the Agent's own credential. A
  surface a third-party client cannot reach is a surface nobody audits; first-party and
  tools-only clients now share one path, one tool list and one set of refusals. The client
  also no longer uploads a trace to a second cloud channel.
- Agent identity comes from the authenticated MCP handshake — `_meta["rulith/v1"].agentId`
  on `initialize` or `tools/list`. It is not decoded out of the bearer secret, and no
  bootstrap Board query is issued to learn it. Ordinary conversation, including startup
  and a plain greeting, touches the Board not at all.
- Host metadata travels only in the MCP `_meta` block under `rulith/v1`: the Agent
  identity, the observation token, the Board revision, the `{caseId, root}` focus pairs
  and the complete affected-Case list. It never enters model content or a tool schema. The
  client echoes back only what the authority returned, and never fetches a token before a
  write. The retired `case: {id, expectedRevision}`, `caseRevision` and
  `expectedBoardSharedEpoch` wire is stripped from advertised schemas and refused visibly
  if a model sends it, rather than executing under a guessed contract.
- **One authenticated MCP connection for the Agent**, and one serial entry through it.
  Local conversations, `--case`, the Local UI and the shadow reviewer all share it; a
  conversation is a transcript and a queue, not a client of its own. Cross-conversation
  concurrency is gone with the per-conversation sessions that made it look possible —
  `RULITH_SERVE_CONCURRENCY` no longer exists, and Local no longer advertises a
  "max concurrent Cases" setting nothing enforced. Two conversations that each opened a
  session were not isolated: the second took the Agent over and the first's next call came
  back `connection_replaced`.
- The transport key is **(Agent, MCP session, JSON-RPC request id)**, and the retired
  body-keyed table of unresolved submissions is gone with the promise it made. It re-sent a
  body under an old request id after the session had changed and told the model this reached
  "the same identity"; under a different session it is a different logical call, so a write
  that had landed could land again. One record replaces the table — calls are serial, so
  there is one thing to remember — and it records the session it was sent under, which is
  what lets this host say the call cannot be re-presented rather than pretending it can.
  The 256-entry ceiling that could refuse every further call is gone with it.
- A local unresolved call and an authority reporting nothing outstanding is a **conflict**,
  not a resolution: an empty recovery record is a statement about the Gateway's records, not
  about the world. The call is named with its request id for reconciliation in Console, and
  work stops until then. A missing recovery record is likewise refused rather than read as
  "nothing outstanding".
- When the authority answers a request the model made by handing back an *earlier* call's
  outcome, the **result itself** becomes that statement — `accepted: false`,
  `requestExecuted: false`, the tool the outcome belongs to, and that outcome kept whole
  beside it under `earlierResult`. Rewriting only the model-facing text was not enough:
  `--case` and the shadow reviewer judge by the result, and with the earlier verdict still
  in it they announced a focus that had not happened and a finding that was never written.
  A `--case` focus answered with a handoff now claims no focus, re-sends nothing, and hands
  the outcome to the model; the shadow reviewer reports its finding as not written rather
  than as rejected. It used to be handed back unlabelled, so an
  earlier `ApplyAction`'s `accepted: true` read as this `ApplyBatch` succeeding — with no log
  line, no event and nothing in what the model could see. The rest of that turn's proposals
  are not carried either. `isError` on the result is now load-bearing: a handoff marker
  without it is two channels disagreeing, and the outcome is unknown rather than either.
- The mechanical claim has a transport identity of its own. Deriving it from the request
  body made it collide with the model's own `QueryBoard` safe default, so the claim inherited
  the in-flight request id and the handoff never happened.
- `tools/list` is read to the end when the endpoint pages it, the session is terminated with
  `DELETE` when this client is done with it, and a resumed stream shares the original call's
  deadline and backs off between attempts instead of adding windows of its own.
- A conversation holds a set of acceptance roots with independent lifecycles, not one
  active Case. Focus pairs come from Core and are never derived locally; Case-id minting
  moved to Core; Local shows every root with its own status; leaving focus is not a
  lifecycle transition, and a stopped model turn is not a paused Case.
- **The observation layer is gone**: no `viewToken`, no observation ledger, no
  `stale_observation` / `scope_expanded`, no first-write bootstrap exception. A write
  presents no view and pins no revision, and the authority judges it against the premises,
  grounding and policy in force when it executes. `viewToken` joins the retired wire
  fields: a model that names one is refused visibly rather than quietly stripped. Board
  revision remains an audit string and is never a precondition.
- **One call at a time, and the authority says when the last one is over.** Several calls
  proposed in one model turn are executed in order, each completing before the next is
  sent — not reduced to the first, which looked serial on the wire while quietly declining
  work the model had proposed. When a call's outcome cannot be determined the queue stops
  there: from that point nothing is sent for this Agent — no write, no `QueryBoard`, no
  `ReadArtifact` — and the model is not asked to decide anything.
- Recovery is read from the authority over the base protocol's own `ping`, whose empty
  result carries a record under `rulith/v1`: `none` proceeds, `waiting` waits on the
  authority's own hint, `result_ready` collects the earlier call's outcome with exactly one
  claim that executes nothing, and `reconciliation_required` stops automatic recovery and
  points at the operator's reconciliation. A state this Runtime cannot read blocks rather
  than reading as "nothing outstanding". No model tool was added for any of it, and nothing
  is polled for when the handshake has already said there is nothing outstanding.
- A recovered outcome reaches the model as a labelled **host-recovery note in the user
  channel** — never forged into an assistant tool call the model never made, and never
  disguised as a message from the user. An authoritative refusal is still never replayed by
  the host. The request identity is the JSON-RPC id the Gateway maps onto one Core request,
  and it is held for exactly as long as the outcome is unknown. The model is no longer told
  that choosing the same step again "reaches that same identity": since the key includes the
  session and every submission mints a fresh id, that promise was false, and a host may not
  claim a de-duplication across a model's new intent. What it is told is that the original
  call is settled at the authority and anything it chooses next is a new command.
- The durable store (`RULITH_SESSION_FILE`, `off` to keep none) now holds one thing:
  submissions whose outcome is unknown. The MCP session id is not written there and not
  restored — the session comes from the `Mcp-Session-Id` response header alone, and a
  restarted process is a new authenticated client that takes over as one. Focus and the
  last Board revision are not persisted either.
- Local shows the unresolved call beside the Cases in focus: its state, which tool it
  concerns, and what the host is doing about it.
- Exact-or-fail at the first membrane: a tool call whose arguments carry an integer beyond
  ±9007199254740991, or a non-finite number, is refused locally with a teaching before
  anything is sent. The look is on the text — the Chat Completions `arguments` string, the
  Messages response body, the emulated reply — because `JSON.parse` has already rounded
  such a literal by the time a value exists. A literal that underflows to zero (`1e-400`)
  is refused the same way.
- **The Worker hop is the v2 one**, vendored from the contract repository's own commit as
  `protocol/worker-contract.json` and compiled into the Worker the way the Agent compiles
  its surface. `caseId` and `caseRevision` are gone from poll, claim and report — Case
  identity is the Gateway's authenticated envelope against Core, and which Cases an
  execution advances is the shared graph's answer — and a work item that still names one is
  refused before the executor runs. What identifies a hop instead is the instance and the
  fencing generation it holds, in the two protected headers and in the operation.
- **A Worker instance is random per process.** `RULITH_WORKER_ID` is gone: a configured
  label was shared by two processes started from one copied Connection secret, and was
  inherited by a restart from the instance it replaced — both of them the identity a fence
  exists to retire.
- **`Poll` is the whole inbox surface**, and the only verb that takes the line. It states
  the instance, the Tool Manifest and — only under a held lease — that lease's generation;
  the acquiring poll of a fresh process states none, because it has never been given one,
  and a resend of that startup request keeps the same instance identity so a lost answer
  costs no generation. A refused poll drops the lease and the next poll acquires again:
  admission is decided against the lease the Gateway holds, so restating a refused
  generation would be refused for the same reason forever. Core's internal `ListWork` has
  no Worker-facing alias.
- **The Tool Manifest rides on every poll**, so a reconnecting Worker re-states what it has
  with no separate registration call to fall out of step with. Three local gates that
  refused legal declarations are gone: an empty `sourceTypes` declares a Source-free Tool,
  an empty `returns` declares a Tool that deliberately attests nothing, and a `returns` row
  with no arguments lands a bare proposition. Each had been refused here as though the field
  were missing, which is a downstream availability condition borrowed to reject a report —
  an operator with a Source-free Tool had nothing truthful to write. A Source-free Tool is
  advertised and, until a work-item shape that omits the Source exists, refused at dispatch
  under its own name rather than by standing the Connection in for the Source.
- **The host's environment is no longer a database Source.** `handDbQuery` / `handDbExec`
  fell back to `RULITH_DB_URL` / `DEMO_DB_URL` when the selected Source carried no DSN — and
  a Source-free dispatch resolves no Source at all, so the fallback fired every time. A Tool
  declaring `sourceTypes: []` could read and write the host's database and land its `returns`
  facts under `sourceRecordId: ""`; `db-exec-fenced` committed constructive statements
  (destructive ones were still held by the classifier, a different fence, unchanged). The
  fallback is removed rather than special-cased: a database Tool runs against the DSN of the
  Source the invocation selected, and no DSN for that Source is a refusal that names it. A
  Source-free dispatch into a *locating* Adapter is refused while the Tool is compiled, which
  is before the claim, so no dispatch is recorded for an execution that was never possible.
  The two variables keep their place in the Adapter environment deny-list; nothing may read
  them, which is a separate protection.
- The database Adapters now take the Source table the caller passed, like every other
  Adapter. They read the module global instead, so a caller who supplied one was ignored and
  the host environment answered in its place.
- `source` is a **reserved argument name**. It is the invocation's Source selector, stripped
  before the declared parameter table is checked, so a Tool declaring it published a slot
  that could never be filled — a caller who supplied it was told the argument was missing,
  pointing at one the invocation plainly sent. Refused at declaration and at dispatch, the
  same way a database Tool's `sql` slot is.
- Case identity is refused for **all four work types** at the one door they arrive through.
  It was checked in two arms, and in one of those it sat behind an early return, so a
  verification row nothing handled was dropped in silence while still carrying the field.
- A review is not started without a lease, and the lease is read **before** the re-review
  interval is recorded. A batch arriving in the tick where the lease had just gone used to
  spend the interval without reviewing anything, delaying clearance by up to twenty seconds.
- The contract projection **fails loud** on a definition it cannot carry whole: a conditional
  or a constraint it does not read would otherwise be dropped in silence, leaving the Worker
  under-enforcing while `npm run check` stayed green. The grant's `const` fields are compared
  per field name, like the action row's, rather than every one of them against the version.
- **The dispatched action row is checked against the contract's closed shape**, before the
  claim: every mandatory field present and of the stated kind, and nothing else carried at
  all. The row's `connectionId` is compared against the Connection this process authenticated
  as rather than merely ignored — a row must not be able to tell a Worker whose line it is on
  — and `toolDigest` is mandatory, so "no pin stated" can never read as "pin matches".
- **One name per thing on the action row.** `work` is the invocation and `tool` is the
  Action; the request vector is built from those alone. The old `invocationId ?? work`
  fallback meant a row could digest one way here and another way at the signer, so
  `invocationId`, `actionId` and a structured `grant` beside the signed token are now refused
  as shadow spellings — before the claim, because a claim is a dispatch recorded on the Board.
- A grant is matched against the **Adapter pin of the local Tool that would run**. A real
  process ran an Adapter once under a grant whose `adapterDigest` was all zeroes, because the
  row's own `toolDigest` matched the local install and nothing compared the licence's copy:
  two different claims by two different parties, and only one of them was being checked.
- **Source-first selection.** A Tool declaration states which Source *types* it accepts; the
  invocation names the instance in its own `source` argument. The static `toolSpec.source` a
  package pinned into its own declaration is retired and read under no name — it made the
  governed Source record a decoration. The named Source must be the record the row was
  dispatched against and an authorized Source of an accepted type on this Connection, and the
  three ways that can fail are refused under three names (`source_free_has_source`,
  `source_selection_required`, `source_type_mismatch`) rather than one. An empty `sourceTypes`
  is a Source-free declaration: nothing is resolved and no credential, root or endpoint is
  manufactured; a `run` Adapter may still execute as pure local compute under the Tool
  authorization it already holds, while an Adapter that needs a DSN or an endpoint still
  cannot. The selector is read out of `args` and stripped from what the Adapter sees; the
  served string the grant's digest covers is never rewritten. A Source-free dispatch is
  refused for carrying **any** `source` argument, including `""` and `null` — presence is the
  rule, not truthiness — and a `toolSpec` that states no `sourceTypes` at all is a malformed
  dispatch rather than a Source-free one: the local definition is no longer consulted, because
  what this machine has installed is not what the authority declared. An empty `args` string
  is likewise malformed; an absent argument set is served as `"{}"`, so the empty case already
  has a value and this Worker does not supply the one the authority failed to send.
- **The shipped Verified Calculation example follows the same rule it demonstrates.** Its
  three Actions pinned one Source instance in the retired `execution.source`; they now
  declare `"sourceTypes": ["file"]`, and each invocation names the bound instance in
  `args.source`. Nothing could be seeded from the old contract — the authority refuses a
  declaration carrying that field — and nothing could have run from it either: a dispatch
  built from it states no `sourceTypes`, which this Worker refuses as malformed. The intake
  Adapter no longer demands `RULITH_CASE_ID`. That name is not part of the Worker hop, so it
  refused every real invocation; on a machine that happened to carry the variable it did not
  refuse but rooted governed task structure at an operator's string. The task seed's root
  now comes from the `batch_id` the input file states, which `data/input.json` therefore
  carries — an input file from an earlier run is refused by name rather than given an
  invented root. `examples/verified-calculation/README.md` teaches `ApplyAction` rather
  than the retired `request_action`, and names the Source in `args` the way the tool
  schema says. It also states what an isolated Core + Gateway + Worker run showed the flow
  actually requires: a Source-bound Action carries its Source selector **and** its business
  values (the board-binding path runs only for an invocation carrying no arguments at all,
  and each stated value is re-checked against a fact grounded `attested` or stronger), and
  the task node the Source seeds is attached to the open Case with one ordinary `ApplyBatch`
  — without it every Action succeeds, the acceptance atom derives, and `CloseCase` still
  answers `case_not_certified`.
- **The `RULITH_` namespace belongs to the runtime, and a `run` Adapter receives from it only
  what the work item decides.** Every ambient `RULITH_*` variable is now stripped before an
  Adapter starts, on the deny path and against an `env.pass` allow-list alike; `handRun` then
  supplies `RULITH_INVOCATION_ID`, `RULITH_SOURCE_ACCESS` and `RULITH_SOURCE_TYPE`. This began
  as a list of three names, which was one entry per known problem and no rule at all — two
  leaks survived it. A **retired** one: Case identity left the Worker hop, so nothing can
  supply `RULITH_CASE_ID`, yet an ambient copy still arrived where an operator's string could
  be read as a Case. And an **invented** one: an Adapter reading `RULITH_CALC_INPUT` for its
  own path takes a location from whatever set that variable and reports what it finds there as
  Source material. Neither is a name anyone would have added to a list in advance. Names
  outside the namespace are untouched.
- **The example Adapters read and write the granted Source root only.** All three took their
  paths from `RULITH_CALC_INPUT` / `RULITH_CALC_OUTPUT` and, failing that, from a directory
  beside the script. Both are gone: the Source root the Worker hands over is the only location
  they have, and an Adapter granted no Source — or one whose type is not `file` — refuses by
  name instead of finding a file of its own. A Source-free dispatch can no longer read
  *something* because a fallback existed.
- **One unusable row no longer swallows the batch.** A refusal thrown while handling one item
  used to escape the whole loop into the poll catch: every other item was dropped and a
  work-item defect was printed as `Polling failed (…)`, on a row the endpoint re-sends every
  round. Each item is now isolated; a rejected Connection credential is the one fault that
  still ends the process.
- **The execution grant is verified on the path it actually arrives on.** The Gateway sends
  `executionGrant` as a signed token; this Worker used to check a structured mirror no
  Gateway has ever sent, and its first line passed when that mirror was absent — so the
  instance, generation and request-digest comparisons were unreachable in production while
  the tests around them were green. The token is now decoded and its HMAC checked in constant
  time with the Connection key already held, the payload is held to the contract's own
  `ExecutionGrant` shape with an exact key set, and every field is compared against what this
  Worker knows independently. Unreadable or unmatched means not claimed and not executed;
  there is no optional shadow and no default-allow.
- **A lost lease stops the batch and keeps the receipt honest.** The batch was handed over
  under one lease, so each following item is checked against the line as it is *now*: after a
  loss the leftovers are left unclaimed and said out loud, rather than a claim going out with
  no generation on it. The work that did run reports under the generation it was dispatched
  under, captured at the claim — a receipt that dropped it was this Worker awarding itself a
  permission it no longer had, and the Gateway cannot judge a field that was not sent. Long
  verification, material and review calls hold the same three things: a lease to work under,
  that lease renewed while they run, and the captured identity on their report. A rejected
  credential during a background renewal is caught rather than surfacing as an unhandled
  rejection mid-execution, and stopping renewals waits for one already in flight.
- The Tool id pattern, pin form, effect classes, parameter types, accredited Source types
  and the Manifest ceiling are now **read out of the contract** into the Worker's generated
  projection instead of being retyped in the source. A hand-written copy of an enum is a
  second source of truth, and the one that goes stale is the local copy.
- **The vendored bundle is closed and its pins are recomputed.** The carried file set must be
  exactly the three files this Runtime reads — an extra key used to be carried, published and
  hashed into the artifact manifest with nothing checking its digest or its provenance — and
  every `gitBlobOid` is recomputed from the bytes beside it rather than read back. When the
  contract repository is on this machine the ids are compared against the commit itself; a
  repository that is present and cannot resolve that commit is a **failure**, deliberately not
  collapsed into the ordinary "no repository here" case, because treating the two alike is how
  a pin to a commit that does not exist passes as verified.
- **No lease, no work.** A confirmed active `Lease` is what admits claiming, executing and
  changing what a Worker advertises; the Worker judges it against the contract's own
  definition, including the two conditions the shape cannot state (a real window, and a
  heartbeat strictly shorter than it) and calendar values that only look canonical.
  `RenewLease` keeps one long execution's lease alive and never acquires one; a refused or
  unreachable renewal stops this instance taking further work rather than assuming it still
  holds anything. `ReleaseLease` on shutdown says this instance is finished — never that an
  invocation already dispatched did not happen — and an unknown answer stays unknown.
- Execution digests are computed by the contract's own `rulith-execution-canonical-json/1`
  and checked against its committed vectors: key order by UTF-16 code unit at every level
  (never a collator), omitted result/reason/facts/artifacts resolved before digesting, and
  `args`, `target` and `toolSpec` left as the exact strings Core served. A Source-free
  execution digests `sourceRecordId: ""` — an empty value, never the Connection standing in
  for a Source. A `v2` grant naming another instance, an older generation or another request
  is refused before the hand moves.
- Artifact production stays **off**: the strict reference and permission boundaries are
  implemented and tested, and no object bytes leave this machine. Only an explicit granted
  Source permission would admit them; `denied` and `absent` — including the Source-free case
  — are refused under their own names, and an over-limit or unknown result is neither a
  success nor something to retry.
- Nothing here reads an unpublished authority field as a control input. The `lawLocked`
  prompt line, `receipt.disposition`, `receipt.invocation` and `payload.done`/`ok` are gone:
  none of them is in Core's published result envelope or Board View, so each was permanently
  absent against the real authority while looking like a working feature. A dispatched
  Action's progress now reports its gap explicitly — the Agent Profile has no field carrying
  an invocation identity — rather than leaving the Worker panel to read as idle.
- Truncation is read from the carriers Core actually publishes: per-limb `cases.truncated`
  and the top-level `truncated`. An earlier draft of this client read an aggregate `loss`
  object that a Core draft proposed and the published schema does not contain, so against the
  real authority it saw no truncation at all and presented a partial view as a complete one.
  A focused root that a bounded answer did not reach keeps its previous status **labelled as
  not refreshed** instead of being republished as freshly observed.
- Worker Tools have one standing (board-spec TOOL-08). A built-in and a Tool-Manifest
  entry are advertised in the same descriptor — `id`, `digest`, `sourceTypes`, `kind`,
  `params`, `returns` — on the startup banner and in the poll body alike, so a host can
  synthesize a governed Action for either. `returns` is the result-fact mapping — the
  same `[{predicate, args: {fact_arg: "$column"}}]` a Capability Action uses and the Board
  installs — never a column table. The built-in workspace and MCP-discovery Tools state
  the parameter tables their handlers have always had and map their rows onto
  `rulith.worker.*` facts, each carrying `source` so rows from two Sources of one type on
  one Connection stay apart; their digests cover the definition those are derived from,
  so no Connection pin moves.
- The Worker no longer filters its own advertisement. A Tool absent from the id list
  Cloud returned beside the Source definitions used to be dropped silently, making the
  Worker a second and unlogged authorization point; authorization is the Connection lock
  in Console, which decides what receives work.
- A Tool Manifest entry may declare `kind` (`read`, `write`, `run`), `params`, and
  `returns`; omitted, `kind` is derived from the adapter and falls to `write` wherever
  the entry has not said otherwise. A declared contract is part of the definition and so
  moves that Tool's digest. Malformed declarations are refused when the manifest is read,
  as is any restatement of a built-in implementation's fixed contract.
- `json` joins `string` / `number` / `boolean` as a declarable parameter type, so
  `rulith.workspace.write_json@1` can state the `value` argument it has always taken;
  database templates still refuse it. Both workspace write Tools now return a result row
  (`source`, `path`, `bytes`, `digest`) like every other workspace Tool, so a write receipt
  reaches the Board as `rulith.worker.file_written`; `digest` is the hash of what landed,
  computed as `read_text` computes its own, so a read-back can be checked against the
  receipt. The receipt text is unchanged.

## 0.6.11 - 2026-09-04

- Conversation mode now exposes one small Rulith surface: start a Case, apply a
  batch, request an advertised Action, or ask to finish. Case Views translate raw
  `ApplyAction` examples into that surface, and a copied raw Board command fails
  visibly instead of becoming an unevaluated user-facing reply.
- An explicit completed finish runs deterministic verification discharge and waits
  for authoritative receipts before asking the Board to close. A transport failure
  is reported as an unknown outcome and may only be retried unchanged with the same
  request identity; it is never misreported as a semantic refusal.
- The Runtime trust-floor order now matches every canonical Core evidence tier and
  fails closed on an unknown tier.
- Blank placeholders in `~/.rulith/local.json` inherit non-empty supervisor values
  instead of erasing credentials. Initial role failures and child stderr are visible
  in the terminal, and the public example no longer installs machine-specific paths.
- Packaging verifies the committed artifact manifest instead of regenerating its own
  trust anchors. Release preparation updates version, immutable tag, embedded hashes,
  and version guards together; release tags are annotated.

## 0.6.10 - 2026-09-03

- Writable workspace Sources must be separate from the entire Worker implementation
  root. This closes Windows short-path aliases and not-yet-created run Adapter paths
  without relying on per-file canonicalization.

## 0.6.9 - 2026-09-03

- File exploration Sources fail closed when their selected root contains an existing
  Rulith Local credential file, Worker credential vault, or Worker Tool Manifest.
  Local passes the resolved configuration path into its Worker, so relative launch
  paths cannot make the parent and child protect different files.
- Whenever the Worker has workspace write capability—through built-ins or a custom
  Tool Manifest—a Source root cannot contain the Worker executable or any configured
  run Adapter, including an Adapter file not created yet. Choose a narrower data-only
  directory so model-writable files cannot become executable code.

## 0.6.8 - 2026-09-03

- Local activity refreshes preserve the reader’s scroll position unless the view was
  already following the tail; explicit navigation and message sends still jump to the
  newest event.
- Conversational active Cases refresh the Source Access catalog once per user message, so an Agent-owned
  exploration Source and its bounded read tools become visible without restarting Local.
- Agent-only workbenches now say `Rulith MCP` and `not local` instead of implying that a
  remote Worker is connected.

## 0.6.7 - 2026-09-03

- Finalizes the safe conversation-first tool transport after the unpublished 0.6.6
  release candidate: unscoped and locked prompts expose no provisional-law template,
  and malformed tool-shaped replies fail visibly without gaining authority.

## 0.6.6 - 2026-09-03

- The compatibility tool transport now executes a Rulith call only when the entire
  model response is exactly one JSON tool block. Quoted examples and explanatory prose
  can never become authority-bearing calls.
- A locked Board receives a conversational guide with no provisional-rule or
  `add_axiom` template, and an aborted turn reports its still-open Case as pending.
- Conversational Board verdicts are visible in the terminal as well as the Local event
  stream, and rejected commands teach the lifecycle vocabulary of their active mode.

## 0.6.5 - 2026-09-03

- Rulith Local is now a normal conversational Agent with Rulith as an optional tool.
  A plain response creates no Case and touches no Board. The model must explicitly
  select `start_case`, a Case operation, pause, resume, or finish; an unfinished Case
  no longer causes the host to keep calling the model until certification or the round
  limit. The existing one-shot positional-task CLI remains the explicit autopilot path.
- Local browser messages retain one bounded local `sessionKey`, so follow-up messages
  continue the same transcript and selected Case until the user starts a new conversation.
  The service generates distinct keys for callers that omit one. At the bounded session
  limit, it records a recoverable Case ID before reclaiming an abandoned local transcript;
  memory pressure never pauses or otherwise changes the Board Case lifecycle. Returning
  sessions receive that bounded recovery hint, and callers may explicitly pass a recorded
  `caseId` to select the same Case again.
- The workbench now labels conversation activity separately from the optional Rulith
  Case inspector and receives Board verdict/completion events from the conversational path.
- Every mutating model step now requires an explicit `{ "tool": "rulith", ... }`
  envelope, so JSON examples in ordinary answers cannot write the Board. The configured
  Case Type remains host-owned and cannot be replaced by model output.

## 0.6.4 - 2026-09-02

- A standalone verified-calculation setup downloaded from Console now verifies and
  fetches its seven files from the immutable `v0.6.4` Runtime release instead of
  relying on retired per-file Console routes or a package-local manifest it cannot have.
- A rejected Agent credential is a host-level failure: Rulith Local stops accepting
  tasks and exits with status 3 without inventing a pending Case identity. Model-provider
  failures remain isolated to the task that encountered them.

## 0.6.3 - 2026-09-02

Security and correctness fixes from a pre-release review. Every item below is covered by
a test that fails when the fix is reverted.

### Worker

- Database Tools take their statement only from the Tool's own `exec` template. An
  invocation argument named `sql` used to replace it, so the SELECT-only guard and the
  destructive-statement classifier judged model-supplied text instead of the declared
  template, and the driver-parameter compilation above them could be bypassed entirely.
- A database Tool that declares a parameter named `sql` is now refused when the Tool is
  resolved, rather than accepted and ignored.
- An Action work item's `payload.args` can no longer replace the validated invocation
  arguments. The door was inert for http, run, workspace and mcp Adapters, which always
  produce compiled args, and live for the two database Adapters, which do not.
- A thrown transport failure on an action receipt (connection reset, peer gone) is
  retried inside the receipt ladder instead of escaping into the poll loop. The claim has
  already recorded a trusted `dispatched`, so a dropped receipt meant the executor had
  changed the world and the Case could never complete.
- Outbound MCP calls carry a 30-second timeout and a 1 MiB response cap, both tightenable
  from the local Worker Tool Manifest and neither settable from a work item.
- A `run` Adapter no longer inherits the runtime's own credentials. The Connection key,
  Agent token, model provider keys, reviewer key, serve key and database DSN are removed
  from the child environment; `PATH`, `HOME` and the rest pass through, and what an
  Adapter needs is still handed to it explicitly.
- That fence matches variable names case-insensitively. Windows environment variables
  are case-insensitive, so a Connection key stored as `Rulith_Connection_Key` — the
  casing a Windows shell keeps — reached the Adapter untouched, as did `rulith_token`
  and `openai_api_key`. Surviving variables keep the casing they arrived with, because a
  child that inherits neither spelling of `Path` cannot resolve a program at all.
- The fence covers the credential families a host actually carries, not only this
  runtime's own variables: `*_API_KEY`, `*_TOKEN`, anything containing `SECRET` or
  `PASSWORD`, `*_PRIVATE_KEY`, `DATABASE_URL`, `*_DB_URL`, `*_DSN`, and the `AWS_`,
  `AZURE_`, `GOOGLE_`, `ANTHROPIC_` and `OPENAI_` families. `OPENAI_API_KEY`,
  `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` previously
  reached every Adapter.
- A `run` Tool may declare `"env": {"pass": ["NAME"]}` in the Worker Tool Manifest. Its
  Adapter then receives the `PATH` / `HOME` / `TEMP` / `SystemRoot`-class basics plus
  exactly those names and nothing else — the only fence that covers a credential name no
  deny-list describes. The field is part of the Tool digest, is refused on the Adapters
  that start no process, and is never accepted from a work item. Neither mode is a
  sandbox: an Adapter runs with the Worker user's rights, and README and SECURITY now
  say so in those words.
- Ambient `RULITH_CASE_ID`, `RULITH_SOURCE_ACCESS`, and `RULITH_SOURCE_TYPE` are stripped
  even when a Tool's `env.pass` names them. The Worker supplies current Case and Source
  context explicitly from the trusted work item, so a reused process cannot hand an
  Adapter stale execution context from its parent environment.

### Agent Runtime

- The model may emit only reads, `ApplyBatch`, `ApplyAction` and `RunDischarge`. Case
  lifecycle, work receipts, clearance, and package or Board governance are refused
  locally with teaching and never reach Cloud, so text arriving through a task, a
  document or a tool result cannot spend the Agent credential on `RemovePack`,
  `CloseCase` or `ReportWork`.
- In `--serve`, a model-provider failure fails that task and leaves the server running.
  It previously exited the process from inside one queued Case, discarding every other
  queued and in-flight Case without telling their callers.
- A one-shot run whose Case never opened exits non-zero instead of 0.
- A paused Case can be resumed. `--case <id>` on a paused Case sends `ResumeCase`
  (board-scoped, per `protocol/operations.json`) instead of falling through to `OpenCase`
  and its `id_reused` refusal, both when the Board Manifest already reports it paused and
  when `OpenCase` reveals it.
- Each board submission carries a `requestId`; an unchanged retry after a failed MCP hop
  reuses it, and it is released once the Board answers. Older Cloud endpoints ignore it.
- Numeric environment knobs fall back to their default with a stderr warning instead of
  becoming `NaN`. `RULITH_MAX_ROUNDS=twelve` previously made every round comparison false,
  so the segment loop ran zero rounds and reported a limit it had never applied.
- A finished one-shot run sets its exit status instead of forcing `process.exit`. On
  Windows the forced exit raced libuv's handle teardown, so roughly half of successful
  runs reported the crash code 3221226505 and lost the tail of their output.
- Public MCP calls keep one deadline across both response headers and body and refuse a
  response larger than 1 MiB instead of buffering it without bound.
- Trace no longer keeps a finished one-shot run alive. Its batching timer is unref'd and
  the run flushes explicitly when it ends, so an exit that took about 150 ms of work no
  longer waits out the 1.5-second batching window; and the flush carries its own
  1.5-second bound across both response headers and body, so a trace endpoint that never
  answers—or sends headers and then stalls its body—cannot hold the process up to the
  45-second MCP abort budget. The batch is still sent, and trace failures are still silent.

### Rulith Local

- The per-run key gates every route, including the page at `/`. The page was previously
  served before the gate with the key substituted into its body, so any local process
  could read a working key with one unauthenticated request, and the Host check that
  prevents DNS rebinding did not apply to it. The page now reads the key from its own
  address; a missing or wrong key answers 401 and a bad Host or Origin answers 403.

### Packaging and documentation

- `npm run check`, which `prepack` runs, refuses to pack when a published canonical file
  contains a CR byte. `artifact-manifest.json` hashes LF text while `npm pack` ships
  working-tree bytes, so a release cut from a CRLF checkout shipped a tarball that failed
  its own manifest — the published 0.4.0 is CRLF throughout.
- `examples/verified-calculation/setup.mjs` verifies every download against
  `artifact-manifest.json` before writing anything, and fails closed with teaching.
  It previously fetched `rulith-agent.mjs` and `rulith-worker.mjs` from
  `RULITH_DOWNLOAD_ORIGIN` and wrote them to be executed without checking them.
- `SUPPORT.md` pointed at `security@rulith.com`; the address is `security@rulith.ai`.
- `SECURITY.md` and `README.md` now state that Windows does not enforce the `0o600` mode
  on `~/.rulith/local.json`, and describe the gate and Adapter fences as implemented.
- `config/worker-tools.example.json` shows a `run` Tool with an environment allow-list,
  and a test parses that shipped example through the Worker's own manifest validator —
  an example is a file readers copy, and until now nothing checked that the Worker would
  accept it.
- The Worker fence tests assert on upper-cased variable names. The end-to-end arm looked
  for `PATH` and read the environment exactly, so under PowerShell — which spells it
  `Path` — it failed on a correct Worker, and it would have passed a Worker leaking
  `Rulith_Token`. The suite is green from PowerShell and from a POSIX shell.

## 0.6.2 - 2026-09-02

- Keeps the center Case stream independently scrollable inside the viewport so long runs remain reachable above the fixed composer.
- Reserves a stable bottom safe area for the composer without pushing the workbench footer outside the visible window.

## 0.6.1 - 2026-09-02

- Resolves Agent identity from the authenticated public MCP surface so short opaque credentials never need client-side decoding.
- Keeps legacy JWT Agent credentials usable during the Cloud cutover; rotating them adopts the short credential format.
- Reports the Cloud-resolved Agent identity in the read-only Local runtime projection without exposing the credential.

## 0.6.0 - 2026-09-01

- Moved the first-party Agent onto the same public MCP tools/call surface used by third-party Agent clients.
- Made the one rotatable Agent token the only Agent identity source; removed `RULITH_AGENT` and `--agent`.
- Sends the Agent token only as an Authorization Bearer header and never in an MCP URL.
- Routes Case commands, Source access planning, evidence chase, and non-authoritative trace through the public `agent_protocol` MCP tool.

## 0.5.2 - 2026-09-01

- Hard-cut Rulith Local back to a single-Agent, configuration-driven Runtime; interactive multi-Agent Studio work is deferred.
- Removed Local account login, Agent selection, OAuth refresh storage, browser configuration writes, and model switching.
- Replaced Local settings with read-only Runtime details and redacted credential-presence indicators.
- Accepts an OpenAI-compatible server root in the configuration and derives its chat-completions endpoint.
- Allows an unauthenticated model endpoint only on loopback and omits empty authorization headers.
- Omits non-standard thinking options in Standard mode.
- Reports immediate Agent or Worker startup exit as failure instead of claiming the role restarted.

## 0.5.1 - 2026-09-01

- Added a dedicated password input for the local model-provider API key.
- Preserves an existing key when the input is left empty, shows only a masked saved-state hint, and provides an explicit clear-and-stop action.

## 0.5.0 - 2026-09-01

- Added loopback PKCE sign-in to Rulith Cloud, account projection, Cloud Agent selection, credential rotation, and sign-out revocation.
- Kept Cloud as the sole authority for identity, governance, acceptance, and billing while Local owns model, Tool, Source, workspace, and process configuration.
- Moved account and settings controls to the lower-left workbench area and added a mobile settings entry.
- Added backed Case/Trace views, JSON session-log export, Case option popover, local Tool ceiling, model badge, thinking control, and busy send state.
- Added a browser-verified responsive workbench layout and strict hidden-state handling for signed-out Agent controls.

## 0.4.3 - 2026-09-01

- Added model URL and model ID to the generated Local Agent configuration.
- Upgrades existing Local configuration views with missing model fields while preserving credentials.
- Clarified the separate Cloud-token and model-provider credentials inside the settings modal.

## 0.4.2 - 2026-09-01

- Marked the Local UI document `no-store` so a restarted runtime cannot reuse stale HTML.
- Automatically reloads an old Local tab when its per-run key is rejected by the new process.

## 0.4.1 - 2026-09-01

- Replaced the below-fold Local settings disclosure with a centered, accessible settings modal.
- Added role-aware settings panes and one-click save-and-restart for Agent and Worker.

## 0.4.0 - 2026-09-01

- Hard-cut the existing `rulith` npm package from the retired MCP executable to Rulith Local.
- Added the global `rulith start --role agent|worker|agent+worker` command.
- Moved the default private configuration to `~/.rulith/local.json`; `rulith --help` is side-effect free.
- Restricted the npm publication to canonical runtime and example files, excluding generated local workspaces.

## 0.1.0-beta.2 - 2026-09-01

- Replaced Station as a separate product surface with one role-aware Rulith Local host and Agent workbench.
- Added Agent, Worker, and Agent+Worker startup modes while preserving separate child-process credentials.
- Unified Agent and Worker display events over structured child-process IPC.
- Enabled bounded file list/count/search/read/hash Tools by default; write Tools still require an explicit `read-write` host ceiling.
- Returned structured, attestable rows from every workspace read Tool and published file writes atomically.
- Compiled database templates to driver parameters instead of interpolated SQL values.
- Added bounded MCP Tool discovery while keeping every remote call behind a separately approved local Tool and governed Action.
- Kept restricted HTTP GET and fenced HTTP write results on the same governed result membrane.
- Generated every manifest digest from repository-canonical LF bytes and pinned LF in Git, fixing the broken manifest carried by the previous beta tag.

## 0.1.0-beta.1 - 2026-08-25

- Published the domain-neutral Agent Runtime, Worker, and local control host as an independent
  Apache-2.0 repository.
- Added the verified file calculation workflow: local JSON read, exact board
  derivation, local JSON write, independent read-back, and board acceptance.
- Kept model credentials in the Agent process and source credentials in the Worker.
- Added an English local control room for starting, configuring, and observing both
  processes.
- Added manifest drift checks, CI, structured bug reports, and workflow feedback.

The public repository begins at this version. Earlier private deployment history is
not part of the public compatibility contract.
