# 踩坑记录（pitfalls）

> 按全局规则维护：遇到踩坑问题登记于此，避免重复踩坑。新条目置顶。

## 2026-10-18 派发测试暴露的四条真坑（8.3 短名 / 假成功 / 换模型 / 403）

### ① Windows 8.3 短名路径会让 Qoder **静默拒绝写文件**（任务却报 done）

现场：用 `C:\Users\ADMINI~1\AppData\Local\Temp\…`（`$env:TEMP` 的展开值，`ADMINI~1` 是 `Administrator`
的 **8.3 短名**）作 cwd 派 Qoder 写任务。Qoder 的路径安全门直接拒绝：

> This path uses suspicious Windows path syntax that could bypass security checks:
> `/c/Users/ADMINI~1/…`. Please use a standard path format.

而任务**报 `exit=0` / `done`**（模型写了段解释就 end_turn）—— **文件根本没创建**。
换成长路径 `C:\Users\Administrator\…` 后一次通过（12.7s 写成 `hello.txt`）。

**为什么难查**：`permissionMode` 完全正常（`accept_edits` → `acceptEdits`，未回落），
`permission_denials` 为空，所以"权限回落检测"看不见它 —— 拦它的是**另一条独立的安全门**。

**修法**：core 的 `validateSpec` 对 `cwd` 做**尽力长路径展开**（`realpathSync.native`，
只对含 `~数字` 段的 Windows 路径动手，失败绝不抛），并落一条 `parseWarnings` 说明。
**纪律**：脚本里**不要用 `$env:TEMP` 直接当 cwd**；要传路径就用长名（或让插件展开）。

### ② 「零工具调用 + 报成功」= 静默假成功，必须报警

Qoder 结果文件里 `toolCount: 31` 是**引擎可用工具总数**（来自 `init.tools`），**不是本次调用**。
真机两次任务（一失败一成功）的旧结果文件里都看不出"到底动手没有"。

**修法**：执行器新增 `toolCalls`（本次实际调用的工具名，按次序）；
并加两条静默失败检测：回答里出现 `denied|blocked|approval|suspicious Windows path|requires confirmation`
且无 denials ⇒ 报警；**声明要写文件却 `toolCalls=0`** ⇒ 报警。
（旧检测的关键词表只有 `denied|permission|allow it`，**漏掉了 `Blocked`/`approval`/`suspicious`**。）

### ③ 顺序派发换模型时**根本没换模型**（10 次尝试全打在同一个模型上）

现场：opencode 顺序列表配了 10 个模型，任务失败后连跳 9 次，
但 **10 次尝试的 `result.json` 里 `model` 全是 `opencode/deepseek-v4.1-flash-free`**。

根因：`retry()` 的"同会话续跑"判据只看「通道相同 + 引擎没变」；顺序派发换模型恰好满足
（同 provider、同引擎、只换 model）⇒ 落进 resume 分支 ⇒ `delete spec.model`
（`--resume` 带 `--model` 必失败）把目标模型丢掉。
**修法**：判据加 `modelChanged`（换模型 ⇒ 必须交接重跑）。

### ④ 上游错误事件不在 stderr ⇒ core 看不见，于是被反复重试

OpenCode 的 403 错误只在 stdout NDJSON 的 `{"type":"error"}` 事件里，**`err.log` 是 0 字节**
⇒ `classifyPause` 看不到原文 ⇒ 停在 `failed/unknown`（无原因）+ 被当成"换模型再试"反复重试。
**修法**：执行器把 `error.data.message` + `statusCode` 原文透传到 stderr；
core 新增暂停原因 `provider-blocked`（`FreeTierError`/`abusive traffic`），
并加入 `NO_SEQUENTIAL_REASONS`（按 IP 封锁时同引擎换模型必然同样失败 ⇒ 直接交回跨通道降级链）。

**顺带一条环境事实**：本机 Clash Verge 代理出口 `157.254.20.4`（机房 IP）被 OpenCode 风控标记，
**该 IP 下所有 opencode 免费模型一律 403**（`isRetryable:false`）；换住宅节点或付费通道才可用。
**与插件无关** —— 手动跑同样的 CLI 命令同样 403。

## 2026-10-17 全面 review 暴露的三条"隐性坑"（断言/口径/死代码）

1. **假保护断言：用"已改名的旧常量"做反断言 ⇒ 恒绿、零保护，却读起来像在守门。**
   实例：`header-entry.test.mjs` 的 A3 `!/ctx\.slots\.inject\(SLOT,/` —— 常量早已改名 `FALLBACK_SLOT`，
   正则永不匹配，永远绿。**教训：写反断言必须钉"当前代码里真实存在的字面/结构"，并顺手验证"故意改坏它会不会红"
   （负向测试自己的断言）。** 已在 2026-10-17 改为会真红的结构断言。
2. **`Get-Content` 数行数会少算**：本仓注释里含**裸 CR**（`\r`）时，PowerShell 的 `Get-Content` 会把若干行并成一行
   （实测 `notify.mjs` 报 298 行、真实 347 行）。**行号/行数一律用 read 工具或 node 统计**，否则审计报告的行号会整体错位。
3. **"看起来死、其实活着"的文案键**：客户端 39 个文案键在源码里搜不到 `t('key')` 字面（只被 `KIND_KEY`/`THINKING_LABEL_KEY`/
   `ENG_GROUP_KEY`/`seqUse*` 这类**映射表**间接引用）。**删键前必须把映射表也扫一遍**，否则删掉的是活键（表现为运行时显示原始 key）。

## 2026-10-17 DSH 0.2.1：重组合会替换 link 插件的新代码（不必重启），但**替换会 kill 掉 running job**

**实测事实（不是推测）**：DSH 主进程自 17:48:09 起**从未重启**，但 `dispatch/.data/state/activation.json` 在
18:08:36 与 18:12:03 **被重写两次**（= 插件 `apply()` 重跑 = 插件被就地替换）；同一时段两条硬证据：
真机 `dispatch action=list` 返回了新代码才有的 `shape:"brief"`/`counts`/`note`，活体 `cordis_inspect_query`
host/Tool 里 `dispatch` 工具的 parameters 出现了新代码才有的 `limit`/`full`。

1. **机制（0.2.1 新增能力）**：重组合（recomposition）时会替换**磁盘上已变化的 link 包目标** ——
   0.2.0 时代重组合只会**重新 apply 已缓存的模块**（所以那时"改 host 必须重启"是对的）。
   ⇒ 正确表述：**host 代码改动会在"下一次重组合"时生效（不必重启）**；重组合由 profile patch/manifest
   变更与插件管理器操作触发。
