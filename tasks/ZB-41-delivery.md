# ZB-41 交付：去品牌化改名（ZCode 派发台 → DSH 派发台 / 派发台）

## 用户要求

> 「面板改成派发台，包名等相关的改成 DSH 派发台。」
> 「即所有跟 Zcode 相关的都改掉」——为**多引擎**（ZCode + OpenCode）做准备。

## 命名决策（落定）

| 位置 | 新值 | 说明 |
|---|---|---|
| **面板标题**（`ui.title` / 入口 chip） | **派发台** | 纯功能名，不再带引擎品牌 |
| **包标题**（`package.json` `meta.title` / locale `meta.title`） | **DSH 派发台** | npm 包名不能含中文，故包名用 `dsh-dispatch` |
| npm 包名 | `dsh-dispatch` | 插件包与根 hub 包都是它 |
| bundle / patch id | `dispatch` | |
| agent 工具名 | `dispatch` | 原 `zcode_dispatch` |
| remote 服务名 / 命名空间 | `dispatch` | 原 `zcodeDispatch`；全局探测钩子 `__dispatchDemo` |

## 改名映射（全量）

| 旧 | 新 | 说明 |
|---|---|---|
| `dsh-zcode-dispatch` | `dsh-dispatch` | npm 包名（插件包 + 根 hub 包） |
| `zcode-dispatch` | `dispatch` | bundle id / **插件目录名** / 状态文件名 / 通知 kind / 测试临时目录前缀 |
| `zcode_dispatch` | `dispatch` | agent 工具名 |
| `zcodeDispatch` / `ZcodeDispatch` | `dispatch` / `Dispatch` | cordis 服务名、typert 命名空间、`registerDispatchTool` |
| `ZCD_` | `DSP_` | 本插件自有环境变量前缀（`DSP_FAKE_RUNNER` 等） |
| `zcode-runs.jsonl` | `dispatch-runs.jsonl` | 额度台账（**共享契约**） |
| `zcode-dispatch.switch.json` | `dispatch.switch.json` | 派发总开关真值文件（**共享契约**） |
| `zcode-switch.mjs` | `dispatch-switch.mjs` | 开关 CLI |
| `bin/zcd.mjs` | `bin/dispatch.mjs` | 插件 CLI 入口 |
| `zcd-*`（CSS 类名） | `dsp-*` | 面板样式命名空间（`.dsp-field` / `.dsp-select` / `.dsp-chip` …） |
| `ZCode 派发台` | 面板：`派发台`；包：`DSH 派发台` | 显示层 |

