# Rulith workbench

Rulith is a local multi-agent working environment. Run `rulith` (or `rulith setup`)
and open the loopback address printed in the terminal. The address carries a fresh
browser access key; keep it in this environment.

## Three columns

- **Agents, left:** this account's currently enabled Agents. Choose one to enter
  its workspace or set it up in this environment for the first time. Each local profile
  keeps its own model settings, identity credentials and workspace. Tools are shared by
  every Agent through the environment’s library.
- **Conversation, center:** the original conversation, Trace and composer. Changing
  Agents preserves each open conversation page and its unsent input.
  Switching conversations also preserves each draft's text, attachments and Case
  preferences. New unsent drafts appear in Conversations. These drafts live only in
  the open page; closing or reloading it discards unsent input. Accepted conversation
  history is saved separately. All activity retains the selected composer destination
  and names it above the input.
- **Execution information, right:** the selected conversation's Cases, the Agent's recent
  operations, frontier and Worker activity. These live in the same page as the conversation, so
  choosing an Agent or conversation switches both together.

The account is anchored at the lower left. Local tool settings, connection setup,
model configuration and technical details open when needed. The local tool setting
belongs to the selected Agent's profile in this environment. On a small screen the
Agent list and execution information open on demand. Presentation uses the same
neutral gray style as Console.

## Sign in and connect

1. Open the account menu at the bottom left and choose **Sign in**. Rulith opens the browser sign-in page.
   A different Console address and environment name are optional settings under **Advanced local settings**.
2. The browser shows a dedicated **Sign in to Rulith** page, without Console navigation.
   Sign in to connect this environment to the account. Rulith then shows every Agent currently
   enabled in that account; no per-Agent selection is retained in this environment. The link carries
   the authorization request; no code needs to be copied or typed. Return to Rulith:
   your Agents appear automatically. No cloud account cookie reaches the local runtime.
   While the sign-in request is valid, Rulith collects the authorization even while its tab is in the background. After
   delivery is acknowledged, the sign-in tab closes when the browser permits it;
   otherwise it explains how to return. Account login alone does not start an Agent
   or authorize a tool.
3. Choose an enabled Agent from the list. On first use, choose whether Rulith runs
   it here with an LLM or provides only a Worker for an existing MCP client.
4. Confirm setup for that Agent. Replacing an existing Agent token requires explicit
   consent; listing, refreshing and ordinary switching never allocate profiles or reissue tokens.
5. For a local Agent, choose **Use the default model** or configure **Use a different model**.
   If the default has not been configured, the same dialog asks for its endpoint, model
   name and API key. **Save** saves the settings. Sending the first message starts that Agent automatically; the conversation shows **Starting…** while it comes up.
   Existing MCP clients keep their own model configuration.
6. Enable **Use this environment’s tools and files** when this Agent needs local tools. Tool and resource authorization remains in Console.

While Rulith is running, the workbench checks the account directory every 30 seconds,
including when its browser is closed. Account shows when the list was received and any
temporary sync failure. **Refresh enabled Agents** requests an immediate check. The refresh adds
newly enabled Agents and removes disabled ones. Profiles are kept, but a disabled Agent cannot
start or make a new call; Rulith asks its running local roles to stop and reports any process
that is still stopping. An account with no enabled Agents is still signed in and can be refreshed
after an Agent is enabled in Console. A temporary network failure preserves the last directory;
a confirmed device rejection stops that account's local roles. Incomplete stops remain visible
with a link to the local profiles; one failed stop does not prevent stopping other profiles.

The selected workspace names its next step: finish connection, set a model, or prepare local tools. **Starting** means the process exists but initialization
has not yet been confirmed. Agent settings also links directly to
that Agent's Runtime in Console, where an operation that waits for a person's decision or
needs reconciliation is handled. Opening the link does not retry or dispose of a call.

