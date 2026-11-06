# DSH 0.2.2 破局升级包 · dsh-022-migration-kit

把 DeepSeek Harness **0.2.2-rc.1** 的全部 30 项开发者向破坏性变更，变成一份能直接执行的迁移清单，
外加一个**能跑**的 profile 兼容预检脚本。

> 不是复述 release notes。这里每一条都落到「谁会被影响 → 会看到什么症状 → 怎么改 → 用什么命令验证」，
> 并且脚本的判定逻辑是对着 0.2.2 装出来的 `app.asar` 源码逐行复刻的。

## 为什么需要它

0.2.2 的插件兼容门是这样的（证据：`@deepseek-ai/dsh-app-boot/lib/index.js:1094-1117`）：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

两个后果直接决定升级成败：

1. **预发布版参与区间匹配**。`>=0.2.1-rc.3` 是满足 `0.2.2-rc.1` 的 —— 用 npm 默认规则判断会得出**相反**结论。
2. **不满足就被静默跳过**。GUI 照常打开，插件不见了，但不会崩、不会红。没有预检，你只能靠"感觉少了什么"。

再加上 `engines.dsh` 单独决定、peer 里只有 `@deepseek-ai/dsh*` 参与判定、旧版 Host 残留句柄会阻塞更新安装……
这就是需要一份 runbook 的原因。

## 包含什么

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | 技能入口：硬规则、预检 → 分类 → 修复 → 验证 → 回滚的决策树 |
| `references/breaking-changes.md` | **全部 30 项**变更，按运行时/工具 PTC/会话/模型/插件生态/桌面分组 |
| `references/plugin-api-migration.md` | 插件作者用：工具注册、投影异步化、模型路由、请求头、清单门禁的 before/after |
| `references/upgrade-runbook.md` | Windows 升级 runbook：校验 → 备份 → 预检 → 关进程 → 静默安装 → 验证 → 回滚 |
| `scripts/check-profile-compat.mjs` | 零依赖预检脚本：算出升级后哪些 bundle 会被 skip、哪些退役、哪些和官方重复 |
| `data/official-bundles-0-2-2-rc-1.json` | 从 `@deepseek-ai/dsh-official-bundles@0.2.2-rc.1` 抽出的官方组合包清单 |
| `data/duplicates.json` | 社区插件 ↔ 官方新功能的重复对照表（官方优先） |

## 60 秒上手

```bash
git clone <this repo> && cd dsh-022-migration-kit

# 1) 升级前：谁会掉？
node scripts/check-profile-compat.mjs --profile "$HOME/.dsh/profiles/desktop" --target 0.2.2-rc.1

# 2) 按 SKILL.md 处理 SKIP / RET / 重复项
# 3) 按 references/upgrade-runbook.md 安装并验证
```

Windows PowerShell：

```powershell
node scripts/check-profile-compat.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --target 0.2.2-rc.1
```

## 真实输出示例（本机 28 个 bundle）

```text
DSH profile compatibility check
  profile : C:\Users\...\.dsh\profiles\desktop
  target  : 0.2.2-rc.1
  bundles : 28

SKIP @deepseek-ai/dsh-subagent-claude-code   0.2.1-rc.5  peerDeps.@deepseek-ai/dsh-llm=0.2.1-rc.5 (fails 0.2.1-rc.5) | ...
SKIP @deepseek-ai/dsh-subagent-codex         0.2.1-rc.5  peerDeps.@deepseek-ai/dsh-subagent=0.2.1-rc.5 (fails 0.2.1-rc.5) | ...
OK   @linxin666/dsh-web-all                  0.4.13      1 gate(s) satisfied
OK   dsh-better-sidebar                      0.28.2      13 gate(s) satisfied
APP  @deepseek-ai/dsh-base                               shipped by the DSH installation

official functionality you also installed from the community:
  - @linxin666/dsh-client-ui-plugin-manager -> @deepseek-ai/dsh-client-ui-plugin-manager, ...  [remove]
  - @linxin666/dsh-client-ui-market         -> @deepseek-ai/dsh-client-ui-plugin-market, ...     [remove]

summary: 2 will be skipped, 0 retired, 8 duplicate(s)
```

它纠正了一个非常常见的误判：**大部分社区插件并不会被 skip**（`>=0.2.1-rc.x` 在
`includePrerelease` 下是满足的）；真正会掉的是那些**把官方包钉死成精确版本**
（如 `@deepseek-ai/* @0.2.1-rc.5`）的自己人。

## 十条结论（升级前必读）

1. **先跑预检**，别用"插件应该没问题"当结论；skip 是静默的。
2. **`@deepseek-ai/dsh-experimental-tool-worktree` 必须手动移除**（已并入「变更请求与工作树」）。
3. `engines.dsh` 与 peer **不合并**；写了 `engines.dsh` 就忽略 peer。
4. `@deepseek-ai/cordis`、`schemastery` 的 peer 不参与门禁，别拿它判断兼容性。
5. 精确钉死官方包版本的插件，升级后必掉；先用插件管理页更新（0.2.2 支持第三方包更新 + 失败回滚）。
6. Session Projection 注册**改异步**：必须 `await` 并持有 handle；`stateOf(session,key)` 已废弃。
7. 工具注册迁移到 `tools.resolve` / `executable`：声明、绑定、准入三处必须一致，否则 `UNKNOWN_TOOL`。
8. 模型路由只认 `agent.model`；`agent/request` 不再能改路由。
9. PTC：取消返回 `ABORTED`；控制通道改 birpc，自部署 bootstrap/SSH helper 必须同步升级（协议 2→3）。
10. 官方组合包清单从 app-boot 迁到 `@deepseek-ai/dsh-official-bundles`；`RETIRED_BUNDLES` 自动清理，
    但 worktree 不在其中，要手删。

## 适用范围与限制

- 实测对象：Windows 11 + DSH 桌面版 **0.2.1-rc.5 → 0.2.2-rc.1**（28 个 bundle，41 个包）。
- 证据来源：官方 release notes（`dsh-v0.2.2-rc.1`）+ 对 0.2.2 安装包 `app.asar` 的静态抽取。
  标 `推断` 的条目表示只来自 release notes，未在 0.2.2 源码中逐行确认，落地前请按文中命令复核。
- 本包**不是官方产物**，不保证覆盖未来 patch 版本；0.2.2 正式版发布后请以官方说明为准。
- 脚本只读 profile，不修改任何文件；它给结论，改不改、怎么改由你决定。

## 目录

```text
dsh-022-migration-kit/
├── SKILL.md
├── README.md
├── CHECKLIST.md
├── LICENSE
├── references/
│   ├── breaking-changes.md
│   ├── plugin-api-migration.md
│   └── upgrade-runbook.md
├── scripts/
│   └── check-profile-compat.mjs
└── data/
    ├── official-bundles-0-2-2-rc-1.json
    └── duplicates.json
```

## 许可

MIT。release notes 原文版权归 DeepSeek；本仓库只引用结论并标注出处。
