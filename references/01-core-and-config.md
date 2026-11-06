# 01 · Cordis 核心与配置层（Core / Fiber / Node / cordis.patch.yml / 设置页图标）

> **影响谁 / 什么时候会踩到**：任何把 profile 从 `0.2.1-rc.5` 升到 `0.2.2-rc.1` 的人，在 **升级重启之后** 就会踩到 4 号（`cordis.patch.yml` 丢失或不再生效）和 3 号（CLI 跑在旧 Node 上）；
> 只有 **自己写过 Cordis 插件** 的人才会踩到 1、2、5 号（`EntryTree` 少实现 `commit`、`fiber` 私有字段失效、设置页图标不显示）。
> 纯 GUI 使用者不做任何事，配置层风险依然存在——它不由你触发，由升级和"保存一次设置"触发。

## 证据路径约定

本文所有 `证据：` 都指 asar 内的真实文件，行号即该文件行号。两份提取目录（只读使用）：

- 0.2.2-rc.1：`.update-investigation/work/x022a/dsh/node_modules/@deepseek-ai/<pkg>/...`
- 0.2.1-rc.5：`.update-investigation/work/x022a/old021/dsh/node_modules/@deepseek-ai/<pkg>/...`

在 `app.asar` 里对应路径去掉 `x022a/` 前缀。重建提取（复现用）：

```powershell
node .update-investigation\asar-read.mjs ".update-investigation\work\asar022\app.asar" ".update-investigation\work\x022a" `
  "dsh/node_modules/@deepseek-ai/cordis/" "dsh/node_modules/@deepseek-ai/cordis-plugin-loader/" `
  "dsh/node_modules/@deepseek-ai/cordis-plugin-include/" "dsh/node_modules/@deepseek-ai/dsh-app-boot/" `
  "dsh/node_modules/@deepseek-ai/dsh-base/" "dsh/node_modules/@deepseek-ai/dsh/package.json"
```

---

## 1. Cordis Core 4.1.0 / Loader 1.1.0 / Include 1.1.0：条目变更与持久化统一

**变更**
- 版本实测：`cordis 4.0.5 → 4.1.0`、`cordis-plugin-loader 1.0.6 → 1.1.0`、`cordis-plugin-include 1.0.10 → 1.1.0`
  （证据：0.2.2 `dsh/package.json:6-10`；0.2.1 同名文件的 `@deepseek-ai/cordis` 等条目）。
- Loader 1.1.0 把"条目变更"变成显式契约：新增 `EntryChange` 接口与 **抽象方法** `EntryTree.commit(change)`。
  0.2.1 的 `EntryTree` 只有 `abstract class EntryTree`，**没有** `commit`。
  （证据：0.2.2 `cordis-plugin-loader/src/config/tree.ts:22` 与 `:204`；0.2.1 同文件 `:7` 起无此成员。）
- 变更语义写入注释：`options` 缺失=删除、`legacy` 缺失=新建、两者都在=更新/移动；**只有** `EntryTree` 的变更方法和显式 Fiber 保存会上报，文件驱动的 `EntryGroup` 对账不上报。
  （证据：`cordis-plugin-loader/src/config/tree.ts:8-28`。）
- Include 1.1.0 重写了写回路径：整份文件在内存里 patch → `routeJournal` 把改动路由给"文件拥有"或"patch 拥有"的键 → 临时文件 + rename 原子落盘。
  （证据：`cordis-plugin-include/src/index.ts:311-361`、`:369`；`src/patch.ts:191-261`。）

**症状**
- 自写 `class MyTree extends EntryTree` 的插件：编译期报未实现抽象成员；运行期 `tree.commit is not a function`，**不报错地** 丢掉运行时改动（设置改了、重启回退），因为没人接变更。
- 直接写配置文件的插件：与 1.1.0 的 journal/drain 抢写，出现 `config conflict ...; file wins` 或 `StaleWriteError` 重试。
- 把 config 文件写成非顶层数组（对象、或 `null`/截断）：启动直接失败 `config file must be a top-level array`，而不是回退默认值。
  （证据：`cordis-plugin-include/src/index.ts:265-267`。）

**迁移动作**
```js
// before（0.2.1，能跑但没人持久化）
class MyTree extends EntryTree { /* 只实现自己的逻辑 */ }

