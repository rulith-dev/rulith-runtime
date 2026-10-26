# The Rulith app's English texts (PSC 0.2.32)

中文摘要：负责人 2026-10-25 决定（D-1025b）Rulith 主要面向中国以外的用户，本机应用的界面以英文为默认与规范文字；中文只在
浏览器语言为中文时显示，作为译文，不再逐字固定（取代 PSC 0.2.28/0.2.29 逐字固定的中文本）。下面逐字列出应用显示的每一句英文，
按用途分组；凡 Console 或 PSC 已有批准英文且意思相同的，原样沿用并注明出处。模型看得到的文字（人设、附录、工具说明）不在此列，
也没有改变；模型的回复仍跟随用户的语言。

Authority: the owner's decision D-1025b (2026-10-25): Rulith mainly serves users outside China, so the app's UI is
English first. English is the default and the normative text; Chinese is a rendering shown when the browser's language
is Chinese (`navigator.language` starting with `zh`), checked for completeness only. This replaces the Chinese texts
PSC 0.2.28 and 0.2.29 fixed verbatim for the local client. Model replies keep following the user's language, and nothing
the model sees changes (persona, addendum and tool texts are as in `app/harness/model-visible.md`).

How the language is chosen: once, when the page loads, from `navigator.language` (Chinese when it starts with `zh`,
otherwise English). dsh's own words follow the same language (the page sets dsh's locale when it differs), and every
request the page sends to the app's host names it (`x-rulith-locale`), so the host answers in it; words the host says
outside a request (a refused turn in the conversation) follow the page that last asked.

`{name}` marks a value filled in when the text is shown. A note after a string names the approved English it reuses
verbatim. The machine-readable copy the tests compare against is `app/test/harness/psc-0.2.32-text.mjs`; the tables
themselves are `TEXTS` in `app/harness/web/rulith-dsh-ui/lib/client.js` (the page) and `HOST_TEXTS` in
`app/harness/web/ui-texts.mjs` (the host).

## The page (`client.js` `TEXTS.en`)

### Punctuation the page puts between its own words and a service's (`p`)

- `p.colon`: `: `
- `p.stop`: `.`
- `p.semi`: `; `
- `p.list`: `, `
- `p.open`: ` (`
- `p.close`: `)`
- `p.dot`: ` · `

### Shared words (`common`)

- `common.reading`: `Reading…`
- `common.connectError`: `Could not reach Rulith on this computer`
- `common.unnamedComputer`: `unnamed computer`
- `common.default`: ` (default)`

### Signing this computer in (`signIn`)

- `signIn.notFinished`: `Sign-in has not finished: approve it on the Rulith page that opened, then choose Sign in again.`
- `signIn.failed`: `Sign-in did not succeed.`
- `signIn.waiting`: `Waiting for approval in the browser…`
- `signIn.button`: `Sign in to Rulith`

### The settings entry: the account and this computer at a glance (`status`)

- `status.notConnected`: `Rulith on this computer is not connected`
- `status.notSignedIn`: `Not signed in to Rulith`
- `status.online`: `This computer is online`
- `status.offline`: `This computer is offline`
- `status.notSetUp`: `This computer is not set up yet`

### An Agent's state on this computer (`worker`)

- `worker.notSetUp`: `Not set up`
- `worker.online`: `Online`
- `worker.notEnabled`: `Not turned on for it on this computer`
- `worker.offline`: `Offline`

### “Set up on this computer”: its steps, why it stopped, and replacing the Agent's key (`setup`)

- `setup.steps.connect`: `Connect to Rulith`
- `setup.steps.kit`: `Install the coding tools`
- `setup.steps.worker`: `Turn on this computer`
- `setup.steps.reload`: `Reload`
- `setup.steps.ready`: `Done`
- `setup.reasons.not_signed_in`: `This computer is not signed in to Rulith: sign in under Account in Settings first.`
- `setup.reasons.agent_not_in_account`: `This Agent is not in the signed-in account, or Console no longer opens it to this computer.`
- `setup.reasons.runtime_credential_exists`: `This Agent's key is in use elsewhere (another computer or another client holds it). It was not replaced, and nothing was changed.`
- `setup.reasons.connection_rejected`: `Rulith no longer accepts the key this computer saved for this Agent (it may have been replaced or revoked in Console). Nothing was changed, and this computer did not turn it on again.`
- `setup.reasons.connection_missing`: `This computer remembers this Agent, but the key it saved for it is gone. Nothing was changed.`
- `setup.reasons.worker_taken_over`: `Another process took over this Agent's work on this computer, so this computer stopped it and did not turn it on again. Choose “Set up on this computer” under This computer in Settings to turn it on here again.`
- `setup.reasons.local_setup_connection_in_use`: `This Agent is working on another computer, so this computer did not connect to it and did not create another copy; this setup was withdrawn. Once that computer stops (or its hold expires), choose “Set up on this computer” again.`
- `setup.reasons.setup_request_conflict`: `This setup conflicted with another one: choose “Set up on this computer” again.`
- `setup.consequence`: `The Agent's previous key stops working at once: clients still using it (including on another computer) stop working, and must be set up again there to go on. Replacing it grants no folder or tool permission.`
- `setup.inUseTitle`: `Replace this Agent's key?`
- `setup.inUseLines[0]`: `This Agent already has a valid key, in use on another computer (or another client).`
- `setup.inUseLines[1]`: `After replacing it, this computer is set up with the new key and a connection of its own; that computer's connection is not taken.`
- `setup.inUseAccept`: `Replace the key and go on`
- `setup.inUseCancel`: `Don't replace`
- `setup.reconnectTitle`: `Reconnect this computer?`
- `setup.reconnectLine`: `Reconnecting gives this computer a new key, delivered here; the projects open on this computer and their grants stay as they are.`
- `setup.reconnectAlso`: `This also replaces this Agent's key. {consequence}`
- `setup.reconnectAccept`: `Replace the key and reconnect`
- `setup.reconnectCancel`: `Don't reconnect`
- `setup.stillRunning`: `Setup is still running: look again later under This computer in Settings.`
- `setup.failed`: `Setup did not succeed.`
- `setup.progressUnread`: `Could not read the setup's progress: {error}. Setup may still be running; look again later.`
- `setup.starting`: `Starting setup…`
- `setup.stepFailed`: `“{step}” did not finish`
- `setup.done`: `Set up on this computer; no restart needed.`
- `setup.setUp`: `Set up on this computer`
- `setup.settingUp`: `Setting up…`