**刻意保留（这些「ZCode」是正确的）**：
- `collab-kit/zcode-run.mjs` —— ZCode **引擎**的执行器，它确实只跑 ZCode；
- `ZCODE_CLI` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` —— ZCode 引擎专属环境变量契约；
- `dsh-connect-zcode`（另一个插件）—— 它是 ZCode 的 **provider 通道**，名字本来就该带 ZCode；
- `tasks/*.md` 历史交付记录 —— 改写历史文档会失真，不重写。

## 跨仓库契约改动（**这才是本轮的关键风险点**）

开关真值文件与额度台账**由「provider 通道（`dsh-connect-zcode`）」与「派发台」共用**
（宿主 `collab/PROTOCOL.md` §7.1：关了开关两者一起冻结）。**单侧改名会让额度台账分裂**
（provider 行落旧文件、dispatch 行落新文件 ⇒ 用量统计静默出错），故三处 + 两份 patch 必须同一次改完：

| # | 位置 | 改动 |
|---|---|---|
| 1 | **本仓库** | 默认名、CLI、通知文案、README、`collab-kit/dispatch-switch.mjs` |
| 2 | **宿主仓库** `keysion dac vue` | `collab/zcode-dispatch.switch.json` → `dispatch.switch.json`（**改名保内容**）；`collab/logs/zcode-runs.jsonl` → `dispatch-runs.jsonl`（**1,023,174 字节历史原样保留**）；`collab/PROTOCOL.md` + `collab/TOOLS-MOVED.md` 引用同步 |
| 3 | **`dsh-connect-zcode`** | 默认路径 + 文档 + 自检（8 个文件 16 处） |
| 4 | **profile `cordis.patch.yml`** | **两个条目**（`zcode-connect` provider 与 `dispatch` 派发台）的 `switchPath` / `ledgerPath` 同步 |
| 5 | **profile `package.json`** | 依赖 link 路径 + `dsh.profile.bundles` 条目 |

> ⚠️ 宿主仓库 `keysion dac vue` 的两处**文档改动未提交**（那是另一个项目，提交时机留给你）；
> 交换文件是 untracked、台账在 `logs/`（被忽略），故实际只动了两份 md。

## 目录改名与 profile 重注册

- 插件目录 `zcode-dispatch/` → **`dispatch/`**（仓库根 `F:\My Code\dsh-dispatch` **不改**：它是工作目录 + git 仓库 + GitHub remote，改不了也不该由脚本改）
- junction 重建：`node_modules\dsh-zcode-dispatch` → **`dsh-dispatch`** 指向 `F:\My Code\dsh-dispatch\dispatch`
  - 删除前已核对 `LinkType=Junction` 且目标存在，用 `cmd rmdir` 删链接（**只删链接**），删后立即验证目标仍在
- 备份：profile 的 `package.json` / `cordis.patch.yml` 各留了一份 `.zb41-backup`

## 验证证据

| 项 | 结果 |
|---|---|
| 插件测试 | **30 个文件 / 472 项断言 / 0 失败**（改名后断言数从 443 → 472） |
| `tools/verify-plugin.mjs` | **23 项，失败 0**（含「探针期间 `$DSH_HOME` 无写入」） |
| `node --check` | 8 个入口文件全绿 |
| `dsh-connect-zcode` 自检 | **SELFCHECK PASS 295/295** |
| 遗留检查 | 现行文件中 `dsh-zcode-dispatch` / `zcode_dispatch` / `zcodeDispatch` / `ZCD_` / `zcode-runs` / `zcode-switch` **全部 0 处**；仅剩 44 处 `zcode-dispatch`，**全是仓库根路径与 GitHub 地址**（合法保留） |
| 暂存安全 | `dispatch/.data`、`dispatch/work` 已被 `.gitignore` 覆盖，无运行时数据入库 |

### 过程中修掉的两个自身失误（留档，防复发）

1. **根路径被误伤**：保护串写的是**单反斜杠** `F:\My Code\dsh-dispatch`，而源码里的 JS 字面量是**双反斜杠**（`'F:\\My Code\\...'`）⇒ 保护没命中，根路径被一起改成了 `F:\My Code\dispatch\...`（10 个测试文件因此 ENOENT 失败）。已用第三遍脚本按三种形态（双反斜杠 / 单反斜杠 / 正斜杠）还原。
2. **GitHub 地址被误伤**：`github.com/Shuffle-1992/dsh-dispatch` 被改成 `.../dispatch`（仓库名不可能由脚本改），已还原为 `Shuffle-1992/dsh-dispatch`。
   另：`workRoot` 在 YAML 单引号里写成了双反斜杠（YAML 单引号不做转义），已修正为单反斜杠。

## 生效方式

- **客户端半边**（`client.js` / locale）：刷新页面即见（标题变「派发台」）
- **宿主半边**（`index.js` / `wire.host.mjs` / `core/*`）+ bundle id 变更：**必须完全退出 DSH 再启动**
- 工具名从 `zcode_dispatch` 变为 **`dispatch`**：重启后 agent 侧才可见（本会话的 system prompt 提示段也会随之更新）

## 待办（下一轮）

1. **重启 DSH 后回归**：面板标题、工具名 `dispatch`、派发端到端（含开关读写新契约文件）
2. **OpenCode 集成**（用户已定方案 = **渠道内集成**，不做双 tab）：
   - 通道带 `engine` 字段（`'zcode' | 'opencode'`），`startJob` 按引擎选 runner + args builder
   - 新增 `core/opencode-run.mjs`（`opencode run <task> -m <model> --format json --dir <dir>`，NDJSON 解析）
   - 通道下拉按引擎 `optgroup` 分组；12 个免费模型**探测式**获取（不写死）
   - 契约纪律：不伪装身份、不读写用户 `~/.config/opencode` 与 `~/.local/share/opencode`、默认不开 `--auto`、免费层按 IP 限流故并发要低
   - 最大增量：**跨引擎降级**（ZCode 额度撞顶 ⇒ 落 OpenCode 免费模型）
3. 宿主仓库那两处文档改动由你决定何时提交。
