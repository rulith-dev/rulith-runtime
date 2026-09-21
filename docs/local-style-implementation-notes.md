# Local Console styling — implementation notes

Scope of this batch: the four existing Local browser pages plus one new shared stylesheet
module. No manager, account, device, CLI, manifest-generator or Runtime logic was touched.
Changes are left uncommitted for root review.

Root integration: the real Local host rendered all three pages in Chrome at 1440 and 390
pixels with no page overflow or JavaScript errors. The Windows packaging test now extracts
the relative archive name from its working directory; the full suite subsequently passed
501 tests with zero failures and one existing skip. Follow-up CSS fixes remove a nested
code-block border and restore wrapping in Markdown table headings. These are style-pass
results; the account/multi-Agent integration has its own acceptance work.

Files changed: `local/theme.mjs` (new), `local/local-ui.mjs`, `local/setup-ui.mjs`,
`local/worker-tools-ui.mjs`, `local/mcp-registry-ui.mjs`, `test/local-style.test.mjs` (new),
`artifact-manifest.json` (hashes only — see *For root* below).

## Why there is now a shared sheet

Before this batch each page carried its own palette: three slightly different blue-blacks,
two different teals, and four sets of button rules. That is how "Local looks like Console"
stops being true one page at a time, and it is why the Console palette could not simply be
pasted in four places. `local/theme.mjs` exports `localThemeCss`, a plain string that every
page inlines into its single `<style>` element before its own geometry rules. The pages keep
their own layout; only tokens and the small shared component vocabulary moved.

`localThemeCss` is deliberately a string with no build step, no import graph and no network
fetch, so `local/manager-ui.mjs` can use it by writing `<style>${localThemeCss}</style>` and
nothing else. What it provides: the token block, base typography and links, focus rings,
`.page` / `.reading` centred containers, `.card`, `.btn` (+ `.s` / `.sm` / `.danger` /
`.primary` / `.button`), form controls including `.txt`, `.row` / `.actions` / `.field` /
`.fieldgrid`, `.pill` (+ `ok` / `wait` / `info` / `bad`), `.kv`, `code` / `pre`, `.table` and
table cells, `details` / `summary`, `.empty-note`, `.notice` (+ `.error`), `.brand-mark`,
`.manager-return`, and a `max-width:920px` breakpoint. A bare `<button>` is styled as the
*secondary* control on purpose: page scripts create plenty of buttons without a class, and
they should not come out unstyled or accidentally primary.

## Palette, taken from Console

Values are copied from `rulith-java/console-web/src/parity/review.css`, documented in
`rulith-java/docs/console-theme.md`. Contrast was measured and asserted on the Console side;
it is not re-derived here, and no value was adjusted.

| Token | Value | Local use |
| --- | --- | --- |
| `--bg` / `--side` / `--panel` / `--panel2` / `--field` | `#151515` `#1c1c1c` `#242424` `#2e2e2e` `#1a1a1a` | page / rails / cards / hover + raised / inputs and verbatim blocks |
| `--line` / `--line2` | `#313131` `#414141` | separators / control outlines |
| `--fg` / `--dim` / `--faint` | `#ededed` `#a9a9a9` `#999999` | body / secondary / tertiary |
| `--accent` / `--accent-d` | `#5c9cf5` `#4a86dd` | links, selection, focus rings / focus and pressed outlines |
| `--btn-fg` / `--btn-ink` | `#f2f2f2` `#171717` | light primary button |
| `--brand` | `#35d0ba` | RULITH mark only |
| `--green` / `--amber` / `--red` | `#4fd18e` `#edb642` `#f77b86` | assist a written status, never carry it alone |

Console keeps the legacy name `--cyan` because its reference sheet and pages already
reference it. Local had no such constraint, so the token is named `--accent` here; the value
is identical. `localThemeCss` does not declare `--cyan`, so a page that expects the Console
name must alias it.

Deliberate separations kept from the Console decision: brand teal is the sidebar/header mark
and nothing else; a primary action is a light surface with dark ink; blue means navigable or
informational; a pressed secondary control (`My tools`, `MCP directory`, the setup step tabs)
gets a blue outline rather than being promoted to a primary button, because a row of controls
that all look like the main action tells a reader nothing.

## The "Back to agents" entry

Provided through an **optional parameter**, never a constant:

- The launcher passes its own address in `?manager=`. `MANAGER_RETURN_PARAM` names the key.
- `managerReturnHref(search)` in `local/theme.mjs` decides whether that address may be
  rendered at all. It is exported for Node-side tests and embedded verbatim into each page's
  script, so the browser and the tests apply the same rule.
- Accepted: `http:` / `https:` on `localhost`, `127.0.0.0/8` or `[::1]`. Rejected: any other
  scheme (a `javascript:` href is script execution on the page), any non-loopback host (a
  return link must not become a redirector), and any URL carrying userinfo credentials.
- Root integration corrected the initial return-link assumption: the real manager requires
  its browser key even for GET `/`; same-origin protection alone is not authentication.
  Only the loopback root and a single validated `k` browser capability survive. Other query
  fields and fragments are dropped. This is not the cloud device management token, which
  remains server-side. The pages use no-referrer.
- No port or host is hard-coded. When the parameter is absent or rejected, no
  link is rendered at all — a page opened directly does not promise a destination that is not
  running.
- The value is carried onto sibling Local pages (`/`, `/setup`, `/worker-tools`) so the way
  back survives navigation within Local. It is never appended to a Console or Gateway URL.

