# 04 · 会话与存储迁移（0.2.1-rc.5 → 0.2.2-rc.1）

> **影响谁**：注册 Session Projection、直接调 `ctx.sessions.*` 或客户端 `session/*` Remote、在 `session/created`/`session/disposed` 里读写的插件；把会话持久化到 `ctx.storage.domain`（整单元 JSON）的自研后端；以及任何用 `header.parentSession` 判断“这是不是子智能体”的代码——这一类在升级后会**悄悄**把独立分支当成子代理。

**证据约定**：`021:` = 0.2.1-rc.5 安装包 `app.asar` 解包根，`022:` = 0.2.2-rc.1 安装包 `app.asar` 解包根；行号为文件内实际行号。标「推断」的结论已附验证方法。

---

## 1. Session API 拆出独立接口：快照 / 事件日志订阅 / 运行状态 / 事件投影

### 变更

0.2.1 的会话读取面基本只有“翻页 + 跟随”两条通道；0.2.2 把四类读取拆成各自独立、可单独订阅的 Remote 端点。

| 能力 | 0.2.1（`021: …/dsh-api-session-controller/lib/typert.host.js`） | 0.2.2（`022: …/lib/typert.host.js`） |
|---|---|---|
| 读一页事件（快照切点） | `session/page` | `session/events`（`session/page` 保留但已弃用） |
| 持续订阅事件日志 | `session/follow` | `session/follow` + `session/observeEvent` |
| 运行状态 | 无独立端点（只能借 `session/control` 的 baseline） | `session/state`、`session/observeState`、`session/wait`、`session/observation` |
| 事件投影数据 | `session/projections` | `session/projections` + `session/observeProjections` |

- 端点名单可用字符串重合对比证实：`021` 的文件里不存在 `session/events`、`session/state`、`session/observeEvent`、`session/observeState`、`session/observeProjections`、`session/wait`、`session/observation`；`022` 全部出现（同一 `typert.host.js`）。
- 语义写在文档里：`022: dsh-api-session-controller/README.zh.md:40` —— `events` 从持久切点读一页时间正序记录，返回 `records`、`hasMore` 和含末项的 `cursor`；省略 `throughSeq` 时取观察到的日志末尾；纯 `observeEvent` / `observeProjections` 订阅既不获取 Observation 也不确认实体存在，其 `ready` 帧不携带快照游标。
- 参数形状也分开了：`events`、`observeEvent`、`follow` 接收 **Address**；投影与状态操作接收 **Session ID**（`022: …/README.zh.md:40`；访问控制同理见 `:38`）。
- 包内同步读取同时被标弃用：`eventAt()`、`snapshotEvents()`、`ownEvents()` 属于“可暂不迁移、禁止新增生产调用”，只需要长度的调用方读 `seq`（`022: dsh-session/README.zh.md:64`）。

### 症状

- 只实现了 `session/page` 的旧客户端：0.2.2 下仍能工作（兼容入口在），但拿不到运行状态的增量，也拿不到投影的持续订阅——表现是“状态灯不更新 / 投影停在首屏”。
- 新写的插件若把 `session/observeEvent` 当“确认会话存在”，会拿到一个没有游标的 `ready`，后续 `append` 却因会话不存在而失败：observe 类订阅**不做存在性确认**。
- 用 `snapshotEvents()`/`ownEvents()` 读整段历史：功能可用，但 lint/依赖策略会拦住新增调用。

### 迁移动作

```ts
// 0.2.1：一条通道包办
const page = await remote["session/page"]({ sessionId, cursor });

// 0.2.2：按用途选端点
const page   = await remote["session/events"]({ address, cursor });   // 快照/翻页
const stop   = remote["session/observeEvent"]({ address }, onEvent);  // 持续订阅
const state  = await remote["session/state"]({ sessionId });          // 一次性运行状态
const live   = remote["session/observeState"]({ sessionId }, onState);
const proj   = await remote["session/projections"]({ sessionId, keys });
const projS  = remote["session/observeProjections"]({ sessionId, keys }, onProjection);
await remote["session/wait"]({ sessionId });                         // 等运行结算
```

- 读历史用 `events`，不要再用 `page`（保留只为过渡）。
- 需要“先确认存在再订阅”时，先 `session/state` 或 `session/events`，再开 observe 订阅。
- 包内插件改用 `session.seq` 取长度，用 `session.eventAt` 之外的新读取面。

### 验证方式

- 断线重连后：`session/events` 的 `cursor` 应能续读、不重不漏；`observeState` 应在运行状态变化时逐次推送。
- 对一个不存在的 sessionId 调 `observeEvent`：应只收到无游标的 `ready`，不报“不存在”；而 `state`/`events` 应明确失败或返回空。

