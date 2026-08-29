# PROJECT_CONTEXT.md — 氛围写作 VibeWrite 交接文档

> 本文件是项目唯一权威交接文档。新会话/新窗口必须**先读本文档再动手**。
> 产品需求：`writing-agent-prd-v1.3.md`；技术选型：`writing-agent-tech-stack-v1.0.md`；
> 拆解指导（需求参考，非运行时）：`拆解指导文档/story-decomposition-guide.md`、`content-decomposition-guide-v1.0.md`。
> 架构定稿：`docs/summary-distillation-refactor-plan-v2.md`（三层记忆架构，已按此实施）。
> **Current baseline (2026-08-22)**: branch `codex/setting-distillation-v2` keeps Setting-v2 active. Story and Other use the legacy hierarchical path; Story omits the `foreshadowing` field and uses name-only knowledge validation. Job/Worker isolation and visual progress are not implemented.

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
| 本地嵌入 | Transformers.js + ONNX Runtime Node + BGE-small-zh-v1.5 | @huggingface/transformers 4.2.0 / onnxruntime-node 1.24.3；Windows x64 CPU，512 维 |

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
| `<workspace>/<projectId>/summaries/docs/<docId>.json` | 文档摘要 schema v2（故事拆解 + 验证知识 + 分块结果 + 源指纹） |
| `<workspace>/<projectId>/summaries/chats/<chatId>.json` | 对话摘要（尾部逐条 + 历史压缩区间） |
| `<workspace>/<projectId>/summaries/resources/<resId>.json` | 资源摘要 schema v2（story/setting/other + 验证知识 + 分块结果 + 源指纹） |
| `<workspace>/<projectId>/summaries/resources/<resId>.setting-v2-checkpoint.json` | setting-v2 临时 checkpoint（同源/同模型/同语言任务结果与失败项；成功发布后删除） |
| `<workspace>/<projectId>/resources/<resId>/source.bin` | Original bytes of an imported external resource; `content` is normalized to UTF-8 |
| `<workspace>/<projectId>/summaries/rollups/<projectId>.json` | 大摘要（每 10 文档聚合，设置页管理） |
| `<workspace>/<projectId>/summaries/vector-index/<projectId>.json` | 本地向量索引（原文分块嵌入） |
| `<userData>/app-config.json` | 应用设置（含 `apiBaseUrl`、`model`、`contextLimit`、`language`、`summaryInjection`、`gitAuthor*`；**不含 Key**） |
| `<userData>/api-key.enc` | API Key，Electron safeStorage（Windows DPAPI）加密 |
| `<userData>/usage/<YYYY-MM>.json`、`lifetime.json` | Token 用量 |
| `<userData>/recovery.json`、`summary-retry.json` | 恢复标记/摘要重试 |
| `<userData>/logs/errors-<YYYY-MM-DD>.log` | 通用错误日志（保留 7 天） |
| `<userData>/logs/summary-attempts-<YYYY-MM-DD>.jsonl` | 摘要/蒸馏结构化生成逐次审计 |
| `<userData>/logs/vector-events-<YYYY-MM-DD>.jsonl` | 本地嵌入 load/build/search/fallback/dispose 元数据日志；不记录项目 ID、查询、原文或向量 |

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
│  │  │  ├─ api.service.ts         # 对话组装/宿主原文检索/大摘要规划/工具循环/预算裁剪/流式
│  │  │  ├─ summary.service.ts     # 摘要/蒸馏入口、分类、大摘要 rollup、一致性扫描
│  │  │  ├─ setting-distillation.service.ts # setting-v2 三角色提取、递归拆分/归并、总览与 checkpoint 编排
│  │  │  ├─ setting-distillation.protocol.ts # setting 专用提取/归并/总览蒸馏协议与字段边界
│  │  │  ├─ setting-distillation.types.ts # setting-v2 候选项、checkpoint 与结果类型
│  │  │  ├─ summary-task-scheduler.ts # 摘要共享并发上限、优先级与 429 自适应收缩
│  │  │  ├─ vector.service.ts      # 本地混合检索（BGE/特征哈希语义 + 轻量字面召回）
│  │  │  ├─ neural-embed.service.ts # 本地 BGE 加载、tokenizer、批量推理与故障冷却
│  │  │  ├─ text-decoding.service.ts # Encoding detection/decoding and corruption-integrity gate
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

