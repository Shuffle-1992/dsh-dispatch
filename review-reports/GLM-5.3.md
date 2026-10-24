审查完成。以下为最终报告（所有核心高严重度发现均已由我本人二次核验行号与代码；子代理发现经抽查证实后收录）。

---

# DSH 派发台插件只读审查报告（2026-10-24）

## 1. 高 severity（会出错 / 数据错 / 泄漏）

- `[HIGH]` dispatch/core/dispatch-core.mjs:4439-4464 — kill() 对 paused 任务只加 killRequested 即返回 true，不清 1949 行自动重试定时器、不改状态；1953 行守卫只查 state==='paused'（kill 未变它）→ 25 秒后 retry() 把**用户已 kill 的任务复活** — kill 时清定时器并置状态
- `[HIGH]` dispatch/core/dispatch-core.mjs:1943-1957 — 并发自动重试经 retry() 生成**新 job**，其 concurrencyRetries 从 0 重计（全文件仅 1943/1944 两处触点）；上游持续报并发满时形成每 25 秒一个新 job+新进程的**无界链**，“最多 8 次”封顶只对单代生效 — 加链级 hopCount 封顶
- `[HIGH]` dispatch/core/dispatch-core.mjs:571-574 — 过期锁抢占：569 行 readLockFile 与 unlinkSync 之间跨进程 TOCTOU，可删掉他人**刚重建的新锁**，随后 wx 建锁成功 ⇒ 双进程同时持锁，单写者互斥静默击穿 — rename 抢占或删前重读确认
- `[HIGH]` dispatch/core/dispatch-core.mjs:3551-3563 — `--list-providers` 探测超时分支只 child.kill() 不调 done()，且 child.stderr 全程未消费；kill 失败或 stderr 管道写满时 Promise 永不 settle，wire 层 channelsProbeInFlight 永占 → action=channels / 面板通道**永久挂起**（对比 2796/3031/3119 三处探测均正确收敛） — 超时分支补 done(null)
- `[HIGH]` dispatch/core/dispatch-core.mjs:4457（配合 1758）— job 终止仅 child.kill() 单杀 runner，Windows 下无树杀；runner（zcode-run.mjs:1132 spawnSync CLI）的引擎子进程成**孤儿**继续跑、耗额度、写文件（本文件 3218 行登录助手已自证必须 taskkill /T /F） — kill 改 taskkill /T
- `[HIGH]` collab-kit/zcode-run.mjs:599-631,813,1144-1146 — **读取并解密** `~/.zcode/v2/credentials.json` 的 API Key，写入临时明文配置文件；清理 rmSync 仅在 spawnSync 正常返回后执行，runner 被杀/崩溃时**明文 Key 残留磁盘** — 违反“执行器不读凭据内容”纪律，需裁决
- `[HIGH]` collab-kit/appserver-gift.mjs:89-105 — readGiftAuth 解密凭据库 zcodejwttoken 并交付使用 — 与上一条同属纪律冲突（“不读写凭据内容”），应一并裁决而非各案处理

## 2. 中 severity（可维护性 / 一致性）

