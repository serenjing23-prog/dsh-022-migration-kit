# 05 · Agent 路由与 LLM（pi-ai、请求头、容量、Web Fetch）

**影响谁 / 什么时候踩到**：用 `agent/request` 钩子改模型路由的插件作者；在 pi-ai 路由上注入传输请求头的插件；把自定义模型（尤其是 32K 级网关）接进 profile 的部署者；依赖「Web Fetch 会拒绝私网」这一行为的自托管部署。踩到时机是升级到 0.2.2-rc.1 后的**第一次模型请求**与**第一次抓取**，而不是启动时。

**证据前缀约定**（下文 `前缀:行号`）：

| 前缀 | 实际路径 |
|---|---|
| `AGENT/` | `dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js` |
| `AGENT-RM/` | `…/@deepseek-ai/dsh-agent/README.zh.md`（0.2.2-rc.1 解包） |
| `PIAI/` | `dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` |
| `PIAI-RM/` | `…/@deepseek-ai/dsh-llm-pi-ai/README.zh.md` |
| `PIAI021/` | `dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`（0.2.1-rc.5 同位置） |
| `FETCH/` `FETCH-RM/` | `…/@deepseek-ai/dsh-web-fetch-http/lib/index.js`、`README.zh.md`（0.2.2） |
| `FETCH021/` | `dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js`（0.2.1） |
| `FETCH021-RM/` | `dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/README.zh.md` |
| `RELNOTES.md` | `RELNOTES.md` |

---

## 0. 影响面速判（30 秒）

命中任意一条就需要按本文逐节迁移；四条全不命中可以只做末尾的「复核清单」。静态检查脚本统一放在 §7。

- [ ] 插件里有**写入** `agent/request` 的 `config.provider` / `config.model` / `reasoningEffort` 的代码。
- [ ] 插件靠包装 `fetch`、改全局 header 或适配器外层来注入传输请求头。
- [ ] profile 接入了**非 1M 上下文**的自定义模型，且没显式写 `contextWindow` / `maxOutputTokens`。
- [ ] 部署把 Web Fetch 当成"只能抓公网"的安全边界（或反之，正等着它支持内网）。

---

## 1. 步骤模型固定：`agent/request` 不再允许改路由

### 变更
- 0.2.2 在**提示词组装之前**捕获一次 `provider / model / reasoningEffort`，并把这个值应用到同一步骤的请求与**所有重试**；本步之后的并发切换只能等下一步生效（`AGENT-RM:174`）。
- `agent/request` 已弃用，仅为既有监听器保留；监听器必须**原样保留**三者，不得改路由（`AGENT-RM:78`）。逐请求控制参数除 `AgentOptions.maxTokens` 外**没有替代 API**（`AGENT-RM:78`、`AGENT-RM:42`）。
- 选择入口是 `agent.model`（与 `agent.inbox` 并列）：`current()` 依次读待生效选择 → 最近请求头 → 实时 `options`；`select({provider, model, reasoningEffort?})` 从下一个尚未准备的步骤生效（`AGENT-RM:48-52`，实现见 `AGENT:181-203`）。
- 作用域内的切换提示由 `installModelSelection(agentCtx)` 安装：它只在「本步固定路由 ≠ 最近一次请求头」时追加一条 `[model changed: …]` user 消息（`AGENT:231-243`，`AGENT-RM:54`）。

### 症状
- 以前在 `agent/request` 里写 `config.provider = …` 能切模型，升级后**静默无效**（被步骤固定值覆盖），请求仍走旧路由。
- 以前「重试时换模型」的技巧失效：重试固定为同一选择，失败重试不再换端点。
- 同一 turn 内两步看到不同模型（本步固定 + 下一步才生效），Web 模型选择器与实际请求出现一拍的错位。
- 若插件把 `agent/pre-step` 的 `decision.messages` 清空，切换提示不会出现（`AGENT:235` 的空消息短路）。