2. ⚠️ **但落盘本身不触发重组合**：18:18 只 `touch` 了 `index.js`（mtime 变、内容不变），等满 2 分钟信标毫无变化。
   （18:11 那次 touch 后 30s 出现了替换，事后看是"恰好赶上一轮重组合"。）⇒ **别把"改完就自动生效"当保证**，
   判据永远用信标/活体 schema，要确定性生效就重启：
   - `Get-Item dispatch\.data\state\activation.json | Select LastWriteTime`（时间变新 = 插件重跑过）；
   - `cordis_inspect_query {platform:'host',provider:'Tool',method:'listTools'}`（看新参数/新描述在不在）。
3. ⚠️ **最要命的一条：替换 = 卸载 + 重新 apply，而卸载清理会 kill 所有 running/queued job** ——
   `dispatch/index.js` 的 `disposeAll()` 里 `dispatcher.kill(j.id, 'plugin unloading: dispatcher disposed')`。
   ⇒ 纪律：**改宿主半边文件之前先确认没有 running/queued job**（`action=list` 一眼可见）。
   注意触发权不在你手里：改完代码后，**别人/别处任何一次重组合**（比如在设置里拨一下插件开关）
   就会执行替换并杀掉当时正在跑的任务。
4. **因此不要**把本插件目录写进 `hmr.config.root`（"存盘即重载"在这里 = "存盘即杀 job"）：这是**负向**优化。
   2026-09-30 第 3 条已给过同样的告诫，0.2.1 下更要守住。客户端半边（`client.js`/locale）仍以**刷新页面**为准。

## 2026-10-05 ZB-27（会话标题行入口改弹窗；以及「批量改大文件的锚点自伤」）

用户反馈：入口与同排不一致、弹窗要像子智能体那样悬浮在旁边、取消右下角最小化药丸。
样式对齐的权威来源是**同槽位的官方实现**（`dsh-client-ui-jobs` 的 job-list）：触发 `border:0;background:none;padding:3px 2px;min-height:28px;font-size:12px;line-height:18px;gap:3px;color:label-tertiary`，
弹层 `position:absolute;top:calc(100% + 5px);background:var(--dsw-specific-menu);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);max-height:min(480px,100vh-140px);overflow:auto`。
**教训：要"与系统协调"就去抄同槽位官方实现的 CSS，别自己设计**（我第一版做成带边框圆角药丸 + 10px 徽标，一眼就不协调）。

### 事故：用 `includes()` 找行锚点，撞上同一句话的第二处 → 一次删掉 2200 行

- **怎么发生的**：改 `client.js`（2600+ 行）时用脚本按行号区间做替换，锚点写作
  `lines.findIndex(l => l.includes('ZB-24：会话标题行入口'))`。这句话在文件里有**两处** ——
  一处是第 44 行的 slot 注释，一处是第 2222 行 `HeaderEntry` 前的块注释；`findIndex` 取到第 44 行，
  于是把 **44..2249 共 2200 行**整段替换掉了（CSS、STRINGS、四个 wire 实现、全部区间组件…）。
- **为什么没当场发现**：`node --check client.js` **照样通过** —— 删剩的部分仍是合法 ES 语法
  （引用了已不存在的标识符只是运行期错误，不是语法错误）。是随后跑测试才暴露。
- **正解（三件套）**：
  1. **先回滚**：`git restore -- <file>` 回到 HEAD（本轮这样做了，代价近零）；
  2. **锚点从唯一标识反查边界**，不要拿"句子"当锚点：
     向前找最近的块注释起点、向后找函数闭合或**已知的后续标记**（例如下一段函数的注释），
     并对首末行各做一次 `includes()` 断言；
  3. **写盘前打印首末行 + 不匹配就 abort**（本轮重做时脚本里加了 `die()`，四处 splice 全部先校验再写）。
- **附带**：`Get-Content | Measure-Object -Line` 与 read 工具报的行数**不一致**（前者不统计空行：
  同一文件 2659 vs 2718），别用它判断文件长度或做偏移。

### 事故：样式注入挂在"按需挂载"的组件上 → 常驻入口裸奔（用户现场「字号不对 + 有背景色」）

- **现象**：会话标题行的入口胶囊字号明显大于同排、且带一块宿主按钮底色。
- **真因不在 CSS 数值**，而在**注入时机**：`ensureStyle()`（唯一把插件样式写进 `document.head` 的地方）
  原先只挂在**弹窗组件 PanelBody 的 effect** 上 —— 而弹窗要用户点开才挂载 ⇒ 入口在首次点开之前
  **完全没有插件样式**，用的是宿主对 `<button>` 的默认样式（继承字号 + 底色）。
- **正解**：把注入提到 `apply()` 内、**槽位注册之前**（`try { ensureStyle(); }`）—— 常驻入口一出现就带样式；
  弹窗里的那次保留作兜底（幂等）。
- **顺带加固**（同一处现场暴露的两个脆弱点）：
  ① 选择器加作用域 `.dsp-entry .dsp-chip`（0,2,0）压过宿主形如 `.headerActions button` 的规则，
     并显式 `appearance:none` + `background:transparent` + `box-shadow:none`；
  ② 颜色一律走主题令牌（`T.*` = `--dsw-alias-*` 带回退），**规则里不出现字面色值** ⇒ 明暗两套主题自适应。
- **门禁**：`header-entry.test.mjs` 新增 B11–B15（作用域/appearance/透明底/无字面色值）与 F1–F3
  （apply 内注入且早于注册）——「入口样式来自哪里、什么时候注入」现在是可断言的事实。

### 事故：给第三方入口写 `font-family:inherit` → 与同排官方入口"字号不一致"（查了三轮）

- **现象**：会话标题行的「DSH 派发台」入口字号看着比同排的「子智能体/智能体团队/创造模式」大，
  反复调 `font-size` 都不对（12px 明明与官方实现声明值相同）。
- **真因**：**font-family 不同，不是 font-size**。邻居都是 `<button>`，而全仓**没有**全局
  `button{font:inherit}` ⇒ 它们渲染用的是 **UA/平台按钮字体**；我写了 `font-family:inherit`
  ⇒ 用**应用字体**。同为 12px，应用字体 x-height 更大 ⇒ 观感更大。
- **又一个坑**：中途想用系统字体关键字补救，写了 `font:button` —— **这是无效声明**
  （CSS 系统字体关键字只有 `caption/icon/menu/message-box/small-caption/status-bar`，**没有 button**），
  整条被丢弃，于是"改了等于没改"。
- **正解**：**元素类型与邻居一致**（`<button>`）+ **不声明 font-family**（让 UA 按钮字体生效），
  只用 `!important` 锁 `font-size/font-weight/line-height` 到与邻居相同的**有效**值
  （邻居 button 的有效字重是 UA 的 400 —— 写 `inherit` 会继承容器权重、更粗）。
