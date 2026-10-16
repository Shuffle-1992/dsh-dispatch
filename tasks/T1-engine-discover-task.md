# T1 任务包：统一引擎发现层 `collab-kit/engine-discover.mjs`

> 依据：`tasks/ZB-51-engine-autodiscovery.md`（设计）、`tasks/ZB-50-qoder-integration-spec.md` §8（Qoder 真机实测）
> **这是接口契约，实现必须逐字遵守导出名与返回形状**（core 与两个执行器都要消费它）。

## 目标
一个**零依赖**（只用 node 内置模块）的 ESM 叶子模块，负责回答一个问题：
> 「这台机器上，ZCode / OpenCode / Qoder 各自**有没有可用的 CLI、在哪、什么版本、是否已登录、什么形态**？」

它**不 spawn 真实任务**，只做路径查找 + 轻量探测（`--version` / `--list-models`）。

## 硬约束（违反即失败）
1. **零依赖**：只 `import` node 内置（`node:fs`、`node:path`、`node:os`、`node:child_process`）与同目录的 `./run-line-protocol.mjs`（可选）。
2. **绝不读写用户 agent 的配置内容**：可以 `existsSync` 判断凭据文件**是否存在**与大小，**绝不读取/解析**其内容。
3. **绝不写任何文件**（纯只读探测）。
4. **任何探测失败都不得抛异常到调用方**（返回 `found:false` + 可读 `reason`）。
5. 探测**必须带超时**（默认 10s/条），超时视为失败，绝不挂死。
6. 平台：Windows 优先，但代码要能在 macOS/Linux 跑（用 `path.delimiter`、`process.platform` 分支）。

## 必须导出（逐字）

```js
export const ENGINES = ['zcode', 'opencode', 'qoder'];   // qoder 同时代表 CN 版与全球版
export function discoverEngine(engine, opts = {}) { /* → Promise<DiscoveryResult> */ }
export function discoverAll(opts = {}) { /* → Promise<{ [engine]: DiscoveryResult }> */ }
export function describeDiscovery(result) { /* → string，给面板/日志的一行可读说明 */ }
```

### `DiscoveryResult` 形状（**字段名逐字**）
```js
{
  engine: 'zcode' | 'opencode' | 'qoder',
  found: boolean,            // 是否找到可用 CLI
  form: 'cli' | 'ide-bundled' | 'client' | 'ide-entry' | null,  // 形态
  entry: string | null,      // 可执行/入口的**绝对路径**
  entryKind: 'exe' | 'cmd' | 'ps1' | 'cjs' | 'js' | null,       // 文件类型（决定怎么 spawn）
  version: string | null,    // 版本号（探测得来）
  loggedIn: boolean | null,  // 是否已登录；null = 无法判定（不要猜 false）
  variant: string | null,    // 仅 qoder：'cn' | 'global'
  candidatesTried: Array<{ level: 'env'|'config'|'path'|'known'|'probe', value: string, ok: boolean, note?: string }>,
  reason: string,            // 一句话结论（无论成功失败都要有）
  warnings: string[],        // 可读告警（例如"找到 CLI 但未登录"）
}
```

### `discoverEngine(engine, opts)` 参数
```js
opts = {
  configPath: string|null,   // L2：插件 config 显式给的路径（可选）
  timeoutMs: 10000,          // 单条探测超时
  env: process.env,          // 便于测试注入
  fsProbe: null,             // 便于测试注入（{existsSync, statSync, readdirSync}）；null = 用真实 fs
  runProbe: null,            // 便于测试注入（(cmd,args,opts)=>Promise<{code,stdout,stderr}>）；null = 真跑
  knownRoots: [],            // 额外扫描根（测试用）
}
```

## 五级探测顺序（**逐级返回第一个成功的，不要合并**）
| 级 | 手段 | 说明 |
|---|---|---|
| `env` | `<ENGINE>_CLI` / `<ENGINE>_CLI_BIN` | ZCode: `ZCODE_CLI`；Qoder: `QODERCN_CLI_BIN`（CN）/`QODER_CLI_BIN`（全球） |
| `config` | `opts.configPath` | 存在且可执行才认 |
| `path` | 在 `opts.env.PATH` 各目录里按 **PATHEXT 顺序**找 `name+ext` | Windows 关键：`.CMD`/`.EXE`/`.BAT`/`.PS1`；**同名多命中只取第一个**（官方 dispatcher 的教训） |
| `known` | 下表候选表（跨盘符枚举用 `knownRoots` + 系统盘符列表） | 见下 |
| `probe` | 对已找到的 entry 跑 `--version`（与登录判据） | 失败 ⇒ `version:null` 但**不**否定 `found` |

