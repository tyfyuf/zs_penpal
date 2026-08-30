# 笔伴 Penpal —— 桌面端写作专精辅助 Agent

依据 `writing-agent-prd-v1.3.md` 与 `writing-agent-tech-stack-v1.0.md` 实现的 Windows 桌面端写作辅助 Agent。

**核心边界**：辅助创作者决策，不替代创作者完成写作成果。AI 不自动修改写作文档、不自动生成/替换/导出成品文件；AI 输出只显示在对话区，由用户手动复制粘贴。

## 技术栈

Electron 33 + React 19 + TypeScript + electron-vite + CodeMirror 6 + Tailwind CSS 4 + Zustand 5 + OpenAI 兼容流式 API + 系统 Git（simple-git）+ safeStorage（DPAPI）+ archiver + Recharts + js-tiktoken。

## 已实现功能

- **单实例与文件关联**：第二实例静默退出并把路径转交第一实例；`.txt/.md/.csv` 打开/导入，非文本文件拒绝提示。
- **文件化存储**：工作目录即数据，无数据库；项目索引 `app-index.json`，文档、对话（JSONL）、摘要、资源均以 Git 可读文本文件保存；全部原子写入。
- **数据生命周期**：文档/项目软删除→回收站→彻底删除；对话用户归档/孤儿归档/彻底删除；彻底删除文档时关联对话转孤儿归档，恢复时按关联关系还原；恢复同名冲突默认重命名。
- **Git 版本管理**：每项目一个仓库，正常关闭时按项目自动提交（系统时间戳）；版本历史查看与回滚；开关关闭时保留仓库但停止相关功能；Git 缺失时三级降级安装（winget → PortableGit → 手动提示）。
- **流式 AI 对话**：OpenAI 兼容协议、`include_usage`、`AbortController` 取消、失败提示、取消仅保留用户消息。
- **右键上下文（核心入口）**：编辑器中「诊断 / 走向 / 优化」创建文档级上下文对话；前后文滑块 + 精确输入框 + 编辑器实时高亮；边界禁用；输出后调整范围提示重新生成。
- **摘要系统**：文档摘要（核心冲突/角色动机/章节功能）按 PRD 7.2 触发条件更新；聊天摘要（索引标签）在关闭对话窗口后后台生成；串行队列，退出时等待或超时。
- **用量统计**：按月分文件、按小时稀疏聚合、lifetime 独立累计；近 30 天与当日逐小时折线图；缺失 `usage` 计入未计入。
- **资源与快照**：仅文本文件；会话内上传写入对话内部快照，历史会话不受原文件后续修改影响。
- **导出**：单文档导出 MD/纯文本；项目导出 Zip（文档与资源默认勾选，聊天/归档/摘要/Git 可调整）。
- **工作目录迁移**：物理复制（含 `.git`）到暂存目录、校验后原子生效，失败保持原目录可用。
- **异常退出恢复**：恢复标记记录最后打开内容，启动提示恢复，正常关闭清除。
- **编辑器**：CodeMirror 6 纯文本（`.md` 不渲染）、行号、字号调节、暗黑/浅色主题、自动保存（防抖）、脏状态标记、新建文档 LF/UTF-8、打开保留原换行符。

## 目录结构

```
src/
  main/        主进程：窗口/单实例、文件仓储、Git、AI、摘要、用量、导出、恢复、迁移、安装器
  preload/     contextBridge 类型化 IPC 白名单
  renderer/    React：侧栏树、标签页、编辑器、聊天、上下文面板、设置、用量图表
  shared/      共享数据模型与 IPC 契约（types.ts / ipc.ts）
```

工作目录形态（生命周期状态存于元数据 JSON，删除/恢复只改状态，彻底删除才物理删文件）：

```
<工作目录>/
  app-index.json
  <project-id>/
    meta.json
    docs/<doc-id>.meta.json + <doc-id>.md
    chats/<chat-id>.meta.json + <chat-id>.jsonl + <chat-id>.snap-<snapshotId>.json
    summaries/docs/<doc-id>.json   summaries/chats/<chat-id>.json
    resources/<file-id>/meta.json + content
    .git/
```

