# 06 · 插件清单与兼容门（manifest gate、索引、安装诊断）

**影响谁 / 什么时候踩到**：发布或安装第三方 bundle 的人；维护自定义 app-boot 集成（自己 import 官方组合包列表）的人；用「自定义插件市场」加过索引源的部署者。踩到时机是升级后的**第一次 `dsh --dump-config` / 第一次启动**（bundle 被跳过），或**第一次点安装/更新**（pnpm 前被拒）。

**证据前缀约定**：

| 前缀 | 实际路径 |
|---|---|
| `APP-BOOT/` | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（0.2.2-rc.1） |
| `APP-BOOT021/` | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（0.2.1-rc.5） |
| `PM/` | `…/dsh-plugin-manager/lib/index.js` |
| `PM-RM/` | `…/dsh-plugin-manager/README.zh.md` |
| `PM-T/` | `…/dsh-plugin-manager/lib/types/`（`failure.js`、`operations.js`、`diagnostic.js`、`tools.js`） |
| `OB/` | `…/dsh-official-bundles/lib/index.js` |
| `MARKET-RM/` | `…/dsh-plugin-market/README.zh.md` |
| `MKT-UI/` | `…/dsh-client-ui-plugin-market/lib/client.js` |
| `PM-UI/` | `…/dsh-client-ui-plugin-manager/lib/client.js` |
| `RELNOTES.md` | `RELNOTES.md` |

---

## 1. 兼容门：`requirements` / `engines.dsh` / `peerDependencies`

### 变更
- **判定发生在加载插件代码之前**：先读 `package.json`，再决定是否 import（`APP-BOOT:1070`）。
- 判定顺序：**自己声明的 `engines.dsh` 单独决定，且此时 peerDependencies 被完全忽略**；没有 `engines.dsh` 时，逐个检查 `@deepseek-ai/dsh` 与所有 `@deepseek-ai/dsh-*` 的 peer 范围（`APP-BOOT:1097-1116`、`APP-BOOT:1119-1120`）。
- peer 里的 `workspace:^ / workspace:~ / workspace:*` 视为「当前运行时」（`APP-BOOT:1110-1114`）；空串、其它 `workspace:` 形式在 `engines.dsh` 位置**一律算不满足**（`APP-BOOT:1122`）。
- 不满足 → bundle 进入 `skippedBundles`（原因就是 `String(error)`，`APP-BOOT:1816-1821`），由 CLI 打到 stderr：`dsh: skipping profile bundle "<pkg>": <reason>`（`APP-BOOT:1355-1356`）。`--dump-default-config` 与 `--dump-config` 都走 `prepareProfile` → `reportSkippedBundles`（`…/dsh/lib/profile-boot-e2mS45fC.js:217-220`）。
- 诊断文案固定包含三项：包与运行时、未满足的 requirement 表、**豁免命令与豁免是否生效**（`APP-BOOT:1151-1153`）。
- 安装侧在 **pnpm 之前**就拒绝（点名 spec 才预检；git/tarball 需要 fetch 本身，见 `PM-T/operations.js:180`），被拒时 CLI 直接给出豁免命令（`…/dsh/lib/plugin-DscIHF4k.js:96`）。
- 豁免落在 profile 自己的 `compatibility.json`（与 `package.json`、`cordis.patch.yml` 并列），格式是「精确 `name@version` → 精确 DSH 版本数组」（`APP-BOOT:1156-1180`、`PM-RM:79`）。**插件升级和 DSH 升级都不继承授权**（`PM-RM:79`）。

### 症状
- 启动 stderr / Host 日志出现 `skipping profile bundle`，GUI 插件页那条消失（不是"禁用"，是没被加载）。原文形状：
  `Plugin <pkg>@<ver> is incompatible with dsh 0.2.2-rc.1: requirements {"@deepseek-ai/dsh-…":"…"}. Running it may cause crashes or data loss. … grant the exact-version exemption for <pkg>@<ver> on dsh 0.2.2-rc.1 with \`dsh plugin allow-version\` … Exact-version exemption: not active.`
- 0.2.1 上已实测过一次：`@zebbkira/dsh-skills-mcp-manager@0.2.0` 要求 `@deepseek-ai/dsh-client-connection: ^0.1.1-rc.2`，被跳过（本机取证记录）——这是**真越界**（`^0.1.x` 装不下 `0.2.x`），不是预发布陷阱。
- `--dump-config` 只列出成功加载的 bundle 层；被跳过的那个**不在输出里**，只在 stderr 有提示，容易误判为"配置丢了"。

