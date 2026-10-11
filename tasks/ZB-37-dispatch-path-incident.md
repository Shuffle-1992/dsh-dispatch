# ZB-37 事故复盘：agent 绕过派发台直跑 runner —— 真因是 schema 把免费额度通道挡在门外

> 用户报告：「我在另外一个会话让 Agent 用派发台派发任务，它派发的方式是后台模式，不是 ZCode 派发台。
> 是否教学或提示词等有不清晰的地方？」
> 结论：**教学说了要用派发台，agent 也确实用了（17 次工具调用）—— 但工具 schema 与教学自相矛盾，
> 把免费额度通道排除在可选目标之外**，于是它只能派到付费通道，撞了 Coding Plan 5 小时限额后
> 转而用后台 `pwsh` 直跑 runner。已修。

## 一、现场还原（会话 `session-6086496e`，cwd = keysion dac vue，2026-10-11）

| 时间 | agent 动作 | 结果 |
|---|---|---|
| 12:05:20 | 用户：「**使用派发台**，派发任务…任务1/2/3 各 2 组…按顺序派发，如果额度足够」 | — |
| 12:05:38 | `action=status` | 开关 on（遵守教学 ✓） |
| 12:05:41 | `action=channels` | 看到通道清单（含免费额度通道）✓ |
| **12:06:33** | `action=channel {provider:"account:bigmodel-start-plan"}` | ❌ **`invalid arguments: "provider" must be one of ["plan","personal"]`** |
| 12:06:38 | `action=quota` | 读到本机用量 |
| 12:06:59~12:07:20 | `dispatch` ×3，**只能传 `provider:"plan"`** | 三个作业全部 `paused / quota-exhausted`（**HTTP 429 code=1309**：Coding Plan 5h 窗口满） |
| 12:07:26 | `action=list` | 看到 paused |
| 12:07:33 | `action=fallback {chain:["account:bigmodel-start-plan"]}` | ✓ 自己想到了降级链（说明它在努力留在体系内） |
| 12:07:37 / 12:07:53 | `action=retry` / 派 `probe-fallback` | 探针在免费通道 `exit=0` ✓（降级链生效） |
| **12:09–12:10** | **`pwsh` + `run_in_background` 直跑 `collab-kit/zcode-run.mjs --provider start-plan` ×6** | 就是用户截图里那 6 个 DSH 后台作业 |
| 12:11:05 | 自查汇报 | 承认先前判断「降级链未生效」有误；最终路径写成「CLI 派发器 + DSH 后台作业承载以便完成时被唤醒」 |

## 二、三个根因（按因果顺序）

1. **【致命】工具 schema 的 `provider` 枚举与教学矛盾**：描述里写「接受 channels 清单里的任意 id」，
   schema 却是 `enum: ['plan','personal']` ⇒ **agent 没有任何合法途径把免费额度通道作为派发目标**
   （`dispatch`/`channel`/`retry` 的 provider 参数全被枚举挡住）。`model` 同样问题（`deepseek-flash` 等
   清单内模型也传不进去）。这才是它"走歪"的起点。
2. **没有"撞额度后怎么办"的操作手册**：教学讲了「能用派发台就用派发台」「不可用才退回后台 jobs」，
   但没讲「**通道撞 429 时该换通道/开降级链 + retry**」，也没讲「**不要用 pwsh 直跑 runner**」。
   于是 agent 把"付费通道撞限额"误判成"派发台不可用"，退回后台作业。
3. **看不到"哪个通道刚撞过额度"**：`plan` 在清单里始终 `enabled=true`，撞限额只能靠撞了才知道；
   付费套餐的 limit/remaining 本就不在引擎 RPC 面（`core/quota.mjs` 已注明），但**台账里有 429 记录**。

## 三、修复（本次提交）

| 修复 | 位置 | 说明 |
|---|---|---|
| ① **去掉 `provider` / `model` 的 enum** | `index.js` 工具 schema | 与 `thinking` 同一条纪律：合法取值随账号/清单变，权威来源是 `action=channels`。描述里写明 `account:<family>-start-plan`=免费额度 |
| ② **工具描述补两条硬规则** | `index.js` 描述正文 | 🚫「不要用 `pwsh`/`Bash` 直接跑 `collab-kit/zcode-run.mjs`（含 `run_in_background`）」——列出会丢什么（文件锁/台账分账/面板可见性/暂停分类/降级链），并说明「落地自动唤醒」派发台本来就有；🔁「额度撞顶怎么办」四步：看 channels 额度 → 直接 `provider:"<通道 id>"` 换通道派发 → 或 `fallback`+`retry` 交接 → 不要退回后台 jobs；💰「派发前先看 `quotaText`/`giftQuota`」 |
| ③ **`action=channels` 标出"最近撞过额度"的通道** | `wire.host.mjs` `recentQuotaExhausted()` / `matchQuotaExhausted()` | 读台账（runner 识别 429 时写 `rateLimited:true`），取最近 5 小时（与 Coding Plan 滚动窗口同尺度）；provider 归一命中通道 id 或 `aliasOf`；只**提示**（`channels[].recentQuotaExhausted` + `quotaNote`），不擅自改 `enabled` |
| ④ 面板同步显示 | `client.js` + `locale/{zh,en}.json` + 内嵌 `STRINGS` | 通道下拉对已标记通道追加「（5 小时窗口已满）」（文案两处对称，`single-source` 哨兵把关） |

## 四、验证

- **新测试 `test/channel-health.test.mjs`（4 项）**：① schema 不得有 enum（连同事故原文的报错值）；
  ② 描述必须含两条硬规则；③ `recentQuotaExhausted` 认窗内 429、忽略超窗、provider 归一命中
  （`plan` 别名与 `builtin:...` 真实 id 都命中，免费额度通道不误标）；④ `attachGiftQuota(…, ledgerPath)`
  把标记挂到通道上（面板与工具同源）。
- **真机复现**：当前台账里的那条 429 → `plan` 通道 `recentQuotaExhausted=true`，
  免费额度通道不误标且仍显示 `剩余 279.9M / 300.0M（93%）`。
- 派发台测试套件 **29/29**（含新测试）；`tools/verify-plugin.mjs` 23/23。

## 五、给下一次的判据（写进工具描述，这里留摘要）

1. 派发前：`action=channels` → 看 `enabled` / `recentQuotaExhausted` / `quotaText`。
2. 目标通道撞 429：**换通道**（`dispatch {provider:"<通道 id>"}`）或 `fallback {chain:[...]}` + `retry`。
3. **任何情况下都不要** `pwsh` 直跑 runner —— 派发台自己会在 job 落地时唤醒你。
4. 只有在 `action=status` 显示开关关闭、或 `dispatch` 返回 `ok:false`（未配置/lock 冲突）时，
   才退回 DSH 自带 subagent/后台 jobs，且**要说明原因**。
