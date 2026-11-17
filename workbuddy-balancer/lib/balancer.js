/**
 * 账号池加权排序 —— 带 I/O 的部分
 *
 * 工作方式（不改上游 bundle，只写它本来就读的配置字段）：
 *
 *  1. 读上游 `GET /plugins/dsh-connect-workbuddy/account-credits?region=<r>`，
 *     拿到每个账号**实时**的 `credits / expiringSoon / nearestExpiryMs`。
 *     这是上游唯一一处「每账号一次上游读」的接口，比卡片上的快照新。
 *  2. 用 `priority.js` 的加权分数排出顺序。
 *  3. 把顺序写进上游的 `regions.<r>.pool.orderAccountIds`（volatile 字段，
 *     就地生效、不重建插件）。上游 `applyPoolSelection` 每次请求都会重新
 *     读这个数组并调用 rankPool，所以下一次请求就用上新顺序。
 *
 * 为什么是「写 orderAccountIds」而不是接管选号：上游 `rankPool` 是闭包里的
 * 私有函数、插件没有 provide 任何 service，外部拿不到。而 `orderAccountIds`
 * 是 rankPool **唯一**从配置读的顺序键，且 `regions` 整棵树是 volatile
 * （`settings.mutate` 允许写），因此这是唯一既不改上游代码、又能真影响
 * 每次请求选号的接缝。
 *
 * 一个诚实的限制：rankPool 的比较键里 `_atRisk`（有临期积分者优先）排在
 * `_order` 之前。所以当某账号**确实有**临期积分时，上游会自己把它提前，
 * 我们的顺序只在该键相同（都临期或都不临期）之后才起作用 —— 这正好和
 * 「临期优先」的方向一致，不会打架。真正由本插件决定的是同一档内
 * 「余额少者优先」这个上游刻意做反了的部分。
 */

import { memberFromRow, orderedIds, sameOrder, withMemberFallback } from './priority.js';

/** 上游账号余额路由（Host 侧，loopback 可直连）。 */
export const UPSTREAM_CREDITS_PATH = '/plugins/dsh-connect-workbuddy/account-credits';

/** 从 settings 描述符里找上游入口用的标识（上游 ns 通常就是 `dsh-connect-workbuddy`）。 */
const ENTRY_HINT = 'workbuddy';

/** 单次上游读的超时；六账号串行读也不该超过这个数。 */
const FETCH_TIMEOUT_MS = 20_000;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 建一个执行器。状态（上次写盘时间）保存在闭包里，随插件实例生死。
 * @param {object} deps 依赖注入（便于测试替换）。
 * @param {object} deps.settings `settings` 服务。
 * @param {object} deps.webServer `webServer` 服务（取本机端口）。
 * @param {object} deps.config 归一后的配置。
 * @param {(line: string) => void} deps.log 写日志。
 * @param {typeof fetch} [deps.fetchImpl] 可替换的 fetch。
 */
