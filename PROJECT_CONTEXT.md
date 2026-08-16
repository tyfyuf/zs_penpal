# PROJECT_CONTEXT.md — 氛围写作 VibeWrite 交接文档

> 本文件是项目唯一权威交接文档。新会话/新窗口必须**先读本文档再动手**。
> 产品需求：`writing-agent-prd-v1.3.md`；技术选型：`writing-agent-tech-stack-v1.0.md`；
> 拆解指导（需求参考，非运行时）：`拆解指导文档/story-decomposition-guide.md`、`content-decomposition-guide-v1.0.md`。

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

**注意**：本项目运行时**不涉及 Python**。`story-decomposition-guide.md` 里提到的 Python 切分脚本只是需求参考，实际实现全部为 TS/Node。

### 1.3 数据库类型与“连接字符串”

**没有数据库**。全部主数据为文件存储（PRD 1.4）：

- 项目主数据：用户自选的工作目录（workspaceDir），JSON/JSONL/Markdown 文件。
- 应用级数据：Electron `userData` 目录 = `%APPDATA%\writing-agent\`。

关键文件（敏感值一律不落仓库、不进 Git、不进安装包）：

| 路径 | 内容 |
| --- | --- |
| `<workspace>/app-index.json` | 项目索引 |
| `<workspace>/<projectId>/{meta.json, docs/, chats/, summaries/, resources/, .git/}` | 项目全部数据 |
| `<userData>/app-config.json` | 应用设置（含 `apiBaseUrl`、`model`、`contextLimit`、`language`、`summaryInjection`、`gitAuthor*`；**不含 Key**） |
| `<userData>/api-key.enc` | API Key，Electron safeStorage（Windows DPAPI）加密 |
| `<userData>/usage/<YYYY-MM>.json`、`lifetime.json` | Token 用量 |
| `<userData>/recovery.json`、`summary-retry.json` | 恢复标记/摘要重试 |
| `<userData>/logs/errors-<YYYY-MM-DD>.log` | 错误日志（保留 7 天） |

“连接字符串格式”等价物：OpenAI 兼容 `{ baseURL, apiKey, model, contextLimit }`，其中 `apiKey` 只存于 `<userData>/api-key.enc`（DPAPI 密文），占位符示例：`sk-****`。

---

## 2. 目录结构与职责

```
D:\ds h-project\
├─ src/
│  ├─ shared/            # 主/渲染共享：数据模型与 IPC 契约（types.ts / ipc.ts）
│  ├─ main/              # Electron 主进程：窗口、单实例、文件关联、退出流程
│  │  ├─ services/       # 业务服务层：file/crypto/api/summary/usage/git/export/recovery/migration/config/log
│  │  ├─ install/        # Git 检测解析 + 三级降级安装（winget→PortableGit→手动）
│  │  ├─ ipc/index.ts    # 全部 IPC handler 注册（统一 try/catch 落错误日志）
│  │  └─ window.ts       # 主窗口创建与事件广播
│  ├─ preload/           # contextBridge 白名单类型化桥（invoke/on/send）
│  └─ renderer/          # React 渲染层
│     └─ src/
│        ├─ components/  # layout(侧栏/标签/摘要区) editor chat settings common
│        ├─ store/       # Zustand：app/dialog/toast/context/i18n
│        ├─ lib/         # api 封装、summaryActions（蒸馏/标题）、editorRegistry（落盘注册表）
│        └─ i18n/        # zh/en 全量界面文案字典
├─ 拆解指导文档/          # 两份拆解指导（需求参考，不参与运行）
├─ out/                  # electron-vite 构建产物（gitignore）
├─ dist/                 # electron-builder 安装包（gitignore）
├─ .npm-cache/ .electron-cache/ .electron-builder-cache/   # 沙箱环境重定向的缓存（gitignore）
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
#    （Base URL / API Key / 模型 / 上下文上限），保存后加密写入 userData。
#    无数据库，无需迁移脚本。

# 3) 启动
npm run dev            # 开发模式（HMR）；或双击 start-dev.cmd
# 生产启动：npm run build 后双击 start.cmd（等价 electron out/）

