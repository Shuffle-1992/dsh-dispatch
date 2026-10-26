#!/usr/bin/env node
/**
 * dispatch-switch.mjs —— 派发总开关（跨会话唯一真值来源）
 *
 * 为什么是文件而不是内存开关：DSH 会话、ZCode 会话、桥（客户端自动化）是**不同进程**，
 * 只有落在磁盘上的状态才可能被所有会话读到。文件即契约，见 collab/PROTOCOL.md。
 *
 * 用法：
 *   node <本仓库>/collab-kit/dispatch-switch.mjs status [--json]    # 查状态（默认人类可读）
 *   node <本仓库>/collab-kit/dispatch-switch.mjs on  [--by <who>] [--note "<原因>"]
 *   node <本仓库>/collab-kit/dispatch-switch.mjs off [--by <who>] [--note "<原因>"]
 *
 * 状态语义：enabled=true 允许把任务派发给 ZCode 子代理；false = 一律拒绝派发。
 * 缺文件 = 开启（保持历史行为）；读取失败 = 开启（不因开关文件损坏而误锁）。
 *
 * 谁遵守（缺一不可，新入口必须一并接入）：
 *   1) collab-kit/zcode-run.mjs      —— 无头派发（本仓库所有 run 的必经之路）
 *   2) dispatch 插件的 Host 动作层     —— 面板/agent 工具的 dispatch 动作
 *   3) dispatch/tools/bridge.mjs      —— 客户端自动化桥的投放
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 项目根（含 collab/ 的目录）：--project > env ZCODE_PROJECT_DIR > cwd。
 * 本工具已迁至 dispatch/collab-kit，不再与宿主项目有目录关系。 */
function resolveProjectRoot() {
  const i = process.argv.indexOf('--project');
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  const env = process.env.ZCODE_PROJECT_DIR;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(process.cwd());
}
const PROJECT = resolveProjectRoot();
export const SWITCH_FILE =
  process.env.ZCODE_SWITCH_FILE && process.env.ZCODE_SWITCH_FILE.trim() !== ''
    ? resolve(process.env.ZCODE_SWITCH_FILE.trim())
    : join(PROJECT, 'collab', 'dispatch.switch.json');

/** 读开关（任何会话都可调用；永不抛）。 */
export function readDispatchSwitch(file = SWITCH_FILE) {
  try {
    if (!existsSync(file)) return { enabled: true, source: 'default(无文件=开启)', path: file };
    /* R03（2026-10-26 审查 P1）：**去 BOM** —— 带 UTF-8 BOM 的正常 JSON 会让 JSON.parse 抛错，
     * 落进 catch 的"读取失败⇒开启"分支 ⇒ **关闭开关静默失效**。 */
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      enabled: raw.enabled !== false,
      path: file,
      updatedAt: raw.updatedAt,
      updatedBy: raw.updatedBy,
      note: raw.note,
      source: 'file',
    };
  } catch (e) {
    return { enabled: true, source: `default(读取失败: ${e.message})`, path: file };
  }
}

/**
 * provider 通道状态（PROTOCOL §7.1，T19 采纳）：
 * `enabled:false` = 套餐整体冻结 —— 既不派发、也不经 provider 通道烧套餐。
 * 与 dispatch 同源开关，仅作展示，不改变 readDispatchSwitch 契约。
 */
export function providerChannelState(enabled) {
  return enabled ? 'active' : 'frozen';
}

/** 写开关（原子替换：临时文件 + rename）。 */
export function writeDispatchSwitch(enabled, { by = 'unknown', note = '' } = {}, file = SWITCH_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const body = {
    enabled: !!enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
    note,
    contract: 'collab/PROTOCOL.md §派发总开关；false = 任何会话都不得把任务派发给 ZCode',
  };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return readDispatchSwitch(file);
}

function main() {
  /* `--project <dir>` 可出现在任意位置（含子命令之前）；先摘掉再解析子命令，
   * 否则 `--project` 会被当成子命令名。项目根本身已在模块顶部解析（供 SWITCH_FILE 使用）。 */
  const raw = process.argv.slice(2);
  const pi = raw.indexOf('--project');
  const rest0 = pi >= 0 ? [...raw.slice(0, pi), ...raw.slice(pi + 2)] : [...raw];
  const [cmd, ...rest] = rest0;
  const getFlag = (name, dflt = '') => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };
  const json = rest.includes('--json');
  const by = getFlag('--by', 'cli');

  if (cmd === 'on' || cmd === 'off') {
    const st = writeDispatchSwitch(cmd === 'on', { by, note: getFlag('--note', '') });
    if (json) console.log(JSON.stringify(st, null, 2));
    else console.log(`[dispatch-switch] 已${st.enabled ? '开启' : '关闭'} ZCode 派发（by=${by}）→ ${st.path}`);
    return 0;
  }
  if (cmd === 'status' || cmd === undefined) {
    const st = readDispatchSwitch();
    const providerChannel = providerChannelState(st.enabled);
    if (json) {
      console.log(JSON.stringify({ ...st, providerChannel }, null, 2));
    } else {
      console.log(`[dispatch-switch] 派发总开关：${st.enabled ? '✅ 开启' : '⛔ 关闭'}`);
      console.log(`[dispatch-switch] provider-channel: ${providerChannel}`);
      console.log(`[dispatch-switch] 真值来源：${st.source}`);
      if (st.updatedBy) console.log(`[dispatch-switch] 最后修改：${st.updatedBy} @ ${st.updatedAt}`);
      if (st.note) console.log(`[dispatch-switch] 备注：${st.note}`);
      console.log(`[dispatch-switch] 文件：${st.path}`);
    }
    return st.enabled ? 0 : 2; // 退出码 2 = 当前处于关闭（便于脚本判断）
  }
  console.error('用法: dispatch-switch.mjs status [--json] | on|off [--by <who>] [--note "<原因>"]');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exit(main());