One cloud Agent attaches to one profile in this workbench. Different profiles may
share a display name but never Agent/Connection credentials or a mutable working directory. Device
credentials are stored privately and never sent to models or role subprocesses.
Execution credentials are sent to their configured Gateway for authentication;
model credentials are sent to the configured model service. Model defaults are local settings,
scoped to the signed-in account and Console origin in this environment. They are not uploaded to Console.

## Health and recovery

Open **Health** at the lower left to check this computer's sign-in, Agent keys, Worker
Connections, Sources, program status and pending calls. Problems appear first; healthy
items collapse into a line for each Agent. The service is read when Health opens or you
press **Refresh**. Older services still show local processes and unfinished pairings.

**Sign in** opens the account recovery flow. **Replace key and connect** asks for the
existing replacement confirmation and repairs the same local profile after its processes
stop. **Reconnect a Connection** opens the named Connection choice, preserving its Source
bindings and Tool selection. **Start Worker** reuses the local tools setting for an enabled,
stopped Worker; a running Worker that the service cannot see says **Restart Rulith**.
Source configuration, a rejected program and calls requiring a person open the matching
Agent tab in Console. Health never displays credentials or retries a Rulith call.

## Default model and Agent overrides

The **Thinking** option distinguishes **Provider default**, **Off**, and **On**. Provider
default omits the setting; it can still enable reasoning when that is the service's default.
Off and On send an explicit `thinking.type` to OpenAI-compatible services that support it.
**Maximum output tokens per response** defaults to 6000 and accepts an integer from 256 to
65536. It is sent as `max_tokens` to either supported provider shape. A larger setting may
cost more, and the provider may reject a limit it does not support; Rulith does not silently
lower it. Default-model followers inherit this setting, while copied and custom models keep
their own value. A changed setting restarts a running Agent automatically between turns.
An empty response or a response cut off at its output limit is reported as a recoverable
model failure, without executing partial tool calls. Continue the same conversation after
raising the output limit in model settings if the provider supports it; Rulith does not retry
paid calls automatically.

Open the account menu at the bottom left and choose **Default model** to configure the model
once. New local Agent profiles follow this default. For one Agent, open its gear menu and
choose **Model settings** to switch between the default and a separate configuration.
Profiles created before this feature and imported installations keep their existing settings.

Changing the default or an Agent’s override restarts the affected Agent automatically between turns. Accepted turns finish on the previous model; new messages wait for the restart. The page says when model settings are missing and takes **Set model** directly to the editor.
If the model endpoint changes while a Worker remains running, that Worker still reads
attachments for the previous endpoint until its current executions drain. The Worker
reloads automatically; adding a file during the drain explains the pending reload.
Existing attachments
retain the model destination approved when they were added; changing models never transfers
that permission.

Saved API keys are never sent back to the page. A blank key retains a saved key only for the
same model service; changing services requires entering a new key or explicitly clearing it.
A switch from the account default to a separate Agent configuration requires entering
that Agent's key, even for the same service; it does not copy the account default key.
A local loopback model can work without a key. **Remove the saved API key** is an explicit
choice, separate from leaving the password field empty.

The workbench shares an installation, not an execution identity. Connections still belong
to their Agents, and each Agent keeps its own Worker, tool permissions and working files.

## Replace a Worker Connection key

When Console rotates or restores a Connection key, open that Agent's settings and choose
**Replace Connection key**. Enter the replacement key, and Rulith verifies it
against the currently attached Agent and Connection at that profile's Console origin before
saving it atomically. The old key is not displayed or retained by the page. A key for another
Agent, Connection, account, or Console address is refused; a remote verification error never
echoes the entered key. Replacing this Worker credential does not change the Agent token, model,
conversation, tools, or other profiles.

The local manager is a limited client of the platform control plane. It uses dedicated
device/manager endpoints for the current enabled-Agent directory, pairing and local role
controls. It does not use `/mcp` or `/work` for management. Those remain the Agent's
business interface and the Worker's execution interface. Creating cloud Agents,
installing capabilities, governing resource access, publishing and billing remain in Console.