export function createBalancer({ settings, webServer, config, log, fetchImpl = globalThis.fetch }) {
  /** region → 上次成功写盘的毫秒时间戳。 */
  const lastWriteAt = new Map();
  /** region → 上次写入的 id 序列（用于报告「翻了没翻」）。 */
  const lastWritten = new Map();
  let lastRun = null;

  function originOf() {
    const port = webServer?.port;
    if (!Number.isInteger(port) || port <= 0) throw new Error('webServer 还没绑定端口，稍后重试');
    const protocol = typeof webServer?.protocol === 'string' ? webServer.protocol : 'http:';
    return `${protocol}//127.0.0.1:${port}`;
  }

  function entryOf() {
    const rows = settings.describe();
    const row = rows.find((candidate) => String(candidate?.ns ?? '').includes(ENTRY_HINT));
    if (row === undefined) throw new Error('没找到 dsh-connect-workbuddy 的配置入口（插件未安装或未启用？）');
    return row;
  }

  async function readCredits(region) {
    const url = `${originOf()}${UPSTREAM_CREDITS_PATH}?region=${encodeURIComponent(region)}`;
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`上游余额接口返回 ${response.status}：${url}`);
    const body = await response.json();
    const rows = Array.isArray(body?.accounts) ? body.accounts : [];
    return rows.map(memberFromRow);
  }

  /** 描述符里的某个 region 的池配置值。 */
  function poolOf(descriptor, region) {
    const pool = descriptor?.value?.regions?.[region]?.pool;
    return pool !== null && typeof pool === 'object' ? pool : {};
  }

  /** 描述符里出现的区域名（过滤掉非对象值）。 */
  function regionsOf(descriptor) {
    const regions = descriptor?.value?.regions;
    if (regions === null || typeof regions !== 'object') return [];
    return Object.keys(regions).filter((key) => regions[key] !== null && typeof regions[key] === 'object');
  }

  /**
   * 跑一轮。任何单个区域的失败都不影响其它区域，失败原因进报告。
   * @param {{ region?: string, dryRun?: boolean }} [options] 只跑某个区域 / 只算不写。
   */
  async function run(options = {}) {
    const dryRun = options.dryRun === true || config.dryRun === true;
    const now = Date.now();
    const report = { atMs: now, dryRun, regions: [], error: undefined };
    try {
      const descriptor = entryOf();
      const available = regionsOf(descriptor);
      const wanted =
        typeof options.region === 'string' && options.region.length > 0
          ? [options.region]
          : Array.isArray(config.regions) && config.regions.length > 0
            ? config.regions.filter((region) => available.includes(region))
            : available;
      if (wanted.length === 0) {
        report.error = `配置里没有可处理的区域（可用：${available.join('、') || '无'}）`;
        lastRun = report;
        return report;
      }
      for (const region of wanted) {
        const row = { region, accounts: 0, previous: [], order: [], written: false, note: '' };
        report.regions.push(row);
        try {
          const pool = poolOf(descriptor, region);
          const members = await readCredits(region);
          row.accounts = members.length;
          if (members.length === 0) {
            row.note = '上游没有返回任何账号（未登录 / 池未启用？）';
            continue;
          }
          const memberIds = Array.isArray(pool.memberAccountIds) ? pool.memberAccountIds : [];
          if (memberIds.length === 0) {
            row.note = '池的 memberAccountIds 为空，上游不会用任何账号，跳过';
            continue;
          }
          const previous = Array.isArray(pool.orderAccountIds) ? pool.orderAccountIds : [];
          const order = withMemberFallback(orderedIds(members, now, config), memberIds);
          row.previous = previous;
          row.order = order;
          if (sameOrder(order, previous)) {
            row.note = '顺序未变';
            continue;
          }
          if (dryRun) {
            row.note = '试算（未写入）';
            continue;
          }
          const since = lastWriteAt.get(region);
          if (since !== undefined && now - since < config.minWriteIntervalMs) {
            row.note = `距上次写盘不足 ${Math.ceil(config.minWriteIntervalMs / 1000)}s，本轮先不写`;
            continue;
          }
          await settings.mutate(
            descriptor.ns,
            [{ op: 'set', path: ['regions', region, 'pool', 'orderAccountIds'], value: order }],
            void 0,
          );
          lastWriteAt.set(region, now);
          lastWritten.set(region, order);
          row.written = true;
          row.note = '已写入';
        } catch (error) {
          row.note = `失败：${messageOf(error)}`;
        }
      }
    } catch (error) {
      report.error = messageOf(error);
    }
    lastRun = report;
    return report;
  }

  return {
    run,
    /** 最近一次运行结果（工具/命令用）。 */
    lastRunOf() {
      return lastRun;
    },
    lastWrittenOf(region) {
      return lastWritten.get(region);
    },
  };
}

/**
 * 把一轮结果写成给人看的文本。
 * @param {ReturnType<createBalancer>['run'] extends Promise<infer R> ? R : never} report 一轮结果。
 * @returns {string} 中文报告。
 */
export function describeReport(report) {
  if (report === null || typeof report !== 'object') return '（还没有运行过）';
  const lines = [];
  if (report.error !== undefined) lines.push(`整体失败：${report.error}`);
  if (report.regions.length === 0) {
    if (report.error === undefined) lines.push('没有需要处理的区域。');
    return lines.join('\n');
  }
  for (const row of report.regions) {
    const head = `[${row.region}] ${row.accounts} 个账号 —— ${row.note}`;
    lines.push(head);
    if (row.order.length > 0) {
      lines.push(`  顺序：${row.order.join(' → ')}`);
    }
    if (row.previous.length > 0 && row.written) {
      lines.push(`  原顺序：${row.previous.join(' → ')}`);
    }
  }
  if (report.dryRun) lines.push('（本次是试算，没有写任何配置）');
  return lines.join('\n');
}