- **方法论**：要"与系统某元素一致"，先去 asar 里读**同槽位官方插件**的 CSS，并把"元素类型"
  也算进一致性的一部分；**别在第三方入口上写 font-family:inherit**，那等于主动与按钮类邻居分家。
- **判据工具**：`node tools/asar-cat.mjs /dsh/node_modules/@deepseek-ai/dsh-client-ui-<pkg>/lib/client.js` +
  正则找 `_trigger{`；比截图猜测快得多。桌面版（Electron）与网页版加载的是**同一份客户端 bundle**，
  所以这类差异与"桌面/网页"无关。

### 教训：别对 minify 产物做"肉眼对照"，DSH 是开源的 —— 直接读源码

- **背景**：为了把「DSH 派发台」入口调成与同排一致，我连续三轮从 `app.asar` 里的 **minify 产物**
  里抠 CSS 字符串、再并排比对截图，结果两次押错参照物（先按 job-list，再按「创造模式」）。
- **正解**：DSH 开源在 **`github.com/deepseek-ai/deepseek-harness`**（"Everything is a Plugin"）。
  源码路径与包一一对应，例如 `@deepseek-ai/dsh-client-ui-jobs` →
  `packages/client/ui-jobs/src/client/JobListAction.{tsx,module.css}`。
  读源码立刻拿到**产物里没有的东西**：
  - **元素类型**（`<button type="button">`），而 CSS 里**根本不声明 `font-family`** —— 这正是"字号看着不一样"
    的根因（第三方入口若写 `font-family:inherit` 就变成应用字体，与按钮类邻居分家）；
  - **设计意图注释**：`AgentPresetLabel.module.css` 开头写着
    "Session-header agent-preset label: **static chrome, never a control**" ——
    「创造模式」是被动装饰（窄屏 `@container (max-width:540px)` 优先隐藏），**不该拿它当交互入口的参照**；
  - **尺寸也不是猜的**：同槽位的 jobs 用 `<IconChevronDownOutlineRegular size={12} />`，
    而子智能体用默认 14 —— 官方自己就不同，选谁取决于你模仿哪一个。
- **取源方式**（本机 raw.githubusercontent.com 直连失败，走 git 那条代理即可）：
  `Invoke-WebRequest -Proxy http://127.0.0.1:7897 -Uri https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/<pkg>/src/client/<File>`
  或先列目录：`https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/<path>`。
- **纪律**：凡是"要与系统某元素一致"，先找**同用法的官方实现**读源码对齐；不要从压缩产物反推，
  更不要凭截图猜度量。

### 坑：PowerShell `Set-Content -NoNewline` 接数组会把整个文件压成一行

```powershell
(Get-Content file.js) -replace 'a','b' | Set-Content file.js -NoNewline   # ❌ 全部行拼成一行
```
`-NoNewline` 用于`Set-Content`时**不会**给数组元素之间补换行 ⇒ 2602 行的 client.js 变成一行，
`node --check` 报 "Unexpected end of input"（语法直接废掉）。
- **正解**：要么用编辑工具/编辑器做替换；要么 `-join "\`n"` 后配合 `-NoNewline`，或
  `[System.IO.File]::WriteAllText(path, text)`；纯文本替换优先用 `edit` 工具。
- **配套纪律**：批量改文件前先 `git status` 确认工作区干净，出事立刻 `git restore -- <file>`
  （本轮就是这样 3 秒回滚到已提交状态，只损失两处未提交微调）。

### 真实 bug：共享的模块级样式表被"按需挂载"组件的卸载清理删掉（用户描述：「悬浮之前正常，悬浮失焦后就不正常」）

- **现象**：会话头入口在**首次悬浮之前**显示正常；**悬浮（打开面板）→ 失焦（关闭面板）后**就变得
  "字变大、位置偏下、对不齐"。
- **真凶**：样式表是**模块级单例**（`ensureStyle()` 注入一张 `<style>` 到 head），却被两个组件各自
  "挂载时注入、卸载时移除"：
  - 会话头入口 `HeaderEntry`（常驻）；
  - 面板 `PanelBody`（**按需挂载**，关闭即卸载）。
  ⇒ 面板一关闭，`PanelBody` 的清理函数直接 `detachStyle()`，把整张样式表从 head 删掉，
  常驻的入口随即失去全部样式、退回浏览器默认按钮外观。
- **实测证据（决定性）**：同一枚入口，面板开/关两个状态的盒子：
  ```
  面板打开 aria-expanded=true   w=58 h=28 top=51   ← 样式在
  面板关闭 aria-expanded=false  w=66 h=19 top=56.5 ← 样式没了（UA 默认按钮）
  ```
  这也解释了为什么"静态测量此前一直显示与邻居一致" —— 那些快照取自**从未打开过面板**的会话。
- **正解**：**引用计数**。`ensureStyle()` 每被持有一份就 +1 并返回释放函数，只有计数归零才真正
  `detachStyle()`；`apply()` 持有一份且永不释放（插件活着，样式就在）。组件卸载时只释放自己那一份。
- **纪律**：**"注入即清理"只适用于独占资源**；一旦资源被多个生命周期不同的组件共享（模块级单例、
  全局样式、共享 store），就必须引用计数或把所有权上移到插件生命周期 —— 否则"先卸载的那个"
  会把别人正在用的东西拆掉。
- **回归测试**：`panel-style.test.mjs` 新增 B6–B8（断言引用计数存在、只有归零才 detach、
  **禁止**任何组件卸载时直接 detachStyle()）。

### 方法：判定"某元素与系统不一致"到底要测哪些属性（以及怎么**免 DevTools** 取到实测值）

排查"入口看着比邻居大/不齐"这类问题时，**只测 font-size/font-weight/font-family 是不够的**——
我按这三项对齐了四五轮，实测一直"一致"，但用户看到的差异始终存在。真正该测的清单：

| 类别 | 属性 |
|---|---|
| 排版 | `font-size` `font-weight` `font-family`（**完整串，别截断**）`line-height` `letter-spacing` `word-spacing` |
| 字体特性 | `font-style` `font-stretch` `font-variant` `font-feature-settings` `text-rendering` `-webkit-font-smoothing` |
| 渲染影响 | `text-shadow` `transform` `zoom` `color` |
| 几何 | 盒 `getBoundingClientRect()` + **字形盒**（`Range.selectNodeContents`，紧贴文字，不受盒模型干扰） |
| 其余元素 | 图标 svg 的盒/位置/`strokeWidth`/`transform`（常被忽略） |

**决定性实验**：用**同一段文字**分别套上"我的字体"与"对照元素的字体"离屏渲染（`position:absolute;visibility:hidden`），
比对宽高。两者相同 ⇒ 差异**只可能来自文字内容**；不同 ⇒ 差异在字体/渲染链上，再逐项二分。