// schema v2：文档摘要 = 故事拆解 + 验证知识 + 分块结果/生成状态 + 源指纹
export interface DocSummary extends StorySummary, SummarySourceInfo, SummaryAnalysisMeta { updatedAt: string }

// 对话摘要：尾部窗口逐条 + 历史压缩区间（增量）
export interface ChatSummary {
  schemaVersion?: number
  items: ChatSummaryItem[]           // 尾部最近 20 条逐条
  compacted: ChatSummaryInterval[]   // 尾部之前的压缩区间（每 10 条一个，非重叠）
  updatedAt: string; lastMessageId: string; messageCount: number
}

// schema v2：资源摘要 = story/setting/other + 验证知识 + 分块结果/生成状态 + 源指纹
export type ResourceDistillType = 'story' | 'setting' | 'other'
export type ResourceSummary = SummarySourceInfo & SummaryAnalysisMeta & { updatedAt: string } & (StorySummary | SettingSummary | GenericResourceSummary)
// SummaryKnowledgeBase 保存实体/事实、短证据片段与 sourceChunkId；SummaryGenerationInfo 标记 complete/incomplete。

// 大摘要（rollup）：每 10 个写作文档聚合（阈值 50，设置页管理）
export interface DocRollup { id; projectId; docIds; rangeLabel; overview; stateChanges[]; causality[]; schemaVersion; sourceFingerprints: Record<string,string>; updatedAt }

// 向量索引（本地 BGE 神经嵌入优先，特征哈希回退，原文分块）
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
  - [x] P0 Summary metadata: SummarySourceInfo source fingerprints + freshness levels; DocSummary no longer embeds full snapshots (legacy formats are treated as absent); resource summaries use lazy stale detection + a stale indicator.
  - [x] P3 Generation protocol: enum/length/negative constraints + schema v2 token-aware chunking, knowledge verification, hierarchical merge, incomplete checkpoint and retry; document/resource paths support unchanged-chunk reuse. Resource distillation remains a synchronous main-process IPC operation in this baseline.
  - [x] P1′ 注入：**内容相关度采样**（实体重叠+新鲜度，每类型默认最相关 10 条，替代“全部注入”）；默认激活集（`summary:defaultActive`）；注入面板**搜索框**（`summary:search` 手动激活）；首条消息冻结 = (默认采样 ∪ pending) − disabled
  - [x] P2′ 大摘要 rollup：写作文档 >50 时每 10 篇聚合成整体摘要（状态变化/因果/伏笔账本），设置页按项目管理（预览/单条重生成/无移除），三级新鲜度
  - [x] P2′ 聊天小摘要增量：尾部窗口 20 条逐条 + 历史区间压缩（触发：消息数 >40 或对话 token 估算 >60% 预算），每 10 条一个压缩区间，增量维护
  - [x] P7 B 记忆菜单：仅在存在大摘要且摘要开启时，通过 provider-neutral 结构化任务选择需要展开的 rollup（`needs`）；规划失败不阻断回答
  - [x] P7/C 宿主驱动原文检索：每个有效问题先由主进程自动检索，独立于摘要开关和重新生成；支持 tools 的模型可在最多 2 次有界工具循环中补充查询，不支持 tools 的端点自动降级
  - [x] P6 本地混合检索：BGE-small-zh-v1.5 FP32 ONNX（CLS + L2，512 维）优先，精确 tokenizer 分块（480 token/重叠 48）；模型故障时整库回退 char 1–3-gram 特征哈希（256 维）；专名/原文措辞字面分数与语义分数融合
  - [x] P7 透明“本次记忆”卡：展示小摘要、大摘要、自动检索/工具检索的逐次查询、命中数、来源、相似度和原文预览（`streamDone.memory`）
  - [x] P4 一致性扫描：R1 别名冲突（error）+ R4 摘要漂移（advisory），摘要区“一致性提示”分组展示（`summary:scanConsistency`）
  - [x] 侧边栏瘦身：归档/回收站/项目回收站迁到设置页“归档与回收站”按项目管理
  - [x] 附件去重：写作文档“附加到对话”（读当前内容）+ 与全文注入去重（`ChatAttachment.docId` / `StreamRequest.docIds`，“关联文档全文已打开，无需上传”提示）