# 4) 打包安装器
npm run dist           # 产物 dist/VibeWrite Setup 1.3.0.exe
```

### 3.1 本机（DSH 沙箱环境）特殊注意事项 ⚠️

本项目开发环境运行在受限沙箱中，普通机器上**不需要**以下步骤，但需要知道：

- `npm install` 需 `--foreground-scripts`，并设 `$env:ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`$env:electron_config_cache=<仓库内目录>`（否则下载/缓存目录在沙箱外被拒）。
- `electron-vite build` / `electron-builder` 依赖 esbuild/nsis 子进程（管道通信），沙箱下需**提权**运行；普通机器直接跑即可。
- electron-builder 还需 `ELECTRON_BUILDER_CACHE`、`ELECTRON_BUILDER_BINARIES_MIRROR`。
- 类型检查可绕过 npm run（管道 EPERM）：`node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json --composite false`（web 同理）。
- dev 模式**主进程改动需重启** start-dev.cmd（渲染层才热更新）。

---

## 4. 核心数据模型与关联关系

完整定义见 `src/shared/types.ts`。最关键两个实体：

```typescript
// 对话元数据（软状态机核心，持久化于 chats/<chatId>.meta.json）
export interface ChatMeta {
  id: string
  projectId: string
  kind: 'project' | 'doc' | 'context'   // 项目级 / 文档级(无滑块) / 上下文对话(有滑块)
  docId?: string                          // doc/context 对话关联的写作文档
  title: string
  status: 'normal' | 'user_archived' | 'orphan_archived'
  createdAt: string
  updatedAt: string
  contextRange?: ContextRange             // 上下文对话的 {before, after, anchor, selection…}
  action?: 'diagnose' | 'plot' | 'optimize'  // 右键创建的动作（图标徽标用）
  lockedRange?: { before: number; after: number }  // 只能扩大的下限（持久化，重开恢复）
  injectionOverrides?: {
    disabled: string[]                    // 开始前用户关闭的注入键
    active?: string[]                     // 首条消息冻结的激活键
    pending?: string[]                    // 开始后手动开启、尚未随消息使用的键（可再关）
  }
}

// 文档摘要 = 故事拆解 + 触发快照（持久化于 summaries/docs/<docId>.json）
export interface DocSummary extends StorySummary {
  snapshotLength: number   // PRD 7.2 触发条件分母
  snapshot: string         // 上次摘要时的全文快照（算“增删改字符总量”）
  updatedAt: string
}
// StorySummary = { overview, characters[{name,aliases,role,goal}], plot[{id,function,summary}],
//                  foreshadowing[{planted,status}], keySettings[], keyQuotes[] }

// 资源摘要（summaries/resources/<id>.json）= { updatedAt } & (StorySummary | GenericResourceSummary)
// 对话摘要（summaries/chats/<id>.json）= { items[{messageId,role,summary}], lastMessageId, messageCount }
```

**关联关系**：`Project 1—N Doc`，`Doc 1—N Chat(kind=doc/context)`，`Project 1—N Chat(kind=project)`；
`Chat 1—1 ChatSummary`、`Doc 1—1 DocSummary`、`Resource 0—1 ResourceSummary`；
摘要文件物理删除随主体走（`file.service.ts` 的 purge/delete 系列负责）。

