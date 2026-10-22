# DSH 派发台（dispatch）

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
> 把任务派发给本机 **四个 AI 编程 CLI**（ZCode / OpenCode / Qoder / WorkBuddy）的无头进程，
> 并在 DSH 页面右下角的悬浮面板里监视它们。

DSH 自带的 `subagent` 跑的是 DSH 自己的 agent；**本插件跑的是你自己的 CLI** —— 独立进程、
独立额度、独立会话，任务行出现在「DSH 派发台」面板里，可查输出、可终止、可续跑、可换通道重跑。

## 四个引擎

全部走**官方 CLI**：不反代、不模拟 OpenAI/Anthropic 兼容接口、不读写任何凭据内容 ——
插件只负责"起进程 / 传参数 / 读 stdout"。"通道即执行目标"是 core 的模型
（`zcode` / `opencode/<model>` / `qoder/<model>` / `codebuddy/<model>`）。

| 引擎 | 官方 CLI | 登录 | 额度 / 积分 | 备注 |
|---|---|---|---|---|
| **ZCode** | `zcode.cjs`（桌面客户端自带） | 读 `~/.zcode/v2/credentials.json` | ✅ **能查**（客户端日志里的 balance 行） | 支持「套餐」与「免费额度 Start Plan」两条路由 |
| **OpenCode** | `opencode`（PATH） | 免费模型无需凭据 | 免费（无额度概念） | 十几个免费模型；并发上限默认 2（实测依据） |
| **Qoder** | `qoderclicn`（PATH） | ⚠️ **需单独登录** | ⚠️ 积分制，**无余额查询接口**；单次消耗可查（`credits`） | 与桌面应用登录**不共享**；并发默认 3（实测） |
| **WorkBuddy** | `codebuddy`（WorkBuddy 客户端内置） | ⚠️ **需单独登录** | ⚠️ 积分制，**CLI 完全不暴露** | 见下节「积分可得性」；并发默认 2（保守默认，未实测） |

**引擎自动发现**：四引擎都走 `collab-kit/engine-discover.mjs` 的五级探测
（env → 配置 → PATH → 已知安装位置 → 跨盘符扫描），**不需要手填路径**；
面板「引擎」行显示形态 / 版本 / 登录态，点悬浮看探测依据。

### 积分可得性（真机实测结论，不猜）

| 引擎 | 余额 | 单次消耗 | 依据 |
|---|---|---|---|
| ZCode | ✅ `giftQuota` | token | 读客户端日志（只读，零网络） |
| OpenCode | — | token | 免费模型 |
| Qoder | ❌ 官方无接口 | ✅ `credits` | `result.total_credits` **恒 0**，真值在每条 assistant 的 `message.usage.credits`（需按 `message.id` 去重累加） |
| WorkBuddy | ❌ 官方无接口 | ❌ | stream-json 只有 token；`total_cost_usd` **恒 0**；`/cost` `/stats` 无头不支持；`--serve` REST 无 usage 端点；本地存储无数值 |

⇒ 面板与 agent 工具**只显示真拿得到的数**：拿不到就**不显示**（不编数字、不猜汇率折算）。
「哪个引擎查不到」这种元数据仍完整保留在 `action=channels` 的 `creditSummary` 里给 agent 读。

### 为什么走官方 CLI，而不是反代

社区有把 WorkBuddy / Qoder 的账号登录态**反代成 OpenAI/Anthropic 兼容接口**的做法。
本项目**刻意不做**：

1. **合规**：反代本质是伪造客户端身份调官方接口，官方一收紧就会被封（WorkBuddy 已经开始限制）。
   走官方 CLI 是产品自身入口，不受这类限制影响。
2. **不碰凭据**：插件**只读**做登录态探测（凭据文件**是否存在 / 大小 / 刷新时间**），
   **从不读内容、不写、不删**。修复动作一律交给用户或官方 `/login`。
3. **能力完整**：CLI 自带完整工具链（读写文件、跑命令、MCP）；反代只能拿到"对话"，
   DSH 的工具层反而用不上。

代价：只能拿到 CLI **愿意暴露**的数据 —— 比如 WorkBuddy 的积分就查不到（见上表）。
本项目的态度是**如实标注"查不到"，不编数字**。

