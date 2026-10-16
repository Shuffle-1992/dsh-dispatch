# dsh-dispatch —— DSH 派发台（cordis bundle）

在 DSH Harness 里派发/监视多个 ZCode 无头进程（`zcode-run.mjs`）：单写者互斥、用量与上下文、套餐通道。
Host 半边（`index.js` + `wire.host.mjs` + `core/*`）跑进程调度并暴露 agent 工具 `dispatch`；
Client 半边（`client.js` + `wire.client.mjs`）在 Web 页面**会话标题行**渲染一枚「DSH 派发台」入口（与「N 个子智能体 / 智能体团队 / 创造模式」同一行），点开即在入口下方弹出面板。

> ⚠ **标准模式不可安装**：标准模式 DSH 会话没有 `plugin_manager` / `cordis_inspect_query`，
> 本包只能被写出、不能被安装验证。安装由**创造模式（creator preset）会话**执行（见下）。
>
> 槽位与令牌证据基于客户端 0.2.0-rc.2 一代包（2026-09-30 抓取），升级后请用 `Slots.listSubTree` 复核。

## 目录结构

```
dispatch/
├─ package.json          bundle 清单（dsh.bundle.patch + dsh.client + meta/icon/locale）
├─ cordis.patch.yml      插入一行 id=dispatch 的 config（demo/maxConcurrent/runnerPath/ledgerPath/workRoot）
├─ index.js              Host 半边：apply(ctx, config)；创建 dispatcher 单例、卸载清理、注册 agent 工具
├─ notify.mjs            ZB-22 落地自动唤醒（job 落地 → 唤醒发起会话；零 @deepseek-ai 依赖）
├─ wire.host.mjs         Host 接线适配器＋动作唯一实现 createActionHandler（creator TODO 已于 Z8-01 清偿）
├─ wire.client.mjs       Client 接线适配器＋轮询/demo 降级
├─ client.js             UI 半边：标题行入口 + 悬浮弹窗（React.createElement，无构建）；内嵌降级 wire
├─ core/                 Z1 交付的派发核心（dispatch-core.mjs / quota.mjs，Z3 增 appserver-rpc.mjs）——只 import，不改
├─ bin/dispatch.mjs           Z1 的独立 CLI（与插件同 core，可做对照排查）
├─ locale/{zh,en}.json   meta + 界面文案（ui 段与 client.js 内嵌 STRINGS 同源）
├─ icon.svg              插件图标（几何图形，≤256KiB）
└─ test/                 可复跑自测与验收（清单见「可复跑自测清单」一节）
```

## 运行期数据（不随包分发）

`work/`（`bin/dispatch.mjs` 默认工作根：`state/jobs.json`、`logs/*.out|err.log`、`locks/`）与插件安装后
patch 默认指向的 `.data/`（同结构，见 config 说明）都是**运行期数据**：不进 `package.json` 的
`files`、不随 bundle 分发，可随时整体删除重建（删除后进程列表清空；用量以 `config.ledgerPath`
指向的台账为准，不受影响）。`state/dismissed.json` 同属运行期数据（Z11：UI「关闭」掉的
paused/终态 job 的 id 集合，`snapshot`/`list` 据此过滤；删掉即恢复显示）。
`test/` 下的验收输出物（如 `*.output.txt`）同样不入包。

## 安装

> **本项目不发布 npm**（不提供裸包名安装）。推荐路径 = **从 GitHub 仓库安装**；
> 改代码的场景用本地绝对路径挂载。

### 方式一：从 GitHub 仓库安装（推荐）

```sh
dsh plugin --profile web add "github:Shuffle-1992/zcode-dispatch#path:dispatch"
# 或等价 URL 形式
dsh plugin --profile web add "https://github.com/Shuffle-1992/zcode-dispatch#path:dispatch"
```

或在 DSH 的**插件页**点「添加插件」、填上面那条 git 规格。

> 把 `web` 换成你的 profile 名（`dsh plugin list` 可查）。装完**重启 DSH** 生效。

> ⚠️ **`#path:dispatch` 不能省**：本仓库是 monorepo，插件本体在 `dispatch/`
> 子目录；DSH 实际执行 `pnpm add <spec>`，而 pnpm 对 git 仓库**默认取仓库根** ——
> 根目录没有插件 `package.json`，装出来只会得到一个占位包
> （实测 `{"_pnpmPlaceholder":"...did not contain a package.json."}`），插件文件全在子层，
> DSH 加载会失败。

### 方式二：本地开发（绝对路径，创造模式会话）

1. `plugin_manager` → `install_bundle`，`target` = `<本仓库>/dispatch`（绝对路径）。
2. **读返回的 `application` 与 `warnings`**（不是看日志）：`applied` 才算生效；`restart-required` /
   `failed` / `overridden` 分别处置。若报 pending build scripts，**先问用户**再传 `approvedBuilds`。
3. 本包无构建步骤、无 npm 依赖；替换已安装包需要重启才加载新 JS（新装 bundle 可走 HMR）。

> 两种入口的取舍：**git + `#path:`**（推荐，当前仓库可直接装）→ **本地绝对路径**
> （改代码即时生效，开发用）。因为不发布 npm，**不要**用裸包名 `dsh-dispatch` 安装
> （只有发布到 npm 之后那种形式才成立）。

## config 说明（cordis.patch.yml 可改；用户 patch 层升级存活）

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `demo` | boolean / `false` | UI 演示模式：客户端用内置假数据渲染面板，不触达 dispatcher |
| `maxConcurrent` | integer / `3` | 同时运行的 run 上限。**注意：它与单写者锁是两道独立的闸，实际并发 = min(两者)**，见下节 |
| `runnerPath` | string / `''` | runner 绝对路径（通用工具仓库 `<本仓库>/collab-kit/zcode-run.mjs`，只读使用）。**与 `workRoot` 任一为空则不创建 dispatcher**（UI 走 demo 降级，工具动作返回可读错误） |
| `runnerCwd` | string / `''` | runner 子进程的工作目录（通常设为宿主项目根）。runner 已迁出通用工具仓库、无法从自身位置推项目根，故它与「从绝对 `--task` 反推」构成**双保险**；留空 = 用 DSH 进程 cwd |
| `ledgerPath` | string / `''` | 台账 `dispatch-runs.jsonl` 绝对路径；留空则跳过台账回读与用量聚合 |
| `workRoot` | string / `''` | 派发器工作根目录（`locks/`、`state/jobs.json`、`logs/` 落在这里）。留空即落到本包 `.data/` |
| `switchPath` | string / `''` | Z12：派发总开关真值文件（宿主项目 `collab/dispatch.switch.json`）。文件缺失/损坏=开启；留空则开关不可写；测试可指向临时文件密封 |
| `notifyOnSettle` | boolean / `true` | **ZB-22**：job 落地（`done`/`failed`/`killed`/`interrupted`/`paused`）时自动唤醒**发起它的那个会话**（与 DSH 后台任务同款，见下节）。`false` = 只派发不唤醒 |
| `maxConsecutiveWakes` | integer / `0` | **ZB-22**：用户没说话期间允许的**连续**唤醒次数上限；`0`=不限。超出后该次通知改为注入下一步（等用户说话后预算清零） |
| `systemPromptHint` | boolean / `true` | **ZB-22**：往 system prompt 注入一段「派发台优先、别退回 DSH 自带 subagent」提示（新会话的 agent 因此不易用错工具）。`false` = 不注入 |

> **路径都是机器专有配置，仓库里不写死。** 本包的 `cordis.patch.yml` 只插入 `demo` / `maxConcurrent`；
> 上述四个路径请在 **profile patch**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里按 id 覆盖：
>
> ```yaml
> - id: dispatch
>   name: "dsh-dispatch"
>   config:
>     runnerPath: '<宿主项目>\scripts\collab\zcode-run.mjs'
>     ledgerPath: '<宿主项目>\collab\logs\dispatch-runs.jsonl'
>     workRoot:   '<本插件目录>\.data'
>     switchPath: '<宿主项目>\collab\dispatch.switch.json'
> ```
>
> 三个路径全空时插件照常激活，只是不创建 dispatcher（面板 demo 降级、工具动作返回可读错误）——
> 不会猜一个位置静默跑错。

## ⚠️ 凭据从哪来 + 报「身份验证失败 / 401」怎么办

本插件的凭据**不自己存**：它和宿主 runner（`zcode-run.mjs`）一样，读 **ZCode 自己的配置文件**：

| 位置 | 内容 |
|---|---|
| `~/.zcode/v2/config.json` → `provider["builtin:bigmodel-coding-plan"].options.apiKey` | **明文** Key（本插件与 ZCode CLI 都读它） |
| `~/.zcode/v2/credentials.json` → `account-provider:coding-plan:…:api-key` | **加密**（`enc:v1`）凭据库，随 OAuth 登录更新 |

### 最常见的故障：OAuth 重新登录后 `config.json` 失配

**这是 ZCode 的上游缺陷，不是本插件的问题**：