**免 DevTools 取实测值的通道**（本项目实测可用）：客户端把测量结果写进 `localStorage`，
Chromium 会落盘到 `%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb\*.log`，
排查方用 Node 读该文件、按 UTF-16LE 解码并做括号配平即可取回 JSON —— 无需用户开 DevTools 或截图。
（注意：值是 UTF-16LE；数组较大时可能被 leveldb 分块，按"单条 + 括号配平"解析最稳。）

**另一个更重要的教训**：如果差异是**状态性**的（"悬浮之前正常、悬浮之后不正常"），
那多半不是样式值的问题，而是**状态残留或资源生命周期**问题 —— 本项目最后就是
"共享样式表被按需挂载的面板卸载时删掉"（见上一条），静态对齐永远修不好。

### 坑：重构容器时丢掉"基础字号"，整块 UI 悄悄变大

- **现象**：面板内"进程"等板块的文字比同级官方弹层明显大。
- **成因**：浮窗时代容器是 `.dsp-root{font-size:12px;line-height:1.6}`；ZB-27 改弹窗后容器换成
  `.dsp-menu`，我**只搬了布局与令牌、漏了字体基准** ⇒ 所有**未显式写 font-size** 的元素
  （进程行、`.dsp-dim`、下拉/输入框、按钮…）都去继承应用根部（≈14px）。而写了字号的又是
  10 / 10.5 / 11 / 12px 混杂，视觉上更乱。
- **正解**：容器**必须显式给出基础字号**（此处对齐官方弹层主行 12px/17px），并把零散值收敛成
  官方三档 —— **12/17（主）· 11/16（次）· 10/15（元）**，删掉 10.5px 这类中间值。
- **纪律**：**换容器 = 重新声明继承起点**。迁移一个容器的样式时，除了显式规则，务必检查
  "哪些子元素是靠继承拿字体的"，否则那部分样式会**静默**跟随新的祖先。

### 坑：`onBlur` 的 `relatedTarget` 为 null 不等于"焦点离开"

- **现象**：悬浮展开面板后，**点击弹窗内任何位置**（例如进程行头这种 `div[role=button]`）面板就被关掉。
- **成因**：点击**不可聚焦**元素时浏览器把焦点移到页面根，`focusout/blur` 的 `relatedTarget` 为 **null**；
  我原来的逻辑"不在子树内 ⇒ 关闭"把这个也算作离开 ⇒ 弹窗内每次点击都触发关闭。
- **正解**：**只有 relatedTarget 非空且不在子树内**（焦点明确移到了别的元素）才关闭；
  `relatedTarget === null` 直接 return。"真正离开"交给鼠标移出、点组件外部、窗口失焦三条路径。
- **纪律**：用 `onBlur` 做"失焦关闭"时，先想清楚**你能否区分**"焦点去了别处"与"焦点落空"。

### 方法：第三方插件的 UI 排查要"查三条链"（profile 装载链 / 令牌定义链 / 级联链），别只看截图

排查「入口颜色/字号与系统不一致」时，按顺序用**可验证事实**排除，比反复对截图快得多：

1. **装载链**：profile 里的插件是 **Junction 软链**还是安装时拷贝？
   `Get-Item <profile>\node_modules\@local\<pkg> -Force | Select LinkType,Target` +
   比对 `Get-FileHash` —— 软链且哈希一致才说明"用户跑的就是我改的文件"（本轮据此排除了"旧缓存"假设）。
2. **令牌定义链**：client Inspect 有 **`Theme.listTokens`**（当前构建的官方令牌清单与说明），
   再用 `asar-grep '--dsw-alias-xxx:'` 到 `dsh-client-ui-theme` 里读**真实取值**。
   本轮实测（暗色）：`label-primary`=bluish-50、`label-secondary`=bluish-300、`label-tertiary`=bluish-400
   ⇒ 邻居那种灰 = tertiary，而 `:hover/:focus-visible` 变亮到 secondary（官方 jobs 的 `.trigger:hover` 同款）。
3. **级联链**：把**运行时会注入的 CSS 文本导出来体检**（括号平衡、规则原文、有没有被吞掉的声明）。
   做法：用 React 桩在 Node 里 `mod.apply(...)` → 读 `document.head` 里那条 `<style>.textContent`，
   检查 `{/}` 计数与目标规则原文。本轮 94/94 平衡、规则原文正确 ⇒ CSS 不是嫌疑。
4. 三条都干净时，**剩下的差异基本就是"交互态"**（对方的截图里指针停在我的入口上）。
   与其继续调数值，不如把状态差异也变成确定性代码（颜色改内联 + React 状态表达），并请用户**移开指针**再截图。

### 另记：清理"死代码"时要先确认它真的没人用

删浮窗样式时把 `.dsp-iconbtn` 当死代码删掉，随后发现 **JobRow 的终止/重跑/续接/关闭四个按钮仍在用它**。
教训：删 CSS 前用 `grep 'className: ...'` 反查类名在 JSX 里的使用点；`.dsp-root` 这类被删掉的**容器**类
才适合整组删。

## 2026-10-05 ZB-22（派发台落地自动唤醒；以及「host 代码改动何时才真生效」）

现场问题（用户报告）：「派发任务时会话窗口不等待、直接继续；任务跑完没人叫醒它，得我自己再发一句。
DSH 自带的后台任务完成时会自动把会话拉起来，派发台也应该这样。」

1. **第三方插件派出去的后台工作，宿主**不会**替你叫醒会话 —— 必须自己投递通知**。DSH 自带 `job_*` 的那套（`@deepseek-ai/dsh-tool-jobs`）是它自己的实现，不是通用服务：它在 job 落地时把一条 user 角色消息投进**发起它的那个会话**（空闲 `agent.followup` 开新一轮、忙碌 `agent.inject` 插下一步）。派发台原来只有 `dispatch`（fire-and-forget）+ `wait`（主动等），于是「会话不等待」这个正确行为变成了「跑完没人叫醒」这个错误体验。正解就照它的契约抄：`exec.agent.id`（工具 `execute(args, exec)` 第二参）登记归属 → 订阅 `dispatcher` 的 `job-updated` 判落地 → `ctx.get('agents').get(会话id)` 投递。DSH 那侧的三个实现细节必须一起抄对：① 判据用「终态 **+ paused**」（paused 也要人来决定续跑/换通道，干等是错的）；② `form` 只能写 `'notice'`（客户端 `contextBody` 对未知 form 直接 `throw unreachable context form`，不是降级渲染）；③ 自己 kill 的、自己 `wait` 已等到落地的 job 要**抑制**通知（否则「自己做的事又叫醒自己」，对应它的 `killedByModel`/`awaited`）。证据：test/notify.test.mjs 17 项 + test/wake-integration.test.mjs 3 项（后者跑真 `apply()` + 假 runner，断言落地后 `followup` 恰好一次）。