// after（0.2.2，必须接住变更；不要自己写文件）
class MyTree extends EntryTree {
  commit(change) {            // change: { id, group, from?, options?, legacy? }
    // 全量落盘：把 this.root.data 序列化后原子替换
  }
}
```
- 更省事：不要再继承 `EntryTree`，而是增加一条 `@deepseek-ai/cordis-plugin-include` 行，让它替你做 journal + 原子写。
- 配置文件的顶层必须是数组；YAML 用 `[]` 而不是 `{}`。

**验证方式**
```powershell
# 1) 版本
node -e "const p=require('./.update-investigation/work/x022a/dsh/package.json');console.log(p.dependencies['@deepseek-ai/cordis'],p.dependencies['@deepseek-ai/cordis-plugin-loader'],p.dependencies['@deepseek-ai/cordis-plugin-include'])"
# 2) 你的插件是否还在实现旧的 EntryTree
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\*\lib\*.js" -Pattern "extends EntryTree|extends Include" | Select-Object Path,LineNumber
# 3) 启动后无 include 报错（非 desktop profile 才可用 --profile）
dsh --profile web --dump-config | Select-String "config file|commit"
```

---

## 2. Cordis Fiber：原始配置 / 候选解析 / 生效配置同源

**变更**
- 4.1.0 把三件事变成公开 API（0.2.1 只有一个私有 `_resolveConfig`）：
  | 读取 | 0.2.2 | 0.2.1 |
  |---|---|---|
  | 原始输入（未解析、未校验） | `fiber.rawConfig` getter / setter | 无（只有 `fiber.config` 字段） |
  | 候选解析（跑 `internal/config` waterfall + schema 校验，**不发布**） | `fiber.resolveConfig(candidate)` | 私有 `_resolveConfig`（`:641`） |
  | 生效配置（真的传进 `apply()` 的那份） | `fiber.effectiveConfig` | 无 |
  证据：0.2.2 `cordis/src/fiber.ts:649`、`:664`、`:676`、`:783`；0.2.1 同文件 `:641`、`:736`。
- 程序化更新走同一条瀑布：`fiber.update(config)` → 解析 → 发出 **新增事件** `internal/commit(fiber, originalConfig)` → 可被 `internal/update` 拦截（`next()` 可选，不调用就保留当前实例）。
  （证据：`cordis/src/fiber.ts:783-819`；`cordis/src/events.ts:342-355`；0.2.1 无 `internal/commit`。）

**症状**
- 插件里 `fiber._resolveConfig(...)` 或读 `fiber.config` 当作"生效值"：4.1.0 下拿到的是**原始输入**（表达式未求值、`!!js` 未展开），于是出现"设置页显示 A、插件按 B 跑"。
- 插件自己 `emit('internal/commit')` 或自己写 entry：被 Loader 的监听器写第二遍，出现重复条目/重复落盘。
- 只 `fiber.config = x`（直接赋值）而不 `update()`：不触发重载，界面与运行态分叉。

**迁移动作**
```js
// before
const cfg = this.ctx.fiber.config            // 原始输入，可能含 !!js 表达式
const resolved = this.ctx.fiber._resolveConfig(next)

