// Test bootstrap (loaded with `node --import`): the suite runs model-command isolation OFF by default, the explicit
// owner-style disable. Most tests exercise the Worker's run loop and the real adapter in throwaway directories, not the
// confined product path; the OS sandbox there would need labeled credential roots and a compiled launcher per case.
//
// This does NOT weaken the P0 proof: the default is required (worker/adapter-confinement.mjs, asserted by a unit test),
// and the confined product path is proven end to end — including that a managed-instance Worker, whose isolated
// environment strips this very variable, defaults to required — by app/test/harness/model-command-isolation.test.mjs
// (ACC-ISO-07/08). Setting it in the test runner's environment before any test file is spawned lets child test
// processes inherit it; tests that assert confinement pass `required` explicitly to confinedLaunch.
if (process.env.RULITH_ADAPTER_SANDBOX === undefined) process.env.RULITH_ADAPTER_SANDBOX = 'off'
