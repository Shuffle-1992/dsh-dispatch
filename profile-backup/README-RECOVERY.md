# profile 配置恢复记录（2026-09-30 14:0x）

## 发生了什么

14:04–14:05 两次 web boot 失败：

```
web boot: 1 entry did not activate
@local/zcode-dispatch: pending (waiting for service: remote.zcodeDispatch)
```

用户点击 DSH 崩溃对话框的 **「禁用第三方插件、备份 profile patch 并重启」**。该按钮做了三件事：

1. 把 `~/.dsh/profiles/desktop/cordis.patch.yml` 备份为 `cordis.patch.yml.bak-1790748315172`（保留 ✅）；
2. 用**出厂默认**重写 patch 与 bundles → **用户自定义配置丢失**；
3. 从 `dsh.profile.bundles` 移除所有非默认 bundle（3 个官方实验特性 + 我们的插件）。

## 恢复动作（用户选择：先恢复设置，插件暂不启用）

| 文件 | 动作 |
|---|---|
| `cordis.patch.yml` | 用 `cordis.patch.yml.bak-1790748315172` **逐字还原**（1382B，7 条全回来：agent-default-model / ui-settings-account / ui-chat / ui-settings / ui-theme / session-log-deepseek / permission）；被重置的那份留档为 `cordis.patch.yml.bak-dsh-reset-20260930` |
| `package.json` | bundles 还原为 `dsh-base` + `dsh-web-app` + 3 个官方实验特性（agent-team-profile / auto-review / schedule-bundle）；**`@local/zcode-dispatch` 未加回**（保持禁用） |

本目录留档：

| 文件 | 说明 |
|---|---|
| `cordis.patch.yml.USER-ORIGINAL` / `.RESTORED-20260930` | 用户原始配置（= 恢复后状态，1382B） |
| `cordis.patch.yml.current-20260930-1408` | 救援按钮重置后的默认配置（750B） |
| `package.json.RESTORED-20260930` | 恢复后的 profile manifest（458B） |
| `package.json.current-20260930-1408` | 救援按钮重置后的 manifest（288B） |

## 插件何时/如何重新启用

插件仍处于**已安装但未启用**状态（`dependencies` 里的软链保留）。重新启用 = 在 `package.json` 的 `dsh.profile.bundles` 里加回一行：

```json
"dsh-dispatch"
```

> ⚠️ **ZB-41 起包名已变更**：bundle id `zcode-dispatch` → **`dispatch`**、包名 `dsh-zcode-dispatch` → **`dsh-dispatch`**
> （ZB-41 去品牌化改名；ZB-43 仓库名 `zcode-dispatch` → `dsh-dispatch`）。
> 本文下方历史记录里的 `@local/zcode-dispatch` / `remote.zcodeDispatch` 是**当时的事实**，已按原文保留；
> **重新启用请用上面的 `dsh-dispatch`**。

然后**完全重启 DSH**。启用前请确认插件源码已含这两个修复（均已提交）：

- `da5633c`：客户端 `inject` 不再自声明 `remote.zcodeDispatch`（此前导致 boot 死锁）；
- `f29a0bc`：客户端 `apply` 全兜底（任何异常只降级，不冒泡）。

DSH 常驻探针（`%TEMP%\z2-verify-dsh.mjs`）含永久判据「boot 安全: inject 不自声明 remote 命名空间」，应保持 20/20。

## 若再次启动失败

救援按钮仍在（会**再次重置配置**）。重置后照本文件用 `profile-backup/` 里的留档还原即可，两条命令：

```powershell
$p='C:\Users\Administrator\.dsh\profiles\desktop'
Copy-Item "$p\cordis.patch.yml" "$p\cordis.patch.yml.bak-dsh-reset-<时间戳>"
Copy-Item 'F:\My Code\dsh-plugins\profile-backup\cordis.patch.yml.USER-ORIGINAL' "$p\cordis.patch.yml" -Force
Copy-Item 'F:\My Code\dsh-plugins\profile-backup\package.json.RESTORED-20260930' "$p\package.json" -Force
```