userData（Electron）：`api-key.enc`、`app-config.json`、`portable-git/`、`usage/<YYYY-MM>.json`、`lifetime.json`、`recovery.json`、`summary-retry.json`。

## 运行

```bash
npm install        # 依赖（见下方国内镜像说明）
npm run dev        # 开发模式（electron-vite dev，HMR）
npm run typecheck  # 类型检查
npm run build      # 构建到 out/
npm run dist       # 打包 Windows 安装包（electron-builder + NSIS）
```

已内置 `.npmrc`（npmmirror 镜像 + electron 镜像），国内环境可直接安装。

### 更便捷的启动方式

1. **安装后从桌面 / 开始菜单启动**：运行 `dist\Penpal Setup 1.3.0.exe`，安装完成后自动在桌面（快捷方式名“笔伴”）与开始菜单创建快捷方式，双击即可启动。
2. **免安装双击启动（生产构建）**：双击项目根目录的 `start.cmd`，直接运行 `out/` 已构建产物（无需终端命令）。
3. **开发模式（热更新）**：双击 `start-dev.cmd`，启动 electron-vite dev 并保持终端窗口。

### 打包说明

- 安装包产物：`dist\Penpal Setup 1.3.0.exe`（NSIS，含文件关联 `.md/.txt/.csv`）；解包版在 `dist\win-unpacked\Penpal.exe`。
- 安装包只包含 `out/` 构建产物与 `package.json`，**不包含任何用户数据**（工作目录、文档、对话、摘要、资源、API Key 与设置均在应用外部，不参与打包）。
- 因未配置代码签名证书，`win.signAndEditExecutable` 设为 `false`（跳过 exe 资源编辑与签名），并使用默认 Electron 图标；后续如需自定义图标/签名，在 `electron-builder.yml` 与 `build/` 中补充即可。
- 打包依赖 `electron_mirror` / `electron_builder_binaries_mirror`（已写入 `.npmrc`）从国内镜像下载 Electron 发行包与 NSIS 工具链。

## 关键工程决策与偏差说明

| 项 | 决策 | 理由 |
| --- | --- | --- |
| Tokenizer | `js-tiktoken`（纯 JS 版 tiktoken，cl100k/o200k 映射，未知模型保守回退） | 替代 WASM 版 tiktoken，避免 Electron 主进程打包时 WASM 加载不稳定 |
| 原子写入 | 自研 `atomicWrite`（临时文件 + rename） | 等价于 `write-file-atomic` 语义，规避其 ESM-only 与 CJS 输出的冲突 |
| 摘要队列 | 自研串行队列（并发 1） | 等价于 `p-queue` 语义，去依赖 |
| 防抖 | 自研 `debounce` | 等价于 `lodash.debounce`，去依赖 |
| 生命周期 | 元数据驱动（tech-stack 第 9 章），不物理移动目录 | 删除/恢复只更新 `status`，彻底删除才删文件 |
| 会话快照 | `chats/<chatId>.snap-<snapshotId>.json`（对话目录内平铺） | 满足“快照写入对话内部”，兼容 7.2 的平铺 `.jsonl/.meta.json` |
| Git 回滚 | `git reset --hard <hash>` | 完整回滚到该提交；前向提交进入 reflog（界面不暴露） |
| 联通测试 | `client.models.list()` | 兼容 OpenAI 兼容协议各服务商 |

## 验收

核心验收标准（PRD 第 9 章）已映射实现：不自动写入（AI 无写回编辑器 IPC）、快捷键优先级（CodeMirror keymap）、软删除/恢复/彻底删除、归档独立性、Git 隔离、资源权限与快照、上下文边界、输出后调整、摘要开关、未保存关闭、工作目录迁移、单实例文件传递、取消生成、流式 usage、异常退出恢复等。
