# ZB-84 任务包：把 WorkBuddy 官方 CLI（codebuddy）接入为派发台**第 4 个引擎**

> 用户决策（2026-10-21）：**不做反代**（WorkBuddy 已开始限制"反代到 DSH"这类用法），
> 改走**官方 CLI 派发** —— 合法合规，且不会因后续封禁反代而失效。
> 参考的 GitHub 项目（`hawklithm/workbuddy2api` 等）**仅作背景**，**本任务不依赖它们**。

---

## 一、真机已确认的事实（2026-10-21 实测，不要再重查）

### 1.1 CLI 位置与启动方式

| 项 | 值 |
|---|---|
| 应用目录 | `C:\Users\Administrator\AppData\Local\Programs\WorkBuddy`（= junction → `D:\Program Files\WorkBuddy`） |
| CLI 根 | `<应用目录>\resources\app.asar.unpacked\cli\` |
| npm 包名 | `@genie/agent-cli`，`main = lib/node/index.js` |
| bin 名 | `codebuddy` / `codebuddy-code` / `cbc` / `cbc-prewarm` / `codebuddy-lowmem` |
| 入口 | `<cli>\bin\codebuddy`（`#!/usr/bin/env node`，15 KB 薄启动器） |
| **版本** | **2.161.0**（`codebuddy --version` 实测） |
| 捆绑 Node | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\bin\node.exe` |
| 数据目录 | `C:\Users\Administrator\.workbuddy`（`dataFolderName: .workbuddy`） |

### 1.2 ⚠️ 必踩的坑：`dist/codebuddy` 缺失，必须走 lite-wb 包

`bin/codebuddy` 默认 require `../dist/codebuddy`，但**解包里只有 lite 包**：

```
<cli>\dist\codebuddy-lite-wb.mjs   (9,483,171 B, ESM)
<cli>\dist\lazy-lite-wb\
（没有 dist\codebuddy / dist\codebuddy-headless）
```

⇒ 不设环境变量直接跑会 `Error: Cannot find module '../dist/codebuddy'`。
**必须设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`** —— 启动器据此 `await import('codebuddy-lite-wb.mjs')`。

启动器内置**逐级回退**：`lite-wb → headless → full`（`ERR_MODULE_NOT_FOUND` 时继续降级）。
另有 `CODEBUDDY_FORCE_HEADLESS_BUNDLE=1` 可强制 headless 包（同样缺失）。

已验证可跑的最小命令：

```powershell
$env:CODEBUDDY_FORCE_LITE_WB_BUNDLE='1'
& "<cli>\bin\codebuddy" --help
```

### 1.3 CLI 参数面（与派发台需求逐项对得上）

```
-p, --print                      无头执行（等于 ZCode/OpenCode 的 -p）
--output-format <text|json|stream-json>      ← stream-json = 实时事件流（我们要的）
--input-format  <text|stream-json>
--json-schema <schema>           结构化输出校验
--permission-mode <acceptEdits|bypassPermissions|default|plan|dontAsk|auto>
-y, --dangerously-skip-permissions          （等价 auto）
--subagent-permission-mode <…>
--tools <value>                   ""=全禁 / "default" / "Bash,Edit,Read"
--allowedTools / --disallowedTools
--mcp-config <file|json>  --strict-mcp-config
--model <id>                      实测可选：auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo,
                                  glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc
--fallback-model <model>          （仅 --print）
--add-dir <dirs...>               额外可访问目录
-r, --resume [sessionId]  -c, --continue     续会话
--session-id <uuid>  --no-session-persistence
--serve                           HTTP server（Web UI / REST / ACP over HTTP SSE）
  --auth <password|none>
--agent <agent>                   默认主 agent（craft/ask/plan/debug/code-explorer）
--ide  --worktree  --tmux  -H/--header  --verbose  -d/--debug
```

**没有** `--reasoning-effort` 类思考档位旗标（与 Qoder 不同）；但有 `--agent` 与 effort 概念走斜杠命令。

### 1.4 ⚠️ 登录：CLI 从未登录过，需一次性 `/login`

实跑 `-p '只回复 OK' --output-format stream-json` 的结果：

```json
{"type":"result","subtype":"error_during_execution","is_error":true,
 "errors":["Authentication required. Please use /login command to sign in to your account"],
 "modelUsage":{"auto":{"contextWindow":168000,"maxOutputTokens":32000}}}
```

- CLI **没有** `login` 子命令（`--help` 里没有）⇒ 要在**交互会话**里敲 `/login`（浏览器 OAuth）
- `~/.codebuddy-session.json` 与 `~/.codebuddy-global-session.json` **都不存在** ⇒ 从未登录
- **与 Qoder 同一类坑：桌面 app 登录 ≠ CLI 登录**（Qoder 也是 CLI 必须单独登录）
- 登录后会话文件落 `~/.codebuddy-session.json`（国内）/ `~/.codebuddy-global-session.json`（`--global`）

### 1.5 事件流形状（与三引擎同级，可复用现有解析范式）

实测 `-p --output-format stream-json` 的事件类型：

```
system/init          ← 含 model、permissionMode、tools[]（数组，元素是工具名）、cwd、uuid、session_id
assistant            ← message.content[] 块：{type:'text'|'thinking'|'tool_use'}
result               ← 权威收尾：subtype(success|error_during_execution)、is_error、result、
                       duration_ms、num_turns、usage{...}、modelUsage{model:{contextWindow,maxOutputTokens}}、
                       permission_denials[]、session_id、total_cost_usd
```

