# 安装与配置

> 本文是 [README](../README.md) 中「安装」「配置」两节的展开（README 里原本重复出现了两个"安装"章节，已合并到这里）。

## 前置要求

- **DSH 桌面版**（在 `0.2.1-rc.2` 上开发验证）
- **至少一个**本机 AI CLI：ZCode / OpenCode / Qoder / WorkBuddy 任一
  （四个都在则全部自动发现，零配置）
- 本插件**无构建步骤、无 npm 依赖**

## 安装

> **本项目不发布 npm**（不提供裸包名安装）。唯一安装路径 = **从 GitHub 仓库安装**；
> 改代码的场景用本地绝对路径挂载。

### 方式一：从 GitHub 仓库安装（推荐）

git 规格 + `#path:` 子目录定位：

```bash
dsh plugin --profile web add "github:Shuffle-1992/dsh-dispatch#path:dispatch"
```

> 把 `web` 换成你的 profile 名（`dsh plugin list` 可查）。装完**重启 DSH** 生效。

**`#path:dispatch` 不能省**：本仓库是 monorepo，插件本体在 `dispatch/` 子目录；
DSH 实际执行 `pnpm add <spec>`，而 pnpm 对 git 仓库默认取**仓库根** —— 根目录没有插件
`package.json`，装出来只会得到占位包
（实测 `{"_pnpmPlaceholder":"...did not contain a package.json."}`）。

### 方式二：本地开发挂载（源码就在本机）

profile 的 `dependencies` 加 `"dsh-dispatch": "link:<仓库>/dispatch"`、`bundles` 加 `"dsh-dispatch"`，
并在 profile 的 `node_modules/dsh-dispatch` 建 junction 指向该目录。

手工版（等价）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dispatch" `
  -Target "<本仓库>\dispatch"
```

然后在**创造模式会话**里用 `plugin_manager` 的 `install_bundle` 安装
（`target` = 插件绝对路径），并**读返回的 `application` 与 `warnings`**（`applied` 才算生效）。

> 包名 = `dsh-dispatch`；bundle 资格由**仓库根** `package.json` 的 `dsh.bundle.patch`
> （→ `dispatch/cordis.patch.yml`）声明；插件本体清单在 `dispatch/package.json`。

**改动生效范围**：Host 半边（`index.js` / `wire.host.mjs` / `core/*` / `collab-kit/*`）
改动需要**重启 DSH**；Client 半边（`client.js`）改动**刷新页面**即可。

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
| `qoderRunnerPath` | `''` | Qoder 执行器（留空自动推断：env `DSP_QODER_RUNNER` → 仓库内） |
| `codebuddyRunnerPath` | `''` | WorkBuddy 执行器（留空自动推断：env `DSP_CODEBUDDY_RUNNER` → 仓库内） |
| `ledgerPath` | `''` | 台账 `dispatch-runs.jsonl` 绝对路径；留空则跳过用量聚合 |
| `workRoot` | `''` | 派发器工作根目录（`locks/`、`state/jobs.json`、`logs/`）；**留空则不创建 dispatcher** |
| `runnerCwd` | `''` | runner 子进程工作目录（通常设为宿主项目根）；留空 = DSH 进程 cwd |
| `switchPath` | 内置默认 | 派发总开关真值文件；留空则开关不可写 |
| `notifyOnSettle` | `true` | 任务落地时自动唤醒发起会话（与 DSH 后台任务同款） |
| `maxConsecutiveWakes` | `0` | 连续唤醒次数上限；0 = 不限 |
| `systemPromptHint` | `true` | 向 system prompt 注入「派发台优先于 subagent」提示段 |

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

## 常见安装问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 装出占位包 `_pnpmPlaceholder` | 漏了 `#path:dispatch` | 见上文「`#path:dispatch` 不能省」 |
| 面板一直显示 demo 假数据 | `runnerPath` 或 `workRoot` 为空 | 按「机器专有路径」补 patch 后重启 |
| 派发报 401 / 身份验证失败 | ZCode 凭据失配 | 见 [`credentials.md`](credentials.md) |
| 某引擎显示"未找到" | CLI 不在 PATH / 非常规安装位置 | 面板点引擎行看探测依据，或用对应 `*RunnerPath` 显式指定 |
