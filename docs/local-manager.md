# Rulith workbench

Rulith is a local multi-agent working environment. Run `rulith` (or `rulith setup`)
and open the loopback address printed in the terminal. The address carries a fresh
browser access key; keep it on this computer.

## Three columns

- **Agents, left:** this account's currently enabled Agents. Choose one to enter
  its workspace or set it up on this computer for the first time. Each local profile
  keeps its own model settings, credentials, tools, workspace and pending-call recovery records.
- **Conversation, center:** the original conversation, Trace and composer. Changing
  Agents preserves each open conversation page and its unsent input.
  Switching conversations also preserves each draft's text, attachments and Case
  preferences. New unsent drafts appear in Conversations. These drafts live only in
  the open page; closing or reloading it discards unsent input. Accepted conversation
  history is saved separately. All activity retains the selected composer destination
  and names it above the input.
- **Execution information, right:** the selected conversation's Cases, unresolved call,
  frontier and Worker activity. These live in the same page as the conversation, so
  choosing an Agent or conversation switches both together.

The account is anchored at the lower left. Role controls, tools, connection setup,
model configuration, importing an older installation and technical details are
opened when needed. Role controls affect only the selected instance on this computer,
not every remote Connection that the cloud Agent might use. On a small screen the
Agent list and execution information open on demand. Presentation uses the same
neutral gray style as Console.

## Sign in and connect

1. Open the account menu at the bottom left and choose **Sign in**. Rulith opens the browser sign-in page.
   A different Console address and computer name are optional settings under **Advanced local settings**.
2. The browser shows a dedicated **Sign in to Rulith** page, without Console navigation.
   Sign in to connect this computer to the account. Rulith then shows every Agent currently
   enabled in that account; no per-Agent selection is retained on this computer. The link carries
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
   name and API key. **Save** only saves; **Save and start Agent** explicitly starts that Agent.
   Existing MCP clients keep their own model configuration.
6. Start the Worker when it is needed for tools. Tool and resource authorization remains in Console.

While Rulith is running, the workbench checks the account directory every 30 seconds,
including when its browser is closed. Account shows when the list was received and any
temporary sync failure. **Refresh enabled Agents** requests an immediate check. The refresh adds
newly enabled Agents and removes disabled ones. Profiles are kept, but a disabled Agent cannot
start or make a new call; Rulith asks its running local roles to stop and reports any process
that is still stopping. An account with no enabled Agents is still signed in and can be refreshed
after an Agent is enabled in Console. A temporary network failure preserves the last directory;
a confirmed device rejection stops that account's local roles. Incomplete stops remain visible
with a link to the local profiles; one failed stop does not prevent stopping other profiles.

The selected workspace names its next step: finish connection, set a model, start the
Agent, or prepare the Worker. **Starting** means the process exists but initialization
has not yet been confirmed. Agent settings also links directly to
that Agent's Runtime in Console, where an unresolved call can be inspected through the
existing recovery procedure. Opening the link does not retry or dispose of a call.

One cloud Agent attaches to one profile in this workbench. Different profiles may
share a display name but never Agent/Connection credentials or a mutable working directory. Device
credentials are stored privately and never sent to models or role subprocesses.
Execution credentials are sent to their configured Gateway for authentication;
model credentials are sent to the configured model service. Model defaults are local settings,
scoped to the signed-in account and Console origin on this computer. They are not uploaded to Console.

## Default model and Agent overrides

The **Thinking** option distinguishes **Provider default**, **Off**, and **On**. Provider
default omits the setting; it can still enable reasoning when that is the service's default.
Off and On send an explicit `thinking.type` to OpenAI-compatible services that support it.
**Maximum output tokens per response** defaults to 6000 and accepts an integer from 256 to
65536. It is sent as `max_tokens` to either supported provider shape. A larger setting may
cost more, and the provider may reject a limit it does not support; Rulith does not silently
lower it. Default-model followers inherit this setting, while copied and custom models keep
their own value. A changed setting takes effect when the Agent next starts.
An empty response or a response cut off at its output limit is reported as a recoverable
model failure, without executing partial tool calls. Continue the same conversation after
raising the output limit in model settings if the provider supports it; Rulith does not retry
paid calls automatically.