Placement: the workbench sidebar footer, plus a second copy inside the Runtime details dialog
because the sidebar is hidden below 720px; the setup page header; the worker-tools header.

## Preserved on purpose

- Export shapes unchanged: `localPage`, `setupPage`, `workerToolsPage` are still strings, so
  `rulith-local.mjs` still calls `res.end(page)`; `attachRegistryBrowser` keeps its options
  object and its `{ updateButtons, detail, search }` return.
- All element ids, `data-*` hooks, routes, key handling and gate behaviour are unchanged. The
  401/403 reload, the `?k=` read, `cache-control: no-store` and the absence of a
  server-substituted key are all still asserted by the existing suites.
- `worker-tools-browser.mjs` was not edited. `#back` still exists and its href is set by that
  controller; the page script only appends the manager parameter afterwards. The discovery
  table's checkbox is still the first `input` in its row, which is how selections are read.
- Rendering safety is unchanged: `renderToolCall` still escapes, `renderMarkdown` is
  untouched, and `mcp-registry-ui.mjs` still writes every directory string through
  `textContent`. The only change there is that generated nodes now carry class names
  (`btn s`, `card-title`, `download-count`, `outlink`) instead of relying on element
  selectors, so the shared sheet reaches them.
- Chat and tool tables were **not** narrowed. The conversation column stays `min(790px,100%)`,
  worker-tools keeps the full 1240px Console content width and its tables keep
  `min-width:660px` and scroll inside `.table`. The setup wizard uses the narrower 960px
  reading column, on the same centre axis as its header.

## Defects found and fixed along the way

- **The workbench was cut off on a narrow screen.** `.top` could not shrink below its own
  text, which dragged the whole shell wider than the window; because the shell never scrolls
  sideways, the right edge of every message was silently clipped. Fixed with
  `.top>div{min-width:0}` plus an auto-height header below 720px. Regression-asserted.
- **"Back to setup" covered the result notice.** It was a fixed element in the bottom-right
  corner, exactly where worker-tools writes every outcome. It now sits with the other header
  navigation; text and href are unchanged.
- **A search-box rule reached a checkbox.** `.row input{min-width:160px}` also matched the
  "Supported setup only" checkbox nested in a label, which the markup had been defeating with
  an inline `style="min-width:0"`. Scoped to `.row>input` and the inline style removed.
- Console's reference sheet defeats its own focus ring on text inputs with a more specific
  `outline:none`; `localThemeCss` states the ring explicitly rather than inheriting that.

## Verification actually run

- `npm test`: **500 passed, 1 failed, 1 skipped** (502 total). The one failure is
  `the packed npm artifact prepares the demo offline…`, which fails identically on this
  worktree *before* any of these changes — it shells out to `tar` and this Windows shell
  resolves `C:` as a remote host (`tar: Cannot connect to C: resolve failed`). It is an
  environment prerequisite, not a result of this batch, and it is **not** claimed as passing.
- `npm run check`: passes (syntax, line endings, MCP and Worker contract projections).
- New `test/local-style.test.mjs`, 7 tests: one shared sheet per page, retired literals gone
  and brand teal reachable only through `--brand`, controller ids intact, return link taken
  only from the validated value with no hard-coded address, the full accept/reject table for
  `managerReturnHref`, the local key never riding along, and the chat/table widths preserved.
- Browser rendering: a throwaway loopback harness in the system temp directory served the
  real `localPage` / `setupPage` / `workerToolsPage` with fixture JSON over the real routes,
  and Chrome captured them headless at 1440px and at a true 390px viewport (rendered inside a
  390px iframe — Chrome on Windows cannot create a window narrower than ~500px, so a plain
  `--window-size=390` crops instead of reflowing, and the first round of narrow screenshots
  taken that way was misleading). Checked: workbench with conversation, Markdown table, tool
  card and inspector; the Runtime details dialog; the setup wizard at all three steps; the
  tool inventory and the MCP directory. The harness and its screenshots live outside the
  repository and are not part of this change.
- Not verified here: any real Runtime, Worker, Gateway or Console traffic; the fixtures are
  synthetic. No screen-reader or contrast measurement was re-run on the Local side — the
  contrast figures come from the Console batch that defined these values.

## For root

1. **`local/theme.mjs` is not in the artifact manifest file list.** It ships inside `local/`
   (already covered by `package.json` `files`) and every Local page imports it, so it should
   be pinned like the other runtime files. Adding it means editing
   `scripts/update-artifact-manifest.mjs`, which is manifest logic and out of this batch's
   ownership — please add the path and regenerate.
2. `artifact-manifest.json` was regenerated with `npm run manifest` because the four edited
   files are hash-pinned there and `npm test` fails otherwise. Only those four hashes moved;
   the generator was not modified.
3. The pre-existing `tar` failure above will also need a Linux/CI run to clear.

## For the manager agent

`local/manager-ui.mjs` should inline `localThemeCss` as its whole base stylesheet and add
only its own geometry, so the manager and the instance pages stay one visual system. Use
`.page` (or `.page.reading` for forms) for the centred column, `.card` for instance tiles,
`.btn` for the one primary action per area, `.pill` for instance status next to a written
label, and `.manager-return` only if the manager itself is ever launched from something else.
Link to an instance with its own `?k=` plus an encoded `&manager=<manager root with its own
browser key>`. The "Back to agents" link must be tested against the real manager gate.
