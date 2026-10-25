# Model-command isolation (D-1024a / PSC 0.2.28 ①)

状态：设计稿（Phase 1）。本文只描述威胁、现状与拟采用的隔离方案；实现与测试在 Phase 2。

## 1. Why — 要堵的边界

官方编程能力让模型写下并运行项目命令（`eng.run` / `eng.job_start` / `eng.test` /
`eng.measure_pinned`，以及 `eng.write_file`/`patch_file` 之外真正启动进程的那几个）。这些命令以
**负责人自己的操作系统账户**运行，没有系统级隔离。PSC 0.2.24 的"打开项目"确认框、0.2.28 ① 的边界段
都已如实写明：在这台电脑上以负责人身份运行的程序——包括模型写下、经编程能力运行的项目命令——
在原理上能读到本机凭据并冒用它们（冒充 Worker 回报、设置档位、打开项目、签字）。

协议层这些入口都够不到：模型只拿到 Rulith 三工具 + 只读 `web_search`/`web_fetch`，
MCP 凭据、Worker、Runtime、规则、动作效果都写不了 `user_signed`。本机的缺口只有一条：
**模型写下的命令作为任意本机进程运行**，于是能绕过协议，直接读磁盘上的凭据或连本机端口。
这一批（model-command isolation）只堵这一条。

## 2. 威胁模型

- 主体：模型写下、经 `eng.*` run/job/test/measure 启动的命令及其整棵子进程树（子进程、
  子进程启动的解释器脚本）。这些进程以负责人 OS 账户运行，命令字与参数由模型给出。
- 不在范围：Worker/Agent/管理器进程自身的代码（受实现字节 pin 与审查约束）；
  `eng.write_file` 等不启动子进程的工具（已被 `fenced()` 限制在项目根内）。
- 能力假设：模型的命令**不可信**，可包含任意程序（含 `curl`、`node -e` 经 shell 时、
  读文件的脚本）。它不能提权（分类器已拒 `sudo`/`runas`/服务控制/全局安装/push/publish），
  但在当前 OS 账户内可自由读文件、发网络请求。

### 2.1 命令怎么被启动（已勘察）

- `kits/general/adapter.mjs` → `classify()`（`lib.mjs`，副作用分类器，非沙箱，README 自述）
  → `execute()`（`lib.mjs:656`）直接 `spawn()`，`shell:false` 走 argv，`shell:true`（主人设置）
  整行交系统 shell。`job_*` 经 `supervisor.mjs` 子进程再 `execute()`。
- `cwd` 由 `fenced(ctx.root, cwd)` 限在项目根；但**命令自身可访问任意路径**，分类器只对
  命令行里"看得见的路径参数"做项目/allowedPaths 检查（`commandPath()`），读文件的程序逻辑看不见。
- 子进程环境：`childEnv()`（`lib.mjs:612`）剥掉所有 `ENG_*` 与 `RULITH_*`，并在 Windows 置
  `NoDefaultCurrentDirectoryInExePath=1`。Worker 侧 `adapterEnv()`+`boundaryEnv()` 另剥一层
  （`RULITH_` 命名空间、凭据族 deny-list、NODE_OPTIONS/NODE_COMPILE_CACHE 等）。
  **结论：环境变量里的机密已经不泄漏给命令。缺口在磁盘读取与本机网络。**

### 2.2 其他可让进程运行 / 发请求的路径（已勘察）

- `web_fetch`（app `web-tools.mjs`，dsh 之上再查一遍）与 kit `web.mjs`：都把每个解析地址限为
  公网单播、钉住连接地址、只跟随同源重定向。**loopback / 私网 / 链路本地已被拒**（含
  `127.0.0.1`、`192.168/16`、`169.254.169.254`、CGNAT、IPv4-mapped IPv6）。
  残留：经 HTTP 代理时主机名最终由代理解析，代理与本机解析不一致（DNS 重绑定 / fake-ip）看不到。