- [x] 文档摘要 = 故事拆解（预算 60% 一次调用，超限拒绝提示；黄点生成中→绿点；失败写日志）
- [x] 对话摘要（关闭窗口后台生成，逐条+区间、变化检测、手动重新生成）
- [x] 资源蒸馏（启发式预筛+模型判定+置信度 0.8 兜底+不确定确认+force；`story/setting/other`；token-aware 分块、知识抽取/原文验证、分层合并、源指纹与未完成状态）——当前仍在主进程同步执行
- [x] 注入配置（设置页按对话类型勾选）+ 每对话开关面板（冻结/锁定/pending 机制）
- [x] Token 用量（按月/按小时/lifetime，总消耗+摘要标题两条折线；标题生成计入 summary 来源）
- [x] Git 版本管理（每项目一仓库、自动提交、版本历史、回滚、身份自动补齐、手动提交按钮）
- [x] 导出（单文档 md/txt；项目 Zip 选项）
- [x] 工作目录迁移（物理复制含 .git、校验、原子生效、EPERM 重试、成功同步界面）
- [x] 异常退出恢复（恢复标记+启动提示）
- [x] 错误与审计日志基础设施（userData/logs，按天、保留 7 天；通用错误、结构化摘要尝试、向量事件和工具协议元数据分开记录；不记录 API Key、原文、查询词或向量）
- [x] 设置（API 配置+联通测试+模型列表获取下拉/手动兜底、语言 zh/en、自动保存、摘要、大摘要、归档回收站、版本、用量）
- [x] i18n（界面文案 zh/en 完整双语；语言切换联动 LLM 输出语言与摘要语言）
- [x] 提示词风格：理性务实（结论先行、少客套）
- [x] 正式命名 氛围写作 / VibeWrite（窗口标题/侧栏/提示词/安装器/快捷方式）

---

## 6. 待办事项与已知问题

### 6.1 本地嵌入模型（已接线；增量索引已实现，待真实语料验收）

2026-08-17 已完成 Windows x64 CPU 版内置语义嵌入接线：

- `neural-embed.service.ts` 在 Electron 主进程动态加载 `@huggingface/transformers`，仅允许本地模型；开发环境读取 `<repo>/models/bge-small-zh-onnx/`，安装包读取 `process.resourcesPath/models/bge-small-zh-onnx/`。
- 模型为 `bge-small-zh-v1.5` FP32 ONNX，CLS pooling + L2 normalize，512 维；查询加官方中文检索指令，文档块不加指令；batch size 4。
- 神经路径使用模型 tokenizer 分块：内容上限 480 token、重叠 48 token，优先句末/换行边界并保留原文子串；特征哈希路径继续使用 800 字/重叠 100 字。
- 向量索引使用 schema v3；记录 `embedModel` 和每个文档/资源的源指纹，后端/schema/维度不一致时全量重建。同一索引绝不混用 512 维神经向量与 256 维哈希向量。
- 模型缺失、加载失败、推理失败或输出形状异常时，废弃神经构建中间结果并从头使用 `fnv-ngram-256`；对话与记忆规划不得因此崩溃。失败后 30 秒冷却，应用退出时主动释放 pipeline。
- `electron-vite` 已外部化 Transformers.js 与 ONNX Runtime；builder 通过 `extraResources` 分发六个模型文件，原生 `.node`/DLL 解包，裁掉非 Windows x64、DirectML 和 ORT Web WASM 等无关资产。模型权重仍不进入 Git/asar。
- 打包前运行 `npm run verify:embedding-model`，校验必要文件、配置值及 model/tokenizer SHA-256；第三方许可说明见 `THIRD_PARTY_NOTICES.md`。
- 本地验证通过：Node 推理、Electron 33.4.11 原生推理、裁剪后 `app.asar` + `resources` 推理、schema v1→v3 重建、并发 SingleFlight、模型缺失哈希回退、恢复模型后重建、空项目稳定索引、实际语义查询。`dist/win-unpacked` 约 427.7 MiB；正式 `npm run dist` 已成功生成 NSIS 安装器（约 135.0 MiB）。

