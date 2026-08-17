# PROJECT_CONTEXT.md — 氛围写作 VibeWrite 交接文档

> 本文件是项目唯一权威交接文档。新会话/新窗口必须**先读本文档再动手**。
> 产品需求：`writing-agent-prd-v1.3.md`；技术选型：`writing-agent-tech-stack-v1.0.md`；
> 拆解指导（需求参考，非运行时）：`拆解指导文档/story-decomposition-guide.md`、`content-decomposition-guide-v1.0.md`。
> 架构定稿：`docs/summary-distillation-refactor-plan-v2.md`（三层记忆架构，已按此实施）。

---

## 1. 项目元信息

### 1.1 产品

- 产品名：**氛围写作 / VibeWrite**（旧临时名 WritingAgent 已废弃）
- 定位：桌面端写作专精辅助 Agent。**核心边界：AI 不自动修改/生成/替换写作文档，输出只进对话区，由用户手动复制**。
- 平台：Windows（首批）；桌面安装包（NSIS，无签名）。
- 版本：1.3.0（与 PRD 版本对齐；内部 `package.json` 的 `name` 保留 `writing-agent`——**刻意为之**，它决定 Electron userData 目录为 `%APPDATA%\writing-agent`，改名会丢用户配置）。

### 1.2 技术栈与精确版本

| 类别 | 选型 | 精确版本 |
| --- | --- | --- |
| 运行时 | Node.js | v24.15.0（npm 11.18.0） |
| 桌面框架 | Electron | 33.4.11 |
| 前端框架 | React / react-dom | 19.2.8 |
| 语言 | TypeScript | 5.9.3 |
| 构建 | electron-vite + Vite | electron-vite 3.1.0 / vite 6.4.3 / @vitejs/plugin-react 4.7.0 |
| 打包 | electron-builder（NSIS） | 25.1.8 |
| 编辑器 | CodeMirror 6 | view 6.43.8 / state 6.7.1 / commands 6.10.4 / lang-markdown 6.5.2 |
| 样式 | Tailwind CSS + @tailwindcss/vite | 4.3.3 |
| 状态管理 | Zustand | 5.0.15 |
| AI 客户端 | openai（OpenAI 兼容协议） | 4.104.0 |
| Git | 系统 Git + simple-git | git 2.55.0（系统）/ simple-git 3.36.0 |
| Tokenizer | js-tiktoken（纯 JS 版） | 1.0.21 |
| Zip 导出 | archiver | 7.0.1 |
| 图表 | Recharts | 2.15.4 |
| 图标 | lucide-react | 0.454.0 |
| 日期 | date-fns | 4.4.0 |
| 本地嵌入（**未接线**，见 §6.1） | @huggingface/transformers（Transformers.js） | 已安装（npm），仅依赖未使用；ONNX 转换待办 |

**注意**：本项目运行时**不涉及 Python**；`scripts/convert_bge_onnx.py` 是**一次性转换脚本**（需 Python + optimum），只在本机执行一次产出 ONNX，运行时仍为 TS/Node。

### 1.3 数据库类型与“连接字符串”

**没有数据库**。全部主数据为文件存储（PRD 1.4）：