- `web_search`：仅当模型路线是 DeepSeek 官方 API 时注册，密钥是该路线自己的，发往 `api.deepseek.com`。
- MCP 客户端（`worker/mcp-client.mjs`）：是 Worker 的工具装配路径，不由模型命令触发，不在本批范围。
- **唯一未堵的本机网络路径**：模型命令本身（`eng.run curl http://127.0.0.1:7790/...`、
  `node -e 'fetch(...)'`）。工具 SSRF 防线管不到子进程里的网络。

## 3. 磁盘上的凭据与本机端口（仅名字/路径，决不打印值）

app home 默认 `~/.rulith/app/`（可 `RULITH_APP_HOME` 改）：

| 位置 | 内容（机密项名字） |
|---|---|
| `~/.rulith/app/manager.key` | 管理器浏览器 loopback 密钥（owner-only ACL / 0600） |
| `~/.rulith/app/manager/registry.json` | 实例名录、设备记录 |
| `~/.rulith/app/manager/device.json` | 设备管理凭据（设备 bearer / deviceSecret / privateKey 的本机副本） |
| `~/.rulith/app/manager/instances/<id>/local.json` | `agent.env.RULITH_TOKEN`（Agent token）、Connection key、模型设置里的 `key`（模型 API key） |
| `~/.rulith/app/manager/instances/<id>/worker-secrets.json` | Worker Connection secret / vault |
| `~/.rulith/app/manager/instances/<id>/mcp/services.json`、`model-defaults.json` | MCP 凭据引用、模型默认 key |
| `~/.rulith/app/dsh/.credentials.yaml` | dsh 浏览器会话 cookie 签名密钥（`client-connection/browser-session`） |
| `~/.rulith/app/kit/settings.json`, `specs/`, `tree-*.json`, `kit-id` | kit home（ENG_KIT_HOME）：改它能放宽 `treeExclude` / 改写代数状态 / 冻结 self- 规格 |

本机端口（loopback）：管理器 `7790`（登录态 `x-rulith-manager` 密钥 + same-origin 守卫；密钥在内存/manager.key）、
启动器/应用 `3080`（`x-deep-rulith:1` + loopback Host 守卫）、各实例 host、模型引擎 `:8080`。
一个以负责人身份运行的命令读到 manager.key 就能向 `7790` 发登录态请求（设档位、打开项目、
0.2.28 起签字）；dsh cookie 密钥则能伪造浏览器会话到 `3080`。

## 4. 现有机制调查（node_modules/@deepseek-ai）

dsh 的进程沙箱 seam `ctx.sandbox`（`dsh-sandbox`）+ 本地后端 `dsh-sandbox-local`，自动按平台选
runner，不可用则 `SANDBOX_UNAVAILABLE` fail-closed，每次报告 `full`/`partial`：

- **Linux**：`bwrap`（只读 host root + 私有 PID ns + 新 `/dev`/`/proc`；`workspace-write` 另加临时
  `/tmp` 与可写 workspace bind）或 `node-addon-system/landlock-run`（npm 分发的 landlock launcher）。
  bwrap 能把 host root 挂只读并**不 bind `~/.rulith`**，从而读也进不去 → 可 `full`。
- **macOS**：Seatbelt（`sandbox-exec`，allow-default + `(deny file-write*)` + 写白名单）。可加
  `(deny file-read*)` 白名单实现读遮蔽；但 `sandbox-exec` 已弃用（Apple 可能移除）。