当前向量索引能力：

- 全局“生成/刷新索引”只重建新增或源指纹变化的文件，并自动移除已删除/回收站文件的向量；后端切换或 schema/维度不兼容时才全量重建。
- 文档/资源保存、删除、恢复和编码修复路径会排队异步的单源同步/移除；同一项目通过操作序列号丢弃过期操作，避免竞态覆盖。
- 设置页展示项目内各文档/资源的 `indexed`、`stale`、`not-indexed`、`encoding-error` 状态，并为每个文件提供单独重建/生成按钮；索引审计写入 `vector-events-YYYY-MM-DD.jsonl`，不记录查询词、原文或项目标识。

尚未完成：真实用户语料召回质量验收；完整 NSIS 安装/卸载与低配机器内存耗时验收；非 Windows x64 平台适配。详见 `docs/neural-embedding-implementation-2026-08-17.md`。

### 6.2 摘要/蒸馏当前基线（setting-v2 已实现；待真实端点验收）

- This round keeps `setting` on Setting-v2. `story` and `other` use the legacy hierarchical summary, chunk reuse, and recursive merge path. Story does not emit `foreshadowing`; its knowledge projection contains only source-name-validated character entities with empty evidence and no facts.
- setting-v2 把每个全文/自然边界分块的提取拆成三个角色：①实体+关系；②术语+规则+约束；③时间线。块内三角色并发，块之间顺序推进；删除未决问题生成，最终固定 no unresolved field is emitted。
- 2026-08-22 已实施内容精简第一阶段：`setting-distillation.protocol.ts` 把 setting 提取、归并、总览提示词统一改为“语义压缩而非穷举整理”，定义实体/术语/规则/关系/时间线/约束的互斥边界、原子事实、禁止长段照抄和字段级长度预算；中英文协议同步。
- 新协议仍要求保留所有独立事实，但明确修辞、同义复述、重复说明和无新增信息的例子不属于独立事实；`sourceIds` 只表示语义吸收，不要求保留候选原句。checkpoint `pipelineVersion` 已升为 2，旧协议缓存不会被复用。
- 组合角色遇到输出截断、空响应或结构校验失败时，继续拆成单语义任务；单语义任务仍失败时递归拆输入，不允许通过减少条目数或 compact 内容来换取成功。`structured-generation.service.ts` 新增 `retryPolicy: 'split-required'`，显式把截断/上下文溢出交还上层拆分；旧路径默认仍为 `compact`。
- 最终阶段不再让一次 LLM 同时输出总览和全部条目：实体/关系、术语/规则/约束、时间线分别归并，总览单独生成；归并要求 `sourceIds` 完整覆盖输入候选并在本地校验名称。叶级归并仍无法完成时原样保留候选，不裁剪内容。
- setting-v2 不要求证据文本，只校验实体名、术语名和关系主体/对象；写入的 knowledge 使用 `status: confirmed` 与空 `evidence`。这属于用户明确接受的 setting 专用减压边界。
- `summary-task-scheduler.ts` 提供共享最大并发 3；setting-v2 使用 batch 优先级，429 后依次收缩到 2/1，端点稳定 60 秒且累计 6 次成功后逐级恢复。旧摘要调用仍保持自身串行顺序，但同样受共享并发上限约束。
- 每个成功任务立即原子写入 `<resId>.setting-v2-checkpoint.json`；仅在源指纹、endpoint/model/contextLimit 指纹和语言一致时复用。重新生成只执行失败或缺失任务；替换资源、删除资源、取消蒸馏和正式发布成功会清理 checkpoint。
- setting-v2 只有在所有必要提取、归并和总览任务成功后才覆盖正式 `<resId>.json`；失败时保留旧正式摘要。真实 2–3 万字复杂设定、Qwen/DeepSeek/其他 OpenAI-compatible 端点的准确性、耗时和失败恢复仍需用户语料验收。

### 6.3 宿主驱动原文检索（已实施，待真实端点验收）