### 迁移动作
1. 把 `agent/request` 监听器里的路由写入删掉，改成在需要切换的位置调用 `agent.model.select({ provider, model })`；**省略 `reasoningEffort` 表示 Auto（适配器默认），不继承旧强度**（`AGENT-RM:50`）。
2. 输出上限改由 `AgentOptions.maxTokens` 承载，不要再逐请求塞 `max_tokens`（`AGENT-RM:42`）。
3. 需要在历史里留痕迹时，在 Agent `setup(agentCtx)` 里调 `installModelSelection(agentCtx)`，监听器随作用域释放（`AGENT-RM:54`）。
4. 仍有 `agent/request` 的监听器只保留**读**语义；驱动逻辑迁到 `agent/pre-step` 或 `agent/turn-stopping`（`AGENT-RM:80`）。

### 验证方式
- 静态：`grep -rn "agent/request" <插件目录>` 只应剩读取；`grep -rn "agent\.model\.select" ` 至少一处。
- 动态：一次 turn 内先 `select` 再发消息，检查 `session.requestHeader().config`（`AGENT:236` 读的就是它）在**整轮重试**中 `provider/model` 不变；第二步才变。
- 提示：强制一次失败重试，确认历史里只出现一条 `[model changed: …]`，而不是每步一条。

---

## 2. pi-ai 动态请求头（按会话与请求用途）

### 变更
- 新增同步 waterfall `llm-pi-ai/request-headers`（`PIAI:2950`）。每次推理调用给出**不可变**的路由元数据与一份从 profile 标头复制的独立 `Headers`：
  `{ provider, model, baseURL, sessionId?, purpose? }`（`PIAI:1851-1857`）。`sessionId` 与 `purpose` 缺省时字段**不出现**。
- Harness 的应用标识在**所有贡献器之后**写入，贡献者改不掉（`PIAI:1859`）；pi-ai 收到的是独立标头记录（`PIAI-RM:150`）。
- 贡献器抛错或给出无效 HTTP 字段名/值，请求**在发出前**以 `LlmError` 代码 `REQUEST_HEADERS` 失败，不发送半成品请求（`PIAI:1861-1862`、`PIAI-RM:152`）。原生 `TypeError` 会回显凭据，因此只给安全排查文案（`PIAI:1842-1845`）。
- 直接使用 `PiAiAdapter` 的调用方可传等价 `prepareHeaders` 回调（`PIAI-RM:152`）。
- 覆盖面：有/无 `sessionId` 的推理调用与辅助调用都走这条链，**模型发现不走**（`PIAI-RM:152`）。

### 症状
- 以前在 `globalThis.fetch` 或适配器外层包一层来加头：升级后要么被应用标识覆盖，要么在并发请求间串味（0.2.1 无此扩展点，`grep prepareHeaders` 在 `PIAI021/` 零命中）。
- 手写的请求头一旦含换行/非法字符，报错从「HTTP 层」提前到「推理前」，错误码变为 `REQUEST_HEADERS`，旧的错误匹配分支抓不到。
- 订阅了 `llm-pi-ai/request-headers` 却忘了调 `next()`，请求会一直等或直接抛错。

### 迁移动作
```ts
// 同步监听器；修改传入的 Headers 副本后必须 next()
ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
  // request: { provider, model, baseURL, sessionId?, purpose? }（frozen）
  if (request.sessionId) headers.set('x-session-id', request.sessionId)
  headers.set('x-tenant', tenantOf(request.provider))
  return next()
})
```
- 值必须是单行、可表示为字节的 HTTP 字段值；构造失败在监听器内就抛 `Error`，消息**不得含凭据与标头值**（`PIAI-RM:152`）。
- 需要按用途分流时读 `request.purpose`（例如标题/审核等辅助调用），不要用 provider 名去猜。
- **不要把两套 header 入口混用**：profile 里 `headers:` 是静态配置，**在配置加载期就被校验**——非法字段名/多行值会让整个 provider 解析失败（`PIAI:1104-1111`、`PIAI:1129`），错误发生在启动/保存设置时；而插件贡献的头是在**每次请求发出前**校验。二者报错时机与错误码不同，排障时先确认是哪一套。
- 同一 provider 的配置里若两个键仅大小写不同，以**最后一个**为准（`PIAI-RM:150`）。

