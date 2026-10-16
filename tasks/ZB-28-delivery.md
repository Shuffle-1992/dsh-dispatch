# ZB-28 交付：派发台四项补强（锁排队可观测 / paused 与超时字段化 / task 记忆禁令 / retry-resume 与枚举权威）

> 用户原话（一句话版）：①锁排队可观测——list 增加锁等待队列（前面有谁/几个/预计等待）；
> ②把 `paused` 的全部触发条件、`timeoutMin` 上限与超时终态（killed/interrupted?）写进文档并落到 job 字段；
> ③给 `kind=target` 补一句与 prompt/task 的边界判据，并在 `kind=task` 上想办法注入记忆禁令
> （现在 memoryBanApplied=false 等于裸奔）；④写清 `resume` 与 `retry` 的选择判据，
> 以及文档枚举的 model/provider 与 `channels` 实际清单不一致时以谁为准。
>
> 本轮 = ZB-28（接 ZB-27 之后）。日期：2026-10-06。

---

## 一、改动清单

### ① 锁排队可观测（`lockWait`）

| 文件 | 位置 | 内容 |
|---|---|---|
| `zcode-dispatch/core/dispatch-core.mjs` | :745 `lockWaitFor()`（新增） | queued job 的结构化排队信息：`position/queuedTotal/ahead/aheadIds(≤10)/blockers[]/estWaitSec/estWaitNote`；blockers 指认持有者（`lock`/`holderJobId`/`holderTag`/`holderState`/`holderElapsedSec`/`holderTimeoutMin`/`holderRemainingSec`），跨层级阻塞以 `cross:…` 条目计入；只读观测（检查锁文件+读内存 job，绝不清锁） |
| 同上 | :471 `serialize()` 挂载 | `out.lockWait = state==='queued' ? lockWaitFor(job) : null` —— `list()/get()/snapshot()` 及事件广播全部携带 |
| 同上 | :697 `lockBlockersFor` 之后 | 完整 ZB-28 字段契约注释 |
| `zcode-dispatch/wire.host.mjs` | :188 `slimJob` | 无需改动：`...rest` 天然透传 `lockWait`（测试钉住） |
| `zcode-dispatch/index.js` | :339 | 工具描述 `action=list` 行新增 lockWait 字段说明 |
| `zcode-dispatch/client.js` | :1617-1634 `lockWaitText()`、:2210-2213 详情行 | queued 行展开显示「`第 2/3 位 · 前方 1 个（j-xxxx） · 被 tag 挡住 · 预计 ≤ 0时03分20秒`」；`estWaitSec=null` 时如实显示「预计等待未知」 |
| `zcode-dispatch/locale/{zh,en}.json` + `client.js` STRINGS | `lockWait/timedOut/timedOutRunner/timedOutWatchdog` 4 键 × 2 语言 | 文案双份同源（single-source ⑤ 仍绿） |
| README | 「锁排队可观测（ZB-28 `lockWait`）」小节 | 字段表 + 语义 |

**estWaitSec 的诚实口径**：仅当**每个**阻塞者都声明了 `timeoutMin` 时才给值
（= max(`timeoutMin`×60 + 看门狗宽限 − 已运行秒)，是**上界**：到点看门狗会放行）；
否则 `null` + note 说明原因 —— 绝不猜测前序任务还要跑多久。

### ② paused 触发条件 / timeoutMin 边界 / 超时终态 → 文档 + job 字段

| 文件 | 位置 | 内容 |
|---|---|---|
| `zcode-dispatch/core/dispatch-core.mjs` | :86 `RES.memoryBan`（新增正则）、:185 解析 | —— 见 ③ |
| 同上 | :170-184 `parseRunnerLine` done 分支 | **`(超时)` 标记不再被丢弃**：带它时返回 `timedOut:true`（此前非捕获组吞掉，「runner 超时的 failed」与真失败不可区分） |
| 同上 | :1049-1056 看门狗 | `job.watchdogSec = timeoutMin*60+宽限` 落字段；开火时 `job.timedOutBy='watchdog'` |
| 同上 | :1157 `handleLine` | `parsed.timedOut → job.timedOut=true + job.timedOutBy='runner'`（仅首次，看门狗优先） |
| 同上 | :1186 `finalizeJob` | `state==='paused' ⇒ job.pausedAt = job.finishedAt`（非 paused 恒 null） |
| 同上 | :1528-1535 `dispatchRaw` | 新字段初始化：`memoryBanRunner:null / timedOutBy:null / pausedAt:null / watchdogSec:null` |
| `zcode-dispatch/test/fixtures/fake-runner.mjs` | `FAKE_TIMEOUT_DONE` / `FAKE_MEMORY_BAN_LINE` env | 假 runner 可模仿「runner 自身超时（exit 124 + `(超时)`）」与「memory-ban=on 确认行」 |
| `zcode-dispatch/index.js` | :337 | 工具描述新增「**paused 与超时**」行：四签名优先级、两种超时终态、字段名 |
| README | 「paused 与超时：触发条件、终态与 job 字段（ZB-28）」整节 | 触发条件全集表、签名优先级表、timeoutMin 边界（**无上限**、runner 下限 1 分钟、看门狗宽限）、超时终态对照表（**runner 超时→failed；看门狗→killed；interrupted 与超时无关**） |