> 长任务在看守进程那侧还会被**温和终止**（3 秒后才兜底强杀）—— 因为真机发现强杀 WorkBuddy CLI
> 会留下 `.logged-out` 标记，导致之后一直判"未登录"（详见 [`pitfalls.md`](pitfalls.md)）。

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
| **派发（四引擎）** | 把 `prompt` / 任务文件 / 目标描述交给 ZCode / OpenCode / Qoder / WorkBuddy 跑；`build / edit / plan / yolo` 四种模式仅 ZCode 支持（其它引擎按各自 CLI 能力剔除） |
| **单写者互斥** | `repo` / 文件锁 + 进程内 FIFO 队列：同锁任务串行，冲突只排队不报错（多会话并发也不会互相踩） |
| **实时监视** | 每个 job 的状态、耗时、**Token 用量**、上下文占用、**积分/费用**、退出码、锁持有者；可拉最近输出（tail） |
| **续跑 / 重跑** | 同会话 `--resume` 重发原提示词，或在同一会话里发一条新指令（仅 ZCode 支持 resume） |
| **通道与降级链** | 切换通道 / 模型 / 思考强度；额度耗尽或未开通时按降级链自动交接重跑到下一个可用通道 |
| **分流模式** | 主通道名额满时把新任务自动改派到降级通道（两条通道并发名额叠加）；显式指定 provider 时不生效 |
| **思考强度核对** | 记录请求档位 vs 实际生效档位；Qoder 用 thinking 内容块有无判定，**不符时给出向上改档建议** |
| **引擎登录助手** | WorkBuddy 登录态常显（●已登录 / ◐凭据在 / ○未登录 / ⚠标记残留）+ 一键登录（临时 `--serve`）；登录服务**温和终止**、残留标记自动诊断 |
| **免费额度通道** | ZCode **Start Plan**：托管官方 app-server 走逐请求签名；`account:<family>-start-plan`；与付费套餐复用同一条面板 / 台账 / 暂停 / 降级流水线 |
| **积分/额度视图** | 按引擎汇总（`creditSummary`：有余额 / 取不到 / 官方无接口）+ 本进程内消耗聚合（`creditConsumption`）；**拿不到的就不显示** |
| **用量聚合** | 本地台账 5 小时滚动 / 本周 / 今日，外加套餐剩余额度（数据源不可用时如实标注，不猜） |
| **派发总开关** | 一个跨会话真值文件：`false` = 任何会话都不得派发（runner / 插件 / 桥接三处强制生效） |
| **agent 工具** | 注册 `dispatch`，与面板同一套动作实现（一操作两调用方） |
| **落地自动唤醒** | 任务落地（done/failed/killed/paused）时唤醒发起会话，与 DSH 后台任务同款 |

---

## 目录结构

```
dispatch/
├─ dispatch/          ★ 插件本体（cordis bundle：Host 半边 + Client 半边）
│  ├─ index.js              Host 入口：apply(ctx, config)、dispatcher 单例、注册 agent 工具、激活信标
│  ├─ wire.host.mjs         Host 接线 + 动作唯一实现 createActionHandler + 派发总开关读写
│  ├─ wire.client.mjs       Client 接线 + 轮询 / demo 降级
│  ├─ client.js             UI 半边：悬浮面板（React.createElement，无构建步骤）
│  ├─ core/                 派发核心（零 npm 依赖）：dispatch-core / quota / gift-quota / appserver-rpc …
│  ├─ bin/dispatch.mjs           独立 CLI（与插件同 core，用来对照排查）
│  ├─ locale/{zh,en}.json   中英文案（key 一一对应，有测试锁）
│  ├─ test/                 69 个可复跑自测文件
│  └─ cordis.patch.yml      bundle 层 patch（**只放 demo/maxConcurrent**，机器路径见「配置」）
├─ collab-kit/              ★ 四个执行器（与插件 core 共用行协议，也可单独当 CLI 用）
│  ├─ zcode-run.mjs         ZCode 执行器
│  ├─ opencode-run.mjs      OpenCode 执行器
│  ├─ qoder-run.mjs         Qoder 执行器（credits 计量）
│  ├─ codebuddy-run.mjs     WorkBuddy / CodeBuddy 执行器（官方 CLI + 登录助手）
│  ├─ engine-discover.mjs   四引擎自动发现（env → 配置 → PATH → 已知安装位置 → 跨盘符扫描）
│  └─ appserver-gift*.mjs   ZCode Start Plan 免费额度托管
├─ tools/                   常驻证据脚本（见「复跑证据」，17 个）
├─ bridge/                  客户端自动化桥（inbox/outbox 收发任务文件）
├─ tasks/                   开发留档：每轮任务书与交付记录（含原始输出与未决项）
├─ refs/                    参考资料（**含第三方材料，见文末声明**）
├─ profile-backup/          DSH profile 配置的三态留档与恢复说明
├─ pitfalls.md              ★ 踩坑总账（每个真机坑的现场、根因、修法）
└─ dispatch/teaching.md     ★ 教学文档（引擎细节 / 登录 / 额度 / 验收清单）
```