### 验证方式（含负向与并发）
- 抓包或网关日志：确认自定义头存在，且 `User-Agent`/应用标识仍是 Harness 的（`PIAI:1859`）。
- 负向 A（插件路径）：临时 `headers.set('x-bad', 'a\nb')`，应得到 `REQUEST_HEADERS` 且网关**没有**收到任何请求。
- 负向 B（配置路径）：在 provider 配置里写 `headers: { "x bad": "v" }`，应在**加载配置**时就报 `not valid for Fetch`（`PIAI:1109`）。
- 并发：同时跑主会话与一次辅助调用（会话标题），确认两边头不串。

---

## 3. pi-ai 1.3.0：模型目录、端点、推理回放

### 变更
- 依赖升到 `@earendil-works/pi-ai: ^1.3.0`（`…/@deepseek-ai/dsh-llm-pi-ai/package.json`，`dependencies`）。
- 同步了模型目录、端点与**推理回放规则**；一条响应里若有「已完成但格式错误的工具参数」，该次响应在任何工具执行前失败（`RELNOTES.md:116`，英文版 `:256`）。

### 症状
- 之前能用的自定义模型条目在模型选择器里消失或需要重填（目录/端点数据换了来源）；`baseURL` 仍是自填的，但模型 id 与能力位可能对不上。
- 走 OpenAI 兼容网关的推理模型：思考签名（thought signature）以前丢一次还能续，现在回放规则更严，缺签名会被端点拒绝（对照 `RELNOTES.md:59` 的 Gemini 修复）。
- 代理或网关返回**截断的 tool-call JSON** 时，整轮直接失败且**一个工具都没执行**，表面上像"模型不干活"，日志里是响应解析失败。

### 迁移动作
1. 升级后逐个复核 pi-ai provider 的模型配置（provider、`baseURL`、模型 id、能力声明）；不要指望旧的自定义目录项自动迁移。
2. 网关若是"半兼容"实现，优先降级到非推理模型或改用 native provider，别在中间层补 tool-call 片段。
3. 工具链上增加「本轮 0 工具调用但模型有输出」的告警，用来区分"模型拒绝"与"参数格式错误整轮失败"。

### 验证方式
- 一次带工具调用的往返 + 一次性发一张图片的往返，都成功即说明目录与端点可用。
- 故意让网关截断一个 tool-call JSON：应看到整轮失败且没有任何工具副作用（文件未改、命令未跑）。
- `node -e "console.log(require('<profile>/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json').dependencies)"` 确认是 `^1.3.0`。

---

## 4. 未声明容量的自定义模型：默认 1M 上下文 / 128K 输出

### 变更
- 0.2.2：`DEFAULT_CONTEXT_WINDOW = 1e6`（**十进制 1,000,000**）、`DEFAULT_MAX_TOKENS = 128e3`（**128,000**），并作为 schema 默认值（`PIAI:960`、`PIAI:962`、`PIAI:1058-1059`）；配置未给 `defaultContextWindow` 时回落 `1e6`（`PIAI:1157`）。
- **这是 4 倍级放大**：0.2.1 同位置是 `262144` / `32768`（`PIAI021:959`、`PIAI021:961`）。
- 解析顺序：模型条目 `contextWindow` → base → 请求级 `defaultContextWindow`（`PIAI:694`）；容量字段也可从外部目录读 `context_window / context_length / max_input_tokens / limit.context` 等别名（`PIAI:2393-2394`、`PIAI:2299`）。

### 症状
- 32K/8K 级端点：长会话**很晚才压缩**，然后一次性撞上端点 400（上下文超限），表现为"突然整轮失败"，而不是渐进截断。
- 输出上限：默认 `max_tokens ≈ 128000` 被小端点直接拒绝；某些网关报 `max_tokens too large` 却提示不到模型名。
- 反向：大端点上的压缩阈值变松，token 成本与延迟上升，但没人改过配置。