- 项目主数据：用户自选的工作目录（workspaceDir），JSON/JSONL/Markdown 文件。
- 应用级数据：Electron `userData` 目录 = `%APPDATA%\writing-agent\`。

关键文件（敏感值一律不落仓库、不进 Git、不进安装包）：

| 路径 | 内容 |
| --- | --- |
| `<workspace>/app-index.json` | 项目索引 |
| `<workspace>/<projectId>/{meta.json, docs/, chats/, summaries/, resources/, .git/}` | 项目全部数据 |
| `<workspace>/<projectId>/summaries/docs/<docId>.json` | 文档摘要（故事拆解 + 源指纹） |
| `<workspace>/<projectId>/summaries/chats/<chatId>.json` | 对话摘要（尾部逐条 + 历史压缩区间） |
| `<workspace>/<projectId>/summaries/resources/<resId>.json` | 资源摘要（源指纹 + 故事/通用拆解） |
| `<workspace>/<projectId>/summaries/rollups/<projectId>.json` | 大摘要（每 10 文档聚合，设置页管理） |
| `<workspace>/<projectId>/summaries/vector-index/<projectId>.json` | 本地向量索引（原文分块嵌入） |
| `<userData>/app-config.json` | 应用设置（含 `apiBaseUrl`、`model`、`contextLimit`、`language`、`summaryInjection`、`gitAuthor*`；**不含 Key**） |
| `<userData>/api-key.enc` | API Key，Electron safeStorage（Windows DPAPI）加密 |
| `<userData>/usage/<YYYY-MM>.json`、`lifetime.json` | Token 用量 |
| `<userData>/recovery.json`、`summary-retry.json` | 恢复标记/摘要重试 |
| `<userData>/logs/errors-<YYYY-MM-DD>.log` | 错误日志（保留 7 天；摘要失败也写这里，source 前缀 `[summary:doc]` 等） |

“连接字符串格式”等价物：OpenAI 兼容 `{ baseURL, apiKey, model, contextLimit }`，其中 `apiKey` 只存于 `<userData>/api-key.enc`（DPAPI 密文），占位符示例：`sk-****`。

---

## 2. 目录结构与职责

```
D:\ds h-project\
├─ src/
│  ├─ shared/            # 主/渲染共享：数据模型与 IPC 契约（types.ts / ipc.ts）
│  ├─ main/              # Electron 主进程
│  │  ├─ services/       # 业务服务层
│  │  │  ├─ file.service.ts        # 文件仓库（含摘要/大摘要/向量索引读写与旧格式迁移）
│  │  │  ├─ api.service.ts         # 对话组装/注入管线/记忆规划(B+C)/预算裁剪/流式
│  │  │  ├─ summary.service.ts     # 摘要/蒸馏/分类/大摘要 rollup/一致性扫描
│  │  │  ├─ vector.service.ts      # 本地向量检索（特征哈希嵌入+余弦）
│  │  │  └─ …(tokenizer/usage/git/export/recovery/migration/config/log/crypto)
│  │  ├─ summary-source.ts         # 源指纹/三级新鲜度工具（src/main 根）
│  │  ├─ summary-relevance.ts      # 注入候选/相关度采样/激活键计算（主渲染共用）
│  │  ├─ install/        # Git 检测解析 + 三级降级安装
│  │  ├─ ipc/index.ts    # 全部 IPC handler 注册（统一 try/catch 落错误日志）
│  │  └─ window.ts       # 主窗口创建与事件广播
│  ├─ preload/           # contextBridge 白名单类型化桥（invoke/on/send）
│  └─ renderer/          # React 渲染层
│     └─ src/
│        ├─ components/  # layout(侧栏/标签/摘要区/一致性提示) chat(对话/记忆卡/注入搜索框) editor settings(设置/大摘要/归档回收站) common
│        ├─ store/       # Zustand：app/dialog/toast/context/i18n
│        ├─ lib/         # api 封装、summaryActions（蒸馏/标题）、editorRegistry
│        └─ i18n/        # zh/en 全量界面文案字典
├─ BAAI--bge-small-zh-v1.5/   # 用户提供的本地嵌入模型（PyTorch 权重，**gitignore**，见 §6.1）
├─ models/              # ONNX 转换输出目录（gitignore，转换脚本生成后使用）
├─ scripts/convert_bge_onnx.py  # 一次性 PyTorch→ONNX 转换脚本（需 Python）
├─ docs/summary-distillation-refactor-plan-v2.md  # 三层记忆架构定稿（实施依据）
├─ 拆解指导文档/          # 两份拆解指导（需求参考，不参与运行）
├─ out/                  # electron-vite 构建产物（gitignore）
├─ dist/                 # electron-builder 安装包（gitignore）
├─ .npm-cache/ .electron-cache/ .electron-builder-cache/   # 沙箱缓存（gitignore）
├─ electron-builder.yml  # 打包配置（productName VibeWrite、文件关联、快捷方式“氛围写作”）
├─ start.cmd / start-dev.cmd  # 双击启动（生产 / 开发）
└─ writing-agent-{prd,tech-stack}*.md  # 需求与选型文档
```

---

## 3. 环境启动步骤（从零到运行）

```bash
# 0) 前置：Node v24+、Git（版本管理功能用到）；无其他系统依赖
cd "D:\ds h-project"

# 1) 安装依赖（.npmrc 已配置 npmmirror 镜像 + electron 镜像）
npm install

# 2) 环境变量：本项目无 .env；API 配置在应用内「设置 → API 配置」填写

# 3) 启动
npm run dev            # 开发模式（HMR）；或双击 start-dev.cmd
# 生产启动：npm run build 后双击 start.cmd（等价 electron out/）

