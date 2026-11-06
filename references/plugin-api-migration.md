# 插件 API 迁移配方（0.2.1-rc.5 → 0.2.2-rc.1）

只写**会给插件作者带来运行时故障**的部分：工具注册、投影注册、模型路由、清单门禁。
签名标 `证据:` 的直接来自 0.2.2-rc.1 `app.asar`；标 `推断:` 的只来自 release notes，
落代码前请用下面的验证命令在本机复核。

---

## <a name="tools"></a>1. 工具注册：`tools.resolve` / `executable`

**变更**：工具从"注册即可用"改成"声明 + 解析 + 准入"三段一致；按步骤条件启用时三处必须同条件。

**0.2.2 的接口形状**（证据：`@deepseek-ai/dsh-tools/lib/types/index.js:174-189`）：

```js
// 执行准入：返回可执行定义，或 undefined 表示该调用必须按 UNKNOWN_TOOL 失败
executable(name, scope, toolSet) { /* ... */ }

// 解析：按步骤上下文解析出本轮可见的工具集合
async resolve(context) { /* ... */ }
```

**迁移思路（推断，需按你插件的注册方式调整）**：

```js
// 之前（0.2.1 常见写法）：注册即暴露，条件写在执行函数里
ctx.tools.register({ name: 'my_tool', schema, execute });

// 之后：声明与准入分离，条件只写一次，声明/绑定/准入共享同一判定
const visible = (ctx) => ctx.agent.mode === 'ptc';   // 你的条件
ctx.tools.register({
  name: 'my_tool',
  schema,
  resolve: (context) => visible(context) ? definition : undefined,
  executable: (name, scope, toolSet) => toolSet.has(name) ? definition : undefined,
});
```

**症状**：模型在提示词里看得到工具，调用却报 `UNKNOWN_TOOL`；或原生能调、PTC 不能调。

**验证**：

```bash
# 原生路径
dsh --profile <name>   # 让模型调用一次该工具
# PTC 路径：在同一 profile 开启 PTC overlay 后调用 run_code("await my_tool(...)")
```

---

## <a name="session"></a>2. 会话投影：注册改异步、句柄必须持有

**变更**：注册 API 异步化；插件启动时就必须 `await` 并持有句柄。旧的
`stateOf(session, key)` 已废弃。

**0.2.2 的接口形状**（证据：`@deepseek-ai/dsh-session-projection/lib/index.js:115-186`）：

```js
// definition
{
  key: 'my-projection',
  stateVersion: 0,                      // 非负整数；同 key 不同版本会抛错
  stateSchema,
  init: (header, inheritedEventCount) => state,
  apply: (state, event) => nextState,
  wire: { viewSchema, view: (state) => view, summary: true },  // 可选，客户端可见
}

// 注册（async，返回 handle）
const handle = await sessionProjections.acquire(definition, (dispose) => { /* 可接收释放函数 */ });
// handle: { async dispose(), stateOf(session), readerFor(session) }
// 旧接口 sessionProjections.stateOf(session, key) 已 @deprecated
```

**迁移**：

```js
// 之前
ctx.on('ready', () => {
  ctx.sessionProjections.register(def);           // 同步注册
  ctx.sessionProjections.stateOf(session, key);   // 全局读取
});

// 之后
ctx.on('ready', async () => {
  const handle = await ctx.sessionProjections.acquire(def);
  ctx.effect(() => () => { void handle.dispose(); });   // 跟随 fiber 生命周期
  const state = handle.stateOf(session);                 // 通过句柄读取
});
```

**症状**：投影在启动早期为空、或首帧读到旧状态；插件卸载后重复注册冲突
（`already registered at stateVersion ...`）。

**验证**：启动后立刻读一次投影应已完成；卸载插件再装回，日志无 `already registered`。

---

## <a name="llm"></a>3. 模型路由与请求头

**变更**：
- 模型在提示词组装与 pre-step 之前固定，重试保持同一步选择。
- 插件通过 `agent.model` 选模型；`agent/request` 不再允许改路由。
- pi-ai 支持按会话与请求用途提供动态请求头；无效头在请求发出前报错。

**迁移（推断：`agent.model` 的具体赋值方式按 0.2.2 的 agent 类型定义确认）**：

```js
// 之前：在请求事件里改
ctx.on('agent/request', (request) => { request.model = 'x'; });

// 之后：在模型选择点声明
ctx.agent.model = 'x';          // 或等价的 agent.model(…) API
```

请求头：

```js
// 头必须是可同步求值的；非法值在请求前抛错（不再"先发再报"）
headers: () => ({ 'x-session-id': String(session.id) })
```

