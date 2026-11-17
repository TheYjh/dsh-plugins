# dsh-profile-doctor

自动修掉一类让 **DSH 插件市场每次更新都失败** 的隐藏故障。

## 症状

在插件市场点「更新」，结果报：

```
更新失败: dsh-mnemon — ⚠ 下次启动会失败：profile 声明了这些插件，但它们没有安装。
请重新安装，或从 profile 的 package.json 的 dsh.profile.bundles 中删除：
@deepseek-harness-tui/dsh-tui
```

详情里还会写：

```
@deepseek-harness-tui/dsh-tui: bundle package is not installed — the profile will fail to boot
（已自动回滚并恢复原版本文件）
```

于是插件永远是旧版本，升不上去。

## 成因

profile 的 `package.json` 里有两处相关声明：

- `dependencies` —— 真正装了哪些包；
- `dsh.profile.bundles` —— 启动时要加载哪些 bundle。

某个 bundle 被卸载（或装了一半失败）之后，`dsh.profile.bundles` 里那一行**不会被清掉**。原因是安装与更新时走的 `reconcileProfilePlugins()` 有一条刻意的保留规则：*既不在安装前的 dependencies、也不在安装后的 dependencies 里的条目，一律保留*。这条规则本意是别误删用户手写的东西，副作用是孤儿声明就此永久残留。

市场在每次更新后会做一次「试启动校验」：按 `dsh.profile.bundles` 逐条解析包，只要有一条社区 scope 的包解析不到，就判 `the profile will fail to boot`，然后回滚整次更新。**所以只装不修，永远更新不成**。

值得一提的是 DSH 真正的启动路径并不因此失败——`loadProfileDirectory()` 对每条 bundle 都 try/catch，坏的只进 `skippedBundles` 然后继续。真正卡住你的是市场那道更严的校验。

## 它做什么

启动后（默认延迟 4 秒）自检当前 profile：

1. 读 `dsh.profile.bundles`；
2. 对每一条，按与 DSH 自身一致的锚点顺序（安装目录 → profile）解析包目录；
3. 找出 **解析不到、且不在 `dependencies` 里** 的条目——只有这类才是可安全摘除的孤儿；
4. 把这些条目从 `dsh.profile.bundles` 里删掉，**写前把原 `package.json` 备份**到 `<profile>/.profile-doctor/package.json.<时间戳>.bak`。

关键的安全边界：**只删「解析不到」且「不在 dependencies 里」的条目**。

- 在 `dependencies` 里却解析不到 → 说明安装被破坏，不动它，只提示重装；
- 能解析到 → 正常插件，一律不动；
- `@deepseek-ai/*` 这类 in-box bundle 解析不到也算正常，不判错。

写完不重启也不会破坏当前会话；下次启动即按新配置加载。

## 用法

装好后无需任何操作，启动时自动跑。也可以手动：

```
/profile-doctor        体检，只报告
/profile-doctor fix    体检并修复
```

或者调用工具 `profile_doctor`：

```json
{ "action": "check" }    // 只体检
{ "action": "repair" }   // 体检并摘除孤儿
{ "action": "check", "profile": "web" }
```

## 配置

在 profile 的插件配置里可覆盖（键名与默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `autoCheck` | `true` | 启动后是否自检 |
| `autoRepair` | `true` | 发现可摘除的孤儿是否自动修 |
| `autoCheckDelayMs` | `4000` | 启动后等多久再跑，0–120000 |
| `profile` | `""` | 覆盖要体检的 profile 名，空则用当前 profile |

只想体检不想自动改，把 `autoRepair` 设成 `false`。

## 注意

- 备份目录 `.profile-doctor/` 会随体检次数增长，可以随时清理。
- 插件只碰 `dsh.profile.bundles` 这一个字段，`dependencies`、其它字段、缩进风格、文件权限（0600）都原样保持。
- 这个插件治的是「孤儿声明」。如果某个插件是真的没装好，请重装它——本插件会明确告诉你哪些属于这种情况，不会替你删。

## 许可证

MIT