## Interrupted connection attempts

If sign-in cannot start, Account shows **Retry sign-in**. The Console address
and environment name remain editable under **Advanced local settings**. Retrying the same request retains its original
proof. A Console without device sign-in support needs a compatible Gateway or the
correct Console address. Approval is checked automatically after the request is ready.
If the browser blocks or closes the sign-in tab, use **Reopen sign-in page** to return
to the same request. There is no manual approval-check step.
Returning to the workbench checks approval immediately. If automatic checks fail,
the account menu shows the actual error and **Reset sign-in**. A request that has not
delivered credentials is cleared locally. An approved sign-in with credentials
uses sign-out: stop local Agents, confirm revocation, then clear. Incomplete stopping or
revocation is reported without pretending that sign-out succeeded; the notice names each
Agent and process that is still running.

The workbench records the processes it starts, with what identifies each one. A recorded
process is known to have ended when another program, or a process this workbench started
itself, now holds its process number, or when it was recorded before the computer last
started; it then no longer blocks sign-out, **Reset sign-in**, opening that Agent, or starting
the workbench. Linux names each boot exactly, and tells apart two processes that had the same
number by when each started. On Windows and macOS a restart shows only when the computer has
been up for less time than it had when the process was recorded, and a Windows shutdown with
Fast Startup does not count as a restart at all. On Windows the program now holding the
number then decides, and when that program is Node, as many developer tools are, so does the
script it runs: a record names its script by file name (`rulith-local.mjs`, `rulith-agent.mjs`
or `rulith-worker.mjs`), and a Node process running another one is not the recorded process.
A Node process whose command line cannot be read, or that holds a number recorded by Rulith
0.9.1 or earlier, still counts as running. macOS has no program check at all: a process number
that another process has taken there still counts as running. Whenever a recorded process
still counts as running, the notice names it and its process number. A marker left by
processes that did outlive a closed workbench clears by itself once those processes end.
Existing local profiles are under **Advanced local settings**, separate from sign-in.

The intended account, Console and Agent are recorded when first-use setup creates a
local profile. Reloading or restarting before pairing resumes that same profile;
this record is not authorization and does not start any process or issue credentials.

A failed response does not prove that no credential was issued. Rulith retains the
original request and proof. **Check again** collects that same request; **Cancel**
releases it only when the Gateway confirms that it was not approved.

The claim code lasts ten minutes. The Gateway keeps receipts for one additional
hour (seventy minutes from creation), allowing expired unapproved requests to be
cancelled. Approved requests cannot be cancelled as though nothing was issued.
After receipt retention, an absent request is reported as **unknown**, never as
cancelled. Expired requests are not replaced or retargeted unless the Gateway first confirms
the original unapproved request was cancelled.

If credentials were issued or issuance can no longer be determined, use **Sign out
and stop this environment** or revoke this device in Console before signing in and
connecting again. This revokes the exact credentials that device issued, without
changing later replacement credentials or unrelated Connections.

## Turns, local tools and sign-out

The Agent starts automatically with the first message, showing **Starting…** in the
conversation. Model changes restart it automatically after accepted turns finish.
There are no Agent or Worker Start/Stop buttons.

During a turn, **Send** becomes **Stop**. Stop aborts the model request immediately.
A Rulith call already sent is allowed to answer within the existing held-call bounds;
its answer is recorded, and the turn ends without another model request. The history
says **Stopped by the user**. Other conversations remain unaffected. Its tooltip says:
“Stops this turn. Work already handed to Rulith is not withdrawn.” To stop Board work,
pause the Case or withdraw work before dispatch in Console. An Action still running
can report its eventual outcome in operations.