> **Scope**: keep Setting-v2 unchanged, restore Story to the legacy hierarchical path, and retain only the confirmed Story boundaries: no `foreshadowing` field and name-only validation. Job/Worker, background IPC, progress UI, and Other are out of scope.
- 检索升级为字面专名/原文措辞 + 神经/哈希语义的混合排序。
- 支持 Function Calling 的端点获得 `search_project_source`，单次回答最多 2 次工具检索；明确的工具参数兼容错误会自动重试不带 tools。
- “本次记忆”逐次展示自动检索/工具检索的查询、结果和命中片段。
- 实施说明与验收清单：`docs/host-rag-tool-loop-implementation-2026-08-17.md`。
- 尚需真实设定集专名召回验收、DeepSeek/OpenAI/Qwen/GLM 工具兼容矩阵、混合阈值调优、工具能力持久化和低上下文预算裁剪。

### 6.4.1 Text encoding compatibility P0 (implemented; UI acceptance still required)

- **Root cause:** the old renderer used `File.text()`, which always decodes external files as UTF-8. GBK/GB18030, Big5 and UTF-16 files therefore acquired `U+FFFD` replacement characters before workspace persistence; summaries, distillation and indexes subsequently only received corrupted text.
- **Import path:** renderer resource/local-attachment upload now sends `Uint8Array`; file-association import also reads bytes. `text-decoding.service.ts` applies BOM detection, strict UTF-8 validation, then `chardet` + `iconv-lite` decoding. Internal `content` is stored as UTF-8 while original bytes are retained in `source.bin` with detected encoding metadata.
- **Isolation:** replacement characters, NUL/control characters and common mojibake patterns mark a resource as suspicious. It is rejected for distillation and chat snapshots, skipped by summary injection/default selection/search and vector indexing, and cannot block an entire chat or index build. Vector-index schema v3 forces old corrupt chunks out during rebuild; Settings reports the file as `encoding-error`.
- **Repair:** Resource Viewer warns that the legacy content is excluded, and offers re-import of the original `.txt/.md/.csv`; repair removes the old resource summary and invalidates the index. Persisted `U+FFFD` content cannot be recovered by reverse decoding because its original bytes were already lost: the user must choose the source file again.
- **Verified:** UTF-8, GB18030, Big5, Shift-JIS and BOM UTF-16LE decoding; corruption guard; `npm run typecheck`; `npm run build`.
- **Known conservative boundary:** automatic detection is reliable for normal/long text samples, but a very short non-UTF-8 file can have low confidence. A future optional encoding picker in the re-import flow can address such cases without allowing suspicious text into LLM/context/index paths.

### 6.4 其他待办（原有）

1. **应用图标**：当前用默认 Electron 图标；在 `build/icon.ico` 放置图标并在 `electron-builder.yml` 配置。
2. **代码签名**：`win.signAndEditExecutable=false`；有证书后恢复并配置 `CSC_LINK`。
3. **主进程错误文案英文化**：i18n 只覆盖界面；主进程错误仍为中文（用户知情并接受）。
4. **多模型支持**：PRD 限定单模型；已预留扩展点 `summary.modelOverride`。
5. （可选）非推理模型的“提示式思考”开关（当前 CoT 仅展示模型原生 reasoning_content）。

### 6.5 已知边界 / 未修复项（出现路径）

- **向量索引异步同步的可见延迟**：保存/删除/恢复会排队单源同步或移除，设置页可显示 stale/not-indexed 并手动触发；队列失败不会阻断编辑，但需要通过索引日志或再次操作恢复。
- **大摘要规划仍可能增加一次 LLM 调用**：仅在摘要开启、非重新生成且项目存在 rollup 时执行 provider-neutral 结构化任务；无 rollup 时零调用。
- **setting-v2 仍运行在主进程**：当前 `resource:distill` 仍是同步 IPC；虽然 LLM 任务已拆分并引入受控并发，但 Job/Worker 隔离、退出恢复和主进程防阻塞尚未实现。
- **尚无生成可视化进度条**：当前 UI 仍只有 `markGenerating/markDone` 的生成中/完成状态；checkpoint 已具备任务级状态基础，但没有向 renderer 广播块/角色/归并阶段进度。
- **真实端点仍可能暴露新的限制**：setting-v2 已针对截断、无效 JSON、上下文溢出、429 和失败任务复用设计恢复路径，但不同 Provider 的真实输出上限、错误文案和 reasoning 行为仍需 2–3 万字复杂设定回归验证。
- **中文模型 token 估算为近似**：DeepSeek/GLM/Qwen 按 ~1.1 token/字（`estimateInputTokens`），可能边界误判。
- **Legacy summary formats**: three-field, single-tag, and v1 snapshot formats are discarded as invalid; v2 reads require knowledge, generation, and chunkResults. No migration or automatic rebuild is performed; users regenerate manually (file.service.ts).
- **重新生成“上一版回答”仅在内存**：不持久化，重开窗口后对照块消失。
- **对话摘要重新生成的 UI 刷新用 2.5s 定时器兜底**（`SummaryArea regenChat`），正常由 `summary:status` 事件驱动。
- **dev 模式关命令行窗口会强杀进程**：自动提交可能丢失；请用窗口 × 正常关闭或“立即提交”按钮。
- **Windows 上 rename 覆盖已存在目录会 EPERM**：迁移已修复（先移除空目标+重试）；其他同类操作需沿用 `renameDirAtomically` 模式。
- **日志中曾出现 `[git:commit] Author identity unknown`**（运行中构建观察，未深查）：`ensureCommitIdentity` 已存在，若复现先确认用户机器跑的是新构建（`out/` 需重新 build）。

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