- **Windows**：`dsh-sandbox-windows-acl`（koffi FFI，受限 token WRITE_RESTRICTED + Low 完整性 +
  能力 SID 写 ACE）。**只限制写与删，读/网络/进程可见性不受限**（README 明言"reads stay
  unconfined"）。即它**堵不住凭据读取**，这是本批在 Windows 上的核心难点。

  **本批在这台 Windows 机器上实测确认（ACC-ISO-04，吞吐自 AclSandbox）：**
  - 受限 token 的子进程**能写入自己的工作区**（`WRITEWS=W`），**不能写工作区外**（`WRITEOUT_EPERM`）——写约束成立。
  - 受限 token 的子进程**仍能读到**工作区外的机密文件（`READ=SECRET`）——读不受限，与该包自述一致。
  - `icacls /deny *S-1-16-4096:(R)` 并不生成 DACL 读拒绝，而被当成把对象的完整性**标签**设为 Low（反而更可读）；
    `icacls /setintegritylevel (NR)…` 直接报"参数错误"——**icacls 无法表达 NoReadUp**。
  - 结论：在 Windows 上堵住"读"必须用原生 Win32（koffi）：AppContainer（子进程以包 SID 运行，主人目录不授包 SID 即读不到），
    或给主人目录设带 `NO_READ_UP` 的 Medium 完整性标签（`SetNamedSecurityInfo` 写 SACL label ACE）。两者都需原生调用。
  - 而 adapter 进程由实现边界（`worker/implementation-boundary.mjs`）禁用 CommonJS、原生插件（`process.dlopen`）与编译缓存，
    所以 koffi **不能在适配器进程内加载**；读隔离的 Win32 必须在适配器外的独立 runner 进程里做，且 koffi 要成为已发布
    `rulith` 包的运行时依赖并纳入实现 pin（现为 devDependency）。这是一块需负责人确认的较大原生工作，见 §9。

关键取舍：本批的威胁是**读**凭据，而 dsh 的 Windows 后端只管**写**。所以在 Windows 上照搬
`ctx.sandbox` 不解决问题；要遮蔽读，只有 (a) AppContainer（子进程以包 SID 运行，凭据文件只授
用户 SID → 包 SID 读不到；但工具链也读不到，需给 project+toolchain 目录补包 SID 读 ACE——重，
且 dsh 未实现）或 (b) 给 `~/.rulith` 目录加一条针对子进程能力 SID 的 deny-read ACE（对真实目录做
标准 ACL 变更）。

另一现实约束：kit 适配器是 **Worker 用 `execFile` 另起的独立进程树**（经
`implementation-boundary.mjs` 的 pin 载入固定字节），它只 import node 内置 + 自身文件，**不**
import `@deepseek-ai/*`。要让 kit 命令进沙箱，要么把 runner 的 argv 前缀逻辑并进 kit（`execute()`
启动时加前缀），要么让 kit 调用平台 runner 可执行文件；两种都要把所选 runner 纳入实现 pin。

## 5. Phase 2 — 本批实际落地与验证（重定向后）

关键决定（负责人 2026-10-25）：**不改 kit 的任何字节**（否则官方能力的 Release 摘要变、已安装 Agent 会
worker_tools_mismatch），把隔离放在 **Worker 启动适配器的那一刻**——适配器整个进程树（含模型写下的每条命令、后台 job）
都是它的后代，继承隔离。kit（`kits/`、pack、recipe、manifest 的 kit 摘要）与 main（e6b7830）逐字节一致（测试已断言）。

1. **本机 loopback 凭据路径（App 宿主）——已修复并测试（ACC-ISO-01）。** 见 Phase 2：`/rulith/api/*` 要求 dsh 浏览器
   会话凭据（`ctx.connection.admit`），无会话 401/403，取不到会话认证 503 fail-closed。
2. **命令环境不带机密——由 Worker 的 `adapterEnv` 落实（ACC-ISO-07 端到端断言）。** 适配器环境已剥 `RULITH_` 命名空间与
   凭据族（API key、token、口令、DSN、数据库 URL、各云厂商族）；命令作为适配器子进程继承这份已洗净的环境。kit 不再自行洗。