2. **`agents` 服务要在「投递那一刻」懒解析，别用 `ctx.inject(['agents'], …)` 等它就绪**。第一版写成 `ctx.inject`，看着更「cordis 正统」，但语义上它把「唤醒能不能用」绑在了「服务解析时机是否恰好赶上 apply」上——服务在子作用域/晚注册时回调永不来，**唤醒静默失效且没有任何报错**（信标只会停在 `wakeActive:false`）。改成 apply 里就建唤醒器、投递时 `ctx.get('agents')` 现取，并把这个事实写进激活信标（`agentsVisible`）。**活体契约核对**（宿主自带的 Inspect Provider，`cordis_inspect_query {platform:'host', provider:'Service', method:'listService', input:{service:'agents'}}`）明确把两条路分开了：`access.optional = ctx.get("agents")` 且 `requiresUndefinedCheck: true`；`access.hardDependency = inject:["agents"]` → `ctx.agents`。也就是说 `ctx.get` 就是官方给「可选依赖」的正门（未注册/未激活返回 undefined，不抛）。教训：**增强型能力不能有「时机依赖的静默失败」**，宁可每次现取。

3. **改 host 代码（index.js 等）后，动 profile patch 只会「重新 apply 已缓存的模块」——新代码要重启 DSH 才生效**。A/B 实证：14:40:20 落盘新 `index.js` → 14:40:46 改 profile `cordis.patch.yml` → 14:40:49 信标 `at` 更新（说明 apply 确实重跑了），但信标里**没有**新代码才会写的 `notifyOnSettle/wakeActive` 字段 = 跑的还是旧模块。原因：`@deepseek-ai/dsh-hmr` 的模块监听根是 profile 目录（`root:["."]`，且默认 `ignored` 含 `**/node_modules`），本插件在仓库路径、又经 `profiles/<p>/node_modules/@local/<pkg>` 软链装配，**两头都不在监听面内**；profile patch 的变更走的是「配置监听 → 重新 apply 同一条目」，ESM 模块实例照样命中缓存。推论：① 插件 host 代码改动一律以「重启 DSH」为验收前提；② 别为了「热更新方便」把插件目录加进 `hmr.root`——`disposeAll` 卸载时会 **kill 所有 running job**（index.js 的卸载清理），编辑一个文件就能干掉一个跑了半小时的派发任务。

4. **排障要看信标，不要靠「应该生效了吧」**：本轮把唤醒状态写进 `.data/state/activation.json`（`wakeActive`/`wakeNote`/`agentsVisible`/`systemPromptHintActive`），并且 `writeActivationBeacon` 从「整文件覆盖」改成「与已有内容合并」（原来只覆盖，晚到的动态结果写不进去）。上面第 3 条的「跑的还是旧模块」就是这么一眼看出来的。

5. **新增一个 host 半边文件，必须同步 `package.json` 的 `files`**：`install_bundle` 按 `files` 打包，漏一个文件 = 装出来的插件 `index.js` 静态 import 直接 ERR_MODULE_NOT_FOUND（本轮加 `notify.mjs` 时差点漏；本机因为是 `link:` 装配所以照样能跑，**只有真装机才炸**——最难发现的一类）。已给 `tools/verify-plugin.mjs` 加常驻哨兵：「index.js 的每个 `./xxx` 相对 import 要么列在 `files`、要么落在列出的目录项下」，并做了反向验证（摘掉 `notify.mjs` → 立刻 `FAIL 缺: notify.mjs`）。

6. **真机验收（重启后闭环）**：`j-muuw3axj-0-f43f`（tag `wake-smoke`，GLM-5.3-Flash，`lock=none`）06:49:27Z 派发 → 06:49:41Z 落地（`done`、exit 0、14.1s、`responseChars:13`、台账命中）。**派发它的会话当时已经结束本轮、没有做任何等待**，落地瞬间被自动拉起并收到通知卡片（正文即 `[dispatch] 派发任务 … 已落地。…[status: done]`），且只收到一次（幂等）。同刻信标 `wakeActive:true / agentsVisible:true / systemPromptHintActive:true`；活体 Config schema 里可查到三个新字段（`cordis_inspect_query` host/Config）。至此「工具取 `exec.agent.id` → 登记归属 → 落地判据 → `followup` 开新一轮 → 新轮次带 notice」整条链路全部经真机验证，不再是「应该能行」。

## 2026-09-30 Z13（官方 API 注册 agent 工具 dispatch）

1. **「宿主随包出货」≠ 本地能静态 import**：本地 node_modules 只有宿主出货包的子集（cosmokit/schemastery）。给 index.js 加静态 `import '@deepseek-ai/dsh-tools'` 会让模块加载即炸——verify-plugin ③「Config 是 Standard Schema」项会**真实 import index.js**（tools/verify-plugin.mjs:38），门禁直接红；宿主真缺包则激活死（Z10-1 同源）。正解沿用本文件 loadConfig 同款：动态 import + try/catch 降级 null，宿主内解析到同一个官方包，语义等价、失败可降。
2. **defineTool 的 output 不可省略**：`options.output.render` / `options.output.schema` 被无条件读取（refs/dsh-tools/lib/index.js:842/:849），「若 output 可省略就省略」按真契约为假。最小合法形态：`{ schema: { type: 'json' }, render: (args, value) => [{type:'text', text: …}] }`——DSL 的 `type:'json'` 编译为注解即无约束 JSON（:688），任意 JSON 返回值都合法。
3. **官方参数 DSL 不是 JSON Schema**：字段级 `{ type, required?:true, description?, enum?/items?/const? }`；`required` 只能是 `true`（编译收拢到顶层 required 数组，:603）；`exclusiveMinimum`/`minimum` 不是 DSL 词汇 → authorError，数字范围约束只能写进 description 由 execute 侧兜底。
4. **validateArgs 吃「作者 spec」不吃编译产物**：`tool.parameters` 里存的是编译后 JSON Schema（`{type:'object', properties, required}` 形状），把它喂回 `validateArgs` 会报 `parameters.type must be a value schema object`（保真脚本首跑即踩）。要验「校验语义」直接走 `tool.execute(args)`——defineTool 的 execute 包装器内部先 validate 再透传（:866-870）。
5. **本地跑通官方包行为的通路（模块钩子）**：`node:module` 的 `register()` resolve 钩子把 `@deepseek-ai/dsh-tools` 短路到工作区提取的 `refs/dsh-tools/lib/index.js`，其 import 的宿主内部包（cordis/dsh-llm/dsh-scope/dsh-util-values/dsh-brand/dsh-sandbox）按名生成 data URL 最小桩——真实 defineTool 即可在本地完成编译/校验/注册全链路验证（本轮 14/14，脚本跑完即删）。另注意：URL pathname 在 Windows 不解码 `%20`（Z12-1），钩子里的文件 URL 一律 `fileURLToPath`/`new URL(…, import.meta.url).href`。