### 7.2 B 大摘要规划 + C 宿主检索/工具循环

`api.service.ts streamChatInner / planMemory / streamAnswerWithTools`：

1. **C 首次检索由宿主执行**：除问候/感谢等低信号输入外，主进程以当前用户问题调用 `searchVectorIndex(projectId, query, 5)`；与 `summaryEnabled`、重新生成和模型规划能力无关。
2. **混合召回**：`vector.service.ts` 同时计算嵌入语义分数和轻量字面分数；引号短语、英文/数字专名、去除提问脚手架后的中文词段可提升精确原文命中排序。
3. **B 层只选大摘要**：仅在非重新生成、摘要开启且存在 rollup 时，`planMemory` 通过 `executeStructuredTask(memory_rollup_plan)` 输出 `{needs, reason}`；最多展开 5 个 rollup。
4. **有界工具循环**：最终回答请求声明 `search_project_source`。支持 tools 的模型可换查询补检索，最多执行 2 次；工具结果作为 `role: tool` 回传。
5. **兼容降级**：端点对 tools/tool_choice/tool_calls/function 参数返回明确 400/404/422 兼容错误时，按 `baseURL + model` 在本进程标记不支持并自动重试无工具请求；宿主首次检索结果仍保留。
6. **透明返回**：自动/工具查询均写入 `memory.vectorTrace.attempts`，命中块按 `docId:index` 去重后写入 `memory.vector`，随 `streamDone.memory` 在“本次记忆”卡展示。
7. **失败隔离**：索引/检索/大摘要规划失败均不得阻断最终聊天请求；模型不得在已有宿主片段或工具可用时声称没有原文访问权限。

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

### 7.6 蒸馏判定与分层摘要（`summary.service.ts distillResource`）

`heuristicClassify`（零成本、极保守）→ 弱信号走 `classifyByLlm`（头/中/尾三段采样，`{type, confidence, reasons}`）→ 分类器只提供首次建议，用户确认后 `force` 严格遵循手动选择。`setting` 作为独立类型，对世界观、势力、术语、规则、关系、时间线和约束使用专用结构。

`setting` 进入 `distillSettingResourceV2`：若全文可放入输入预算，三个角色都读取全文；否则按标题/段落/句子优先切成约 3k–10k token 自然块。每块并发执行“实体+关系”“术语+规则+约束”“时间线”，组合输出失败则拆为单语义调用，单语义仍失败再递归拆输入。所有 LLM 请求进入共享并发调度器，默认上限 3，429 自适应降并发。

提取完成后，三大语义分支分别归并；候选过多或输出失败时按预算分批并递归二分。每个归并输出通过 `sourceIds` 做全覆盖检查，实体名、术语名、关系主体/对象必须与引用候选一致。总览是独立任务；输入过长或输出失败时按层级生成局部概览再归纳。最终 no unresolved field is emitted，knowledge 不保存证据。

