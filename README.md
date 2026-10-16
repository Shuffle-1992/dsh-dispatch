# DSH 派发台（dispatch）

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
> 把任务派发给本机 **ZCode** CLI 的无头进程，并在 DSH 页面右下角的悬浮面板里监视它们。

DSH 自带的 `subagent` 跑的是 DSH 自己的 agent；**本插件跑的是 ZCode**——独立进程、独立额度、
独立会话，任务行出现在「DSH 派发台」面板里，可查输出、可终止、可续跑、可换通道重跑。

---

## 安装

> **本项目不发布 npm**（不提供裸包名安装）。唯一安装路径 = **从 GitHub 仓库安装**；
> 改代码的场景用本地绝对路径挂载。

**从 GitHub 仓库安装（推荐）**——git 规格 + `#path:` 子目录定位：

```bash
dsh plugin --profile web add "github:Shuffle-1992/dsh-dispatch#path:dispatch"
```

> 把 `web` 换成你的 profile 名（`dsh plugin list` 可查）。装完**重启 DSH** 生效。
> **`#path:dispatch` 不能省**：本仓库是 monorepo，插件本体在 `dispatch/` 子目录；
> DSH 实际执行 `pnpm add <spec>`，而 pnpm 对 git 仓库默认取**仓库根** —— 根目录没有插件
> `package.json`，装出来只会得到占位包（实测 `{"_pnpmPlaceholder":"...did not contain a package.json."}`）。

**本地开发挂载**（源码就在本机时）：profile 的 `dependencies` 加
`"dsh-dispatch": "link:<仓库>/dispatch"`、`bundles` 加 `"dsh-dispatch"`，
并在 profile 的 `node_modules/dsh-dispatch` 建 junction 指向该目录。

> 包名 = `dsh-dispatch`；bundle 资格由**仓库根** `package.json` 的 `dsh.bundle.patch`
> （→ `dispatch/cordis.patch.yml`）声明；插件本体清单在 `dispatch/package.json`。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **派发** | 把 `prompt` / 任务文件 / 目标描述交给 ZCode 跑，支持 `build / edit / plan / yolo` 四种模式 |
| **单写者互斥** | `repo` / `memory` 文件锁 + 进程内 FIFO 队列：同锁任务串行，冲突只排队不报错（多会话并发也不会互相踩） |
| **实时监视** | 每个 job 的状态、耗时、上下文占用、退出码、锁持有者；可拉最近输出（tail） |
| **续跑 / 重跑** | 同会话 `--resume` 重发原提示词，或在同一会话里发一条新指令 |
| **通道与降级链** | 切换套餐通道 / 模型；额度耗尽或未开通时按降级链自动交接重跑到下一个可用通道 |
| **免费额度通道** | 支持 ZCode **Start Plan（活动赠送额度）**：托管官方 agent 走 app-server（端点要求逐请求官方签名），通道 `account:<family>-start-plan`；与付费套餐复用同一条面板 / 台账 / 暂停 / 降级流水线 |
| **用量聚合** | 本地台账 5 小时滚动 / 本周 / 今日，外加套餐剩余额度（数据源不可用时如实标注 `available:false`，不猜） |
| **派发总开关** | 一个跨会话真值文件：`false` = 任何会话都不得派发（runner / 插件 / 桥接三处强制生效） |
| **agent 工具** | 注册 `dispatch`，与面板同一套动作实现（一操作两调用方） |

---

## 目录结构

