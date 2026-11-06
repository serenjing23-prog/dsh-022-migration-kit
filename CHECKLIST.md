# 升级检查清单（0.2.1-rc.5 → 0.2.2-rc.1）

打印/照着勾。任何一项没勾，不要宣称"升级完成"。

## 升级前

- [ ] 安装包 `sha512` 与 `update-info.json` 一致
- [ ] 安装包签名 `Valid`（DeepSeek 官方发布者）
- [ ] 备份 profile：`package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-lock.yaml`
- [ ] 备份 `~/.dsh/storages`（0.2.2 会重写存储格式）
- [ ] 跑 `check-profile-compat.mjs`，记录 `SKIP` 清单
- [ ] 决定每个 `SKIP` 的处理：升级 / 移除 / 接受跳过（写下来）
- [ ] 从 `dsh.profile.bundles` 移除 `@deepseek-ai/dsh-experimental-tool-worktree`
- [ ] 确认没有正在跑的会话（升级会结束它们）
- [ ] 记录当前版本：`dsh --version`

## 升级中

- [ ] 正常退出桌面应用
- [ ] 确认无 `DeepSeek Harness` 残留进程（0.2.1 Host 可能不退出，阻塞安装）
- [ ] 执行 `installer.exe --updated /S --force-run`
- [ ] 等待安装完成并拉起新版本（60-120 秒）
- [ ] 失败时：强杀残留进程后重跑，不要反复点击"自动更新"

## 升级后

- [ ] `dsh --version` = 新版本
- [ ] `--dump-config` 无 `incompatible` 输出
- [ ] 重跑 `check-profile-compat.mjs`，`SKIP` 数量符合预期
- [ ] 插件管理页里，每个想要的插件都是启用状态
- [ ] 用插件管理页更新第三方包（不要手改 lockfile）
- [ ] 对比 `cordis.patch.yml` 与备份，设置/MCP 注入块还在
- [ ] 冒烟：文件读写、shell、PTC `run_code`、子智能体、MCP、任务板
- [ ] 打开一个旧会话，历史完整
- [ ] 记录新版本下仍需处理的问题（插件作者未更新等）

## 回滚预案（升级前就要知道）

- [ ] profile 三件套可从备份恢复
- [ ] 存储目录可从备份恢复（回滚旧版本前必须先恢复）
- [ ] 旧安装包可获取（官方下载页/本地缓存）

## 给插件作者的额外检查

- [ ] 清单里的 `dsh.engines.dsh` 能匹配 `0.2.2-rc.1`（`includePrerelease` 语义）
- [ ] 没有把 `@deepseek-ai/cordis` 当兼容性判据
- [ ] `tools.resolve` / `executable` 三处条件一致
- [ ] 投影注册已 `await` 且持有 handle
- [ ] 模型选择走 `agent.model`，不在 `agent/request` 里改路由
- [ ] `run_code` 取消按 `ABORTED` 处理
- [ ] 自部署 bootstrap / SSH helper 已同步升级（协议 3）
