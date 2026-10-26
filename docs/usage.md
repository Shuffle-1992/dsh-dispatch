# 使用：悬浮面板与 agent 工具

> 本文是 [README](../README.md) 中「悬浮弹窗」「agent 工具 `dispatch`」两节的展开。

## 悬浮面板

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

### 派发优先级（写进了工具描述，模型选工具就看这段）

凡是「把任务交给一个 agent 去做」的诉求，**能用派发台就优先用派发台**——
用 `action=dispatch`，任务才会出现在面板里、才受派发总开关约束。
**仅当派发台不可用**（开关已关闭、`dispatch` 返回 `ok:false`：未配置 runner/workRoot、锁冲突等，
或用户明确要求「你自己去做」）才退回 DSH 自带的 `subagent` / 后台 jobs，
且**要说明为什么没用派发台**，不静默切换。

### 三条硬规则（ZB-37，2026-10-11 真机事故逼出来的）

① **不要用 `pwsh`/`Bash` 直接跑 `collab-kit/zcode-run.mjs`**（含 `run_in_background`）—— 那会绕过
文件锁、台账/额度分账、面板可见性、暂停分类与降级链；派发台 job **落地时本来就会自动唤醒**发起会话。

② **通道撞 429/额度耗尽**（job 变 `paused / quota-exhausted`）时：先 `action=channels` 看
`recentQuotaExhausted` 与 `quotaText` → **直接 `dispatch {provider:"<通道 id>"}` 换通道**（免费额度
通道 `account:<family>-start-plan` 常常仍可用），或 `action=fallback {chain:[…]}` + `action=retry` 交接。

③ **派发前先看额度**：`channels[].quotaText` / `giftQuotaText`（剩余与窗口剩余时间），剩余少或窗口
将尽就拆小任务。

④ **派发到"已撞顶"通道时立刻给提示**（ZB-38）：`action=dispatch` 的返回里带 `warning` +
`suggestedProvider`（优先建议可用的免费额度通道）—— 不必等它 429 暂停再靠猜。

⑤ **显式指定"已撞顶"通道 ⇒ 自动改派**（ZB-39，用户报告「面板选的是免费额度，派发却先走付费 5h 窗口」）：
候选顺序 = **你在面板 / `action=channel` 选定的默认通道** → 降级链首个可用目标 → 可用的免费额度通道；
返回里带 `redirectedFrom` + `warning` 说明改派事实。**绝不硬闯注定 429 的通道**，也不静默乱派
（候选全不可用 ⇒ 仅提示）。**因此调用方通常根本不需要传 `provider`**：不传就是用你选的通道。

> 事故复盘见 [`tasks/ZB-37-dispatch-path-incident.md`](../tasks/ZB-37-dispatch-path-incident.md)：
> 真因是工具 schema 的 `provider` enum 只有 `["plan","personal"]`，与"接受清单任意 id"的说明矛盾，
> 把免费额度通道挡在门外 ⇒ agent 只能派到付费通道 ⇒ 撞限额后绕开派发台。

### 派发时的两条纪律（真机教训）

- **必须明确要求「不要使用子代理/子任务」**：被派发的 CLI 自己再派子代理会撞上**同一账号的并发上限**
  （ZCode 免费额度实测 = 3），互相挤掉后串行重试白耗时间 —— 本项目第一次跑双模型复审就因此 25 分钟超时。
  工具描述里的 `prompt` / `task` / `target` 三个参数都写了这条要求，派发时给人看的说明里也该写。
- **给时间预算**：比如"30 分钟内完成，先出结论再补细节"，避免长任务跑飞。

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

**限制**：不支持 `--resume` / `--target` / `--memory-bench`（app-server 后端每次新建 CLI 会话）；
官方 MCP 在托管进程里不可用；免费额度是**时间窗口**型（窗口外以 `paused/quota-exhausted` 停下，
**不是**"5 小时已满"就判定额度耗尽）；`--cwd` 需落在宿主项目内（与 `ledgerPath` 同项目，
否则用量聚合看不到该单）。

**额度可见性（ZB-33）**：选中该通道时面板显示**额度条**（剩余 / 百分比 / 窗口 / 剩余时长）；
同一份数据也通过 `action=channels`（`channels[].quota`/`quotaText`）与 `action=quota`（`giftQuota`）
暴露给 agent —— **派发前就能知道还剩多少额度、窗口还剩多久**，工具描述里还写了据此拆任务/换通道的
决策指引。数据只读 ZCode 客户端日志（零网络请求、零额度消耗），新鲜度以 `observedAt` 如实标注。

验收记录见 [`tasks/ZB-33-gift-channel-exploration.md`](../tasks/ZB-33-gift-channel-exploration.md)。
