审查完成（串行、无子代理，约 30 分钟）。以下为报告。

---

# DSH 派发台插件只读审查报告（F:\My Code\dsh-dispatch）

覆盖：`dispatch/core/dispatch-core.mjs`（4625 行全读）、`dispatch/wire.host.mjs`（1585 行全读）、`dispatch/index.js`（800 行全读）、`collab-kit/run-line-protocol.mjs`（全读）+ 4 执行器定向 grep 抽查、`client.js` 按约定只做 3 项检查。

## 1. 高 severity（会出错 / 数据错 / 泄漏）

- `[HIGH] dispatch/core/dispatch-core.mjs:1947` — handleLine 对**每条解析成功的输出行**调 persist()，persist（:1071-1103）每次全量 readFileSync+JSON.parse jobs.json（上限 1000 条、含 200 行 tailLines）再全量 pretty-write——心跳/输出行密集时主线程同步 I/O 放大严重 — 建议：dirty 标记+节流落盘
- `[HIGH] dispatch/core/dispatch-core.mjs:1720` — startJob 里 `writeFileSync(captureOut,'')` 无 try/catch，抛错时 job 已置 running、锁已持有、无 child/close ⇒ 永不 finalize，kill()（:4517 无 child 分支）也救不回，整仓锁卡死队列直到重启 — 建议：try/catch→finalizeJob failed
- `[HIGH] dispatch/core/dispatch-core.mjs:4520` — kill(running) 只 `child.kill()`；Windows 下只杀 node runner，CLI 孙进程成孤儿继续烧额度（:3239 登录服务路径自己都承认“必须 /T 否则变孤儿”，job 路径却没用 taskkill /T）— 建议：复用 killLoginTree 杀树
- `[HIGH] dispatch/wire.host.mjs:233` — `stalled = running && (!lastProgressAt || >150s)`；而 zcode-run.mjs **完全没有 progress 心跳**（全文 grep "progress" 0 命中，仅 opencode/qoder/codebuddy 有）⇒ 每个 running 的 ZCode 任务恒标“可能卡住”，briefJob(:299) 还会产出 `lastProgressAgoSec:NaN` — 建议：无心跳引擎不算 stalled

## 2. 中 severity

- `[MED] collab-kit/zcode-run.mjs:1204` — 唯一权威 run-line-protocol.mjs 只被另外 3 个执行器 import；zcode-run 前缀与 done 行格式硬编码手抄（协议文件 ：16 自己承认“与 core RES 镜像手改两处”），ZB-31 式漂移风险仍在 — 建议：zcode-run 也改 import
- `[MED] collab-kit/qoder-run.mjs:116` — qoder/codebuddy（codebuddy-run.mjs:152）接受 `--memory-ban` 却**从不打印 `memory-ban=on`** ⇒ core:1913 的 `job.memoryBanRunner` 对 2/4 引擎恒为 null，审计确认位静默失真（zcode-run:859 / opencode-run:873 都打印）— 建议：两执行器补确认行
- `[MED] dispatch/core/dispatch-core.mjs:1992` — 台账回读只跳过 opencode；qoder/codebuddy 同样无台账（qoder-run.mjs:153 自证）⇒ 每次终态仍全量读 dispatch-runs.jsonl，与注释所述“无台账不读”的理由不一致 — 建议：按引擎查表跳过
- `[MED] dispatch/core/dispatch-core.mjs:479` — `APPLIED_MAPPER[e](m)` 无兜底，而 ：235 给 APPLIED_RE_OF 加过兜底；两张并行表仅靠约定同步，漏一张即热路径抛 `is not a function` — 建议：取值加 `?.() ?? {}`
- `[MED] dispatch/core/dispatch-core.mjs:2802` — runOpenCodeProbe/runQoderProbe(:3042)/runCodebuddyProbe(:3133) 三份近同构探测实现，且返回形状不一致（OpenCode 版带 error 文案，Qoder/CodeBuddy 版非 0 退出无 error 字段）— 建议：抽一个带前缀参数的实现
- `[MED] dispatch/core/dispatch-core.mjs:693` — pendingCwdNotes 模块级信箱：validateSpec 先 push（:4076）后若在 ：4081 抛错，残留 note 被下一次 dispatch 消费 ⇒ cwd 说明串到别的 job（跨实例也共享）— 建议：改为校验返回值
- `[MED] dispatch/core/dispatch-core.mjs:3549` — listChannels 约 315 行（含 4 引擎探测+别名+白名单+发现层），远超 100 行红线 — 建议：按引擎拆函数
- `[MED] dispatch/index.js:679` — 一次 apply 创建 3 个 createActionHandler 实例（工具/attachHostWire:1455/face:985），仅靠模块级 dismissedByFile 保持一致 — 建议：创建一次传递复用

## 3. 低 severity

