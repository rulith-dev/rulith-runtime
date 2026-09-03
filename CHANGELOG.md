# Changelog

All notable changes to the local runtime are documented here.

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
