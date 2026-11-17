/**
 * dsh-workbuddy-balancer —— 给 WorkBuddy 账号池加上「积分临期 / 积分少优先」
 *
 * 为什么要有这个插件：`dsh-connect-workbuddy` 的 `rankPool` 默认把余额**多**的
 * 账号排在前面，结果是余额最多的账号一直被用，其余账号的积分静静过期。
 * 想改成「临期的先用、少的先用」只有两条路：
 *   ① 改上游 bundle 的源码 —— 已被证明走不通：上游一升级，改动就没了
 *      （5.23.1 → 5.24.9 → 5.24.13 连着丢了两次，连精确版本锁定都没拦住）。
 *   ② 写一个独立的附属插件，只动上游**本来就读**的配置字段。
 *
 * 本插件走 ②。它不 patch、不 import 上游代码、不碰 node_modules：
 * 读上游的账号余额接口 → 自己算加权顺序 → 写进上游的
 * `regions.<region>.pool.orderAccountIds`（volatile 字段，就地生效）。
 * 上游 `applyPoolSelection` 每个请求都会重读这个数组，所以下一次请求就用上新顺序。
 * 上游升级后本插件照旧工作，因为 `orderAccountIds` 是它的公开配置之一。
 *
 * ## 为什么写盘要绕一条自己的 HTTP 路由
 *
 * `settings.mutate` 最终走 `configEditor.edit`，而后者被 `hmr.runExclusive()`
 * 包着；`runExclusive` 检测到「已经在事务里」时直接抛
 * `HMR transactions cannot be nested`。
 *
 * 插件 `apply()` 本身就是在一次 HMR 事务里被调用的，`AsyncLocalStorage`
 * 的 store 会顺着 `setTimeout` 一起传下去 —— 于是在 apply 里起的定时器，
 * 每一拍都带着「我在事务里」的标记，定时写盘**必然**失败。手动工具/命令能成功，
 * 是因为它们由 agent 循环调用，不在那条异步链上。
 *
 * 所以：定时器不自己写盘，它向本插件自己注册的一条 loopback 路由发一个请求，
 * 由那条路由的 handler（真实 HTTP 请求，全新的异步上下文）去写。这和上游
 * `__save` 路由写配置的做法是同一个形状。
 *
 * 排序算法与设计理由见 `lib/priority.js` 顶部注释；I/O 与写入路径见 `lib/balancer.js`。
 */

import { createBalancer, describeReport } from './balancer.js';

export const name = 'dsh-workbuddy-balancer';

/** 刻意不 inject：排序跑起来需要 settings 与 webServer，但那两个都在 apply 里按需取，
 *  服务晚到也不会让插件启动失败（下面用 ctx.inject 等它们就位再开定时器）。 */
export const inject = [];

/** 本插件自己的触发路由（定时器用它来获得一个干净的异步上下文）。 */
export const APPLY_PATH = '/plugins/dsh-workbuddy-balancer/apply';

const DEFAULTS = {
  /** 总开关。关掉后定时器不启动，手动工具仍可用（用于试算）。 */
  enabled: true,
  /** 是否按间隔自动重排。关掉则只能手动跑工具/命令。 */
  autoRefresh: true,
  /** 自动重排间隔。上游余额快照 10 分钟过期，这里默认 10 分钟对齐。 */
  intervalMs: 600_000,
  /** 最短写盘间隔：避免两次跑得太近时反复重写同一份配置（写盘会落 YAML 文件）。 */
  minWriteIntervalMs: 60_000,
  /** 启动后等多久再跑第一轮，给宿主把网关注册完留出余量。 */
  startupDelayMs: 15_000,
  /** 只处理这些区域；空数组 = 配置里出现的所有区域。 */
  regions: [],
  /** 只算不写（试算模式）。 */
  dryRun: false,
  /** 临期项的分离量级；默认 1e9 是**分离保证**，不是调参项，见 priority.js。 */
  urgentWeight: 1e9,
  /** 距到期天数下限，防止当天到期除以小数。 */
  minDaysLeft: 1,
};

function normalizeConfig(raw) {
  const merged = { ...DEFAULTS };
  if (raw === null || typeof raw !== 'object') return merged;
  const bool = (key) => {
    if (typeof raw[key] === 'boolean') merged[key] = raw[key];
  };
  bool('enabled');
  bool('autoRefresh');
  bool('dryRun');
  const number = (key, min, max) => {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) {
      merged[key] = Math.max(min, Math.min(max, raw[key]));
    }
  };
  number('intervalMs', 30_000, 24 * 3600_000);
  number('minWriteIntervalMs', 5_000, 3600_000);
  number('startupDelayMs', 0, 300_000);
  number('minDaysLeft', 0.001, 365);
  if (typeof raw.urgentWeight === 'number' && Number.isFinite(raw.urgentWeight) && raw.urgentWeight > 0) {
    merged.urgentWeight = raw.urgentWeight;
  }
  if (Array.isArray(raw.regions)) {
    merged.regions = raw.regions.filter((region) => typeof region === 'string' && region.length > 0);
  }
  return merged;
}