---

## 2. Session Projection 注册 API 改为异步（启动时必须持有 handle）

### 变更

- 0.2.1：`register(definition)` 是**同步**的，直接返回 Cordis effect 的 disposer（内部 `return this.ctx.effect(...)`）：
  - `021: dsh-session-projection/lib/index.js:68`；
  - 读取只有注册表级别的 `stateOf(session, key)`，`cachedSnapshot` 也只读“别人已经算好的 cell”。
- 0.2.2：注册是异步的，成功时给出一个**handle**，插件必须在启动期持有它。
  - 兼容入口 `register(definition)` 仍在，但返回值是“可调用的 thenable”，运行时 `typeof === "function"`、`instanceof Promise === false`（`022: dsh-session-projection/lib/index.js:84`；文档 `022: …/README.zh.md:86`）。
  - 真正的新 API：`async acquire(definition, onEffect)`（`022: …/lib/index.js:115`）；`register` 在其上做了兼容包装。
  - handle 提供 `stateOf(session)`、`dispose(): Promise<void>`、`readerFor(session)`（`022: …/README.zh.md:58`、`:61`、`:69`）。
  - 注册归调用方 fiber 所有；最后一个注册方 `dispose()` 后，单元退出全局驱动、快照、恢复读取与变更通知；checkpoint 仍保留每个 Session 的最后一个 cell（`022: …/README.zh.md:58`）。
  - 弃用面：`stateOf(session, key)` 返回 `unknown`（`:90`）；`cachedSnapshot(session, keys)` 弃用，应改 `snapshot(session, keys)`（`:94`）。

```ts
// 0.2.1：同步注册，disposer 由 ctx.effect 持有
apply(ctx) {
  ctx.sessionProjections.register(definition);
  const s = ctx.sessionProjections.stateOf(session, "todo");
}

// 0.2.2：await 注册，持有 handle
async apply(ctx) {
  const handle = await ctx.sessionProjections.register(definition);
  const s = handle.stateOf(session);          // 强类型
  const read = handle.readerFor(session);     // () => S，供组合读取
  // 卸载：await handle.dispose()（重复调用安全）
}
```

### 症状

- `ctx.effect(() => register(...))` 或**异步生成器里 yield 注册值**：得到的是 handle 而 effect 失效，Cordis 报 `Invalid effect`；注册从未被该 effect 接管，插件仍激活，直到 fiber 卸载才释放（`022: …/README.zh.md:88`）。
- 用 `instanceof Promise` / Vitest 的 `expect(...).resolves` 断言：因为返回值是可调用 thenable，断言失败；需 `Promise.resolve(registration)`（`:86`）。
- 继续用 `stateOf(session, key)`：能跑，但类型是 `unknown`，且不生成无关视图的行为变化会掩盖缺失 key。
- `cachedSnapshot`：可能缺 key、无选中 cell 时返回 `undefined`，被当成“状态为空”。

### 迁移动作

1. 插件改为 `async apply(ctx)`，`const handle = await ctx.sessionProjections.register(def)`，把 handle 存在插件闭包里。
2. 读取改用 `handle.stateOf(session)`；需要组合多个投影时用 `handle.readerFor(session)`（`022: …/README.zh.md:69`）。
3. 释放用 `await handle.dispose()`，不要再用“调用返回值”的旧写法。
4. 测试里统一 `Promise.resolve(...)` 再断言。

### 验证方式

- 插件加载后 `handle` 非空，`handle.stateOf(session)` 返回强类型状态；热卸载不出现 `Invalid effect`。
- 同一 key 由两个插件注册时共享一个 cell；`stateVersion` 不一致应被拒绝（`022: …/lib/index.js:115` 起）。
- 只注册不读：`snapshot(session, keys)` 应给出一致视图，未注册 key 缺席。

---

## 3. 创建 / 恢复 / 销毁期间的事件发布与清理顺序

### 变更

SessionStore 的“进入—宣告—移除”状态机从两个布尔改成四态，并给 `append` 加了宣告门禁：

| 环节 | 0.2.1 | 0.2.2 |
|---|---|---|
| `prepare()` | 返回**未挂载**的实例（restore 分支不登记 attachment） | 两个分支都 `attachments.set(session, null)`（`022: dsh-session/lib/index.js:1808` 起） |
| 写入门禁 | 只校验“仍在 store 里”（`liveEntryFor`，`021: …:1972`） | 额外要求宣告完成：`entry.announcement !== "complete"` 即抛 `cannot append before session/created completes`（`022: …:1579`） |
| `announce()` | 派发**前**就置 `announced = true`（`021: …:1904`），无失败态 | 四态 `pending → dispatching → complete/failed`（`022: …:1879`、`:1922`、`:1935`、`:1937`） |
| `detachEntered()` | `attachments.delete(...)`，`if (entry.announced) emitDisposed`（`021: …:1886`、`:1892`） | `attachments.set(entry.session, null)`，`if (entry.announcement !== "pending") emitDisposed`（`022: …:1901`、`:1907`） |
| 派发中移除 | 只在 `!entry.appending` 时立即 detach | `detachRequested` 延迟到派发/追加结束（`022: …:1892`、`:1922` 的 finally） |

