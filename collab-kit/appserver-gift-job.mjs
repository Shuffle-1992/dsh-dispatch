/**
 * 派发台的**免费额度（Start Plan）任务外壳** —— 产物、台账、输出行全部对齐 print 模式，
 * 这样派发台的解析（`parseRunnerLine`）、暂停分类（`PAUSE_SIGNATURES`）、面板、重试/交接、
 * 回退**一行都不用改**。
 *
 * 与 print 模式（`zcode.cjs -p`）的差异只有一处：**执行后端换成 app-server 托管**
 * （见 `appserver-gift.mjs` 的模块头注释）。产物命名/字段/输出行格式刻意保持一致。
 *
 * ⚠️ 输出行纪律（`dispatch-core.parseRunnerLine` 的契约）：
 *   - 只允许打**已知形状**的 `[zcode-run] …` 行（start/provider/done/endpoint/usage/context/out/err/result）；
 *   - 其余诊断一律用 `[gift] …` 前缀（不带 `[zcode-run]`）——否则会被解析器当成"识别失败"并记 warning。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGiftAuth, runGiftTurn, startPlanProviderId } from './appserver-gift.mjs';

/** 暂停指纹：命中即打印对应字样，让派发台的既有分类与"自动交接"生效（不新造分类）。 */
const PAUSE_HINTS = [
  { reason: 'plan-not-entitled', re: /not_entitled|not entitled|未开通|未启用|未生效/i, token: 'coding_plan_not_entitled' },
  { reason: 'provider-signing', re: /ClientRequestSigningV4Error|signature|签名/i, token: 'ClientRequestSigningV4Error' },
  { reason: 'quota-exhausted', re: /quota|额度|balance|insufficient|rate_?limit|\b429\b|\b1005\b/i, token: 'quota_exceeded' },
];

/**
 * 跑一个免费额度任务。
 * @param {object} input
 * @param {string} input.cliPath       zcode.cjs
 * @param {string} input.prompt        任务文本（已组装，含 memory-ban）
 * @param {string} input.cwd           agent 工作目录
 * @param {string} input.tag
 * @param {string} [input.taskPath]
 * @param {object} input.opt           runner 的参数对象（model/reasoningLevel/mode/timeoutMin/ledger…）
 * @param {string} input.outLog
 * @param {string} input.errLog
 * @param {string} input.resultFile
 * @param {string} input.ledgerPath
 * @returns {Promise<number>} 退出码（0 成功 / 1 失败 / 124 超时；与 print 模式同语义）
 */
