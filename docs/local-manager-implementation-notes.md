# Local manager — implementation notes

Runtime half of the approved *Local account and multi-Agent upgrade* (2026-09-20), after
root's counterexample review. Everything is uncommitted in the `codex/local-manager-upgrade`
worktree; nothing is deployed.

The first section answers root's fourteen points one by one. The second records what was
built and what is still open.

## Review points

Every "fixed" below has a test that fails against the previous behaviour, not one that passes
because the previous behaviour happened not to be exercised.

### 1 · Lock stealing — **fixed**

`withFileLock` no longer has an expiry. Age proves nothing about whether a holder is alive: a
slow first-run install, a pairing on a bad connection, or a suspended machine outlives any
window one could pick, and the previous thirty-second rule deleted the lock underneath them.
An unreadable lock is no longer read as death either — that is the normal appearance of a lock
created microseconds ago, so the case that broke was two managers starting together.

A lock is now reclaimed only when its record names a process **on this host** that the kernel
says is gone, and the record is re-read immediately before removal so a lock that was replaced
in the meantime is not the one deleted. Acquisition is `wx` plus a read-back of the ticket id:
another process reclaiming at the same instant leaves this one without the lock, and it
notices. `update()` asks `owned()` again before writing, and release unlinks only a lock that
still carries this ticket. A host name is recorded, because a pid from another machine says
nothing here. Waiting is bounded by `lockWaitMs` and ends in a `RegistryLockedError` naming
the holder, with nothing written.

`test/local-manager-registry.test.mjs` drives this with a real second process
(`test/support/registry-lock-holder.mjs`): a live holder with a ten-minute-old lock is not
taken; an empty lock is not taken; a proven-dead holder's lock is; a foreign-host lock is
waited on; and an edit that loses its lock mid-flight writes nothing and does not unlink the
new holder's lock.

### 2 · Corruption absorbed into loss — **fixed**

`readJson`'s swallowed parse error and `normalizeRegistry`'s silent dropping are gone. Reading
a registry that exists and is not valid throws `RegistryUnreadableError` with the path, the
reason, and "Nothing was changed"; `update()` refuses to write over it. `validateRegistry`
refuses — by index and id — a record with no id, a malformed id, a duplicate id, a duplicate
directory, no directory, or an unknown mode, instead of filtering it out. A format that is not
`rulith-local-manager/1` is refused rather than reinterpreted. Fields this version does not
know are preserved, and a missing file is still an ordinary first run.

### 3 · Blanket 401/403 → unusable — **fixed**

`call()` now carries the service's `status` and `errorCode` instead of deciding. Routes whose
subject *is* the device (`context`, `poll`, `ack`) still mark the grant unusable on 401/403.
An **operation** route (`pair`) only does so when the service names a device-level code
(`device_revoked`, `device_expired`, `device_unknown`, `device_not_found`,
`device_unauthorized`); otherwise it re-asks `/local-devices/context`, and a network failure
while asking leaves the grant alone — "I could not check" must never be recorded as "it is
gone". The pending reservation is persisted in the registry, so the exact request survives to
be retried.

The fixture emits `agent_out_of_scope` for a denied Agent. `test/local-device-login.test.mjs`
has both arms: a denied Agent leaves the device linked and the rest of the grant usable; a
Console revocation between sign-in and attach does mark it unusable.

### 4 · Session file and the "history" claim — **fixed (scope kept)**

The per-instance `RULITH_SESSION_FILE` was already in place and is asserted distinct in
`test/local-manager.test.mjs`. No new persistence protocol was added, as instructed. What
changed is the claim: `docs/local-manager.md` now states plainly that `agent-sessions.json` is
a record of calls with an unknown outcome and **not** a transcript, that conversation messages
live in the running process and in the page and do not survive a run, and that a Case's own
record on the Board is the Gateway's. The CHANGELOG no longer says instances keep their
"history".

### 5 · Inheritance and Worker file exposure — **fixed**

