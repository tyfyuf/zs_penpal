# Penpal 全项目审计问题汇总

Final triage report: 2026-09-04

Audit work is stopped. This document only deduplicates and prioritizes findings already recorded.

## Severity model

- S0: direct data loss, destructive deletion, workspace contamination, or core data-integrity risk.
- S1: severe reliability risk in chat, summaries, persistence, or workspace switching.
- S2: large-project performance, status visibility, uncommon compatibility, or release-polish risk.

Static findings and runtime-validation findings remain explicitly separated.

## S0 - protect user data and workspace boundaries

### 2A-03｜P1：工作区迁移会误处理“目标路径是文件”的情况，存在删除用户文件的风险

### 2B-01｜P1｜写作文档保存操作未按文档统一串行化

### 2B-09｜P1｜工作区刷新可能静默移除标签并清理 dirty 状态

### 2B-12｜P1｜切换标签前未主动 flush 编辑器

### 2B-13｜P1｜关闭标签的异步保存缺少错误处理与关闭锁

### 2B-15｜P1｜退出 flush 使用 `Promise.all`，单个失败可能影响整体收尾

### 2C-2-01｜P1｜资源编辑保存与重新导入没有互斥屏障

### 2C-2-02｜P1/P2｜资源变更入口没有共享的资源级互斥队列

### 2A-01｜P1：项目/实体归属与状态校验不集中，存在越过生命周期边界的入口

### 2A-02｜P1/P2：创建、删除与索引更新不是事务，失败时可能留下半成品或索引悬挂

### 2A-04｜P1/P2：删除、永久删除与后台摘要/向量任务没有统一协调

## S1 - restore core reliability

### 2A-05｜P1/P2：工作区迁移期间没有冻结编辑与派生任务，配置切换也可能与物理目录脱节

### 2B-21｜P1｜工作区切换/迁移期间旧请求写回风险

### 2C-1-01｜P1/P2｜并发工作区迁移缺少互斥锁与最终提交仲裁

### 2B-02｜P1｜对话 JSONL 追加与整体重写未统一串行化

### 2B-04｜P1｜`stream:done` 未完整校验 requestId

### 2B-05｜P1｜关闭聊天标签不会取消主进程流式请求

### 3A-2-01｜P1/P2｜非正常终止和提前结束的流被当作正常回答

### 3A-2-03｜P1/P2｜Responses 的最终 `.done` 内容在已有 delta 后被无条件忽略

### 3A-2-05｜P1/P2｜一轮 Responses/Chat 工具响应包含多个调用时只执行第一个

### 3A-2-07｜P2｜仅有 reasoning、没有正文时被视为成功但没有可见回答

### 3B-2-03｜P1/P2｜大摘要单组输入没有独立预算保护，十篇较大文档摘要可能直接超出模型上下文

### 3B-2-04｜P1/P2｜摘要规划选择结果与最终实际发送消息可能不一致，记忆卡片也可能继续显示已注入

### 3C-01｜P1｜原文检索结果在上下文预算裁剪后追加，最终请求缺少统一的二次预算保护

### 2B-22｜P1｜摘要 Worker 初始化失败可能阻塞主窗口启动

### 2B-23｜P1｜Worker error/fatal 收尾不完整

### 2B-24｜P1｜摘要任务取消协议没有真正贯通

### 2B-25｜P1｜退出时后台派生任务可能仍写入文件

## S1 - security and isolation gates

### P1/P2：IPC 缺少运行时参数与来源窗口校验

### P1/P2：实体 ID 与路径缺少统一安全边界

### 3C-02｜P1/P2｜向量搜索底层入口没有统一校验项目是否可检索，系统项目和回收站项目存在防御性隔离缺口

## S2 - defer until the core risks are closed

### 5B-3-01 | P2 | 默认摘要与动态摘要选择在同一请求内重复加载候选

### 5B-3-02 | P2 | 对话上下文组装中当前文档在一轮请求内重复读取

### 5B-3-03 | P2 | 激活资源摘要在候选阶段与注入阶段重复读取

### 5B-3-04 | P2 | 摘要候选加载使用无界限 Promise.all 并发读取

### 3C-06｜P2｜首次自动原文检索可能在对话请求中同步构建项目全部索引，长项目会产生不可预期的首轮等待

### 2B-19｜P2｜摘要事件不会触发完整工作区刷新

### 4B-1-02｜P2｜聊天历史中的项目写作文档附件使用不稳定的 React key
- **影响**：React 可能错误复用或重排附件节点，造成名称显示错位、旧节点残留或控制台 key 警告；在同名文档和多附件场景中会进一步削弱附件身份的可确认性。输入框草稿附件区已经使用 `snapshotId / docId / name`，但历史消息渲染没有复用该安全策略。

### 4B-1-03｜P2｜历史附件消息气泡没有展示附件类型与稳定身份

### 4B-1-04｜P2｜聊天初始化失败时没有用户可见的错误收尾

### 3B-1-02｜P1/P2｜结构化响应在状态与业务校验前被计为“成功”，会误导摘要调度器并发恢复

### 3B-2-01｜P1/P2｜故事/其他资源蒸馏在摘要不完整时仍返回成功，并允许不完整摘要进入注入

## Encoding and release note

### 编码与用户可见文本存在乱码风险

已发现明显乱码字符串或注释的文件包括：

- `src/main/index.ts`
- `src/main/services/file.service.ts`
- `src/main/services/feature-guide-content.ts`
- `src/main/services/git.service.ts`
- `src/main/services/vector.service.ts`
- `src/main/services/migration.service.ts`
- `src/main/services/doc-summary-maintenance.service.ts`
- `electron-builder.yml`

后续需要区分注释乱码、日志乱码、用户可见文本乱码、配置值乱码和构建元数据乱码。

特别需要复核：

```yaml
shortcutName: 绗斾即
```

该值疑似仍是乱码，可能影响 Windows 快捷方式或安装包显示名称。


## Deduplicated repair order

1. S0: migration target safety; document/resource save, switch, close, exit, and re-import barriers; ownership, lifecycle, and multi-file consistency.
2. S1: migration lock and request generation; chat stream and JSONL state machine; final context budgeting; summary Worker failure and shutdown; IPC and path isolation.
3. S2: repeated long-project reads, first vector-build latency, summary and attachment status, structured-failure states, and package-name encoding.

## Final judgment
目前系统的主要风险并非核心功能全部失效，而是集中在：

1. 后台 Worker 异常和退出时状态收尾不完整；
2. 摘要、向量、Git、迁移之间缺少统一协调；
3. IPC 缺少运行时安全边界；
4. 多窗口与外部文件事件缺少明确的目标和队列语义；
5. 普通对话与后台任务没有供应商级并发控制；
6. 项目中仍有用户可见乱码和构建元数据乱码风险。

This file is a repair baseline, not a statement that the issues are fixed. No further audit expansion is recommended before the S0 and S1 repair batches are approved.
