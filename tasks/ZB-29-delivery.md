# ZB-29 交付：派发台思考强度（thinking / reasoningLevel）+「Agent决定」档

> **ZB-29 追加（同日，用户反馈二则）**：
> ① 进程行**模型徽标后显示实际生效思考强度**（不再显示「Agent决定」字样）——runner 对 agent 档按
> ZCode 自身默认规则解析（`optionSpecs.reasoningLevel.values` 的**最后一档**，与 headless 未显式
> 选择时 `QKe`/`v3i` 的 `values.at(-1)` registry-fallback 完全同语义）并**显式注入**，回显
> `reasoning-level=<实际档>` ⇒ `job.reasoningLevelApplied`；core 对 agent 档也透传（由 runner 解析）；
> 面板徽标/详情改显示实际档位（无法确定时隐藏，不伪造）。README/index.js 描述同步更新。
> ② 进程行改**两行布局**：上行=状态灯+进程名+模型+思考强度+徽标+文件锁；下行=时间+上下文+退出
> （`.zcd-job-head` 纵向 + `.zcd-job-line` 横行，整行仍一键开合）。
> 测试同步：agent 档断言改为「透传 + 解析成声明最后一档」；新增「未声明模型不注入+警告」分支；
> argv 捕获改独立目录（修 pid 字典序偶发读错）。全量 24 文件 144 PASS / 0 FAIL。

---

> 用户需求：① 派发台可设置模型思考强度；② 新增一档「Agent决定」——选它时由**派发的 Agent**
> 根据派发任务自己设置思考强度，不是该档时遵循设置的档位；③ 在工具使用说明/相关提示词里写清该
> 设定，让 Agent 明白怎么用。本轮编号 ZB-29（接 ZB-28b）。

---

## 一、机制结论（调查取证，ZB-29 前置调查）

| 层 | 事实 | 证据 |
|---|---|---|
| CLI（zcode.cjs 0.16.9） | `parseArgs` 选项表**逐项枚举**，无任何 thinking/reasoning 参数，也无 `--model/--provider`（它们是 runner 的参数） | bundle 内 `parseGlobalArgs` options 表 |
| ZCode 内部 | 思考强度 = 会话模型选择的 `options.reasoningLevel`；合法取值**随模型声明**（`optionSpecs.reasoningLevel.values`）；桌面 UI 有 Thought Level 下拉；日志实证会话档位 `max` 等 | `listThoughtLevels()`、`setThoughtLevel`、`session.reasoning_effort.updated` 日志 |
| **headless 注入点** | 临时 provider 配置（runner 已在生成）顶层 `config.defaultModelSelection`（`Pu` 形状 `{providerId, modelId, options:{reasoningLevel?}}`，strict）→ headless 启动读取（`Tpe.read()` → `configuredDefaultModelSelection` → `p9a`）作为**新会话**初始模型选择；`--resume` 由 ZCode 明确跳过 | `M3i` schema、`p9a`、`NodeModelSelectionConfigRepository` |
| 档位校验 | ZCode 会话创建校验（`validateSelection`/`_$o`，非法抛 `Unsupported reasoning effort`）；runner 另做前置校验（读 builtin `modelRules` 按序 overlay 得 values） | `qEn/_$o/DYa` 等 |

## 二、改动清单

### runner（`collab-kit/zcode-run.mjs`）
- 新旗标 `--reasoning-level <v>`：写入临时 provider 配置 `config.defaultModelSelection`（providerId/modelId 解析：plan=选中 builtin key；personal=源配置实际规则 id），并打确认行
  `[zcode-run] reasoning-level=<v> target=<providerId>/<modelId>`（core 解析为 job.reasoningLevelApplied/reasoningTarget）。
- **fail-fast**：目标模型在 builtin 声明了档位集合而请求值不在其中 → 拒绝派发并列出可用值（防静默按默认档跑）。
- **resume 语义**：`--resume` + 档位 → 警告并忽略（ZCode 沿用原会话档位），core 层也不透传。
- `--list-providers` 扩展：输出 `[zcode-run] reasoning-levels <model>=<a,b>`（按模型声明探测；面板下拉与 Agent 查询的数据源）。

### core（`core/dispatch-core.mjs`）
- `spec.reasoningLevel`：可选字符串；'agent'=Agent决定（**不透传** runner = 不覆盖）；validateSpec 拒绝空/非字符串。
- `buildRunnerArgs`：非 agent 且非 resume → `--reasoning-level <v>`。
- job 字段：`reasoningLevel`（请求档）、`reasoningLevelApplied` + `reasoningTarget`（runner 确认注入）。
- `parseProviderTable`：解析 reasoning-levels 行 → `modelLevels`；`listChannels` → 每通道 `thinkingLevels`（通道模型档位并集；缺失=不猜，字段缺省）。
- retry 交接重跑 spec 沿用原任务档位。