**症状**：模型选择被忽略 / 每步重复选择导致前缀缓存失效；或第一轮就因头非法失败。

**验证**：让插件指定模型 → 该步所有请求（含重试）日志中的 model 一致；注入非法头 → 请求前失败。

**另**：未声明容量的自定义模型默认上下文/最大输出变为 1M/128K（十进制）。小端点请显式覆盖容量。

---

## <a name="manifest"></a>4. 清单门禁（决定插件是否被加载）

**0.2.2 的门禁实现**（证据：`@deepseek-ai/dsh-app-boot/lib/index.js:1094-1117`）：

```js
// 伪代码，忠实还原
if (manifest.dsh.engines.dsh) {
  // engines.dsh 单独决定；peerDependencies 被完全忽略
  unmet = satisfies(runtime, engines.dsh) ? {} : { 'engines.dsh': engines.dsh };
} else {
  // 只检查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 的 peer
  for (const [name, range] of Object.entries(peerDependencies))
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      if (!satisfies(runtime, range)) unmet[name] = range;
}
// satisfies = semver.satisfies(runtime, range, { includePrerelease: true })
// workspace:^ / workspace:~ / workspace:* 视为 runtime 本身
```

**关键结论**：

1. `includePrerelease: true` → `>=0.2.1-rc.3` **满足** `0.2.2-rc.1`。不要用 npm 默认规则判断。
2. `engines.dsh` 与 peers **不合并**：写了 `engines.dsh`，peers 就不再检查。
3. `peerDependencies` 里指向 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 的 range
   **不参与**门禁（只决定 npm 安装解析）。
4. 不满足时插件被 **skip**，不是崩溃；`--dump-config` 打印
   `Plugin <name>@<ver> is incompatible with dsh <runtime>: requirements {...}`。
5. 豁免是精确版本对：`dsh plugin allow-version` / 插件管理页授予 `<name>@<version>` → `<runtime>`；
   升级 runtime 后豁免失效，需要重新授予。

**写清单的建议**：

```jsonc
{
  "dsh": {
    // 二选一：engines.dsh 简单直接
    "engines": { "dsh": ">=0.2.1-rc.3" }
    // 或（不要同时写）用 peer 精确表达依赖面
    // "peerDependencies" 里只放 @deepseek-ai/dsh-*，放 cordis 不会参与门禁
  }
}
```

**验证**：

```bash
dsh --profile <name> --dump-default-config 2>&1 | grep -i incompatible
node scripts/check-profile-compat.mjs --profile "<profile>" --target 0.2.2-rc.1
```

---

## 5. 官方组合包列表与 app-boot 导入

**变更**：组合包清单从 app-boot 迁到 `@deepseek-ai/dsh-official-bundles`。
（证据：该包 0.2.2-rc.1 `lib/index.js` 导出 `PROFILE_TEMPLATES`、`RETIRED_BUNDLES`、
`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES`、`PROTECTED_PLUGINS`、`HIDDEN_BUNDLES`、
`EXTENSION_BUNDLES`、`MORE_BUNDLES`、`EXPERIMENTAL_BUNDLES`、`INSTALLATION_OWNED_PROFILE_TUPLES`。）

```js
// 之前
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot';
// 之后
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles';
```

`RETIRED_BUNDLES` 当前为 `['@deepseek-ai/dsh-experimental-schedule-bundle']`：升级时 app-boot
会自动从 profile 的 bundles 中移除它们——**但 `dsh-experimental-tool-worktree` 不在此列，
需要手动移除**。

**验证**：

```bash
node -e "import('@deepseek-ai/dsh-official-bundles').then(m=>console.log(Object.keys(m).sort().join(',')))"
```

---

## 6. PTC 运行时

- 取消语义：调用方取消的 `run_code` 返回 `ABORTED`，不再 `CODE_RUN_FAILED`。
  所有消费取消结果的地方（SDK、Session 消费方、UI 分类）要更新判断。
- 控制通道改为 birpc：**自部署 bootstrap 与 SSH helper 必须同步升级**，SSH 协议 2 → 3。
- 新增 VM Script 模式：顶层 await / 动态导入 / 表达式结果可用；跨调用状态需显式开启；
  顶层不允许 `return` / `using`。
- 原生与 PTC 执行器拆分，PTC 通过配置 overlay 启用；旧 `tools.mode` / `DSH_TOOLS_MODE` 要迁移。

**验证**：`run_code` 正常返回；手动取消得到 `ABORTED`；跨调用状态开关各测一次。
