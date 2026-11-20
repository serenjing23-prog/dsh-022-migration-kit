# DSH 0.2.2-rc.3 → 0.2.2-rc.5 升级交接单

执行时间：2026-11-20 11:19（计划任务 `DSH-0225-Update`，由 lead 安排）

## 已完成的准备

- 官方 nightly 通道最新 = **0.2.2-rc.5**（feed `nightly.yml`，releaseDate 2026-11-13）
- 安装包已下载并校验：`%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\deepseek-harness-0.2.2-rc.5-win-x64.exe`
  - sha512 与 feed 一致（脚本内再次校验），Authenticode 由脚本校验
- `update-info.json` 已指向 rc.5，旧 rc.3 安装包仍在同目录
- 兼容预检（`check-profile-compat.mjs --target 0.2.2-rc.5`）：34 个 bundle，
  **3 个会被跳过**、0 个 retired、8 个与官方重复
- profile 会在安装前自动备份到 `%USERPROFILE%\dsh-backup-<时间戳>\`

## 升级后必须补的 3 个包（都已有 0.2.2-rc.5）

| 包 | 当前 | 原因 |
|---|---|---|
| `@deepseek-ai/dsh-deepseek-chat-import` | 0.2.2-rc.3 | peerDeps 精确钉 rc.3 |
| `@deepseek-ai/dsh-subagent-claude-code` | 0.2.1-rc.5 | 早就被跳过（0.2.2 起一直没补） |
| `@deepseek-ai/dsh-subagent-codex` | 0.2.1-rc.5 | 同上 |

补法：插件页更新，或 `dsh plugin --profile desktop add <包>@0.2.2-rc.5`；改完需再重启一次。

## 侧边栏「会话消失」的结论（未修，待升级后处理）

不是数据问题，是**垂直空间被挤没**：

- 侧栏滚动区 `wtg9ga_scrollRegion` 高 442px
- 「全局面板」`wtg9ga_panelList` 已 8 项（插件/自媒体工作台/全局 MCP/歸藏设计/上下文洞察/任务看板/思维图/更多），占 274px
- 剩下的「工作区 + 会话树」只有约 160px，显示 3 个工作区后就被裁断，且该区域不滚动
- 底部还有「有更新」「今日消费」两张卡片进一步挤压

修法（升级后做）：鼠标悬停各面板行 → 点行尾的「从侧边栏取消固定」，保留 2-3 个常用项；工作区/会话树即可恢复完整高度。
若卸载后仍不够，再停 `dsh-newbe-my-favorites`（收藏夹桥接，占新建会话行右侧）。

## 已知未处理

- `@linxin666/dsh-web-all` 里 8 个与官方重复的包（plugin-manager / market / community-plugins / preset-center / skill-explorer / i18n / update / usage）——
  上次报告建议移除，属「双入口抢槽位」，本次未动，等侧栏稳定后再评估。