export async function runGiftJob(input) {
  const { opt } = input;
  const startedAt = new Date();
  const started = Date.now();

  console.log(`[zcode-run] tag=${input.tag} mode=${opt.mode} cwd=${input.cwd}`);
  /* provider= 这一行是派发台记录 job 通道的依据：优先用显式通道 id，否则按账号家族解析
   * （与 runGiftTurn 内部同源；解析失败就落回 'start-plan'，真正的错误在 runGiftTurn 里报）。 */
  const providerForLine = (() => {
    if (typeof input.accountProviderId === 'string' && input.accountProviderId !== '') return input.accountProviderId;
    try {
      return startPlanProviderId(readGiftAuth().activeProvider);
    } catch {
      return 'start-plan';
    }
  })();
  console.log(`[zcode-run] provider=${providerForLine} model=${opt.model ?? 'GLM-5.3-Flash'} (免费额度 Start Plan)`);
  if (input.taskPath) console.log(`[zcode-run] task=${input.taskPath}`);
  console.log(`[zcode-run] cli=${input.cliPath}`);
  if (opt.reasoningLevel) console.log(`[gift] reasoningLevel=${opt.reasoningLevel}`);

  let lastReport = 0;
  /* ZB-40：**心跳**（用户要求「能看出进程确实在工作还是卡住」）——
   * 每 10s 打一行 `[zcode-run] progress stage=… elapsed=…s chars=… tools=…`，
   * 派发台解析后可在面板/job 上显示"当前在做什么 + 多久没动静"。 */
  const progress = { stage: 'spawn-app-server', at: Date.now(), textChars: 0, tools: 0 };
  const heartbeat = setInterval(() => {
    const ago = ((Date.now() - (progress.at ?? Date.now())) / 1000).toFixed(0);
    console.log(
      `[zcode-run] progress stage=${progress.stage ?? '?'} elapsed=${((Date.now() - started) / 1000).toFixed(0)}s ` +
        `chars=${progress.textChars ?? 0} tools=${progress.tools ?? 0}${progress.lastTool ? ` lastTool=${progress.lastTool}` : ''} ` +
        `stageAgo=${ago}s${progress.sessionId ? ` session=${String(progress.sessionId).slice(5, 13)}` : ''}`,
    );
  }, 10000);
  let result;
  try {
    result = await runGiftTurn({
      cliPath: input.cliPath,
      prompt: input.prompt,
      cwd: input.cwd,
      model: opt.model,
      reasoningLevel: opt.reasoningLevel,
      mode: opt.mode,
      accountProviderId: input.accountProviderId,
      timeoutMs: Math.max(1, opt.timeoutMin) * 60 * 1000,
      progress,
      logger: { info: (m) => console.log(m), warn: (m) => console.error(m) },
      onEvent: (kind, payload) => {
        const now = Date.now();
        if (now - lastReport < 3000) return; // 进度节流（避免刷屏）
        lastReport = now;
        if (kind === 'tool') console.log(`[gift] 工具 ${payload.name}（${payload.type}）`);
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  /* ── 产物（与 print 模式同名：out = agent 正文，err = 诊断尾部，result = 可解析摘要） ── */
  const resultShape = {
    sessionId: result.sessionId ?? null,
    traceId: null,
    response: result.response ?? '',
    usage: result.usage,
    projection: result.projection,
    channel: result.channel,
    accountProviderId: result.accountProviderId ?? null,
    runtimeVersion: result.runtimeVersion ?? null,
    finish: result.finish,
    usageBasis: result.usage?.usageBasis ?? null,
    serverRequests: result.serverRequests ?? null,
    toolEventCount: result.toolEvents ?? null,
    toolNames: result.toolNames ?? [], // ZB-34：本次用过的工具名（空 = 没调工具）
    eventTypes: result.eventTypes ?? [], // ZB-34：见过的事件类型（对齐真实词汇表）
    permissionRequests: result.permissionRequests ?? [], // ZB-35：审批链路（yolo 通常为空）
    reasoningChars: result.reasoningChars ?? null,
    providerError: result.providerError ?? null, // ZB-40：上游业务错误（如 1005 exceed quota limit）
    lastStage: progress.stage ?? null, // ZB-40：卡在哪一阶段（诊断用）
  };
  writeFileSync(input.outLog, `${result.response ?? ''}\n\n--- gift-result-json ---\n${JSON.stringify(resultShape, null, 2)}\n`);
  writeFileSync(input.errLog, `${(result.stderrTail ?? []).join('\n')}\n`);
  writeFileSync(input.resultFile, JSON.stringify(resultShape, null, 2));

  /* ── 输出行（形状必须与 dispatch-core 的正则一致） ── */
  const channel = result.channel ?? {};
  console.log(
    `[zcode-run] done exit=${result.exitCode}${result.timedOut ? ' (超时)' : ''} elapsed=${elapsed}s` +
      (result.sessionId ? ` session=${result.sessionId}` : '') +
      (channel.providerId ? ` provider=${channel.providerId}` : '') +
      (channel.modelId ? ` model=${channel.modelId}` : '') +
      (result.response ? ` responseChars=${String(result.response).length}` : ''),
  );
  if (channel.baseURL) console.log(`[zcode-run] endpoint=${channel.baseURL}`);
  const usage = result.usage ?? {};
  console.log(
    `[zcode-run] usage requests=${usage.modelRequestCount ?? '-'} in=${usage.inputTokens ?? '-'} out=${usage.outputTokens ?? '-'} cacheRead=${usage.cacheReadTokens ?? '-'}`,
  );
  const projection = result.projection ?? {};
  if (Number.isFinite(projection.contextUsed) && projection.contextUsed > 0) {
    const pct = Number.isFinite(projection.contextWindow) && projection.contextWindow > 0
      ? ` (${((projection.contextUsed / projection.contextWindow) * 100).toFixed(1)}% of ${projection.contextWindow})`
      : '';
    if (pct === '') {
      /* 正则要求带窗口：没有窗口时只打诊断行（不带 [zcode-run] 前缀），不污染解析。 */
      console.log(`[gift] context used=${projection.contextUsed}（窗口未知）turnCount=${projection.turnCount ?? '-'}`);
    } else {
      console.log(`[zcode-run] context used=${projection.contextUsed}${pct} turnCount=${projection.turnCount ?? '-'}`);
    }
  }
  console.log(`[zcode-run] out=${input.outLog}`);
  console.log(`[zcode-run] err=${input.errLog}`);
  console.log(`[zcode-run] result=${input.resultFile}`);

  /* ── 失败归因：命中暂停指纹就打出对应字样（派发台据此落 paused 并可能自动交接） ── */
  const failureText = `${result.finish?.error ?? ''} ${(result.stderrTail ?? []).join(' ')}`;
  /* ZB-40：上游业务错误（providerCode/providerMessage）优先成句 —— 真机事故里
   * `GLM-5.3` 在免费额度通道被判 `1005 exceed quota limit`，必须让调用方一眼看懂怎么改。 */
  const pe = result.providerError;
  if (result.exitCode !== 0 && pe && (pe.code !== null || pe.message)) {
    console.error(
      `[gift] 上游业务错误 providerCode=${pe.code ?? '-'} providerId=${pe.providerId ?? '-'} ` +
        `modelId=${pe.modelId ?? '-'} retryable=${pe.retryable ?? '-'} message="${String(pe.message).slice(0, 160)}"` +
        (/exceed quota limit/i.test(String(pe.message))
          ? ` ｜ 提示：免费额度权益通常只授予**特定模型**（以 action=quota 的 giftQuota.model 为准）——用未授予的模型会被判 1005；不改 model 直接重试一定还会失败`
          : ''),
    );
    console.error(`[gift] pause-signature quota-exhausted（上游额度/权益判定）：${String(pe.message).slice(0, 200)}`);
  } else if (result.exitCode !== 0 && failureText.trim() !== '') {
    for (const hint of PAUSE_HINTS) {
      if (hint.re.test(failureText)) {
        console.error(`[gift] pause-signature ${hint.token}（${hint.reason}）：${failureText.slice(0, 300)}`);
        break;
      }
    }
  }
  if (result.timedOut) {
    console.error(`[gift] 超时（${opt.timeoutMin}min）已终止会话；stderr 尾部见 ${input.errLog}`);
  }

  /* ── 台账（字段与 print 模式同形；billing 用独立取值便于面板分辨免费额度） ── */
  if (opt.ledger) {
    try {
      appendFileSync(
        input.ledgerPath,
        JSON.stringify({
          at: startedAt.toISOString(),
          tag: input.tag,
          task: input.taskPath ? input.taskPath.replace(`${input.project}\\`, '').replace(/\\/g, '/') : null,
          mode: opt.mode,
          kind: 'prompt',
          billing: 'zcode-plan-gift', // 免费额度（Start Plan）：与付费套餐分账
          provider: channel.providerId ?? result.accountProviderId ?? null,
          endpoint: channel.baseURL ?? null,
          model: channel.modelId ?? opt.model ?? null,
          sessionId: result.sessionId ?? null,
          traceId: null,
          exit: result.exitCode,
          timedOut: result.timedOut === true,
          signal: null,
          silentExit: false,
          rateLimited: null,
          retryAfterSec: null,
          elapsedSec: Number(elapsed),
          requests: usage.modelRequestCount ?? null,
          /* ⚠️ 单次调用口径（见 appserver-gift.mjs 的 usage 折算注释）：多调用回合上报的是
           * CLI 的按次上下文，不是回合聚合 —— 直接记聚合会虚高 N 倍。 */
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          usageBasis: usage.usageBasis ?? null,
          contextUsed: projection.contextUsed ?? null,
          contextWindow: projection.contextWindow ?? null,
          responseChars: result.response ? String(result.response).length : null,
          channel: 'appserver-gift',
        }) + '\n',
      );
    } catch {
      /* 台账写入失败不影响主流程 */
    }
  }

  return result.exitCode;
}