### The model form (the wizard's step 2 and Settings → Model) (`model`)

- `model.reading`: `Reading the model settings…`
- `model.unreadable`: `Could not read the model settings.`
- `model.notSaved`: `Not saved.`
- `model.saved`: `Saved. It applies from the next turn.`
- `model.savedNoKey`: `Saved, but not usable yet: enter the key (a model at a local address may need none).`
- `model.notSavedError`: `Not saved: {error}`
- `model.current`: `In use: {name} · {host}`
- `model.none`: `No usable model is set yet.`
- `model.address`: `Address`
- `model.modelId`: `Model ID`
- `model.key`: `Key`
- `model.keySaved`: `Saved; leave empty to keep it`
- `model.keyPlaceholder`: `API key`
- `model.hint`: `An OpenAI-compatible address, or an Anthropic address ending in /messages; a model on this computer can use http://127.0.0.1:port/v1. Saved, it applies from the next turn without a restart; the key stays on this computer and is never shown again.`
- `model.saving`: `Saving…`
- `model.save`: `Save`

### Signing proposed acceptance criteria (Console Text A) (`sign`)

- `sign.title`: `Proposed acceptance criteria` (Console Text A)
- `sign.button`: `Sign these criteria` (Console Text A)
- `sign.body`: `You are signing these criteria as the acceptance for this goal. The Agent proposed them; from now on it cannot end or change them, and the goal completes only when every criterion holds on the current state. This is your decision under your account.` (Console Text A)
- `sign.accept`: `Sign` (Console Text A)
- `sign.cancel`: `Not yet` (Console Text A)
- `sign.signed`: `Signed.` (Console Text A)
- `sign.pending`: `The signature's result is not confirmed yet; this refreshes on its own.`
- `sign.unreadable`: `The criteria awaiting your signature cannot be read right now`
- `sign.signing`: `Signing…`
- `sign.refused`: `Nothing was signed: {teaching}.` (Console Text A)
- `sign.unavailable`: `These criteria cannot be signed for this goal: {category}.` (Console contractUnsignable)
- `sign.truncated`: `This task has too many criteria to list here; sign them in Console.`
- `sign.moreInConsole`: `More tasks await your signature than are listed here: see them in Console.`
- `sign.replaced`: `Will be replaced` (Console contractSuperseded)
- `sign.notCriterion`: `Not a criterion` (Console contractNotCriterion)
- `sign.unknownReason`: `the reason is unknown; try again later`
- `sign.stale`: `The previous signature's result is not confirmed yet; it signed the earlier criteria.`
- `sign.signedMark`: `Signed` (Console contractSigned)

### Why criteria were not signed, by the Kernel's refusal code (filled into `sign.refused` and `sign.unavailable`) (`signReasons`)

- `signReasons.unknown_goal`: `this task was not found`
- `signReasons.goal_ended`: `this task has ended`
- `signReasons.goal_paused`: `this task is paused`
- `signReasons.contract_fixed`: `this task's acceptance criteria are set by its capability and need no signature`
- `signReasons.leaf_not_proposed`: `these criteria have changed; look at the latest ones and sign again`
- `signReasons.criterion_unsupported`: `one of them cannot be an acceptance criterion`
- `signReasons.goal_pending_obligations`: `this task still has unfinished work; sign later`

### An operation in plain words: the task panel's recent operations and the conversation's tool-call lines (`ops`)

- `ops.onFile.read`: `Read {file}`
- `ops.onFile.read_image`: `Read {file}`
- `ops.onFile.write_file`: `Write {file}`
- `ops.onFile.patch_file`: `Edit {file}`
- `ops.refusals.sourceRevoked`: `the project's grant was withdrawn`
- `ops.refusals.workerOffline`: `this computer is offline`
- `ops.refusals.personRefused`: `you refused this operation`
- `ops.refusals.boardSealed`: `this conversation is deleted`
- `ops.refusals.goalPaused`: `the task is paused`
- `ops.refusals.goalEnded`: `the task has ended`
- `ops.refusals.needsSetup`: `this operation is not turned on yet`
- `ops.refusals.lawLock`: `the rules are locked`
- `ops.refusals.governancePending`: `the Agent's settings are taking effect`
- `ops.refusals.boardDraining`: `writes are paused now`
- `ops.refusals.ruleBlocks`: `the current conditions do not allow it`
- `ops.refusals.reviewBlocked`: `the review did not pass`
- `ops.execute`: `Run an operation`
- `ops.endTask`: `End the task`
- `ops.startTask`: `Start a task`
- `ops.startTaskNamed`: `Start the task “{label}”`
- `ops.completed`: `Task completed (acceptance passed)`
- `ops.record`: `Record evidence`
- `ops.readResult`: `Read a result`
- `ops.viewProgress`: `Check progress`
- `ops.proposeCriteria`: `Propose acceptance criteria`
- `ops.breakDown`: `Break the task down`
- `ops.preparing`: `Preparing an operation…`
- `ops.error`: `{verb}: error`
- `ops.passed`: `{verb}: passed`
- `ops.notPassed`: `{verb}: did not pass`
- `ops.failed`: `{verb}: failed`
- `ops.failedWhy`: `{verb}: failed ({why})`
- `ops.refusedWhy`: `Refused: {why}`
- `ops.refused`: `{verb}: refused`
- `ops.unknown`: `{verb}: result unknown, reconcile it in Console`
- `ops.atWorker`: `{verb}: running on this computer`
- `ops.running`: `{verb}: in progress`
- `ops.waiting`: `{verb}: waiting for your decision`
- `ops.needsPerson`: `{verb}: needs you to reconcile it in Console`
- `ops.stopped`: `{verb}: stopped`
- `ops.showEvidence`: `Show evidence`
- `ops.hideEvidence`: `Hide evidence`
- `ops.reason`: `Reason`
- `ops.receipt`: `Receipt`
- `ops.result`: `Result`
- `ops.thisCall`: `This call`
- `ops.raw`: `Full original text`
- `ops.empty`: `(empty)`

### The official engineering capability's tools in plain words (`tools`)