Open the account menu at the bottom left and choose **Default model** to configure the model
once. New local Agent profiles follow this default. For one Agent, open its gear menu and
choose **Model settings** to switch between the default and a separate configuration.
Profiles created before this feature and imported installations keep their existing settings.

Changing the default applies when an inheriting Agent next starts. Running Agents keep their
current model until restarted. Changing one Agent's model requires stopping that Agent;
its independently running Worker does not have to stop. The page says when model settings
are missing and takes **Set model** directly to the editor, without trying to start a child.
If the model endpoint changes while a Worker remains running, its panel asks you to stop
and start that Worker before using new attachments. Existing attachments retain the model
destination approved when they were added; changing models never transfers that permission.

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
**Replace Connection key**. Stop its Worker, enter the replacement key, and Rulith verifies it
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
and computer name remain editable under **Advanced local settings**. Retrying the same request retains its original
proof. A Console without device sign-in support needs a compatible Gateway or the
correct Console address. Approval is checked automatically after the request is ready.
If the browser blocks or closes the sign-in tab, use **Reopen sign-in page** to return
to the same request. There is no manual approval-check step.
Returning to the workbench checks approval immediately. If automatic checks fail,
the account menu shows the actual error and **Reset sign-in**. A request that has not
delivered credentials is cleared locally. An approved sign-in with credentials
uses sign-out: stop local Agents, confirm revocation, then clear. Incomplete stopping or
revocation is reported without pretending that sign-out succeeded.
Older installation imports are under **Advanced local settings**, separate from sign-in.

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
and stop this computer** or revoke this device in Console before signing in and
connecting again. This revokes the exact credentials that device issued, without
changing later replacement credentials or unrelated Connections.

## Stop and sign out

**Stop Agent** and **Stop Worker** affect only the named role of the selected Agent.
Opening settings or choosing another Agent does not stop either role. A process
that is still draining is reported as stopping, not stopped.

**Sign out and stop this computer** first observes managed processes exit, then
confirms device revocation at the Gateway, then clears the credentials it issued.
If any step is incomplete, the page says so and preserves the same request for
retry. Model settings, tool configurations, workspaces and user files are kept.
Remote revocation blocks the issued credentials at the Gateway; it is not a claim
that a local process or already-started external effect has stopped.

## Existing installation

Import from this computer's settings copies a legacy installation into an independent profile.
The original files are preserved. Tool manifests, Source vaults, mutable MCP state
and owned workspace paths are copied or re-rooted; changes are reported. The old
Agent token and Worker credentials stay with the original installation: they were
not issued by this device and cannot be covered by its sign-out. Connect the new
profile separately. Do not run two clients with the same Agent token.

Compatible single-Agent entry points remain available:

```sh
rulith start --legacy
rulith start --config /path/to/rulith-local.json
rulith start --role worker
```

`RULITH_LOCAL_CONFIG` also selects that single-Agent mode. Starting the workbench
never silently moves or rewrites the legacy configuration.

## Files and limits

Profiles live under `~/.rulith/manager/instances/<id>` by default. Each contains
`local.json`, MCP service state, Worker configuration, Source vault, workspace and
`agent-sessions.json`. The latter stores pending MCP calls for recovery, separately
from `conversations/<owner-hash>.json` and its `.d` directory, which preserve accepted
messages, attachment names and visible replies. History is scoped to the Console origin, account and Agent;
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
the original JSON is retained during migration. The Conversations dialog pages through
active and archived history. Archive preserves receipts and messages and frees active
capacity; restore is required before sending again. Stop the Agent before archiving
unfinished work. Archiving does not cancel a Board Case.
Active history is limited to 1,000 turns and 256 MiB, including 8 MiB reserved for each
unfinished turn. A single stored turn is limited to 32 MiB. No history is silently deleted.
For a private backup, stop the Agent and copy both the owner JSON and its `.d` directory.
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
automatically. Explicit single-Agent mode still uses `RULITH_LOCAL_PORT` (default7790).

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

Run `node --test test/browser/workbench-ui.browser.mjs` for browser behavior, separately
from `npm test`. For installations outside the development workspace, set
`RULITH_PLAYWRIGHT_MODULE` to the Playwright entry file and `RULITH_CHROMIUM_EXECUTABLE`
to a Chromium executable. The runner reports a skip if its browser dependencies are absent.