// after
const live = this.ctx.fiber.effectiveConfig   // 真正生效的那份
const preview = this.ctx.fiber.resolveConfig(next)  // 只想校验/预览候选，不发布
await this.ctx.fiber.update(next)             // 想让它生效并持久化（noSave=true 可只生效不落盘）
```
- 需要"设置编辑"和"热更新"一致：两者都交给 `fiber.update()`，不要各写一套。

**验证方式**
```powershell
# 你的插件是否还在用私有/裸配置
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\*\lib\*.js" -Pattern "_resolveConfig|fiber\.config\s*=" | Select-Object Path,LineNumber
# 端到端：改一项设置 → 不重启生效 → 重启后仍在（说明 commit 链路通）
```

---

## 3. 最低 Node.js 24.9

**变更**
- `@deepseek-ai/dsh@0.2.2-rc.1` 首次声明 `engines.node = ">=24.9.0"`；0.2.1 的同一个文件**没有** `engines` 字段。
  （证据：0.2.2 `dsh/package.json:178-180`；0.2.1 对应文件无该键。）
- 桌面端自带的运行时本来就是 24.21.0，**两个版本都是**，所以桌面 App 不受这条影响。
  （证据：两份 `dsh/desktop-runtime.json` 的 `release`：`{"version":"0.2.2-rc.1",...,"nodeVersion":"24.21.0"}` / `{"version":"0.2.1-rc.5",...,"nodeVersion":"24.21.0"}`。）

**症状**
- 桌面 App：无变化（仍是内置 24.21.0）。
- 自部署 / CLI / SDK / CI：Node 22.x 或 24.0–24.8 上，安装期只有 pnpm/npm 的 engine 警告（`engines.node` 不满足默认不阻断），**运行期**才炸。具体崩法取决于触发的内置能力（推断：无 version gate，失败表现为启动期 `TypeError`/`SyntaxError` 而非友好提示——DSH 的兼容门禁只校验插件 `engines.dsh` 与 peer，不校验 `engines.node`，证据：`dsh-app-boot/lib/index.js:1094-1127`）。
- 插件自己的 `engines.node`（如 `^22.19.0 || >=24`）不会救你，它也不被 DSH 强制。

**迁移动作**
- 先升运行时再升 DSH：`node -v` ≥ `v24.9.0`；nvm/fnm 切版本，或改用 DSH 安装目录下自带 runtime 的 `node.exe`。
- 插件仓库同步把 `engines.node` 抬到 `>=24.9.0`，CI matrix 去掉 <24.9 的格子。

**验证方式**
```powershell
node -p "process.versions.node"                       # 期望 >= 24.9.0
node -p "require('./.update-investigation/work/x022a/dsh/node_modules/@deepseek-ai/dsh/package.json').engines.node"
& "C:\Users\Catherine\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version
```

---

## 4. `cordis.patch.yml`：谁在覆盖你的配置层，以及备份/恢复

**变更**（这不是官方"条目"，而是 2026-11-01 本机真实事故的机制复盘；四条机制全部有代码证据）

1. **文件缺失 → 写入模板。** profile 初始化写 `cordis.patch.yml` 的条件是"文件不存在"，模板正文逐字为：
   ```yaml
   # Your patch layer for this dsh profile, applied after every bundle layer:
   # a top-level YAML array of loader patch entries (id-targeted config
   # overrides, disables, and insert lists; `!!js` expressions allowed).
   []
   ```
   证据：`dsh-app-boot/lib/index.js:1368-1372`（模板）、`:1386`（`initProfile`）、`:1398-1399`（`if (!existsSync(patchPath)) writeFileSync(...)`）；0.2.1 同一逻辑在 `:593/:611/:624`。
   **注意**：代码只在**不存在**时写，已存在的文件不会被 init 覆盖——所以事故现场长成"模板 + `[]`"，说明当时命中的是"文件不在"这条路径（哪一步让它不在：推断，可能是升级/首次启动改写了 profile 目录或路径）。
   `loadProfile` 也只在 `existsSync` 时才加载用户层（`:1823`），因此"文件不在"与"文件为空数组"表现一致：**你的设置静默失效，没有报错**。
2. **保存设置 → 整份文件被重写。** Settings 的改动通过"当前 profile 的 Cordis patch"持久化（证据：`dsh-settings/README.zh.md:12`），落盘是 `js-yaml dump` 整份数组 + 临时文件 + rename（证据：`cordis-plugin-include/src/index.ts:338`、`:369`）。
   后果：**注释、空行、字段顺序、手写排版全部丢**；`!!js` 表达式仍在（自定义 YAML type，`:16-25`），但你的注释没了。
3. **patch 拥有的键会被写回 patch 层。** `routeJournal`/`PatchIndex` 判断某个键归文件还是归某条 patch，归 patch 的改动写回 `config.patches` 再 `fiber.update()` 持久化；若无 entry 承接则只警告 `patches ... changed at runtime but cannot be persisted`（证据：`src/patch.ts:174-183`、`:247-257`；`src/index.ts:313-329`）。
4. **写坏 = 启动失败，不是清空。** 非顶层数组/截断文件抛 `ConfigFileError`（stage `validate`），不会回退（`:263-267`）；读不到文件时才回退 `initial` 模板（`:143-153`）。

**迁移动作（升级前后各做一次）**
```powershell
$P="$env:USERPROFILE\.dsh\profiles\desktop"; $B="$env:USERPROFILE\.dsh\profiles\desktop.bak-$(Get-Date -Format yyyyMMdd-HHmm)"
New-Item -ItemType Directory $B | Out-Null
Copy-Item "$P\cordis.patch.yml","$P\package.json","$P\cordis.yml","$P\pnpm-lock.yaml" $B
Get-FileHash "$P\cordis.patch.yml" | Select-Object Hash   # 记下来，升级后对比
```
- 恢复：`Copy-Item "$B\cordis.patch.yml" $P\cordis.patch.yml -Force` 后重启；**不要**在 DSH 运行时改这个文件再靠热更新——它会被 journal 合并，冲突时"文件赢"（`:295-300`）。
- 不想动用户层时用一次性 overlay 试运行：`dsh --profile <name> --patch .\try.yml --dump-config`（`--patch` 可重复，证据：`dsh/lib/bin.js:27-28`、`:105`）。
- 整个 profile 坏到起不来：`dsh rescue --from-default-profile web` 用出厂模板重建（会替换，先备份！证据：`dsh/lib/bin.js:42-43`）。

**验证方式**
```powershell
# 你的 patch 层到底有没有被应用：两者差异应当就是你的 12 条设置
dsh --profile web --dump-config        | Select-String "settings|mcp|你的条目 id"
dsh --profile web --dump-default-config | Select-String "settings|mcp|你的条目 id"
# 设置能活过重启
Copy-Item $P\cordis.patch.yml "$B\after-boot.yml"; # 改一项设置、重启，再比 hash 与内容
```

---

## 5. 插件设置页导航图标（可选新能力）

**变更**
- 设置外壳把导航图标也做成 slot：`ctx.slots.inject('settings.section.icon', ...)`，用**与 `settings.section` 贡献相同的 `id`** 注册图标组件；组件收到 `size`（px）与 `active`；外壳负责按钮/标签/装饰容器；没有匹配注册时渲染默认图标，**释放贡献即恢复默认**。
  （证据：`dsh-client-ui-settings/README.zh.md:47`。）
- 图标不是 manifest 里的 `icon`：那是插件**展示元信息**（会话列表/插件页用，读 `package.json` 的 `icon` 或 `<pkg>/icon`，证据：`dsh-app-boot/README.zh.md:89`）。两者别混。

**症状**
- 注册了但 `id` 对不上：**静默不渲染**，没有报错、没有占位（README 明确"不匹配的 id 不会渲染"）。
- 顺手传 `label`：不显示，外壳自己生成标签。
- 组件卸载没走 `ctx.effect`/disposer：图标残留或闪烁。

**迁移动作**
```js
// 一个自带设置页的插件，同时给它一个导航图标
ctx.slots.inject('settings.section', { id: 'my-plugin', /* ... */ })
ctx.effect(() => ctx.slots.inject('settings.section.icon', {
  id: 'my-plugin',                       // 必须与上面的 id 完全一致
  render: ({ size, active }) => <Icon size={size} muted={!active} />,
}))
```
- 图标是**可选**能力：不写就继续用默认图标，不算破坏性变更；升级时无需为它改任何东西。

**验证方式**
```powershell
# 该 slot 类型存在于当前客户端
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-client-ui-settings\lib\client.js" -Pattern "settings.section.icon"
# 运行时：打开 设置 → 你的页面，看导航左侧图标；停用插件后应回到默认图标
```

---

## 6. 速查

| # | 一行判断 | 你要动的东西 |
|---|---|---|
| 1 | 只有自写 `EntryTree` 子类才需要改 | 实现 `commit(change)`，或改用 Include 一行 |
| 2 | 只有读 `fiber.config`/`_resolveConfig` 的插件才需要改 | 换 `effectiveConfig` / `resolveConfig()` / `update()` |
| 3 | 桌面端不用管；CLI/CI 先升 Node | `node -v` ≥ 24.9 |
| 4 | **所有人都要备份**，升级后必比对 | `cordis.patch.yml` → 备份目录 + `--dump-config` 对比 |
| 5 | 纯可选新增 | `settings.section.icon` 同 id 注册 |

> 复核建议：4 号里"2026-11-01 那次具体是文件被移到别处、还是被别的进程删掉"，代码只能证明"缺失即重建模板"这条通路，触发源需要当次升级日志才能定性（推断）。