**四引擎的差异不会被"抹平"**：每个引擎在 `validateSpec` 里剔除自己不支持的参数
（如 Qoder/WorkBuddy 不支持 `mode` / `memoryBench`），并在面板"引擎提示"行如实说明，
而不是静默忽略。

---

## 安装

要求：DSH 桌面版（在 `0.2.1-rc.2` 上开发验证）+ **至少一个**本机 AI CLI
（ZCode / OpenCode / Qoder / WorkBuddy 任一；四个都在则全部自动发现）。

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
| `maxConcurrent` | `3` | **全局**同时运行上限（各引擎实际并发 = min(全局, 该引擎上限)） |
| `maxConcurrentOpenCode` | `2` | OpenCode 独立并发（**实测**：并发 opencode 进程会零输出 exit 1，故默认 2 不建议调高） |
| `maxConcurrentQoder` | `3` | Qoder 独立并发（**实测**：3/5 个 `qoderclicn` 并发全部 exit=0 且结果正确） |
| `maxConcurrentCodebuddy` | `2` | WorkBuddy 独立并发（**保守默认，未实测**；该 CLI 是 Electron 内置 bundle，比纯 CLI 重） |
| `runnerPath` | `''` | ZCode 执行器绝对路径（`collab-kit/zcode-run.mjs`）；**留空则不创建 dispatcher** |
| `opencodeRunnerPath` | `''` | OpenCode 执行器（留空自动推断：env `DSP_OPENCODE_RUNNER` → 仓库内） |
| `codebuddyRunnerPath` | `''` | WorkBuddy 执行器（留空自动推断：env `DSP_CODEBUDDY_RUNNER` → 仓库内） |
| `ledgerPath` | `''` | 台账 `dispatch-runs.jsonl` 绝对路径；留空则跳过用量聚合 |
| `workRoot` | `''` | 派发器工作根目录（`locks/`、`state/jobs.json`、`logs/`）；**留空则不创建 dispatcher** |
| `runnerCwd` | `''` | runner 子进程工作目录（通常设为宿主项目根）；留空 = DSH 进程 cwd |
| `switchPath` | 内置默认 | 派发总开关真值文件；留空则开关不可写 |
| `notifyOnSettle` | `true` | 任务落地时自动唤醒发起会话（与 DSH 后台任务同款） |
| `maxConsecutiveWakes` | `0` | 连续唤醒次数上限；0 = 不限 |
| `systemPromptHint` | `true` | 向 system prompt 注入「派发台优先于 subagent」提示段 |

> Qoder 执行器路径通过 `options.qoderRunnerPath` / env `DSP_QODER_RUNNER` 注入，默认推断到仓库内。

`runnerPath` 与 `workRoot` **任一为空则不创建 dispatcher**：面板走 demo 降级，agent 工具返回可读错误。
这是**刻意设计**——不猜一个位置静默跑错。

> 「引擎自动发现」在 dispatcher 存在时**默认开启**，不需要额外配置；
> 它只读取环境/文件系统/CLI 版本，**不消耗任何额度**。

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
dispatch | list | kill | dismiss | tail | quota | status | switch
         | channels | channel | retry | fallback | split | login | wait