### 迁移动作
- 每个非 1M 级路由都**显式覆盖容量**：模型条目写 `contextWindow` / `maxOutputTokens`，或在该 provider 上设 `defaultContextWindow` / `defaultMaxTokens`（schema 见 `PIAI:1038`、`PIAI:1058-1059`）。
- 拿真实端点值填，不要照抄 1M/128K；压缩阈值跟着 `contextWindow` 走（`PIAI:1480-1489` 用它做溢出判定）。
- 多路由部署逐个路由覆盖，不要只改全局默认。

### 验证方式
- `dsh --profile <p> --dump-config` 里该 provider 的生效值应为你的显式值（未写时才会出现 1000000/128000）。
- 跑一次接近窗口的会话，观察压缩触发点是否贴近 `contextWindow` 的预期比例（此前会明显滞后）。
- 小端点回归：一次长输出请求不再 400。

---

## 5. Web Fetch 不再拒绝非公网地址（安全边界变化）

### 变更
- 0.2.1：只接受公共单播目标，主机名只解析一次、任一非公网地址即**拒绝整个结果**并把连接固定到已校验地址（`FETCH021-RM:64`；实现注释「连接不能二次解析到私网地址」见 `FETCH021:12`，「否则正好到达这些检查要挡住的 loopback/私有服务」见 `FETCH021:129`，代理/loopback 属于受支持目标的说明见 `FETCH021:144`）。
- 0.2.2：删除该限制——请求走进程级 dispatcher（代理策略生效），目标地址由系统解析器选择，**任何目标地址都被允许**（`FETCH-RM:64`、`FETCH-RM:135`）。`FETCH/` 中已无 private/loopback 判定（grep `private|loopback|127.0.0` 零命中）。
- 相对的兼容修复：编码声明混含 UTF-8 的可读页面现在能被解码（`RELNOTES.md:73`）。

### 症状
- 模型可以抓 `http://127.0.0.1:<port>/`、内网服务与云元数据地址；提示注入页面能把内网内容读进上下文（SSRF 面扩大）。
- 依赖「私网会被拒绝」的插件错误分支变成死代码；以前"抓取失败但安全"的场景现在**成功返回内容**。
- 自托管环境若本来靠这条限制兜底，等于默认放开了。

### 迁移动作（部署侧自行限制，按优先级）
1. **不挂载**抓取工具：不启用 `dsh-tool-web` / `dsh-web-fetch-http` 的 profile 直接不装（`FETCH-RM:135` 的首选方案）。
2. 加 `tools/pre-execute` 策略：对 URL 参数做主机解析并拒绝 loopback / RFC1918 / link-local / 云元数据（`169.254.169.254` 等），拒绝失败要显式报错而不是放行（`FETCH-RM:135`）。
3. 网络隔离：容器/防火墙限制出站，只允许代理；保留进程级 dispatcher 的代理配置（`FETCH-RM:64`）。
4. 提醒用户：这是行为变更，不是漏洞修复——升级说明里要写清"抓取不再有地址白名单"。

### 验证方式
- 正/负向：让模型抓 `http://127.0.0.1:<dsh 端口>/` 与 `http://169.254.169.254/latest/meta-data/`；**能返回内容 = 策略未生效**。
- 抓一个纯内网域名，确认 `tools/pre-execute` 拒绝时的错误文案出现且没有发起 TCP 连接（网关侧看不到请求）。
- 抓公网页面确认代理仍生效、`User-Agent` 仍是显式产品标识（`FETCH-RM:64`）。

---

## 6. 失败面速查：这些错误码现在意味着什么

`dsh-llm-pi-ai` 的失败被收敛到少数稳定码上（导入清单见 `PIAI:2`），升级后**按码分流**比按文案匹配可靠：