### 迁移动作
```powershell
# 看跳到哪、为什么（stderr 会被这里捕获）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  --profile desktop --dump-config 2>&1 | Select-String 'skipping profile bundle'

# 优先：升级/换用兼容版本（不要先豁免）
# 只有确认风险、且用户明确同意时：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile <profile> allow-version "<pkg>@<ver>" --dsh-version 0.2.2-rc.1 --accept-risk
# 撤销 / 列表
& …\dsh.cmd plugin --profile <profile> version-exemptions
& …\dsh.cmd plugin --profile <profile> revoke-version "<pkg>@<ver>" --dsh-version 0.2.2-rc.1
```
- CLI 参数以 `…/dsh/lib/plugin-DscIHF4k.js:17-37` 为准：`allow-version` 缺 `--accept-risk` 会拒绝；`version-exemptions` 不接受多余参数。
- 桌面 profile 由应用独占，`dsh.cmd --profile desktop` 可能被拒；此时在 GUI 插件页做豁免，或对副本 profile 验证后手工写 `compatibility.json`。

### 验证方式
- `…dsh.cmd --profile <p> version-exemptions` 应列出 `name@version → [0.2.2-rc.1]`。
- 再跑一次 `--dump-config`，stderr 不再出现该包；`--dump-config` 输出里出现它的 bundle 层。
- 负向：把 `engines.dsh` 改成 `0.1.0`，应立刻回到 skip（证明门在工作，而不是缓存）。

---

## 2. 预发布版 semver：真实数据（**修正一个常见误判**）

### 变更（语义）
- DSH 的门用 **`semver.satisfies(rt, range, { includePrerelease: true })`**（`APP-BOOT:1094-1096`）。**0.2.1 就是同一实现**（`APP-BOOT021:276-277`），所以这不是 0.2.2 的行为变更，而是长期存在、容易被误读的语义。
- `includePrerelease: true` 让预发布版本能够匹配**没有预发布段的比较器**；因此 `^0.2.1-rc.x` / `>=0.2.1-rc.x` / `>=0.2.0` / `*` / `~0.2.1` 对 `0.2.2-rc.1` **都满足**。
- 只有那些**真的把 0.2.2 挡在外面**的范围才会 skip：精确 pin（`0.2.1-rc.5`）、跨 minor 的下界（`^0.1.x`）、空串。

### 实测对照表（`semver@7.8.6`，取自 0.2.2 应用内 `dsh/node_modules/semver`，运行时版本 `0.2.2-rc.1`）

| requirement 写法 | DSH 门（includePrerelease） | 裸 `semver.satisfies` | 结论 |
|---|---|---|---|
| `^0.2.1-rc.1` | **PASS** | false | 不 skip；裸判定会误报 |
| `>=0.2.1-rc.3` | **PASS** | false | 同上 |
| `^0.2.1-rc.5` | **PASS** | false | 同上 |
| `~0.2.1-rc.5` | **PASS** | false | 同上 |
| `>=0.2.0` | **PASS** | false | 同上 |
| `~0.2.1` | **PASS** | false | 同上 |
| `*` | **PASS** | false | 同上 |
| `>=0.1.0` | **PASS** | false | 同上 |
| `^0.2.2-rc.1` | **PASS** | true | 推荐写法 |
| `>=0.2.2-rc.1` | **PASS** | true | 推荐写法 |
| `^0.1.1-rc.2` | **SKIP** | false | 真越界（minor 不符） |
| `0.2.1-rc.5`（精确 pin） | **SKIP** | false | 真会 skip，必须改 |
| `""`（空串） | **SKIP** | false | 真会 skip |

### 现场数据（本机 profile，41 个包）
- 用裸 `semver.satisfies` 预判：**31 个包会被 skip**。
- 用 DSH 真实门（`includePrerelease: true`）：**0 个包被 skip**。
- 这 31 个里绝大多数是 `@linxin666/*` 的 `peerDeps.@deepseek-ai/dsh: ">=0.2.1-rc.3"`、`aegis` 的 `>=0.1.0-rc.6`、`dsh-pet` 的 `^0.2.0-rc.1` ——**都不会被跳过**。若按裸 semver 结论去逐个"修"，会白改一轮（并且把本来安全的 range 抬到 `^0.2.2-rc.1`，提前锁死后续 minor）。
- 口径说明：上面的 41 包是"第三方/社区包"口径，不含 profile 里**钉死官方版本**的 `@deepseek-ai/dsh-subagent-claude-code` 与 `@deepseek-ai/dsh-subagent-codex`（peer 精确 pin `0.2.1-rc.5`）。把它们算进来时，`scripts/check-profile-compat.mjs` 会报 **2 个 SKIP**——这两个要升级到 `0.2.2-rc.1`。