Setting-v2 writes an independent sidecar checkpoint and publishes only after required tasks succeed. `story` and `other` retain the legacy knowledge-extraction + type-summary + recursive-merge path; Story now skips evidence extraction and projects name-only character knowledge.
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
- 错误日志：`log.service.ts logError`（按天文件，7 天清理；IPC wrapper、`uncaughtException`、渲染层 `window.onerror` 已覆盖；摘要失败目前仅部分路径接入，见 §6.2）。

---

## 8. 编码规范与约束

- **缩进**：2 空格；**无分号**；**单引号**；文件命名 kebab-case；TS 变量 camelCase；JSON 字段 camelCase。
- 类型：跨进程类型只放 `src/shared/`；IPC 新增通道必须同步改两处——`shared/ipc.ts`（通道+`IpcApi` 类型）、`main/ipc/index.ts`（handler）；preload 无需改（泛型桥自动覆盖）。
- 所有文件写入用 `atomicWrite`；所有异步 LLM 调用设超时（180s）且 `maxRetries: 0`。
- 渲染层不直接接触 Node/网络：一律走 `window.api`（preload 白名单）。
- **潜规则**：
  - 禁止任何第三方分析/统计 SDK；安装包应用代码白名单为 `out/**`、`package.json`、第三方许可说明及生产依赖，模型只走 `extraResources`；打包后必须核验无用户数据。模型/缓存/复现文档**不进 asar、不入 Git**。
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
| 本地嵌入真实语料验收 | BGE/回退/打包链路已接通并通过隔离烟测 | 用实际小说项目比较语义命中；据结果决定是否调分块、查询指令、阈值或模型 |
| setting-v2 真实语料与多 Provider 验收 | 三角色提取、分支归并、总览拆分、checkpoint 和 429 收缩已实现；精简协议第一阶段已接入 | 先用现有 5000 字/2 万字样本验证摘要体积、字段归属和原文复用率，再决定是否实施跨字段质量门及 timeout 拆分 |
| 蒸馏后台化与进度可视化 | setting-v2 仍由主进程同步 IPC 编排；checkpoint 已提供任务级状态 | 后续设计 Job/Worker 隔离、退出恢复、取消语义和阶段/块/角色进度事件；本轮不实现 |
| 向量索引自动刷新 | 已有源指纹、逐文件状态和手动重建；正文修改可显示 stale | 增加保存后增量/防抖重建 |
| 无应用图标 / 无签名 | 默认图标；`signAndEditExecutable=false` | 图标与证书就绪后补齐 |
| 主进程错误文案中文 | 界面 i18n 完成 | 计划在语言设置完善时统一 |
| 单模型限制 | 摘要复用主模型；留 `summary.modelOverride` | 多模型需求出现时升级 |
| 中文 token 估算近似 | 1.1 token/字 | 引入官方 tokenizer 可替换 |
| 摘要区对话摘要刷新兜底定时器 | setTimeout(2.5s) | 事件驱动已覆盖，可后续移除 |
| “上一版回答”对照不持久化 | 仅内存 | 如需历史对照，给 ChatMessage 增加 prevContent |
| 沙箱缓存目录占用仓库空间 | 三个缓存目录 | 已 gitignore；仓库迁移可删除后重装 |
| 旧摘要 schema | v2 仅接受带 knowledge/generation/chunkResults 的当前格式；旧格式视为未生成 | 不迁移、不自动重建，由用户手动重新生成 |
| 大摘要规划额外 LLM 调用 | 仅存在 rollup 时每个非重新生成消息一次结构化调用 | 可增加用户开关或规则优先，继续降低延迟 |
| 工具能力缓存 | 当前按 baseURL + model 仅保存在进程内 | 持久化能力状态并提供重新探测入口 |
| 混合召回阈值 | 当前返回 top-k 正分结果，未设最低相关性阈值 | 用真实设定集调分并增加低相关性抑制/多样性重排 |
| 检索片段预算 | 自动检索在主预算裁剪后追加，低上下文上限可能偏紧 | 增加检索专用 token 预算和截断策略 |

---

## 10. 可借鉴的工程经验

