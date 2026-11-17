# dsh-workbuddy-balancer

给 `dsh-connect-workbuddy` 的账号池加上**「积分临期优先、积分少优先」**。

## 症状

账号池里挂着好几个账号，但每次聊天几乎总是余额最多的那个在处理请求。其余账号的积分一直不动，等到期日过了就静静作废。

`/plugins/dsh-connect-workbuddy/usage?region=cn` 里能看到 6 个账号的余额差着几百上千分，但无论怎么用，被选中的总是余额最高的那一两个。

## 成因

上游 `rankPool` 的排序键里，`score`（余额）是**降序**的 —— 余额多者优先。它的理由写在源码注释里（「用余额充足的账号更稳」），但代价就是余额少的账号永远轮不到，临期积分只能过期。

想改成「临期优先、少者优先」，传统做法是改上游 `lib/index.js` 的 `rankPool`。这条路已经走过两次，两次都丢：

| 时间 | 上游版本 | 结果 |
|---|---|---|
| 11-16 | 5.23.1 | 手改生效，当晚自动升级后丢失 |
| 11-17 03:33 | 5.24.9 | 重打补丁 + 锁定精确版本 `"5.24.9"`，生效 |
| 11-17 11:04 | 5.24.13 | **精确版本锁定没拦住**，补丁再次丢失 |

改 `node_modules` 注定被覆盖。所以这个插件换个接缝。

## 它做什么

不改一行上游代码，只写上游**本来就会读**的配置字段：

1. 读上游 `GET /plugins/dsh-connect-workbuddy/account-credits?region=<r>`，拿到每个账号**实时**的 `credits / expiringSoon / nearestExpiryMs`（这是上游唯一「每账号一次上游读」的接口，比卡片上的快照新）。
2. 用加权公式算出一个全局优先级：

   ```
   有临期积分： priority = 1e9 + expiringSoon / 距到期天数 - 余额
   无临期积分： priority = -余额
   余额读不到： priority = -Infinity
   ```

   权重**越大越先用**。`1e9` 是**分离保证**而不是调参项：余额量级最多几千，把临期项加在 1e9 之上，保证「有临期」永远压过「无临期」，无论两边余额差多少。做成乘数的话大余额会反超临期。
3. 把排好的顺序写进上游的 `regions.<region>.pool.orderAccountIds`。

上游每次请求选号都会走 `applyPoolSelection` → `rankPool(members, now, poolPreferencesOf(...).orderAccountIds)`，而 `orderAccountIds` 是 `rankPool` **唯一**从配置读的顺序键。`regions` 整棵树是 `.volatile()` 的，所以 `settings.mutate` 写得进去，而且是**就地生效**（不重建插件、不重启）。

上游升级后这个插件照旧工作 —— `orderAccountIds` 是它的公开配置之一，不是内部实现。

### 一个诚实的限制

`rankPool` 的比较键里，`_atRisk`（有临期积分者优先）排在 `_order`（本插件写的顺序）**之前**。所以：

- 当某账号**确实有**临期积分时，上游会自己把它提前 —— 方向和本插件一致，不打架。
- 真正由本插件决定的是同一档内「**余额少者优先**」这个上游刻意做反了的部分。

也就是说：临期优先上游本来就对了一半（只要 `expiringSoon > 0`），本插件补上的是余额方向。当前 6 个账号的 `expiringSoon` 全是 0，所以现在写进去的顺序**直接**决定选号结果。

## 用法

### 自动（默认）

插件启动 15 秒后跑第一轮，之后每 10 分钟一轮（与上游余额快照 TTL 对齐）。只在顺序**真的变了**时才写盘，且有 60 秒最小写盘间隔，避免反复重写 YAML。

### 手动

工具：

```json
{ "action": "dry-run" }
```

```json
{ "action": "apply", "region": "cn" }
```

- `action: "dry-run"` —— 只算不写，先看会排成什么样
- `action: "apply"` —— 算完写入

命令：

```
/workbuddy-balance          # 立即重排
/workbuddy-balance dry      # 试算
```

输出示例：

```
[cn] 6 个账号 —— 已写入
  顺序：0d977650 → c67cd733 → c9d7df2a → 381d4d3b → 700921c0 → c3a7750e
  原顺序：c3a7750e → 381d4d3b → 700921c0 → c9d7df2a → c67cd733 → 0d977650
```

（余额升序，与上游默认的降序相反。）

## 配置

写在 profile 的 `cordis.patch.yml` 里 `- id: dsh-workbuddy-balancer` 的 `config` 下：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后定时器不启动，手动工具仍可用 |
| `autoRefresh` | `true` | 是否按间隔自动重排；关掉则只能手动 |
| `intervalMs` | `600000` | 自动重排间隔，夹在 30s ~ 24h。默认 10 分钟对齐上游余额快照 TTL |
| `minWriteIntervalMs` | `60000` | 最短写盘间隔，夹在 5s ~ 1h。防反复重写 YAML |
| `startupDelayMs` | `15000` | 启动后等多久跑第一轮，夹在 0 ~ 5min |
| `regions` | `[]` | 只处理这些区域（如 `["cn"]`）；空数组 = 配置里出现的所有区域 |
| `dryRun` | `false` | 全局试算模式 |
| `urgentWeight` | `1e9` | 临期项的分离量级。**不建议改**：小于余额量级会让临期项失效 |
| `minDaysLeft` | `1` | 距到期天数下限，防当天到期除以小数产生无意义尖峰 |

## 注意

- **只写配置，不碰 `node_modules`。** 本插件不 patch、不 import 上游代码，上游升级不影响它。
- **写的是 `orderAccountIds`，不是「接管选号」。** 上游 `rankPool` 是闭包里的私有函数、不 provide 任何 service，外部拿不到。写 `orderAccountIds` 是唯一既不改上游代码、又能真影响每次请求选号的接缝。
- **余额读不到的账号排最后**，不是最前。这是刻意设计：读取失败时若按 0 计算，未测量的账号会排到所有真实账号前面，等于「读取失败抢走全部流量」（上游 `scoreOf` 的注释说的是同一件事）。
- **被上游排除的账号（`excludedBy` 非空）排在最后但仍在顺序里**，等上游解除排除后自动回到原位。
- **写盘会改 profile 的 `cordis.patch.yml`。** 走的是 DSH 的 `settings.mutate`（带文件锁、原子写、失败回滚），不是自己拼接文件；YAML 其余行与注释由文档树保留。
- `rankStrategy: weighted` 这个字段在当前上游（5.24.13）**没有任何代码读取**，是早先手改补丁的遗留。留着不影响功能，但会误导人以为它还有用。可以删。

## 开发

```bash
node --test lib/priority.test.js    # 17 个断言：排序算法
node --test lib/balancer.test.js    # 10 个断言：读写接线（用桩替换 settings/webServer/fetch）
```

## 许可证

MIT