### ③ kind=target 边界判据 + kind=task 记忆禁令（不再裸奔）

| 文件 | 位置 | 内容 |
|---|---|---|
| `collab-kit/zcode-run.mjs` | :36（usage）、:148（解析）、:505-526（注入） | 新旗标 **`--memory-ban`**：在组装出的 prompt 末尾追加同款禁令文本（对 `--task`/`--prompt` 生效；`--target` 不经 prompt，warn 说明由派发台拼在目标文本内）；打印 `[zcode-run] memory-ban=on` 供上层确认 |
| `zcode-dispatch/core/dispatch-core.mjs` | :996-1004 `buildRunnerArgs` | `kind=task` 默认带 `--memory-ban`（`opts.noMemoryBan` 可关）；旧版 runner 报「未知参数」exit 1 = **fail-fast，不静默裸奔** |
| 同上 | :1525-1528 | `memoryBanApplied` 三种 kind 恒 `true`（语义=「禁令已安排」）；runner 确认位独立为 `memoryBanRunner` |
| 同上 | :963-978、:988-990 | 覆盖面注释改写（删除「task 注入不进去」的旧表述） |
| `zcode-dispatch/index.js` | :301、:335 | `kind` 参数描述带三 kind 判据；记忆写入行改写为「三种 kind 全覆盖 + memoryBanRunner 确认位 + 成对升级 runner」 |
| README | 「锁与并发语义」memory-ban 引文改写 + 「resume 与 retry 怎么选」前的 tool 一节 | 同步 |
| **kind 边界判据（成文处）** | `index.js` :327 dispatch 行 + README「agent 工具」dispatch 条目 | **prompt=完整指令**（一次性问答/明确步骤）；**target=目标描述**（只说"要达成什么"，ZCode 自主规划并自续跑直到达成，适合无人值守委托；与 prompt/task 互斥是 CLI 限制）；**task=任务包文件绝对路径**（含交付物/验收标准的正式任务，runner 读文件内联） |

判据依据 = runner 的实际行为（`collab-kit/zcode-run.mjs` 头注）：`--target` 是 CLI 的目标模式
（自续跑直到达成、与 `--prompt`/`--task` 互斥），`--task` 由 runner 内联并套交付壳。

### ④ resume/retry 选择判据 + 枚举权威

| 文件 | 位置 | 内容 |
|---|---|---|
| `zcode-dispatch/index.js` | :348 retry 行、:346-347 channels/channel 行、:355 限制行 | **判据**：job 还在派发台 → `retry`（簿记链完整）；只有裸 sessionId → `dispatch`+`resume`。**权威**：`channels` 实时清单是通道可用性与真实 id 的唯一权威；schema enum 只是常用别名（可能被宿主强制）；枚举外通道走 `action=channel`（provider 接受任意清单 id）设默认后不带 provider/model 派发 |
| `zcode-dispatch/index.js` | :304-305 参数描述 | `model`/`provider` 描述注明「枚举=常用别名；实际可用值以 channels 为准」 |
| README | 「resume 与 retry 怎么选（ZB-28）」+「枚举与 channels 清单，以谁为准（ZB-28）」两节 | 判据表 + 权威链说明 |
| `zcode-dispatch/core/dispatch-core.mjs`（无改动，佐证） | `dispatch()` F2 纪律、`channel` 动作不设白名单 | resume 不注入默认 model；channel set 接受任意 provider id —— 文档口径与实现一致 |