**Use this environment’s tools and files** is saved in each Agent's local profile as
`worker.enabled`. When enabled, its Worker starts with Rulith and restarts after a crash
with bounded backoff (250 ms, 1 s, 4 s, 10 s). Repeated failures stop automatic retries
and appear beside the setting. A minute of stable operation resets the failure count.
Credential rejection (Worker exit code 3) stops retries and reports **needs setup**;
replace its Connection key before enabling local tools again. A crash retry delayed
by manager sign-out admission resumes when that drain finishes, under the current grant.
Tool changes reload the Worker after its running executions drain; turning the setting
off drains and stops it. Its status is **online**, **offline** or **needs setup**,
based on the Connection and active Worker lease. Agents without local tools default to
off and show no Worker controls. Existing-client mode keeps the setting and status.
This setting grants no Gateway permissions; tool and resource authorization stays in Console.

Opening settings or choosing another Agent leaves accepted work with its owning role.

**Sign out and stop this environment** gives each owned process two seconds to drain,
then kills an owned child still running and observes its exit before confirming device
revocation at the Gateway and clearing issued credentials. Explicit manager stop and
**Remove from Rulith** use the same bound. The response and Trace report forced termination;
work already handed to Rulith may still be running and can be checked in Console.
If any step is incomplete, the page says so and preserves the same request for
retry. Model settings, tool configurations, workspaces and user files are kept.
Remote revocation blocks the issued credentials at the Gateway; it is not a claim
that a local process or already-started external effect has stopped.

## One workbench entry

Run `rulith`, `rulith start`, or `rulith setup` to open the workbench. Configure each
Agent in its own local profile. The old single-instance CLI and installation import
have been removed. Unsupported options fail before creating state; an inherited
`RULITH_LOCAL_CONFIG` must be unset before starting the workbench.

Existing managed profiles, including ones previously imported, retain their configuration,
materials and history. Their original import provenance remains visible in details.
Starting the workbench does not read or change an unrelated single-instance configuration.

## Files and limits

**This environment’s tools** at the bottom of the Agent list opens the shared library in a
workbench dialog. Add tool definitions or MCP services there once; every Agent using this
environment sees all library tools. There is no local selection of tools per Agent. Editing or
removing a definition or service asks for one review and confirmation, then applies the change
after running work finishes. Changed contracts need to be locked again in Console.

Source keys stay once in the environment vault; an Agent uses a key only for a Source granted
to it in Console, and a key supplies only secret material for that Source (a token, headers, a
database DSN at the address granted there): it cannot say what the Source is, or where or how it
connects, so an entry that does is refused and stays in an Agent’s own vault when its tools move.
The page lists key names and types and the file to edit, without exposing
values. A key added for a Source an Agent’s
running Worker has already loaded is read when that Worker reloads. Each Agent retains its
workspace, file-tool mode, materials, conversations and private script tools. Its **Tools** page
shows the shared inventory and edits its own file-tool mode.

A tool’s own credentials, installed in this environment, are available to the tool processes of every Agent that uses the environment; Rulith only sends each Agent the calls it is authorized for. Put tools whose credentials some Agents must not reach into a separate environment (a separate manager directory, `RULITH_MANAGER_HOME`).

The library is `~/.rulith/manager/library` by default. Older profiles move their tools, MCP
services, installs and keys there at startup. Equal definitions merge; conflicts preserve the
profile’s own files and show **Check again** after the conflict is resolved and its local tools
are turned off. Originals of what the move rewrote or removed stay in `tools-before-environment/`,
which keeps the old keys and service credentials in plain text until you delete it; see the tool
library for when and how.
Migrated Agents see the full library while their Console permissions stay as granted. See
[the tool library](local-mcp-setup.md) for formats, private composition and migration recovery.

Profiles live under `~/.rulith/manager/instances/<id>` by default. Each contains
`local.json`, private script definitions and non-secret Source locations, workspace and
`conversations/<owner-hash>.json` with its `.d` directory, which preserve accepted
messages, attachment names and visible replies. An `agent-sessions.json` left by Runtime 0.9
held a record of an unfinished call; the Agent names such a record once at startup and removes
it, because the Gateway's recent-operations strip now shows what became of every call. History is scoped to the Console origin, account and Agent;
replacing a credential does not change its owner. It remains readable with the Agent
stopped. New conversation starts empty; select an existing conversation to continue it.