1. **文档驱动开发**：PRD（806 行）+ 技术栈文档先行；需求变更先“报根因+边界问题”再动手；三层记忆架构有定稿文档（`docs/summary-distillation-refactor-plan-v2.md`），按 P0→P7 分期实施，每期类型检查+构建验证。
2. **对标研究驱动重构**：精读 OpenFic（会话压缩/区间摘要/惰性失效/分层注入）与 NeuroBook（事件溯源/分层记忆/矛盾规则化）源码，提取为改进方案；研究仓库在 `research/`（**已 gitignore，不入库**）。
3. **受限网络/沙箱环境作战手册**：npmmirror 镜像、`electron_config_cache` 重定向、`--foreground-scripts`、构建提权跑 esbuild、关闭签名绕 winCodeSign 问题；**模型权重类资产在沙箱内无法获取，需用户机器配合**。
4. **Electron 踩坑清单**：渲染层 `window.prompt` 不支持；`simple-git customBinary` 开 `unsafe.allowUnsafeCustomBinary`；空仓库 `git log` 需捕获；`fs.rename` 覆盖目录 EPERM；dev 主进程改动必须重启；`safeStorage` 存 Key；**原生/WASM 依赖（onnxruntime）不能直接打包，需外部化或走 WASM**。
5. **隐私打包红线**：应用代码使用 builder 白名单，生产依赖由 builder 收集；模型只通过 `extraResources` 分发。打包后核验 asar/resources 无用户数据，模型/缓存/复现文档一律 gitignore。
6. **LLM 工程技巧**：OpenAI-compatible 不是统一能力契约；结构化任务应通过 capability profile + provider adapter 选择 JSON Schema/JSON mode/prompt-only、reasoning 与 token 参数。摘要请求现在共享最大并发 3：setting 块内角色并发，旧路径保持串行；429 后动态收缩。复杂大 JSON 应按语义角色、归并分支和总览任务拆开，截断/上下文溢出必须拆输入或拆任务，不得靠补括号、减少条目或 compact 内容冒充完整结果。
7. **状态机落库**：UI 锁定规则（冻结/锁定/pending、只能扩大）必须持久化到 meta 并主/渲染双端共用同一判定（`summary-relevance.ts`），否则重开失效或两端不一致。
8. **错误可观测性**：IPC/通用异常、摘要结构化生成逐次尝试、向量 load/build/search/fallback/dispose 分开落日志；审计日志禁止记录用户原文、查询和向量。
9. **透明可信**：LLM 读取记忆的行为（注入/大摘要/向量命中/自述缺口）以“本次记忆”卡全量展示，作者对“AI 记错来源”零容忍，透明是信任根基。
10. **增量优先**：聊天摘要只重算尾部、压缩区间只追加；大摘要只重生成变更块；全部基于源指纹判定，避免全量重算的线性成本。

---

## 11. 当前基线与近期提交记录

当前仓库状态（交接时核对）：

```text
branch: codex/setting-distillation-v2
implementation: feat: add resilient setting distillation pipeline
parent baseline: 8374d8a docs: update project handoff for 193f6a8 baseline
working tree: 本实现提交后应为 clean
```

当前历史中与本次交接最相关的提交（从新到旧；setting-v2 的准确提交哈希以实际 `git log` 为准）：

```
feat: add resilient setting distillation pipeline
8374d8a docs: update project handoff for 193f6a8 baseline
193f6a8 feat: add verified hierarchical resource distillation
6f4a3bf fix: preserve chat state across tab switches
8a39ac3 fix: restore chat auto scroll
186b4bd fix: restore visible chat streaming and memory cards
4302af8 fix: harden LLM tool-call streaming
83059d2 fix: decode legacy text encodings before indexing
8887558 feat: make project retrieval host-driven with tool fallback
62ccb0c feat: expose vector index and retrieval traces
61eebf7 feat: bundle local neural embeddings
1b235ef fix: harden summary structured generation
```

> **Scope record**: this round keeps Setting-v2 semantic splitting, concurrency, recursive recovery, and sidecar checkpoint; Story is restored to the legacy hierarchical path with no `foreshadowing` field and name-only knowledge validation. Job/Worker, background IPC, and progress UI remain out of scope.

> **交接提醒**：新会话第一步读取本文件，并运行 `git status --short` 与 `git log --oneline -15`。若要继续本轮工作，优先用真实 2–3 万字复杂设定验证输出完整性、失败块复用和多 Provider 行为；后台化/进度条是后续独立阶段，不要与本轮 setting 协议一起重做。