### 测试

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test/lock-queue-visibility.test.mjs`（新增） | 6 | 整仓锁/文件锁/跨层级 blockers 指认持有者；ahead 同类计数（文件锁与整仓库分开数）；estWaitSec 上界与「不猜」；非 queued 恒 null；wire `list` 动作透传 |
| `test/pause-timeout.test.mjs`（新增） | 5 | `(超时)` 标记解析；看门狗 → killed + timedOutBy=watchdog + watchdogSec；runner 超时 → failed + timedOutBy=runner；paused/pausedAt 与 unknown 分支；timeoutMin 校验（>0 合法无上限） |
| `test/memory-ban.test.mjs`（更新） | 4→6 | task 用例改为「传 `--memory-ban` 旗标 + memoryBanApplied=true + memoryBanRunner 独立确认位」；新增 runner 确认行 e2e 与 parseRunnerLine 单元 |
| `test/core.test.mjs`（更新 1 断言） | — | done 行 deepEqual 补 `timedOut:true`（预期中的行为变更） |
| `test/fixtures/fake-runner.mjs`（扩展） | — | `FAKE_TIMEOUT_DONE` / `FAKE_MEMORY_BAN_LINE` 两个 env 开关 |

---

## 二、复现命令与结果

```powershell
cd "F:\My Code\dsh-dispatch\zcode-dispatch"
node --test test/lock-queue-visibility.test.mjs   # 6/6
node --test test/pause-timeout.test.mjs           # 5/5
node --test test/memory-ban.test.mjs              # 6/6
node --test test/core.test.mjs                    # 12/12
# 全量 19 文件 + 3 新文件：
#   channel-retry 9/9 · wait-action 6/6 · file-lock 9/9 · lock-model 8/8 · lock-priority 4/4
#   lock-badge 1/1 · lock-ui 1/1 · single-source 1/1（含 STRINGS↔locale 逐值）· hardening 5/5
#   notify 21/21 · wake-integration 3/3 · quota-rpc 16/16 · ctx/elapsed/tail/section/panel/header 1/1
node tools/verify-plugin.mjs                      # 21 项，失败 0 项（越界检查 clean）
node --check zcode-dispatch/index.js; node --check zcode-dispatch/client.js
node --check zcode-dispatch/core/dispatch-core.mjs; node --check collab-kit/zcode-run.mjs
```

runner 侧真机口径验证（假 CLI，零网络零额度）：

```
node collab-kit/zcode-run.mjs --project <tmp> --task <tmp>/task.md --memory-ban --no-ledger
  → [zcode-run] memory-ban=on（已在提示词末尾注入记忆禁令）
  → 假 CLI 收到的 argv 里同时含「===== 任务包开始 =====」与「不要执行任何 ZCode 记忆写入」 ✅
```

---

## 三、形态与证据（文件:行号，当前 HEAD）

- `core/dispatch-core.mjs` :86 / :185 / :471 / :745-861(lockWaitFor) / :996-1004 / :1049-1056 / :1157-1158 / :1186 / :1528-1535
- `collab-kit/zcode-run.mjs` :36 / :148 / :505-526
- `index.js` :301-309（参数描述）/ :327（kind 判据）/ :335-339（记忆禁令 + paused 与超时 + list lockWait）/ :346-348（channels 权威 + retry 判据）/ :355（限制行）
- `client.js` :434-435 / :484-485（STRINGS）/ :1617-1634（lockWaitText）/ :2210-2213（详情行）
- `locale/zh.json` / `locale/en.json`：ui 段各 +4 键（lockWait/timedOut/timedOutRunner/timedOutWatchdog）

---

## 四、未确定项（宁缺毋编）

1. **宿主是否强制 enum**：未在真机验证 DSH 对工具参数 `enum` 是否硬校验（可能只在模型侧约束）。
   因此文档口径写成「枚举是常用别名，**可能**被宿主强制」——无论哪种行为，给出的替代路径
   （`action=channel` 设默认通道）都不受枚举限制，口径在两种实现下都成立。
2. **旧版 runner 共存**：若 profile 的 `runnerPath` 指向旧版 `zcode-run.mjs`（无 `--memory-ban`），
   kind=task 派发会 exit 1「未知参数」（fail-fast）。未做自动探测/降级——降级意味着静默裸奔，
   与本轮「不再裸奔」的目标相反；文档已写明「成对升级」。
3. **宿主项目的 `tools/bridge.mjs`**（派发第三入口）不在本仓库，未同步 `--memory-ban`；
   走派发台/CLI（同一 core）的 task 任务已全覆盖。
4. **运行中的会话看到的是旧工具描述**：`index.js` 属宿主半边，**需完全退出并重启 DSH** 才加载新
   工具描述与 lockWait（README「改 host 代码后必须重启」一节）；`client.js` 刷新页面即可。
   本会话系统提示里的 `zcode_dispatch` 定义仍是旧文案，属预期。
