#!/usr/bin/env node
/**
 * kill-tree.mjs —— **统一的进程树终止**（ZB-118）
 *
 * 背景（GLM-5.3 审查 MED，已核实）：三个执行器各自写了一份"杀进程树"，
 * 行为**不一致**且都有隐患：
 *   · opencode-run.mjs：`spawnSync('taskkill', …, { timeout: 15_000 })` —— 带超时（较好）；
 *   · qoder-run.mjs / codebuddy-run.mjs：`spawnSync('taskkill', …)` —— **无超时**，
 *     一旦 taskkill 挂住（进程树巨大/被占用），整个 runner 一起卡死，任务永远不落终态。
 *
 * 为什么必须树杀：runner spawn 的是引擎 CLI，CLI 自己还可能再 spawn 子进程 ——
 * 只杀 runner 会让 CLI 成为**孤儿**继续跑（耗额度、写工作区），而面板已显示任务结束。
 * 本文件 3218 行附近的登录助手早已自证"必须 taskkill /T /F"（否则它自己的 child 也清不干净）。
 *
 * 本模块只做一件事，**永不抛**：调用方在清理路径上不需要 try/catch。
 */
import { spawnSync } from 'node:child_process';

/**
 * 终止进程树（Windows: taskkill /T /F；其它平台: SIGKILL）。
 * @param {number} pid 目标进程（非正整数直接返回 false）
 * @param {{timeoutMs?: number}} [opts] taskkill 的超时（默认 15s —— 防止挂死）
 * @returns {boolean} 是否发出了终止请求（不代表进程一定已退出）
 */
export function killTree(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15_000;
  if (process.platform === 'win32') {
    try {
      /* /T = 连同子进程树；/F = 强制。/PID 区分大小写在 Windows 上无所谓。 */
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
