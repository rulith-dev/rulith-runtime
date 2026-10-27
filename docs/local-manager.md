# The local Runtime manager

The Rulith app (`rulith`, see [app/README.md](../app/README.md)) runs one Runtime manager beside it:
`rulith manager`, a loopback service with no page. It keeps this computer's sign-in to a Rulith
account, one local profile ("instance") per Agent set up here, and each instance's own Agent and
Worker processes. The app's host is its only client; a person uses it through the app.

The English workbench page that used to front this service (`rulith start`, `rulith setup`) is
retired: since Rulith 0.19.0 those commands open the app. What a person did there is in the app's
first-run wizard and its one settings page (account, this computer, model, appearance and language,
advanced), or in Console.

## Where it keeps things, and how it is reached

The app's manager home is `manager/` in the app home (`~/.rulith/app/manager`, or under
`RULITH_APP_HOME`). `rulith manager` on its own uses `RULITH_MANAGER_HOME` (default
`~/.rulith/manager`), `RULITH_MANAGER_PORT` (default 7780) and `RULITH_MANAGER_KEY` (16–128 of
`A–Z a–z 0–9 - _`; default a new random key per run). The app's launcher gives it the key from
`manager.key` in the app home and never prints it. Every request needs that key (header
`x-rulith-manager`, or `?k=`), a loopback `Host` and no foreign `Origin`; operations also need the
header and the same origin. Only one manager process can own a manager home at a time; a second
refuses until the first exits. Instance ports and keys are assigned automatically.

Profiles live under `<manager home>/instances/<id>`. Each contains `local.json`, private script
definitions and non-secret Source locations, a workspace, and, when the profile ran the Runtime's
own Agent, its conversation history (`conversations/<owner-hash>.json` and its `.d` directory).
Device credentials are stored privately and never sent to models or role subprocesses. Execution
credentials are sent to their configured Gateway for authentication; model credentials are sent to
the configured model service. On Windows, protect the manager home with your account's filesystem
permissions.

## Sign in and the account directory

Signing in from the app starts a device sign-in (`/manager/device/start`, then `/manager/device/poll`); the
person approves it in the browser at Console, and no code is copied or typed. The grant lists the
account's enabled Agents. While the manager runs it checks that directory every 30 seconds:
newly enabled Agents appear, disabled ones are removed (their profiles are kept, but a disabled
Agent cannot start or make a new call, and its running roles are asked to stop). A temporary network
failure keeps the last directory; a confirmed device rejection stops that account's local roles.

A failed response does not prove that no credential was issued: the original request and proof are
kept, and the same request is collected again. A request is cancelled only when the Gateway
confirms it was not approved. The claim code lasts ten minutes; the Gateway keeps receipts for one
more hour, after which an absent request is reported as unknown, never as cancelled.

Signing out (`/manager/device/signout`) gives each owned process two seconds to drain, then kills an
owned child still running and observes its exit before confirming device revocation at the Gateway
and clearing issued credentials. An incomplete step is reported, and the same request can be
retried. Model settings, tool configurations, workspaces and user files are kept. Remote revocation
blocks the issued credentials at the Gateway; it is not a claim that a local process or an external
effect already started has stopped.

## Set an Agent up on this computer in one step

