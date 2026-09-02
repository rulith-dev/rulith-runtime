# Changelog

All notable changes to the local runtime are documented here.

## 0.6.3 - unreleased

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

### Agent Runtime

- The model may emit only reads, `ApplyBatch`, `ApplyAction` and `RunDischarge`. Case
  lifecycle, work receipts, clearance, and package or Board governance are refused
  locally with teaching and never reach Cloud, so text arriving through a task, a
  document or a tool result cannot spend the Agent credential on `RemovePack`,
  `SealBoard`, `CloseCase` or `ReportWork`.
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

### Rulith Local

- The per-run key gates every route, including the page at `/`. The page was previously
  served before the gate with the key substituted into its body, so any local process
  could read a working key with one unauthenticated request, and the Host check that
  prevents DNS rebinding did not apply to it. The page now reads the key from its own
  address; a missing or wrong key answers 401 and a bad Host or Origin answers 403.

### Packaging and documentation

- `npm run check`, which `prepack` runs, refuses to pack when a manifest-listed file
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