Restarting marks unfinished local turns as interrupted and never replays their work.
Sending a new message may use the selected conversation's recent text as historical
context; it does not restore MCP sessions, Board focus, tool results or file access.
Board Cases and their evidence remain authoritative in the cloud. The same message
request ID returns its original receipt on retry, including after restart. Interrupted
requests offer an explicit new submission. Changing the model service requires consent
before existing conversation text is sent to that destination.

History is written atomically by the Agent, before a message is acknowledged. An
unreadable history is preserved and blocks startup; a failed write blocks admission
or stops further execution. Changes are stored per turn under an exclusive writer lock;
the original JSON is retained during migration. A lock left by a stopped Agent is removed
before the workbench starts that Agent again, once the process that took it has provably
ended; an Agent whose history another running process holds does not start, and names it.
The Conversations dialog pages through active and archived history. Archive preserves
receipts and messages and frees active capacity; restore is required before sending again.
Archiving unfinished work applies automatically after its accepted turns finish.
Archiving does not cancel a Board Case.
Active history is limited to 1,000 turns and 256 MiB, including 8 MiB reserved for each
unfinished turn. A single stored turn is limited to 32 MiB. No history is silently deleted.
For a private backup, sign out and stop this environment, then copy both the owner JSON and its `.d` directory.
Never overwrite history while the Agent is running. Windows protects atomic replacement
against process interruption, but does not provide a directory-fsync guarantee on power loss.
Archive releases active capacity, not disk space. List indexing still scans file metadata
across archived history; very large libraries increase read latency. Reads run outside
the UI server thread and page responses contain only the selected conversation slice.
Old process-only conversations cannot be recovered. Explicit single-Agent CLI mode
does not create account-scoped durable history.

`RULITH_MANAGER_HOME`, `RULITH_MANAGER_PORT` (default7780) and `RULITH_MANAGER_KEY`
configure the workbench. Only one workbench process can own a profile root at a time;
a second launch refuses until the first exits. Instance ports and per-run browser keys are assigned
automatically.

Rulith and installed MCP servers run with your operating-system permissions. Known
protected-path checks prevent accidental exposure of the manager's private files;
they are not an OS sandbox for arbitrary executables. Device login does not grant
tools, install capabilities, change billing, delegate work between Agents, or give
one Worker access to another Agent's queue.

## Browser verification

**Export view** (also in Conversations on narrow screens) downloads the currently
loaded local events for the selected conversation, including trace details. All activity
exports the loaded events across conversations. The file explicitly marks incomplete
history; it is not a backup, original material contents, or Board proof. Unsent drafts
are never included. Load earlier messages before exporting if they are needed.

Run `node --test test/browser/workbench-ui.browser.mjs test/browser/materials-ui.browser.mjs`
for browser behavior, separately from `npm test`. This covers the environment tools
dialog on desktop and narrow screens, its single confirmation and cancellation,
the Agent's library notice, and migration's **Check again** action. For installations
outside the development workspace, set
`RULITH_PLAYWRIGHT_MODULE` to the Playwright entry file and `RULITH_CHROMIUM_EXECUTABLE`
to a Chromium executable. The runner reports a skip if its browser dependencies are absent;
a release browser check must execute the tests with both dependencies present.

For the first-use smoke check against an already signed-in, dedicated QA environment,
set `RULITH_LIVE_RUN=1`, `RULITH_LIVE_AGENT` to its enabled Agent name, and
`RULITH_LIVE_PACKAGE_ROOT` to this checkout, then run
`node test/browser/live-setup.browser.mjs`. It pairs the QA Agent when needed and checks that it uses
the environment library and that its tools page loads. This smoke check does not edit
library tools or keys. The document workflow's separate acceptance procedure remains
in [document-authoring-acceptance.md](document-authoring-acceptance.md).
