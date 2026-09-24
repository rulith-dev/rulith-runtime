# Action input contract adoption

The current external Worker path executes the legacy input contract. It does not
advertise or implement the v2 per-parameter roles or guard phases yet. A work item
carrying `inputRoles` or `guardCatalogDigest`, including a misplaced field inside
`execution`, is refused during Tool resolution before ClaimWork and before the
adapter can run. A valid signature authenticates the supplied bytes; it cannot
make an older binary understand a newer contract.

The real-Worker regression starts a Worker against a scripted signed Work endpoint
and inspects the adapter's actual write log. All four unadopted-field cases executed
before this correction and now must produce zero claims, adapter executions and
reports. This is a compatibility boundary test, not end-to-end v2 adoption.

The Java B1c contract freeze sends the full legacy declaration in `toolSpec` and
retains the existing execution-request/2 identity. Legacy declaration metadata
continues to work. New roles remain unavailable until the Core, Gateway, locked
Tool contract and Worker have adopted every required phase with matching catalog
identity. Path creation, JSON/Artifact guards, human confirmation and outcome
recovery are separate incomplete work; this change grants none of them.

The existing workspace writer is not an implementation of
`rulith.source.new-relative-path@1`: it permits a regular existing target and
renames a temporary file over it. Its path checks also precede the final write,
so they do not provide an atomic defence against replacing an ancestor with a
symlink or Windows junction. That phase remains unavailable until the actual
filesystem primitive and race tests satisfy the guard contract.

Validation for this boundary change: 20 targeted tests passed, including four
new cases first demonstrated failing on the prior implementation; `npm run check`
and the 50-file artifact manifest verified. Full `npm test`: 938 passed, one
existing platform skip, zero failures (102.498 seconds). No release or production
deployment is included in this development batch.

The changed Runtime also passed the Java B1c real Core/Gateway material journey
(`scripts/verify-local-materials.mjs` at Java `a2e27f6`, with
`RULITH_MCP_RUNTIME=D:/Work/rulith-runtime-action-inputs`). Evidence is in that
Java worktree's `gateway/target/local-materials-7hvIcF`: real file selection,
Worker execution, exact request identity, third-party MCP proxy reads, local
Agent delivery and absence of original payload in Gateway storage. Its model
endpoint is deterministic; this does not replace the later real-model journey.

The next adoption step must negotiate compatible phases through an authenticated
Worker lease and check them before Core creates a v2 invocation. Rejecting only
at dispatch time would leave an unavailable action pending. Agent arguments must
not supply that compatibility assertion; the live deployment and the locked
Tool contract are the authority for it.