# 4) 打包安装器
npm run dist           # 产物 dist/VibeWrite Setup 1.3.0.exe
```

### 3.1 本机（DSH 沙箱环境）特殊注意事项 ⚠️

本项目开发环境运行在受限沙箱中，普通机器上**不需要**以下步骤：

- `npm install` 需 `--foreground-scripts`，并设 `$env:ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`$env:electron_config_cache=<仓库内目录>`。
- `electron-vite build` / `electron-builder` 依赖 esbuild/nsis 子进程（管道通信），沙箱下需**提权**运行；普通机器直接跑。
- electron-builder 还需 `ELECTRON_BUILDER_CACHE`、`ELECTRON_BUILDER_BINARIES_MIRROR`。
- 类型检查可绕过 npm run（管道 EPERM）：`node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json --composite false`（web 同理）。
- dev 模式**主进程改动需重启** start-dev.cmd（渲染层才热更新）。
- **沙箱阻断 HuggingFace 等外网**：本地嵌入模型权重无法在沙箱内下载/验证；模型的 ONNX 转换与实机验证必须在用户机器上进行（见 §6.1）。

---

## 4. 核心数据模型与关联关系

完整定义见 `src/shared/types.ts`。三层记忆涉及的关键结构：

```typescript
// 摘要源指纹（三级新鲜度 FRESH/STALE/NEEDS_REBUILD 的信号源，替代内嵌全文快照）
export interface SummarySourceInfo {
  schemaVersion: number
  sourceFingerprint: string    // 规范化（去空白/标点）后全文 sha256
  sourceLength: number
  sourceNormalizedLength: number
}
// 生成工具：src/main/summary-source.ts（computeSourceInfo / isSourceStale）
// 失效判定：指纹变化 且（原始长度变化>30% 或 规范化长度差>100 字符）→ STALE

// 文档摘要 = 故事拆解 + 源指纹（不再内嵌全文快照；旧格式读取时自动迁移）
export interface DocSummary extends StorySummary, SummarySourceInfo { updatedAt: string }

// 对话摘要：尾部窗口逐条 + 历史压缩区间（增量）
export interface ChatSummary {
  schemaVersion?: number
  items: ChatSummaryItem[]           // 尾部最近 20 条逐条
  compacted: ChatSummaryInterval[]   // 尾部之前的压缩区间（每 10 条一个，非重叠）
  updatedAt: string; lastMessageId: string; messageCount: number
}

// 资源摘要 = 源指纹 + 故事/通用拆解
export type ResourceSummary = SummarySourceInfo & { updatedAt: string } & (StorySummary | GenericResourceSummary)

// 大摘要（rollup）：每 10 个写作文档聚合（阈值 50，设置页管理）
export interface DocRollup { id; projectId; docIds; rangeLabel; overview; stateChanges[]; causality[]; schemaVersion; sourceFingerprints: Record<string,string>; updatedAt }

// 向量索引（本地特征哈希嵌入，原文分块）
export interface VectorIndex { schemaVersion; embedModel; chunks: VectorChunk[]; updatedAt }

// “本次记忆”透明卡（streamDone.memory）
export interface MemoryContext { small: MemoryContextItem[]; rollups: MemoryContextItem[]; vector: MemoryContextItem[]; reason?: string }

// 一致性提示（纯规则）
export type ConsistencyIssueKind = 'alias_conflict' | 'stale_summary'
export interface ConsistencyIssue { kind; severity: 'error' | 'advisory'; message; docId?; resourceId? }
```

**对话元数据（软状态机核心，持久化于 chats/<chatId>.meta.json）**：

```typescript
export interface ChatMeta {
  id: string; projectId: string
  kind: 'project' | 'doc' | 'context'
  docId?: string; title: string; status: 'normal' | 'user_archived' | 'orphan_archived'
  createdAt: string; updatedAt: string
  contextRange?: ContextRange; action?: 'diagnose' | 'plot' | 'optimize'
  lockedRange?: { before: number; after: number }
  injectionOverrides?: { disabled: string[]; active?: string[]; pending?: string[] }
}
```

**关联关系**：`Project 1—N Doc`，`Doc 1—N Chat(kind=doc/context)`，`Project 1—N Chat(kind=project)`；
`Chat 1—1 ChatSummary`、`Doc 1—1 DocSummary`、`Resource 0—1 ResourceSummary`、`Project 0—N DocRollup`、`Project 0—1 VectorIndex`；
摘要文件物理删除随主体走（`file.service.ts` 的 purge/delete 系列负责）。

注入键约定：`'fulltext'`、`'doc:<id>'`、`'chat:<id>'`、`'res:<id>'`——主进程与渲染层共用（`summary-relevance.ts collectApplicableKeys` / `ChatPane injectionItems`）。

---

## 5. 已完成功能清单

