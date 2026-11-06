# DSH 0.2.2-rc.1 官方发布说明节选（开发者向「其他变更」段）

> 原文来自官方 GitHub release dsh-v0.2.2-rc.1（2026-11-04）。版权归 DeepSeek。
> 完整中英文说明请见官方 release 页。本文件仅为离线取证摘录，行号与原文不对应。

### 其他变更

- 同步 Cordis Core 至 4.1.0、Loader 至 1.1.0、Include 至 1.1.0，统一配置访问、条目变更和持久化行为。 @shigma, @imccyu
- Cordis Fiber 提供统一的原始配置、候选配置解析和生效配置访问，设置编辑与热更新使用一致的配置来源。 @shigma
- DSH 的最低 Node.js 版本提高至 24.9；使用旧版 Node.js 的用户需先升级运行时。 @tianyicui
- 升级 pi-ai 至 1.3.0，并同步模型目录、端点与推理回放规则；完整工具参数格式错误会在执行任何工具前终止该次响应。 @tianyicui
- 未声明容量的自定义模型默认上下文与最大输出调整为十进制 1M/128K；较小端点应显式覆盖容量以避免延迟压缩。 @LegGasai
- Agent 在提示词组装与 pre-step 前固定本步模型，重试保留同一选择；插件应通过 agent.model 选择模型，agent/request 不再允许改路由。 @kermanx
- pi-ai 支持插件按会话和请求用途提供动态请求头；无效请求头在请求发出前报错。 @LegGasai
- TypeScript 与 Python SDK 补齐与 Web 模式一致的文件交付、问答与回调、调度、技能和上下文能力，并支持原生命令、插件管理、计划审阅、目标续跑及操作审批；插件变更需重启 SDK 生效。 @koalazf99, @LogosVeritas
- 「自动化任务」改为统一的宿主级管理，支持手动创建、直接编辑和通过预填提示在会话中创建，保留编辑草稿并支持冲突复核，可选择复用或新建会话执行任务。 @ZiyaZhang, @Magolor
- 「Git 工作树」入口已合入「变更请求与工作树」，此前启用独立插件的用户需手动从 profile 的 dsh.profile.bundles 中移除 @deepseek-ai/dsh-experimental-tool-worktree。 @LegGasai
- Ralph 循环与会话搜索不再显示在实验性列表。 @ZiyaZhang
- 新增默认关闭的 `apply_patch` 工具，一次完成多文件新增、编辑、删除和移动，并在 Review 中查看变更。 @sjw1231, @CreatixChu
- 文件修改的先读和外部修改防护默认关闭，沙箱限制和 Review 保持不变；需要原防护的 profile 可显式恢复观察策略。 @sjw1231
- 工具可按步骤条件启用，模型声明、PTC 绑定与执行准入保持一致；插件需迁移 tools.resolve/executable 与提示词组装接口。 @LegGasai
- Node PTC 新增 VM Script 模式，支持顶层 await、动态导入和表达式结果，可独立开启跨调用状态保留；默认仍逐次执行，脚本顶层不支持 return 或 using。 @kermanx
- 原生与 PTC 工具执行拆为按 Agent 作用域选择的插件；PTC 通过配置 overlay 启用，旧 tools.mode 与 DSH_TOOLS_MODE 需迁移。 @kermanx
- PTC Node 控制通道改用 birpc；自部署 bootstrap 与 SSH helper 必须同步升级，SSH 协议从 2 升为 3。 @kermanx
- PTC Mode 中由调用方取消的 run_code 改为返回 ABORTED，而非 CODE_RUN_FAILED；SDK 和 Session 消费方需更新取消分类。 @kermanx
- Web Fetch 不再拒绝非公网地址，可用于代理与内网，部署应自行限制网络访问。 @turtle2099
- Headless 支持实验性 Auto 自动审核。 @tianyicui
- 桌面启动故障可获取诊断报告，并附上有界的近期插件操作记录，便于排查问题。 @winewill
- Session API 新增独立接口，可分别读取快照和持续订阅会话事件日志、运行状态以及事件投影数据。 @imccyu
- 修复会话创建、恢复和销毁期间的事件发布与清理顺序；初始化事件可实时订阅，取消时等待已取得资源完成清理。 @kermanx
- Session Projection 注册 API 调整为异步，需要插件启动时持有。 @kermanx, @Magolor
- 整单元 JSON 与 SQLite 存储支持读取领域明确声明的兼容旧版本，并以新版本格式写入。 @Magolor
- 「自定义插件市场」更名为「自定义插件索引」，发现页读取用户添加的索引文件，索引生成器排除标记为 private 的版本、标签与默认分支包。 @turtle2099, @turtle1999
- 官方组合包列表改由 @deepseek-ai/dsh-official-bundles 导出；自定义集成需更新原 app-boot 的相关导入。 @turtle2099
- 插件可为自己的设置页面提供导航图标，卸载后恢复默认图标。 @Magolor
- 插件安装失败时显示完整诊断与 Host 日志入口，并区分安装失败和安装后启用失败。 @kermanx
