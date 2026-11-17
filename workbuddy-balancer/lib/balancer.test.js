/**
 * balancer.js 的接线测试：用桩替换 settings / webServer / fetch，
 * 验证「读余额 → 算顺序 → 写 orderAccountIds」这条路真的走通。
 *
 * node --test lib/balancer.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBalancer, describeReport } from './balancer.js';

const CREDITS = [
  { id: 'rich', accountName: 'rich', credits: 2100, expiringSoon: 0, nearestExpiryMs: 1797078957000 },
  { id: 'poor', accountName: 'poor', credits: 1385, expiringSoon: 0, nearestExpiryMs: 1797099538000 },
  { id: 'mid', accountName: 'mid', credits: 1561, expiringSoon: 0, nearestExpiryMs: 1796246595000 },
];

/** 造一个记录调用的桩环境。 */
function harness(overrides = {}) {
  const calls = { mutate: [], fetched: [] };
  const descriptor = {
    ns: 'dsh-connect-workbuddy',
    revision: 3,
    value: {
      regions: {
        cn: {
          enabled: true,
          pool: {
            enabled: true,
            memberAccountIds: ['rich', 'poor', 'mid'],
            orderAccountIds: [],
          },
        },
        global: {
          enabled: true,
          pool: { enabled: false, memberAccountIds: [], orderAccountIds: [] },
        },
      },
    },
  };
  const settings = {
    describe: () => [descriptor],
    async mutate(ns, ops, expected) {
      calls.mutate.push({ ns, ops, expected });
      // 模仿上游：写入后 describe 的 value 随之更新
      const [op] = ops;
      if (op.op === 'set' && op.path.join('.') === 'regions.cn.pool.orderAccountIds') {
        descriptor.value.regions.cn.pool.orderAccountIds = op.value;
      }
    },
  };
  const webServer = { port: 3080, protocol: 'http:' };
  const fetchImpl = async (url) => {
    calls.fetched.push(url);
    const region = new URL(url).searchParams.get('region');
    const accounts = region === 'cn' ? CREDITS : [{ id: 'g1', accountName: 'g1', credits: 10, expiringSoon: 0 }];
    return { ok: true, status: 200, async json() { return { accounts }; } };
  };
  const config = {
    enabled: true,
    autoRefresh: false,
    intervalMs: 600_000,
    minWriteIntervalMs: 0,
    startupDelayMs: 0,
    regions: [],
    dryRun: false,
    urgentWeight: 1e9,
    minDaysLeft: 1,
    ...overrides,
  };
  const logs = [];
  const balancer = createBalancer({ settings, webServer, config, log: (line) => logs.push(line), fetchImpl });
  return { balancer, calls, descriptor, logs };
}

test('写入 orderAccountIds：余额少的排前面', async () => {
  const { balancer, calls } = harness();
  const report = await balancer.run({});
  assert.equal(report.error, undefined);
  assert.equal(calls.fetched.length, 2, '应该为两个区域各读一次余额');
  assert.ok(calls.fetched.every((url) => url.startsWith('http://127.0.0.1:3080/plugins/dsh-connect-workbuddy/account-credits?region=')));
  assert.equal(calls.mutate.length, 1, '只有 cn 区会写（global 池没成员）');
  const [call] = calls.mutate;
  assert.equal(call.ns, 'dsh-connect-workbuddy');
  assert.deepEqual(call.ops, [
    { op: 'set', path: ['regions', 'cn', 'pool', 'orderAccountIds'], value: ['poor', 'mid', 'rich'] },
  ]);
  assert.equal(call.expected, undefined);
  assert.equal(report.regions.find((row) => row.region === 'cn').written, true);
});

test('顺序没变就不写盘', async () => {
  const { balancer, calls, descriptor } = harness();
  descriptor.value.regions.cn.pool.orderAccountIds = ['poor', 'mid', 'rich'];
  const report = await balancer.run({});
  assert.equal(calls.mutate.length, 0);
  assert.equal(report.regions.find((row) => row.region === 'cn').note, '顺序未变');
});

test('dryRun 只算不写', async () => {
  const { balancer, calls } = harness();
  const report = await balancer.run({ dryRun: true });
  assert.equal(calls.mutate.length, 0);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.regions.find((row) => row.region === 'cn').order, ['poor', 'mid', 'rich']);
});