- [x] 单实例 + 文件关联（第二实例转交路径，非 `.txt/.md/.csv` 拒绝）
- [x] 文件化存储（JSON/JSONL/Markdown，原子写入，元数据驱动生命周期）
- [x] 项目/文档/对话/资源 CRUD 与软删除状态机（回收站/归档区/孤儿对话/恢复冲突改名）
- [x] 编辑器（CodeMirror 6：行号/字号/暗色/选区高亮/复制剪切粘贴右键菜单/边界钳制/自动保存/CRLF 保留）
- [x] 右键「诊断/走向/优化」→ 创建上下文对话（默认标题“新对话”+ action 图标徽标）
- [x] 上下文面板（前后文滑块+数字输入，固定在对话顶部，只可扩大下限持久化）
- [x] 流式对话（OpenAI 兼容、include_usage、取消、失败提示、思维链 reasoning 可视化）
- [x] 重新生成（范围/摘要变化联动提示，不重复调用，上一版对照，告知 LLM 新增上下文）
- [x] **三层记忆架构（docs/summary-distillation-refactor-plan-v2.md 定稿）**：
  - [x] P0 摘要元数据：`SummarySourceInfo` 源指纹 + 三级新鲜度；DocSummary 去内嵌全文快照换指纹（旧格式读取自动迁移）；资源摘要读时惰性失效检测 + 摘要区“待更新”黄标
  - [x] P3 生成协议：枚举/字数/负例约束 + 长文档（>2 万字）有界摘要（角色≤20/情节≤40/伏笔≤30/设定台词≤40）；摘要失败写错误日志（不再静默）
  - [x] P1′ 注入：**内容相关度采样**（实体重叠+新鲜度，每类型默认最相关 10 条，替代“全部注入”）；默认激活集（`summary:defaultActive`）；注入面板**搜索框**（`summary:search` 手动激活）；首条消息冻结 = (默认采样 ∪ pending) − disabled
  - [x] P2′ 大摘要 rollup：写作文档 >50 时每 10 篇聚合成整体摘要（状态变化/因果/伏笔账本），设置页按项目管理（预览/单条重生成/无移除），三级新鲜度
  - [x] P2′ 聊天小摘要增量：尾部窗口 20 条逐条 + 历史区间压缩（触发：消息数 >40 或对话 token 估算 >60% 预算），每 10 条一个压缩区间，增量维护
  - [x] P7 B 记忆菜单：回答前一次小决策调用，模型可自动请求展开大摘要（`needs`）或发起向量检索（`vectorQuery`），失败兜底直接作答
  - [x] P7 透明“本次记忆”卡：每次回答展示注入的小摘要 + 补充的大摘要 + 向量命中 + 模型自述缺口（`streamDone.memory`）
  - [x] P6 本地向量检索：char 1–3-gram 特征哈希嵌入（256 维）→ 原文分块（800 字/重叠 100）→ 余弦 top-5，索引存 `summaries/vector-index/`，无索引自动构建（`vector:build`/`vector:search`）
  - [x] P4 一致性扫描：R1 别名冲突（error）+ R4 摘要漂移（advisory），摘要区“一致性提示”分组展示（`summary:scanConsistency`）
  - [x] 侧边栏瘦身：归档/回收站/项目回收站迁到设置页“归档与回收站”按项目管理
  - [x] 附件去重：写作文档“附加到对话”（读当前内容）+ 与全文注入去重（`ChatAttachment.docId` / `StreamRequest.docIds`，“关联文档全文已打开，无需上传”提示）
- [x] 文档摘要 = 故事拆解（预算 60% 一次调用，超限拒绝提示；黄点生成中→绿点；失败写日志）
- [x] 对话摘要（关闭窗口后台生成，逐条+区间、变化检测、手动重新生成）
- [x] 资源蒸馏（启发式预筛+模型判定+置信度 0.8 兜底+不确定确认+force；取消蒸馏即移除；源指纹失效检测）
- [x] 注入配置（设置页按对话类型勾选）+ 每对话开关面板（冻结/锁定/pending 机制）
- [x] Token 用量（按月/按小时/lifetime，总消耗+摘要标题两条折线；标题生成计入 summary 来源）
- [x] Git 版本管理（每项目一仓库、自动提交、版本历史、回滚、身份自动补齐、手动提交按钮）
- [x] 导出（单文档 md/txt；项目 Zip 选项）
- [x] 工作目录迁移（物理复制含 .git、校验、原子生效、EPERM 重试、成功同步界面）
- [x] 异常退出恢复（恢复标记+启动提示）
- [x] 错误日志（userData/logs，按天、保留 7 天，主进程/IPC/渲染层全覆盖；摘要/蒸馏失败亦落日志）
- [x] 设置（API 配置+联通测试+模型列表获取下拉/手动兜底、语言 zh/en、自动保存、摘要、大摘要、归档回收站、版本、用量）
- [x] i18n（界面文案 zh/en 完整双语；语言切换联动 LLM 输出语言与摘要语言）
- [x] 提示词风格：理性务实（结论先行、少客套）
- [x] 正式命名 氛围写作 / VibeWrite（窗口标题/侧栏/提示词/安装器/快捷方式）