Environment isolation was already there (every `RULITH_*` plus `ANTHROPIC_API_KEY` removed
before a role's own configuration is applied) and is asserted from what the children actually
received, including that no variable under *any* name carries a Rulith-shaped credential into
the Worker. What is new is the file half: `managerExposure` refuses to open an instance whose
`RULITH_WORKER_ROOT`, `RULITH_TOOLS_FILE`, `RULITH_SECRETS_FILE` or `RULITH_SESSION_FILE`
overlaps the manager directory outside its own instance — that tree holds `device.json` and
every sibling's configuration. `createMcpServices` gained `protectedPaths`, which the manager
sets to its root, so a filesystem MCP server cannot be given access there either.

### 6 · Revoke retry after a lost response or a remote revocation — **fixed**

`revoke()` runs from any state that still holds a token, including `unusable`: that is
precisely the state in which the revocation may be the thing that has not happened.
`alreadyRevoked` is treated as success. `forgetDevice` — the path for a grant the service
already refuses — now sends the same revoke request once more before clearing, reports
`confirmed` / `already_revoked` / `unconfirmed`, and clears the credentials of safely stopped
instances either way, saying so when the service did not answer. Tested end to end, including
that a Console-first revocation does not rewrite the audit record.

### 7 · Imported credentials falsely covered by the device — **fixed**

An import now produces an **unpaired profile**. `RULITH_TOKEN`, `RULITH_CONNECTION` and
`RULITH_CONNECTION_KEY` are not imported; the original installation keeps them and keeps
working under `rulith start --legacy` with its own independent authority, which the notes and
the page state rather than leave to be discovered. No account or Agent identity is inferred
from the old pairing file — the stored `agentId` is dropped, and the identity is established
by attaching, where the Agent is checked against the grant the service just confirmed. Source
bindings are carried as local resource *selections* only, explicitly described as proposals
again until the profile is attached and they are authorized for its own Connection. Replacing
an existing Agent token remains a separate, explicit choice.

### 8 · `start` and the instance page bypassing the lifecycle — **fixed**

`createLocalHost` gained `managedPolicy`, consulted by `POST /control` with `start` and by
every `POST /setup/*`. The manager binds it per instance id, so it answers about that instance
and never about a global selection. It requires: a linked device; the instance's recorded
origin/account matching the current grant; its Agent still in the authorized set; and, for
starting, that it is attached at all. `/setup/pair/*` additionally requires a persisted
reservation, so a pairing cannot be begun from an instance page at all. `instances.start()`
checks the same thing first, to give one clear refusal instead of a per-role one. A standalone
host has no policy and keeps its existing semantics exactly.

Tested: an unattached instance, an instance with nobody signed in, an Agent removed from the
grant, a direct `POST /control` from an instance page before and after sign-out, and a direct
`POST /setup/pair/start` from an instance page.

### 9 · Pairing reservation — **fixed**

The clash check and the reservation are now one serialized registry edit that happens
*before* any network call, and the reservation is persisted on the instance row. It refuses
both an Agent already attached elsewhere and one already reserved elsewhere, so two
simultaneous attachments — including with `replaceAgentToken: true` — cannot both pass.
`pairingIntent` in memory is gone; the approver reads the persisted reservation, so a manager
that restarted mid-pairing still knows what this instance claimed. `pairPoll` checks the
delivered identity against the reservation *and* the current grant before recording anything,
in addition to the setup service's own `approvedAgentId` check.

Tested with two concurrent `pair` calls (exactly one wins, exactly one credential exists at
the service), with an interrupted delivery whose reservation survives and blocks another
instance, and with a delivery naming a different Agent.

### 10 · Dead manager, living children — **fixed**

`createLocalHost` exposes `children()`; the manager records `runtime: {pid, children}` and
refreshes it on every start and stop. `reclaimStale` clears a marker only when the manager pid
*and* every recorded child pid are gone; otherwise it records `orphaned` with the pids, and
opening that instance is refused by name.

The other half is that managed children now stop when their parent does.
`agent/rulith-agent.mjs` and `worker/rulith-worker.mjs` handle `disconnect` on the IPC channel
Local gives them — the Worker through its existing managed-stop path, so the lease is released;
the Agent by ending, with nothing claimed about anything already dispatched. Both are gated on
the channel Local creates, so a standalone run is unaffected.

One real defect came out of this, and the targeted regression run caught it: adding a
`disconnect` listener makes Node **ref** the IPC channel, which kept a finished or failing
Agent alive indefinitely — the shipped-Agent-cannot-reach-its-Gateway arm in
`test/runtime.test.mjs` went from 221 ms to a 20-second hang. `process.channel?.unref()`
restores the previous liveness exactly.

Tested by spawning a real host (`test/support/orphan-parent.mjs`), letting it start a real
Worker and a real Agent, `SIGKILL`ing the host, and asking the kernel about the child pid —
not by deleting a marker.

### 11 · Shared mutable Worker configuration on import — **fixed**

`RULITH_TOOLS_FILE` and `RULITH_SECRETS_FILE` are now always copied into the instance,
wherever they came from, because the tools page edits them in place. The note records where
each came from. Resource *targets* are preserved: `RULITH_WORKER_ROOT` keeps pointing at the
operator's project, and MCP launch arguments pointing outside the old `mcp/` tree are left
alone. The session store is not copied at all (see 7).

### 12 · Reusing model settings — **implemented**

`POST /manager/instances/model/copy` copies `RULITH_MODEL_URL`, `RULITH_MODEL`,
`RULITH_MODEL_KEY` and `RULITH_MODEL_THINKING` from another instance into a stopped
`local_agent` instance. An allow-list, not "everything but the tokens", so a future variable
carrying identity is not copied the day it is added. Both instances must belong to the
signed-in account and Console address where they record one; the key is written to the
configuration and never returned. The page offers it per card. Per-instance setup editing is
unchanged.

### 13 · Return link and key shape — **fixed as directed**

The return ticket is gone. It was not the isolation it claimed to be: whoever held the ticket
could read the redirect's `Location` and obtain the full manager key anyway, and the link broke
on a second click or after its window. The `manager=` parameter now carries the manager's own
browser key, which is what `GET /` requires, and `local/theme.mjs`'s `managerReturnHref`
validates and renders it.

That key is a per-run loopback browser capability and is kept out of everything except an
address the operator navigates: `runtime.managerReturn` was removed from `/status`, no child
process receives it, and it is not logged. The cloud device management token is separate and
appears in none of those places either. The default key is 32 hex characters; a constructor or
`RULITH_MANAGER_KEY` value is validated against `[A-Za-z0-9_-]{16,128}` and refused at startup
with the reason, so a key the pages would silently drop cannot be configured. The legacy
`/mcp-services` redirect now carries `manager=` through.

`local/theme.mjs` was copied from `D:/Work/rulith-runtime` as a local dependency and is
imported statically; the fallback palette is gone and the manager's own rules reference the
shared tokens only — a page test asserts the manager block contains no colour literal at all.
The four instance UI files were not touched.

### 14 · The default import path always refused — **fixed**

The blanket "destination inside the source directory" rule is replaced with the four things
that actually matter: the destination may not be the configuration's own directory, may not
contain it, may not contain the configuration file, and may not sit inside the `mcp/` tree
that is copied recursively. `~/.rulith/manager/instances/<id>` under `~/.rulith` — the only
layout ever offered — now imports.

`test/local-manager-import.test.mjs` builds that exact parent/manager/instances layout and
fingerprints every file under `~/.rulith` and under the home directory before and after,
asserting byte-for-byte equality apart from the new instance.

## What changed in the tree

| File | Change |
| --- | --- |
| `local/manager-registry.mjs` | Ownership-proving lock, visible corruption, child-aware stale reclaim |
| `local/device-client.mjs` | Device-level vs operation-level refusals, `alreadyRevoked`, revoke from any state |
| `local/instance-manager.mjs` | Grant policy, persisted reservation, exposure check, unpaired import, model copy, runtime pids |
| `local/manager-server.mjs` | Ticket removed, key shape validated, model-copy route, keyed return URL |
| `local/manager-ui.mjs` | Static theme import, no local palette, blocked/orphaned/pending/model controls |
| `local/theme.mjs` | Copied from main as a local dependency (root owns the file) |
| `local/rulith-local.mjs` | `managedPolicy`, `protectedPaths`, `children()`, `manager=` on the retired redirect, `managerReturn` removed from `/status` |
| `local/mcp-services.mjs` | `protectedPaths` option |
| `agent/rulith-agent.mjs`, `worker/rulith-worker.mjs` | Exit when the launching host's IPC channel closes; `unref` so this does not keep a finished process alive |

Tests: `local-manager-registry` (9), `local-manager-import` (5), `local-manager` (26),
`local-device-login` (16), `local-manager-page` (14), `local-cli-entry` (5),
`local-manager-integration` (1). Support: `registry-lock-holder.mjs`, `orphan-parent.mjs`,
plus the devices gateway updated to the real self-revoke protocol and to emitting `errorCode`.

### Targeted runs

```
node --test test/local-manager-registry.test.mjs        9/9
node --test test/local-manager-import.test.mjs          5/5
node --test test/local-manager.test.mjs                26/26
node --test test/local-device-login.test.mjs           16/16
node --test test/local-manager-page.test.mjs           14/14
node --test test/local-cli-entry.test.mjs               5/5
node --test test/local-manager-integration.test.mjs     1/1
npm run check                                          pass
```

Regression set for the touched runtime files — `runtime`, `local-gate`, `local-setup`,
`local-mcp-services`, `local-mcp-registry`, `local-presentation`, `worker-flows`,
`worker-tool-management` — 105 tests, all passing, 1 pre-existing POSIX-only skip. The full
suite is root's to run; the GNU tar issue was not re-chased.

---

# Independent review pass (reviewer b830950a)

A second, read-only review found substantive defects in the work above. Its findings are
answered here one by one. Everything below is in the same worktree, uncommitted.

The reviewer's own coverage note still holds and is worth repeating: every device and pairing
assertion runs against `test/support/local-devices-gateway.mjs`, this repository's restatement
of the contract. Root's integrated run against the real Gateway/Core is what validates that the
service behaves as the fixture says.

## P1

### 1 · `copyModelSettings` tore down a host with a live Worker — **fixed**

It refused only while the *Agent* ran, then closed the host to make the new configuration take
effect. `host.close()` signals, waits at most a second, and returns regardless — so for an
`existing_client` profile, or a Local-agent instance with only the Worker started, a Worker
draining a call lost its host, its `hosts` entry and its registry record while still running.
Everything downstream then answered truthfully about a world that no longer contained it:
`stop` said `stopped` because there was no host to ask, and sign-out revoked the device.

Three changes:

- It refuses while **any** role is running, naming which, and refuses a Worker-only profile
  outright — an existing client's Agent never reads a model endpoint.
- It never closes a host. When one is open, the change goes through that instance's own
  `POST /setup/model`, which updates the live configuration in place; `setup.model` gained an
  optional `thinking` field so this stays one write path rather than two.
- `closeHost` now refuses outright while a role runs, unless the manager process itself is
  exiting. That closes the same hole for every other caller, present and future.

Evidence: `test/local-manager.test.mjs`, *"nothing tears down a host while a child is still
finishing"*. `test/support/echo-role.mjs` gained `RULITH_TEST_STOP_DELAY_MS` and advertises
`managedStop`, so the child is asked over IPC and really keeps running for nine seconds after
being asked to stop — on Windows as well as POSIX. The arm starts only the Worker, through the
instance page's own `/control`, and asserts: the copy is refused; `closeHost` is refused;
`stop` answers `stopping` while the child is still recorded and still alive; **sign-out returns
`incomplete` and does not revoke**; and once the child really exits, everything agrees.

### 2 · A failed attachment stranded a reservation — **fixed**

A reservation was persisted before the network call and deleted in only three places, none of
which was a failure path. A denied Agent therefore left the card showing only "Check
attachment" forever and blocked that Agent on every other instance.

- A `pair()` that fails releases its own reservation **if the account service never approved
  it** — `approvedAt` is the line between "nothing was claimed" and "a credential exists".
- `POST /manager/instances/pair/cancel` releases one left behind by a manager that stopped
  mid-way, and the page offers it.
- After approval, cancelling is **refused**, with what actually has to happen: finish
  collecting it, or revoke/replace that Agent's token in Console. This is the case root named —
  a safe cancellation needs the backend to withdraw an issued credential, so this manager
  reports that precisely rather than inventing a local-only forget that would leave a minted
  token unaccounted for.
- A retry of the same attachment after approval no longer re-approves: it goes straight to
  collecting, so one attachment produces one credential however many times it is retried.

Evidence: three arms — a denied Agent leaves nothing reserved and frees the Agent; an approved
one refuses cancellation with the Console instruction and then finishes on retry; an unapproved
one cancels and unblocks the Agent for another instance.

### 3 · Same instance, different target, silent overwrite — **fixed**

`pair()` checked other instances but not its own pending reservation, so a second call for one
instance overwrote it — and the approver, which reads the *persisted* reservation, spent the
grant on the other Agent and reported success to the caller who asked for neither.

The reservation now records the whole target (`agentId`, `origin`, `accountId`, `clientMode`,
`replaceAgentToken`) and an existing one is never overwritten: a different target is refused, an
identical one is the same attachment retried. Evidence: the refused request never reaches
`/local-devices/pair` at all, the reservation is unchanged, and the identical retry produces
exactly one pairing and one credential.

### 4 · `protectedPaths` guarded only the Filesystem branch — **fixed, with the limit named**

The stdio and registry branches built the identical `node <server> <directory>` launch line with
no check, so the configuration refused in one dropdown was accepted verbatim in the next.

`refuseProtectedLaunch` now runs on the assembled launch line for **every** branch, and covers
what is genuinely identifiable: the working directory, the executable, and any argument that is
an absolute path naming an existing directory — which is exactly how Filesystem and servers like
it are told what they may read. It runs again in `workerEnvironment`, the moment a saved service
is actually launched, so a configuration that predates the guard or was edited by hand is caught
too. The scratch directory Local mints under `<instance>/mcp/workspaces/` is exempted, because it
is this instance's own working area and holds no credentials.

**The limit, stated rather than papered over.** Rulith Local is trusted operator software running
as the operator; a stdio MCP server is an arbitrary executable with every power that
operating-system user has. No inspection of a command line can confine it, and neither the code
nor `docs/local-manager.md` claims otherwise. An argument that is not a plain path — a URL, a
config file, a glob, a flag with a root inside it — is not checked and cannot be.
`protectedPaths` is a configuration guard that closes the accidental Filesystem-integration
bypass; it is not filesystem confinement. The reviewer's stronger reading cannot hold without a
sandbox architecture this release does not have, and that is named rather than implied.

Evidence: the stdio branch is refused for a directory argument and for a working directory inside
the manager tree, with a teaching that says it cannot confine an executable; a project directory
outside Rulith's state is not refused by this check.

### 5 · Child pids were not recorded when a role was started from the instance page — **fixed**

`recordRuntime` ran only from the manager's own `ensureHost`/`start`/`stop`, so a role started
through the instance page's `/control` — which the policy permits, and which `local-ui.mjs`
posts — existed only in this process's memory. A later manager read `children: []`, cleared the
marker and could open a second host over a live Worker.

`createLocalHost` gained `onChildChange`, fired on every spawn and every exit whoever asked for
it; the manager records the pids from there. And the swallowed `.catch(() => undefined)` is gone:
a failed write is retried once and, if it still fails, kept and surfaced on the instance card,
because "this instance's processes are not recorded" is something an operator can act on and a
silent gap is not.

Evidence: *"a role started from the instance page is recorded as this instance's child"* starts a
Worker through the page's own route, asserts the pid is in the registry and alive, then backdates
the manager pid and shows `reclaimStale` refusing to clear the marker.

One window remains and is documented: a child spawned in the instant before the manager is killed
may not have been recorded. The IPC `disconnect` handlers added in the previous pass cover it —
the child exits with its parent — and nothing here claims the registry alone would.

## P2

| # | Disposition |
| --- | --- |
| 6 · Corrupt `device.json` | **Fixed.** `DeviceRecordUnreadableError` with the path and "nothing was changed"; `status()` and `peek()` answer with an `unreadable` *state* rather than throwing, so the page still renders and every card explains itself; the file is never overwritten; `forgetDevice` clears it and reports `revoke: 'unreadable'` with the exact teaching — the credential that would have revoked this device could not be read, so revoke it in Console. Tested end to end. |
| 7 · `managerExposure` only at open | **Fixed.** Moved into the start gate. Opening a host spawns nothing, so Setup and Tools — the only pages that can repair a bad path — stay reachable, and starting is what refuses. The refusal names those pages. |
| 8 · Pre-auth catch snapshot | **Fixed.** `gate()` runs outside the `try`; nothing inside it is reachable unauthenticated, and a gate that throws answers with the error alone. |
| 9 · Owned-lock read-back poisoning | **Fixed.** `readLock` distinguishes absent / anonymous / unreadable, and `ownership()` answers `unknown` for a read that failed. `unknown` is treated as ownership, because `wx` creation is the strongest evidence available and the alternative is the reported self-deadlock. Tested with a lock path that cannot be read as a file, asserting both that it is not stolen and that later edits still work. |
| 10 · `clientMode` not in the reservation | **Fixed.** Part of the target (see 3) and checked in the approver: a pairing started as `existing_agent` against a `local_agent` reservation is refused before anything is minted, and the instance's roles are not rewritten. |
| 11 · `device.json` lost updates | **Fixed.** Every write goes through one serialized queue and re-reads inside it; no write carries a snapshot from before a network call. A transition that would move the record backwards is refused rather than applied — not bookkeeping: a linked grant regressed to `pending` leaves the token on disk while the manager believes nobody is signed in, so nothing offers to revoke it. |
| 12 · `overview()` cost | **Fixed** (it was simple). The grant is read once for the whole list instead of once per instance. |
| 13 · A revoked grant does not kill a running process | **Unchanged, now explicit.** The server denies the next call from that Agent token and that Connection; this computer does not reach into a running process. `docs/local-manager.md` gained a section saying exactly that, including that nothing already dispatched is reported as cancelled. |

## Targeted runs

```
node --test test/local-manager-registry.test.mjs        10/10
node --test test/local-manager.test.mjs                 34/34
node --test test/local-device-login.test.mjs            18/18
node --test test/local-manager-import.test.mjs           5/5
node --test test/local-manager-page.test.mjs            14/14
node --test test/local-cli-entry.test.mjs                5/5
node --test test/local-manager-integration.test.mjs      1/1
npm run check                                           pass
```

Regression for the files this pass touched — `runtime`, `local-gate`, `local-setup`,
`local-mcp-services`, `local-mcp-registry`, `worker-tool-management`, `worker-flows` — 100
passing, 1 pre-existing POSIX-only skip. Root runs the full suite; the GNU tar issue root fixed
in main was not re-chased here.

Root's polished `local/manager-ui.mjs` was preserved: its `<details>` disclosure, its
preservation of open state, field values and disabled states across a poll re-render, and its
copy. Two affordances were corrected inside it — the model button is disabled while *any* role
runs rather than only the Agent, and a pending attachment offers Cancel beside Check — plus one
line for a runtime record that could not be written.

## Still open

1. **Browser QA and the real Gateway** remain root's: the page arms run the real script against
   a minimal document, and the device/pairing arms run against this repository's fixture.
2. **The fixture now models two server behaviours the real Gateway must also have**: a repeated
   `/local-devices/pair` for an already-approved pairing id answers with the existing approval
   rather than minting a second credential, and self-revoke stays reachable while revoked or
   expired. Local no longer depends on the first — an approved attachment is collected rather
   than re-approved — but a Gateway that minted twice would still be wrong.
3. **A child spawned in the instant before the manager is killed** may go unrecorded; the IPC
   disconnect handlers are what cover that window.
4. **Arbitrary executable plugins** retain operating-system-user powers (P1 #4). Confining them
   needs a sandbox architecture that is not in this release.
5. **File modes on Windows** are POSIX intent; the manager directory is not an access boundary
   against other processes of the same account.
6. **Two managers with different roots** pointed by hand at one instance directory are still
   undetected.

---

# Root's concurrent-open reproduction, and three follow-ups

Root reproduced, on integrated main, two simultaneous `instances.open(id)` calls producing two
listening hosts for one registered instance. Verified here first, against this worktree's code,
before changing anything:

```
outcomes: ["63173","63174"] tracked hosts: 1
  port 63173 -> 401     # a second host, with its own key, that nothing tracked
  port 63174 -> 200
```

The first fix pass did **not** close it. The probe also showed the second half of the defect:
`manager.close()` walks `hosts`, so the untracked host survived shutdown and kept the process
alive. After the change the same probe answers `["55739","55739"] tracked hosts: 1` and exits.

## 1 · One instance, one owned host — **fixed**

`ensureHost` read `hosts.get(id)`, then awaited a stale-marker sweep, a port probe and a
`listen` before writing the entry back. Every one of those is a point where a second request
passes the same empty check.

A promise chain per instance id (`lifecycle(id, action)`) now serializes opening, starting,
stopping, closing, attaching, cancelling and copying settings for one instance. Different
instances stay parallel — the point was never to serialize the manager. The public entry points
take the lock; `ensureHostLocked`, `closeHostLocked` and the `__`-prefixed bodies are what runs
inside it, so an operation that already holds the lock never asks for it again and the design
cannot deadlock against itself (`pair` collects its own delivery, `forget` closes its own host).

No global selected-id routing was introduced: every operation still names a stable instance id.

Evidence, `test/local-manager.test.mjs`:

- *"simultaneous opens of one instance create one host, on one port"* — four concurrent opens,
  one port, one key, one tracked host, the registry's `hostPort` agreeing, and a TCP probe
  confirming nothing else is listening.
- *"opens, starts and stops of one instance interleave without losing a child or a host"* —
  five interleaved lifecycle calls, then the recorded children are asserted to be exactly the
  processes that exist and are alive, and the instance still stops and starts afterwards.

## 2 · `closeHost(force)` claimed children had stopped — **fixed**

It deleted `hosts` before closing and then unconditionally removed `row.runtime`, after a
`close()` that waits one second and returns regardless.

Now the record is written from what the host reports *after* closing. If children remain, the
marker is preserved with their exact pids plus an `unobservedAt` stamp, so the next run's
orphan check sees a dead manager with living children and refuses to open a second host over
them. The registry write is no longer `.catch`ed away. `closeAll` returns
`{unobserved, failures}` and `managerServer.close()` passes it up: a manager closed as a
library object, with this process continuing, must not report that everything stopped.

Evidence: *"a manager that closes with a draining child records it rather than claiming it
stopped"* — a real Worker that takes nine seconds to finish, `closeAll` reporting it, the pid
still alive, the registry still naming it, and the next `open` refused.

## 3 · Cancellation reworked onto the Gateway contract — **fixed**

Root is right that the previous version read a local absence as a server-side absence.
`releaseUnapprovedReservation` is gone, and the automatic release in `pair`'s catch with it: a
failed attempt now keeps its reservation *and its proof*, and says so.

Cancelling goes through root's contract, `POST /local-setup/cancel {pairingId, deviceSecret}`,
sent by the instance that holds the original proof — same no-Origin server call as poll and
ack. `setup-service` gained `cancel`, `rulith-local` routes `/setup/pair/cancel` behind the
same managed policy (a persisted reservation is required, so an instance page cannot start
one), and the service's `errorCode` is carried back rather than flattened into a message.

Three outcomes, and only one of them clears anything:

- `cancelled` — the pending proof, key and code are removed *after* confirmation, so a retry
  before it presents the same proof rather than minting a second request. The Agent is free.
- 409 `local_setup_already_approved` — a credential exists. Nothing is touched here or there;
  the reservation is marked approved so the card offers "Check attachment", and the teaching
  names the Console action for genuinely abandoning it.
- anything else, including a dropped response — nothing is dropped and the same cancellation
  can be sent again. An unknown answer is not a cancellation.

Also: an attachment the service already approved is now *collected* rather than re-approved, so
one attachment yields one credential however often it is retried.

Fixture: `/local-setup/cancel` with root's exact semantics, plus `local_setup_cancelled` on a
later start, poll, ack or device approval of a cancelled pairing, and a new
`dropResponseAfterEffect(path)` control that applies a request and then destroys the socket.

Evidence: *"a failed attachment keeps its reservation, and cancelling it asks the account
service"*; *"a cancellation whose answer was lost changes nothing here, and the same
cancellation finishes it"* (effect-then-drop, then a retry asserted to carry the identical
pairing id and proof); *"a cancellation that races an approval is refused by the service, and
nothing is forgotten"* (409, reservation intact, token count unchanged, then the poll finishes
it).

