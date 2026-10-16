# T6 任务包：插件教学文档 `dispatch/teaching.md`

> 目标读者：**刚接触这个插件的 Agent / 开发者**。读完要能**自己把三个引擎跑起来、不撞墙**。
> 依据：`tasks/ZB-51-engine-autodiscovery.md`（发现层设计）、`tasks/ZB-50-qoder-integration-spec.md` §8（Qoder 真机实测）、`tasks/ZB-44-delivery.md`（历史事故）。
> **纪律：只写本文件里给出的事实，不确定的写"未实测"，绝不编造。**

## 交付物
只写一个文件：**`dispatch/teaching.md`**（中文，Markdown）。不要改任何代码或其它文档。

## 必须覆盖的章节

### 1. 这是什么 / 一句话上手
- 派发台 = 把任务派给**无头 agent 进程**跑，支持**三个引擎**：ZCode / OpenCode / Qoder。
- 最小例子（两条命令即可上手）：
  - 看有哪些引擎和通道：`dispatch action=channels`
  - 派一个任务：`dispatch action=dispatch { kind:'prompt', prompt:'…', provider:'opencode/deepseek-v4.1-flash-free', timeoutMin:5 }`
- 强调：**总开关**（`dispatch action=status`）关着时，只读探测仍可用、真实派发会被拒。

### 2. 三个引擎：装什么、怎么登、怎么被找到
按下面这张**已实测**表写（不要改数字/路径）：

| 引擎 | 形态 | 可执行（真实落点） | 登录 | 环境变量覆盖 |
|---|---|---|---|---|
| **ZCode** | 桌面客户端自带 CLI | `F:\Program Files\ZCode\resources\glm\zcode.cjs`（**不在 PATH**） | `~/.zcode/v2/credentials.json` | `ZCODE_CLI` |
| **OpenCode** | npm 全局 CLI（1.19.2） | `%APPDATA%\npm\opencode.cmd` | `~/.local/share/opencode/auth.json` | — |
| **Qoder CN** | IDE + 独立 CLI（v1.1.73） | `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe` | 需单独登录：`qoderclicn login`（浏览器设备码，**5 分钟有效期**） | `QODERCN_CLI_BIN` |
| Qoder 全球版 | 同上 | `~/.qoder/bin/qoder` | 同上（`qoder login`） | `QODER_CLI_BIN` |

**安装命令**（照抄，注意 CN 与全球是不同域名）：
```powershell
# Qoder CN（你若是国内版）
irm https://qoder.com.cn/install.ps1 | iex
# Qoder 全球版
irm https://qoder.com/install.ps1 | iex
```

### 3. 自动发现：插件怎么找到它们（**五级**）
说明插件安装后**会自动**按这五级找，**用户不需要手填路径**：
1. 环境变量（`ZCODE_CLI` / `QODERCN_CLI_BIN` …）
2. 插件 config 显式路径
3. PATH（Windows 按 PATHEXT：`.exe`/`.cmd`/`.bat`/`.ps1`；**同名多命中只取第一个**）
4. 已知安装位置扫描（客户端/IDE 自带 CLI 走这条；**跨盘符**枚举）
5. 全失败 ⇒ 该引擎通道为空 + 可读说明，**其它引擎照常**

并说明**每个引擎上报四件事**：找到的文件 / 版本 / 是否已登录 / 形态（cli / ide-bundled / client）。

### 4. 十面墙（**每条：现象 → 原因 → 怎么办**）
这是本章重点，逐条写清（内容取自实测与设计文档）：

