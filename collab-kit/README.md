# collab-kit —— DSH ↔ ZCode 协作工具集

从 `keysion dac vue/scripts/collab/` 迁出的**通用协作基础设施**（2026-10-01）。
它们与任何具体业务项目无关，只是恰好被 keysion 项目的协作流程使用。

**配套的派发台插件**在本仓库 `dispatch/`（DSH 面板 + job 管理 + 锁闸）。

---

## 工具清单

| 工具 | 用途 |
|---|---|
| `zcode-run.mjs` | **ZCode 无头派发器**（核心）：把自足任务包交给 ZCode Agent CLI 无头执行，产物/证据落盘，退出码透传 |
| `dispatch-switch.mjs` | **派发总开关**（跨会话唯一真值来源）：`enabled:false` = 禁止一切派发 |
| `wait-inbox.mjs` | 等待信箱出现新消息（跨 Agent 互唤醒的备选通道） |
| `run-gates.mjs` | 门禁批量复跑器（读 `<project>/collab/gates.json`，逐套件执行并留原始日志） |
| `relay-once.mjs` | 机械复审证据准备（跑门禁 + 产出证据包） |
| `headless-wake.mjs` / `.cmd` | 计划任务无头拉起（Trae 时代遗留） |
| `inject-inbox.js` | ZCode SessionStart 钩子（把协作待办注入会话上下文） |
| `trae-session-inject.mjs` / `trae-stop-check.mjs` / `hook-*.cmd` | Trae 钩子（**已停用**，保留为历史资产） |
| `zcode-run.cmd` | 单令牌启动器（供钩子/计划任务调用，路径含空格安全） |

---

## 项目根怎么给（**必读**）

这些工具**不再假定自己是某个项目的子目录**（它们已迁出宿主项目），因此项目根必须显式给出。

**解析顺序**：

1. `--project <dir>`
2. env `ZCODE_PROJECT_DIR`
3. **从绝对路径的 `--task` 反推** —— 向上找最近的含 `collab/` 的祖先目录
   （专为 DSH 派发台准备：它传绝对 `--task` 但**不传** `--project`，且子进程 cwd 未必是宿主项目）
4. 当前工作目录

> 在项目根目录下直接运行可省略（走第 4 条）。

### 可用环境变量

| 变量 | 作用 |
|---|---|
| `ZCODE_PROJECT_DIR` | 项目根（含 `collab/` 的目录） |
| `ZCODE_SWITCH_FILE` | 派发总开关文件（跨项目统一开关时用） |
| `ZCODE_LOG_DIR` | 日志/台账目录（默认 `<project>/collab/logs`） |
| `ZCODE_CLI` | ZCode CLI 路径（默认 `F:\Program Files\ZCode\resources\glm\zcode.cjs`） |

---

## 用法

```bash
# 无头派发（主通道）
node "<本仓库>/collab-kit/zcode-run.mjs" \
     --project "F:/path/to/project" \
     --task collab/tasks/T1-task.md --tag T1 --mode edit

# 直接给指令
node "<本仓库>/collab-kit/zcode-run.mjs" --project "<root>" --prompt "只回答 OK" --tag smoke

# 目标模式（ZCode 自续跑到目标达成；与 --prompt/--task 互斥）
node "<本仓库>/collab-kit/zcode-run.mjs" --project "<root>" --target "<可校验目标>" --tag T2

# 续接既有会话
node "<本仓库>/collab-kit/zcode-run.mjs" --project "<root>" --resume sess_xxx --prompt "继续"

# 查套餐/供应商可用性
node "<本仓库>/collab-kit/zcode-run.mjs" --list-providers

# 派发总开关
node "<本仓库>/collab-kit/dispatch-switch.mjs" --project "<root>" status
node "<本仓库>/collab-kit/dispatch-switch.mjs" --project "<root>" off --by dsh --note "维护中"

# 门禁批量复跑
node "<本仓库>/collab-kit/run-gates.mjs" --project "<root>" --tag R1
```

> ⚠️ 项目根**不要**写成 `<script>/../..` 那种相对推导 —— 工具已在另一个仓库，推导会指错。

---

## 凭据处理（重要）

派发器消费 **ZCode 套餐额度**（默认 `--provider plan`），凭据来源有**两个**：