- `[LOW] dispatch/core/dispatch-core.mjs:178` — qoderLevelsCache 模块级可变闭包，多 dispatcher 实例（测试）间串味
- `[LOW] dispatch/core/dispatch-core.mjs:3937` — mergeFromLedger 每次终态全量读台账文件，台账无界增长时 O(n)/job
- `[LOW] dispatch/core/dispatch-core.mjs:4603` — 导出面暴露 opencode/codebuddyRunnerPath 却漏 qoderRunnerPath
- `[LOW] dispatch/wire.host.mjs:231` — lastProgressAgoSec 与 stalledSec 同值算两遍（冗余字段）
- `[LOW] dispatch/wire.host.mjs:1007` — channels 缓存“陈旧判定”在 cachedChannels 与 channelsCached(:1039) 各写一份
- `[LOW] dispatch/core/dispatch-core.mjs:1103` — persist 用 `null,2` pretty-print，热路径放大写盘体积
- `[LOW] dispatch/core/dispatch-core.mjs:3676` — 账号专属白名单 `account:bigmodel-start-plan` 与 ：3762 模型兜底写死在 core（有注释，但换机/换账号需改代码）
- `[LOW] dispatch/core/dispatch-core.mjs:3400` — lightCodebuddyLoggedIn 读执行器写的 %TEMP% 缓存，形状契约 `{at,ok,reason}` 无共享校验（隐式契约）
- `[LOW] dispatch/wire.host.mjs:744` — wait 动作的超时 setTimeout 在提前 settle 后不 clear（幂等 done 兜底，仅留游离 timer）
- `[LOW] dispatch/core/dispatch-core.mjs:611` — atomicWrite 里 writeFileSync(tmp) 抛错时 tmp 文件不清理

## 4. 全局 Top 5 风险（按优先级）

1. **persist 每行全量读写 jobs.json**（HIGH#1）：所有面板/工具操作都跑在 DSH 宿主主进程上，job 多 + 输出密时是全局卡顿源。
2. **Windows 下 kill/看门狗泄漏 CLI 孙进程**（HIGH#3）：每次手动 kill 都可能留下继续消耗额度的孤儿引擎进程。
3. **startJob 捕获文件创建失败即卡死调度器**（HIGH#2）：仓库锁被死持、kill 无法恢复，只能重启。
4. **stalled 心跳判据对主力引擎（ZCode）全量误报**（HIGH#4）：核心可观测信号失去意义。
5. **手抄同步契约仍然存在**（MED#1/#2）：协议“唯一权威”没覆盖 zcode-run、memory-ban 确认行 2/4 引擎缺失——本仓库历史上反复被这类漂移咬（ZB-31/ZB-44 教训均在注释中自证）。

## 5. 查过并确认“没问题”的关键点

1. **client.js 三项约定全部达标**：innerHTML/document.write 0 处；hex 色值 0 处，仅 3 处 `rgba(0,0,0)` 投影兜底且注释声明为唯一例外（client.js:316,321）；STRINGS.zh/en 键集经脚本比对**逐键对齐**（各 138，无单侧缺键），`t()` 还有 zh 兜底（client.js:898）。
2. **锁语义实现扎实**：repo 锁与文件锁跨层级互斥（dispatch-core.mjs:1365-1401，含 `lock:'none'` 空集放行的 ZB-80 修正）；锁路径归一含 win32 整体小写+realpath 最佳努力（:718-763）；tryAcquire 部分获取失败回滚（:1424）；淘汰只删本进程终态记录（:1093-1095）。
3. **引擎扩展面一致**：ENGINES 单源驱动并发快照/上限/通道分组（dispatch-core.mjs:1465,4602；run-line-protocol.mjs:25）；未知引擎解析 fail-open 不抛（:235 `?? (() => /(?!)/)`）；opencode/qoder/codebuddy 三执行器均 import 协议模块且 done 行/exit-124/`(超时)` 语义 grep 验证一致（opencode-run.mjs:476、qoder-run.mjs:695、codebuddy-run.mjs:841）。

## 6. 未能覆盖的范围（诚实说明）

- client.js 主体 6069 行**未读**（按任务约束只做了 3 项检查 + STRINGS 区域），渲染逻辑、XSS 面（如 innerText 使用）、事件监听泄漏未审。
- wire.client.mjs(836)、notify.mjs(488)、core/quota.mjs、core/gift-quota.mjs、core/appserver-rpc.mjs、bin/、test/、bridge/、tools/ 全部未读。
- 4 个执行器只做了定向 grep（协议行/台账/memory-ban/杀树/信号处理），未逐行读（合计 4389 行）；runner 侧 spawn 细节、`--list-providers` 表格输出的逐字保真度未验证。
- 纯静态审查 + 少量只读脚本比对，**无任何运行时验证**；HIGH#3 的孤儿进程结论基于 Node Windows `child.kill()`=TerminateProcess 的平台行为与代码内 :3239 的自证注释推断，未实测 `?`。
- `wait` 动作在并发竞态下的边界（订阅与超时同时落地）仅静态推演。