### 症状
- 误判为"预发布不兼容"→ 大规模改 `peerDependencies` 或加 `compatibility.json`，问题没消失（因为真正 skip 的是另一个包）。
- 反向误判：认为 `0.2.1-rc.5` 的精确 pin 还"差不多能用"，结果它在 0.2.2 上**确实被跳过**。

### 迁移动作
1. 只用**真实门**判定，别用裸 semver：清单级扫描请复用 `reports/_scan.mjs`，但把第 75-79 行的 `semver.satisfies` 换成带 `{ includePrerelease: true }` 的调用（`_scan.mjs:75-79` 现在是无参数版，会高估 skip）。
2. 需要抬范围时**只抬能证明被跳过的包**；新发布的插件写 `^0.2.2-rc.1` 或 `>=0.2.2-rc.1`（两者裸判定也成立，最稳）。
3. 精确 pin 的包（`0.2.1-rc.5`）必须改范围或升级版本，否则每次启动都 skip。

### 验证方式
```powershell
node --input-type=module -e @"
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const p = 'C:/Program Files/…/semver/'; // 任取 7.x
const semver = createRequire(pathToFileURL(p + 'package.json').href)('semver');
const sat = (r) => semver.satisfies('0.2.2-rc.1', r, { includePrerelease: true });
for (const r of ['^0.2.1-rc.5','0.2.1-rc.5','^0.1.1-rc.2']) console.log(sat(r), r);
"@
```
期望：`true ^0.2.1-rc.5` / `false 0.2.1-rc.5` / `false ^0.1.1-rc.2`。

---

## 3. 官方组合包列表迁到 `@deepseek-ai/dsh-official-bundles`

### 变更
- 0.2.2 的 app-boot **从包里 import**：`import { INSTALLATION_OWNED_PROFILE_TUPLES, PROFILE_TEMPLATES, RETIRED_BUNDLES } from "@deepseek-ai/dsh-official-bundles"`（`APP-BOOT:15`）。
- 0.2.1 是把列表**内联在 app-boot**：`lib/types/official-bundles.generated.js`（`APP-BOOT021:2409-2412`），并从 app-boot 导出 `DEFAULT_PROFILE_BUNDLES`、`OFFICIAL_ON_DEMAND_CATALOG`、`ON_DEMAND_BUNDLES`、`OPTIONAL_BUNDLES`（`APP-BOOT021:4566` 的 `export {…}`）。
- 现在这些名字由 `OB/` 导出（`OB:228`）：`PROFILE_TEMPLATES`、`INSTALLATION_OWNED_PROFILE_TUPLES`、`RETIRED_BUNDLES`、`DEFAULT_PROFILE_BUNDLES`、`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES`、`OFFICIAL_ON_DEMAND_CATALOG`、`PROTECTED_PLUGINS`、`HIDDEN_BUNDLES`、`EXTENSION_BUNDLES`、`MORE_BUNDLES`、`EXPERIMENTAL_BUNDLES`。
- 该包是**纯数据**，官方要求作为库依赖使用，不要走 `cordis.yml`（`…/dsh-official-bundles/README.zh.md:12`）。

### 症状
- 自定义集成 `import { OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-app-boot'` → ESM 直接 `SyntaxError: The requested module … does not provide an export named …`；CJS 下变成 `undefined`，然后在遍历时报 `undefined is not iterable`。
- 自己复制的列表与安装内容漂移：`RETIRED_BUNDLES`、`OPTIONAL_BUNDLES` 升级后会变（0.2.2 的 `OPTIONAL_BUNDLES` 多了 `forge-bundle`、`personalized-recommendations` 等，见 `OB:33-49`）。

### 迁移动作
```diff
- import { DEFAULT_PROFILE_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-app-boot'
+ import { DEFAULT_PROFILE_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-official-bundles'
```
- 依赖里显式加 `@deepseek-ai/dsh-official-bundles`（版本随安装，通常与运行时同号）。
- 不要再复制列表；它被编译进安装，改列表=发新版本（`README.zh.md:82`）。
- 若原来读的是 `ON_DEMAND_BUNDLES`（仅 3 个：`subagent-claude-code`、`subagent-codex`、`cua-bundle`，`OB:51-55`）而实际要的是带图标/本地化的目录，改用 `OFFICIAL_ON_DEMAND_CATALOG`（`OB:145`）。

