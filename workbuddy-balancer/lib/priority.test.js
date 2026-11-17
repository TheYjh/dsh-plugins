/**
 * priority.js 的断言测试：node --test lib/priority.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  URGENT_WEIGHT,
  memberFromRow,
  orderedIds,
  rankMembers,
  sameOrder,
  weightedPriorityOf,
  withMemberFallback,
} from './priority.js';

const NOW = 1_800_000_000_000;
const DAY = DAY_MS;

const account = (id, total, expiringSoon = 0, daysToExpiry = 30) => ({
  id,
  name: id,
  credits: { total, expiringSoon, nearestExpiryMs: NOW + daysToExpiry * DAY },
  excluded: false,
});

test('无临期时：余额少的排前面（这是用户要的，也是上游默认做反的）', () => {
  const members = [account('rich', 2100), account('poor', 1500), account('mid', 1800)];
  assert.deepEqual(orderedIds(members, NOW), ['poor', 'mid', 'rich']);
});

test('有临期的账号压过任何无临期账号，哪怕余额非常小', () => {
  const members = [account('tiny-no-expiry', 1), account('huge-expiring', 5000, 100, 30)];
  assert.deepEqual(orderedIds(members, NOW), ['huge-expiring', 'tiny-no-expiry']);
});

test('两个都临期时：临期量/剩余天数 比值大的在前', () => {
  // 100 分 / 2 天 = 50；500 分 / 30 天 ≈ 16.7
  const members = [account('slow', 1500, 500, 30), account('fast', 1500, 100, 2)];
  assert.deepEqual(orderedIds(members, NOW), ['fast', 'slow']);
});

test('当天到期不会因为除以小数而炸出诡异尖峰', () => {
  // 距到期 1 小时，若直接除会得到 24 倍；下限 1 天应把它压住
  const members = [
    { id: 'today', name: 'today', credits: { total: 1500, expiringSoon: 100, nearestExpiryMs: NOW + 3600_000 }, excluded: false },
    { id: 'tomorrow', name: 'tomorrow', credits: { total: 1500, expiringSoon: 100, nearestExpiryMs: NOW + DAY }, excluded: false },
  ];
  const [first, second] = rankMembers(members, NOW);
  assert.equal(first.member.id, 'today');
  // 两者比值应完全相等（都被夹到 1 天），只由 id 字典序决定
  assert.equal(first.priority, second.priority);
});

test('余额读不到的账号排最后，而不是排最前（读失败不许抢流量）', () => {
  const unknown = { id: 'unknown', name: 'unknown', credits: undefined, excluded: false };
  const known = account('known', 9999);
  assert.deepEqual(orderedIds([unknown, known], NOW), ['known', 'unknown']);
  assert.equal(weightedPriorityOf(unknown, NOW), Number.NEGATIVE_INFINITY);
});

test('余额是 0 与余额读不到不是一回事', () => {
  const zero = account('zero', 0);
  const unknown = { id: 'unknown', name: 'unknown', credits: undefined, excluded: false };
  assert.deepEqual(orderedIds([unknown, zero], NOW), ['zero', 'unknown']);
});

test('被上游排除的账号排最后，但仍在顺序里', () => {
  const excluded = { ...account('excluded', 1), excluded: true };
  const normal = account('normal', 5000);
  assert.deepEqual(orderedIds([excluded, normal], NOW), ['normal', 'excluded']);
});

test('URGENT_WEIGHT 是分离保证：任何无临期账号都不可能反超有临期账号', () => {
  // 极端对照：有临期但余额巨大 vs 无临期但余额为 0
  const urgent = { ...account('urgent', 1e6, 1, 365), credits: { total: 1e6, expiringSoon: 1, nearestExpiryMs: NOW + 365 * DAY } };
  const plain = account('plain', 0);
  assert.ok(weightedPriorityOf(urgent, NOW) > weightedPriorityOf(plain, NOW));
  assert.ok(weightedPriorityOf(plain, { ...plain, credits: { total: 1e6, expiringSoon: 0 } }) < URGENT_WEIGHT);
});

test('并列时按 id 字典序，保证顺序确定', () => {
  const members = [account('b', 1000), account('a', 1000)];
  assert.deepEqual(orderedIds(members, NOW), ['a', 'b']);
});

test('memberFromRow 从 account-credits 的扁平行归一', () => {
  const member = memberFromRow({
    id: 'x',
    accountName: '野间鹤',
    selected: true,
    credits: 1385.01,
    expiringSoon: 0,
    nearestExpiryMs: 1797099538000,
    excludedBy: null,
  });
  assert.deepEqual(member, {
    id: 'x',
    name: '野间鹤',
    credits: { total: 1385.01, expiringSoon: 0, nearestExpiryMs: 1797099538000 },
    excluded: false,
  });
});

test('memberFromRow 缺 credits 时保持 undefined（不伪造成 0）', () => {
  const member = memberFromRow({ id: 'y', accountName: 'y' });
  assert.equal(member.credits, undefined);
  assert.equal(member.excluded, false);
});

test('memberFromRow 认出 excludedBy', () => {
  assert.equal(memberFromRow({ id: 'z', excludedBy: 'out-of-credit' }).excluded, true);
});

test('withMemberFallback 只保留池成员，缺数据的成员补在末尾且保持原次序', () => {
  const order = withMemberFallback(['c', 'a', 'zzz-not-member', 'b'], ['a', 'b', 'c', 'd']);
  assert.deepEqual(order, ['c', 'a', 'b', 'd']);
});

test('withMemberFallback 对空成员数组返回空数组', () => {
  assert.deepEqual(withMemberFallback(['a', 'b'], []), []);
  assert.deepEqual(withMemberFallback(['a'], undefined), []);
});

test('withMemberFallback 不重复', () => {
  assert.deepEqual(withMemberFallback(['a', 'a', 'b'], ['a', 'b']), ['a', 'b']);
});

test('sameOrder 逐项比较', () => {
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameOrder([], []), true);
  assert.equal(sameOrder(['a'], []), false);
  assert.equal(sameOrder(null, []), true);
});

test('真实场景：六账号、全无临期时应按余额升序（与上游默认相反）', () => {
  // 取自 11-17 实测的 account-credits 数据
  const rows = [
    { id: 'c3a7750e', accountName: '190****9796', credits: 2108.39, expiringSoon: 0, nearestExpiryMs: 1797078957000 },
    { id: '381d4d3b', accountName: '156****4552', credits: 2103.39, expiringSoon: 0, nearestExpiryMs: 1797079069000 },
    { id: '700921c0', accountName: '134****4182', credits: 2105.85, expiringSoon: 0, nearestExpiryMs: 1797100554000 },
    { id: 'c9d7df2a', accountName: '野间鹤', credits: 1561.8, expiringSoon: 0, nearestExpiryMs: 1796246595000 },
    { id: 'c67cd733', accountName: '188****6038', credits: 1547.98, expiringSoon: 0, nearestExpiryMs: 1797376983000 },
    { id: '0d977650', accountName: '199****0373', credits: 1385.01, expiringSoon: 0, nearestExpiryMs: 1797099538000 },
  ];
  const order = orderedIds(rows.map(memberFromRow), Date.now());
  assert.deepEqual(order, ['0d977650', 'c67cd733', 'c9d7df2a', '381d4d3b', '700921c0', 'c3a7750e']);
});
