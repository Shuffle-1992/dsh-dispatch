# 审查复现说明

基线与交付范围见根目录《项目全面审查报告-2026-10-26.md》。所有内容均基于本次本地代码和实际工具输出；未调用真实模型完成复现。

## 现有门禁

- 遍历 `dispatch/test/*.test.mjs`，每个文件使用独立 `node <file>` 子进程串行执行，单文件最长等待 150 秒，stdout/stderr 分文件保存。
- 首轮结果见 `suite-results.json`。四个非零退出文件在允许的沙箱外环境使用同样 Node 和原文件复跑，结果见 `rerun-results.json`。
- `node --check` 检查 Git 跟踪的自有 JS/MJS，共 124 个文件，不包括第三方 refs 代码，结果见 `syntax.json`。
- 另外执行 `node tools/verify-plugin.mjs`、`node tools/verify-switch.mjs`、`node dispatch/test/z2-verify.mjs`、`node dispatch/test/z4-token-check.mjs`；各自原始日志均保留。
- 首轮的 taskkill 环境诊断：创建一个只等待 3 秒的 Node 子进程，执行 `taskkill /PID <本次子进程PID> /T /F`；得到 status=1，stderr 的 Windows 本地编码文本为“错误: 拒绝访问”。随后调用该 ChildProcess.kill 清理。没有针对用户现有进程执行终止。

## 安装包

在仓库根执行：

```powershell
npm.cmd pack --dry-run --json --ignore-scripts --cache ./test/.npm-review-cache
npm.cmd pack ./dispatch --dry-run --json --ignore-scripts --cache ./test/.npm-review-cache
```

按返回 `files[].path` 分别复制到 `test/.review-runtime/package-root/package` 与 `package-dispatch/package`，只复制清单内文件。在对应隔离目录执行 Node ESM import 入口，保存 exit/stdout/stderr。这是 pack 清单忠实重建，不是 DSH 插件管理器或远程 Git 安装实测。

## R02 命令参数

导入两个 runner 的真实 `spawnTarget` 和 `buildQoderArgs/buildCodebuddyArgs`。假 CLI 是仅包含 `@echo OFF`、`echo AUDIT_FAKE_CLI` 的 `.cmd`。输入提示词为 `hello & echo AUDIT_SHELL_EXECUTED & rem`。按返回 cmd/argv/shell 启动子进程，检查是否出现额外标记。测试动作只有本地打印；没有文件删除或网络访问。

## 锁与终止

- 活锁年龄：用 `__testables.isStaleLock/acquireLockFile`，锁的 PID 指向当前测试进程，at 设置为 `now - LOCK_STALE_MS - 1000`，记录抢占前后。
- 陈旧锁竞争：仅在测试进程内替换 `fs.renameSync` 并 `syncBuiltinESMExports()`；当真实锁获取函数即将搬走旧锁时，注入另一个有效 owner 的新锁。随后恢复原始 fs 方法。此为确定性 interleaving 注入，不是跨进程压力测试。
- 跨进程 kill：A 创建 dispatcher 并启动 20 秒等待型假 runner，B 为独立 Node 进程，使用同 workRoot 创建 dispatcher 后 kill。比较 B 的返回、B 状态和 A 状态。最后由 A 终止自身子进程。已在沙箱外重新执行，最终 `targeted-repro.json` 为复核结果。
- 相对文件锁：两个任务 cwd 相同，write 分别为 `same.txt` 和目标目录下绝对 `same.txt`；比较 running 状态及实际 fileLocks。工具文档要求绝对路径，复现针对的是实现未拒绝非法输入。

## 开关、降级和通知

- BOM：只在临时目录创建 `\uFEFF + JSON.stringify({enabled:false})`。调用两个真实读取器，再将该路径通过 `ZCODE_SWITCH_FILE` 传给 Qoder runner；QODER_CLI 指向只输出固定 result 的假脚本。
- 冻结探测：无 BOM 的关闭文件，分别运行三引擎 runner 的 `--version`，确认在调用 CLI 前被拒绝。
- 清理竞争：假 ZCode runner 输出 `quota_exceeded` 并退出 1；channelsImpl 返回人为延迟的 Promise。原任务 paused 后先 dispose，再释放返回可用 Qoder 的 Promise，观察实际后继 job。
- 通知：同样的降级链，使用真实 createSettleNotifier 和记录消息的假 agent；只给初始任务登记 owner，观察后继 done 是否通知。
- 通道缓存：真实 createRemoteFace，listChannels 为延迟 100ms 的计数函数，Promise.all 同时调用 channels 三次。只用于证明去重缺失，不证明真实探测耗时。

## 参数与文件边界

- retry：真实 createActionHandler，对 dispatcher.retry 的 opts 做捕获，同时输入 reasoningLevel/thinking=max，确认两者均没有转发。
- junction：允许根仅设为临时 work/logs，在其内部创建 junction 指向另一个临时目录；目标内容是 `AUDIT_SYNTHETIC_OUTSIDE_LOG_ROOT`。恢复一个 outLog 指向 junction 的已结束假 job，再调用 tail。测试完成后已移除 junction，未读取任何真实敏感文件。
- 性能：生成 32 MiB、每行 1024 字节的合成文件。调用真实 tail(...,30) 三次，在测试进程内观测该文件 readFileSync 的实际字节数及 performance.now 耗时；完成后恢复方法。结果是本机合成负载，不能作为生产 P95。

## 产物纪律

临时脚本、假 CLI、合成日志、隔离包和 npm 临时缓存均在 `test/` 下。脚本哈希见 `verification-summary.json`，清理后仅保留本目录证据和根报告。已有项目测试不删除。业务文件哈希核对见 `final-integrity.json`。

首轮日志、后续复跑日志和专项结果都保留；没有通过筛选删除失败证据制造全绿结论。