---

## 6. 待办事项与已知问题

### 6.1 本地嵌入模型（最优先待办）⚠️

现状：向量检索目前用**特征哈希嵌入**（`vector.service.ts`，零依赖但只有字面/实体重叠，语义召回弱）。用户已提供 `BAAI--bge-small-zh-v1.5`（PyTorch 权重，位于仓库根 `BAAI--bge-small-zh-v1.5/`，**已 gitignore**）。

**硬约束（已核实）**：
- 沙箱阻断 HuggingFace，无法下载/捆绑 ONNX 权重；也无法在沙箱内跑 ONNX 推理验证。
- `@huggingface/transformers` 已安装（package.json）但**只认 .onnx**，不读 PyTorch 权重。
- electron.vite 未配置外部化——接线时需把 `@huggingface/transformers` 及 `onnxruntime-*` 加入 `electron.vite.config.ts` 的 external（否则打包原生模块/WASM 会失败），并处理 Electron ABI（倾向强制 onnxruntime-web/WASM）。

**待办链**（需用户机器配合）：
1. 用户跑 `scripts/convert_bge_onnx.py`（需 Python + `pip install optimum[onnxruntime] transformers`）→ 产出 `models/bge-small-zh-onnx/`（已 gitignore）。
2. 接线：写 `neural-embed` 模块（加载本地 ONNX 目录，bge 用 CLS 池化 + 归一化，512 维），**保留特征哈希回退**（模型加载失败自动降级，不破坏现有功能）。
3. electron.vite 外部化 + 打包配置（模型目录作为 extraResources 随安装包分发）。
4. 实机验证（沙箱无法验证 ONNX 推理）。

### 6.2 摘要/蒸馏仍存在失败问题（用户已指示：**不再修改**）

- 已修复一部分：长文档有界摘要防截断（`bfc2782`）+ 摘要失败写错误日志（`[summary:doc]` 前缀，不再静默）。
- 但用户反馈**仍有文档/资源始终失败**。可能残留原因（**未确认**）：设置中“模型上下文上限”比模型实际值大（预算检查失效后在 API 层超限）；或个别内容让模型输出非法/空 JSON。**接手窗口如非用户要求，不要在此投入**。
- 排查入口：`<userData>/logs/errors-*.log` 中的 `[summary:doc]` / `[summary:res]` 条目；手动“重新生成”会返回具体报错。

### 6.3 其他待办（原有）

1. **应用图标**：当前用默认 Electron 图标；在 `build/icon.ico` 放置图标并在 `electron-builder.yml` 配置。
2. **代码签名**：`win.signAndEditExecutable=false`；有证书后恢复并配置 `CSC_LINK`。
3. **主进程错误文案英文化**：i18n 只覆盖界面；主进程错误仍为中文（用户知情并接受）。
4. **多模型支持**：PRD 限定单模型；已预留扩展点 `summary.modelOverride`。
5. （可选）非推理模型的“提示式思考”开关（当前 CoT 仅展示模型原生 reasoning_content）。

### 6.4 已知边界 / 未修复项（出现路径）

- **向量索引无自动重建**：`searchVectorIndex` 只在无索引时构建，不跟踪文档变更（文档改了索引不刷新；属兜底层，可接受，未来可加“doc 保存后重建对应块”）。
- **记忆规划每次消息多一次小 LLM 调用**（`max_tokens 400`，temperature 0），成本/延迟增加（用户接受）。
- **中文模型 token 估算为近似**：DeepSeek/GLM/Qwen 按 ~1.1 token/字（`estimateInputTokens`），可能边界误判（可调大上下文上限）。
- **旧版本摘要格式**：三字段版/单标签版读取时按无效丢弃并重新生成；v1 带全文快照版读取时自动迁移为指纹（`file.service.ts readDocSummary`）。
- **重新生成“上一版回答”仅在内存**：不持久化，重开窗口后对照块消失。
- **对话摘要重新生成的 UI 刷新用 2.5s 定时器兜底**（`SummaryArea regenChat`），正常由 `summary:status` 事件驱动。
- **dev 模式关命令行窗口会强杀进程**：自动提交可能丢失；请用窗口 × 正常关闭或“立即提交”按钮。
- **Windows 上 rename 覆盖已存在目录会 EPERM**：迁移已修复（先移除空目标+重试）；其他同类操作需沿用 `renameDirAtomically` 模式。
- **日志中曾出现 `[git:commit] Author identity unknown`**（运行中构建观察，未深查）：`ensureCommitIdentity` 已存在，若复现先确认用户机器跑的是新构建（`out/` 需重新 build）。
- **`@huggingface/transformers` 已装但未接线**：当前不影响构建（未被 import）；接线前勿静态 import（会触发打包原生模块问题）。