⇒ **与 Qoder/OpenCode 的流式形状高度一致**，`qoder-run.mjs` 的聚合器结构可几乎照搬。

### 1.6 内置 agent / 工具（供参考，不影响执行器）

- `builtInAgentsName`: craft, ask, plan, debug, code-explorer
- 工具清单（product.json）：Agent / Bash / PowerShell / Glob / Grep / Read / Edit / Write /
  WebFetch / WebSearch / Task* / Workflow / REPL / Monitor / Team / Cron / A2A / Skill / MCP 等
- 子 agent 通过 `Task` 工具起（`code-explorer` 等）

---

## 二、要做的事（每条都要落地 + 测试）

### 2.1 新执行器 `collab-kit/codebuddy-run.mjs`

**照抄 `qoder-run.mjs` 的骨架**（同目录、同协议、同 CLI 参数风格），差异点：

| 项 | 取值 |
|---|---|
| 前缀常量 | `[codebuddy-run]`（加进 `run-line-protocol.mjs` 的 `RUN_PREFIX`） |
| 引擎 id | `codebuddy`（加进 `ENGINES`；**注意**：加引擎必须同时补 `LEVELS_KEYWORD` / `APPLIED_RE_OF` / `APPLIED_MAPPER` 三张表，见 ZB-51 教训） |
| 通道 id 形态 | `codebuddy/<model>`（`codebuddy-model` 与我们 `--model` 的裸名关系同 Qoder：CLI 收**裸模型名**） |
| **必须注入的 env** | `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`（否则 MODULE_NOT_FOUND） |
| 执行命令 | `codebuddy -p <body> --output-format stream-json --permission-mode acceptEdits [--model M] [--session-id S] [--add-dir D]…` |
| 权限映射 | 默认 `accept_edits` → `--permission-mode acceptEdits`；`--auto` → `--permission-mode bypassPermissions` |
| 续会话 | `--session-id <S>`（不是 `--resume`；`--resume` 是"选会话"语义） |
| 模型探测 | `codebuddy --model <假值> -p x` 逼出合法列表？**需实测**；退路：从 `product.json` 的 `--model` 帮助文本解析，或声明式表 |
| 思考档位 | **CLI 无档位旗标** ⇒ `thinkingLevels` 不提供（面板显示"无档位维度"），或走 `--agent` |
| 登录判据 | `~/.codebuddy-session.json` 存在 且 `-p` 不返回 `Authentication required` |
| 暂停分类 | 401/`Authentication required` ⇒ 新暂停原因 `not-logged-in`（可读指引：请在 codebuddy 交互会话里 `/login`） |

### 2.2 引擎注册与发现

- `collab-kit/engine-discover.mjs`：加 `codebuddy` 五级发现（env `CODEBUDDY_CLI` → 配置 →
  PATH（`codebuddy.cmd`）→ 已知安装位置（`%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy`）
  → 失败给可读说明）
- `dispatch/core/dispatch-core.mjs`：`ENGINES` 加 `codebuddy`，`maxConcurrentCodebuddy`（建议默认 2），
  `engineLimit()` 加分支，`listChannels()` 加 codebuddy 通道
- `dispatch/index.js`：FIELDS 加 `codebuddyRunnerPath` / `maxConcurrentCodebuddy`（**必须真透传**，见 ZB-79 教训）
- 面板：引擎标签加 codebuddy（客户端 `KNOWN_ENGINES` 由 cross-check 守门）

### 2.3 必须遵守的既有纪律（每条都踩过坑）

1. **加引擎必须同时补三张表**：`LEVELS_KEYWORD` / `APPLIED_RE_OF` / `APPLIED_MAPPER`（ZB-51，否则热路径 `resFor()` 抛 `is not a function`）
2. **执行器路径是逐引擎的**：`runnerPath` 只对 zcode 生效 ⇒ 测试要显式注入 `codebuddyRunnerPath`（ZB-75/77 踩过两次）
3. **remote 转发不许丢参数**（ZB-73）
4. **CLI 不按模型校验档位时别写死枚举**（ZB-31/ZB-75）
5. **`lock:'none'` 必须真的不取锁**（ZB-80）
6. **分流判据按引擎不按 provider**（ZB-83）

---

## 三、验收标准

- [ ] `node collab-kit/codebuddy-run.mjs --version` 能打出 2.161.0（走 lite-wb 包）
- [ ] `--list-models` 能列出模型（探测式，不写死）
- [ ] **登录后** `-p '只回复 OK'` 真机跑通，exit=0，`[codebuddy-run] done exit=0 …` 行正确
- [ ] 派发台 `dispatch { provider:'codebuddy/<model>' }` 能真跑并在面板可见
- [ ] 未登录时给可读暂停原因（`not-logged-in` + 指引），**不是** `failed/unknown`
- [ ] 全量测试绿（含新引擎路由/暂停分类/路径注入）
- [ ] teaching.md / pitfalls.md 记录：lite-wb 包坑、CLI 登录与桌面登录独立、无档位旗标

## 四、前置人工步骤（我做不了的部分）

**必须先在交互会话里登录一次**（浏览器 OAuth，我无法代劳）：

```powershell
$env:CODEBUDDY_FORCE_LITE_WB_BUNDLE='1'
& "C:\Users\Administrator\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
# 在交互界面里输入：/login
# 完成后确认 ~/.codebuddy-session.json 存在
```
