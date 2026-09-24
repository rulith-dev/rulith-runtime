# External Action input adoption in the Worker

This Runtime implements a narrow v2 execution phase for Source-bound database
Tools. On Poll, a Worker states `inputAdoption` only if its installed manifest
contains a compatible fixed SQL Tool and its configured Source table
contains a `db` Source with a DSN. The claim names each ready Source for each
eligible Tool under `sourceNamesByExec` and is fixed for that Worker instance's
lease generation. A read Tool can advertise `rulith.value.enum@1`; a write Tool
can advertise that guard and `rulith.payload.bounded-text@1`. A Worker with no
eligible Tool and Source sends no v2 claim. Tool authorization still belongs to
the Connection lock and the Gateway/Core fence, not to this advertisement.

The catalog bytes are vendored from the protocol repository; their SHA256 is
`55d92d40901868ac10ba2198f1778ec550899a51e218561c90b91b7816997f9f`.
The Worker compares every v2 dispatch to that digest. It matches the served
Tool's kind, parameter table, Source types and returns against the locally
pinned manifest descriptor; resolves the invocation's named Source against its
authorized Source table; compiles only the local SQL template; and checks the
original signed grant against the exact request bytes and local Tool pin before
ClaimWork. Roles inside `execution`, a mixed legacy `inputPolicy`, an unknown
guard, and non-database Tool or Source combinations are refused before claim.
For each eligible Tool, Poll also fingerprints the canonical
`{exec,kind,sourceTypes,params,returns}` descriptor under
`toolContractsByExec`. The Gateway and Core must intersect this claim with their
approved locked Tool and Source; the Worker claim alone grants no Tool.

The read template is a single `SELECT` of literal columns from a literal table
with equality predicates and typed driver value placeholders. The write
template is one simple `UPDATE` of a literal table: guarded data placeholders
appear only in `SET`, and at least two distinct grounded placeholders appear
only in `WHERE` for target and base version. Both templates have a nonempty
returns map of columns actually selected or returned by the database; writes
use a fixed `RETURNING` column list. Quotes, comments, subqueries,
expressions, function calls, joins and multi-statements do not enter this v2
phase. Enum values use exact scalar type and value equality; bounded text uses
the UTF-8 byte count of the supplied string. A payload is always a driver
parameter, never SQL text, target identity, version or an executable fragment.
Every SQL placeholder in this phase must have a required scalar type; optional
parameter slots are refused before claim because the compiler has no fixed
omitted-value SQL interpretation.

A successful v2 write requires the database driver to report exactly one
`UPDATE` row and one readable returned row. Zero rows is a known failed
conditional update. Multiple rows or
an unreadable row count are an uncertain external effect: the Worker leaves the
invocation pending for reconciliation and does not execute it again. This guard
does not prove a database uniqueness constraint exists, and a multi-row effect
may already have happened before its row count is known. A deployment should
back the target column with an actual unique key and use a real base-version
predicate. A transport loss or database error after submission can also be
unknown; neither a Worker lease nor a signed Rulith grant makes the external
database effect idempotent.

This batch does not adopt `run`, HTTP, MCP, workspace/path, JSON, Artifact or
Source-free v2 inputs. It does not establish an end-to-end Core/Gateway/Worker
journey or prove a live database schema. The targeted tests exercise the real
Worker Poll and pre-claim refusal path, fixed SQL compilation and mocked driver
row-count outcomes. The original legacy execution path remains available under
its existing Tool and Source controls, with the HTTP write safeguard below.

An HTTP write now requires a locally configured, digest-pinned terminal response
profile in its Tool's `fence.completion`, for example
`{"stage":"terminal","statuses":[200],"json":{"field":"status","equals":"completed"}}`.
The Worker refuses a write lacking this profile before ClaimWork. A configured
write stays pending without an outcome report if the endpoint returns only
acceptance (including `202`, or `200` with `status: accepted`), a partial/error
status, an unreadable body, or a lost response after the request. The profile
is checked against the bounded response body; the work item's own `toolSpec`
cannot replace it. A post-execution return-mapping error is also unknown, not a
known failed write. An HTTP Tool declared as a read may use only GET or HEAD;
an operator-declared write remains a write even if its method is GET. The Worker
never follows a redirect for a write.

This is a fail-closed interim guard, not full B4 adoption. Submit-only Actions,
partial-effect reports, a durable remote outcome reconciliation path, and
completion-stage enforcement in Core and Case rules remain unavailable. An
existing HTTP write Tool without a terminal profile needs an operator-reviewed
version and refreshed Connection pin before new execution; do not replay an
already dispatched invocation to obtain a new result.

`sourceNamesByExec` lists only local `db` records with nonempty DSNs. The Worker
checks each v2 work item's Tool and Source against the frozen first-Poll list
before ClaimWork, so a later Source refresh cannot extend that lease's scope.
Gateway/Core must intersect each listed Source with its own governed record
before enabling an invocation; local readiness alone grants no Source access.
