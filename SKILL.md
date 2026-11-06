---
name: dsh-breaking-upgrade
description: Use when upgrading DeepSeek Harness (DSH) across a breaking release (0.2.1 → 0.2.2 and later), when a DSH plugin or bundle was skipped/failed to load after an update, or when porting a plugin to the 0.2.2 APIs (Cordis 4.1, tools.resolve/executable, async session projections, PTC overlays, agent.model routing, official-bundles exports, prerelease compatibility gate).
---

# DSH 0.2.2 breaking-change upgrade

This skill turns the official `0.2.2-rc.1` developer-facing changes into a checked migration:
pre-flight scan → profile repair → install → post-install verification → rollback.

It is written for **operators upgrading a profile** and **plugin authors porting code**.
Every claim marked `证据:` was read out of the shipped 0.2.2-rc.1 `app.asar` or its
release notes; anything else is marked `推断` and must be verified locally.

## 0. Hard rules

1. **Back up the profile before touching it** — `package.json`, `cordis.patch.yml`,
   `pnpm-lock.yaml`, `cordis.yml`. A previous DSH update clobbered a user
   `cordis.patch.yml` to a template; never assume it survives.
2. **Never edit the profile while the desktop app is mid-update.** Close the app
   (and its leftover Host processes) before running the installer.
3. **The compatibility gate is not a crash guard.** An incompatible bundle is
   *skipped silently at load*; the GUI still opens. Verify with `--dump-config`,
   not by "it feels fine".
4. **Prereleases participate in ranges in 0.2.2.** `semver.satisfies(..., {includePrerelease:true})`.
   Do not reason with npm's default prerelease rule here.
5. **Official wins.** When the new release ships a surface you already get from a
   community plugin, remove the community one; two owners of one route fight.

## 1. Pre-flight scan (do this first)

```bash
node scripts/check-profile-compat.mjs --profile "<profile dir>" --target 0.2.2-rc.1
```

Read the output as four buckets:

| marker | meaning | action |
| --- | --- | --- |
| `SKIP` | a declared gate is unsatisfied by the target | update that package, or pin a compatible version, or accept the skip |
| `RET` | the installation retires this bundle | delete it from `dsh.profile.bundles` |
| `APP` | shipped by the installation, not in `node_modules` | nothing to do |
| `--` | declares no gate | it loads, but nothing guarantees it works — smoke-test it |

Exit code `2` means at least one bundle will be skipped. That is the number to
drive to zero (or to an explicit, written decision).

Known removal for this release: **`@deepseek-ai/dsh-experimental-tool-worktree`**
must be removed from `dsh.profile.bundles` by hand — the Git worktree entry was
merged into "Change requests and worktrees" (`证据:` official release notes,
其他变更).

## 2. Triage the change class

Start from the full list, then open the deep-dive that matches:

| change class | deep-dive |
| --- | --- |
| Cordis 4.1 / Loader 1.1 / Include 1.1、Fiber 配置、Node 24.9、`cordis.patch.yml` | `references/01-core-and-config.md` |
| 工具条件启用、`tools.resolve`/`executable`、执行器拆分、`apply_patch`、观察策略、pi-ai 1.3 | `references/02-tools-and-prompt.md` |
| PTC：VM Script、birpc、SSH 协议 3、`ABORTED`、`tools.mode` 迁移 | `references/03-ptc-runtime.md` |
| Session API 拆分、Projection 异步、事件顺序、存储格式 | `references/04-session-and-storage.md` |
| `agent.model` 路由、动态请求头、模型容量默认值、Web Fetch 放行 | `references/05-agent-routing-and-llm.md` |
| 兼容门语义、预发布 semver、`official-bundles`、插件索引/安装诊断 | `references/06-plugin-manifest-and-gate.md` |
| 桌面更新、worktree 合并、Ralph/搜索分类、更新安装排障 | `references/07-desktop-update-and-profile.md` |
| **全部 30 项总表**（变更→症状→迁移→验证） | `references/breaking-changes.md` |
| 插件作者 before/after 配方 | `references/plugin-api-migration.md` |
| 安装/修复/回滚命令 | `references/upgrade-runbook.md` |

## 3. Repair decision table

| symptom after upgrade | likely cause | fix |
| --- | --- | --- |
| GUI opens, a plugin's UI is gone | bundle skipped by the gate | run the scanner; bump that package to a version whose gate accepts the runtime |
| `--dump-config` prints `incompatible with dsh ...` | gate mismatch | update the plugin, or grant the exact-version exemption **only** when you accept crash/data-loss risk |
| plugin loads but its tools are missing | `tools.resolve`/`executable` not migrated | port to the 0.2.2 tool registration contract |
| projection data is empty / late | registration not awaited | `await` the registration and hold its handle for the fiber lifetime |
| model ignores the plugin's routing | `agent/request` can no longer re-route | choose the model through `agent.model` before prompt assembly / pre-step |
| update install hangs on 0.2.1 | lingering Host handles (fixed *in* 0.2.2) | close DSH + leftover Host processes, then run the installer directly |

## 4. Post-install verification (non-negotiable)

```bash
# 1. version actually changed
"<install dir>/resources/runtime/cli/bin/dsh.cmd" --version

# 2. no skipped bundles
"<install dir>/resources/runtime/cli/bin/dsh.cmd" --profile <name> --dump-default-config 2>&1 | grep -i incompatible

# 3. gates re-evaluated against the new runtime
node scripts/check-profile-compat.mjs --profile "<profile dir>" --target <new version>

# 4. smoke-test the tools the profile depends on (one call each)
#    fs read/write, shell, PTC run_code, task/board, subagent, MCP
```

A passing `--version` alone proves nothing about plugins.

## 5. Rollback

The installer keeps the old app only until it is replaced; the profile is the part
you can always restore:

```powershell
Copy-Item "<backup>/package.json"       "$env:USERPROFILE/.dsh/profiles/<name>/package.json" -Force
Copy-Item "<backup>/cordis.patch.yml"  "$env:USERPROFILE/.dsh/profiles/<name>/cordis.patch.yml" -Force
Copy-Item "<backup>/pnpm-lock.yaml"    "$env:USERPROFILE/.dsh/profiles/<name>/pnpm-lock.yaml" -Force
```

Then reinstall the previous desktop version if the runtime itself is broken.

## 6. Anti-patterns

- Editing `node_modules` by hand instead of changing `package.json` + install.
- Adding a `requirements` range that the runtime is *equal* to but fails the gate
  (`engines.dsh` decides alone; it is not merged with peers).
- Replacing a community plugin with an official one without removing the old
  bundle: duplicate settings routes, duplicated menu entries, and shadowed storage.
- Trusting a "0.2.2" tag on npm: an npm version string is not a compatibility
  claim — read its `dsh.engines.dsh` / `peerDependencies`.

## 7. References

- `references/breaking-changes.md` — all 30 developer-facing changes, 变更→症状→迁移→验证.
- `references/01-core-and-config.md` … `07-desktop-update-and-profile.md` — 按主题的深挖版，
  含 0.2.1 vs 0.2.2 源码对照与文件行号。
- `references/plugin-api-migration.md` — before/after API recipes with evidence paths.
- `references/upgrade-runbook.md` — Windows install/repair/rollback runbook.
- `data/official-bundles-0-2-2-rc-1.json` — official bundle lists extracted from `@deepseek-ai/dsh-official-bundles@0.2.2-rc.1`.
- `data/duplicates.json` — community plugin ↔ official surface map.
- `scripts/check-profile-compat.mjs` — the pre-flight scanner used above.
