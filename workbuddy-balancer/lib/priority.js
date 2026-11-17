/**
 * 账号池加权排序 —— 纯函数部分（无 I/O，可单测）
 *
 * 目标：把「积分快到期的账号」与「积分少的账号」排到前面先用掉，
 * 而不是上游默认的「余额多者优先」（那会让余额最多的账号一直被用，
 * 其余账号的积分静静过期）。
 *
 * 一个分数而不是一组规则：两条直觉（临期优先 / 余额少优先）强弱不同，
 * 而余额几乎不会恰好相等，写成规则列表的话第二条永远轮不到执行。
 * 所以把两条折进同一个可比较的数值：
 *
 *   priority = URGENT_WEIGHT + expiringSoon / daysLeft - total      （有临期积分）
 *   priority = -total                                              （无临期积分）
 *   priority = -Infinity                                           （余额读不到）
 *
 * 四条不能丢的理由：
 *  1. URGENT_WEIGHT 是**分离保证**，不是可调参数。余额最多几千分，把
 *     expiring/days（0~几千）加在 1e9 之上，保证「有临期」永远压过
 *     「无临期」，无论两边余额差多少。做成乘数的话大余额会反超临期。
 *  2. 除以天数，天数下限取 1：当天到期不能除以小数（会得到无意义尖峰），
 *     更不能除以 0。
 *  3. 余额读不到返回 -Infinity，排最后。余额项是取负的，若按 0 计算，
 *     未测量的账号会排到所有真实账号前面 —— 正是「读取失败抢走全部流量」
 *     的故障（上游 scoreOf 的注释说的是同一件事）。
 *  4. 纯函数：不抛异常、不改入参，方便在工具/命令/测试里直接跑。
 */

/** 临期项与普通项的分离量级；余额量级最多几千，1e9 足够让两者永不相交。 */
export const URGENT_WEIGHT = 1e9;

/** 一天的毫秒数。 */
export const DAY_MS = 864e5;

/**
 * 把 account-credits 路由的一行（扁平的 credits / expiringSoon / nearestExpiryMs）
 * 归一成排序用的 member 形状。缺失的字段保持 undefined —— 区别于 0。
 * @param {unknown} row 上游 `GET /plugins/dsh-connect-workbuddy/account-credits` 的 accounts[] 元素。
 * @returns {{ id: string, name: string, credits: undefined | { total?: number, expiringSoon?: number, nearestExpiryMs?: number }, excluded: boolean }}
 */
export function memberFromRow(row) {
  const record = row !== null && typeof row === 'object' ? row : {};
  const id = typeof record.id === 'string' ? record.id : String(record.id ?? '');
  const name = typeof record.accountName === 'string' && record.accountName.length > 0 ? record.accountName : id;
  const total = finiteOrUndefined(record.credits);
  const expiringSoon = finiteOrUndefined(record.expiringSoon);
  const nearestExpiryMs = finiteOrUndefined(record.nearestExpiryMs);
  const credits =
    total === undefined && expiringSoon === undefined && nearestExpiryMs === undefined
      ? undefined
      : { total, expiringSoon, nearestExpiryMs };
  return { id, name, credits, excluded: record.excludedBy !== undefined && record.excludedBy !== null };
}

function finiteOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 单个账号的优先级：**越大越先用**。
 * @param {{ credits?: { total?: number, expiringSoon?: number, nearestExpiryMs?: number } }} member 归一后的账号。
 * @param {number} nowMs 当前时间戳（毫秒）。
 * @param {{ urgentWeight?: number, minDaysLeft?: number }} [options] 覆盖默认量级（测试用）。
 * @returns {number} 优先级；余额读不到时为 -Infinity。
 */
export function weightedPriorityOf(member, nowMs, options = {}) {
  const urgentWeight = Number.isFinite(options.urgentWeight) ? options.urgentWeight : URGENT_WEIGHT;
  const minDaysLeft = Number.isFinite(options.minDaysLeft) && options.minDaysLeft > 0 ? options.minDaysLeft : 1;
  const total = member?.credits?.total;
  if (total === undefined) return Number.NEGATIVE_INFINITY;
  const expiring = member?.credits?.expiringSoon ?? 0;
  if (!(expiring > 0)) return -total;
  const expiryMs = member?.credits?.nearestExpiryMs;
  if (expiryMs === undefined) return -total;
  const daysLeft = Math.max(minDaysLeft, (expiryMs - nowMs) / DAY_MS);
  return urgentWeight + expiring / daysLeft - total;
}

/**
 * 按优先级排序（高优先级在前），并列时按 id 字典序保证确定性。
 * 被上游排除的账号（excludedBy 非空）排在最后 —— 它们这一轮本来就不会被选中，
 * 但仍然留在顺序里，等上游解除排除后自动回到原位。
 * @param {Array<{ id: string, credits?: object, excluded?: boolean }>} members 归一后的账号列表。
 * @param {number} nowMs 当前时间戳（毫秒）。
 * @param {{ urgentWeight?: number, minDaysLeft?: number }} [options] 透传给 weightedPriorityOf。
 * @returns {Array<{ member: object, priority: number }>} 排序结果。
 */
export function rankMembers(members, nowMs, options = {}) {
  const rows = members.map((member) => ({ member, priority: weightedPriorityOf(member, nowMs, options) }));
  rows.sort((a, b) => {
    const usable = Number(a.member.excluded === true) - Number(b.member.excluded === true);
    if (usable !== 0) return usable;
    if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
    return a.member.id < b.member.id ? -1 : a.member.id > b.member.id ? 1 : 0;
  });
  return rows;
}

/**
 * 排序后的账号 id 序列。
 * @param {Array<object>} members 归一后的账号列表。
 * @param {number} nowMs 当前时间戳（毫秒）。
 * @param {object} [options] 透传给 rankMembers。
 * @returns {string[]} id 序列。
 */
export function orderedIds(members, nowMs, options = {}) {
  return rankMembers(members, nowMs, options).map((row) => row.member.id);
}

/**
 * 把算出的顺序裁剪到「池成员」范围内，并把没拿到余额数据、因而缺席的成员补在末尾，
 * 保持它们之间原有的相对次序。
 *
 * 上游 `orderAccountIds` 只对 `memberAccountIds` 里的账号生效（`effectiveMembersOf`
 * 会先取交集），所以写进去的顺序必须是成员子集；缺数据的成员补在末尾，
 * 避免它们靠「没被写进顺序」而落到 `+Infinity` 之外的意外位置。
 * @param {string[]} ids 按优先级排好的 id。
 * @param {string[]} memberIds 池成员 id（`pool.memberAccountIds`）。
 * @returns {string[]} 可写入 `orderAccountIds` 的完整顺序。
 */
export function withMemberFallback(ids, memberIds) {
  const members = Array.isArray(memberIds) ? memberIds.filter((id) => typeof id === 'string' && id.length > 0) : [];
  if (members.length === 0) return [];
  const allowed = new Set(members);
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of members) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 两个 id 序列是否逐项相同。 */
export function sameOrder(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