1. **任务"成功"但一个文件都没改**（Qoder 默认权限模式）：无头下 `ask` 一律变 `deny`，且**完全静默**（`permission_denials` 是空、`is_error=false`）。⇒ 派发时用 `auto:true` 或让执行器带 `--permission-mode accept_edits --add-dir <cwd>`。
2. **目录不受信任 ⇒ 权限模式被回落**：非默认模式只在受信任目录生效；执行器会比对 `init.permissionMode`，若回落（真实值形如 `acceptEdits`/`default`）会**明确报警**。
3. **Qoder 未登录**：报 `Not logged in. Run 'qoderclicn login'`，`--list-models` exit=1。⇒ 先登录或设 PAT。**注意 IDE 登录 ≠ CLI 登录**（实测：IDE 登录着 CLI 仍报未登录）。
4. **Qoder 的 token 字段可能是 0**：实测 `input_tokens/output_tokens/contextWindow` 全 0，**真实计量是 `total_credits` 与 `context_usage_ratio`**。⇒ 面板显示为 0 不代表没消耗。
5. **慢模型被误杀**（历史事故）：执行器曾有独立于 `--timeout-min` 的 15s 兜底，把"慢但正常"的调用判成挂死（`glm-5.3-flash-free` 冷启 ~14s）。⇒ 现在兜底只挂在 `timeoutMin` 之上。**给慢模型留足 timeoutMin**。
6. **并发第二个 opencode 进程会破坏第一个**：同一进程链里在 `run` 进行中再起一个 opencode（如探测）⇒ 前者零输出 exit 1。⇒ 探测已改为顺序 + 缓存；**两个独立的 `run` 并发本身是安全的**（实测 2/2 成功）。
7. **免费层限流**：429 / `Endpoint is unavailable`，间歇失败属正常；不要靠调大并发提速。
8. **续会话必须同 cwd**：会话按工作目录/项目隔离，换目录续跑会挂或静默开新会话。⇒ 系统会把 `sessionId` 与 `cwd` 成对持久化。
9. **权限放行是显式的**：`auto` 默认 **false**；开启后 job 上有 `autoApproved` 标记 + 面板徽标 ⇒ **放行永远可见**，不会偷偷全放行。
10. **改完不生效**：`dispatch/client.js` 与 `locale/*` 只需**刷新页面**；`dispatch/index.js`/`wire.host.mjs`/`core/*` 必须**完全退出 DSH 再启动**；`collab-kit/*` 执行器**下次派发即生效**（每次 spawn 新进程）。

### 5. 三个引擎的能力差异（一张速查表）
| 维度 | ZCode | OpenCode | Qoder |
|---|---|---|---|
| 思考强度 | `reasoning-level` | `--variant` | `--reasoning-effort` |
| 不支持 | — | `mode`/`memoryBench` | `mode`/`memoryBench` |
| 权限放行 | 不需要 | `--auto`（默认关） | `--permission-mode`（默认 `accept_edits`） |
| 续会话 | `--resume` | `-s <id>`（同 cwd） | `--session-id`（按项目隔离） |
| 并发上限 | `maxConcurrent` | `maxConcurrentOpenCode`（默认 2） | 待定（建议 1） |

### 6. 常见操作速查（命令）
```powershell
# 引擎/通道探测
dispatch action=channels
# 总开关
dispatch action=status
# 派发（默认参数已最优，多数情况只需 kind/prompt/provider）
dispatch action=dispatch { kind:'prompt', prompt:'…' }
# 看进程
dispatch action=list
# 读输出 / 等落地
dispatch action=tail { id:'j-…', n:30 }
dispatch action=wait { id:'j-…', timeoutSec:120 }
# 续跑一个暂停/失败的任务
dispatch action=retry { id:'j-…' }
```

### 7. 出问题时怎么自查（三步）
1. `dispatch action=channels` 看**通道在不在**、`warnings` 说什么（找不到引擎会写明查过哪些位置）；
2. 看 job 的 `paused`/`failed` 原因（`pauseReason`/`pauseDetail`）与 `tail` 尾部；
3. 引擎级问题直接手跑一条最小命令定位（例：`qoderclicn -p -o json "Reply with exactly: PONG"`）。

### 8. 给 Agent 的三条纪律
1. **不要把"没找到引擎"当成插件坏了** —— 先看 `channels` 的 warnings；
2. **派慢模型要给足 `timeoutMin`**，不要用短超时"快速失败"；
3. **需要权限放行时显式传 `auto:true`**，并在交付说明里写清"这次是放行了权限的"。

## 硬要求
1. 全文中文，**Markdown 表格优先**，控制在 **200–320 行**；信息密度优先，不要客套话。
2. **每条关键结论后标注依据**：`（实测）`/`（官方文档）`/`（设计约定）`。**没实测的写"未实测"**。
3. 路径写**真实值**（上面表里给的），不要写成 `<安装目录>` 这种占位符 —— 这份文档的价值就在"照着做能通"。
4. 不要写代码实现细节（那是 README 的事）；这是**使用者/上手指南**。
5. 不要在文档里承诺未实现的功能（例如 Qoder 执行器**还没写**，要如实写"Qoder 引擎接入中，CLI 已可独立使用"）。

## 禁止
- 只写 `dispatch/teaching.md`，**不要改任何其它文件**。
- 不要调用任何真实 AI 任务（写完文档即结束）。
