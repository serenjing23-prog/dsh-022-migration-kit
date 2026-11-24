# DSH 0.2.2-rc.5 → 0.2.3-alpha.2 升级记录

时间：2026-11-24
通道：nightly（`download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`）
结果：版本 `0.2.3-alpha.2`，安装器退出码 0，旧安装目录已清理

## 一、升级前做的三件事

1. **依赖树修复**：profile 的 `node_modules` 与 lockfile 不同步，4 个包在 deps/lockfile 里但没安装
   （`dsh-thesis`、`dsh-project-mcp`、`dsh-plugin-cas-kb`、`dsh-whale-boot-theme`）。
   根因是上一轮被中断的 `pnpm install`。`pnpm install` 已补回（8m50s）。
2. **精确版本包对齐**：`dsh-deepseek-chat-import`、`dsh-subagent-claude-code`、`dsh-subagent-codex`
   的 peerDependencies 是精确版本，必须等于宿主版本，否则启动门禁跳过。三者已到 `0.2.3-alpha.2`。
3. **兼容预检**：`check-profile-compat.mjs --target 0.2.3-alpha.2` → 35 个 bundle，skip 0 / retired 0。

## 二、升级中遇到的三个故障（都定位到根因）

### 1. 启动崩溃：配置文件被写入 UTF-8 BOM

```
DesktopHostFatalError: dsh: failed to parse patches C:\Users\Catherine\.dsh\cordis.patch.yml
YAMLParseError: Unexpected scalar at node end at line 1, column 4:
锘? insert:
```

`锘?` 是 BOM（EF BB BF）被当正文解析的典型乱码。DSH 解析 patch 层时直接 fatal，
桌面壳随后自行重写文件才恢复——表象就是「崩溃，然后自己好了」。

- 触发源：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM
- 检测：`scripts/check-bom.mjs`（扫 `~/.dsh` 全部 yml/yaml/json，`--fix` 剥离）
- 已接入安装脚本：**备份后**与**安装后**各跑一次，结果写进 `install-0.2.2.log`
- 当前状态：12 个配置文件，0 个带 BOM

### 2. 所有插件消失：`dsh.profile.bundles` 被重置成 2 项

升级完成后 `package.json` 的 bundles 只剩 `dsh-base` + `dsh-web-app`，依赖（25 个）仍在，
所以一个插件都不挂载。安装脚本在安装前自动备份了 profile（`dsh-backup-<时间戳>`），
从备份恢复 `package.json` 与 `cordis.patch.yml` 即可（35 bundles / 2353 字节的 patch）。

教训：**升级后先比对 bundles 数量**，不要假设它会被保留。

### 3. 桌宠 dsh-pet 加载失败（0.2.3 不兼容）

```
TypeError: ctx.connection.authenticatedUrl is not a function
```

0.2.3 移除了 `ctx.connection.authenticatedUrl`，而 dsh-pet 0.3.8 **与最新的 0.4.9 都在调用它**
（已扒 0.4.9 的 tarball 确认），所以升级版本救不了。

调用点只用于给桌宠窗口传 `DSH_PET_SITE_URL`（本机回环地址），兜底到 `origin` 语义等价：

```js
const siteUrl = (typeof ctx.connection.authenticatedUrl === "function")
  ? ctx.connection.authenticatedUrl(origin)
  : origin;
```

- 处理：`scripts/patch-dsh-pet.mjs`（幂等、先备份、只改 `ctx.connection.*` 调用，不碰包内同名方法）
- 注意：`pnpm install`、升级或重装 dsh-pet 会覆盖补丁，需重跑该脚本

## 三、与官方重复的社区插件（已停用 5 个）

| 社区包 | 官方对应 | 动作 |
|---|---|---|
| `@linxin666/dsh-client-ui-plugin-manager` | 官方插件管理器 / 清单页 | disabled |
| `@linxin666/dsh-client-ui-market` | 官方插件市场 / 索引 | disabled |
| `@linxin666/dsh-client-ui-community-plugins` | 同上（第三个索引入口） | disabled |
| `@linxin666/dsh-client-ui-preset-center` | 官方 agent preset | disabled |
| `@linxin666/dsh-client-ui-skill-explorer` | 官方 skill 页 | disabled |

保留观察：`@linxin666/dsh-update`（更新提示重复）、`@linxin666/dsh-i18n`（官方已内置多语言）、
`@linxin666/dsh-usage`（提供「今日消费」卡）。

## 四、连接器（腾讯 / 企业微信）

- 0.2.3 内置的是底座 `@deepseek-ai/dsh-client-ui-connector-account`：connector 插件注册账号后，
  **渲染在「插件」页**该插件的详情区（连接按钮、授权提示、状态标签），不在侧栏
- 安装包（351 个官方包）内**没有**腾讯/企业微信/飞书/钉钉的连接器；20 篇用户指南也无对应章节
- 可行路径：装第三方 connector 插件（市场搜索），或自建 MCP server 桥接其 API 后挂到「全局 MCP」

## 五、本次新增/修改的脚本

| 文件 | 作用 |
|---|---|
| `scripts/check-bom.mjs` | BOM 检测与修复（`--fix`），已接入安装脚本前后各一次 |
| `scripts/patch-dsh-pet.mjs` | 修补 dsh-pet 在 0.2.3 上的失效调用（幂等、带备份） |
| `scripts/pin-bundles.mjs` | 把精确版本 bundle 对齐到目标版本（无 BOM 写入 + 回读校验） |
| `scripts/fetch-installer.mjs` | 按 nightly feed 下载并校验 sha512 的安装包 |
| `scripts/install-0.2.2.ps1` | 新增 BOM 守卫；其余流程不变 |

## 六、回滚

- profile 备份：`%USERPROFILE%\dsh-backup-<时间戳>\`
- 安装包留档：`%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\`（rc.5 与 alpha.2 都在）
- 回退到 rc.5：把 rc.5 的 `update-info.json` 指向 rc.5 安装包，重跑 `install-0.2.2.ps1`