| 位置 | 形态 | 说明 |
|---|---|---|
| `~/.zcode/v2/config.json` → `provider[planKey].options.apiKey` | **明文** | 首选 |
| `~/.zcode/v2/credentials.json` → `account-provider:coding-plan:...:api-key` | **加密 `enc:v1`** | 回退来源 |

**回退逻辑**：`config.json` 的 key **验活失败**时，自动回退到加密凭据库（逐把验活取第一把通过的）。
用 `--no-cred-fallback` 关闭回退（只用 `config.json`）。

### 为什么需要回退

ZCode 在 **OAuth 重新登录**后会把新 API Key **只写进加密凭据库、不回写 `config.json`**；
而 `config.json` 里留着**已失效的旧 Key** ⇒ 一切读 `config.json` 的工具集体 401
（**连 ZCode 自己的 Agent CLI 也一样**）。

<!-- 完整事故分析与恢复工具见 dsh-connect-zcode 仓库的 TROUBLESHOOTING.md §1.1 -->

### ⚠️ 验活的致命陷阱

**bigmodel 网关对失效 key 的 `GET /v1/models` 也返回 HTTP 200**，body 为
`{"code":1000,"msg":"身份验证失败。","success":false}`。

**只看状态码会把无效 key 判为有效** ⇒ 回退逻辑形同虚设。正确判定：

```js
if (!res.ok) return false;                          // 401 等
if (body?.success === false) return false;          // ← 关键：200 也可能是认证失败
if (body?.code !== undefined && body.code !== 200) return false;
return Array.isArray(body?.data) && body.data.length > 0;
```

### 加密凭据库的解密机制（从 zcode.cjs 反编译实证）

```
格式  ：enc:v1:<iv base64url>.<tag base64url>.<data base64url>
算法  ：AES-256-GCM
密钥  ：sha256(secret)          // 32 字节；iv 12B / tag 16B
secret：env ZCODE_CREDENTIAL_SECRET
        否则 "zcode-credential-fallback:<platform>:<homedir>:<username>"
键名  ：account-provider:coding-plan:account:<planId>:account:<accountId>:api-key（7 段）
```

> **形态校验要留诊断**：`API_KEY_RE` 是硬过滤，ZCode 若换 key 形态会让候选**静默变空**。
> 本工具输出了 `凭据库条目 N 条…形态校验通过 K 条`，让"被过滤"这件事可见。

### 网络实现说明

派发器用 **`node:https`（`httpsGetJson`）而非 `fetch`** —— 有意规避运行环境对
`fetch`/undici 的限制，稳定性更好。

---

## 安全纪律

- **零明文日志**：只打指纹（`head=xxxxxxxx*** tail=***xxxx`），绝不打印 key 原文
- **零落盘**：解出的明文只在内存，不写任何副本
- **必须验活才切换**：不验活可能选到同样失效的 key，比不切更糟
- **全部失败 → 沿用 `config.json` 原值**（不抛、不引入新失败面）

---

## 与 DSH 派发台的配合

派发台插件（本仓库 `dispatch/`）通过 `runnerPath` 调 `zcode-run.mjs`。
profile 配置示例（`~/.dsh/profiles/<p>/cordis.patch.yml`）：

```yaml
- id: dispatch
  config:
    runnerPath: '<本仓库>\collab-kit\zcode-run.mjs'
    runnerCwd: 'F:\My Code\keysion dac vue'      # runner 子进程 cwd = 宿主项目根
    ledgerPath: 'F:\My Code\keysion dac vue\collab\logs\dispatch-runs.jsonl'
    switchPath: 'F:\My Code\keysion dac vue\collab\dispatch.switch.json'
    workRoot: '<插件目录>\.data'
```

`runnerCwd` 与"从 `--task` 反推"构成**双保险**：任一机制生效即可正确定位项目根。

---

## 迁移说明

详见目标项目的 `collab/TOOLS-MOVED.md`（以 keysion dac vue 为例），含：
完整迁移对照表、哪些脚本为何留下、新用法、以及"后续改动请改这里"的提醒。

> ⚠️ **后续改动请直接改本目录**。原位置（业务项目的 `scripts/collab/`）已删除该文件，
> 在那边改动会落到**已废弃的路径**上。
