# Changelog

All notable changes to the local runtime are documented here.

## Unreleased

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
