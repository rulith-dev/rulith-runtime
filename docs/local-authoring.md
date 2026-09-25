# Document assistant

1. Sign in to Rulith, select an enabled Agent, configure its model and start its Worker.
2. Open **Document assistant**, choose at least one material delivery permission, then
   press **Prepare local assistant**. A remote model needs the explicit remote-disclosure
   permission as well as local delivery when it reads a locally held document. Preparation
   with both permissions off is refused before installing the assistant: its ingest action
   would otherwise run without any permitted path to register its Artifact result. Preparation installs the ordinary
   `official_authoring@3.0.0` Release on that Agent and binds its file Source to this
   profile's material area. It downloads two pinned public checker JARs once per computer.
   Java 25 is required. Existing conversations and credentials are retained.
3. Attach a UTF-8 `.txt` or `.md` document (at most 256 KiB) in the conversation. Ask
   the Agent to prepare a capability from it, answer its questions, and let it run
   the mechanical checks and close the matching Case after they pass. The preferred
   `construct_rule_draft` Action accepts an explicit compact construction, expands only
   repeated predicate namespaces/references and the fixed certified Case terminal, then
   sends that expanded draft through the same compiler, kernel example runner and exact
   citation checker used by `check_rule_draft`.
4. Open **Document assistant → Review checked draft**. Review its rules, examples,
   citations and unresolved questions. If several recent checks exist, choose the exact
   **Checked version**; each revision has its own local result and must match a certified Case.
   A failed version read returns the choice to the draft still shown. Choose **Save private
   draft** after the exact proposal has a certified completed Case. Reopening that checked
   result shows its saved receipt, including after restarting Local. Publication remains
   a separate Console action.

Each newly checked result has its own immutable, Agent-scoped local index entry. The
version selector shows the 200 most recent entries; an older result remains readable by
its exact result ID. Checks by different local Workers no longer rewrite one shared list.

If Save receives no reply, Rulith reads that same immutable checked version again before showing an
outcome. When the private draft was committed, its receipt appears without another
save. When the outcome cannot be checked, Save stays disabled; use **Review checked
draft** after the connection returns. A definite refusal keeps the selected Case
and permits an explicit retry. Repeated transport attempts for the same checked
proposal and Case carry one stable request identity.

Your Agent uses its selected model, including any Agent-specific override of the
account's local default. A remote model receives authorized material text directly
from Local. The Gateway stores material references and digests; the original file
does not pass through Gateway storage. Draft text, quotations and check metadata
are part of the governed work and the private draft you explicitly save.

The checker reports actual compilation, example execution and verbatim citation
matching. An `attested` result describes those checks, not legal, tax or business
correctness. The Release's official publisher and local execution do not increase
the Source's grounding tier.

The constructor is a syntax boundary, not a second author. Its input must still name
every predicate, alias, rule atom, Case key, grounding floor, example, citation and
unresolved question. It does not infer business keys, add missing guards, repair examples,
choose evidence tiers or alter quotes. A construction error is reported separately from a
checker failure. The local Artifact retains the submitted construction, the exact expanded
draft and the checker report so Review checked draft always shows what actually ran.

Check receipts carry mechanical counts and fixed error codes. The complete draft
and detailed checker report remain in the local immutable Artifact. When space
permits, the model also receives failing example indexes (zero-based), counts,
fixed citation failure reasons and separately labelled format guidance. Free-form
example labels, exception details and quoted text are not copied into this inline
guidance. A smaller receipt budget omits the optional guidance; it does not discard
required facts or turn a failed check into a pass. Reading the full report still
requires the current material delivery permission.

Preparation grants material access only to the selected Agent and its current
Source/Connection/material-root binding. Deployment denials take precedence.
An unlocked Source or a different Connection/material-root binding cannot use that
managed permission. Preparing a new binding requires an explicit operator action.
A Worker without the pinned checker or Java 25 fails
with a setup message; it never falls back to a hosted model or checker.

For an offline development fixture, `RULITH_AUTHORING_JAR` can name an absolute
`local-authoring.jar` with its matching `rule-check.jar` beside it, and
`RULITH_AUTHORING_JAVA` can name an absolute Java 25 executable. These are operator
configuration, never arguments the model can supply.
These overrides apply to the Worker process. The workbench's **Prepare local
assistant** button installs the public checker pinned by this Rulith release.

The preparation dialog reads the selected Agent's current material permissions through
`POST /manager/authoring/status` before enabling submission. This is a read-only device
control-plane request: the Gateway verifies the account, Agent, Connection and material
root. Existing permissions are loaded afresh on each opening; an unavailable read cannot
silently replace them with checkbox defaults. A binding to another Worker or material
area must be unlocked in Console first. Periodic workbench refreshes do not overwrite
choices while the dialog is being edited.

The dialog offers **Start Worker** when needed and waits for its initialization before
enabling preparation. The manager checks the selected account, Agent, Connection and
Worker before any checker download, then checks the same target again after installation.
If access, configuration or Worker readiness changes during the download, preparation
stops before sending the setup command. A model endpoint change requires restarting the
Worker before new attachments or preparation, as indicated in the selected workspace.
Signing out can stop the local roles and revoke the device while the public checker
download continues; completing that download cannot resume setup under a different login.