Setting an Agent up on this computer in the app (「在本机设置」) uses one manager operation, `POST /manager/instances/setup-local`
(`{requestId, agentId, mode: "setup" | "repair", kitHome?, replaceAgentToken?}`; read with `GET /manager/instances/setup-local?requestId=`).
It answers at once with the step list and runs, in order: **instance** (this Agent's instance, created when it has none),
**pair** (a working Connection is kept without rotating it; otherwise the Connection this instance remembers, also after a
sign-out, is offered for reconnection and the Gateway decides; it creates a Connection only when this device has none),
**kit** (the general kit is installed or refreshed; a running Worker drains first and is never forced), **worker** (local
tools on), **reload** (the Worker runs with the kit's tools and reports them) and **ready** (the Connection id and whether it
was reused or created). A failure stops at its step with a reason, and the same request id continues from there; two
requests for one Agent run one after the other. `repair` mode — used before a project is opened and when the app starts —
never changes an existing pairing and never starts a Worker that stopped itself (its Connection credential refused, or its
Connection taken over by another Worker process); only `setup` mode, an explicit click, does, and at most once per setup.
In `setup` mode a working Connection is kept only while this computer's Agent token is current too, as the device's Health
read reports it (no token travels). Replacing the Agent's token is never automatic: when another computer or client holds
it, or replaced this computer's token since, **pair** fails with `runtime_credential_exists`; when Rulith refuses an
attached instance's Connection credential, or it is missing, **pair** fails with `connection_rejected` or
`connection_missing`, because reconnecting this computer is a new pairing of the same Connection (its new key delivered
here; Source bindings and Tool lock unchanged), which replaces the token too. The same request, or a new one, with
`replaceAgentToken: true` — the person's confirmation that clients still using the old token stop working — continues. A
pairing the account service refused before approving it is withdrawn there at once, so nothing waits on the person: a
Connection in use by a Worker elsewhere is refused (`local_setup_connection_in_use`) and nothing is created; a remembered
Connection an older service refuses to reconnect (`local_setup_refused`) is forgotten and the pairing goes on without it.
Nothing here grants a tool or Source permission.

## The Worker setting

An instance's local tools setting is saved in its profile as `worker.enabled`. When enabled, its
Worker starts with the manager and restarts after a crash with bounded backoff (250 ms, 1 s, 4 s,
10 s). Repeated failures stop automatic retries; a minute of stable operation resets the count.
Credential rejection (Worker exit code 3) stops retries and reports **needs setup**. Tool changes
reload the Worker after its running executions drain; turning the setting off drains and stops it.
Its status is **online**, **offline** or **needs setup**, from the Connection and the active Worker
lease. This setting grants no Gateway permission; tool and resource authorization stays in Console,
or comes from the person opening a project in the app.

## Running model commands without isolation

On Windows and Linux the commands a model runs through a Tool's Adapter are isolated, and refused when isolation cannot
be set up (`docs/model-command-isolation.md`). The owner can turn that off for one Agent on this computer: in the app,
Settings → Advanced → "Run without isolation (not recommended)", off by default, which asks for confirmation before it
turns on. It is `POST /manager/instances/isolation` (`{instanceId, runWithoutIsolation, confirmed?}`); turning it on
needs `confirmed: true`, turning it off needs nothing. The manager writes `RULITH_ADAPTER_SANDBOX=off` into that
instance's `local.json` Worker environment (or removes it), inside a credential root a confined command can neither read
nor write; the instance host has no route for it, and the manager's own environment never reaches the Worker. A running
Worker restarts with the new value after its running executions drain; otherwise the Worker takes it at its next start.
Any case of the variable's name counts (Windows reads names without case); turning it back on removes every spelling.
While it is on, the Worker reports each Adapter it starts unconfined, and the host records them in the instance's
directory (`unconfined-processes.json`). When isolation is required again, before a Worker starts isolated (or at once
when none runs), what those Adapters left running is ended, detached background jobs included: on Windows by process id
and the time each Adapter held it, on Linux also by a mark the commands inherit (`UNCONFINED_RUN_MARK`). Each instance in
the state says `runWithoutIsolation`, and `isolationSweep` (`{at, stopped, failed, error?}`, process ids and names) once
something was found. New instances never name it, so they require isolation.

## Post-call review

Post-call review (D-1013f) is optional in every exploration mode and needs no Console step (D-1026a): the owner's client
switches it per conversation (`/manager/conversations/review`, unchanged, and no longer refused in derived mode), and sets
the Agent's side of it through this computer's device grant:

- `POST /manager/agents/reviewer` (`{agentId, connectionId, reviewSeconds?, ifNone?}`) designates the Agent's reviewer
  Connection with its review deadline (60 to 300 seconds; left out, an unchanged reviewer keeps its own), or cancels it
  with `connectionId: null`; with `ifNone: true` the Gateway designates only while the Agent has no eligible reviewer.
  The only Connection it accepts is this computer's own for that Agent (the local Agent instance attached to it under
  the signed-in account); any other id is refused with `reviewer_not_this_computer` and nothing is sent. It forwards to
  `/local-devices/agents/reviewer`.
- `POST /manager/agents/review-default` (`{agentId, enabled}`) sets the Agent's "review new conversations" default
  (off for a new Agent), forwarded to `/local-devices/agents/review-default`.
- `POST /manager/agents/review-state` (`{agentId}`) reads them, forwarded to `/local-devices/agents/review-state`, which
  creates nothing.