### 验证方式
```powershell
node --input-type=module -e "import('@deepseek-ai/dsh-official-bundles').then(m=>console.log(Object.keys(m).sort().join('\n')))"
```
- 键集合应与 `OB:228` 一致；`node --input-type=module -e "import('@deepseek-ai/dsh-app-boot').then(m=>console.log(Object.keys(m)))"` 里**不应**再出现 `OFFICIAL_ON_DEMAND_CATALOG` / `OPTIONAL_BUNDLES`。
- `grep -rn "from '@deepseek-ai/dsh-app-boot'" <集成代码>` 逐个确认导入名还在导出表里。

---

## 4. 「自定义插件市场」→「自定义插件索引」

### 变更
- 只是**命名**：同一份 UI 文案从「市场」改成「索引」——0.2.1 `还没有插件市场` / `切换插件市场，当前为 {market}` / `插件市场`（`MKT-UI021:1115/1120/1177`）→ 0.2.2 `还没有插件索引` / `切换插件索引，当前为 {market}` / `插件索引`、`索引源`、`索引 URL`（`MKT-UI:1591-1600`、`MKT-UI:1653`）。
- **配置字段没改名**：两版都是 `indexes`（URL 数组，默认 `[]`）、`setIndexes(urls)`、`listIndexes()`（`MARKET-RM:31`、`:40-41`；0.2.1 同名，见 `…/dsh-plugin-market/README.zh.md:31`）。
- 发现页读取**用户添加的索引文件 URL**（Host 侧 fetch、拒绝重定向、Worker 里严格 UTF-8 解析校验，`MARKET-RM:91`）；默认没有任何索引源，`indexes: []` 时 Host 不发请求（`MARKET-RM:29`）。
- 「索引生成器排除 private 版本 / 标签 / 默认分支包」是**仓库侧生成器**的规则（`RELNOTES.md:138` 英文 `:278`），生成器不在安装包内（0.2.2 asar 文件清单中无生成器入口）——这一条属**推断**：规则生效在你自己的生成流水线，而不是升级后会帮你清洗已有索引文件。复核方法见文末。
- 顺带的行为变化：0.2.1 README 明确「**不支持升级**——索引版本更新的已安装组合包报告 `update-available`，升级仍需先卸载再安装」（`…07b/…/dsh-plugin-market/README.zh.md:102`）；0.2.2 增加了更新路径（见下节 5）。

### 症状
- 文档/截图/自动化脚本按「市场」字样找 UI 或找设置键，找不到（`marketMenu` 这个 i18n key 仍然叫 market，`MKT-UI:1596`）。
- 索引文件里混入 private 版本/默认分支包时，发现页照样列出来——生成器没排除，客户端不负责过滤。

### 迁移动作
- 配置**不用迁移**；只在文档、脚本注释、运维手册里改称呼。
- 自建索引生成器补三条排除：
  1. 版本对象的 `private: true` 或 `publishConfig.access: "restricted"` → 不输出；
  2. 标签（dist-tag）指向的版本若为 private/未发布 → 不输出，也不要用它算 `defaultVersion`；
  3. 仓库默认分支的**未发版**提交包 → 不输出（只输出显式 tag/commit 版本）。
- 索引只写你愿意让别人安装的版本；索引没有签名，装什么由 manifest 决定（`MARKET-RM:127`）。

### 验证方式
- UI：插件页出现「插件索引 / 索引源 / 索引 URL」（`MKT-UI:1591-1600`）。
- 配置：`dsh --profile <p> --dump-config` 里该行仍是 `indexes: [...]`，没有 `markets`。
- 生成器：造一个 `private: true` 的版本 + 一个默认分支包，重新生成索引，`grep` 索引文件应无这两个版本号。

---

## 5. 安装失败诊断、更新第三方包与回滚