## 2026-09-30 Z12（派发总开关插件侧接入）

1. **`new URL('.', import.meta.url).pathname` 在 Windows 不解码 `%20`**：路径含空格时得到 `F:\My%20Code\…`，再喂给 `pathToFileURL` 会二次编码（`%2520`）→ ERR_MODULE_NOT_FOUND。Z6-4 只记了正向（path → import 要用 `pathToFileURL(p).href`），反向（URL → path）必须用 `fileURLToPath(import.meta.url)`，别手搓 `.pathname` 替换。
2. **给既有动作加门禁 = 给所有调用方（含验收探针）引入运行期真值依赖**：Z12 给 `dispatch` 加开关门禁后，`test/z2-verify.mjs` 的 e2e dispatch 隐式变成「真值文件为开才能过」——探针从密封变活体依赖，且静态跑探针时毫无征兆。修法：探针 cfg 显式 `switchPath` 指向临时文件（缺失=开启，恢复密封）。与 Z5-1「行为变更必须同步本地验收探针」同源：同步的不止断言，还有**探针的输入依赖面**。

## 2026-09-30 Z11（UI 第二轮：空态/折叠/关闭/行展开）

1. **core 的 `kill()` 对 `paused` 是「返回 true 的空操作」**：paused 时子进程已退出（close 处理器跑完即 `children.delete`），`kill()` 走默认分支只 `killRequested.add` + emit——返回 `{ok:true}` 但状态永停 paused，且 `killRequested` 条目永久残留。UI 判据：kill 返回的 `job.state` 仍是 `'paused'` 即视为无效，退回 dismiss（wire 层 `createActionHandler` 新动作，`state/dismissed.json` 落盘 + snapshot/list 过滤；core 零改动）。
2. **本地 React 桩测试三坑**（test/z11-ui.test.mjs 已删，复现成本高，记下）：
   ① `useState` 的 setter 闭包必须捕获**自己组件的 hooks 数组**——若引用共享可变变量，写入会落到「最后渲染的组件」，表现为状态永不更新/串台；
   ② `createElement` 的 children 要同时放进 `props.children`（PanelBoundary 的 `this.props.children` 依赖它）且遍历器沿 render 产物走——沿 raw `props.children` 下降会漏掉所有函数组件内部；
   ③ effect 桩要「每次渲染重跑、先执行上次 cleanup」——JobRow 的 tail effect 依赖 `open` 变化重跑，只跑一次会让展开区永远「读取中/无输出」。
3. **test/z2-verify.mjs §7 是既有红、非 Z11 引入**：其 React 桩没有 `Component`，`PanelBoundary extends React.Component`（Z9 提交 e4cdb4c 引入）在 factory 即抛 `Class extends value undefined`。已用 `git stash` A/B 实证改动前后同红。该脚本不在任何现行验收门禁里（现行=tools/verify-plugin.mjs 20/20）；后续要么给它补 `Component` 桩、要么把 §7 断言改为跳过渲染冒烟。

## 2026-09-30 Z10（Config 换 Standard Schema）

1. **cordis 的 Config 只认 Standard Schema v1，裸 JSON Schema 直接炸激活**：`resolveConfig` 取 `runtime.Config['~standard'].validate`（cordis lib/index.js:958），draft-07 JSON Schema 没有 `~standard` → `TypeError: Cannot read properties of undefined (reading 'validate')`。宿主随包出货的 schemastery 就是 Standard Schema（`Schema.prototype['~standard']` getter，vendor='schemastery'），官方插件一律 `import z from '@deepseek-ai/schemastery'` + `z.object({...})`。降级兜底写手写 `{'~standard':{version:1,vendor,validate}}`，validate 只归一不抛 issues——激活永不被配置打崩。
2. **验收探针的正则是契约，改代码形态前先 grep 探针**：DSH 探针用 `/export\s+const\s+Config\s*=/` 断言「Config 可配置」，任务包示例的 `let Config; export { Config }` 会让这条静默变红；写成 `export const Config = await loadConfig();` 语义等价且保住契约。同坑变体：本地探针的纪律断言（`@deepseek-ai` 全禁、裸包名说明符禁、Config 为 JSON Schema 形状）必须随行为变更同步豁免/改写（Z5-1、Z8-02 同一先例），否则探针永久假红。
3. **try/catch 包住主路径会让「方法名写错」静默落降级**：schemastery 导入失败与方法不存在都会进 catch → 手写降级兜底，探针若只断言 `~standard.validate` 是函数就测不出主路径已死。探针必须断言 `Config['~standard'].vendor === 'schemastery'` 区分主/降级路径（本地探针临时脚本据此发现主路径健康）。

## 2026-09-30 Z8（wire 全接线）

1. **新增的状态枚举值必须逐个核对消费者，否则永远停在初始态**：Z8-01 给远端 wire 选了新连接态 `conn='remote'`，但 UI 徽标映射（client.js connLabel）只认 `demo/ext/live`，未识别值全部落到「连接中」——远端真接通徽标也永远显示连接中，`node --check`/探针/浅渲染全测不出来（纯映射遗漏）。修法：wire 发 `conn='live'`（与既有枚举对齐），两处 emit（正常/出错）都要改；同源镜像 wire.client.mjs 同步。教训：给既有 discriminated 字段加值前先 `grep` 该字段的全部比较点。
2. **本地验收探针的「TODO 白名单」类断言会过时**（Z5-1 变体）：test/z2-verify.mjs 断言 TODO 只存在于 wire.*.mjs 两文件，Z8-01 把 TODO 清偿后变成 0 个文件，断言反而红——期望值把「临时状态」写死成永久断言。同理 `@deepseek-ai` 全禁断言没豁免协议标记键常量（typert 协议要求键跨副本精确相等，wire.host.mjs 必须含该字符串）。修法：断言表达不变式（TODO 应清偿为 0；协议键仅限 wire.host.mjs 且恰 1 处），别表达「当前中间态」。
3. **接续半成品单子先修可加载性再做增量**：Z8-01 被超时掐断时留下 `createWire is not defined`（调用点已写、定义没写），此刻任何增量改动的验证都是噪音。Z8-02 先落 createWire 定义、跑探针回到 18/18，再补 inject/$mount——每步落盘保持源码可加载（任务包铁律）。

## 2026-09-30 Z7（wire 接成 Remote 面）