注入键约定：`'fulltext'`、`'doc:<id>'`、`'chat:<id>'`、`'res:<id>'`——主进程与渲染层共用（`api.service.ts collectApplicableKeys` / `ChatPane injectionItems`）。

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
- [x] 文档摘要 = 故事拆解（预算 60% 一次调用，超限拒绝提示；黄点生成中→绿点）
- [x] 对话摘要（关闭窗口后台生成，逐条、变化检测、手动重新生成）
- [x] 资源蒸馏（启发式预筛+模型判定+置信度 0.8 兜底+不确定确认+force；取消蒸馏即移除）
- [x] 注入配置（设置页按对话类型勾选）+ 每对话开关面板（冻结/锁定/pending 机制）
- [x] Token 用量（按月/按小时/lifetime，总消耗+摘要标题两条折线；标题生成计入 summary 来源）
- [x] Git 版本管理（每项目一仓库、自动提交、版本历史、回滚、身份自动补齐、手动提交按钮）
- [x] 导出（单文档 md/txt；项目 Zip 选项）
- [x] 工作目录迁移（物理复制含 .git、校验、原子生效、EPERM 重试、成功同步界面）
- [x] 异常退出恢复（恢复标记+启动提示）
- [x] 错误日志（userData/logs，按天、保留 7 天，主进程/IPC/渲染层全覆盖）
- [x] 设置（API 配置+联通测试+模型列表获取下拉/手动兜底、语言 zh/en、自动保存、摘要、版本、用量）
- [x] i18n（界面文案 zh/en 完整双语；语言切换联动 LLM 输出语言与摘要语言）
- [x] 提示词风格：理性务实（结论先行、少客套）
- [x] 正式命名 氛围写作 / VibeWrite（窗口标题/侧栏/提示词/安装器/快捷方式）

---

## 6. 待办事项与已知 Bug

### 待办（下一步）

1. **应用图标**：当前用默认 Electron 图标（electron-builder 提示 "default Electron icon"）。在 `build/icon.ico` 放置图标并在 `electron-builder.yml` 配置。
2. **代码签名**：`win.signAndEditExecutable=false`（因无证书且规避 winCodeSign 符号链接解压问题）。有证书后恢复并配置 `CSC_LINK`。
3. **主进程错误文案英文化**：i18n 目前只覆盖界面；主进程返回的错误（如“未配置 API Key”）仍为中文（用户知情并接受，计划后续补）。
4. **多模型支持**：PRD 限定单模型；已预留扩展点 `summary.modelOverride`（config 字段直接加即可）。
5. （可选）非推理模型的“提示式思考”开关（当前 CoT 仅展示模型原生 reasoning_content）。

### 已知边界 / 未修复项（出现路径）

- **超长文档蒸馏**：输入 > 模型上下文上限 60% 直接拒绝并提示调大上限（用户明确要求不做分块）。路径：`summary.service.ts callStoryDecomposition/callGenericDecomposition`。
- **中文模型 token 估算为近似**：DeepSeek/GLM/Qwen 等按 ~1.1 token/字估算（`summary.service.ts estimateInputTokens`），可能造成边界误判（可调大设置中的上下文上限）。
- **旧版本数据无兼容**：注入冻结（`injectionOverrides.active`）对旧对话不做迁移（用户明确“重新建对话测试”）。旧摘要文件（三字段版/单标签版）读取时按无效丢弃并重新生成（`file.service.ts readDocSummary/readChatSummary`）。
- **重新生成“上一版回答”仅在内存**：不持久化，重开窗口后对照块消失（`ChatPane prevAnswer`）。
- **对话摘要重新生成的 UI 刷新用 2.5s 定时器兜底**（`SummaryArea regenChat`），正常由 `summary:status` 事件驱动。
- **dev 模式关命令行窗口会强杀进程**：自动提交可能丢失；请用窗口 × 正常关闭或“立即提交”按钮。
- **Windows 上 rename 覆盖已存在目录会 EPERM**：迁移已修复（先移除空目标+重试）；其他同类操作（如有新增）需沿用 `renameDirAtomically` 模式。

---

## 7. 关键业务逻辑解释

### 7.1 摘要注入管线（每次发送消息都会走）

`api.service.ts buildMessages`：
1. `collectApplicableKeys(chat, cfg, tree)` → 该对话按类型+全局配置可注入的候选键（fulltext / doc: / chat: / res:）。
2. `computeActiveKeys(chat, applicable)` → **激活键状态机**：
   - 未冻结（首条消息前）：激活 = 候选 − `disabled`；
   - 已冻结：激活 = 候选 ∩ (`active` ∪ `pending`)。