/** 往宿主日志写一行；任何异常都不许冒泡到启动链。 */
function report(message) {
  try {
    process.stderr.write(`${name}: ${message}\n`);
  } catch {
    /* 忽略 */
  }
}

/** 只服务本机：定时器与手动触发都来自 loopback。 */
function isLoopbackPeer(req) {
  const address = req?.socket?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['apply', 'dry-run'],
      description: 'apply 计算并写入上游顺序；dry-run 只算不写',
    },
    region: {
      type: 'string',
      description: '只处理这个区域（如 cn / global），省略则处理配置里列出的所有区域',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    text: { type: 'string' },
    config: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        autoRefresh: { type: 'boolean' },
        intervalMs: { type: 'number' },
        minWriteIntervalMs: { type: 'number' },
        startupDelayMs: { type: 'number' },
        regions: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
      },
      required: ['enabled', 'autoRefresh', 'intervalMs'],
      additionalProperties: false,
    },
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          region: { type: 'string' },
          accounts: { type: 'integer' },
          written: { type: 'boolean' },
          order: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['region', 'written'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
};

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  let balancer = null;
  let selfOrigin = null;
  /** 定时器是否真的排上了（用来说明「自动重排」到底开没开）。 */
  let timerArmed = false;
  let lastAutoRunAt = null;
  /** 上一轮自动重排的完整结果，供工具/命令回显 —— 定时器的问题不能只进 stderr。 */
  let lastAutoReport = null;
  /** 定时器那一侧的失败原因（例如路由没起来），单独记下来。 */
  let lastAutoError = null;

  /** 一行配置摘要，方便一眼看出配置到底有没有生效。 */
  const configLine = () =>
    `配置：enabled=${config.enabled} autoRefresh=${config.autoRefresh} intervalMs=${config.intervalMs} ` +
    `startupDelayMs=${config.startupDelayMs} minWriteIntervalMs=${config.minWriteIntervalMs} ` +
    `regions=${config.regions.length === 0 ? '全部' : config.regions.join(',')} dryRun=${config.dryRun}`;

  const timerLine = () => {
    if (!(config.enabled && config.autoRefresh)) return '自动重排：关闭';
    if (!timerArmed) return '自动重排：配置为开启，但定时器未就绪';
    const when = lastAutoRunAt === null ? '（尚未跑过第一轮）' : `（上次 ${new Date(lastAutoRunAt).toLocaleTimeString()}）`;
    const head = `自动重排：已启动，间隔 ${Math.round(config.intervalMs / 1000)}s${when}`;
    if (lastAutoError !== null) return `${head}\n  上一轮失败：${lastAutoError}`;
    if (lastAutoReport === null) return head;
    if (lastAutoReport.error !== undefined) return `${head}\n  上一轮失败：${lastAutoReport.error}`;
    const rows = lastAutoReport.regions.map((row) => `[${row.region}] ${row.note}`).join('；');
    return rows.length === 0 ? head : `${head}\n  上一轮：${rows}`;
  };

  /** 把配置与定时器状态拼到报告后面 —— 报告本身只讲结果。 */
  const withDiagnostics = (text) => `${text}\n\n${configLine()}\n${timerLine()}`;

  /** 直接跑一轮（工具/命令用；它们不在 HMR 事务里，写盘没问题）。 */
  async function runOnce(options = {}) {
    if (balancer === null) {
      return {
        atMs: Date.now(),
        dryRun: options.dryRun === true,
        regions: [],
        error: 'settings / webServer 服务还没就位（插件刚启动？）',
      };
    }
    return balancer.run(options);
  }

  /**
   * 定时器专用：走自己的路由，拿一个干净的异步上下文去写盘。
   * 直接调 `settings.mutate` 会撞上 `HMR transactions cannot be nested`，原因见文件头。
   */
  async function runViaRoute(options = {}) {
    if (selfOrigin === null) throw new Error(`${APPLY_PATH} 路由还没就绪`);
    const query = options.dryRun === true ? '?dryRun=1' : '';
    const response = await fetch(`${selfOrigin}${APPLY_PATH}${query}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`${APPLY_PATH} 返回 ${response.status}`);
    const body = await response.json();
    if (body?.error !== undefined) throw new Error(String(body.error));
    return body.report;
  }

  ctx.inject(['settings', 'webServer'], (sub) => {
    balancer = createBalancer({
      settings: sub.settings,
      webServer: sub.webServer,
      config,
      log: report,
    });
    const port = sub.webServer.port;
    const protocol = typeof sub.webServer.protocol === 'string' ? sub.webServer.protocol : 'http:';
    selfOrigin = Number.isInteger(port) && port > 0 ? `${protocol}//127.0.0.1:${port}` : null;

    // ---- 触发路由 ------------------------------------------------------
    // 只做一件事：在真实 HTTP 请求的上下文里跑一轮（从而能安全写配置）。
    sub.effect(() => {
      const dispose = sub.webServer.register({
        kind: 'exact',
        path: APPLY_PATH,
        handler: async (req, res) => {
          const send = (code, payload) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
          };
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
          if (!isLoopbackPeer(req)) return send(403, { error: 'loopback only' });
          try {
            const url = new URL(req.url ?? APPLY_PATH, 'http://127.0.0.1');
            const dryRun = url.searchParams.get('dryRun') === '1';
            send(200, { report: await runOnce({ dryRun }) });
          } catch (error) {
            send(500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      });
      return () => dispose();
    }, 'workbuddy-balancer:route');

    // ---- 定时重排 ------------------------------------------------------
    if (config.enabled && config.autoRefresh) {
      sub.effect(() => {
        let cancelled = false;
        let timer = null;
        const tick = () => {
          if (cancelled) return;
          void (async () => {
            try {
              const result = await runViaRoute({});
              lastAutoRunAt = Date.now();
              lastAutoReport = result;
              lastAutoError = null;
              if (cancelled) return;
              const changed = result?.regions?.filter((row) => row.written) ?? [];
              if (result?.error !== undefined) {
                report(`本轮未完成：${result.error}`);
              } else if (changed.length > 0) {
                report(
                  `已重排 ${changed.map((row) => `[${row.region}] ${row.order.join(' → ')}`).join('；')}。` +
                    '上游下一次选号即按此顺序。',
                );
              }
            } catch (error) {
              lastAutoRunAt = Date.now();
              lastAutoError = error instanceof Error ? error.message : String(error);
              report(`定时重排失败：${lastAutoError}`);
            } finally {
              if (!cancelled) {
                timer = setTimeout(tick, config.intervalMs);
                timer.unref?.();
              }
            }
          })();
        };
        const kickoff = setTimeout(tick, config.startupDelayMs);
        kickoff.unref?.();
        timerArmed = true;
        return () => {
          cancelled = true;
          timerArmed = false;
          clearTimeout(kickoff);
          if (timer !== null) clearTimeout(timer);
        };
      }, 'workbuddy-balancer:auto-refresh');
    }

    // ---- 工具：workbuddy_balance ---------------------------------------
    sub.inject(['tools'], (toolsCtx) => {
      toolsCtx.tools.register({
        name: 'workbuddy_balance',
        description:
          '按「积分临期优先、积分少优先」重排 WorkBuddy 账号池的使用顺序：读上游每个账号的实时余额，算加权顺序，写进上游 pool.orderAccountIds（不影响上游代码，升级不会丢）。action="dry-run" 只算不写。',
        parameters: TOOL_PARAMETERS,
        output: {
          schema: TOOL_OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: value?.text ?? '（无结果）' }],
        },
        async execute(args) {
          const dryRun = args?.action === 'dry-run';
          const region = typeof args?.region === 'string' && args.region.length > 0 ? args.region : undefined;
          const result = await runOnce({ dryRun, region });
          return {
            ok: result.error === undefined,
            dryRun: result.dryRun === true,
            text: withDiagnostics(describeReport(result)),
            config: {
              enabled: config.enabled,
              autoRefresh: config.autoRefresh,
              intervalMs: config.intervalMs,
              minWriteIntervalMs: config.minWriteIntervalMs,
              startupDelayMs: config.startupDelayMs,
              regions: config.regions,
              dryRun: config.dryRun,
            },
            regions: result.regions.map((row) => ({
              region: row.region,
              accounts: row.accounts,
              written: row.written === true,
              order: row.order,
              note: row.note,
            })),
          };
        },
      });
    });

    // ---- 命令：/workbuddy-balance --------------------------------------
    sub.inject(['commands'], (commandsCtx) => {
      commandsCtx.commands.register({
        name: 'workbuddy-balance',
        description: '按「临期优先、少者优先」重排 WorkBuddy 账号池（/workbuddy-balance dry 只算不写）',
        input: { hint: '[dry]' },
        async handler(invocation) {
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim().toLowerCase() : '';
          const dryRun = raw === 'dry' || raw === 'dry-run' || raw === '--dry-run';
          const result = await runOnce({ dryRun });
          const text = withDiagnostics(describeReport(result));
          if (result.error !== undefined) return { kind: 'error', text };
          return { kind: 'success', text };
        },
      });
    });
  });

  return () => {
    balancer = null;
    selfOrigin = null;
    timerArmed = false;
  };
}
