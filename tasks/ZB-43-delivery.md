# ZB-43 交付：仓库改名 `zcode-dispatch` → `dsh-dispatch`（GitHub + 本机根目录）

## 用户要求

> 「做之前先把 Github 上的名称改了，能行不？现在上面的项目名称带有 Zcode，有误导性」
> 选定：GitHub 名 = `dsh-dispatch`；**本地目录也一起改**；改完产出**交接文档**供重开会话继续。

## 能力探测（先证可行，再动手）

| 项 | 结果 |
|---|---|
| `gh` CLI | ❌ 未安装 |
| 可用凭据 | ✅ Git Credential Manager（`Shuffle-1992`） |
| OAuth scopes | `gist, repo, workflow` —— **含 `repo`** ⇒ 有仓库管理权 |
| 目标仓库权限 | `admin=True`（public） |

⇒ 用 GitHub REST API（`PATCH /repos/{owner}/{repo}`）改名，无需 `gh`。

## 改动清单

### ① GitHub 端
- `Shuffle-1992/zcode-dispatch` → **`Shuffle-1992/dsh-dispatch`**（HTTP 200）
- 旧地址 GitHub **自动 301 重定向** ⇒ 既有 clone / 链接不会断
- 本机 `git remote set-url` 同步

### ② 本机根目录
- `F:\My Code\zcode-dispatch` → **`F:\My Code\dsh-dispatch`**
- ⚠️ **必须从父目录执行改名**：在自己的 cwd 里改名会被 Windows 拒绝（"因为它在使用中"）——
  第一次就撞上了，换成 `workdir=F:\My Code` 后成功

### ③ 引用同步：234 处 / 43 文件

覆盖**四种形态**（教训见下）：

| 形态 | 例 |
|---|---|
| GitHub URL | `Shuffle-1992/zcode-dispatch` |
| 路径·双反斜杠 | JS 字面量 `'F:\\My Code\\zcode-dispatch\\…'` |
| 路径·单反斜杠 | yml/md 纯文本 `F:\My Code\zcode-dispatch\…` |
| 路径·正斜杠 | `F:/My Code/zcode-dispatch/…` |

### ④ profile / junction
- `runnerPath` → `F:\My Code\dsh-dispatch\collab-kit\zcode-run.mjs`
- `workRoot` → `F:\My Code\dsh-dispatch\dispatch\.data`
- junction `…\node_modules\dsh-dispatch` 重建指向 `F:\My Code\dsh-dispatch\dispatch`
  （用 `cmd /c rmdir` 删旧链接，删后立即验证目标仍在）

### ⑤ 修掉两个"改名连带伤"

1. **`node_modules/@deepseek-ai/{schemastery,cosmokit}` 悬空 junction**
   它们指向旧根的 `refs/dsh-typert/*`。改名后悬空 ⇒ `@deepseek-ai/schemastery` 解析失败
   ⇒ 插件降级为手写 fallback ⇒ `hardening.test.mjs` 的「schemastery 品牌仍在」变红。
   已重指向新根，全绿。

2. **`profile-backup/README-RECOVERY.md` 的操作指令**
   第 39 行是「如何重新启用插件」的**可执行指令**，写的是旧 bundle id `@local/zcode-dispatch`——
   照做会失败。已改为当前 bundle id `dsh-dispatch`，并加注说明；
   该文件里的事故记录（`remote.zcodeDispatch` 等）是**当时的事实**，按原文保留。

### ⑥ 文档策略

- **`tasks/*.md` 历史交付记录**：其中的旧名**按事实保留**——它们记录的是当时确实叫那个名字，
  改写等于篡改历史（残留 264 处全部属于此类）。已在 `README-RECOVERY.md` 中加注区分。
- **新增**根目录 `NEXT-SESSION-HANDOFF.md`：交接文档（路径/部署/契约/下一步/踩坑/验证命令）。

## 验证

| 项 | 结果 |
|---|---|
| 全量测试 | **31 个文件 / 478 项断言 / 0 失败** |
| `tools/verify-plugin.mjs` | **23 项，失败 0** |
| `node --check` | 8 个入口文件全绿 |
| schemastery 解析 | ✅ 修复悬空 junction 后可解析 |
| 工作树 | 干净；`HEAD == origin/main == 65b4d39` |
| GitHub | `Shuffle-1992/dsh-dispatch` 可读（改名 API 返回 200） |

## 坑（写进交接文档，防复发）

改名脚本的保护串**只写了单反斜杠**，而源码里的 JS 字面量是**双反斜杠** ⇒
根路径被一起改掉，10 个测试文件 ENOENT（ZB-41 已踩过一次，这次是**同一类坑的镜像**：
上次是"漏保护"，这次是"漏替换形态"）。**四种形态必须全覆盖**。

## 下一步

OpenCode 集成（渠道内集成 / 12 个免费模型 / 跨引擎降级）——完整方案见
`NEXT-SESSION-HANDOFF.md` §3 与 `tasks/ZB-41-design.md`。