### 各引擎候选表（`known` 级，按顺序）
```js
zcode: [
  '<root>/ZCode/resources/glm/zcode.cjs',            // 客户端自带 CLI（本机实测：F:\Program Files\ZCode\...）
]   // root ∈ [%ProgramFiles%, %ProgramFiles(x86)%, %LOCALAPPDATA%\Programs, %LOCALAPPDATA%, 各盘符:\Program Files]
    // entryKind 为 'cjs'（要用 node 跑）
    // 也认 PATH 里的 zcode / zcode.cmd / zcode.ps1

opencode: [
  '%APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',   // npm 全局实际落点（本机实测）
  '%LOCALAPPDATA%\\Programs\\opencode\\opencode.exe',               // 客户端形态
  '~/.opencode/bin/opencode',                                       // *nix 安装脚本
  '%APPDATA%\\npm\\opencode.cmd',                                   // npm shim
]

qoder: [   // 先 CN 再全球（两者可共存，视作同一 engine 但 variant 不同）
  CN:     '~/.qoder-cn/bin/qoderclicn/qoderclicn.exe',   // CLI 稳定入口（本机实测，v1.1.73）
          '~/.qoder-cn/entry/qoder-cn.cmd',              // 统一入口（dispatcher 会分派 CLI/IDE）
  global: '~/.qoder/bin/qoder', '%LOCALAPPDATA%\\Programs\\Qoder\\...'
]   // CN 的环境变量是 QODERCN_CLI_BIN；全球是 QODER_CLI_BIN（不要混用）
```

## 登录态探测（**必须按引擎分别实现，且只做存在性/可用性判断**）
| 引擎 | 判据（按优先级） | 说明 |
|---|---|---|
| **Qoder** | ① `runProbe(entry, ['--list-models'])` 成功（exit 0 且 stdout 有模型行）⇒ `loggedIn:true`；② 输出含 `Not logged in` ⇒ `loggedIn:false` + warning「需 `qoderclicn login`」 | 🔴 **实测结论**：IDE 的登录态 CLI 用不了；`.auth/` 目录存在**不代表**已登录（里面只有 machine_id）。**禁止**用 `.auth/` 判登录 |
| **ZCode** | `existsSync('~/.zcode/v2/credentials.json')` 且 `statSync().size > 0` | 只判存在与大小，**不读内容** |
| **OpenCode** | `existsSync('~/.local/share/opencode/auth.json')` | 只判存在 |

## 版本探测
- 统一尝试 `--version`（对 `.cjs`/`.js` 用 `node <file> --version`）
- 解析：取输出里第一个形如 `\d+\.\d+\.\d+` 的串；解析不到则 `version:null`（**不要伪造**）

## 关键边界（必须处理）
1. **同名多命中**：`PATH` 里可能同时有独立 CLI 和 IDE 自带的，**返回第一个标量路径**，绝不返回数组或拼接字符串。
2. **`.cjs`/`.js` 形态**（ZCode）：spawn 时前置 `node`，`entryKind` 如实上报 `'cjs'`。
3. **`.cmd`/`.ps1`**：Windows 下 `spawn` 需要 `shell:true` 或经 `cmd /c`；模块只需**如实上报 entryKind**，由调用方决定怎么跑（本模块不做 spawn 任务）。
4. **Qoder CN 与全球共存**：`variant` 分别上报；若两者都找到，**CN 优先**（同机更可能只用 CN），但要在 `warnings` 里说明"检测到两个版本"。
5. **全部失败**：`found:false`、`form:null`、`reason` 必须**列出查过哪些位置**（`candidatesTried` 里全部 `ok:false`），便于用户自查。

## 交付要求
1. `collab-kit/engine-discover.mjs`（模块本体，带中文注释解释每条"为什么"）
2. `dispatch/test/engine-discover.test.mjs`（**离线**、不 spawn 真 CLI、不联网）：
   - 用 `fsProbe`/`runProbe` 注入假环境，覆盖：五级各自命中、PATH 多命中只取第一个、`.cjs` 形态、Qoder 未登录文案、凭据文件不存在、全失败时 `reason` 含查过位置、超时不抛
   - **断言本机真实环境**（只读探测，允许慢）：`discoverAll()` 至少能发现 `zcode` 与 `opencode`（本机确定有），`qoder` 若找到则 `version` 非空
   - 不得 spawn 真实 AI 任务（只用 `--version`/`--list-models`）
3. 跑法：`node dispatch/test/engine-discover.test.mjs`，**退出码 0**，风格与既有测试一致（自打印 PASS/FAIL 计数 + `process.exit`）
4. 完成后回报：文件、`node --check` 结果、测试原始输出、以及**本机三个引擎的 `DiscoveryResult` 实打印**（JSON）

## 禁止
- 不要改 `collab-kit/zcode-run.mjs`、`opencode-run.mjs`、`qoder-run.mjs`（T3/他人范围）
- 不要改 `dispatch/core/**`、`dispatch/client.js`（T2/T5 范围）
- 不要写任何文件到用户目录；不要读凭据内容
