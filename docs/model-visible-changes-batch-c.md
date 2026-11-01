# Model-visible changes in batch C (D-1031a, 2026-11-01)

中文摘要：批次 C 没有新增或改写模型看得到的文字。附录第一句本来就有两个已批准的版本（含不含 web_search），现在按
web_search 此刻是否真的注册来选，而不只看启动时的开关（第 1 节）。工具包是官方编程能力 1.0.0 的原样，字节不变；应用给
它设置的 kit home 写入它本来就读的设置，模型因此会遇到几处行为变化（第 2 节）：每条命令最长 600 秒，允许项目内安装与删除，
Windows 上命令经 cmd 运行（npm、npx 才能启动，管道、&&、重定向也随之可用；Linux 与 macOS 不开 shell）。工具包的拒绝说明原因与测量规格路径的
改动留给单独的批次（kit 1.1）。

Authority: the coordinator's batch C brief (D-1031a), from the product review of 2026-10-31 (`01-product.md` findings 2
and 19), and the decision that batch C ships without changing the official engineering capability (no new Release, no
recipe change): the kit is the capability's 1.0.0 as it is, byte for byte. Named kit refusals and the
`.rulith/measure` path wait for their own batch, "kit 1.1".

Nothing the model reads is new or reworded: the persona, the addendum (its measure sentence included), the three Rulith
tools and their schemas, the Board layout of results, the web tools' text, the kit's refusals and the project context
line are as on main.

## 1. web_search is named only while it is registered

- Location: the persona section the gates install (`app/harness/rulith-gate.mjs`, `app/harness/web/rulith-web-gate.mjs`),
  now computed at each prompt assembly by `app/harness/web-tools.mjs` `addendumText`.
- Why: the addendum promised web_search to models that usually do not have it (product review finding 19). The choice
  used to follow the launch flag only; now it follows whether `web_search` is registered for the agent the prompt is
  assembled for (`tools.get('web_search', scope)`, the check dsh's own web_search guidance makes).
- The text is not new: it is one of the two approved first sentences, unchanged.
- With web_search registered:

```text
Your tools are Rulith's three and the read-only tools web_search and web_fetch.
```

- Without it:

```text
Your tools are Rulith's three and the read-only tool web_fetch.
```

## 2. Tool behaviour the model meets (no new text)

The app writes `settings.json` into a kit home it sets up when that home has none (`kits/general/installer.mjs`
`APP_KIT_SETTINGS`; an owner's own file is never replaced). These are settings the 1.0.0 kit already reads. A kit home
that never had a settings file gets them at the app's next start or repair, so an existing Agent changes too on upgrade
(the release notes say so):

- `runDeadlineSeconds` and `pollMaxWaitSeconds` 600 (were 35): installs, tests and builds can take up to ten minutes per
  command; a check's repeats share that deadline (`eng.measure_pinned` gives each of N repeats 600/N seconds). Until the
  Agent's Worker restarts, its own 95-second limit still stops longer commands.
- `allow: ["install", "delete"]`: `npm install`, `pip install`, `cargo add` and deletions inside the project run (they
  were refused with `command refused`).
- `shell` on Windows only: every `eng.run` command and job goes to `cmd.exe`, so `npm`, `npx`, `pnpm` and `yarn`
  start, and pipes, `&&`, `||`, redirects and variables work. Linux and macOS keep the shell off: npm needs none there,
  and macOS has no isolation, where the shell's `~`, `$HOME` and globs together with allowed deletions would turn a slip
  into a deletion outside the project. With the shell on, the classifier's words are a courtesy check only (kit README):
  it reads the words as written, so a caret or variable inside a word (`git pu^sh`, `npm i ^-g`), privilege and
  process commands after `&`, `;` or `|` (it checks those on the first word only), and code given to `powershell` or
  `bash -c` pass it. The boundary is model-command isolation. On
  Chinese Windows, cmd's built-in commands print in the console code page, so their output in receipts may not be UTF-8.
- An acceptance check that runs `npm test` on Windows needs a spec with `"shell": true` and the command as one string
  (`{"command": "npm test", "shell": true, …}`): an argv spec (`["npm", "test"]`) is never given to a shell, and the
  1.0.0 kit cannot start a `.cmd` program without one. Such a check runs the script in `package.json`, so the spec
  should freeze `package.json` too. A check passes when its whole line exits with 0, so a line that joins commands
  (`npm test | tail -20`) passes on the last one's status. The sign card in the app and in Console says both of these
  next to the check; refusing them is kit 1.1's.
- `treeExclude`: `node_modules`, `.git`, `dist`, `.venv`, `target` and every `__pycache__` are left out of the tree
  digest, so a test run that writes there no longer makes its own pass not current. Whole-tree `eng.search` and
  `eng.glob` skip them too (the addendum's "eng.search covers the whole tree" means the tree the digest covers), and a
  command's changes there no longer withdraw passes. `build` stays in: in many projects it is source.
- The tree digest includes these settings, so a kit home that gets them on its next setup or repair starts a new tree
  generation once: earlier passes there need to run again; certified goals are untouched.
