# dsh-plugins

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 用的插件集合。

每个插件一个目录，可单独安装，互不依赖。

## 目录

<!-- plugins-table:begin -->
| 插件 | 包名 | 一句话 |
|---|---|---|
| [`profile-doctor`](./profile-doctor/) | `dsh-profile-doctor` | 自动体检并修复 DSH profile 的 bundle 声明：删掉「声明了但没安装」的残留条目，让插件市场的更新不再被试启动校验回滚 |
| [`workbuddy-balancer`](./workbuddy-balancer/) | `dsh-workbuddy-balancer` | 给 dsh-connect-workbuddy 的账号池加上「积分临期优先、积分少优先」：读上游实时余额，算加权顺序，写进上游的 pool.orderAccountIds，不碰上游代码，升级不会丢 |
<!-- plugins-table:end -->

---

## dsh-profile-doctor

**Profile 医生** —— 自动删掉 profile 里「声明了但没安装」的残留 bundle。

### 它解决的问题

在插件市场点「更新」，结果报：

```
更新失败: dsh-mnemon — ⚠ 下次启动会失败：profile 声明了这些插件，但它们没有安装。
请重新安装，或从 profile 的 package.json 的 dsh.profile.bundles 中删除：
@deepseek-harness-tui/dsh-tui
（已自动回滚并恢复原版本文件）
```

然后插件永远是旧版本，升不上去。

**成因**：profile 的 `package.json` 里有两处相关声明 —— `dependencies`（真正装了哪些包）和 `dsh.profile.bundles`（启动时加载哪些 bundle）。某个 bundle 被卸载后，`dsh.profile.bundles` 里那一行**不会被清掉**。因为安装与更新时走的 `reconcileProfilePlugins()` 有一条刻意的保留规则：*既不在安装前 dependencies、也不在安装后 dependencies 里的条目，一律保留*。这条规则本意是别误删用户手写的东西，副作用是孤儿声明就此永久残留。

而市场每次更新后会做一次试启动校验：按 `dsh.profile.bundles` 逐条解析包，只要有一条社区 scope 的包解析不到，就判 `the profile will fail to boot` 并回滚整次更新。**所以只装不修，永远更新不成。**

> 反直觉的一点：DSH 真正的启动路径并不会因此失败 —— `loadProfileDirectory()` 对每条 bundle 都 try/catch，坏的只进 `skippedBundles` 然后继续。真正卡住你的是市场那道更严的校验。

### 它做什么

启动后（默认延迟 4 秒）自检当前 profile：

1. 读 `dsh.profile.bundles`；
2. 对每一条，按与 DSH 自身一致的锚点顺序（安装目录 → profile）解析包目录；
3. 找出 **解析不到、且不在 `dependencies` 里** 的条目 —— 只有这类才是可安全摘除的孤儿；
4. 把这些条目从 `dsh.profile.bundles` 删掉，**写前把原 `package.json` 备份**到 `<profile>/.profile-doctor/package.json.<时间戳>.bak`。

安全边界：**只删「解析不到」且「不在 dependencies 里」的条目**。

| 情况 | 处理 |
|---|---|
| 解析不到，且不在 `dependencies` | 判定为孤儿 → 摘掉 |
| 解析不到，但在 `dependencies` 里 | 安装被破坏 → **不动**，提示重装 |
| 能解析到 | 正常插件 → **不动** |
| `@deepseek-ai/*` 解析不到 | in-box bundle，属正常 → 不判错 |

修复优先走 `pluginManager.setBundleEnabled(name, false)` —— 它自带 `package.json` 的文件锁、会 emit `plugin-manager/changed`、与市场的安装流程互斥；只有拿不到该服务时才退回自己动手改 manifest（同样原子写、保持 2 空格缩进与 0600 权限）。

### 安装

```bash
dsh plugin --profile web add link:/绝对路径/dsh-plugins/profile-doctor
```

或直接在 DSH 里说「装一下这个目录」，让它调用插件管理器。

### 用法

装好后无需任何操作，启动时自动跑。手动入口：

```
/profile-doctor        体检，只报告
/profile-doctor fix    体检并修复
```

或者调用工具 `profile_doctor`：

```json
{ "action": "check" }                  // 只体检
{ "action": "repair" }                 // 体检并摘除孤儿
{ "action": "check", "profile": "web" }
```

### 配置

在 profile 的插件配置里可覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `autoCheck` | `true` | 启动后是否自检 |
| `autoRepair` | `true` | 发现可摘除的孤儿是否自动修 |
| `autoCheckDelayMs` | `4000` | 启动后等多久再跑，0–120000 |
| `profile` | `""` | 覆盖要体检的 profile 名，空则用当前 profile |

只想体检不想自动改，把 `autoRepair` 设成 `false`。

### 已验证

在一台真实出故障的机器上，用**市场自己的校验函数**（`dshmarket/lib/trial.js` 的 `trialValidate`）对照测过：

| | 修复前 | 修复后 |
|---|---|---|
| `trialValidate` | `ok: false`，错误指向 `@deepseek-harness-tui/dsh-tui` | `ok: true` |

同时确认：`dsh --dump-config` 退出码 0 且无 skip 警告；改写后的文件除 `bundles` 外逐字段与原文件相同，`dependencies` 未动，权限仍为 0600。

### 注意

- 备份目录 `.profile-doctor/` 会随体检次数增长，可随时清理。
- 插件只碰 `dsh.profile.bundles` 这一个字段。
- 它治的是「孤儿声明」。某个插件是真的没装好时，它会明确告诉你哪些属于这种情况，不会替你删。

---

## 许可证

MIT