| 错误码 | 触发点 | 升级后常见成因 | 处置 |
|---|---|---|---|
| `REQUEST_HEADERS` | 请求发出前（§2） | 插件头非法、贡献器抛错、忘了 `next()` | 修头或修贡献器；不会产生半截请求 |
| `CONTEXT_WINDOW_EXCEEDED` | 请求/响应期间用 `contextWindow` 判溢出 | 容量被默认 1M 放大后**更晚**才触发（§4） | 显式设容量；别用默认值跑小端点 |
| `IMAGE_OFFLOAD_REQUIRED` | 图片数/字节超限 | 图片上限与卸载策略按 provider 配置（`maxRequestImages` 默认 50，`PIAI:1134`） | 调 `maxRequestImages` / `maxRequestImageBytes` |
| `INVALID_CREDENTIAL` | 认证阶段 | 升级后凭据平面变化、env 名不同 | 重填凭据，不要改代码 |
| `QUOTA_EXCEEDED` | 端点返回配额错误 | 与路由/计费无关的透传 | 换 key 或换路由 |
| `EMPTY_RESPONSE` | 响应解析后无内容 | 网关返回空/被截断（常与 §3 的工具参数格式错误同源） | 查网关日志，别重试打满 |

排查顺序建议：`REQUEST_HEADERS` → `INVALID_CREDENTIAL` → `CONTEXT_WINDOW_EXCEEDED` → 其余。前两个是"我们发不出去"，第三个是"发出去太多"，剩下的一般在端点侧。

---

## 7. 插件自检脚本（一次性）

把 `<插件目录>` 换成你的包根目录；四项全绿再合并：

```powershell
# 1) 路由改写必须清零（允许读取）
grep -rn "agent/request" <插件目录>

# 2) 选择入口必须存在（至少一处）
grep -rn "agent\.model\.select\|installModelSelection" <插件目录>

# 3) 容量必须显式（没有输出=用的是默认 1M/128K，危险）
grep -rn "contextWindow\|maxOutputTokens\|defaultContextWindow\|defaultMaxTokens" <插件目录>

# 4) 头注入只走 waterfall（不应再出现包装 fetch 的痕迹）
grep -rn "llm-pi-ai/request-headers\|globalThis.fetch\|prepareHeaders" <插件目录>
```

期望：1) 空；2) ≥1 行；3) 非空（如果该插件确实接了小端点）；4) 只命中 `llm-pi-ai/request-headers`。

---

## 8. 复核清单（升级后一次跑完）

| 检查 | 命令/位置 | 期望 |
|---|---|---|
| 无路由改写 | `grep -rn "agent/request" <插件>` | 只剩读取 |
| 模型固定 | 一次 turn 内切模型 | 重试不变，第二步才变 |
| 请求头 | 网关日志 | 自定义头存在，应用标识未被覆盖 |
| 容量 | `--dump-config` | 小端点出现显式值，而非 1000000/128000 |
| 抓取边界 | 抓 loopback | 被你的策略拒绝 |
| pi-ai 版本 | provider 包 `dependencies` | `^1.3.0` |

**推断项（需复核）**
1. `purpose` 的取值集合：本版解包中 `PIAI:1856` 只做透传，`dsh-llm`、`dsh-llm-pi-ai`、`dsh-agent-loop` 内均无赋值点（推断由标题/审核等辅助调用方注入）。复核：在 `llm-pi-ai/request-headers` 里 `console.log(request.purpose)`，跑一次会话标题生成与一次 Auto 审核，观察实际字符串。
2. 「Web Fetch 在 0.2.1 曾拒绝私网」用的**具体错误码**未在本文引用。复核：在 `FETCH021/` 里搜该错误消息常量，确认被删掉的判定返回什么码，避免旧监控按码匹配失效。
3. 1M/128K 是否会被显式 `defaultContextWindow` 之外的第二层（会话级设置）覆盖，未在本文件验证。复核：改 `defaultContextWindow` 后看 `--dump-config` 与运行时压缩点是否一致。