- `tools.read`: `read files`
- `tools.read_image`: `read images`
- `tools.list`: `list files`
- `tools.glob`: `find files by name`
- `tools.search`: `search file contents`
- `tools.tree_state`: `see the folder's changes`
- `tools.write_file`: `write files`
- `tools.patch_file`: `edit files`
- `tools.apply_patch`: `edit files by patch`
- `tools.run`: `run commands`
- `tools.test`: `run tests`
- `tools.job_start`: `run commands in the background`
- `tools.job_poll`: `check background commands`
- `tools.job_stop`: `stop background commands`
- `tools.acceptance`: `run acceptance checks`

### The task panel (right column) (`panel`)

- `panel.unreadable`: `Could not read Rulith`
- `panel.notConnected`: `Rulith is not connected yet: sign in, then choose “Set up on this computer” for an Agent on the left.`
- `panel.noBoard`: `This conversation has not started a task yet. Say what you want done; once it starts, its task, acceptance criteria and recent operations show here.`
- `panel.deleted`: `This conversation is deleted and cannot continue. Its receipts and records are kept and can be read in Console's task records.`
- `panel.unnamedTask`: `(Unnamed task)`
- `panel.goal.running`: `Running`
- `panel.goal.paused`: `Paused`
- `panel.goal.completed`: `Completed (acceptance passed)`
- `panel.goal.ended`: `Ended`
- `panel.awaitingSignature`: `Waiting for your signature`
- `panel.awaitingDecision`: `Waiting for your decision`
- `panel.statusUnread`: `Status not read`
- `panel.aCriterion`: `An acceptance criterion`
- `panel.byCapability`: `Set by the capability`
- `panel.signed`: `Signed`
- `panel.unsigned`: `Not signed`
- `panel.decisionConsole`: `An operation's result needs you to reconcile it in Console.`
- `panel.decisionWaiting`: `An operation is waiting for your decision.`
- `panel.agentWaiting`: `This Agent has an operation waiting for your decision.`
- `panel.agentConsole`: `An operation of this Agent needs you to reconcile its result in Console.`
- `panel.agent`: `Agent: {name}`
- `panel.refresh`: `Refresh`
- `panel.goConsole`: `Handle in Console`
- `panel.inConsole`: `Handle it in Console.`
- `panel.tasks`: `Tasks`
- `panel.tasksUnreadable`: `This conversation's tasks cannot be read right now: they show here once its next result arrives.`
- `panel.tasksNext`: `This conversation's tasks show here once its next result arrives.`
- `panel.acceptInConsole`: `Accept in Console`
- `panel.noTasks`: `No tasks yet: say what you want done; once it starts, it shows here.`
- `panel.criteria`: `Acceptance criteria and status`
- `panel.holds`: `Holds`
- `panel.notHolds`: `Does not hold`
- `panel.holdsUnread`: `Not read yet whether it holds`
- `panel.criteriaLater`: `Acceptance criteria show here once they are read.`
- `panel.noCriteria`: `No acceptance criteria yet.`
- `panel.recent`: `Recent operations`
- `panel.noOps`: `No operations yet.`
- `panel.computer`: `This computer`
- `panel.computerStates.reading`: `Reading…`
- `panel.computerStates.unread`: `Could not be read`
- `panel.computerStates.online`: `Online`
- `panel.computerStates.offline`: `Offline`
- `panel.viewInSettings`: `View in Settings`

### The exploration mode chip and its menu (`tier`)

- `tier.label`: `Mode: `
- `tier.fresh`: `Default`
- `tier.unreadable`: `Unconfirmed`
- `tier.mixed`: ` (mixed)`
- `tier.menu`: `This conversation's exploration mode · narrowing applies at once, widening asks first`
- `tier.menuMixed`: `This conversation's exploration modes differ: the strictest is shown; choose one to make them the same`
- `tier.menuFresh`: `This conversation has not used Rulith yet: the mode you choose applies, starting from the Agent's mode; widening asks first`
- `tier.accepted`: `Accepted, not in effect yet`
- `tier.betweenCalls`: `Accepted, not in effect yet: it takes effect when this call ends`
- `tier.later`: `Accepted, not in effect yet; look again later`
- `tier.notSwitched`: `Not switched`
- `tier.notAccepted`: `This switch was not accepted`
- `tier.title`: `This conversation's exploration mode (changes only this conversation)`

### The three exploration modes, by Console's names (`modeWords`)

- `modeWords.strict`: `Strict` (Console explorationStrict, without "exploration mode")
- `modeWords.derived`: `Derived` (Console explorationDerived, without "exploration mode")
- `modeWords.non_strict`: `Non-strict` (Console explorationNonStrict, without "exploration mode")

### One sentence for each exploration mode (`modeHints`)

- `modeHints.strict`: `Writes and runs need trusted facts first`
- `modeHints.derived`: `Writes and runs go ahead when a rule derives a warrant for them`
- `modeHints.non_strict`: `The model's commands and inputs run as given; completion still needs your signature`

### Widening confirmations (Console's non-strict confirmation, PSC 0.2.5, and Text 9, PSC 0.2.9) (`widen`)

- `widen.non_strict.title`: `Switch to non-strict exploration mode?` (Console non-strict confirmation)
- `widen.non_strict.accept`: `Switch to non-strict` (Console non-strict confirmation)
- `widen.non_strict.cancel`: `Keep strict` (Console non-strict confirmation)
- `widen.non_strict.body`: `Write and run actions of this environment's tools will accept inputs the model supplies, even when no trusted fact on the Board backs them. Each such call is marked "Inputs not grounded". Calls that need your decision never run without it, writes stay inside the locations you authorized, and tools you have not locked stay unavailable. You can switch back at any time.` (Console non-strict confirmation)
- `widen.derived.title`: `Switch to derived exploration mode?` (Text 9)
- `widen.derived.accept`: `Switch to derived` (Text 9)
- `widen.derived.cancel`: `Keep strict` (Text 9)
- `widen.derived.body`: `The model will be able to write and run in this environment's workspace whenever it can derive, from facts and rules it writes on the Board, a warrant for that action and its key inputs. Those facts do not have to be trusted evidence. Calls that need your decision never run without it, and writes stay inside the local workspace.` (Text 9)

### Why a mode or review switch was refused, by code (both switches) (`switchRefusals`)

