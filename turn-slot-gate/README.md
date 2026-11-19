# dsh-turn-slot-gate

回合收尾闸门：本回合改过东西、交付说明却没写「改了什么 / 已阅未改 / 判断无问题」三栏时，把回合拦回来补一次。

## 它解决什么

模型在收尾时组织的是「我做了什么、结果如何」，天然不含「我看见了什么但没做」。同一场景连写四轮自然语言要求，四轮都没让那件事出现在交付说明里——漏报不是态度问题，它发生在生成交付说明那一刻。

所以这里改成结构性拦截：用 `agent/turn-stopping` 在回合边界上挡一下。宿主会 await 所有监听器，然后重新读一次收件箱；监听器里 `agent.steer(...)` 注入的消息会让它再走一步。这是结构性强制，不是建议。

## 三栏

| 栏名 | 收什么 |
|---|---|
| `改了什么` | 本回合实际改动的东西 |
| `已阅未改` | 读到了、但判断不该动的 |
| `判断无问题` | 读到了、判断过、结论是不构成问题的，必须给理由 |

第三栏是重点：它区分「看见了、判断没问题」和「根本没看见」。没有它，第二栏的「无」是不可信的。

## 安装

```
dsh plugin install /path/to/turn-slot-gate
```

或在 profile 的 `package.json` 里加一条 link 依赖，再加入 `dsh.profile.bundles`。它自带 `cordis.patch.yml`，安装器会读 `dsh.bundle.patch` 自动插入。

**改配置或换版本后需要重启 DSH**：插件在启动时按 bundle 层栈解析，不是热加载。

## 配置

```yaml
- id: dsh-turn-slot-gate
  name: dsh-turn-slot-gate
  config:
    enabled: true        # 总开关；false 时完全不注册监听器，不读会话、不判工具
    maxRetries: 1        # 单回合最多拦几次。0 = 不拦，只留痕
    writeTools: []       # 覆盖默认写类工具名单；留空用 write/edit/apply_patch
```

`enabled: false` 不是「注册了监听器但提前 return」——`wire()` 在开头就返回空清理函数，一个 `on()` 都不调。所以关掉之后它对会话完全不可见，这一点有测试直接断言 `ctx.handlers.size === 0`。

### 为什么不拦 `bash`

`bash` 可能是 `cat`（只读），也可能是 `rm`（写）。从工具名和参数里可靠区分这两者做不到，把 `bash` 算进写类会让「只读了一下」也触发闸门。**宁可漏拦，不可误拦**——这条取舍写死在默认值里，要改就显式配 `writeTools`。

## 已知边界

- **只验结构，不验内容真假。** 模型可以在第二栏编造「读过但没改」的对象，插件拦不住，也不假装能。真正的保证来自规则文件对第三栏的要求。
- **拦不住「不用写类工具就交付」的回合。** 纯解释、纯查询不该被管，这是有意的。
- **最多拦 `maxRetries` 次。** 上限内没补齐就放行。闸门永远不允许把回合卡死。
- **超限放行会留痕。** 正常情况下写一条会话日志记录（`plugin:turn-slot-gate/non-compliant`，带 `turn`、`missing`、`strikes`），同时往 stderr 写一行。会话日志写不进去时（例如拿不到 `@deepseek-ai/dsh-session`）静默降级为只有 stderr——不假装写了。
- **只拦住有 `write`/`edit`/`apply_patch` 的回合。** 只跑 `bash` 的回合不算，哪怕那条命令其实写了文件。
- **需要新会话或重启后才生效。** 插件本身在启动时装配。
- **它会压过会话内的显式指示。** 用户在任务里写「只回一句『改好了』，不要写小节」，闸门照样拦，模型会判定「后来的用户消息覆盖」并补出三栏。这是它有效的原因，也是它和「用户明确要求简短」打架的原因——不想要就配 `enabled: false`。
- **`link:` 安装拿不到会话日志写入能力。** 见下节。

### 安装方式会影响留痕能力

`dsh-turn-slot-gate` 用 `link:` 装进 profile 时（`dependencies` 写成 `link:/path/to/plugin`，`node_modules` 里是符号链接），`import('@deepseek-ai/dsh-session')` 与 `import('@deepseek-ai/dsh-llm')` 都会 `ERR_MODULE_NOT_FOUND`：Node 按 **realpath** 解析，插件真实位置在仓库里，那条祖先链上没有宿主的 `@deepseek-ai/*`。

后果分两级：

- **闸门本身照常工作**——`steer` 的降级路径是裸消息对象，拦回与提醒都不受影响。
- **超限留痕只剩 stderr**，会话日志里查不到 `plugin:turn-slot-gate/non-compliant`。

要拿到会话日志写入能力，把插件**物理拷贝**进 profile 的 `node_modules`（不要符号链接）。实测同一份代码在两种安装下：链接时两条 import 都失败，拷贝后 `dsh-session` 与 `dsh-llm` 都解析成功。

这条限制不是本插件独有，任何 `link:` 安装的 profile 插件都拿不到上述两个宿主包。

## 测试

```
npm test        # 或 node --test
```

52 条用例，只断言对外可观察行为（`steer` 有没有被调用、调用内容说了什么、会话日志里出现了什么记录），不断言内部计数字段。

必测分支：

- 有写类调用 + 交付缺槽位 → `steer` 调用一次，提醒指明缺哪一栏
- 有写类调用 + 三栏齐全 → `steer` 不调用
- 拦过一次仍不合规 → 放行，`steer` 不再调用（防死循环）
- 只读回合（`read`/`grep`/`glob`）、只跑 `bash` 的回合 → 不 `steer`
- `enabled: false` → 一个监听器都不注册
- 超限放行 → 记录含回合号与缺失栏名
- 子代理回合与主代理行为一致（独立会话、同样被拦、同样留痕）

`test/index.test.js` 用注入的假加载器验证「记录真的落进会话日志」，所以不需要 DSH 运行时也能测这一环。

## 结构

```
lib/slots.js  三栏识别的纯函数（不依赖宿主）
lib/gate.js   闸门状态机（不依赖宿主）
lib/wire.js   宿主接线层，宿主能力全部参数注入
lib/index.js  cordis 入口，只有这里碰宿主包
```

宿主包（`@deepseek-ai/dsh-llm` 取消息工厂、`@deepseek-ai/dsh-session` 写会话日志）都只在第一次需要时动态 import 并缓存，失败就降级，所以前三个模块能直接 `node --test`，不需要 DSH 运行时。

`lib/index.js` 的入口是 `createApply(deps)` 的结果：`deps` 里可以换掉会话日志的加载器，让 `test/index.test.js` 用假加载器验证写记录这一环。