3. **工具 SSRF（loopback/私网）——回归已钉（ACC-ISO-03）。**
4. **适配器进程树隔离——已落地（`worker/adapter-confinement.mjs`，在 handRun 启动点）。结构（2026-10-25 复审后的重做）：**
   - **凭据根与工作根分开。** 凭据根是目录（个别是单个文件）：管理器 home（不论谁启动管理器）、各实例目录、App home 与
     dsh home、settings 文件点名的 modelHome 与管理器密钥文件（可以在任意位置，如 `workbench-key.txt`），以及兜底的
     `~/.rulith`。受限进程要用的东西——Worker 根（适配器实现）、
     kit home、临时与包缓存、作业状态——一律放在凭据根之外的**工作根**：Windows `%LOCALAPPDATA%\Rulith\work\<实例 id>`，
     Linux `$XDG_DATA_HOME/rulith-work/<实例 id>`。新实例直接按此布局创建；旧布局由管理器启动时迁出（复制、改 local.json、
     旧副本保留并记下；下一次启动见新布局在用即确认并删除旧副本；被多个实例共用的旧目录在无人使用前不删）。
   - **Windows：** 每个凭据根目录整体打上可继承的不可读上行标签 `S:(ML;OICI;NRNW;;;ME)`（`SetNamedSecurityInfo`，传播到
     既有子项；之后新写的文件、原子改写后的 local.json、`*.tmp`、备份都继承——ACC-ISO-08 实测）。由各自的主人在启动时打：
     App 打 App home；管理器（`createInstanceManager`，不论由 App、`rulith start` 还是单独 Runtime 启动）打自己的 home、
     `~/.rulith` 兜底、home 外的实例目录与 App 交来的根（含单个密钥文件，按文件打标签）；实例宿主每次启动 Worker 前再补一次。
     **非系统盘（如 D:\）：** 打完整性标签需要 WRITE_OWNER；D:\ 根默认的访问列表只给 Authenticated Users「修改」，没有
     CREATOR OWNER 项，所以用户自己新建的目录也拿不到 WRITE_OWNER，直接打标签会被拒（access denied）。此时只在**对象归当前
     用户所有**时，借所有者隐含的 WRITE_DAC 给自己加一条允许项（TakeOwnership，可继承到里面），再打标签并传播；不归当前用户
     所有的对象一概不动，仍失败就拒绝（英文说明原因）。凭据根上的这一条保留（凭据根长期存在）；项目目录把“加过这一条”记在
     project-labels 记录里，最后一个释放时先还原标签、再精确删去这一条（实测：还原后目录与其中文件的访问项与原来一致，只多了
     表示已按继承计算的 AI 标志）。项目目录在向 Gateway 打开之前就打标签，打不上即拒绝打开（`project_folder_unprotectable`，
     英文原因，什么都不发出）；Gateway 拒绝打开时撤回刚打的标签；看到项目已是 ready 时补回标签。哪些根或项目没能保护、为什么，
     记在管理器 home 的 `isolation-status.json`，设置页「高级 → 诊断」逐条显示。
     **打标签时核验一次内部：** 给一个目录打上标签后遍历其中已有的一切（不跟随重解析点）；若有子项保留了别的标签（传播不会
     替换显式标签，例如提权运行留下的文件），就把这个根刚打的标签撤掉，让启动器像对待未加标签的根一样拒绝，并用英文拒绝
     说明点名那个子项（宿主把它交给 Worker，命令拒绝时原样给出）。适配器以**低完整性**运行
     （C# 小启动器逐字随 Runtime 发布，用本机 .NET Framework 的 `csc.exe` 编进管理器 home 的 `bin`，按摘要自检）；启动器在
     **每次**启动命令前用 `--require-nr` 逐个校验凭据根（目录或文件）的有效标签（第一条作用于对象本身的标签项）确为中及以上
     且不可读上行，缺一即退出 126 拒绝运行（fail-closed），Worker 把它转成英文拒绝说明。要校验的根：管理器在启动每个 Worker
     时点名的管理器 home 与实例 id（实例目录在管理器 home 之外也覆盖；没有时从实例目录往上找 registry.json），加实例目录、
     兜底与列出的根。kit home 打 Low；打开的项目打 Low（见下）。可写的 kit home 若伸进任一凭据根，也在启动前拒绝。
   - **项目目录标签：** 只在 Gateway 确认打开后打；打开前先把目录原有标签记到管理器 home 的 `project-labels`（凭据根内，
     受限命令读写不到），按实例 id 计数（打开时与 Worker 释放时用的是同一个 id）。实例被移除、本机登出或忘记这台设备、或 Worker 发现这个 file Source 不再授予（解锁、删除、设备停用；包括在
     Worker 不在时被收回，下次启动的首个 Source 刷新即处理）时释放；最后一个释放时按原样还原并传播到子项。打开时拒绝
     包含或位于任一凭据根或工作根内的目录（`project_folder_protected`，确认前、什么都不发出）；Worker 侧也再拒一次。
   - **Linux（代码落地，WSL 实测 fail-closed）：** 同一结构：工作根可写；凭据根（同一套推导）以 tmpfs 遮盖（只遮最外层）；
     整根只读、项目与 kit home 可写；**不断网**（kit 的 web 工具要联网），本机端口靠机密防护（①）。保留 `--unshare-pid`
     以免命令读到 Worker／Agent 的 `/proc/<pid>/environ`。bwrap 不在即拒。WSL Ubuntu-24.04 无 bwrap（按决定不安装）。
   - **macOS：** 本批不隔离，命令照常运行（确认框与 PSC 如实写明）。
   - 默认在 Windows 与 Linux 要求隔离、壳不可用即拒；`RULITH_ADAPTER_SANDBOX=off` 是 "Run without isolation (not recommended)"（不隔离运行，不推荐）开关，只认
     实例 local.json 的 worker.env 或测试引导里显式写的 off，缺省即要求。App／管理器／Worker 自身都在中完整性运行。