- 行为汇总在文档里：`022: dsh-session/README.zh.md:34` —— 独立实例进入 Store 时不把已有历史重放为 `session/event`；创建监听器只能读，且能看到**全部已有历史**；宣告失败或移除后仍禁止写入；**只有开始过宣告的实例**在移除时发 `session/disposed`，宣告失败也不例外；进入但从未宣告的实例两个通知都不发。

### 症状

- 在 `session/created` 监听器里 `append`（旧版常见做法，例如打一条初始化事件）：0.2.2 直接抛 `cannot append before session/created completes`，且该异常会让宣告失败、插件初始化中断。
- 依赖“宣告失败后不再有 `session/disposed`”的清理逻辑：现在失败也会发 disposed，可能重复清理。
- 以为创建监听器“看不到历史”：新顺序下能看到完整已有历史（对恢复场景尤其明显）。
- 在宣告派发期间同步卸载插件：移除被延迟，旧代码里“卸载即 detached”的假设不再成立。

### 迁移动作

1. `session/created` 监听器只读：需要写事件时改到宣告完成之后（例如插件 `apply` 的后续步骤，或监听 `session/event` 的首次 `turn/start`）。
2. 清理逻辑对 `session/disposed` 幂等：接受“宣告失败也可能收到 disposed”。
3. 自己组合 `prepare + enter + announce` 的代码（agent factory 一类）保持**同一个** `ctx.effect`，否则会重现 0.2.1 的竞态（`022: …:1795` 的注释明确警告兄弟 effect 的卸载顺序问题）。
4. 恢复流程不要依赖“进入 Store 会重放历史事件”；需要回放请显式读 `snapshotEvents` 之外的新读取面（见第 1 节）。

### 验证方式

- 注册一个抛异常的 `session/created` 监听器：会话应不可写、重试宣告被拒，卸载时仍收到 `session/disposed`。
- 在 `session/created` 里 `append`：应抛上述错误；把同一次写入挪到宣告之后成功。
- 恢复一个长历史会话：创建监听器读到的历史条数应等于持久日志条数。

---

## 4. 整单元 JSON / SQLite 存储：读“领域声明的旧版本”，写“当前版本格式”

### 变更

- 0.2.1：整单元 JSON 读取时**保留文件上的版本戳**。
  - `openSingleUnit` 直接 `parse(text, descriptor)`，序列化用 `state.version`（`021: dsh-storage-json/lib/index.js:178`、`:187`；`serialize` 的 `version: state.version` 在 `021: …:78`）。
  - 后果：一个被声明为兼容的旧版本文件，被读入后**再次写回时仍是旧版本戳**。
- 0.2.2：读取接受领域声明的兼容版本，随后把内存版本**强制提升为当前版本**。
  - `parse` 校验 `version !== descriptor.version && !descriptor.compatibleVersions?.includes(version)` 才拒绝（`022: dsh-storage-json/lib/index.js:106`）。
  - `openSingleUnit` 在解析后追加 `state.version = descriptor.version`（`022: …:196`）——下一次 publish 就以新格式落盘。
  - 领域的兼容声明：`descriptor.compatibleVersions` 透传于 `022: dsh-storage-domain/lib/index.js:89`；现存范例 `022: dsh-schedule/lib/types/storage.js:120`（`name: 'schedule', version: 2, compatibleVersions: [1]`）、`022: dsh-session-projection-cache/lib/index.js:92`。
  - 语义边界：`compatibleVersions` **只**允许当前解码器读旧数据，不做值迁移；消费方在重写选定记录时自行转换；没有独立迁移命令，未知版本在激活前拒绝，降级被拒（`022: dsh-storage-domain/README.zh.md:148`）。

### 症状

- 旧版本文件在 0.2.1 下读写多次后版本戳不变，0.2.2 首次写入即升级戳；如果还有降级回 0.2.1 的流程，旧进程会因不认新戳而拒绝——降级被明确拒绝。
- 未在 descriptor 里声明 `compatibleVersions` 的领域：升级后读旧文件直接 `version-mismatch`，整个整单元不可用（不是丢弃某条记录）。
- 以为“兼容版本 = 自动迁移字段”：不会，语义差异由消费方负责，旧值可能原样留在新戳文件里。