```
dispatch/
├─ dispatch/          ★ 插件本体（cordis bundle：Host 半边 + Client 半边）
│  ├─ index.js              Host 入口：apply(ctx, config)、dispatcher 单例、注册 agent 工具、激活信标
│  ├─ wire.host.mjs         Host 接线 + 动作唯一实现 createActionHandler + 派发总开关读写
│  ├─ wire.client.mjs       Client 接线 + 轮询 / demo 降级
│  ├─ client.js             UI 半边：悬浮面板（React.createElement，无构建步骤）
│  ├─ core/                 派发核心（零 npm 依赖）：dispatch-core / quota / appserver-rpc
│  ├─ bin/dispatch.mjs           独立 CLI（与插件同 core，用来对照排查）
│  ├─ locale/{zh,en}.json   中英文案
│  ├─ test/                 可复跑自测与验收脚本
│  └─ cordis.patch.yml      bundle 层 patch（**只放 demo/maxConcurrent**，机器路径见「配置」）
├─ tools/                   常驻证据脚本（见「复跑证据」）
├─ bridge/                  客户端自动化桥（inbox/outbox 收发任务文件）
├─ tasks/                   开发留档：每轮任务书与交付记录（含原始输出与未决项）
├─ refs/                    参考资料（**含第三方材料，见文末声明**）
└─ profile-backup/          DSH profile 配置的三态留档与恢复说明
```

---

## 安装

要求：DSH 桌面版（在 `0.2.0-rc.2` 上开发验证）+ 可选的本机 ZCode CLI。