---

## 7. 关键业务逻辑解释

### 7.1 注入管线（每次发送消息都会走，三层记忆的第一层）

`api.service.ts buildMessages` → `summary-relevance.ts`：

1. `collectApplicableKeys(chat, cfg, tree)` → 候选键（fulltext / doc: / chat: / res:）。
2. `selectDefaultKeys(chat, applicable)` → **内容相关度采样**：实体重叠（角色/别名/关键设定/术语，零 LLM）+ updatedAt 新鲜度，每类型取最相关 **10** 条（`RELEVANCE_SAMPLE`）。文档级对话锚点 = 当前文档摘要实体。
3. `computeActiveKeys(chat, applicable, defaultSelected)` → 激活键状态机：
   - 未冻结（首条消息前）：激活 = (defaultSelected ∪ pending) − disabled（fulltext 恒可用）；
   - 已冻结：激活 = 候选 ∩ (active ∪ pending)。
4. 上下文块：context 对话取切片；doc 对话读全文并触发 `ensureDocSummary`（首次或 STALE 时阻塞生成），`fulltext` 仅当激活。
5. `injectSummaries` → 文档摘要 > 资源快照/附加文档 > 对话摘要 > 资源摘要，并收集注入明细到 `memory.small`。
6. `applyBudget` → 预算裁剪顺序（从低到高丢）：历史 → 资源摘要 → 对话摘要 → 快照/附加 → 文档摘要 → 最后截断上下文块。输入预算 = `contextLimit * 0.8`。
7. 附加文档去重：同文档已全文注入则跳过附件（`fullTextDocIds` 集合）。

### 7.2 记忆规划（B 大摘要 + C 向量，三层记忆的第二三层，自动触发）

`api.service.ts planMemory`（`streamChatInner` 中，非重新生成且 `summaryEnabled` 时）：

1. 把可用大摘要目录（`buildRollupCatalogBlock`）+ 指令附到消息尾部，模型输出 JSON `{needs: [rollupId...], vectorQuery: "..."或null, reason: "..."}`（`parseMemoryPlan`，失败兜底：不补充直接作答）。
2. `needs`（最多 5 个）→ 展开对应 rollup 块，记入 `memory.rollups`。
3. `vectorQuery` → `searchVectorIndex(projectId, vectorQuery, 5)` → 注入命中分块（带来源头），记入 `memory.vector`。
4. `reason` → `memory.reason`（模型自述缺口）。
5. 全部随 `streamDone.memory` 返回渲染层，由“本次记忆”卡透明展示。

### 7.3 注入开关的“冻结/锁定/pending”状态机（渲染层 ChatPane）

- 首条消息发出：冻结 `active` = (defaultActive ∪ pending) − disabled 并持久化（chatPatch）。defaultActive 来自 `summary:defaultActive`（主进程相关度采样）。
- 开始后：`active` 键锁定；未激活键可开启 → `pending`（可再关）；`pending` 随下一次 send 并入 active 并锁定。
- 打开已开始对话时检测到“新摘要” → 一次性 toast。
- 主进程 `computeActiveKeys` 同套逻辑保证一致。

### 7.4 大摘要 rollup（`summary.service.ts`）

- 写作文档按 `createdAt` 排序，> `ROLLUP_THRESHOLD(50)` 时每 `ROLLUP_BATCH(10)` 个生成 `DocRollup`（`generateDocRollups`，增量复用未变块）。
- 基于成员文档摘要生成（非全文，省 token），内容 = overview + stateChanges（“什么变了”）+ causality（因果/伏笔账本）。
- 新鲜度：成员摘要指纹任一变化 → STALE（`listDocRollups`）；设置页按项目展示，可预览/单条重生成（`regenerateDocRollup`），无移除。

### 7.5 聊天小摘要增量（`summary.service.ts generateChatSummary`）

- 尾部窗口 `CHAT_TAIL_WINDOW(20)` 条逐条摘要（每次只重算尾部）；窗口之前的历史在 `CHAT_COMPACT_THRESHOLD(40)` 或 token 超预算 60% 时按 `CHAT_COMPACT_BATCH(10)` 压缩成非重叠区间（增量追加，已压缩区间复用）。
- 注入块 `buildChatSummaryBlock` 含“历史（已压缩）+ 最近”两段。