### 变更
- 结果里带**完整诊断与 Host 日志路径**：`PackageResult` 有 `logPath`、`kind`、`timedOut`、`incompatible`（`PM-T/../typert.host.js:1429`）；客户端把日志路径显示成一行 `installLogPath: { path }`（`PM-UI:6872-6874`），安装输出以 `plugin-manager/install-log` 流式转发（`PM-RM:68`）。
- 操作记录有**白名单化的 stage**（`PM-T/diagnostic.js:13`），Host/桌面壳只接受自己 run id 的记录（`PM-RM:134`）；这解释了为什么桌面端能看到「最近插件操作」。
- **区分「安装失败」与「安装后启用失败」**：包管理运行失败/取消、或组合包校验失败时，恢复 pnpm 运行前快照的 manifest 与 lockfile；「新出现或配置变化后的故障」，以及「显式启用目标未激活」，都会让操作失败但**包已装上**（`PM-RM:130`）。失败类型由 `classifyInstallFailure(facts)` 归类（`PM-T/install-failure.js:23-30`）。
- 新增第三方包**更新**：`listVersions(name)` 只对「自身包名、按注册表 spec 保存、声明 semver、且不承载插件管理」的已安装 bundle 标 `updatable`（`PM-RM:56`）；`updateBundle(name, version)` 先删后装、拒绝更旧版本、目标版本被 `engines.dsh`/DSH peer 拒绝时停在 `step:'check'` 且 profile 不变；无 HMR 时覆盖安装并报 `restart-required`（`PM-RM:58`）。
- **热更新失败回滚**：安装/更新失败会尝试恢复旧版本（`RELNOTES.md:15`、英文 `:155`），并把目标版本以**精确版本**重新写回（`PM-RM:172`）。

### 症状
- 更新按钮出现（本机 `ds-bot` 装了 0.1.7、市场提示 0.2.7），点更新后失败，版本回到旧的、`pnpm-lock.yaml` 被重写但依赖没变。
- 失败弹出的诊断是空白的（旧版），新版才把 pnpm 的 `logPath` 与 stage 显示出来。
- 更新成功后界面提示需要重启（`restart-required`），但插件行看起来"已启用"——这是**启用失败**与**安装失败**混在一起看的典型误判。
- 需要新构建脚本批准的版本会**更新失败并回滚**；必须先移除包、用普通安装批准脚本再装（`PM-RM:175`）。

### 迁移动作
1. 更新前记下当前版本：`node -p "require('<profile>/node_modules/<pkg>/package.json').version"`。
2. 更新失败时按 stage 分流：
   - `check` 阶段失败 = 版本被兼容门拒绝（去看 `incompatible`，别急着豁免）；
   - pnpm 阶段失败 = 读 `logPath`（客户端那行）与 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`；
   - 装完但未激活 = 启用失败，查 patch 层与 bundle 选择，不要重装。
3. 需要 `allowBuilds` 的包：先在插件页移除，走普通安装批准构建脚本，再更新（`PM-RM:175`）。
4. 更新会以**精确版本**保存（原来是 `^0.5.8` 会变成 `0.5.9`），需要 range 的话更新后手工改回并 `pnpm install`（`PM-RM:172`）。

### 验证方式
- 更新后 `node -p` 版本变了，且 `pnpm-lock.yaml` 里该包为精确版本。
- 失败演练：故意指定一个不存在的版本，`step` 应停在 `check`、profile 的 `package.json` 与 `pnpm-lock.yaml` 与更新前逐字节一致（快照恢复）。
- 桌面端：`%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations` 有对应记录，`logs` 下有同时间段报告。

---

## 复核清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 兼容门 | `dsh --profile <p> --dump-config 2>&1 \| Select-String skipping` | 只剩真越界/pin 的包 |
| 豁免 | `dsh plugin --profile <p> version-exemptions` | 与 `compatibility.json` 一致 |
| semver | 上文 node 片段 | `true ^0.2.1-rc.5`、`false 0.2.1-rc.5` |
| 导入 | `import('@deepseek-ai/dsh-official-bundles')` | 键集合同 `OB:228` |
| 索引 | `--dump-config` | 字段是 `indexes` |
| 失败诊断 | 触发一次失败安装 | 有 stage + logPath |

**推断项（需复核）**
1. 「索引生成器排除 private」的落点：本文件只引 `RELNOTES.md:138`，生成器不在 0.2.2 asar 内（清单核对无生成器入口）。复核：在仓库执行 `pnpm gen-…`（生成器名见 `OB:143` 注释里的 `gen-official-bundle-catalog`），对一份含 private 版本的源跑一遍，检查输出。
2. 桌面 profile 是否能直接用 `dsh.cmd --profile desktop …`：本机 CLI 版本信息可读（`--version` → `0.2.1-rc.5`），但应用声明该 profile 由 Electron 独占（本机取证记录）。复核：升级后对 desktop 跑一次 `--dump-config`，若被拒绝就走 GUI。
3. `purpose`/`stage` 的枚举全集：`diagnostic.js:13` 只给出 `stage` 是 enum，未在本文展开全部取值。复核：读该文件同一 region 的 enum 列表。