## 4 · Unawaited device writes — **fixed**

`recordPairing` and both `noteSignOut` calls are awaited. `recordPairing` in particular ran
inside the approver, so not awaiting it meant an approval could be reported successful before
what it produced had been written down, and a rejected queue write would surface as an
unhandled promise.

## 5 · "never leave this computer" — **corrected**

The CLI banner and `docs/local-manager.md` said account and Agent credentials never leave this
computer. That is not true of execution credentials and never was: the Agent token travels to
its configured Gateway as a bearer header on every MCP call, the Worker Connection key on every
poll, the model key to the configured model endpoint. The banner now reads *"credentials are
stored here; execution credentials are sent to their own configured Gateway"*, the
single-instance banner *"credentials are stored here, and are sent only to the services they
authenticate to"*, and the documentation has a *"Where credentials live, and where they go"*
section stating both halves — including what does not happen: a credential reaching a service
it was not issued for, another instance, a child of a different role, a page, a log or model
context.

## Targeted runs

```
node --test test/local-manager.test.mjs                 39/39
node --test test/local-device-login.test.mjs            18/18
node --test test/local-manager-registry.test.mjs        10/10
node --test test/local-manager-import.test.mjs           5/5
node --test test/local-manager-page.test.mjs            14/14
node --test test/local-cli-entry.test.mjs                5/5
node --test test/local-manager-integration.test.mjs      1/1
npm run check                                           pass
```