3. 上下文块：context 对话取切片（`sliceContext`+`buildContextBlock`）；doc 对话读全文并触发 `ensureDocSummary`（PRD 7.2 的 30%/500 字触发，阻塞式“方案 a”），`fulltext` 仅当激活。
4. `injectSummaries` → 文档摘要 > 资源快照 > 对话摘要 > 资源摘要 按优先级组装。
5. `applyBudget` → 预算裁剪顺序（从低到高丢）：历史 → 资源摘要 → 对话摘要 → 快照 → 文档摘要 → 最后截断上下文块。输入预算 = `contextLimit * 0.8`。

### 7.2 注入开关的“冻结/锁定/pending”状态机（渲染层 ChatPane）

- 首条消息发出（`send` 中 `messages.length===0` 分支）：把当前开启键冻结为 `active` 并持久化（chatPatch）。
- 开始后：`active` 键**锁定**（不能关）；未激活键（新摘要或此前关闭的）可**开启**→ 进 `pending`（可再关）；`pending` 键随下一次 send（普通或重新生成）并入 `active` 并锁定。
- 打开已开始对话时检测到“新摘要”（候选 − active − disabled − pending）→ 一次性 toast。
- 主进程侧同一套逻辑（`computeActiveKeys`）保证注入一致。

### 7.3 上下文范围“只能扩大” + 重新生成联动

- 锁定下限 `lockedRange` 持久化在 ChatMeta；`ContextPanel` 用 `minBefore/minAfter` 钳制滑块。
- 变化时（`ChatPane updateRange/toggleInjection`）合并原因：`regenerateReason = 'context' | 'summary' | 'both'`，只弹一次提示、只重新生成一次。
- 主进程 `buildRegenerateGuidance`：对比 `lockedRange` 与当前范围算出**新增前后文片段**，或读取 `newlyEnabledSummaries` 对应摘要，生成“用户不满意+新增内容”的引导块；`replaceLastAssistantMessage` 替换最近回答并保留 reasoning。

### 7.4 蒸馏判定状态机（`summary.service.ts distillResource`）

`heuristicClassify`（零成本，**极保守**：仅当另一类信号为零才直接判定）→ 弱信号走 `classifyByLlm`（头/中/尾三段采样，输出 `{type, confidence, reasons}`）→ 置信度 `<0.8` 返回 `uncertain`（渲染层确认后带 `force` 重试）→ 与所选不符返回 `mismatch`（附理由）→ 生成对应摘要（故事/通用）。所有摘要 LLM 调用走 `enqueueLlm` 全局串行队列（并发 1），空结果/`finish_reason=length` 自动重试一次。

### 7.5 其他关键机制（函数名索引）

- 原子写：`util.ts atomicWrite`（临时文件+rename+EPERM 退避+按文件串行队列）——曾修复滑块高频保存的 EPERM。
- 单实例/文件关联：`main/index.ts`（`requestSingleInstanceLock` + `second-instance`）。
- 退出流程：`before-quit` → `flushRenderer`（渲染层落盘握手 `app:flush`/`app:flushed`）→ `commitAllProjects` → `waitForSummaryQueue(8000)` → `clearRecovery` → `app.exit(0)`。
- Git 身份：`git.service.ts ensureCommitIdentity`（应用配置优先，缺失写仓库级默认 VibeWrite）。
- 摘要生成状态：`summary.service.ts markGenerating/markDone` → 广播 `summary:status` → 摘要区黄点/绿点。
- 生命周期：元数据 `status` 字段驱动（`file.service.ts` 的 delete/restore/purge 系列），物理删除仅在 purge。
- 错误日志：`log.service.ts logError`（按天文件，7 天清理；IPC wrapper、`uncaughtException`、渲染层 `window.onerror` 全覆盖）。

---

## 8. 编码规范与约束