### 迁移动作

1. 在你的 storage domain descriptor 上声明能读的旧版本：`compatibleVersions: [prev]`。
2. 确保当前解码器真的能解释旧形状（字段新增用可选、删除字段做容错），因为没有任何迁移执行器。
3. 需要一次性重写时，主动触发一次写入；不要期待“只是打开就升级”。
4. SQLite 后端：本构建的 `app.asar` 里没有 `@deepseek-ai/dsh-storage-sqlite` 包（仅在文档里被引用为姊妹后端，`022: dsh-storage-json/README.zh.md:113`），同一语义是否已同步到 SQLite 属**推断**；验证方法见下。

### 验证方式

- 手工造一个 `{"unit":{"name":"<n>","version":<n-1>},…}` 文件 → 打开并写一次 → 断言文件里的 `unit.version` 等于当前版本。
- 再换成未声明的版本号：应在打开时报 `version-mismatch`。
- 若你有 SQLite 后端副本：用同法验证“读旧戳、写新戳”，并检查其 descriptor 是否同样透传 `compatibleVersions`。

---

## 5. 会话分支（fork）独立运行，不再被误识别为子智能体

### 变更

- 0.2.1 的文档措辞就是“子会话”：`021: dsh-session/README.md:32` —— “`fork()` creates a **child session** from a stable prefix of a live one.”（中文版同样写“创建子会话”）。
- 0.2.2：fork 产出**独立会话**，不再记录来源关系；分类字段改为 `origin`。
  - `022: dsh-session/README.zh.md:32`：`fork()` 复制历史、`cwd`、`isSeeded` 和继承事件数，**不记录来源关系**；`parentSession` 记录的是“**子代理**的直接创建者”，历史普通 fork 可能仍在该字段保留来源，因此“分类使用 `origin`”。
  - `origin` 的唯一合法值就是 `subagent`：`022: dsh-session/lib/types/index.js:58-59`（非 `subagent` 且非 `undefined` 直接抛错）。
  - 消费侧同口径：ACP 的会话列表与恢复“允许普通 fork，包括含 `parentSession` 的历史日志；`origin: subagent` 仍被排除”（`022: dsh-acp/README.zh.md:76`）。

### 症状

- 插件按 `header.parentSession !== undefined` 判父子：**独立运行的 fork 会被当成子代理**，于是被排除出会话列表、套用子代理的权限/生命周期、拒绝恢复或拒绝重命名。
- 反向也会错：真正的子代理若因历史原因丢了 `parentSession`（或被迁移边改写），按 `parentSession` 判会漏判。
- 目录/侧栏里出现“幽灵子会话”，或在 fork 上做“父会话结束后清理子会话”的联动。

### 迁移动作

```ts
// 0.2.1 常见写法（错的）
const isSubagent = session.header.parentSession !== undefined;

// 0.2.2 正确写法：只认 origin
const isSubagent = session.header.origin === "subagent";
// parentSession 仅作来源线索展示，不参与分类
```

- 把 `header.origin === "subagent"` 作为唯一分类依据；`delegationDepth`、`isSeeded`、`parentSession` 都不是分类信号。
- 列表/恢复过滤逻辑同步改口径，避免与 ACP、Web 语义分叉。
- 需要在 UI 里展示“来自哪个会话”时，继续读 `parentSession`，但标注为“来源”，不据此改变行为。

### 验证方式

- 对一个会话执行 fork，再读取新会话 header：`origin` 应为 `undefined`，`isSeeded` 为真，且它出现在会话列表里、可以被恢复。
- 起一个真实 `subagent`：`origin` 应为 `"subagent"`，在只允许普通会话的列表/恢复入口里被排除。
- 用旧判断复跑同一场景应能复现误判（回归测试保留两条断言）。

---

## 复核建议（给审查者）

1. 第 1 节的端点对照基于 `typert.host.js` 的字符串集合差异，未逐个读 RPC 声明；若要写进对外文档，建议再过一遍 `022: dsh-api-session-controller/lib/types/client/contract/{session,sessions,snapshot}.js`。
2. 第 2 节 `acquire` 与 `register` 的包装关系以 README 与实际返回值为准；`dispose()` 的幂等性与“重复调用安全”来自文档，代码侧建议补一条集成测试。
3. 第 4 节 SQLite 后端不在本构建内，结论按“推断”处理；若目标环境确有该包，用同法复核后再去掉推断标记。
4. 第 5 节只覆盖 `origin`/`parentSession` 分类；`delegationDepth` 是否参与任何遗留过滤逻辑未逐一审计。