1. 让插件目录能被 profile 解析（开发期常用 junction / `link:`）：

   ```powershell
   # 例：把本包挂进 profile 的 node_modules
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dispatch" `
     -Target "<本仓库>\dispatch"
   ```

2. 在 **创造模式会话**里用 `plugin_manager` 的 `install_bundle` 安装（`target` = 插件绝对路径），
   并**读返回的 `application` 与 `warnings`**（`applied` 才算生效）。

3. 在 profile patch 里补上机器专有路径（见下一节），然后**完全退出 DSH 再启动**。

> 本包**无构建步骤、无 npm 依赖**；Host 半边（`index.js` / `wire.host.mjs` / `core/*`）改动
> 需要重启 DSH 才生效，Client 半边（`client.js`）改动刷新页面即可。

---

## 配置

### 插件字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `demo` | `false` | UI 演示模式：用内置假数据渲染面板，不触达 dispatcher |
| `maxConcurrent` | `3` | 同时运行的 run 上限 |
| `runnerPath` | `''` | runner 脚本绝对路径（通用工具仓库 `<本仓库>/collab-kit/zcode-run.mjs`，只读使用） |
| `ledgerPath` | `''` | 台账 `dispatch-runs.jsonl` 绝对路径；留空则跳过用量聚合 |
| `workRoot` | `''` | 派发器工作根目录（`locks/`、`state/jobs.json`、`logs/`）；留空落到插件目录 `.data/` |
| `switchPath` | `''` | 派发总开关真值文件；留空则开关不可写 |

`runnerPath` 与 `workRoot` **任一为空则不创建 dispatcher**：面板走 demo 降级，agent 工具返回可读错误。
这是**刻意设计**——不猜一个位置静默跑错。

### 机器专有路径放 profile patch（不进本仓库）

上面的路径都指向**某个具体宿主项目**，属部署配置。请在
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dispatch
  name: "dsh-dispatch"
  config:
    demo: false
    maxConcurrent: 3
    runnerPath: '<宿主项目>\scripts\collab\zcode-run.mjs'
    ledgerPath: '<宿主项目>\collab\logs\dispatch-runs.jsonl'
    workRoot:   '<本插件目录>\.data'
    switchPath: '<宿主项目>\collab\dispatch.switch.json'
```

（`cordis.patch.yml` 的 patch 层按 id 覆盖是 DSH 的标准机制——同文件里 `ui-theme` / `ui-chat`
等条目就是这么覆盖 bundle 内置条目的。）

### ⚠️ 报「身份验证失败 / 401」：多半是 ZCode 凭据失配

本插件**不自己存凭据**，而是读 ZCode 自己的 `~/.zcode/v2/config.json`
（`provider["builtin:bigmodel-coding-plan"].options.apiKey`）—— 与 ZCode CLI 同源。

> **已知上游缺陷**：ZCode 在 **OAuth 重新登录**后，把新 Key **只写进加密凭据库
> `credentials.json`**、**不回写 `config.json`**，导致 `config.json` 里留着**失效的旧 Key**
> ⇒ 一切读它的程序集体 **401**（**连 `zcode.cjs -p …` 也一样**）。

**💡 处理办法：把有效 Key 保存（写回）到 `config.json`** —— 一次修好所有工具：

1. 从 `credentials.json` 解出有效 Key（`enc:v1` = AES-256-GCM，密钥 `sha256(secret)`）；
2. **先验活**（⚠️ 网关对**失效 Key 也返回 HTTP 200**，body 却是
   `{"code":1000,"msg":"身份验证失败。","success":false}` —— **不能只看状态码**）；
3. **备份** `config.json`，把有效 Key 填回 `options.apiKey`；回读校验。

> 详细步骤、解密参考实现、验活判定代码与完整踩坑记录见
> **[`dispatch/README.md` 的「凭据从哪来 + 报 401 怎么办」一节](dispatch/README.md#️-凭据从哪来--报身份验证失败--401-怎么办)**。
> 现成恢复工具见姊妹项目 [`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode)
> 的 `scripts/sync-key-to-config.mjs`（自动备份 + 验活 + 原子替换 + 回读校验）。

---

## 免费额度（Start Plan）通道

派发台支持 **ZCode Start Plan（活动赠送额度）**：通道 id `account:<family>-start-plan`
（本机实测 `account:bigmodel-start-plan`），面板下拉里显示为「**免费额度（Start Plan）**」，
也可直接当 `--provider` 用：

```bash
zcd dispatch --kind prompt --prompt "只回复 OK" --provider start-plan
zcd dispatch --kind task   --task <任务包> --provider account:bigmodel-start-plan --mode yolo
```

原理：该端点要求**逐请求的官方客户端证明**（直连 HTTP 会被 `405 / code 3012` 拦），
所以由 runner 托管 `zcode.cjs app-server`、自己注入套餐账户并把 token 递给它签名。
实现在 `collab-kit/appserver-gift.mjs`（回合驱动）+ `collab-kit/appserver-gift-job.mjs`
（产物 / 输出行 / 台账，与既有 print 模式同形）—— 因此**面板、暂停分类、重试/交接、降级链、
台账聚合全部复用**，台账按 `billing=zcode-plan-gift` 与付费套餐分账。

> **和姊妹项目 [`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode) 的 provider 通道怎么选？**
> 派发台的语义是「**独立 ZCode 进程 + 它自己的工具 + 独立会话/额度**」—— 所以在这里
> 「工具由 ZCode 自己执行」是**设计，不是缺陷**；而那边把同一个免费额度接成 **DSH 的模型对话通道**，
> 代价是 **DSH 工具层不参与**（`browser_*` / Agent Teams / `ask_user_question` / `present` / TODO 等都没有，
> 见其 README 的「免费额度通道目前缺失的功能速查」）。
> ⇒ **要让 agent 用工具自主干活，就用派发台；要在 DSH 里做交互式对话并复用 DSH 工具链，就用 provider 通道。**

限制与验收记录见 [`dispatch/README.md` 的「免费额度（Start Plan）通道」一节](dispatch/README.md#免费额度start-plan通道zb-33)
与 [`tasks/ZB-33-gift-channel-exploration.md`](tasks/ZB-33-gift-channel-exploration.md)。
**额度可见性（ZB-33）**：选中该通道时面板显示**额度条**（剩余 / 百分比 / 窗口 / 剩余时长）；
同一份数据也通过 `action=channels`（`channels[].quota`/`quotaText`）与 `action=quota`（`giftQuota`）
暴露给 agent —— **派发前就能知道还剩多少额度、窗口还剩多久**，工具描述里还写了据此拆任务/换通道的
决策指引。数据只读 ZCode 客户端日志（零网络请求、零额度消耗），新鲜度以 `observedAt` 如实标注。
要点：不支持 `--resume`/`--target`/`--memory-bench`；官方 MCP 在托管进程里不可用；
免费额度是**时间窗口**型（窗口外以 `paused/quota-exhausted` 停下）；`--cwd` 需落在宿主项目内
（与 `ledgerPath` 同项目，否则用量聚合看不到该单）。

---

## agent 工具 `dispatch`

一个工具 + `action` 参数，与面板上的操作一一对应：

```
dispatch | list | kill | dismiss | tail | quota | status | switch | channels | channel | retry | fallback
```

- `dispatch`：`kind=prompt|task|target` + 对应内容字段；可选 `model` / `provider` / `mode` /
  `timeoutMin` / `memoryBench` / `tag` / `lock` / `cwd` / `resume`
- `list` / `tail(id,n)` / `quota`：监视与用量
- `kill(id)` / `dismiss(id)`：终止；把 paused/终态 job 从列表移除
- `status` / `switch(enabled)`：读 / 切换派发总开关
- `channels` / `channel` / `retry` / `fallback`：通道、续跑、降级链

> **派发优先级（写进了工具描述，模型选工具就看这段）**：
> 凡是「把任务交给一个 agent 去做」的诉求，**能用派发台就优先用派发台**——
> 用 `action=dispatch`，任务才会出现在面板里、才受派发总开关约束。
> **仅当派发台不可用**（开关已关闭、`dispatch` 返回 `ok:false`：未配置 runner/workRoot、锁冲突等，
> 或用户明确要求「你自己去做」）才退回 DSH 自带的 `subagent` / 后台 jobs，
> 且**要说明为什么没用派发台**，不静默切换。
>
> **三条硬规则（ZB-37，2026-10-11 真机事故逼出来的）**：
> ① **不要用 `pwsh`/`Bash` 直接跑 `collab-kit/zcode-run.mjs`**（含 `run_in_background`）—— 那会绕过
> 文件锁、台账/额度分账、面板可见性、暂停分类与降级链；派发台 job **落地时本来就会自动唤醒**发起会话。
> ② **通道撞 429/额度耗尽**（job 变 `paused / quota-exhausted`）时：先 `action=channels` 看
> `recentQuotaExhausted` 与 `quotaText` → **直接 `dispatch {provider:"<通道 id>"}` 换通道**（免费额度
> 通道 `account:<family>-start-plan` 常常仍可用），或 `action=fallback {chain:[…]}` + `action=retry` 交接。
> ③ **派发前先看额度**：`channels[].quotaText` / `giftQuotaText`（剩余与窗口剩余时间），剩余少或窗口
> 将尽就拆小任务。
> ④ **派发到"已撞顶"通道时立刻给提示**（ZB-38）：`action=dispatch` 的返回里带 `warning` +
> `suggestedProvider`（优先建议可用的免费额度通道）—— 不必等它 429 暂停再靠猜。
> ⑤ **显式指定"已撞顶"通道 ⇒ 自动改派**（ZB-39，用户报告「面板选的是免费额度，派发却先走付费 5h 窗口」）：
> 候选顺序 = **你在面板 / `action=channel` 选定的默认通道** → 降级链首个可用目标 → 可用的免费额度通道；
> 返回里带 `redirectedFrom` + `warning` 说明改派事实。**绝不硬闯注定 429 的通道**，也不静默乱派
> （候选全不可用 ⇒ 仅提示）。**因此调用方通常根本不需要传 `provider`**：不传就是用你选的通道。
> （事故复盘见 [`tasks/ZB-37-dispatch-path-incident.md`](tasks/ZB-37-dispatch-path-incident.md)：
> 真因是工具 schema 的 `provider` enum 只有 `["plan","personal"]`，与"接受清单任意 id"的说明矛盾，
> 把免费额度通道挡在门外 ⇒ agent 只能派到付费通道 ⇒ 撞限额后绕开派发台。）

---

## 悬浮弹窗

**会话标题行的「DSH 派发台」入口**（与「智能体团队」「创造模式」同排）+ 点击弹出的悬浮弹窗
（ZB-27：复用系统菜单样式与令牌；点外部 / Esc 关闭；**入口本身不建 wire**，展开才连）。
弹窗高度上限 **960px**（ZB-36：按用户要求「增加 100%」由 480px 翻倍；短屏按 `calc(100vh - 140px)`
自然收敛，不会顶出屏幕；该上限**只挂在面板这一层**，`.dsp-menu` 类仍是 DSH 官方菜单的 480px）。

- **通道**：通道 + 模型两个下拉（固定两行版式），自动降级链；**不可用通道不再列出**
  （主通道与降级目标同一过滤；当前选中值若已掉线仍单独显示并标注「不可用：原因」以便切走）
- **派发**：类型 / 模式 / 内容 / 超时 / `--memory-bench` / 派发按钮
- **进程**：按状态分 **Tab**（进行中 / 需处理 / 异常 / 已完成），每页只渲染最近 5 条 + 可展开；
  点击行头展开详情（派发要素、会话 id、最近输出），行动作（终止 / 重跑 / 续接 / 关闭）都在展开区里
- **用量**：5 小时窗口 / 本周 / 今日三张卡；**单写者**：锁持有者与队列长度
- 面板空白区不挡应用（`pointer-events` 精细控制）；主题令牌取自 DSH 主题，无字面色值

---

## 复跑证据

```bash
node tools/verify-plugin.mjs      # 插件形态与契约探针（20 项）
node tools/verify-switch.mjs      # 派发总开关独立复现（8 项，用临时目录密封）
cd dispatch
node test/core.test.mjs           # 派发核心自测（12 项）
node test/channel-retry.test.mjs  # 通道 / 续跑 / 降级链自测（9 项）
node test/quota-rpc.test.mjs      # 额度 RPC 自测（16 项）
node test/tail-scroll.test.mjs    # 输出框滚动决策（13 项：不闪烁 / 不弹回 / 底部跟随）
node test/pill.test.mjs           # 最小化胶囊（16 项：标题字样 / locale 对称）
node test/pill-position.test.mjs  # 胶囊定位与视口钳制（15 项：固定右下角 / 脏 pos 不出屏）
node --test test/file-lock.test.mjs    # 细粒度文件锁（9 项：write 声明 / 回退底线 / 归一化 / 防死锁）
node --test test/wait-action.test.mjs  # wait 动作（6 项：等终态 / paused 也返回 / 超时不谎报）
node test/section-order.test.mjs  # 分区顺序（9 项：单写者紧跟进程 / 用量置末）
node test/panel-reclamp.test.mjs  # 面板位置可见性（9 项）
node test/panel-anchor.test.mjs  # 面板锚定语义（22 项：缩窗不挤中间 / 放大回原位）
node test/elapsed-format.test.mjs  # 耗时展示格式（15 项：XX时XX分XX秒）
node test/ctx-format.test.mjs  # 上下文占用展示（23 项：180.9k / 200k）
node --test test/lock-model.test.mjs  # 锁模型（8 项：删 memory / 不同文件集可并发）
node test/lock-ui.test.mjs  # 派发区锁控件与中文锁名（26 项）
node --test test/lock-priority.test.mjs  # 调度优先级（4 项：文件锁任务优先放行）
node test/lock-badge.test.mjs  # 进程行锁徽标 + 全仓防复发扫描（34 项）
node --test test/memory-ban.test.mjs  # 记忆禁令注入（4 项：prompt/target 注入，task 如实标记）
node test/panel-style.test.mjs  # 面板样式注入（24 项：只注入 head 一次，重渲染不触碰）
Z2_HOST_REPO=<宿主项目> node test/z2-verify.mjs   # 端到端验收（不设则跳过越界检查并如实标注）
```

门禁阈值只升不降；原始输出与未决项记录在 `tasks/` 下各轮的交付文档里。

---

## 第三方材料声明

`refs/dsh-tools/**` 是从本机 DSH 安装包**只读提取**的 `@deepseek-ai/dsh-tools` 包副本
（MIT 许可，`refs/dsh-tools/LICENSE` 随附），保留在此处是为了给插件开发提供**形态对照**。
其余 DSH 自带材料的提取副本（`refs/extracted/`、`refs/dsh-typert/`、`refs/plugin-whale-pet/` 等）
遵守 **不入库** 纪律，见 `.gitignore` 与 `refs/README.md`。

---

## 许可

MIT（见 [`LICENSE`](LICENSE)）。第三方材料沿用其各自许可（见上节）。