- `[MED]` dispatch/core/dispatch-core.mjs:3156 — concurrencyRetryTimers 注释承诺“kill/dismiss/新 attempt 时清理”，但 kill()/retry() 均不删除条目，全靠回调状态守卫兜底（正是 HIGH#1 根源） — 实现承诺的清理
- `[MED]` dispatch/core/dispatch-core.mjs:1968 — 台账回读只豁免 opencode，qoder/codebuddy 同样无 ZCode 台账却照常回读；tag 撞历史 zcode 记录时 job 被填入无关运行的 provider/sessionId（数据污染） — 按引擎白名单回读
- `[MED]` dispatch/core/dispatch-core.mjs:1239,1244 — spec.__jobId 全仓库零处赋值（死契约）：lockBlockersFor 恒把自己当别人，crossLevelBlocked 拿 undefined 使 !== 恒真 — 删除或补赋值
- `[MED]` dispatch/core/dispatch-core.mjs:4025+1771-1776 — timeoutMin 校验只设下界；>2^31-1ms 时 Node 将 delay 钳为 1ms → 看门狗任务一启动就开火误杀（index.js:376 工具描述还明文宣称“无上限”） — 加上界并改描述
- `[MED]` dispatch/core/dispatch-core.mjs:3299-3331 — startCodebuddyLogin 并发调用双双通过 stop（此时仍 null）后各自 spawn，后到者覆盖先到者 → 登录服务进程泄漏；且 3418 TTL 仅在 status 被轮询时惰性回收 — 加 in-flight 去重
- `[MED]` dispatch/core/dispatch-core.mjs:1923+1071-1104 — 每条 runner 输出行触发一次“读整个 jobs.json→JSON.parse→全量写回”的同步 I/O（热路径），且 atomicWrite 失败重试用 Atomics.wait(604-608) 阻塞主线程 — 改防抖批量持久化
- `[MED]` dispatch/core/dispatch-core.mjs:1866 — parseWarnings 无上限（tailLines 有 TAIL_CAP=200），行格式漂移时数组与 jobs.json 无界增长 — 加 cap 同 tailLines
- `[MED]` dispatch/core/dispatch-core.mjs:1579-1708 — buildRunnerArgs/OpenCode/Qoder/Codebuddy 四份近似复制（文件头 60 行自警“复制两份必然漂移”）；runQoderProbe(3018)/runCodebuddyProbe(3109) 亦逐字重复 — 抽参数表驱动
- `[MED]` dispatch/core/dispatch-core.mjs:4391 + client.js:2482 — job 状态/pauseReason 魔法串在 core 约 15 处硬编码，client 又手抄 8 个暂停原因镜像（PAUSE_LABEL_KEY），纯注释级对齐无共享常量 — 集中常量并导出
- `[MED]` dispatch/core/dispatch-core.mjs:787-4548 — createDispatcher 单闭包约 3760 行（listChannels 308 行、startJob 142 行、retry 120 行嵌套其内），超长函数红线全破 — 按域拆模块
- `[MED]` dispatch/wire.host.mjs:953 vs 1141 — login 子动作两处实现：action 认 sub/op/action2 三别名，remote face 只认 sub —— 同一动作两套参数契约，ZB-104 已在 action 侧踩过同名坑 — face 复用 action 实现
- `[MED]` dispatch/wire.host.mjs:233+275 — stalled 判据（150_000 阈值+公式）在 slimJob/briefJob 双份魔数；231-232 的 lastProgressAgoSec 与 stalledSec 两字段恒为同值 — 抽共享函数删冗余字段
- `[MED]` dispatch/wire.host.mjs:521-540,819-867 — 额度改派（redirectFrom）与 ZB-108 通道收窄等**派发业务策略**实现于 wire 动作层而非 core（core 冻结所致），层职责边界持续模糊 — 策略下沉 core
- `[MED]` collab-kit — 总开关门禁仅 zcode-run.mjs:495-503 实现（exit 3）；opencode/qoder/codebuddy 三个 runner 无此检查，直调即绕过派发总开关 — 三 runner 补同款门禁
- `[MED]` collab-kit — killTree 三份不一致实现：opencode-run.mjs:715-724（spawnSync 带 15s 超时+SIGKILL 兜底）vs qoder-run.mjs:588 / codebuddy-run.mjs:719（无超时、默认信号）；退出策略亦三种写法（zcode-run.mjs:1287 同步 / opencode-run.mjs:1180-1188 exitCode+unref 兜底 / qoder-run.mjs:804-809 文档明言 unref 定时器不可靠） — 统一抽共享模块
- `[MED]` dispatch/index.js:780-791 — 插件卸载只 kill running/queued；paused 任务的重试定时器无人清（dispatcher 无 dispose，789-791 注释自认）→ 卸载后 25 秒仍可能拉起新 job — 卸载时清全部定时器

## 3. 低 severity（风格 / 微优化）

- `[LOW]` dispatch/wire.host.mjs:744-748 — wait 落地后不清 setTimeout（仅 unref 兜底），每次调用遗留最长 10 分钟的待期定时器 — finish 里 clearTimeout
- `[LOW]` dispatch/wire.host.mjs:459 — matchQuotaExhausted 用双向 includes 子串匹配（id.includes(key)||key.includes(bare)），前缀相近的通道易误标“刚撞额度” — 改精确/前缀匹配
- `[LOW]` dispatch/core/dispatch-core.mjs:4043+4068 — pendingCwdNotes 模块级信箱：validateSpec 后续抛错时 note 残留，被下一个无关 job 领走（与 692 行“自然作废”注释相反） — 改局部传参
- `[LOW]` dispatch/core/dispatch-core.mjs:471,3378 — 两处直接 Date.now() 绕过可注入时钟 nowMs()，测试注入对这两条路径失效 — 统一走 nowMs()
- `[LOW]` dispatch/core/dispatch-core.mjs:315 — 额度暂停正则含 /balance/、/\b429\b/ 宽词，任务输出合法出现会误判 quota-exhausted — 收紧词表
- `[LOW]` dispatch/core/dispatch-core.mjs:1808-1819 — feed() 只监听 end/error 不监听 close，流被销毁仅发 close 时捕获文件 fd 泄漏 — 补 'close' 处理
- `[LOW]` dispatch/index.js:410-476 — agent 工具描述使用 ⛔✅🚫🔁🎯💰🎫 等 emoji（agent-facing 文案、非前端 UI，属前端禁 emoji 纪律的边缘地带，报备） — 如需严格执行再清理
- `[LOW]` dispatch/client.js:111,321 — rgba 字面量 2 处，均为投影阴影且带主题令牌回退、注释已声明例外（报备性质，不算违规） — 维持现状可接受
- `[LOW]` collab-kit/zcode-run.mjs:1137 — spawnSync maxBuffer 64MB 溢出时 r.error.code 为 ENOBUFS 非超时路径所认的 ETIMEDOUT，stdout 截断后静默走解析失败 — 显式识别 ENOBUFS `?`