1. **对象字面量里的「别名方法」不能按名引用同字面量的其他方法**：`{ setChannel: (c) => channelSet(c) }` 里 `channelSet` 是属性不是作用域绑定，调用时才解析 → ReferenceError（写时无告警、`node --check` 也不报）。共用逻辑先落成局部函数，再挂两个名字。
2. **纯数据描述符表先声明后引用**：`export const TYPERT = { …members: DOCS.map(…) }` 引用声明在其后的 `const DOCS`，模块求值即 TDZ ReferenceError——比函数体内引用更早爆炸，import 阶段就挂。
3. **ESM（strict）分支内漏 `let` 声明 = ReferenceError 而非隐式全局**：旧代码把 `let pollTimer` 写在分支里，重排分支时把它落在别的分支，被引用分支直接炸。拆分支时逐分支核对局部变量声明。
4. **官方 Remote 信封有两种返回形状要归一化**：官方代理包 `{ok:true,value}|{ok:false,error:{message}}`，进程内直连 face 是域形状（`{ok,job}`、`string[]`）——拆包判据用「有 boolean `ok` 且 own `value` 键」而不是 `ok===true`，否则直连形状会被误拆。

## 2026-09-30 Z6（通道/暂停/续跑）

1. **返回克隆的 API 不能再拿来写簿记**：`dispatchRaw()` 末尾 `return get(id)`（= serialize 展开克隆），`retry()` 在其返回值上写 `parentJobId/attempts/hopCount` 全部静默丢失（内存、`d.get()`、jobs.json 三面皆空），且**只断言 retry() 返回值测不出来**——簿记断言必须从 `d.get()/d.list()/jobs.json` 读回。修复走内部 `{raw:true}` 返回 jobs 里的真实对象，对外仍给克隆。
2. **纪律 grep 会被"注释+文案"组合命中**（Z2-1 变体）：client.js 头注释"不 import 任何宿主包" + 英文文案 `parentFrom: 'continued from', hop: 'hop'` 恰好构成 `import … from '…, hop: …'` 假形状，贪婪说明符正则一次假命中同时打挂 z2-verify 两条断言（真 `require('react')` 还被这次大匹配吞掉、没数到）。修法：说明符扫描前先剥块注释。
3. **classifyPause 是行优先不是签名优先**：`PAUSE_SIGNATURES` 注释说"顺序即优先级"，实现却是外层遍历行、内层遍历签名——跨行时先出现的行先定性（前面的 quota 宽词行会抢先 entitlement），签名顺序只在**同一行内**生效。写断言别照注释想当然。
4. **Windows ESM 静态 import 不吃盘符绝对路径**（`F:\...` → ERR_UNSUPPORTED_ESM_URL_SCHEME）：临时探针要用 `await import(pathToFileURL(p).href)`。

## 2026-09-30 Z5（安装前收尾）

1. **行为变更必须同步本地验收探针**：Z3 把 `fetchPlanQuota` 从占位变真实、Z4 把注册 id 改为 `dispatch.console`，两单都没同步 `test/z2-verify.mjs` 的对应断言，探针一直 73 PASS / 2 FAIL 假红（DSH 侧探针是另一份所以没暴露）。改行为的那一单要 grep 本地验收脚本里的相关断言一起改。
2. **React 桩必须在 factory 之前装好**：client.js 顶部 `const { useState, … } = React` 在 factory 时解构，之后再造 `R.useState` 无效（表现诡异：hooks 返回初始值、整树只剩 21 个节点）。先装桩再调 factory。
3. **遍历元素树要对函数组件求值**：只递归 children 会把 Section/QuotaCards 等函数组件当黑盒叶子（节点数骤减、找不到目标 DOM）。要 `el.t({ ...el.p, children })` 递归求值，并按组件切换 hooks 槽（同 test/z2-verify.mjs 的 renderTree 做法）。

## 2026-09-30 Z4（槽位/令牌证据固定）

1. **asar header 里文件 offset 是相对数据区基址的**：扫描器把命中绝对偏移映射回文件时，必须先减 `baseOffset` 再对文件表二分，直接用绝对偏移会整体错位到错误的文件。
2. **提取器 stdout 接 `head`/`tail` 会 EPIPE 崩**（退出码≠0）：但文件其实已写全——管道下游提前关闭是主因，看落盘结果别看退出码。
3. **提取器对无尾斜杠前缀平铺落盘**：前缀 `…/lib` 会把 `lib/client.js` 直接写到 `outDir/client.js`（`slice(prefix.length)` 后去首斜杠）；要保留目录形态就给前缀加尾斜杠或按整包前缀提取。
4. **令牌差集只认 `var(…)` 引用**：注释里的通配写法（如 `--dsw-alias-bg-layer-*`）会被正则截断成 `--dsw-alias-bg-layer-` 伪命中；同理任务包口径的"20 个令牌"实为 19 个去重引用，先去重再比对。
5. **DSH 主题令牌真实命名与直觉不同**：文本是 `--dsw-alias-label-*`（不是 `-text-*`）、边框 `-border-l1..l4`（不是 `-border-default`）、状态 `-state-*-primary`、阴影 `--dsw-shadow-lv1/2/3`（非 alias）、代码字体 `--ds-font-family-code`（`--ds-` 前缀！）；`brand-primary` 是近黑/近白不是蓝，产品蓝用 `-state-business-primary`。权威调色板在 `dsh-client-ui-theme/lib/client.js` 的 `design_platform_css_default`（body 亮色 + body[data-ds-dark-theme] 暗色）。

## 2026-09-30 Z3（套餐额度 RPC）

1. **ZCode Protocol stdio 没有 JSON-RPC 包装**：带 `jsonrpc:"2.0"` 直接 -32600（报错的 zod union issues 会把四种合法形状全暴露出来）。正确帧是裸 `{id,method,params}` / `{method,params}` / `{id,result|error}`。
2. **stdio 面无握手**：bundle 里的 hello/clientHello 是桌面 WebSocket 面的（`clientMode:"desktop-continuous"`）；stdio 启动先推 5 条 `startup/storageState` 通知，直接发业务请求即可，别等 hello。
3. **`usage/stats` ≠ 套餐剩余**：它是本地 agent-db 的日粒度聚合（range 7d/30d/all）。找"剩余额度"先全枚举方法表 + 实测 -32601 再下结论——0.13.3 的 RPC 面不提供套餐 limit/remaining/resetAt。
4. **Windows `taskkill /PID x /T /F` 对已退出进程 exit=128**（找不到 PID）：树杀兜底代码要把 128 当正常，别当失败重试。
5. **反查 minified bundle 的捷径**：grep zod 校验错误文案（如 "Unrecognized key"、"Method not found"）可直接反推协议 union 形状与方法表，比读压缩代码快一个量级。
6. **模拟 spawn ENOENT 时假进程 pid 必须为 undefined**：真实 Node spawn 失败不给 pid；假进程给了 pid，库的"pid 已设=spawn 成功"快路径会误判（测试假桩踩的）。

## 2026-09-30 Z2（DSH 派发台插件包）