### wire（`wire.host.mjs`）
- dispatch 动作：`thinking` 参数 → `spec.reasoningLevel`；slimJob spec 投影带 `reasoningLevel`。

### 工具与提示词（`index.js`，用户要求③的落点）
- 工具参数 `thinking`（无 enum——档位随模型声明；描述里指明以 `channels[].thinkingLevels` 为准）。
- 描述正文 dispatch 行 + **「思考强度」专条**：写明 Agent决定契约——
  「传 agent 时由你（调用方）按任务判断并**改传具体档位**（查询/机械 ⇒ disabled；复杂推理/架构 ⇒ enabled/high/max），判断后**不要传 agent**；确无把握才保持 agent（=模型默认档）」+ 四条规则（档位随模型声明/fail-fast/仅新建会话/job 可核对字段）。
- `SYSTEM_PROMPT_SECTION` 增加一句同语义提示（常驻提示词，短句控制 token）。
- channels 动作行说明 `thinkingLevels`。

### 面板（`client.js` + `locale/{zh,en}.json`）
- 派发栏新增「思考强度」下拉：`Agent决定（按任务判断）`（默认）+ 当前通道 `thinkingLevels` 的档位
  （旧 runner 无数据 ⇒ 只显示 Agent决定，不猜）；提交时 `spec.thinking` 透传。
- 进程详情行显示档位（agent → 「Agent决定」文案）。文案四处同源（single-source ⑤ 绿）。

## 三、测试与验收

- **新增 `test/thinking-level.test.mjs`（7 项）**：
  ① parseProviderTable 档位行解析；② parseRunnerLine 注入确认行；③ listChannels thinkingLevels
  （plan 别名继承、personal 无数据不猜）；④★ core 透传（具体档 → `--reasoning-level`；
  'agent'/未指定 → 不透传 + job 字段 + Applied 确认 + validateSpec 拒绝）；⑤ wire thinking→spec 映射；
  ⑥ retry 交接沿用档位；⑦★ **runner hermetic 干跑**（假 CLI 零网络：defaultModelSelection 精确落盘断言、
  未指定不写键、非法档位 fail-fast 列可用值、resume 跳过+警告）。
- **全量门禁**：24 个测试文件全部绿（含 single-source 31、header-entry 102 等）；`node --check`
  四文件 + runner 通过；`tools/verify-plugin.mjs` 21/21。
- **真机观测**（可选，会消耗极少量额度）：派发带 `thinking=enabled` 后，job 的
  `reasoningLevelApplied=enabled` 即为 runner 注入确认；ZCode 侧档位生效以会话创建不报错为准
  （非法档位会 fail-fast 并列出可用值）。

## 四、复现命令

```powershell
cd "F:\My Code\dsh-dispatch\zcode-dispatch"
node --test test/thinking-level.test.mjs   # 7/7
node test/single-source.test.mjs           # 31/31（文案四处同源）
node collab-kit 不可用；runner 探测：
node ..\collab-kit\zcode-run.mjs --list-providers | Select-String 'reasoning-levels'
#   → [zcode-run] reasoning-levels GLM-5.3=disabled,enabled
#   → [zcode-run] reasoning-levels deepseek-v4.1-flash-…=disabled,low,high,max
```

## 五、未确定项（宁缺毋编）

1. **ZCode 侧档位最终生效**未真机跑任务验证（headless 启动读 defaultModelSelection 的链路已由
   bundle 源码证实：`Tpe.read()` → `configuredDefaultModelSelection` → `p9a` 会话初始选择；
   runner 注入行 `reasoning-level=…` 与 job.reasoningLevelApplied 提供派发侧确认）。可随时用一次
   极短派发验证：`thinking=enabled` 派发 → job.reasoningLevelApplied=enabled 即注入成功。
2. **档位集合的合并语义**按「modelRules 数组按序 overlay、后命中覆盖」实现（与 ZCode ConfigOverlay
   同序）；若某模型声明与实际可用集有出入，以 ZCode 会话创建的 fail-fast 报错为准（列出可用值）。
3. 桌面端 `account:*` provider 声明的档位（日志见 `max`）可能多于 CLI builtin 声明 —— 派发台走
   CLI 声明为准；若上游扩展档位，`--list-providers` 探测会自动跟随（读同一份 builtin 配置）。
4. 面板下拉在旧 runner（未升级）下只有 Agent决定一项 —— 成对升级后自动出现档位集。