## 4. 全局 Top 5 风险（按优先级）

1. **文件锁 TOCTOU（HIGH#3）**：互斥一旦被击穿即破坏“单写者”根本纪律，直接威胁宿主仓库数据完整性——最该先修。
2. **kill/卸载不清 paused 重试定时器（HIGH#1 + index.js:780）**：用户 kill 掉或卸载插件后任务仍被自动复活并拉起新进程，行为层面的“失控”。
3. **listChannels 超时不 settle（HIGH#4）**：一次探测异常即可让通道查询永久挂死且自愈机制（1s TTL）被 never-settling 的 in-flight 占位废掉。
4. **Windows 无树杀 + 明文 Key 落盘（HIGH#5+#6）**：孤儿引擎进程持续耗额度，叠加 runner 被杀时临时明文 API Key 残盘，属安全+成本双损。
5. **凭据内容读取与项目纪律冲突（HIGH#6+#7）**：zcode-run 与 appserver-gift 均为有意设计，但与“不读写凭据内容”声明矛盾，需产品级裁决后要么豁免入档、要么改道。

## 5. 已查证“没问题”的关键点

1. **client.js 前端纪律**：全文件 grep 零 innerHTML/dangerouslySetInnerHTML/insertAdjacentHTML（无 XSS 注入面）；无十六进制硬编码色值（rgba 仅 111/321 两处带文档与主题回退的投影例外），`var(--token)` 40 处；STRINGS 内 zh/en 两表各 281 键经脚本比对**完全对齐**，locale/zh.json 与 en.json 顶层结构一致（各 285 个嵌套 key）。
2. **client.js 资源清理**：9 处 setTimeout/setInterval 与 3 处 addEventListener 全部核验有对应清理——订阅清零即 clearInterval（1440/1644/1977）、clearTimers 专用 effect（4861）、监听器三连 remove（4873-4876）、重试 timers 数组统一 clear（2727）、槽位宽限定时器挂 ctx.effect（6032-6033）。
3. **run-line-protocol.mjs 引擎判据**：纯函数零依赖叶子模块，engine 推断/规整（inferEngine/normalizeEngineSpec）四 runner 共用一份且幂等，Qoder 前缀剥离防静默退回 Auto 的坑有真机注释佐证。
4. **wire.host.mjs 总开关**：writeSwitch tmp+rename 原子写、写后立失效 mtime 缓存（115），readSwitch 永不抛、缺文件=开启不误锁，写入口全包唯一。

## 6. 未能覆盖的范围（诚实声明）

- `dispatch/test/` 69 个测试文件未逐个审查（仅确认数量与存在性）；**未运行任何测试门禁**（只读约束，DoD 级运行时验证不在本次范围）。
- `dispatch/wire.client.mjs`、`notify.mjs`、`core/quota.mjs`、`core/gift-quota.mjs`、`bridge/`、`tools/`、`refs/`、`profile-backup/` 未审。
- dispatch-core.mjs 4562 行中约 40% 行段（主要是 2700-3520 探测/登录区间及 1000-1500 持久化区间）依赖子代理通读报告，我仅对收录的每一条亲自核验了对应行号与代码；子代理的“超长函数行数表”未全量复核。
- appserver-gift.mjs(704 行) 仅查了凭据读取与进程清理关键段；engine-discover.mjs 仅验证安全包装器模式（33-36 全 try-catch），未通读。
- 两个审查子代理曾因模型并发限额失败一次，client.js 与 collab-kit 改由我以定向 grep+关键段精读覆盖，覆盖密度低于原计划的全量通读。

---

**审查方式备注**：本次为纯只读审查（Read/Grep/wc/node -e 只读比对），未修改、创建、删除任何文件，未执行记忆写入。核心三大高危（kill 复活、锁 TOCTOU、channels 挂起）均经我本人逐行二次核验后收录，行号可直接定位。