- **缩进**：2 空格；**无分号**；**单引号**；文件命名 kebab-case；TS 变量 camelCase；JSON 字段 camelCase。
- 类型：跨进程类型只放 `src/shared/`；IPC 新增通道必须同步改三处——`shared/ipc.ts`（通道+`IpcApi` 类型）、`main/ipc/index.ts`（handler）、preload 无需改（泛型桥自动覆盖）。
- 所有文件写入用 `atomicWrite`；所有异步 LLM 调用设超时（180s）且 `maxRetries: 0`。
- 渲染层不直接接触 Node/网络：一律走 `window.api`（preload 白名单）。
- **潜规则**：
  - 禁止任何第三方分析/统计 SDK；**安装包只允许包含 `out/**` 与 `package.json`**（打包后必须 `asar list` 核验无用户数据——隐私红线）。
  - AI 侧不提供任何“写回编辑器/一键应用”的 IPC（PRD 0.2 边界）。
  - API Key 明文不出主进程；渲染层只问 `hasApiKey`。
  - 提示词/摘要输出语言跟随 `config.language`；界面文案一律走 `src/renderer/src/i18n`（禁止硬编码中文）。
  - 主进程错误文案暂用中文（已知债务）；新代码需落错误日志。
  - 依赖克制：原子写/防抖/串行队列均为自研小实现（替代 write-file-atomic/lodash.debounce/p-queue）。
  - 每次可运行改动都提交 Git（基线 `e176cbb` 可回滚）。

---

## 9. 遗留技术债务

| 债务 | 现状 | 计划 |
| --- | --- | --- |
| 无应用图标 / 无签名 | 默认 Electron 图标；`signAndEditExecutable=false` | 待图标与证书就绪后在正式发布前补齐（见 §6） |
| 主进程错误文案中文 | 界面 i18n 完成，主进程错误未英文化 | 计划在语言设置完善时统一 |
| 单模型限制 | 摘要复用主模型；已留 `summary.modelOverride` 扩展点 | 多模型需求出现时按 PRD 升级 |
| 中文 token 估算近似 | DeepSeek 等按 1.1 token/字 | 若引入 DeepSeek 官方 tokenizer 可替换 `estimateInputTokens` |
| 摘要区对话摘要刷新兜底定时器 | `SummaryArea.regenChat` 用 setTimeout(2.5s) | 事件驱动已覆盖，定时器仅为兜底，可后续移除 |
| “上一版回答”对照不持久化 | 仅内存 | 如需历史对照，给 ChatMessage 增加 prevContent 字段并落盘 |
| 沙箱缓存目录占用仓库空间 | `.npm-cache/.electron-cache/.electron-builder-cache` | 已 gitignore；如仓库迁移可整体删除后重装 |
| 旧摘要格式只读不迁移 | 读取时判定无效即丢弃重生成 | 无迁移计划（用户明确不需要） |

---

## 10. 可借鉴的工程经验

1. **文档驱动开发**：PRD（806 行）+ 技术栈文档先行，验收标准逐条映射实现；每轮需求变更先“报根因+边界问题”再动手，改动全部 commit 可回滚。
2. **受限网络/沙箱环境作战手册**：npmmirror 镜像（`electron_mirror`/`electron_builder_binaries_mirror`）、`electron_config_cache` 重定向、`--foreground-scripts` 绕开 npm 管道 EPERM、构建提权跑 esbuild、关闭签名绕开 winCodeSign 的 darwin 符号链接解压失败。
3. **Electron 踩坑清单**：渲染层 `window.prompt` 不支持（自定义对话框）；`simple-git customBinary` 对含空格路径要开 `unsafe.allowUnsafeCustomBinary`；空仓库 `git log` 抛错需捕获；`fs.rename` 覆盖已存在目录 EPERM（先删空目标+退避重试）；dev 模式主进程改动必须重启；`safeStorage`（DPAPI）存 Key。
4. **隐私打包红线**：`files` 白名单只放 `out/**`+`package.json`，打包后用 `asar list` 逐文件核验。
5. **LLM 工程技巧**：预算分档（60% 一刀切 > 过度设计的分块合并）、三段采样分类、结构化 JSON 输出 + 括号配平“截断抢救”解析、空结果/截断自动重试、全局串行队列防并发堵塞、中文模型 token 近似估算。
6. **状态机落库**：UI 交互的锁定规则（冻结/锁定/pending、只能扩大）必须**持久化到 meta 并主/渲染双端共用同一判定**，否则重开即失效或两端不一致。
7. **错误可观测性**：所有 IPC 异常自动落日志（按天轮转），让用户直接贴 log 定位问题，避免“看不到提交记录”这类静默失败。
