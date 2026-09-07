# PSC evidence routing

`psc.json` records this repository's adoption of the approved PSC baseline. A
mapped entry identifies tests; it does not assert that they ran, that Cloud has
adopted the same behavior, or that a release was deployed. Blocked entries remain
open even when unrelated tests pass.

`npm test` checks the local inventory and runs its test targets as part of the full
suite. The Core repository's `scripts/check-psc-conformance.mjs` owns reconciliation
with the approved clauses and cross-repository assignments. Pass both peer
repositories and their full committed revisions with `--peer cloud <path> <commit>`
and `--peer runtime <path> <commit>`; it reads each inventory and target from that
Git commit. `--report` permits explicit adoption gaps, but never malformed or
missing evidence routes. A single peer can be reported while the absent peer's
assignments remain explicitly unreconciled; the strict check cannot pass that
state. No sibling checkout is required to run Runtime tests.
