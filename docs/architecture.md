# 架构、目录结构与复跑证据

> 本文是 [README](../README.md) 中「目录结构」「复跑证据」两节的展开。

## 目录结构

```
dispatch/                          ← 仓库根（monorepo：根 package.json 只是 bundle 声明）
├─ dispatch/                       ★ 插件本体（cordis bundle：Host 半边 + Client 半边）
│  ├─ index.js                           Host 入口：apply(ctx, config)、dispatcher 单例、
│  │                                     注册 agent 工具、激活信标
│  ├─ wire.host.mjs                      Host 接线 + 动作唯一实现 createActionHandler + 总开关读写
│  ├─ wire.client.mjs                    Client 接线 + 轮询 / demo 降级
│  ├─ client.js                          UI 半边：悬浮面板（React.createElement，无构建步骤）
│  ├─ core/                              派发核心（零 npm 依赖）：
│  │                                     dispatch-core / quota / gift-quota / appserver-rpc …
│  ├─ bin/dispatch.mjs                   独立 CLI（与插件同 core，用来对照排查）
│  ├─ locale/{zh,en}.json                中英文案（key 一一对应，有测试锁）
│  ├─ test/                              74 个可复跑自测文件
│  └─ cordis.patch.yml                   bundle 层 patch（**只放 demo/maxConcurrent**，
│                                        机器路径见 `install.md`）
├─ collab-kit/                     ★ 四个执行器（与插件 core 共用行协议，也可单独当 CLI 用）
│  ├─ zcode-run.mjs                     ZCode 执行器
│  ├─ opencode-run.mjs                  OpenCode 执行器
│  ├─ qoder-run.mjs                     Qoder 执行器（credits 计量）
│  ├─ codebuddy-run.mjs                 WorkBuddy / CodeBuddy 执行器（官方 CLI + 登录助手）
│  ├─ engine-discover.mjs               四引擎自动发现（env → 配置 → PATH → 已知位置 → 跨盘符）
│  ├─ spawn-target.mjs                  `.cmd/.bat` 安全启动（shim 解析 + fail-closed，四执行器共用）
│  ├─ run-line-protocol.mjs             行协议唯一权威（前缀 / 行语法 / 引擎差异字段）
│  ├─ kill-tree.mjs                     统一树杀（带超时，防 taskkill 挂死）
│  └─ appserver-gift*.mjs               ZCode Start Plan 免费额度托管
├─ tools/                          常驻证据脚本（verify-plugin / verify-switch / …）
├─ bridge/                         客户端自动化桥（inbox/outbox 收发任务文件）
├─ tasks/                          开发留档：每轮任务书与交付记录（含原始输出与未决项）
├─ refs/                           参考资料（**含第三方材料，见 README 文末声明**）
├─ docs/                           ★ 文档（本目录）
└─ profile-backup/                 DSH profile 配置的三态留档与恢复说明
```

## 设计取舍

| 取舍 | 为什么 |
|---|---|
| **core 零 npm 依赖** | 插件被装进用户的 DSH profile，多一个依赖就多一份供应链风险与安装失败面；标准库足够 |
| **client.js 无构建步骤** | 改动刷新页面即可验证，不需要跑打包链；代价是不能用 JSX/模块语法（有测试锁） |
| **动作实现在 wire 层唯一（`createActionHandler`）** | 面板与 agent 工具共用同一套动作 —— 一操作两调用方，不会出现"面板能做的工具做不了" |
| **`runnerPath`/`workRoot` 空则不建 dispatcher** | 不猜一个位置静默跑错；宁可面板走 demo 降级 + 工具返回可读错误 |
| **机器路径进 profile patch，不进仓库** | 仓库要能给别人用；宿主项目路径是本机部署配置 |
| **`dispatch/package.json` 与根 `package.json` 分离** | 根包声明 bundle（`dsh.bundle.patch`），子包是插件本体清单；DSH 只装根包 |

## 复跑证据

```bash
node tools/verify-plugin.mjs          # 插件形态与契约探针
node tools/verify-switch.mjs          # 派发总开关独立复现（用临时目录密封）
node tools/verify-engine-detail.mjs   # 四引擎自动发现真机冒烟
node tools/verify-zb95-state.mjs      # WorkBuddy 登录态三态（含临时 marker 造残留）
# 全量套件（74 个测试文件）：
node %TEMP%\dispatch-suite.mjs
```

各引擎专项（也可单独跑）：

```bash
cd dispatch
node test/core.test.mjs               # 派发核心
node test/qoder-executor.test.mjs     # Qoder 协议 / 聚合器 / credits 去重累加
node test/codebuddy-engine.test.mjs   # WorkBuddy 协议 / 端到端（退出码恒 0 的坑）/ 登录助手
node test/engine-discover.test.mjs    # 四引擎自动发现（五级优先级 + 假 fs）
node test/gift-quota.test.mjs         # 免费额度解析 + 陈旧度 + creditSummary 三态
node test/ctx-format.test.mjs         # 上下文占用展示
```

> **门禁阈值只升不降**；原始输出与未决项记录在 `tasks/` 下各轮的交付文档里。
> 踩过的真机坑（含根因与修法）见 [`pitfalls.md`](../pitfalls.md)，
> 引擎细节与验收清单见 [`dispatch/teaching.md`](../dispatch/teaching.md)。

## 第三方材料声明

`refs/dsh-tools/**` 是从本机 DSH 安装包**只读提取**的 `@deepseek-ai/dsh-tools` 包副本
（MIT 许可，`refs/dsh-tools/LICENSE` 随附），保留在此处是为了给插件开发提供**形态对照**。
其余 DSH 自带材料的提取副本（`refs/extracted/`、`refs/dsh-typert/`、`refs/plugin-whale-pet/` 等）
遵守**不入库**纪律，见 `.gitignore` 与 `refs/README.md`。