1. **纪律 grep 会被注释命中**：任务包禁止 JS 出现 `@deepseek-ai`、`document.body`、`require('react')` 以外的 require——这些字面串连**注释**里都不能出现（client.js 头注释原样写了这三个，验收 grep 全部命中）。改述为「DSH 宿主客户端包 / 宿主 body 节点 / 经宿主模块表注入的 react」。
2. **Node ≥21 的 `globalThis.navigator` 只读**（本机 v24.14.1）：测试桩直接赋值抛 `TypeError: Cannot set property navigator … only a getter`。赋值要 try/catch；业务代码读 navigator 必须带回退链。
3. **同步 subscribe 的 TDZ**：`const un = wire.subscribe(cb)` 里 cb 被同步首推时引用 `un` 命中暂时性死区（ReferenceError），promise 快速 reject 且现象诡异。写法改为 `let un = null; un = wire.subscribe(...)`；适配器侧把首推包进 try/catch（wire.host.mjs subscribe 已如此）。
4. **dispose() 只清 interval 不够**：demo 引擎「派发编排」的挂起 setTimeout（约 6.2s 后置 done）会跨组件卸载存活，导致定时器泄漏检查偶发失败。挂起定时器要登记（pendingTransitions）并在 dispose 统一清（wire.client.mjs 与 client.js 内嵌引擎均已处理）。
5. **杀进程过快 ≠ 缺陷**：dispatch 后立刻 kill（<100ms），子进程还没打印任何行，captureOut 为空、`tail()` 返回 `[]` 是 core 正确行为（UI 显示「无输出」）。测试要在 kill 前等一拍（等 runner 打印启动行），不要反过来「修」core。
6. **`ctx.slots.inject(owner, cb)` 的回调由框架在挂载时调用**：桩环境测试必须手动调用 cb 才会触发 `slots.register`，否则会误判「没注册组件」。

## Z10：Config 必须是 Standard Schema；且**宿主半边改代码必须重启进程**（2026-09-30 实测）

1. **激活失败 `Cannot read properties of undefined (reading 'validate')`**
   cordis `lib/index.js:958` 只认 `Config["~standard"].validate(config)`（Standard Schema v1）。
   导出裸 JSON Schema 会得到 `runtime.Config["~standard"] === undefined` → 激活失败、插件不加载。
   正解：`import z from "@deepseek-ai/schemastery"`（随 dsh 出货、官方插件同款）+ `z.object({...})`；
   或手写 `{'~standard':{version:1,vendor,validate}}`（DSH 已加降级兜底，见 `dispatch/index.js`）。

2. **"关→开开关"重载不到新代码（宿主半边）**
   cordis `_reload()` → `_resolveConfig()` 用的是 `this.runtime`，即**进程内已 import 的模块对象**；
   `_reload` 不会重新从磁盘 import。实测：源码修好后切开关，仍报**完全相同**的旧错误。
   判据：DSH 主进程启动时间早于源码修改时间（本例进程 03:19 启，源码 13:30 改）。
   → **宿主半边改动：必须完全退出 DSH 再启动**；客户端半边（`client.js`）改动：刷新页面即可（浏览器重新取包）。

3. **本地自证的两条路径**（写单必带）
   - 主路径：`node -e "import('./dispatch/index.js')"` → `Config['~standard'].validate({})` 应有 5 个默认值；
   - 降级路径：`node --import <block-hook>`（resolve 钩子对该包抛 ERR_MODULE_NOT_FOUND）→ 仍须有 `~standard` 且归一脏值。

## 2026-09-30：DSH 崩溃对话框的「禁用第三方插件、备份 profile patch 并重启」会重置配置（务必知晓）

- 它**保留备份**（`~/.dsh/profiles/desktop/cordis.patch.yml.bak-<ts>`），但会把 `cordis.patch.yml` 与
  `dsh.profile.bundles` **重置为出厂默认**（web 模板 = `dsh-base` + `dsh-web-app`）。
- 后果：用户自定义项全部消失 —— 默认模型（`agent-default-model`）、权限预设（`permission-presets`）、
  `ui-settings.enabled`、`ui-chat.performanceUsage`、以及自行开启的官方实验 bundle
  （agent-team-profile / auto-review / schedule-bundle）。
- 还原：`profile-backup/README-RECOVERY.md`（含三态留档与两条恢复命令）。
- **教训**：让插件进入启动路径前，先用常驻判据挡住"会阻塞启动"的写法（本轮已加：
  「inject 不自声明 remote 命名空间」+「apply 全兜底」），否则一次启动失败就要用户点救援按钮 = 配置被重置。

## 2026-10-05：仓库目录改名（`dsh-plugins` → `dispatch`）—— link 状态必须由 pnpm 重建

- **起因**：本地目录名与 GitHub 仓库名（`dispatch`）不一致，改名对齐。
- **踩的坑**：改完 `profile/package.json` 的 `link:` spec 后，**只手工改了
  `node_modules/.pnpm/lock.yaml`，漏了 profile 根目录的正式锁文件 `profiles/desktop/pnpm-lock.yaml`**。
  约 2.5 小时后 DSH 插件管理器自动跑 `pnpm install`（日志
  `profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log`），pnpm 以**仍含旧路径的根锁**为准，
  把 `package.json`/两个 lock/junction 全部按旧路径重建 ⇒ junction 悬空 ⇒ 下次启动报
  `cannot resolve profile bundle "@local/dispatch"`。（当时的包名 —— ZB-32 起包已改名为
  `dsh-dispatch`；此处保留原始报错文本以保持史实准确。）
- **正确做法**：改 `link:` spec 后**跑一次 profile 的 pnpm install**，让它自己重建 lock + junction；
  若必须手工改，则 `profiles/<p>/pnpm-lock.yaml`（正式）与 `node_modules/.pnpm/lock.yaml`（副本）
  **两个都要改**，并重建 junction，最后**再跑一次 install 复验**。
- **附带教训（本仓库自身）**：`tools/`、`dispatch/test/*.test.mjs`、README、`CREATOR-*.md`
  里**硬编码了绝对路径**（本次共 23 文件 43 处），改名后测试/校验脚本全部找不到源码。
  本次已批量更正；**建议后续改为相对自身推导**（`import.meta.url` → `path.resolve`），
  这样仓库放哪都能跑，不必再随改名批量改路径。
- **附带教训（改名必查项）**：`junction`/`symlink` 的目标路径**不在任何文本里**，文本替换扫不到 ——
  改名后必须单独扫链接：`Get-ChildItem <root> -Recurse -Force -Directory | Where-Object { $_.LinkType }`
  再校验 `Target` 是否存在（本次另发现 `node_modules/@deepseek-ai/{cosmokit,schemastery}` 悬空）。
- **附带教训（验收标准）**：改名后实测面板派发成功（exit 0）**不足以**作为验收 —— 依赖/link 类改动
  必须**跑一次 install + 重启一次**；故障可能延迟到下次启动才暴露。