Regression for the files this pass touched — `runtime`, `local-gate`, `local-setup`,
`local-mcp-services`, `local-mcp-registry`, `worker-tool-management` — 87 passing, 1
pre-existing POSIX-only skip. No full suite, no commits, no deployment. Root's polished
`local/manager-ui.mjs` is intact apart from the Cancel affordance, which now says
"Cancel attachment" and explains when it will be refused.

## Still open, added by this pass

1. **The cancel contract is implemented against root's specification, not a running backend.**
   The fixture encodes it exactly; root reconciles if the Java side lands differently.
2. **A cancellation refused with an unrecognised error** leaves the reservation and asks for a
   retry. That is the safe direction, but a pairing the service considers permanently unknown
   would need an operator to remove the instance; there is no local override, deliberately.
3. **Serialization is per manager process.** Two managers on one registry are still separated
   by the registry lock and the runtime marker, not by this chain.


### Root integration: lifecycle and Rulith workbench

The workbench now uses a root lifetime owner lease and a count-based admission phase:
ordinary operations remain parallel across Agent instances; sign-out and closing stop
admission and await previously admitted operations before taking the stop snapshot.

Final orphan-process closure: sign-out and refused-device cleanup both inspect live child
PIDs from runtime and orphan markers, including a fresh check before revoking or clearing
credentials. A dead parent or a closed host is not evidence of a stopped Worker. Seventeen
lifecycle tests pass, including real surviving processes under both parent states and a
marker arriving while another host stops; the final independent review closes this P1.
Concurrent sign-out/forget requests are refused until the current drain completes.
The private internal host-control token never enters a role's environment or UI.
A closed manager does not accept new instances. Unobserved children retain their PID markers.

Expired/retargeted pairing requests can only be replaced after the Gateway confirms
cancellation of the original request. A local start timestamp also bounds retries when
the first response was lost. Beyond the Gateway receipt window, unknown issuance requires
explicit device revocation; absence never means cancelled. Private-file MCP arguments
are refused while legitimate server code from the installation remains usable.

Customer-facing product name is Rulith. Main startup is the three-column workbench;
explicit legacy/config/role options preserve single-Agent use. Full UI negative-path
review and final integrated test counts are recorded in the final root validation logs.
