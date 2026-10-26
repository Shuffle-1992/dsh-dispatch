#!/usr/bin/env node
/**
 * DSH ↔ ZCode 客户端「桥」工具（零依赖）。
 * 用法：
 *   node tools/bridge.mjs submit <任务包.md> [--name <名字>]   # 投放任务到 inbox
 *   node tools/bridge.mjs status                               # inbox / outbox 概览
 *   node tools/bridge.mjs poll [超时秒=600] [轮询秒=5]          # 等 outbox 出现新交付
 *   node tools/bridge.mjs next                                 # 打印客户端将要取走的那个任务文件名
 * 说明：任务包由客户端「自动化（定时任务）」里的固定指令消费（见 bridge/README.md）。
 */
import { readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BRIDGE = join(ROOT, 'bridge');
const INBOX = join(BRIDGE, 'inbox');
const OUTBOX = join(BRIDGE, 'outbox');
const ARCHIVE = join(BRIDGE, 'archive');
for (const d of [INBOX, OUTBOX, ARCHIVE]) mkdirSync(d, { recursive: true });

const isTask = (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('README');
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter(isTask).sort() : []);

/* ---- 派发总开关（跨会话唯一真值来源）----
 * 契约见宿主仓库 collab/PROTOCOL.md §派发总开关。
 * 真值文件路径**不硬编码**（属机器专有配置）：必须用 DSP_SWITCH_FILE 指定，
 * 未指定时按「无文件 = 开启」放行（不误锁），并在投放前提示该事实。
 * 语义：enabled:false → 拒绝投放；文件缺失/损坏 → 视为开启（不误锁）。 */
const SWITCH_FILE = process.env.DSP_SWITCH_FILE || '';
function readDispatchSwitch() {
  try {
    if (!SWITCH_FILE) return { enabled: true, source: 'default(未配置 DSP_SWITCH_FILE=开启)' };
    if (!existsSync(SWITCH_FILE)) return { enabled: true, source: 'default(无文件=开启)' };
    /* R03：去 BOM（带 BOM 的正常 JSON 会让 JSON.parse 抛错 ⇒ 被误判"损坏" ⇒ 关闭失效）。 */
    const raw = JSON.parse(readFileSync(SWITCH_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { enabled: raw.enabled !== false, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy, note: raw.note };
  } catch (e) {
    return { enabled: true, source: `default(读取失败: ${e.message})` };
  }
}
function assertSwitchOn() {
  const sw = readDispatchSwitch();
  if (sw.enabled) return;
  console.error('[bridge] ⛔ 派发总开关为「关闭」，拒绝投放任务（没有任务会被客户端执行）。');
  console.error(`[bridge] 开关文件: ${SWITCH_FILE}`);
  if (sw.updatedBy || sw.updatedAt) console.error(`[bridge] 最后修改: ${sw.updatedBy ?? '?'} @ ${sw.updatedAt ?? '?'}`);
  if (sw.note) console.error(`[bridge] 备注: ${sw.note}`);
  console.error('[bridge] 恢复: 用 collab-kit 的 dispatch-switch.mjs 打开开关（node "<本仓库>/collab-kit/dispatch-switch.mjs" on）');
  process.exit(3);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'submit') {
  assertSwitchOn();
  const src = rest.find((a) => !a.startsWith('--'));
  if (!src) {
    console.error('用法: node tools/bridge.mjs submit <任务包.md> [--name <名字>]');
    process.exit(1);
  }
  const abs = resolve(src);
  if (!existsSync(abs)) {
    console.error(`任务包不存在: ${abs}`);
    process.exit(1);
  }
  const nameIdx = rest.indexOf('--name');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = (nameIdx >= 0 ? rest[nameIdx + 1] : null) ?? basename(abs);
  const dest = join(INBOX, name);
  copyFileSync(abs, dest);
  console.log(`[bridge] 已投递: ${dest}`);
  console.log(`[bridge] inbox 现有 ${list(INBOX).length} 条；客户端将先取: ${list(INBOX)[0]}`);
  console.log(`[bridge] 提示：客户端自动化按周期触发（见 bridge/README.md），也可在客户端点「立即运行」催一次。`);
} else if (cmd === 'status') {
  console.log(`[bridge] inbox(${list(INBOX).length}): ${list(INBOX).join(', ') || '空'}`);
  console.log(`[bridge] outbox(${list(OUTBOX).length}): ${list(OUTBOX).join(', ') || '空'}`);
  console.log(`[bridge] archive(${list(ARCHIVE).length}): ${list(ARCHIVE).slice(-3).join(', ') || '空'}`);
  console.log(`[bridge] 客户端将先取: ${list(INBOX)[0] ?? '(无)'}`);
} else if (cmd === 'next') {
  console.log(list(INBOX)[0] ?? '(inbox 为空)');
} else if (cmd === 'poll') {
  const timeoutSec = Number(rest[0] ?? 600);
  const intervalSec = Number(rest[1] ?? 5);
  const base = new Set(list(OUTBOX));
  const t0 = Date.now();
  console.log(`[bridge] watch ${OUTBOX}（基线 ${base.size} 条，超时 ${timeoutSec}s，轮询 ${intervalSec}s）`);
  const tick = () => {
    const news = list(OUTBOX).filter((f) => !base.has(f));
    if (news.length) {
      console.log(`[bridge] 新交付: ${news.join(', ')}`);
      for (const f of news) {
        const p = join(OUTBOX, f);
        console.log(`[bridge] ${f}: ${statSync(p).size} bytes, mtime=${statSync(p).mtime.toISOString()}`);
        console.log(readFileSync(p, 'utf8').slice(0, 800));
      }
      process.exit(0);
    }
    if ((Date.now() - t0) / 1000 > timeoutSec) {
      console.log('[bridge] 超时退出（无新交付）');
      process.exit(2);
    }
    setTimeout(tick, intervalSec * 1000);
  };
  tick();
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
}