test('minWriteInterval 会挡住第二次写', async () => {
  const { balancer, calls, descriptor } = harness({ minWriteIntervalMs: 3600_000 });
  await balancer.run({});
  assert.equal(calls.mutate.length, 1);
  descriptor.value.regions.cn.pool.orderAccountIds = [];
  await balancer.run({});
  assert.equal(calls.mutate.length, 1, '第二次应该被最小间隔挡住');
});

test('指定 region 时只处理该区域', async () => {
  const { balancer, calls } = harness();
  await balancer.run({ region: 'cn' });
  assert.equal(calls.fetched.length, 1);
  assert.match(calls.fetched[0], /region=cn$/);
});

test('上游接口失败时给出原因，不影响插件其它功能', async () => {
  const { balancer } = harness();
  const failing = createBalancer({
    settings: { describe: () => [{ ns: 'dsh-connect-workbuddy', value: { regions: { cn: { pool: { enabled: true, memberAccountIds: ['a'], orderAccountIds: [] } } } } }], async mutate() {} },
    webServer: { port: 3080, protocol: 'http:' },
    config: { enabled: true, autoRefresh: false, intervalMs: 1, minWriteIntervalMs: 0, startupDelayMs: 0, regions: [], dryRun: false, urgentWeight: 1e9, minDaysLeft: 1 },
    log: () => {},
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }),
  });
  const report = await failing.run({});
  assert.match(report.regions[0].note, /503/);
  assert.equal(report.regions[0].written, false);
  // 同一个 harness 里的正常实例仍然可用
  const ok = await balancer.run({});
  assert.equal(ok.error, undefined);
});

test('找不到上游配置入口时报错而不是崩', async () => {
  const balancer = createBalancer({
    settings: { describe: () => [], async mutate() {} },
    webServer: { port: 3080, protocol: 'http:' },
    config: { enabled: true, autoRefresh: false, intervalMs: 1, minWriteIntervalMs: 0, startupDelayMs: 0, regions: [], dryRun: false, urgentWeight: 1e9, minDaysLeft: 1 },
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { accounts: [] }; } }),
  });
  const report = await balancer.run({});
  assert.match(report.error, /没找到/);
});

test('webServer 还没绑端口时给出明确原因', async () => {
  const balancer = createBalancer({
    settings: { describe: () => [{ ns: 'dsh-connect-workbuddy', value: { regions: { cn: { pool: {} } } } }], async mutate() {} },
    webServer: { port: undefined },
    config: { enabled: true, autoRefresh: false, intervalMs: 1, minWriteIntervalMs: 0, startupDelayMs: 0, regions: [], dryRun: false, urgentWeight: 1e9, minDaysLeft: 1 },
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { accounts: [] }; } }),
  });
  const report = await balancer.run({});
  assert.match(report.regions[0].note, /还没绑定端口/);
});

test('describeReport 给出人话', async () => {
  const { balancer } = harness();
  const report = await balancer.run({});
  const text = describeReport(report);
  assert.match(text, /\[cn\] 3 个账号/);
  assert.match(text, /poor → mid → rich/);
});

test('withMemberFallback：只写池成员，缺数据的成员补末尾', async () => {
  const descriptor = {
    ns: 'dsh-connect-workbuddy',
    value: { regions: { cn: { pool: { enabled: true, memberAccountIds: ['poor', 'mid', 'rich', 'no-credits'], orderAccountIds: [] } } } },
  };
  const calls = { mutate: [] };
  const balancer = createBalancer({
    settings: {
      describe: () => [descriptor],
      async mutate(ns, ops) {
        calls.mutate.push(ops);
        descriptor.value.regions.cn.pool.orderAccountIds = ops[0].value;
      },
    },
    webServer: { port: 3080, protocol: 'http:' },
    config: { enabled: true, autoRefresh: false, intervalMs: 1, minWriteIntervalMs: 0, startupDelayMs: 0, regions: [], dryRun: false, urgentWeight: 1e9, minDaysLeft: 1 },
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { accounts: CREDITS }; } }),
  });
  await balancer.run({});
  assert.deepEqual(calls.mutate[0][0].value, ['poor', 'mid', 'rich', 'no-credits']);
});