### 7.6 蒸馏判定状态机（`summary.service.ts distillResource`）

`heuristicClassify`（零成本，极保守）→ 弱信号走 `classifyByLlm`（头/中/尾三段采样，`{type, confidence, reasons}`）→ 置信度 <0.8 返回 `uncertain`（用户确认后 force）→ 与所选不符返回 `mismatch` → 生成对应摘要（故事/通用，均带源指纹）。所有摘要 LLM 调用走 `enqueueLlm` 全局串行队列（并发 1），空结果/`finish_reason=length` 自动重试一次；长文档用有界 prompt。

### 7.7 一致性扫描（`summary.service.ts scanConsistency`）

纯规则、零 LLM：R1 别名冲突（两角色名字互为别名或别名交集，error 红标）+ R4 摘要漂移（复用 `checkResourceSummaryStale`，advisory 黄标），摘要区“一致性提示”分组展示，只提示不自动改。

### 7.8 其他关键机制（函数名索引）

- 源指纹：`src/main/summary-source.ts`（`computeSourceInfo`/`isSourceStale`；三级新鲜度信号）。
- 原子写：`util.ts atomicWrite`（临时文件+rename+EPERM 退避+按文件串行队列）。
- 单实例/文件关联：`main/index.ts`。
- 退出流程：`before-quit` → `flushRenderer` → `commitAllProjects` → `waitForSummaryQueue(8000)` → `clearRecovery` → `app.exit(0)`。
- Git 身份：`git.service.ts ensureCommitIdentity`（应用配置优先，缺失写仓库级默认 VibeWrite）。
- 摘要生成状态：`markGenerating/markDone` → 广播 `summary:status` → 黄点/绿点。
- 生命周期：元数据 `status` 字段驱动，物理删除仅在 purge。
- 错误日志：`log.service.ts logError`（按天文件，7 天清理；IPC wrapper、`uncaughtException`、渲染层 `window.onerror`、摘要失败全覆盖）。

---

## 8. 编码规范与约束

- **缩进**：2 空格；**无分号**；**单引号**；文件命名 kebab-case；TS 变量 camelCase；JSON 字段 camelCase。
- 类型：跨进程类型只放 `src/shared/`；IPC 新增通道必须同步改两处——`shared/ipc.ts`（通道+`IpcApi` 类型）、`main/ipc/index.ts`（handler）；preload 无需改（泛型桥自动覆盖）。
- 所有文件写入用 `atomicWrite`；所有异步 LLM 调用设超时（180s）且 `maxRetries: 0`。
- 渲染层不直接接触 Node/网络：一律走 `window.api`（preload 白名单）。
- **潜规则**：
  - 禁止任何第三方分析/统计 SDK；**安装包只允许包含 `out/**` 与 `package.json`**（打包后必须 `asar list` 核验无用户数据——隐私红线）。接线本地模型时，模型文件走 electron-builder `extraResources`，**不进 asar、不入 git**。
  - AI 侧不提供任何“写回编辑器/一键应用”的 IPC（PRD 0.2 边界）。
  - API Key 明文不出主进程；渲染层只问 `hasApiKey`。
  - 提示词/摘要输出语言跟随 `config.language`；界面文案一律走 `src/renderer/src/i18n`（禁止硬编码中文）。
  - 主进程错误文案暂用中文（已知债务）；新代码需落错误日志。
  - 依赖克制：原子写/防抖/串行队列均为自研小实现；新依赖需说明理由（`@huggingface/transformers` 为本地嵌入专用）。
  - 每次可运行改动都提交 Git。

---

## 9. 遗留技术债务

| 债务 | 现状 | 计划 |
| --- | --- | --- |
| 本地嵌入未接线 | 特征哈希向量在用；`@huggingface/transformers` 已装未用；ONNX 权重缺失 | 用户跑 `scripts/convert_bge_onnx.py` → 接线 neural embed（CLS 池化）+ electron 外部化 + 实机验证（§6.1） |
| 摘要/蒸馏仍有失败 | 已做有界摘要+错误日志；用户指示不再修改 | 仅在用户要求时排查（`errors-*.log` 的 `[summary:*]` 条目） |
| 向量索引无自动重建 | 只在无索引时构建 | 文档保存后重建对应块（低优先） |
| 无应用图标 / 无签名 | 默认图标；`signAndEditExecutable=false` | 图标与证书就绪后补齐 |
| 主进程错误文案中文 | 界面 i18n 完成 | 计划在语言设置完善时统一 |
| 单模型限制 | 摘要复用主模型；留 `summary.modelOverride` | 多模型需求出现时升级 |
| 中文 token 估算近似 | 1.1 token/字 | 引入官方 tokenizer 可替换 |
| 摘要区对话摘要刷新兜底定时器 | setTimeout(2.5s) | 事件驱动已覆盖，可后续移除 |
| “上一版回答”对照不持久化 | 仅内存 | 如需历史对照，给 ChatMessage 增加 prevContent |
| 沙箱缓存目录占用仓库空间 | 三个缓存目录 | 已 gitignore；仓库迁移可删除后重装 |
| 旧摘要格式只读不迁移 | 三字段/单标签版丢弃重生成；快照版自动迁移指纹 | 无进一步迁移计划 |
| 记忆规划额外 LLM 调用 | 每消息一次小调用 | 用户已接受；未来可加“有 rollup/索引才规划”开关 |