> ZCode 在 **OAuth 重新登录 / 重新授权**后，把**新 Key 只写进加密凭据库
> `credentials.json`**，**不回写 `config.json`**；而 `config.json` 里留着**已失效的旧 Key**。
> ⇒ **一切读 `config.json` 的程序集体 401**，**连 ZCode 自己的 Agent CLI（`zcode.cjs -p …`）也一样**。

**判断**（最快）：比对两个文件的修改时间 —— 若 `credentials.json` 很新、`config.json` 停在很久以前，
基本就是失配。

**💡 解决：把有效 Key 保存（写回）到 `config.json`** —— 这是**一次修好所有工具**的做法：

1. 从凭据库解出有效 Key（`credentials.json` 里的值是 `enc:v1:<iv>.<tag>.<data>`
   AES-256-GCM 加密，密钥 = `sha256(secret)`，secret 见下方参考实现）；
2. **先验活**（见下方陷阱，**不能只看状态码**）；
3. **备份** `config.json` 后，把有效 Key 填回
   `provider["builtin:bigmodel-coding-plan"].options.apiKey`；
4. 回读校验；必要时重启 ZCode / DSH。

> ⚠️ 手工改之前**先退出 ZCode**（运行中修改可能被覆盖），并**务必先备份**。
>
> 姊妹项目 [`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode) 提供了
> 现成工具做这件事（自动备份 + 验活 + 原子替换 + 回读校验）：
> `node scripts/sync-key-to-config.mjs --dry-run` 先诊断，去掉 `--dry-run` 即执行。
> 其 README 与 `TROUBLESHOOTING.md` 有完整的踩坑记录。

### ⚠️ 验活陷阱：网关对**失效 Key** 也返回 HTTP 200

```
HTTP 200
{"code":1000,"msg":"身份验证失败。","success":false}      ← 这是失效 Key！
```

**只看 `res.ok` / 状态码会把无效 Key 判为有效**。正确判定（三者同时满足）：

```js
const res = await fetch(`${baseURL}/v1/models`, {
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
});
if (!res.ok) return false;                        // 401 等
const body = await res.json();
if (body?.success === false) return false;        // ← 关键：200 也可能是认证失败
if (body?.code !== undefined && body.code !== 200) return false;
return Array.isArray(body?.data) && body.data.length > 0;
```

> 本仓库 `test/` 下的假 runner 不触网，故该判定属于**宿主持有凭据**的范畴；
> 此处记录是为了让排查者知道「为什么工具说正常、实际仍 401」。

## agent 工具 `dispatch`

一个工具 + `action` 参数：`dispatch | list | kill | dismiss | tail | quota | status | switch | channels | channel | retry | fallback | wait`，
与 UI 悬浮窗操作一一对应
（同一实现：`wire.host.mjs` 的 `createActionHandler`，references/user-actions.md「一个操作两个调用方」）。

- `dispatch`：`kind=prompt|task|target` + 对应内容字段。**kind 判据（ZB-28）**：
  `prompt`=完整指令（一次性问答/明确步骤）；`target`=**目标描述**（只说"要达成什么"，
  ZCode 自主规划并自续跑直到达成，适合无人值守委托；与 prompt/task 互斥是 CLI 限制）；
  `task`=任务包文件绝对路径（含交付物/验收标准的正式任务，由 runner 读文件内联）。
  可选 `model(GLM-5.3|GLM-5.3-Flash)`、`provider(plan|personal)`、`mode(build|edit|plan|yolo，默认 edit)`、
  **`thinking(思考强度，默认 agent=Agent决定，见「思考强度（thinking）」小节)`**、
  `timeoutMin(>0，无上限；runner 生效下限 1 分钟)`、`memoryBench(仅 kind=prompt)`、`tag`、
  `lock(repo|none，**默认 repo**；none=明确不取锁)`、`write(预计写入的文件列表)`、`cwd`、`resume`。
- `list` / `kill(id)` / `dismiss(id)` / `tail(id, n=30)` / `quota`（本地台账 5h 滚动 / 本周 / 今日聚合 +
  引擎本周已用；`bin/dispatch.mjs quota --json` 同时含 `local` 与 `planQuota` 两段，
  任一失败不互相影响）。`dismiss`（Z11）：把 paused/终态 job 从列表移除并落盘
  `state/dismissed.json`（queued/running 必须先 kill）；core 的 `kill` 对 paused 是空操作
  （子进程已退出），UI「关闭」按钮因此先 `kill`、kill 无效时退回 `dismiss`。
  **`list` 的 queued 行带 `lockWait`（ZB-28 排队可观测）**，见「锁排队可观测（ZB-28）」一节。
- `channels` / `channel set` / `retry(jobId, {provider?, model?})` / `fallback`：Z6 通道与续跑，见下节。
  `fallback`（ZB-30）：无参=读设置；`chain:[id,…]` 或 `chain:null` 设/关多目标；单目标用
  `provider` + `model` + `thinking`（与面板开关同形）。
  **选择判据（ZB-28）**：job 还在派发台里 → `retry`（簿记链完整）；手里只有裸 sessionId → `dispatch` + `resume`，
  详见「resume 与 retry 怎么选」一节。
- 限制：仓库写锁互斥（同锁 FIFO 排队，不报错；**文件锁任务优先放行**，见「锁与并发语义」）；`memoryBench` 仅 prompt；
  model/provider 的 schema 枚举只是常用别名——**通道取值以 `channels` 实时清单为准**（见「枚举与 channels 清单，以谁为准」）；工具不授予/确认任何权限。

## 锁与并发语义（ZB-16 锁模型）

**并发数 = min(`maxConcurrent`, 锁闸)**。锁闸按**文件集**判定 —— 这是 ZB-16 的核心：

| 任务的 `lock` / `write` | 行为 |
|---|---|
| **声明 `write: [...]`** | **只锁这些文件** ⇒ 与写**其它文件**的任务**可并发**；写同一文件的后排队 |
| 不声明 `write`（默认 `lock=repo`） | 锁**整个仓库** ⇒ 与任何任务互斥（单写者纪律本义） |
| `lock='none'` | 明确不取锁（确认无竞写关系时用） |

> **怎么让多个任务真正并发**：给每个任务声明它**要写的文件**（`write`）——
> 由派发方（Agent）在工具调用里声明（面板手动派发已于 ZB-29c 移除，派发一律经 `dispatch`）。
> 实测：三个任务分别写 `a.ts`/`b.ts`/`c.ts` ⇒ **三路同时 running**。

> **memory 锁已删除（ZB-16）**：它保护的是 ZCode 自己的记忆库（`~/.zcode`），与仓库写入互不相干。
> ZCode 记忆写入改由**默认注入的提示词禁令**约束（派发时自动要求子代理不写记忆库）。
> **ZB-28 起三种 kind 全覆盖**：`kind=prompt`/`target` 由插件把禁令直接拼进内容；
> **`kind=task` 由宿主 runner 经 `--memory-ban` 旗标注入**（runner 内联任务包时追加同款文本）。
> 字段语义：`memoryBanApplied=true` = 禁令已安排（三种 kind 恒 true）；
> `memoryBanRunner=true` = runner 打印了 `memory-ban=on`（**runner 确认**注入；假/旧 runner 无此行则该位为空）。
> ⚠️ 旧版 runner 不认识 `--memory-ban` 会报「未知参数」exit 1（fail-fast，不静默裸奔）——
> runner 与插件同仓库（`collab-kit/`）发货，请成对升级。
> ⚠️ 该禁令只是提示词层面的约束（LLM 遵循），不是进程级强制。

> **跨层级互斥（ZB-16 修的真实缺口）**：`repo.lock`（整仓库）与 `files/*.lock`（某几个文件）
> 曾是两套互不知情的锁 —— 一个持整仓库锁时，另一个锁某文件却照常 running。
> 但"整仓库写"涵盖所有文件 ⇒ 必然竞写。现已加 `crossLevelBlocked`：
> 文件锁任务会检查整仓库锁，反之亦然（保守：无法证明无交集即视为冲突）。

> **调度优先级（ZB-17 用户要求）：文件锁任务优先放行**。
> 旧实现是严格 FIFO + 队头阻塞（队头拿不到锁就 `break`）—— 后果是一个整仓库锁任务排在
> 队头时，**后面本可并行的文件锁任务全被堵住**（实测：反向验证时旧实现"实际跑的是 WHOLE"）。
> 现改为**按优先级扫描队列**取第一个能拿到锁的：
>
> | 规则 | 说明 |
> |---|---|
> | 优先级 | **文件锁任务 > 整仓库锁任务** |
> | 同类内 | 保持 **FIFO**（按队列原始顺序，不互相插队） |
> | 整仓库锁执行时 | 文件锁任务**都等待**（这是 `crossLevelBlocked` 的职责，与优先级无关） |
>
> ⚠️ 已知取舍：若文件锁任务持续不断到来，队里的整仓库锁任务可能被长期推后（**饥饿**）。
> 本轮按用户明确要求只做优先级、**未加 aging**；若实际出现饥饿，再加"等待超时后提升优先级"。

> 实测（2026-09-30）：T18（`lock=both`）跑 27 分钟期间，一个只要 `repo`、
> 一个只要 `memory` 的任务全程干等，三者 `started`/`finished` 首尾相接、**无一毫秒重叠** ——
> 因为 `maxConcurrent=1` 是总闸。故 `maxConcurrent` 已提到 4（profile 配置）。


### 细粒度文件锁（`write`）

派发时声明「这个任务预计写哪些文件」，core 就只为这些路径加锁：

```
dispatch(write: ['F:\\proj\\src\\a.ts'])   # 只锁 a.ts
```

- **写不同文件 ⇒ 可并行**（这是本机制的全部收益）
- **写同一文件 ⇒ 后者排队**（细粒度互斥仍成立）
- **路径归一化**：Windows 上大小写不敏感，`F:\proj\src\a.ts` 与 `F:\PROJ\SRC\A.TS`
  视为**同一文件**（否则会产出多把锁、同一文件被并发写 —— 这是开发中实测抓到并修掉的 bug）
- **防死锁**：多文件按归一化路径**排序后**依次加锁，所有任务加锁顺序一致
- **加锁留痕**：锁体回存 `paths`，UI「**仓库文件锁**」分区展示**哪个文件被哪个进程锁着、锁了多久**

> ⚠️ **安全底线**：**未声明 `write` 的任务一律锁整个仓库**（`repo.lock`）。
> 细粒度是「声明了才生效的可选优化」，**不是默认放宽** —— 否则不声明的任务会失去互斥保护，
> 多个 ZCode 进程同时改同一个仓库，那正是单写者语义要防的事故。
> 测试 `test/file-lock.test.mjs` 的第一条就是这个底线。

### 锁排队可观测（ZB-28 `lockWait`）

**用户可见语义（一句话）**：被整仓库锁挡住时不再盲等 —— queued 任务直接告诉你
「被谁挡住、前面还有几个、预计还要等多久」。

`list` 动作 / 面板进程行（展开）里，queued job 携带 `lockWait` 结构（其余状态恒 `null`）：

| 字段 | 含义 |
|---|---|
| `position` / `queuedTotal` | 全局队列位次（1 起）/ 队列总长 |
| `ahead` / `aheadIds` | **同类**前方任务数与 id（同类=文件锁任务 / 整仓库锁任务，与放行优先级同尺，同类内 FIFO；id 截前 10 个） |
| `blockers[]` | 此刻挡住本任务的锁：`lock`（`repo` / `file:<路径>` / `cross:…` 跨层级）、持有者 `holderJobId`/`holderTag`/`holderState`、`holderElapsedSec`（已运行秒）、`holderTimeoutMin`、`holderRemainingSec`（剩余上界秒） |
| `estWaitSec` | 预计等待秒数（**上界**）：仅当每个阻塞者都声明了 `timeoutMin` 时可估 = max(`timeoutMin`×60 + 看门狗宽限 − 已运行秒)；否则 `null` —— **不猜** |
| `estWaitNote` | 中文说明：估计怎么来的 / 为什么是 `null` / 前方同类还会加时 |

- 只读观测：计算只检查锁文件与内存 job，**绝不加锁、绝不清锁**（观测不能改变调度状态）。
- 面板展开行显示一行人话：「`第 2/3 位 · 前方 1 个（j-xxxxxxxx） · 被 tag-x 挡住 · 预计 ≤ 0时03分20秒`」。
- 证据：`test/lock-queue-visibility.test.mjs`（6 条：整仓锁/文件锁/跨层级指认持有者、ahead 分类计数、estWaitSec 上界与不猜、wire 透传）。

### `wait`：让会话不必轮询

`dispatch` 是 **fire-and-forget**（实测：返回时 `state=queued`、无回调），会话拿结果得自己轮询。
`wait` 补上这个缺口：

```
dispatch(...)            → { ok:true, job:{ id, state:'queued' } }
wait(id, timeoutSec)     → { ok:true, job:{…终态…}, waitedSec, timedOut:false }
```

语义取舍（与 CLI 的 `awaitJob` 一致）：

- **终态返回** `done|failed|killed|interrupted`
- **`paused` 也返回** —— 不干等：paused 需要调用方决定 `retry` 续跑还是换通道交接
- **超时返回 `timedOut:true` + 当前状态 + `note`**，**绝不谎报完成**
- `timeoutSec` 缺省取该任务 `timeoutMin` 的秒数（再缺省 600s）

- 注册方式（Z13）：官方契约 `ctx.tools.register(defineTool({...}))`（`index.js` 导出
  `inject = ['tools']` 取得服务；`defineTool` 来自随 dsh 出货的 `@deepseek-ai/dsh-tools`，
  动态 import，缺包时降级为不注册 + warn，不影响激活与 UI）。

### 任务落地自动唤醒（ZB-22，默认开）

**现场问题**：派发之后会话**不等待**（这是 fire-and-forget，本身没错），但任务跑完
**没有任何东西叫醒它** —— 用户得自己再发一句话「继续」。DSH 自带的后台任务不是这样：
它落地时会把通知投进发起它的会话，会话自动被拉起。

**现在派发台也一样**（实现与 `@deepseek-ai/dsh-tool-jobs` 同源契约）：

| 环节 | 做法 | 依据 |
|---|---|---|
| 归属 | 工具 `execute(args, exec)` 取 `exec.agent.id`；`dispatch`/`retry` 成功后登记 `jobId → 会话 id` | `dsh-tool-jobs` 的 `exec.agent?.id` 用法 |
| 触发 | `dispatcher.subscribe` 的 `job-updated` 事件里判落地：`done`/`failed`/`killed`/`interrupted`/**`paused`** | 与 `action=wait` 的落地判据同源（paused 也要人来决定） |
| 投递 | `ctx.get('agents').get(会话id)` → `status==='idle' ? agent.followup(msg) : agent.inject(msg)` | `Agent.followup = send(next-turn, wakeup)`；`inject = send(next-step, no-wakeup)` |
| 消息 | `{role:'user', content:[{type:'text',text}], source:{kind:'dispatch', form:'notice', summary}}` | 客户端据此渲染「本轮由通知触发」的可展开卡片；`form:'notice'` 是客户端已认识的形态（换别的字符串会抛 `unreachable context form`） |

**抑制**（避免「自己做的事又叫醒自己」，与 `dsh-tool-jobs` 的 `killedByModel` / `awaited` 同语义）：

- 自己 `action=kill` 掉的 job → 不发通知；
- 自己 `action=wait` **已等到**落地的 job → 不发通知（结果已由那次工具调用返回）；
- `wait` 超时**不**抑制（job 还在跑，落地时仍应唤醒）。

**注册与降级**：`agents` 服务**既不用静态 `inject`、也不用 `ctx.inject` 等它就绪** —— 投递那一刻
才 `ctx.get('agents')` 懒解析（cordis 对未注册/未激活的服务返回 `undefined` 而不抛）。
理由：唤醒是「有就更好」的增强，不能让它的成立与否取决于服务解析时机是否恰好赶上 `apply`。
服务缺席时插件照常激活，只是不唤醒（派发/面板/工具一字不变）。
`ctx.inject(['systemPrompt'], …)` 同理注入「派发台优先」提示段（名 `tool:dispatch`，
顺序 1605，紧随 `tool:jobs` 1600）。

**排障一眼看**：`.data/state/activation.json` 里有
`notifyOnSettle / wakeActive / wakeNote / agentsVisible / systemPromptHint / systemPromptHintActive`。
`wakeActive:false` = 唤醒器没建起来（看 `wakeNote`）；`agentsVisible:false` = apply 那一刻
解析不到 agents 服务（投递时仍会再试，只是要留意 DSH 日志里的「会话已不在」warn）。

**证据**：`test/notify.test.mjs`（17 条：形态/幂等/抑制/预算/卸载/工具层译码）；
`test/wake-integration.test.mjs`（3 条：`apply()` 全链路 —— 派发→落地→唤醒 + systemPrompt 段落 + 信标）。
**真机验收（2026-10-05）**：job `j-muuw3axj-0-f43f`（tag `wake-smoke`）06:49:27Z 派发 → 06:49:41Z 落地
（`done`/exit 0/14.1s）——**派发它的会话当时已结束本轮且未做任何等待**，落地瞬间被自动拉起并收到通知，只收到一次。
同刻信标 `wakeActive:true / agentsVisible:true / systemPromptHintActive:true`。

> ⚠️ **改 host 代码（`index.js` / `notify.mjs` / `wire.host.mjs`）后必须重启 DSH 才生效**：
> HMR 的模块监听根是 profile 目录且默认忽略 `**/node_modules`，本插件在仓库路径 + 经
> `profiles/<p>/node_modules/@local/...` 软链装配 —— 两头都不在监听面内；只改 profile patch
> 会「重新 apply 已缓存的模块」。判据：信标里没出现你这次新增的字段 = 跑的还是旧模块。
> （也别把插件目录塞进 `hmr.root`：卸载清理会 kill 所有 running job。）

## 其他会话如何发现并调用（Z13）

任何 DSH 会话（包括新开的）只要宿主加载了本插件，agent 工具列表里就有 `dispatch`
——工具名固定，模型侧可直接调用，无需额外发现步骤：

1. **开工先查开关**：`dispatch({ action: 'status' })` → 返回
   `switch={enabled, updatedAt, updatedBy, note, source}`；文件缺失/损坏视为开启。
   工具描述首行也带注册时刻的开关快照，但运行期以 `status` 实时返回为准。
2. **开关关闭时先切换**：`dispatch({ action: 'switch', enabled: true, by: '<会话标识>', note: '<原因>' })`
   （原子写真值文件，格式与 CLI `dispatch-switch.mjs` 相同；`enabled` 必填布尔）。
   任何会话都可切换，也可主动关闭（`enabled: false`）。
3. **总开关关闭时派发会被拒**：`dispatch` 与 `retry` 在关闭态直接返回
   `ok:false` + 当前 switch 状态，不创建 job（runner 侧 `zcode-run.mjs` 还有第二道门）。
4. **派发**：`dispatch({ action: 'dispatch', kind: 'prompt', prompt: '…', mode: 'edit' })`，
   其余参数见上节；`list/kill/tail/quota/channels/channel/retry/fallback` 同理，
   全部动作与 UI 悬浮窗共用同一实现（`createActionHandler`）。
5. 工具未出现在列表里 = 注册降级了（宿主缺 `@deepseek-ai/dsh-tools` 或 `ctx.tools` 不可用），
   看 DSH 日志里的 `[dispatch]` warn；UI 悬浮窗与派发核心不受影响。

## 通道切换 / 暂停 / 续跑（Z6）

**用户可见语义（一句话）**：换通道 = 交接重跑（新会话 + 未完成部分交接），同通道 = 真 `--resume` 续跑；
CLI 硬限制：`--resume` + `--model` 必失败（ZCode 机制实测 F2），因此同通道续跑绝不带 `--model`。

- **通道切换器**（面板顶部）：provider 下拉 + model 下拉，数据来自 `listChannels()`（runner
  `--list-providers` 真实输出 + 权益缓存 + 个人 provider 配置，解析不出就空清单 + warning，
  **绝不猜测可用性**）；**不可用通道不再列出**（ZB-33b，用户要求）——主「通道」下拉与
  「自动降级」目标下拉共用同一份过滤；**唯一例外**：当前选中值若已掉线（历史存值指向不可用通道），
  仍单独列在最前并标注「不可用：原因」以便切走（否则 `<select>` 匹配不到 option 会显示首项，
  与真实存值不符 —— 与 ZB-31「失效档位要显式列出」同一个坑）；
  切换后显示「新任务将使用：<通道>/<模型>」。个人通道的模型列表以个人配置
  （`provider_config.json` 的 `personalModelIds`）实际声明为准。
  **ZB-33**：选中**免费额度（Start Plan）**通道时，多一行**额度条**（剩余 / 百分比 / 窗口 /
  剩余时长；来源 = ZCode 客户端日志，零网络请求）——同一份数据也暴露给 agent 工具，见
  「免费额度（Start Plan）通道」一节。
  **ZB-37**：下拉里对**最近撞过额度**的通道追加「（5 小时窗口已满）」——数据来自台账里 runner 写的
  `rateLimited:true`（取最近 5 小时，与 Coding Plan 滚动窗口同尺度），只提示、不改可用性。
  **ZB-38**：`action=dispatch` 若目标是"最近撞过额度"的通道，返回里直接带 `warning` +
  `suggestedProvider`（优先建议可用的免费额度通道），agent 可立刻改派而不用等 429 暂停。
  **ZB-39**：显式指定"已撞顶"通道时**自动改派**到用户选定的可用通道（默认通道 → 降级链 → 免费额度），
  返回 `redirectedFrom` + `warning`；候选全不可用则只提示。⇒ 调用方**通常不需要传 `provider`**。
  **ZB-40（运行中可观测）**：免费额度通道的 runner 每 **10s** 打一行心跳
  （`[zcode-run] progress stage=… elapsed=…s chars=… tools=… lastTool=…`），派发台解析后：
  运行中行显示「**当前：**<阶段> · <最近工具> · N 字 · 工具 N 次 ｜ 最近心跳 Ns」；**>150s 无心跳**
  → 红色「**可能卡住**」徽标；`action=list` 的 job 也带 `progress` / `lastProgressAgoSec` / `stalled`。
  同时修掉一个真机事故：**失败的回合只发 `turn.failed`**，此前 runner 只认 `turn.completed` ⇒ 死等
  60/75 分钟、零输出（外部看像"卡住"）；现在立刻收尾并把上游业务错误写进 `result.json.providerError`。
  另：免费额度权益**只授予特定模型**（`action=quota` 的 `giftQuota.model`）；`--model` 与该授予不一致时
  runner **自动替换为授予模型并大声说明**（否则上游判 `providerCode 1005 exceed quota limit`）。
- **暂停态**：run 非 0 退出且输出命中暂停签名 → `paused` + 原因徽章（`额度耗尽` / `未开通` /
  `需签名` / `配置错误`）。paused **不占锁、不占并发、不自动重试**，队列继续跑其他任务；
  未命中签名保持 `failed`（Z1 语义不变），仅记 `pauseReason: unknown` 作信息字段。
- **两个续跑按钮**（paused 行内）：
  - 「同通道续跑」：有 sessionId 时可用 → 真 `--resume <sessionId>` 续跑（绝不带 `--model`）；
  - 「换通道重跑」：选目标通道 → **交接重跑**（新会话），确认提示明示语义后执行；交接提示词
    含五要素：① 原任务原文 ② 上次中断点（pauseReason + 最后输出）③ 新通道说明（交接重跑 ≠
    原会话续跑）④ 先核对现状、只做剩余、按原要求交付 ⑤ 不回滚、不重复交付。
  - 「关闭」（Z11）：把该 paused 行从列表移除（wire 层 `dismiss` 动作，落盘
    `state/dismissed.json`；UI 先试 `kill`、core 对 paused 是空操作故退回 `dismiss`）。
  - 交接链路全程簿记：新 job 记 `parentJobId / attempts[] / hopCount`，旧 job 标 `handedOffTo`
    （同通道续跑标 `resumedBy`）；从 `list/get` 与 `state/jobs.json` 均可读回。
- **进程行展开**（Z11）：点击行头（非按钮区）展开该 job 的派发要素——kind、prompt/task/target
  原文（截 1200 字符）、provider/model、mode、cwd、timeoutMin、createdAt、sessionId、
  pauseReason（中文标签）与「输出」tail 子块；多进程靠它区分「谁在跑什么」。
- **自动降级**（默认关，ZB-30 起是**开关 + 单目标**）：面板「通道」分区里一个带指示灯的开关
  （与标题栏派发总开关同一套视觉语言：点击开/关、`aria-pressed` 反映状态）；**打开后**才显示
  通道 / 模型 / 思考强度三个下拉，**关闭时不显示**。
  **三个下拉与上面「通道」分区完全一致的选项逻辑**（ZB-30b，用户要求）：同样的通道清单、
  同样的模型首项 `（通道默认模型）`（值 `''`）、同样的档位首项 `Agent决定（按任务判断）`
  （值 `'agent'`）、同样的档位并集与中文标签、同样的禁用判据。
  语义：仅当暂停原因属于 {额度耗尽 / 未开通 / 需签名} 时，按交接语义自动跳到选定目标；
  模型留空 ⇒ 该 provider 的默认模型；档位 `agent` ⇒ runner 按 ZCode 默认规则解析（模型声明
  档位的最后一档），与上面「Agent决定」在未显式指定档位时走同一条规则。⚠ 开启即授权
  **自动消耗下游通道额度**。
  - core 侧状态是**有序目标列表** `[{provider, model, reasoningLevel}]`（`<workRoot>/state/fallback.json`，
    `version: 2`；旧 `version: 1` 的 `chain` 自动迁移，不丢配置）；面板开关只设一个目标
    （`setFallbackTarget`），CLI/工具仍可设多目标（`setFallbackChain`）。
    `getFallbackChain()` 返回 `{enabled, chain（旧形状 id 列表）, targets, target（首项）}` —— 旧读者照旧可读。
  - `model` / `reasoningLevel` 的 **`null` = 沿用原任务**（core/CLI 兼容语义，旧调用方照旧）；
    面板**不再产生 `null`** —— 它始终写 `''`（通道默认模型）/ `'agent'`（Agent决定），
    与上面「通道」分区的默认值逐字一致。
- CLI 对照：`zcd channels [--json]` / `zcd channel set <provider> [--model]` /
  `zcd retry <jobId> [--provider --model]` /
  `zcd fallback [list|set a,b,c|set <id> --model <m> --thinking <lv>|off]`；
  agent 工具 `dispatch` 同名 action 一一对应。

## paused 与超时：触发条件、终态与 job 字段（ZB-28）

**用户可见语义（一句话）**：paused 只有一种进入方式（非 0 退出 + 输出命中暂停签名）；
超时有两条路径、两种终态（runner 超时 → failed，看门狗强杀 → killed），全部落到 job 字段可查。

### paused 的全部触发条件

| 条件 | 结果 |
|---|---|
| run 非 0 退出（**且非 kill 请求**），输出命中暂停签名之一 | **`paused`** + `pauseReason`（下表按优先级，防宽词抢定性） |
| 非 0 退出，有输出但未命中任何签名 | `failed`（Z1 语义不变），仅记 `pauseReason: 'unknown'` 作信息字段 |
| 非 0 退出，完全无输出（如 spawn 失败） | `failed` |
| 自动降级目标耗尽 / 某一跳失败 | 停在 `paused`（附 parseWarning） |

暂停签名与优先级（`core/dispatch-core.mjs` 的 `PAUSE_SIGNATURES`，顺序即优先级）：

| pauseReason | 输出关键词（不区分大小写） |
|---|---|
| `plan-not-entitled` | `not_entitled` / `plan-not-entitled` |
| `provider-signing` | `ClientRequestSigningV4Error` |
| `config-error` | `Select a model before continuing` / `CONFIGURATION_ERROR` |
| `quota-exhausted` | `quota_exceeded` / `coding_plan_required` / `rate_limited` / `insufficient` / `429` / `balance` |

paused **不占锁、不占并发、不自动重试**，队列继续跑其他任务；需要人（或调用方）决定
`retry` 同通道续跑还是换通道交接。

### timeoutMin 的边界

- **无硬上限**：工具与 core 只校验 `> 0`（`timeoutMin: 99999` 合法）；
- **runner 生效下限 1 分钟**：`zcode-run.mjs` 内部 `max(1, timeoutMin)`；
- **看门狗兜底**：dispatcher 在 `timeoutMin × 60 + 宽限`（`timeoutGraceSec`，默认 120s）后仍未退出则强杀。

### 超时终态（两条路径，别混淆）

| 路径 | 终态 | job 字段 |
|---|---|---|
| **runner 自身超时**（`--timeout-min` 到点，done 行带 `(超时)`、exit=124） | **`failed`** | `timedOut=true`、`timedOutBy='runner'`、`exitCode=124` |
| **dispatcher 看门狗强杀**（超时 + 宽限后仍未退出） | **`killed`** | `timedOut=true`、`timedOutBy='watchdog'`、`watchdogSec`=开火秒数、parseWarning 留痕 |
| （对照）dispatcher 重启/属主进程消失的残留清理 | `interrupted` | 与超时**无关**，`interruptReason` 记原因 |

### 相关 job 字段一览（ZB-28 起齐备）

`pauseReason` / `pauseDetail` / `pausedAt`（进入 paused 的时刻，非 paused 恒 null）/
`timedOut` / `timedOutBy`（`'runner'` | `'watchdog'`）/ `watchdogSec` / `memoryBanRunner`（见「锁与并发语义」）。

证据：`test/pause-timeout.test.mjs`（5 条：`(超时)` 标记解析、看门狗 → killed、runner 超时 → failed、
paused/pausedAt 与 unknown 分支、timeoutMin 校验）。

## resume 与 retry 怎么选（ZB-28）

**一句话判据：job 还在派发台里 → `retry`（簿记链完整）；手里只有裸 sessionId → `dispatch` + `resume`。**

| 场景 | 用法 | 发生什么 |
|---|---|---|
| 上一次 run 是**派发台的 job**（paused/终态） | `action=retry, id` | 内部自动判定：同通道且有 sessionId → 真 `--resume` 续跑（绝不带 `--model`，F2）；换通道或无 sessionId → 交接重跑（新会话 + 五要素交接提示词）。`parentJobId/attempts/hopCount/handedOffTo/resumedBy` 簿记全自动 |
| 手里只有**裸 sessionId**（job 已不在派发台，或 run 来自派发台之外） | `action=dispatch, resume: <sessionId>`（+ 同通道） | 新建 job 续接该会话；core 不会注入通道默认 model（F2：`--resume` 带 `--model` 必失败） |
| 想在同一会话里发**新指令** | `dispatch(resume)` 带新 prompt（面板「续接」按钮同款） | 同上 |

## 思考强度（thinking / reasoningLevel，ZB-29）

**用户可见语义（一句话）**：派发时可指定 ZCode 的思考强度（Thought Level）；默认档
**「Agent决定」**= 由派发方 Agent 按任务自行判断并改传具体档位；传了具体档位则严格执行。

| 取值 | 行为 |
|---|---|
| `agent`（**默认**，Agent决定） | 由调用方 Agent 按任务判断并**改传具体档位**（判断准则已写进工具说明：查询/机械 ⇒ 低档；复杂推理/架构 ⇒ 高档）。未改传时 runner 按 **ZCode 自身默认规则**解析——该模型声明档位的**最后一档**（GLM-5.3 系 ⇒ `max`、deepseek 系 ⇒ `max`；= headless 未显式选择时 `QKe`/`v3i` 的 `values.at(-1)` registry-fallback 行为）——并**显式注入** ⇒ 进程上显示实际生效档位，而非「Agent决定」字样。模型未声明档位 ⇒ 不注入 + 警告 |
| 具体档位（如 `high`） | 严格生效：runner 写入临时 provider 配置的 `defaultModelSelection.options.reasoningLevel`（ZCode headless 启动读取它作为**会话初始模型选择**）；面板/人工派发同理 |

规则与边界：

- **档位集合随模型声明不同，不写死枚举**：runner 探测 builtin 配置 `modelRules`（按序 overlay），
  经 `--list-providers` 输出 `[zcode-run] reasoning-levels <model>=<a,b>`，core 解析为
  `channels[].thinkingLevels` 供面板下拉与 Agent 查询。当前实测：**GLM-5.3 / GLM-5.3-Flash =
  `low|high|max`**；**deepseek-flash / deepseek-v4 系 = `disabled|low|high|max`**。
  - ⚠️ **匹配式必须与 ZCode 逐字同式**（ZB-31 修的现场 bug）：ZCode 用
    `new RegExp('^(?:'+modelMatch+')$','i')`（**锚定 + 忽略大小写**）。漏 `i` 会让小写规则
    （如 `.*glm-5\.3(?:-flash)?(?:…)?` → `low,high,max`）**永不命中**大写模型 id `GLM-5.3`，
    于是只剩更早的宽规则 `.*glm-5(?:…)?` → `disabled,enabled` —— 面板就少了低/高/最高三档。
  - ⚠️ **枚举面必须含个人通道模型**：`--list-providers` 的模型集 = 桌面端 `config.json` 的
    `provider[*].models` **∪ 个人通道 `provider_config.json` 的 `personalModelIds`/`modelOrder`**。
    `deepseek-flash` 只出现在后者；漏了 ⇒ 该通道一条档位行都没有 ⇒ 面板无档位选项。
- **fail-fast 不静默**：runner 校验（模型声明了档位集合而请求值不在其中 ⇒ 拒绝派发并列出可用值）；
  ZCode 会话创建也会校验（defaultModelSelection 非法 ⇒ 会话创建失败）。
- **仅新建会话生效**：`--resume` 沿用原会话档位（ZCode 语义；core 对 resume 不透传，runner 警告）。
- **可观测**：job 带 `reasoningLevel`（请求档：agent/具体档）与 `reasoningLevelApplied`/`reasoningTarget`
  （实际生效档 + 注入目标）；**进程行模型徽标后显示实际生效档位**（Agent决定档解析出的具体档），
  详情行同步；无法确定（旧 runner / --resume / 模型未声明）时隐藏，不伪造。
- **失效档位显式可见（ZB-31）**：存值不在当前模型声明的档位集里时（如模型档位表更新后），
  下拉会把它**显式列为一项并标注「已失效」**+ tooltip 说明 —— 否则 `<select>` 找不到匹配 option
  时会静默显示首项「Agent决定」，显示与事实不符（而派发会被 runner 拒绝）。
- **通道默认思考强度（ZB-29d）**：面板「通道」分区可设（`action=channel` 带 thinking：
  `Agent决定` 或具体档位）——**这就是给派发 Agent 的规定**：设具体档位时，未显式传 thinking 的
  派发一律按它执行；设 `Agent决定` 时派发 Agent 按任务自行改传具体档位。回退在 core `dispatch()`
  统一实现 ⇒ 工具/CLI/面板三条入口一致。面板**手动派发表单已移除**（ZB-29c：无需手动派发，
  有需要让 Agent 代劳）。
- `--list-providers` 探测各模型档位集（`reasoning-levels` 行）；无档位数据（旧 runner）时
  通道下拉只剩 Agent决定 —— 不猜。

证据：`test/thinking-level.test.mjs`（7 项：解析/通道透出/core 透传与字段（含**通道默认回退与
覆盖**）/wire 映射/validateSpec/交接沿用/runner 注入 hermetic 干跑 + fail-fast + resume 跳过）。

## 枚举与 channels 清单，以谁为准（ZB-28）

**一句话：通道可用性与真实 id，一律以 `action=channels` 的实时清单为唯一权威。**

- 工具 schema 里 `model`/`provider` 的 **enum 只是常用别名提示**（GLM-5.3 / GLM-5.3-Flash；plan / personal），
  且可能被宿主按白名单强制 —— 它**不是**全量通道表；
- `channels` 清单来自 runner `--list-providers` 真实输出 + 权益缓存 + 个人 provider 配置
  （解析不出就空清单 + warnings，绝不猜测）；
- 要派发到**枚举之外**的通道（如 `builtin:…` 真实 id）：用 `action=channel`（provider 接受清单里任意 id）
  设为默认通道，再**不带** provider/model 派发（未显式指定时自动采用默认通道）——这条路径不受枚举限制；
- per-dispatch 显式 `provider`/`model` 仅用于枚举内的常用值；两者不一致时，**以 channels 为准**。

## 真数据 vs demo 判据（Z8 接线后）

面板标题栏徽标（`connLabel`）直接标明当前数据来源，逐级降级、绝不白屏：

| 徽标 | conn 值 | 数据来源 | 含义 |
| --- | --- | --- | --- |
| **已连接** | `live` | `ctx.remote.dispatch` 远端面 | **真数据**：真 ZCode 子进程 + 真用量台账（宿主 face 已注册） |
| 外部数据 | `ext` | `window.__dispatchDemo` | 宿主/creator 注入的外部数据源（测试用） |
| **未连接** | `offline` | — | 诚实空态（Z11）：远端与外部源都没有——无假行，进程区明示「真数据需完成 Remote 接线」 |
| **演示数据** | `demo` | 内置演示引擎 | 纯前端假数据（默认**不启用**，仅 `window.__dispatchDemo === 'builtin'` 时，可交互） |
| 连接中 | `connecting` | — | 尚未收到任何数据包（首帧渲染前） |

降级链：`apply` 捕获 ctx → `resolveRemote()` 探测 `ctx.remote.dispatch`（有 `snapshot()` 即可用）
→ 命中走 1s 轮询 + `$on('dispatch/changed')` 抢答；未命中（远端缺席 / `$mount` 失败 /
无 ctx）→ 外部源 → 诚实空态（内置 demo 引擎仅 `'builtin'` 显式开启）。**看到「未连接」即表示
远端面未接通**，排查顺序：宿主侧 `wire.host.mjs` 的 face 注册（日志 `attachHostWire`）→
客户端 `$mount` 贡献项 → 探测判据。

接线两侧（Z8 落地，原「wire TODO 清单」已清偿）：
- 宿主侧：`wire.host.mjs` 的 `attachHostWire()` 把 face 经 `ctx.provide('dispatch', face)`
  注册为 cordis 服务，`index.js` 用 `ctx.effect` 包裹 dispose 清理；导出 `TYPERT` 清单经
  `package.json` 的 `exports["./typert"]` 由 typert-loader 自动注册（loader 形状校验已本地复核）。
- 客户端侧：`client.js` 模块 `inject` 声明 `remote` 与 `remote.dispatch`，`apply` 里
  `ctx.remote.$mount({package, descriptors})` 自挂子服务（第三方本地包不被构建期内联进
  api-remotes，须自挂），内嵌同源传输层（`wire.client.mjs` 的镜像）调用远端面。

## 派发总开关（Z12）

**用户可见语义（一句话）**：一个跨会话的「能否把任务派发给 ZCode」总开关，面板、agent 工具、CLI 三处看到的都是同一个文件。

- **真值文件**：`<宿主项目>/collab/dispatch.switch.json`（`{enabled, updatedAt, updatedBy, note, contract}`；契约全文见宿主项目 `collab/PROTOCOL.md` §7）。路径由 `config.switchPath` 给出（机器专有，见上文「config 说明」）。
  语义：`enabled:false` = **拒绝对 ZCode 的任何派发**；文件缺失/损坏 = 视为开启（不误锁）。
- **查询/切换 CLI**：`node "<本仓库>/collab-kit/dispatch-switch.mjs" --project "<宿主项目>" status|on|off [--by …] [--note "…"]`（status 退出码 0=开、2=关）。
- **遵守的三个入口**（缺一不可）：① runner `zcode-run.mjs`（关闭时 exit 3，不启动进程）② 本插件 Host 动作层（`dispatch`/`retry` 关闭时返回 `{ok:false, error, switch}`，不创建 job、不 spawn）③ `<本仓库>/tools/bridge.mjs`（关闭时 exit 3，拒绝投放）。
- **插件侧读写只此一处**：`wire.host.mjs` 的 `readSwitch()`（mtime 缓存、永不抛）/ `writeSwitch()`（tmp+rename 原子写，格式与 CLI 逐字段一致）。UI 与工具都经 `createActionHandler` 的 `switch` 动作写，杜绝第二个写文件方。
- **config**：`switchPath`（string，默认空 = 未接入宿主项目；由 profile patch 指定；测试可指向临时文件密封）。字段清单见上文「config 说明」表（代码里 DEFAULTS / fallbackConfig / schema 三处同源）。
- **面板（UI）**：标题栏徽标「派发：开 / 关」——`conn='live'` 时可点击切换（成功后 1s 轮询带回新快照；真实点击效果需刷新页面后确认）；远端不可用（ext/demo/offline/连接中）时显示为**只读**，tooltip 提示「未连接宿主：请在终端执行 dispatch-switch.mjs 切换」，状态未知时如实显示「派发：未知」（浏览器读不到宿主文件，不谎报）。关闭态下派发按钮禁用并显示原因（`switchOffBlocked`）。
- **agent 工具**：`dispatch` 描述首行动态携带当前状态（注册时生成）；`action=status` 查实时状态、`action=switch`（`enabled` 必填，`by`/`note` 可选）切换、`action=dispatch` 派发（关闭时被拒）。其他会话开工先 `status` 一次即知。
- **重载提示**：本节属宿主半边（`wire.host.mjs`/`index.js`）改动——完全退出 DSH 再启动才生效（pitfalls：cordis `_reload` 不重新 import）；客户端半边（`client.js`）刷新页面即可。

## 验证步骤（creator 会话，安装后）

1. `cordis_inspect_query`：确认新行已挂（`Config.listConfigs` 过滤本包名 → 查 `entry`；插槽注册）。
2. 会话标题行出现「DSH 派发台」入口（排在「N 个子智能体」之后）：**悬浮 150ms 展开**面板、**离开 120ms 收起**，Esc / 点外部也可关闭；有任务时入口显示状态点、进行中为脉动（同官方入口做法）；四个分区
   （通道 / 用量卡片 / 进程列表 / 单写者状态）可折叠（通道/单写者默认收起，ZB-29c 起**无手动派发表单**——派发一律由 Agent 经工具完成）；浅色/深色主题各看一眼。
3. 双调用方一致性：agent 跑工具 `dispatch` `action: list`，与 UI 列表一致；
   `action: quota` 的三窗口数字与 `node bin/dispatch.mjs quota` 一致。
4. 端到端：`action: dispatch`（`kind: prompt`、`model: GLM-5.3-Flash`、内容 `只回答 OK`）→
   UI 出现 queued→running→done，5h 窗口 run 数 +1。
5. 控制台不得有 `slot entry crashed in '<slot>'`；跑完恢复动过的任何设置/状态。
6. 安装前可先跑本地静态验收（无需安装）：
   `node tools/verify-plugin.mjs`（21 项：manifest / 静态纪律 / Config 是 Standard Schema / 客户端模块加载与槽位注册 / Host e2e）。
   > `test/z2-verify.mjs` 是**历史遗留脚本、当前在 HEAD 上就有红灯**（断言过时 + React 桩缺 Component），
   > 已不在门禁内，仅在排查历史问题时参考。

### 可复跑自测清单

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `node test/core.test.mjs` | 12 | 派发核心：调度/锁/状态/持久化/淘汰回收 |
| `node test/channel-retry.test.mjs` | 9 | 通道切换、续跑（含 `--resume` 不得带 `--model` 的 F2 回归） |
| `node test/quota-rpc.test.mjs` | 16 | 额度 RPC 与聚合 |
| `node test/tail-scroll.test.mjs` | 13 | 输出框滚动决策（ZB-05：不闪烁、不弹回、底部跟随） |
| `node test/file-lock.test.mjs` | 9 | 细粒度文件锁（ZB-08：声明 write 才生效、未声明回退粗粒度、路径归一化、防死锁、无泄漏） |
| `node test/wait-action.test.mjs` | 6 | `wait` 动作（ZB-08：等终态 / paused 也返回 / 超时不谎报 / 参数校验） |
| `node test/section-order.test.mjs` | 9 | 面板分区渲染顺序（ZB-09：单写者/文件锁紧跟进程、用量置末） |
| `node test/elapsed-format.test.mjs` | 15 | 耗时展示格式（ZB-13：恒定三段 XX时XX分XX秒；数据层仍为秒数） |
| `node test/ctx-format.test.mjs` | 23 | 上下文占用展示（ZB-14：`180.9k / 200k`，截断非四舍五入） |
| `node test/lock-model.test.mjs` | 8 | 锁模型（ZB-16：删除 memory 锁；不同文件集可并发；同文件排队；跨层级互斥） |
| `node test/lock-ui.test.mjs` | 26 | 派发区锁控件与中文锁名（ZB-16/17：仓库文件锁开关 + 要写的文件 + 分区名「仓库文件锁」） |
| `node test/lock-priority.test.mjs` | 4 | 调度优先级（ZB-17：文件锁任务优先放行；同类内 FIFO；整仓库锁执行时文件锁等待） |
| `node test/lock-badge.test.mjs` | 34 | 进程行锁徽标（ZB-18：区分整仓库锁 / 文件锁 N / 不取锁 / 旧版记录）+ **全仓防复发扫描**（ZB-19） |
| `node test/lock-queue-visibility.test.mjs` | 6 | 锁排队可观测（ZB-28：lockWait 的 blockers 指认持有者、ahead 同类计数、estWaitSec 上界/不猜、跨层级 cross 条目、wire 透传） |
| `node test/pause-timeout.test.mjs` | 5 | paused 与超时（ZB-28：`(超时)` 标记 → failed+timedOutBy=runner、看门狗 → killed、pausedAt 落字段、unknown 分支、timeoutMin 校验） |
| `node test/thinking-level.test.mjs` | 7 | 思考强度（ZB-29：`thinking` 参数与 'agent'=Agent决定不透传、档位透传 `--reasoning-level`、channels[].thinkingLevels、validateSpec、交接沿用、runner 注入 hermetic 干跑 + fail-fast + resume 跳过） |
| `node test/thinking-levels-coverage.test.mjs` | 6 | 思考强度**探测漏档**（ZB-31：个人通道模型纳入 `--list-providers`、匹配式与 ZCode 逐字同式（`^(?:)$`+i）、plan/personal 都带 thinkingLevels、真实内置配置现场值、失效档位显式列出、fail-fast 报错列出修正后取值） |
| `node test/fallback-target.test.mjs` | 6 | 自动降级目标（ZB-30：`setFallbackTarget` 单目标/关闭/落盘 v2 与 v1 迁移、跳转带目标 model+档位、未指定则沿用原任务、wire 对象/数组/null 三形状、face 对象走单目标、面板源码形态、文案四处齐备） |
| `node test/fallback-ui.test.mjs` | 16 | 自动降级**真渲染**（ZB-30：关闭态只有开关且无目标下拉、开启后出现通道/模型/思考强度三下拉、档位中文标签且 value 仍原始、目标里无「Agent决定」、点开关 → wire 收到 `chain:null`、关闭后下拉消失） |
| `node test/memory-ban.test.mjs` | 6 | 记忆禁令注入（ZB-20/28：prompt/target 拼进内容；**task 经 runner `--memory-ban` 旗标**，memoryBanRunner=runner 确认位） |
| `node test/panel-style.test.mjs` | 24 | 样式注入与作用域（ZB-21/27：样式只注入 head 一次、重渲染不触碰；border-box 限定 .dsp-menu 子树） |
| `node test/notify.test.mjs` | 21 | 落地自动唤醒（ZB-22：空闲 followup / 忙碌 inject、幂等、自己 kill/wait 的抑制、唤醒预算、卸载退订、工具层译码） |
| `node test/wake-integration.test.mjs` | 3 | 落地唤醒**全链路接线**（ZB-22：`apply()` → inject agents/systemPrompt → 派发 → 落地 → 唤醒 + 信标 `wakeActive`；关配置 / 无服务时降级） |
| `node test/header-entry.test.mjs` | 105 | 会话标题行入口 + 悬浮弹窗（ZB-27：槽位/order、**入口样式与同排一致**、系统菜单令牌、点外部/Esc 关闭、入口不建 wire、真点击开合；ZB-28b：共享 wire 配对释放契约；**ZB-36：弹窗高度上限 ×2 = 960px 且只挂在面板层（真渲染断言）**） |
| `node test/shared-wire-liveness.test.mjs` | 18 | **共享 wire 存活哨兵**（ZB-28b：功能重放「面板开→关不得处决入口的 live wire」+ 配对释放/REMOTE_READY 补投/kind 标签源码不变量——修「状态灯冻结、切换会话才显示」） |
| `node test/single-source.test.mjs` | 31 | **单源哨兵**（ZB-25：动作清单 ≡ switch、状态集合引用同一性、三表方法集相等、协议常量逐字相等、STRINGS ↔ locale 逐值） |
| `node test/hardening.test.mjs` | 5 | **核对硬化**（ZB-26：B1 锁 realpath / B2 ownerPid 不改写活 job / B3 多进程不丢更新 / B4 tail 不读越界 / A2 非法 config 只 warn 不阻断激活） |
| `node test/z2-verify.mjs` | — | 端到端验收（越界检查需 `Z2_HOST_REPO`，未设则 SKIP 并如实标注） |

> `file-lock` 与 `wait-action` 用 `node:test` 语义（`node --test test/xxx.test.mjs`），
> 退出码 0 = 全过；其余为自实现的极简断言框架。

## 免费额度（Start Plan）通道（ZB-33）

派发台现在支持 **ZCode Start Plan（活动赠送额度，如 Weekend Build 的免费 GLM-5.3-Flash）**。

**为什么需要专门一条通道**：Start Plan 的端点 `https://zcode.z.ai/api/v1/zcode-plan/anthropic`
要求**逐请求的官方客户端证明** —— 既有的 plan 路径（把 Key 塞进临时 provider 配置走直连 HTTP）
在它上面会被判 `405 / code 3012`；而且 `~/.zcode/v2/config.json` 里 `builtin:bigmodel-start-plan`
通常是 `enabled:false`，`--provider plan` 永远挑到**付费** coding-plan。唯一可行路线是
**托管官方 agent 本体**（`zcode.cjs app-server`），由它自己签发 —— 也就是姊妹项目
[`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode) 那条 `zcode-appserver`
通道的同一套协议。

**怎么用**（通道 id 可直接当 `--provider`）：

```bash
# 面板：通道下拉选「免费额度（Start Plan）」；或命令行：
zcd dispatch --kind prompt --prompt "只回复 OK" --provider account:bigmodel-start-plan
zcd dispatch --kind task --task <任务包> --provider start-plan --mode yolo
```

- 实现：`collab-kit/appserver-gift.mjs`（回合驱动：账户注入 + 鉴权递送 + 事件收集 + usage 折算）
  ／ `collab-kit/appserver-gift-job.mjs`（产物 / `[zcode-run]` 输出行 / 台账，与 print 模式同形）。
- **解析、暂停分类、面板、重试/交接、降级链、台账全部复用**，无需改动；
  台账 `billing` 记为 **`zcode-plan-gift`**（与付费套餐分账）。
- 需要新增配置：**无**（`runnerPath` 指向的 runner 已含该 transport）。
- **选型：什么时候用派发台、什么时候用 provider 通道** —— 本派发台的语义 = **独立 ZCode 进程 + 它自己的工具 + 独立会话/额度**，
  所以「工具由 ZCode 自己执行」在这里是**设计而非缺陷**；而姊妹项目
  [`dsh-connect-zcode`](https://github.com/Shuffle-1992/dsh-connect-zcode) 的 `zcode-appserver` 是**模型对话通道**，
  它那条免费额度通道上 **DSH 工具层不参与**（浏览器面板 / Agent Teams / `ask_user_question` / TODO 等都没有，
  见其 README 的「免费额度通道目前缺失的功能速查」）。
  ⇒ **要让 agent 自主用工具干活 ⇒ 用派发台（本文这条通道）；要 DSH 自己的工具链做交互式对话 ⇒ 用 provider 通道。**

### 工具执行能力：与付费套餐派发**实测等同**（ZB-34）

派发出去的 agent 就是**同一个 `zcode.cjs`**（同一套原生工具 + MCP + 子代理），差别只在"谁托管进程"
（本通道注入账户托管 app-server；付费套餐是 print 模式一次一进程）。真机实测（2026-10-11，全部经
`dispatch` 派发 + 读落盘产物交叉验证）：

| 能力 | 结果 | 证据 |
|---|---|---|
| Write / Edit 工具 | ✅（`yolo` 与 `edit` 都通过） | 文件字节级核对，内容精确匹配 |
| Bash 工具 | ✅ | `echo … > zb34-bash-proof.txt` 落盘；`toolNames=["Bash"]` |
| MCP 本地服务 | ✅ | `mcp__node_repl__js` 执行 `1+1` 返回 `=> 2` |
| MCP 远程/内置服务 | ✅ | `mcp__web_reader__webReader` 抓 example.com 返回 `Example Domain` |
| 无人值守（权限） | ✅ 默认放行（仅 `plan` 模式拒绝） | 见下「已修缺陷」 |

> **已修缺陷（ZB-34）**：权限应答原写成「**仅 yolo 放行**」，导致 `--mode edit`（runner 默认模式）下
> agent 的 Write 被拒（回复「Write 工具调用被拒绝了，文件未创建」）。派发是**无人值守**语义（print 模式
> 无人可批、桥接用 `allow-all`），现已改为**默认放行**，仅 `plan` 模式拒绝。同轮把工具事件匹配从猜的三个
> 名字改为 `tool.*` 前缀，并在 `result.json` 里带出 `toolNames` / `eventTypes`（此前 `toolEventCount` 恒为 0）。
> 完整矩阵与复跑方法见 [`tasks/ZB-34-gift-tool-parity.md`](../tasks/ZB-34-gift-tool-parity.md)。

**仍不等同的（工具层以外，如实列出）**：`--resume` 续跑 / `--target` 目标自续跑 / `--memory-bench`
**不支持**（都是 print 模式 CLI 的能力，本通道每次新建会话）；`--attach` 被忽略（但 agent 有自己的 Read
工具，可直接读工作目录 —— 实测文件读写正常）。

**模式怎么选（`--mode`，ZB-35 实测）**：`yolo` = **CLI 内部直接放行**，不产生审批请求；`edit`/`build` =
对需审批的工具（`Read` 不需要，`Write`/`Edit` 需要）发 `interaction/requestPermission`，
**托管派发由我们代批**（默认放行，`result.json.permissionRequests` 可见，事件流里有
`permission.requested` / `permission.resolved`）；`plan` = 只规划不执行（权限请求一律拒绝）。
三者在"能不能干活"上：`yolo` 与 `edit` **实测等价**（都落盘成功），`plan` 不执行。
**无人值守派发建议显式 `--mode yolo`**（少一层往返、少一个失败点），或 `edit`/`build`（保留可审计的审批事件）。

### 额度条与「Agent 知道自己还有多少额度」（ZB-33）

- **面板**：选中免费额度通道时，「通道」分区多一行**额度条**——
  `剩余 279.9M / 300.0M（93%）· 窗口 10-10 20:12 → 10-12 09:00 · 剩 30.3 小时`，
  条形按剩余百分比填充（≤15% 转警示色，主题令牌取值，无字面色值）。
- **agent 工具侧（派发决策用）**：同一份数据出现在
  · `action=channels` → `channels[].quota` + `channels[].quotaText`（仅 start-plan 通道）与顶层 `giftQuotaText`；
  · `action=quota` → `giftQuota`（含 `state`/`totalUnits`/`remainingUnits`/`startsAt`/`endsAt`/`observedAt`）。
  工具描述里还写了一条**派发前额度决策指引**：active 且充足 ⇒ 正常派；剩余少或临近窗口结束 ⇒ 拆小任务；
  pending/expired/ok:false ⇒ 换通道。**派发前后都可查**，据此决定是否再派下一单。
- **数据来源与新鲜度**：只读 ZCode 桌面端自己写在 `~/.zcode/v2/logs/<date>.log` 里的
  `billing/balance 请求完成` 响应（**零网络请求、零额度消耗**，避开上游对直连 plan 端点的风控）。
  因此新鲜度取决于桌面端是否在运行/轮询 —— 状态里带 `observedAt`（日志行时刻）供判断，
  旧到一定程度面板会照实显示旧值而不是猜。

**限制（照实说）**

1. **不支持** `--resume` / `--target` / `--memory-bench`（都是 print 模式 CLI 的能力；该后端每次新建
   CLI 会话）；`--attach` 会被忽略（agent 有自己的文件工具，可直接读工作目录）。
2. 官方 MCP 服务器在托管进程里**连不上**（拿不到桌面端签名头），agent 可能在其上打转 ——
   靠既有 `timeoutMin` + 暂停分类兜底。
3. 免费额度是**时间窗口**型：窗口外派发会以 `paused / quota-exhausted` 停下（不静默改烧付费额度）；
   窗口恢复后 `retry` 续跑。
4. 并发：一个 job 一个 app-server 进程；建议先由 `maxConcurrent` 限 1–3。
5. **`--cwd` / `runnerCwd` 必须落在宿主项目内**（与 `ledgerPath` 同项目）：runner 的台账固定在
   `<PROJECT>/collab/logs/dispatch-runs.jsonl`，两者不同项目时 job 能跑通但用量聚合看不到这一单
   （面板显示 `billing=-`）。
6. 思考档**必填**：通道的 `session/setModel` 会硬校验；面板传的 `agent`（=「Agent决定」）会被
   翻译为"未指定"，自动回落到本机 `config.json` 里该模型的官方 `defaultVariant`（GLM-5.3 系 = `max`）。

**验收（2026-10-11 真机，全部通过）**：提示词任务 `done exit=0`；真实任务包（5 次模型调用 / 130s）
`done exit=0` 且 agent 在工作目录写出交付文件；`zcd channels` 列出该通道且 `enabled=true`；
`parseRunnerLine` 10 行全识别；暂停三签名命中；台账 `billing=zcode-plan-gift` / `usageBasis=cli-single`；
本仓库测试套件 **27/27**。完整记录见 [`tasks/ZB-33-gift-channel-exploration.md`](../tasks/ZB-33-gift-channel-exploration.md)。

## 已知限制

1. **套餐（Coding Plan）剩余额度未接入**：用量区拆成两段展示——「本地用量（可核对）」= 台账聚合（5h 滚动 /
   本周 / 今日）+ 引擎本周已用（`core/quota.mjs` 的 `fetchPlanQuota()` 经 ZCode app-server
   `usage/stats`，Z3 实装；语义是引擎本地库「已用」合计）；「套餐剩余额度：未接入」明示
   limit/remaining/resetAt 不在 CLI RPC 面（方法表全枚举 + 候选方法实测 -32601；桌面端走签名
   HTTP，裸 Key/OAuth 均 401），以 ZCode 客户端显示为准。三类证据见 `tasks/Z3-delivery.md` §四。
   引擎本地用量**不得**呈现为「套餐已用」。
   **例外（ZB-33）**：**免费额度（Start Plan）的剩余量已接入** —— 走 `core/gift-quota.mjs`
   读 ZCode 客户端日志里的 `billing/balance` 响应（零网络请求），面板额度条 / `action=channels`
   / `action=quota` 三处同源；新鲜度取决于桌面端轮询，状态带 `observedAt` 如实标注。
   两者是**不同额度体系**，不要混为一谈。
2. **标准模式不可安装**：无 `plugin_manager`，也不写 `$DSH_HOME`（`C:\Users\Administrator\.dsh`）。
3. **远端面接通但未见真数据的场景**：Z8 已全接线（宿主 face 注册 + 客户端 `$mount` 自挂），
   但若宿主侧 `ctx.provide` 缺席或 typert-loader 未注册本包 TYPERT，客户端会安静降级到
   demo（徽标「演示数据」）；安装后以徽标为准判断（见「真数据 vs demo 判据」一节）。
   宿主→客户端的 `$on` 推送依赖装配级事件源，未接通时以 1s 轮询兜底（功能不受影响，仅刷新及时性）。
5. **Config 形态**：`index.js` 的 `Config` 是 Standard Schema v1——cordis 的 `resolveConfig`
   只认 `Config['~standard'].validate`，裸 JSON Schema 会在激活时报
   `Cannot read properties of undefined (reading 'validate')`（Z10-01 已修）。首选宿主随包
   出货的 schemastery（官方插件同款），解析不到时自动降级为手写 Standard Schema
   （`fallbackConfig()`），激活永不因 schema 崩；字段与默认值不变。
6. **与任务包给定 manifest 的偏离**：`package.json` 的 `files` 数组在任务包给定内容之上补了
   `wire.host.mjs` / `wire.client.mjs` 两项——否则 install_bundle 按 `files` 打包时
   `index.js` 的相对 import 会缺文件。其余字段与任务包逐字一致。
7. 界面文案在 `client.js` 内嵌 `STRINGS` 与 `locale/*.json` 的 `ui` 段**双份同源**（浏览器模块表
   取不到本包 locale 文件）；接线后可改走宿主 locale 服务并删内嵌。

## 接线结论（creator 会话回收处）

> Z8 接线已落地，实际确认值回写如下（升级时对照）：
>
> - 槽位（SLOT 实际取值）：`shell.overlay`（list 型，id=`dispatch.console`，order=20；
>   证据见 `refs/dsh-slots.md`，与 chat / plugin-manager / workspace 官方先例同槽）
> - Host 入口（Service/Event）：远端面 face `dispatch`（`ctx.provide` 注册，15 方法；
>   typert-loader 经 `exports["./typert"]` 自动注册 TYPERT 清单 + typertGateway SRC 接收器兜底：
>   实例 `typertRemote` 绑定 + 原型协议标记键）；Host→客户端推送事件名 `dispatch/changed`
> - TOKENS 实际令牌名：已按 `refs/dsh-theme-tokens.md` 核对（文本族 `--dsw-alias-label-*`、
>   边框 `-border-l1..l4`、状态 `-state-*-primary`、阴影 `--dsw-shadow-lv3`、代码字体
>   `--ds-font-family-code`）