```

- `dispatch`：`kind=prompt|task|target` + 对应内容字段；可选 `model` / `provider` / `engine` /
  `thinking` / `mode` / `timeoutMin` / `memoryBench` / `auto` / `tag` / `lock` / `write` / `cwd` / `resume`
- `list` / `tail(id,n)` / `quota`：监视与用量
- `kill(id)` / `dismiss(id)`：终止；把 paused/终态 job 从列表移除
- `status` / `switch(enabled)`：读 / 切换派发总开关
- `channels` / `channel` / `retry` / `fallback`：通道清单、默认通道、续跑、降级链
- `split`：分流模式（主通道满了自动摊到降级通道，两条通道名额叠加）
- `login`：WorkBuddy 登录助手（`start` / `status` / `stop`）
- `wait`：等 job 落终态（paused 也返回，超时不谎报）

**给 agent 的关键数据**（都在 `action=channels` 的返回里）：

| 字段 | 含义 |
|---|---|
| `channels[].thinkingLevels` | 该通道各模型的**合法思考档位**（随模型声明不同，别猜枚举） |
| `channels[].recentQuotaExhausted` | 最近撞过额度（含 `retryAfterSec`）—— 这才是"现在能不能派"的真信号 |
| `channels[].expired` | 用户已关闭的模型（面板勾选决定） |
| `engineDetail` | 四引擎形态 / 版本 / **登录态** / 探测依据 |
| `creditSummary` | 按引擎的积分/额度：`available:true`(有数据) / `false`(取不到) / **`null`(官方不提供)** |
| `creditConsumption` | 本进程内按引擎的**已消耗**（Qoder `credits` / WorkBuddy `costUsd`，口径不同**绝不相加**） |

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

- **通道**：通道 + 模型两个下拉（按引擎折叠：选引擎→选模型），思考强度；
  自动降级链；**不可用通道不再列出**（当前选中值若已掉线仍单独显示并标注原因以便切走）
- **引擎**：四引擎状态行（● 可用 / ○ 未登录 / × 未找到）+ 形态 · 版本 · 登录态；
  选中通道时显示它的**额度**（只在真查到数据时出现，查不到就不占地方）
- **派发**：面板**已不再手动派发**（ZB-29c）——需要时让 agent 用 `dispatch` 工具代劳
- **进程**：按状态分 **Tab**（进行中 / 需处理 / 异常 / 已完成），每页只渲染最近 5 条 + 可展开；
  点击行头展开详情（派发要素、会话 id、最近输出），行动作（终止 / 重跑 / 续接 / 关闭）都在展开区里
- **每行显示**：`Token 用量` · 上下文占用 · 积分/费用（有才显示） · 耗时 · 退出码
- **用量**：5 小时窗口 / 本周 / 今日三张卡；**单写者**：锁持有者与队列长度
- 面板空白区不挡应用（`pointer-events` 精细控制）；主题令牌取自 DSH 主题，无字面色值

---

## 复跑证据

```bash
node tools/verify-plugin.mjs      # 插件形态与契约探针
node tools/verify-switch.mjs      # 派发总开关独立复现（用临时目录密封）
node tools/verify-engine-detail.mjs   # 四引擎自动发现真机冒烟
node tools/verify-zb95-state.mjs      # WorkBuddy 登录态三态（含临时 marker 造残留）
# 全量套件（69 个测试文件）：
node %TEMP%\dispatch-suite.mjs
```

各引擎专项（也可单独跑）：

```bash
cd dispatch
node test/core.test.mjs               # 派发核心
node test/qoder-executor.test.mjs     # Qoder 协议 / 聚合器 / credits 去重累加
node test/codebuddy-engine.test.mjs   # WorkBuddy 协议 / 端到端（退出码恒 0 的坑）/ 登录助手
node test/engine-discover.test.mjs    # 四引擎自动发现（五级优先级 + 假 fs）
node test/gift-quota.test.mjs         # 免费额度解析 + 陈旧度 + creditSummary 三态
node test/ctx-format.test.mjs         # 上下文占用展示
```

> **门禁阈值只升不降**；原始输出与未决项记录在 `tasks/` 下各轮的交付文档里。
> 踩过的真机坑（含根因与修法）见 [`pitfalls.md`](pitfalls.md)，引擎细节见
> [`dispatch/teaching.md`](dispatch/teaching.md)。

---

## 第三方材料声明

`refs/dsh-tools/**` 是从本机 DSH 安装包**只读提取**的 `@deepseek-ai/dsh-tools` 包副本
（MIT 许可，`refs/dsh-tools/LICENSE` 随附），保留在此处是为了给插件开发提供**形态对照**。
其余 DSH 自带材料的提取副本（`refs/extracted/`、`refs/dsh-typert/`、`refs/plugin-whale-pet/` 等）
遵守 **不入库** 纪律，见 `.gitignore` 与 `refs/README.md`。

---

## 许可

MIT（见 [`LICENSE`](LICENSE)）。第三方材料沿用其各自许可（见上节）。