- `switchRefusals.exploration_control_pending`: `This conversation's exploration mode is still narrowing. Nothing was changed; try again later.`
- `switchRefusals.control_pending`: `The previous setting has not finished. Nothing was changed; try again later.`
- `switchRefusals.agent_call_pending`: `The Agent still has a call that has not ended or awaits reconciliation; change this after it ends. Nothing was changed.`
- `switchRefusals.observation_in_progress`: `An observation has no result yet; try again once it does. Nothing was changed.`
- `switchRefusals.configuration_unconfirmed`: `The Agent's settings are taking effect; try again later. Nothing was changed.`
- `switchRefusals.conversation_ended`: `This conversation is deleted and can no longer be changed.`
- `switchRefusals.board_unavailable`: `This conversation's record cannot be read. Nothing was changed; try again later.`
- `switchRefusals.request_conflict`: `This request conflicted with an earlier one. Nothing was changed; choose again.`
- `switchRefusals.exploration_mode_unconfirmed`: `This conversation's current exploration mode cannot be read. Nothing was changed; try again later.`
- `switchRefusals.conversations_unavailable`: `The conversation setting's result could not be confirmed; try again.`
- `switchRefusals.device_revoked`: `This computer's sign-in is no longer valid; sign in again at the bottom left.`
- `switchRefusals.device_unauthenticated`: `This computer's sign-in is no longer valid; sign in again at the bottom left.`
- `switchRefusals.unauthenticated`: `This computer's sign-in is no longer valid; sign in again at the bottom left.`
- `switchRefusals.not_authorized`: `This computer's sign-in is not authorized to use this Agent.`
- `switchRefusals.agent_not_found`: `This Agent is not available now.`
- `switchRefusals.not_signed_in`: `This computer is not signed in to Rulith: sign in at the bottom left first.`
- `switchRefusals.manager_signing_out`: `This computer is signing out of Rulith, so this cannot be changed now.`
- `switchRefusals.manager_closing`: `Rulith on this computer is closing, so this cannot be changed now.`

### Why a mode switch was refused (mode switch only) (`tierRefusals`)