---

## 10. 可借鉴的工程经验

1. **文档驱动开发**：PRD（806 行）+ 技术栈文档先行；需求变更先“报根因+边界问题”再动手；三层记忆架构有定稿文档（`docs/summary-distillation-refactor-plan-v2.md`），按 P0→P7 分期实施，每期类型检查+构建验证。
2. **对标研究驱动重构**：精读 OpenFic（会话压缩/区间摘要/惰性失效/分层注入）与 NeuroBook（事件溯源/分层记忆/矛盾规则化）源码，提取为改进方案；研究仓库在 `research/`（**已 gitignore，不入库**）。
3. **受限网络/沙箱环境作战手册**：npmmirror 镜像、`electron_config_cache` 重定向、`--foreground-scripts`、构建提权跑 esbuild、关闭签名绕 winCodeSign 问题；**模型权重类资产在沙箱内无法获取，需用户机器配合**。
4. **Electron 踩坑清单**：渲染层 `window.prompt` 不支持；`simple-git customBinary` 开 `unsafe.allowUnsafeCustomBinary`；空仓库 `git log` 需捕获；`fs.rename` 覆盖目录 EPERM；dev 主进程改动必须重启；`safeStorage` 存 Key；**原生/WASM 依赖（onnxruntime）不能直接打包，需外部化或走 WASM**。
5. **隐私打包红线**：`files` 白名单只放 `out/**`+`package.json`，打包后 `asar list` 核验；模型/缓存一律 gitignore + extraResources。
6. **LLM 工程技巧**：预算分档、三段采样分类、结构化 JSON + 括号配平“截断抢救”解析、空结果/截断自动重试、全局串行队列、中文模型 token 近似估算、**长文档输出用“有界 prompt”防截断**（比分块合并更省且利于注入）、**决策调用与作答分离（两段式记忆菜单）**。
7. **状态机落库**：UI 锁定规则（冻结/锁定/pending、只能扩大）必须持久化到 meta 并主/渲染双端共用同一判定（`summary-relevance.ts`），否则重开失效或两端不一致。
8. **错误可观测性**：所有 IPC 异常 + 摘要/蒸馏失败自动落日志（按天轮转），让用户直接贴 log 定位，避免静默失败。
9. **透明可信**：LLM 读取记忆的行为（注入/大摘要/向量命中/自述缺口）以“本次记忆”卡全量展示，作者对“AI 记错来源”零容忍，透明是信任根基。
10. **增量优先**：聊天摘要只重算尾部、压缩区间只追加；大摘要只重生成变更块；全部基于源指纹判定，避免全量重算的线性成本。

---

## 11. 近期提交记录（本会话）

```
9d501e3 加 bge 转 onnx 脚本
bfc2782 修复: 长文档有界摘要防截断 + 摘要失败写日志 + 向量检索改为 LLM 记忆规划自动调用(移除按钮)
51747be 侧边栏瘦身: 归档/回收站/项目回收站迁移到设置页
da81358 P1 附件去重: 写作文档附加到对话 + 与全文注入去重
9017a1b P4 一致性扫描: R1 别名冲突 + R4 摘要漂移
c733dc3 P7+P6: C 向量门(记忆卡向量检索入口)
a7657ca P6 本地向量检索(特征哈希嵌入原文分块)
f5ef000 P7: B 两段式记忆菜单 + 透明“本次记忆”卡
bf863d6 P2 聊天压缩补 60% token 预算触发
39237ca P2 聊天小摘要增量压缩
105ff0b P2 大摘要 rollup
c170da5 P1 注入搜索框 + 默认激活集冻结修复
6a4de51 P0+P3+P1核心: 源指纹/新鲜度、生成协议、相关度采样
```

> 交接提醒：`research/`（对标仓库）、`BAAI--bge-small-zh-v1.5/`（模型权重）、`models/`（ONNX 输出）、各缓存目录均已 gitignore，**不要**将其加入 Git。