## 6. 对正常项目工作的影响

- 工具链在家目录（Python、cargo、npm）为中完整性、无不可读上行标签，低完整性命令照常读取运行；写只限 Low 标签的项目与
  工作根里的 kit home（TEMP 与 npm/pip 缓存已改到这里）。
- 不能把家目录本身、`~/.rulith`、`%LOCALAPPDATA%` 这类包含 Rulith 数据的目录作为项目打开（会被 `project_folder_protected`
  拒绝，中文说明请另选文件夹）。
- Linux 不断网；但后台作业（`eng.job_*`）随发起它的那次工具调用结束（`--unshare-pid` 下命名空间随适配器退出），见 §8。
- 只给凭据根（不可读上行）、kit home 与打开的项目（Low）改标签，项目在释放时还原；不动任何其他真实目录。

## 7. 提交给 PSC 0.2.29 的拟定文字（Chinese）

承接 0.2.28 ① 末句“把模型的命令与本机凭据隔开另列一批（模型命令隔离），届时这几处一起堵上”。

> **0.2.29（模型命令隔离，D-1024a）：** ① 本机客户端在 dsh 服务端同源暴露的私有控制路由一律要求该浏览器会话的签名凭据，
> 不再只认常量请求头与 loopback 主机名；无会话被拒，取不到会话认证时拒绝而非退回旧门。② 经编程能力运行的命令环境已剥去
> 本机命名空间变量与凭据形变量，只余工具链所需的通用变量。③ 只读 `web_fetch`/`web_search` 对 loopback、私有与链路本地地址
> 一律拒绝、钉住已解析地址、只跟随同源重定向。
> **命令隔离（不改能力的实现字节，隔离加在宿主启动适配器处；模型写下的每条命令与后台作业都继承）：**
> - **凭据根与工作根：** 本机 Rulith 存放凭据的目录（管理器目录、各实例目录、应用目录、dsh 目录与 `~/.rulith`）是凭据根；
>   命令要用的东西（适配器实现、工具包目录、临时与缓存）放在凭据根之外的工作根。旧布局在升级后的首次启动迁出。
> - **Windows：** 每个凭据根目录整体设为低完整性进程不可读（可继承，之后新写或改写的文件同样不可读）；适配器及其整个进程树
>   以低完整性运行；每次运行命令前逐个核验凭据根已受保护，未受保护即拒绝运行（fail-closed）。工具包目录与打开的项目目录
>   设为命令可读写；项目目录原有的设置在打开前记录，实例移除或 Source 收回（含设备停用）时还原。
> - **Linux：** 适配器在命名空间壳内运行——项目与工具包目录可写，系统与工具链只读，凭据根被遮盖；网络保留，本机端口靠
>   必须出示、而命令读不到的机密来挡；后台作业随发起它的工具调用结束。壳不可用即拒。
> - **macOS：** 本批不提供命令隔离；命令按既有方式运行。
> - 包含或位于凭据根、工作根内的文件夹不能作为项目打开。
> 默认在 Windows 与 Linux 要求隔离并 fail-closed；有一个负责人专属、缺省关闭、需显式确认的 "Run without isolation (not recommended)" 开关。
>
> **UI texts (English is normative; a Chinese rendering follows each, per the owner's 2026-10-25 English-first direction).**
>
> *Open-project confirmation* (replaces the 0.2.24 sentence that the folder is not OS-level isolated; one paragraph, by
> platform):
>
> > On this computer, reading, writing and running commands in this project folder are carried out by the Agent's
> > engineering capability. Commands run without this computer's keys or tokens in their environment, and tool access to
> > loopback and private network addresses (including this computer's manager and app ports) is refused. **By system:** on
> > Windows, commands run at low integrity and cannot read the folders where Rulith keeps its credentials; this folder is
> > writable for commands while it is open, and its previous setting is restored when it is revoked or this computer is
> > deactivated. On Linux, commands can write only this project folder and their tool folder, the system is read-only,
> > Rulith's credential folders are hidden, the network stays available, and background jobs end with the tool call that
> > started them. On macOS, commands are not yet isolated on this computer. If isolation cannot be set up, commands do not
> > run (unless you chose "Run without isolation (not recommended)" in Settings). The non-strict tier means the commands
> > and arguments the model gives no longer need grounds on the Board; whether the work is done is still certified only by
> > the acceptance contract you sign. To revoke: unlock this project in Console, or deactivate this computer.
>
> > 中文对照：在这台电脑上，这个项目目录里的读、写和运行命令由智能体的编程能力执行。命令的环境里不带本机的密钥或令牌，
> > 通过工具访问本机与私有网络地址（含本机的管理器与应用端口）会被拒绝。**按系统不同：** 在 Windows 上，命令以低完整性
> > 运行，读不到 Rulith 存放凭据的目录；这个目录在打开期间命令可读写，收回或停用这台电脑时还原原有设置。在 Linux 上，命令
> > 只能写这个项目目录与它的工具目录，系统只读，看不到 Rulith 存放凭据的目录，网络保留，后台任务随发起它的那次工具调用
> > 结束。在 macOS 上，命令目前不受本机隔离限制。隔离无法启用时命令不会运行（除非你在设置里选了“不隔离运行（不推荐）”）。
> > 宽松档意味着模型给出的命令与参数不再需要板上依据，是否完成仍只由你签字的验收合同认证。撤销：在 Console 解除这个项目的
> > 锁定，或停用这台电脑。
>
> *Refusal when a folder overlaps Rulith's data* (`project_folder_protected`): "This folder contains, or is inside, a folder
> where Rulith keeps its own data (credentials or work files), so it cannot be opened as a project. Choose a folder that
> holds no Rulith data." — 中文对照：“这个文件夹包含或位于 Rulith 存放自己数据（凭据或工作文件）的目录里，不能作为项目打开。
> 请选一个不含 Rulith 数据的文件夹。”
>
> *Owner setting* "Run without isolation (not recommended)" (off by default; 中文对照“不隔离运行（不推荐）”). Its
> confirmation: title "Run model commands without isolation?"; body "Commands the model runs through the engineering
> capability will be able to read everything your account can read on this computer, including Rulith's own credentials.
> Turn this on only if isolation cannot work here and you accept that risk."; buttons "Run without isolation" / "Keep
> isolation". 中文对照：标题“不隔离运行模型命令？”；正文“模型经编程能力运行的命令将能读取你的账户在这台电脑上能读的一切，
> 包括 Rulith 自己的凭据。只有在这里无法隔离、且你接受这个风险时才打开。”；按钮“不隔离运行”／“保持隔离”。
>
> **验收项：**
> - `ACC-ISO-01` App 宿主私有控制路由无会话时拒（401/403），取不到会话认证时拒（503），不触及后端路由。
> - `ACC-ISO-02` 命令环境不含 `ENG_KIT_HOME` 与凭据形变量（由 `adapterEnv` 落实；ACC-ISO-07 端到端断言无 `OPENAI_API_KEY`）。
> - `ACC-ISO-03` `web_fetch` 拒绝管理器、应用宿主、模型引擎等 loopback／私网端点。
> - `ACC-ISO-04`（Windows）参考事实：dsh 受限 token 后端只约束写、不约束读（本批不靠它做读隔离）。
> - `ACC-ISO-05` Linux：`bwrapAdapterArgv` 的隔离 argv（项目／kit home 可写、凭据根遮盖、保留网络）；bwrap 不在时 fail-closed。
> - `ACC-ISO-06`（Windows）打标签后低完整性进程读标签目录下文件（含打标签后新建者）被拒，正常进程照常读。
> - `ACC-ISO-07`（Windows）经启动器以低完整性运行的命令树：写得了项目、读不到经 `--require-nr` 核验的标签目录、环境无机密、
>   派生的 job 同样被隔离；启动器每条命令开销有界。
> - `ACC-ISO-08`（Windows，产品路径端到端）一次性账户目录里：App 设置、真实管理器（登录并配对）、实例宿主启动 Worker、
>   项目打开标签——标签全部由产品代码打上；Worker 领取真实 `eng.run`，命令读 manager.key、刚原子改写的 local.json、
>   model-defaults.json、`*.tmp` 与备份全部被拒，写项目与工作根里的 kit home 成功；Worker 不在时收回 Source，下次启动还原
>   项目原标签；旧布局被下一次管理器启动迁出、再下一次确认并删除旧副本。
> - `ACC-ISO-09` 包含或位于凭据根／工作根的文件夹在确认前被拒（`project_folder_protected`），不发出任何请求、不打标签；
>   Worker 启动命令时再拒一次；伸进凭据根的 kit home 同样被拒。
> - `ACC-ISO-10` 实例目录在管理器 home 之外时，Worker 仍按管理器点名的 home 校验，并以打开时的实例 id 释放项目标签。
> - `ACC-ISO-11`（Windows）单个密钥文件作为凭据根：未加标签时启动器拒绝（退出 126，英文说明点名该文件），加标签后命令运行
>   且读不到它。
> - `ACC-ISO-12`（Windows）根内有子项保留了别的标签时，该根视为未受保护：标签撤回、启动器拒绝、英文拒绝说明点名该子项。
> - `ACC-ISO-13`（Windows，仅当本仓库在非系统 NTFS 盘上）该盘上的新目录与含文件的目录经所有者授权后成为凭据根（低完整性读被拒）；
>   项目目录打 Low 后受限命令可写（含已有文件），释放后标签与访问列表与原来一致；打不上标签的项目在向 Gateway 发出前即被拒。

## 8. 残留缺口（如实）

- **Linux 后台作业随调用结束**：为挡住命令读 Worker／Agent 的 `/proc/<pid>/environ`，bwrap 用 `--unshare-pid`；命名空间随
  适配器退出，`eng.job_start` 起的后台作业也随之结束（Windows 不受影响）。kit 字节不改，故不在本批解决。
- **用户配置里别处的他人机密**：只保护 Rulith 的凭据根。低完整性命令仍能读同一用户配置下别的程序的中完整性文件（例如浏览器
  cookie 库里可能有 Console 会话）。要防护需更强的逐目录读白名单（AppContainer），不在本批。
- **硬链接别名**：若有人在凭据根之外为凭据文件建硬链接，那个别名带的是文件本身的标签（继承来的标签随文件），一般仍不可读；
  但从外部复制出的副本不受保护。Rulith 自己不建这类副本。
- **凭据根上留下的 WRITE_OWNER 项**：为在非系统盘上打标签而给所有者加的那一条允许项留在凭据根上（所有者本来就能取得所有权，
  不扩大谁能做什么）；项目目录上的会在释放时删去。
- **迁移带入的旧作业日志**：旧布局迁出时整份复制 Worker 根与 kit home，其中可能有旧的作业日志与输出；它们因此落在工作根
  （受限命令可读写）。这些内容本来就由受限命令产生，不含 Rulith 的凭据；旧副本在确认后删除。
- **启动器会话令牌打印到 stdout**：`dsh web` 把带 `?token=` 的本页会话地址打印到启动器的标准输出。若所有者把它重定向到
  命令可读的位置（如项目目录里的日志），命令就能拿到会话。请勿如此重定向。
- **卸载后遗留**：卸载应用不会自动还原仍在打开中的项目目录标签（记录在管理器 home 的 `project-labels`，删掉管理器 home 即
  丢失记录），也不删工作根（`%LOCALAPPDATA%\Rulith\work`）。Low 标签只放宽低完整性进程对该项目目录的写，不影响正常程序；
  卸载前先移除实例即自动还原。
- **低完整性的常见副作用**：个别需要更高完整性的操作（写系统位置、某些 COM／WMI、`CREATE_NEW_CONSOLE`）会失败；正常构建、
  测试、安装不受影响。
- **csc 不可用**：无 .NET Framework csc 的精简 Windows 上 fail-closed 拒绝并提示；PowerShell `Add-Type` 后备编译未实现。
- **Linux bwrap 未在本机实跑**：argv 与 fail-closed 已测，bwrap 在场的实跑按原因跳过。
- **"Run without isolation (not recommended)" 的 App 设置界面**：引擎侧已实现并测试，App 设置里的确认框（文字见 §7）是界面小项。
- **HTTP 代理解析**：工具经代理时主机名由代理解析，重绑定／fake-ip 时本机防线看不到代理连向的地址。
- **实验限制**：所有本机实验只用一次性临时目录与一次性账户目录（USERPROFILE／LOCALAPPDATA 指向临时目录），且已清理。

## 9. 可行性与规模（更新）

- 已交付并验证：App 宿主会话门、工具 loopback 回归、凭据根目录级不可读上行标签（主人启动时打、实例宿主补、启动器每次核验）、
  工作根布局与迁移、项目标签记录与还原、项目目录重叠拒绝、Windows 低完整性启动器与产品路径端到端（ACC-ISO-08）、Linux 同一
  结构的 bwrap 代码与 fail-closed、`adapterEnv` 命令环境洗净。kit 字节与 main 一致（已断言）。
- 紧随小项：① PowerShell `Add-Type` 后备编译；② Linux 装了 bwrap 的机器上实跑；③ "Run without isolation (not recommended)" 的设置确认框；
  ④ macOS Seatbelt（需在 macOS 上验证后再发）。