- `tierRefusals.review_required_by_derived_mode`: `Turn post-call review back on for this conversation before switching it to derived mode.` (PSC 0.2.20 ③)
- `tierRefusals.derived_mode_unavailable`: `Derived mode needs a reviewer for this Agent and permission for the model to write rules. Designate a reviewer for it in Console first.` (first sentence: Text 9's unavailable notice)

### Why a review switch was refused (review switch only) (`reviewRefusals`)

- `reviewRefusals.derived_requires_review`: `Switch this conversation out of derived mode before turning its review off.` (PSC 0.2.20 ③)

### The composer's model and review chips (`composer`)

- `composer.ended`: `This conversation is deleted and cannot continue`
- `composer.modelTitleOverride`: `This Agent uses its own model setting; opens the account's model settings`
- `composer.modelTitle`: `The model this conversation uses next turn; opens Settings to change it`
- `composer.model`: `Model: {name}`
- `composer.modelNotSet`: `not set`
- `composer.reviewTitle`: `This conversation's post-call review (changes only this conversation)`
- `composer.review`: `Review: {state}`
- `composer.reviewDefault`: `Default`
- `composer.reviewOn`: `On`
- `composer.reviewOff`: `Off`
- `composer.reviewMenu`: `Post-call review of this conversation's write calls, from the next call`
- `composer.reviewOnItem`: `On: write calls go to the reviewer`
- `composer.reviewOffItem`: `Off: this conversation is not reviewed (not in derived mode)`

### Opening a folder as a project (PSC 0.2.24 SYS-LOCAL-01): the confirmation, refusals and progress (`project`)

- `project.incomplete`: `What was read about this opening is incomplete, so you cannot be asked to confirm it. Try again later.`
- `project.unexplained`: `This version of the Rulith app cannot explain the mode it would set, so you cannot be asked to confirm it. Update the Rulith app first.`
- `project.modeMeaning.non_strict`: `New conversations on this computer use Non-strict mode by default: the model's commands and inputs run without needing evidence first; whether a task is done is still decided only by the acceptance criteria you sign.`
- `project.title`: `Open this folder as a project?`
- `project.folder`: `Folder`
- `project.agent`: `Agent`
- `project.agentValue`: `{agent} · this computer {computer}`
- `project.canDo`: `What it may do`
- `project.canDoValue`: `Read files, write files and run commands (including tests and builds) in this folder.`
- `project.tools`: `Tools used`
- `project.fromCapability`: `From this Agent's installed official engineering capability.`
- `project.mode`: `Exploration mode`
- `project.note`: `Note`
- `project.noteValue`: `On this computer, reading, writing and running commands in this project folder are carried out by the Agent's engineering capability. Commands run without this computer's keys or tokens in their environment, and tool access to loopback and private network addresses (including this computer's manager and app ports) is refused. By system: on Windows, commands run at low integrity and cannot read the folders where Rulith keeps its credentials; this folder is writable for commands while it is open, and its previous setting is restored when it is revoked or this computer is deactivated. On Linux, commands can write only this project folder and their tool folder, the system is read-only, Rulith's credential folders are hidden, the network stays available, and background jobs end with the tool call that started them. On macOS, commands are not yet isolated on this computer. If isolation cannot be set up, commands do not run (unless you chose "Run without isolation (not recommended)" in Settings). The non-strict tier means the commands and arguments the model gives no longer need grounds on the Board; whether the work is done is still certified only by the acceptance contract you sign. To revoke: unlock this project in Console, or deactivate this computer.` (PSC 0.2.31 ④, the open-project confirmation text)
- `project.withdraw`: `How to withdraw`
- `project.withdrawValue`: `To withdraw it later, withdraw the grant on this project's row of this Agent's page in Console, or revoke this computer's sign-in.`
- `project.account`: `Account`
- `project.toolsVersions`: `Tools and versions`
- `project.capability`: `Official engineering capability {id}`
- `project.connection`: `Local connection`
- `project.footer`: `Existing conversations are not affected. Once it is open, a new conversation starts in this folder.`
- `project.accept`: `Open project`
- `project.cancel`: `Cancel`
- `project.details`: `Details`
- `project.refusals.not_authorized`: `This computer's sign-in is not authorized to use this Agent.`
- `project.refusals.account_changed`: `The account this computer is signed in to is not the one shown a moment ago. Refresh, then open it again.`
- `project.refusals.connection_not_of_this_device`: `This Agent's connection on this computer was not set up by this computer. Choose “Set up on this computer” for this Agent on the left again.`
- `project.refusals.connection_not_found`: `This Agent is not set up on this computer yet. Choose “Set up on this computer” for it on the left.`
- `project.refusals.agent_not_found`: `This Agent is not available now.`
- `project.refusals.client_authority_refused`: `The request carried something only the service may decide, so it was refused. Nothing was changed.`
- `project.refusals.device_revoked`: `This computer's sign-in is no longer valid. Sign in again at the bottom left.`
- `project.refusals.device_expired`: `This computer's sign-in has expired. Sign in again at the bottom left.`
- `project.refusals.device_unauthenticated`: `This computer's sign-in is no longer valid. Sign in again at the bottom left.`
- `project.refusals.unauthenticated`: `This computer's sign-in is no longer valid. Sign in again at the bottom left.`
- `project.refusals.official_capability_not_installed`: `This Agent does not have the official engineering capability installed, so it cannot open projects.`
- `project.refusals.official_capability_invalid`: `The official engineering capability this Agent has installed is incomplete, so it cannot open projects.`
- `project.refusals.project_directory_in_use`: `This folder is already held by another grant on this computer; this needs handling in Console. Nothing was changed.`
- `project.refusals.project_nested`: `This folder is inside an open project, or contains one. Choose a folder that does not overlap an open project.`
- `project.refusals.platform_mismatch`: `This path is not written the way the folders open on this computer are.`
- `project.refusals.worker_tools_unavailable`: `This computer has not reported the tools it needs yet. Choose “Set up on this computer” for this Agent under This computer in Settings, then try again.`
- `project.refusals.worker_tools_mismatch`: `The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.`
- `project.refusals.worker_tool_contract_missing`: `The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.`
- `project.refusals.worker_tool_not_direct`: `The tools on this computer do not match the versions the Agent requires. Update the Rulith app, then try again.`
- `project.refusals.worker_tool_pin_conflict`: `Another version of a tool with the same name is already locked on this computer; this needs handling in Console. Nothing was changed.`
- `project.refusals.project_unavailable`: `The project's state cannot be confirmed now. You can open this folder again on the left later: it continues from where it is, or asks you to confirm again.`
- `project.refusals.not_signed_in`: `This computer is not signed in to Rulith, or its sign-in can no longer be used: sign in at the bottom left first.`
- `project.refusals.manager_signing_out`: `This computer is signing out of Rulith, so it cannot open projects now.`
- `project.refusals.manager_closing`: `Rulith on this computer is closing, so it cannot open projects now.`
- `project.refusals.authorization_changed`: `What would be granted changed after you confirmed. Open it again and confirm again.`
- `project.refusals.runtime_credential_exists`: `This Agent's key is in use on another computer (or another client), and this computer is not set up yet. Choose “Set up on this computer” for it under This computer in Settings, confirm the replacement, then open the folder again. Nothing was changed.`
- `project.refusals.connection_rejected`: `Rulith no longer accepts the key this computer saved for this Agent (it may have been replaced or revoked in Console), and this computer stopped it. Choose “Set up on this computer” for it under This computer in Settings, confirm reconnecting, then open the folder again. Nothing was changed.`
- `project.refusals.connection_missing`: `The key this computer saved for this Agent is gone. Choose “Set up on this computer” for it under This computer in Settings, confirm reconnecting, then open the folder again. Nothing was changed.`
- `project.refusals.worker_taken_over`: `Another process took over this Agent's work on this computer, and this computer stopped it. Choose “Set up on this computer” for it under This computer in Settings, then open the folder again.`
- `project.refusals.local_setup_connection_in_use`: `This Agent is working on another computer; this computer did not connect to it and did not create another copy. Once that computer stops (or its hold expires), choose “Set up on this computer” for it under This computer in Settings, then open the folder again.`
- `project.folderWords.wholeDrive`: `A whole drive or share cannot be opened as a project; choose a folder in it.`
- `project.folderWords.root`: `The filesystem root cannot be opened as a project; choose a folder.`
- `project.folderWords.colon`: `A folder name cannot contain a colon.`
- `project.folderWords.loopback`: `This network path points back at this computer or at an administrative share; use the folder's ordinary path, such as D:\folder.`
- `project.folderWords.backslash`: `A backslash in this path names another folder on Windows; choose a folder whose path has no backslash.`
- `project.folderWords.slashes`: `A path starting with // is a network share on Windows; write it as \\server\share\folder.`
- `project.folderWords.device`: `A device path cannot be opened as a project; use the folder's ordinary path, such as D:\folder.`
- `project.folderWords.share`: `A network path must name a server and a share.`
- `project.folderWords.windows`: `This computer runs Windows; choose a folder such as D:\folder.`
- `project.folderWords.notWindows`: `This computer is not Windows; choose a folder such as /home/you/folder.`
- `project.badFolder`: `This folder cannot be opened as a project`
- `project.notOpened`: `Project not opened`
- `project.again.mode_changed`: `After opening, this computer's exploration mode was changed back (perhaps in Console). Retrying would not widen it for you; to go on, confirm again.`
- `project.again.opened_elsewhere`: `This folder's opening was not confirmed on this computer. To use it here, confirm again.`
- `project.again.mode_refused`: `Setting the exploration mode to Non-strict did not succeed several times. To go on, confirm again.`
- `project.again.revoked`: `This folder's project grant has been withdrawn. To grant it again, confirm again.`
- `project.again.other`: `This opening did not finish. To go on, confirm again.`
- `project.step`: `(step {n} of 3) `
- `project.agentCall`: `The Agent still has a call that has not ended; opening goes on once it ends…`
- `project.modeRetry`: `Setting the mode did not succeed; retrying…`
- `project.configuration`: `Recording the project folder and the tools it uses…`
- `project.program`: `Waiting for the new settings to take effect…`
- `project.modeStage`: `Setting new conversations on this computer to Non-strict…`
- `project.opening`: `Opening the project…`
- `project.later`: `You can open this folder again on the left later: it continues from where it is, or asks you to confirm again.`
- `project.changed`: `What would be granted changed after you confirmed. Look at it again.`
- `project.stopped`: `Stopped waiting. {later}`
- `project.manyTimes`: `This folder did not open after several tries: {again}`
- `project.notYet`: `Not open yet: {progress} {later}`
- `project.assignFailed`: `Could not record this conversation's Agent`

### Choosing a folder (`folder`)

- `folder.open`: `📂 Open folder…`
- `folder.choose`: `📂 Choose folder…`
- `folder.pickerUnavailable`: `Could not open the folder chooser: type the path instead.`
- `folder.path`: `The folder's full path, such as D:\work\game or /home/you/game`
- `folder.openButton`: `Open`
- `folder.cancel`: `Cancel`
- `folder.pickTitle`: `Choose a folder with the system's folder chooser and open it as this Agent's project`
- `folder.picking`: `Choose the folder in the window that opened…`
- `folder.typePath`: `Type the path`
- `folder.stopWaiting`: `Stop waiting`

### The left column: Agents, folders and conversations; deleting a conversation (Console's Conversations texts) (`tree`)

- `tree.otherFolder`: `Other folder`
- `tree.ago.now`: `just now`
- `tree.ago.minutes`: `{n} min`
- `tree.ago.hours`: `{n} h`
- `tree.ago.days`: `{n} d`
- `tree.newConversation`: `New conversation`
- `tree.untitled`: `Untitled conversation`
- `tree.recordUnreadable`: `Could not read this conversation's record`
- `tree.deletePending`: `This conversation still has a call without a result. Settle it first; nothing was changed.` (Console conversationDeletePending)
- `tree.notDeleted`: `Not deleted`
- `tree.partial`: `Not deleted yet: {reasons}. Choose “Finish deleting” on this conversation to go on.` (first sentence: Console conversationDeletePartial)
- `tree.deletedRefused`: `Deleted. Core refused to close {n} of its goals; they stay open on its ended Board.` (Console conversationDeleteRefused)
- `tree.newFailed`: `The new conversation was not created: {error}`
- `tree.projectNotOpened`: `Project not opened: {error}`
- `tree.notProject`: ` (not a project yet)`
- `tree.newInFolder`: `Start a new conversation in this folder`
- `tree.less`: `Show less`
- `tree.more`: `More ({n})`
- `tree.unsettled`: `Not fully deleted: {reasons}`
- `tree.subConversation`: `Earlier sub-conversation`
- `tree.finishTitle`: `The deletion is not finished: {reasons}. The same deletion goes on, without asking again.`
- `tree.finish`: `Finish deleting` (Console conversationDeleteAgain)
- `tree.deleteTitle`: `Delete this conversation`
- `tree.delete`: `Delete` (Console conversationDeleteConfirm)
- `tree.defaultTitle`: `This account's default Agent`
- `tree.default`: `Default`
- `tree.newUnderAgent`: `Start a new conversation under this Agent`
- `tree.agents`: `Agents`
- `tree.newHereTitle`: `Start a new conversation under the current Agent and folder`
- `tree.newHere`: `+ New conversation`
- `tree.filter`: `Filter Agents, folders or conversations`
- `tree.readingAgents`: `Reading Agents…`
- `tree.agentsUnreadable`: `Could not read the Agents: sign in to Rulith in Settings at the bottom left first.`
- `tree.unowned`: `Conversations without an Agent`
- `tree.expand`: `Show the Agent list`
- `tree.dialogTitle`: `Delete this conversation?` (Console conversationDeleteTitle)
- `tree.introAgent`: `Conversation “{title}” belongs to Agent {agent}. Deleting it:`
- `tree.intro`: `Conversation “{title}”. Deleting it:`
- `tree.sealed`: `Its Board is sealed and the conversation cannot continue.` (Console conversationDeleteBody, first sentence)
- `tree.goals`: `{n} open goals will be closed as abandoned.` (Console conversationDeleteGoals)
- `tree.kept`: `Receipts, proofs, billing and history are kept and stay visible in the Console.` (Console conversationDeleteBody, second sentence)
- `tree.undone`: `This cannot be undone.` (Console conversationDeleteBody, third sentence)
- `tree.notFound`: `Conversation “{title}” has not used Rulith yet, so Rulith has no record of it. Deleting only removes it from the list on this computer.`
- `tree.keep`: `Keep` (Console conversationDeleteCancel)
- `tree.deleting`: `Deleting…`

### Why a deletion is not finished yet (Console's Conversations texts) (`deletion`)

- `deletion.closings`: `{n} goal closings are not confirmed yet` (Console conversationClosingsUnconfirmed)
- `deletion.someClosings`: `some goal closings are not confirmed yet`
- `deletion.goalsUnread`: `its open goals could not be read` (Console conversationGoalsUnread)
- `deletion.deletedBeforeRecording`: `it was deleted before deletions were recorded as finished` (Console conversationDeletedBeforeRecording)
- `deletion.settlementUnrecorded`: `its deletion is not recorded as finished yet` (Console conversationSettlementUnrecorded)
- `deletion.unfinished`: `its deletion is not finished yet`

### The first-run wizard (`wizard`)

- `wizard.title`: `Get started with Rulith`
- `wizard.steps.signin`: `Sign in`
- `wizard.steps.model`: `Choose a model and enter its key`
- `wizard.steps.folder`: `Open a folder`
- `wizard.notAttached`: `This Agent is set up on this computer but not connected to Rulith yet: wait a moment, then choose the folder again.`
- `wizard.signinLine`: `Sign this computer in with your Rulith account: Rulith opens in your browser; approve it there, then come back here.`
- `wizard.modelLine`: `Choose a model service, then enter the model ID and key.`
- `wizard.folderLine`: `Choose a folder as the project: the Agent reads and writes files and runs commands in it. You confirm once before it opens.`
- `wizard.agentsUnreadable`: `Could not read the Agents.`
- `wizard.noAgents`: `This account has no Agent available on this computer: check this computer's sign-in authorization in Console.`
- `wizard.agent`: `Agent: {name}`
- `wizard.agentLabel`: `Agent: `
- `wizard.chooseAgent`: `Choose an Agent`
- `wizard.later`: `Later`

### The settings page (`settings`)

- `settings.title`: `Settings`
- `settings.close`: `Close settings`
- `settings.entry`: `Settings · {status}`
- `settings.sections.account`: `Account`
- `settings.sections.computer`: `This computer`
- `settings.sections.model`: `Model`
- `settings.sections.appearance`: `Appearance and language`
- `settings.sections.advanced`: `Advanced`
- `settings.localUnreadable`: `Could not read Rulith on this computer.`
- `settings.actionFailed`: `The operation did not finish`
- `settings.account`: `Account`
- `settings.unnamedAccount`: `(Unnamed account)`
- `settings.notSignedIn`: `Not signed in`
- `settings.signingOut`: `Signing out…`
- `settings.signOut`: `Sign out`
- `settings.computerSignInFirst`: `Sign in to Rulith under Account first to set up Agents on this computer.`
- `settings.computer`: `This computer`
- `settings.unnamedComputer`: `Unnamed computer`
- `settings.setupHint`: `“Set up on this computer” does it in one step: connect this computer, install the coding tools and turn this computer on. One already set up is checked and anything missing is added, with no restart; setting up grants no folder or tool permission.`
- `settings.noAgents`: `This account has no Agent available on this computer.`
- `settings.modelSignInFirst`: `Sign in to Rulith under Account first, then set the model.`
- `settings.appearance`: `Appearance`
- `settings.system`: `Follow the system`
- `settings.light`: `Light`
- `settings.dark`: `Dark`
- `settings.noAppearance`: `No appearance setting is available here.`
- `settings.language`: `Language`
- `settings.languageValue`: `English, from your browser's language`
- `settings.languageNote`: `Rulith and the rest of the page use your browser's language: Chinese when it is Chinese, otherwise English.`
- `settings.otherClients`: `Other clients`
- `settings.otherClientsLine`: `Other MCP clients (Claude Code, for example) can reach the same Agent with the Agent's MCP token. Get the token in Console: open this Agent's page and find “Agent MCP token”.`
- `settings.openInConsole`: `Open the Agent in Console`

### Agents set up by the retired workbench (`legacy`)

- `legacy.one`: `1 Agent`
- `legacy.many`: `{n} Agents`
- `legacy.notice`: `{count} set up by the retired Rulith workbench ({home}) no longer start their Workers with rulith. Run "rulith manager" to keep them running, or set each Agent up again here; that replaces its Agent token, and Sources bound to its old Connection must be bound again in Console.`

### Settings → Advanced: running model commands without isolation (PSC 0.2.31 ③ ④) (`isolationSwitch`)

One switch per Agent set up on this computer, off by default, shown only where model commands can be isolated (Windows
and Linux). Turning it on asks first with the confirmation below; only its `accept` button turns it on. Turning it off
asks nothing. The switch's name and the whole confirmation are PSC 0.2.31 ④'s English, verbatim.

- `isolationSwitch.title`: `Model-command isolation`
- `isolationSwitch.label`: `Run without isolation (not recommended)` (PSC 0.2.31 ③, the switch's name)
- `isolationSwitch.confirmTitle`: `Run model commands without isolation?` (PSC 0.2.31 ④)
- `isolationSwitch.confirmBody`: `Commands the model runs through the engineering capability will be able to read everything your account can read on this computer, including Rulith's own credentials. Turn this on only if isolation cannot work here and you accept that risk.` (PSC 0.2.31 ④)
- `isolationSwitch.accept`: `Run without isolation` (PSC 0.2.31 ④)
- `isolationSwitch.cancel`: `Keep isolation` (PSC 0.2.31 ④)
- `isolationSwitch.restarting`: `Saved. {agent} restarts on this computer to apply it, once any command it is running finishes.`
- `isolationSwitch.nextStart`: `Saved. It applies the next time {agent} starts on this computer.`
- `isolationSwitch.notSaved`: `Not saved`
- `isolationSwitch.stopped`: `Stopped what model commands had started without isolation: {names}.` (under an Agent's switch, after isolation was required again; `{names}` is each process's name and id)
- `isolationSwitch.notStopped`: `Could not stop what model commands started without isolation: {names}. Stop them yourself, or restart this computer.`
- `isolationSwitch.notChecked`: `Could not check what model commands started without isolation left running: {reason}.`

### Settings → Advanced → Diagnosis (`diagnosis`)

- `diagnosis.title`: `Diagnosis`
- `diagnosis.reading`: `Reading…`
- `diagnosis.unreadable`: `Rulith could not read its diagnosis.`
- `diagnosis.versions`: `Rulith {rulith} · DeepSeek Harness {dsh} · Node.js {node} · {platform}`
- `diagnosis.computer`: `This computer: {name} · {signedIn}`
- `diagnosis.unnamed`: `unnamed`
- `diagnosis.signedIn`: `signed in`
- `diagnosis.notSignedIn`: `not signed in`
- `diagnosis.starting`: `starting`
- `diagnosis.off`: `off`
- `diagnosis.notSetUp`: `not set up`
- `diagnosis.isolation`: `Model-command isolation: {text}`
- `diagnosis.unknown`: `unknown`
- `diagnosis.projectNotProtected`: `Project folder not protected: {path} ({reason})`
- `diagnosis.notProtected`: `Not protected: {path} ({reason})`

### The page's frame: sidebar, task panel tab, empty conversation page, file references (`shell`)

- `shell.toggleSidebar`: `Toggle the sidebar`
- `shell.collapseSidebar`: `Collapse the sidebar`
- `shell.openSidebar`: `Open the sidebar`
- `shell.childHistory`: `Earlier sub-conversation (read only)`
- `shell.panel`: `Tasks`
- `shell.panelGuide`: `Tasks, acceptance criteria, recent operations and this computer`
- `shell.openFirst`: `Open a conversation first`
- `shell.emptySession`: `Say what you want done`
- `shell.emptyNone`: `Start a new conversation under an Agent on the left`
- `shell.files`: `Files and folders`
- `shell.project`: `Project`

### dsh's own sentences the app replaces (by dsh namespace and key) (`dsh`)

- `dsh.chat:chat.deepDiving`: `Working…`
- `dsh.chat:chat.deepDivingFor`: `Working for {duration} ···`
- `dsh.chat:message.failure.accountSignedOut`: `Stopped because you signed out.`
- `dsh.chat:message.failure.accountSignInRequired`: `Sign in first, and make sure the request address supports account authentication.`
- `dsh.conversation:placeholder.default`: `Say what you want done`
- `dsh.conversation:placeholder.hero`: (empty)
- `dsh.conversation:placeholder.workspace`: `Start a conversation on the left first`
- `dsh.conversation:hero.headline`: (empty)
- `dsh.conversation:hero.preview`: (empty)

## The host (`ui-texts.mjs` `HOST_TEXTS.en`)

### Conversation requests (`session.*`)

- `session.invalid`: `This conversation's id is not valid.`

### The local Runtime manager (`manager.*`)

- `manager.incomplete`: `Rulith on this computer did not complete this request ({status}).`

### A conversation's settings (`conversation.*`)

- `conversation.agentNotSetUp`: `This conversation's Agent is not set up on this computer yet: choose “Set up on this computer” for it on the left first.`
- `conversation.sharedBoard`: `This app is set to keep one record for all conversations (conversationBoards off), so a conversation's exploration mode and review can be changed only in Console.`

### The sidebar's folders (`tree.*`)

- `tree.workspace`: `Workspace`

### Recording a conversation's Agent (`assign.*`)

- `assign.incomplete`: `The request names no conversation or no Agent.`
- `assign.notSetUp`: `This Agent is not set up on this computer yet.`
- `assign.otherAgent`: `This conversation already belongs to another Agent: start a new conversation.`

### The signing route (`sign.*`)

- `sign.incomplete`: `The signing request is incomplete: it lacks the task, the confirmed criteria or this confirmation's request id.`
- `sign.unconfirmed`: `The signature was sent; its result is not confirmed yet.`
- `sign.notThisRequest`: `The answer received does not confirm this signature.`

### The app's guarded routes (`route.*`)

- `route.pageOnly`: `Only Rulith requests sent by this page are accepted.`
- `route.sessionUnconfirmed`: `Rulith could not confirm this page's session.`
- `route.sessionNeeded`: `This needs this page's Rulith session.`
- `route.sessionRefused`: `This page's Rulith session did not pass the check.`
- `route.unknown`: `There is no such Rulith route.`

### A folder typed or chosen (`folder.*`)

- `folder.network`: `This is a network folder (a shared folder or a mapped network drive). Commands on this computer cannot run in it; choose a folder on a local disk.`
- `folder.empty`: `Enter a folder path.`
- `folder.fullWindows`: `Enter the full path, such as D:\work\project.`
- `folder.fullPosix`: `Enter the full path, such as /home/you/project.`
- `folder.missing`: `This computer has no such folder: {path}`

### Opening a folder as a project (`open.*`)

- `open.notSignedIn`: `This computer is not signed in to Rulith: sign in at the bottom left first.`
- `open.notInAccount`: `This Agent is not in the signed-in account.`
- `open.notSetUp`: `This Agent is not set up on this computer: choose “Set up on this computer” on the left first.`
- `open.runtimeOld`: `The Rulith Runtime on this computer is too old to open projects: update the Rulith app, then try again.`
- `open.noRequestId`: `This opening has no valid request id; confirm it again.`
- `open.noVersion`: `This opening has no confirmed content version; confirm it again.`
- `open.protectedFolder`: `This folder contains, or is inside, a folder where Rulith keeps its own data (credentials or work files), so it cannot be opened as a project. Choose a folder that holds no Rulith data.`
- `open.unprotectable`: `Rulith could not make this folder writable for isolated model commands: {reason}. Nothing was opened. Choose a folder on an NTFS drive that your account owns.`

### The setup route (`setup.*`)

- `setup.unknownRequest`: `No setup request was named to look at.`
- `setup.notFinished`: `This Agent's setup on this computer did not finish.`
- `setup.inProgress`: `This Agent's setup on this computer is still running; try again later.`

### The folder chooser (`picker.*`)

- `picker.unavailable`: `This computer cannot open the system's folder chooser: type the folder's full path instead.`
- `picker.open`: `The folder chooser is already open: choose a folder or cancel in that window first.`

### The model: settings routes and a conversation's turn (`model.*`)

- `model.unreadable`: `Rulith's model settings cannot be read.`
- `model.agentElsewhere`: `This conversation belongs to Agent “{name}”, which is not set up on this computer under the account signed in now (after switching accounts, for example). Nothing was sent: this conversation uses only its own Agent's model in its own account. Sign in to that account, or set this Agent up on this computer, then send again.`
- `model.notSet`: `The signed-in account has not set a model for this conversation's Agent yet: set one under Model in Settings; it applies from the next turn.`
- `model.notSignedIn`: `This computer is not signed in to Rulith yet: sign in under Account in Settings first.`
- `model.accountChanged`: `The signed-in account just changed: open the model settings again, then save.`
- `model.chooseAgent`: `Choose an Agent of the account signed in now.`
- `model.agentNotSetUp`: `Set this Agent up on this computer first, then give it a model of its own.`
- `model.chooseSource`: `Choose whether to use the account's model or this Agent's own.`
- `model.defaultsElsewhere`: `This app reads the account's model settings from another Rulith folder (modelHome); change them there.`

### Model-command isolation: Diagnosis, and the switch's route (`isolation.*`)

- `isolation.unavailable`: `Not available on this platform yet: model commands run with your account's access.`
- `isolation.linuxOn`: `On: model commands run under bubblewrap, with Rulith's own folders hidden.`
- `isolation.noBwrap`: `Bubblewrap (bwrap) is not installed: model commands are refused until it is.`
- `isolation.refusingOne`: `Model commands are refused: {roots} is not read-protected. Restart Rulith to protect it again.`
- `isolation.refusingMany`: `Model commands are refused: {roots} are not read-protected. Restart Rulith to protect them again.`
- `isolation.windowsOn`: `On: model commands run at low integrity and cannot read Rulith's own folders.`
- `isolation.offFor`: `{status} Turned off for {agents} (RULITH_ADAPTER_SANDBOX=off; not recommended).`
- `isolation.pendingFor`: `{status} For {agents} it applies after the Worker restarts, once the commands it is running finish.` (isolation required again while that Agent's Worker still runs unconfined)
- `isolation.incomplete`: `The request does not say which Agent, or whether its model commands run without isolation.` (the switch's route)
- `isolation.unconfirmed`: `Running model commands without isolation needs your confirmation. Nothing was changed.` (the switch's route, turned on without the confirmation)

### Where Rulith keeps its files (Diagnosis) (`folders.*`)

- `folders.files`: `Rulith files`
- `folders.manager`: `Local manager`
- `folders.conversations`: `Conversations (DeepSeek Harness)`
- `folders.logs`: `Logs`
- `folders.kit`: `General kit settings`
- `folders.work`: `Model command work area`
