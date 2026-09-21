# Rulith workbench

Rulith is a local multi-agent working environment. Run `rulith` (or `rulith setup`)
and open the loopback address printed in the terminal. The address carries a fresh
browser access key; keep it on this computer.

## Three columns

- **Agents, left:** the Agents this device is authorized to use. Choose one to enter
  its workspace or set it up on this computer for the first time. Each local profile
  keeps its own model settings, credentials, tools, workspace and pending-call recovery records.
- **Conversation, center:** the original conversation, Trace and composer. Changing
  Agents preserves each open conversation page and its unsent input.
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
   Sign in and approve the exact Agents this computer may use. The link carries
   the authorization request; no code needs to be copied or typed. Return to Rulith:
   your Agents appear automatically. No cloud account cookie reaches the local runtime.
   While the sign-in request is valid, Rulith collects the authorization even while its tab is in the background. After
   delivery is acknowledged, the sign-in tab closes when the browser permits it;
   otherwise it explains how to return. Account login alone does not start an Agent
   or authorize a tool.
3. Choose an authorized Agent from the list. On first use, choose whether Rulith runs
   it here with an LLM or provides only a Worker for an existing MCP client.
4. Confirm setup for that Agent. Replacing an existing Agent token requires explicit
   consent; listing, refreshing and ordinary switching never allocate profiles or reissue tokens.
5. Open setup to configure the local model and resources. Start the Agent and/or
   Worker as needed. Tool and resource authorization remains in Console.

One cloud Agent attaches to one profile in this workbench. Different profiles may
share a display name but never a credential or mutable working directory. Device
credentials are stored privately and never sent to models or role subprocesses.
Execution credentials are sent to their configured Gateway for authentication;
model credentials are sent to the configured model service.

The local manager is a limited client of the platform control plane. It uses dedicated
device/manager endpoints for the authorized Agent directory, pairing and local role
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
`agent-sessions.json`. The latter stores pending calls for recovery, **not a durable
chat transcript**. Conversation history lasts for the running Agent session;
restarting it does not recreate the conversation. Board Cases remain in the cloud.

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

Run `node --test test/browser/workbench-ui.browser.mjs` for browser behavior, separately
from `npm test`. For installations outside the development workspace, set
`RULITH_PLAYWRIGHT_MODULE` to the Playwright entry file and `RULITH_CHROMIUM_EXECUTABLE`
to a Chromium executable. The runner reports a skip if its browser dependencies are absent.