All three answer `{agentId, reviewer, reviewerState, reviewSeconds, reviewNewConversations}`. `reviewerState` is
`not_designated`, `ineligible` (the reviewer's Connection was revoked or deleted: it counts as none and may be
replaced), `disconnected` (its Worker is offline or its key is being changed), `not_configured` (its Worker does not
offer review) or `ready`; the last three keep the reviewer. `/manager/conversations/state` carries the same fields; the app passes none of the Connection ids to its page.
An account service from before these routes answers them `not_found`: the app then shows that it cannot read the
settings, and turning a conversation's review on only switches the conversation, as 0.19.1 did. A reviewer Connection reviews with its Agent's own model: the Worker's reviewer route is that model (see
Model settings), it advertises the reviewer seat on every Poll, so a designation applies from its next Poll without a
restart, and it reads each write call after it runs and may add advice; it never blocks a call.

## Health

`GET /manager/health` reads this computer's sign-in, Agent keys, Worker Connections, Sources,
program status and calls waiting for a person from the account service, merged with what is running
here. It reads the service only when asked, never displays a credential, and never retries a Rulith
call. The app's task panel uses it for a call that waits for a person.

## Model settings

Each signed-in account has one default model on this computer (`/manager/model/default`), and each
Agent may use it or its own (`/manager/instances/model`). A setting is the service URL, the model ID,
the key, **Thinking** (provider default, off or on: off and on send an explicit `thinking.type` to
OpenAI-compatible services that support it) and the maximum output tokens per response (default
6000, an integer from 256 to 65536, sent as `max_tokens`; the provider may reject a limit it does
not support, and Rulith does not silently lower it). The app uses a saved model from the next turn
of every conversation, without a restart; a turn already running finishes on the previous one. A
local Agent's Worker takes the same model as its reviewer route at its next reload, unless the
profile's own Worker settings name one, with the Agent's effective maximum output tokens (at most 16000) as its review
budget: a reviewer on a model that thinks by default may need a higher maximum output on the Agent; the reviewer speaks the model's own wire (an address ending in `/messages` is
Anthropic Messages, any other OpenAI-compatible Chat Completions; before 0.19.2 a Messages model left the Worker without
a reviewer).

Saved keys are never returned. A blank key keeps a saved key only for the same model service;
changing services requires a new key or an explicit clear. Moving an Agent from the account default
to its own model requires that Agent's key, even for the same service. A model on this computer
(loopback) can work without a key.

## Replace a Worker Connection key

When Console rotates or restores a Connection key, `/manager/instances/connection-key` verifies the
replacement against the attached Agent and Connection at the profile's Console origin before saving
it atomically. A key for another Agent, Connection, account or Console address is refused; a remote
verification error never echoes the entered key. The Agent token, model, conversations, tools and
other profiles are unchanged. Setting the Agent up on this computer again in the app reconnects this
computer instead when Rulith refuses the key it holds.

## Processes it records

The manager records the processes it starts, with what identifies each one. A recorded process is
known to have ended when another program, or a process this manager started itself, now holds its
process number, or when it was recorded before the computer last started; it then no longer blocks
sign-out, opening that Agent, or starting the manager. Linux names each boot exactly, and tells
apart two processes that had the same number by when each started. On Windows and macOS a restart
shows only when the computer has been up for less time than it had when the process was recorded,
and a Windows shutdown with Fast Startup does not count as a restart at all. On Windows the program
now holding the number then decides, and when that program is Node, so does the script it runs: a
record names its script by file name (`rulith-local.mjs`, `rulith-agent.mjs` or `rulith-worker.mjs`),
and a Node process running another one is not the recorded process. A Node process whose command
line cannot be read, or that holds a number recorded by Rulith 0.9.1 or earlier, still counts as
running. macOS has no program check at all. A marker left by processes that outlived a closed
manager clears by itself once those processes end.

Rulith and installed MCP servers run with your operating-system permissions. Known protected-path
checks prevent accidental exposure of the manager's private files; they are not an OS sandbox for
arbitrary executables. Device sign-in does not grant tools, install capabilities, change billing,
delegate work between Agents, or give one Worker access to another Agent's queue.

## Tools shared by this computer's Agents

Tool definitions and MCP services installed in the manager home's library are available to every
Agent's Worker on this computer; Console still decides what each Agent may call. The official
general kit the app installs is per Agent. See [the tool library](local-mcp-setup.md) for its files,
keys and migration.
