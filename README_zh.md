# 笔伴（Penpal）

笔伴是一款面向写作者的 Windows 桌面写作辅助软件。它帮助你组织写作项目、编辑文档、管理参考资料，并通过受控的 AI 对话辅助创作判断。

> 笔伴的定位是辅助作者，而不是替代作者。AI 的建议会停留在对话区；笔伴不会在你不知情的情况下改写写作文档，也不会替你发布最终作品。

## 下载与发布附件

普通用户只需要从 GitHub Release 的附件中下载并安装 `Penpal-0.1.0-win-x64-setup.exe`。Windows 安装包已经自带本地嵌入模型，安装后即可使用，普通用户不需要另外下载或手动配置模型。

单独提供的 `bge-small-zh-onnx.zip` 主要用于从源码构建软件的开发者，以及需要手动校验或重新打包模型的场景。使用 Windows 安装包时不需要下载这个模型附件。
## 功能特色

- 基于本地工作区的项目与文档管理。
- 纯文本与 Markdown 编辑，支持字号调整、段落对齐、首行缩进、字符统计、保存和导出。
- 支持项目级对话、文档级对话，以及围绕选中文字展开的有滑块文档级对话。
- 右键快捷发起“诊断”“优化”“走向”三类写作辅助任务。
- 资源区支持 TXT、Markdown、CSV、DOC、DOCX 文件。
- 支持资源蒸馏，并根据相关度进行摘要注入。
- 支持原文检索，以及面向长项目的可选本地向量索引。
- 支持项目 Git 历史、归档、回收站、恢复和导出流程。
- 本地优先存储；API Key 使用 Windows 数据保护能力进行保护。
- 内置“软件功能指引”项目，方便首次使用者快速了解功能。

## AI 服务商

笔伴使用 OpenAI 兼容的 API 调用方式，并针对不同服务商和模型的差异做了兼容处理。你可以在设置窗口中配置 API Base URL、API Key、模型名称和模型上下文上限。

不同模型对工具调用、结构化输出、reasoning 字段、上下文长度等能力的支持并不完全一致。如果请求失败，请优先检查当前服务商文档中该模型支持的参数和能力。

## 本地嵌入模型

笔伴使用 BAAI `bge-small-zh-v1.5` ONNX 模型作为可选的本地向量检索模型。Windows 安装包已经内置该模型，安装后即可使用，普通用户不需要下载或手动放置模型文件。为了保持源码仓库轻量，模型文件不会提交到 Git。从源码构建软件时，开发者需要获取经过校验的模型包，并在打包前将其放置到 `models/bge-small-zh-onnx/` 目录。

必需模型文件：

- `model.onnx`
- `config.json`
- `tokenizer.json`
- `tokenizer_config.json`
- `special_tokens_map.json`
- `vocab.txt`

解压模型附件后，请运行 `npm run verify:embedding-model` 校验模型完整性。模型附件中已经包含一份模型许可证文本。源码和打包应用中包含的许可证信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 运行要求

- 当前应用目标平台为 Windows x64。
- 从源码开发需要 Node.js 20 或更新版本。
- Git 不是基础写作功能的必需项，但项目版本历史功能需要 Git。未检测到 Git 时，应用会给出提示。

## 快速开始

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建 Electron 应用
npm run dist       # 构建 Windows 安装包
```

开发时请在终端中运行上面的命令。要运行已经构建好的应用，请从 Release 附件下载 Windows 安装包。

首次启动时，请选择一个专门的工作区文件夹。项目、写作文档、对话、资源和摘要都会保存在该工作区中。请不要将真实创作数据提交到源码仓库。

## 数据与隐私

- 用户工作区不会被包含在应用安装包中。
- 根据你的配置，当前对话内容和被选中的上下文可能会发送给你配置的 AI 服务商。
- 请不要提交 API Key、Authorization Header、私人创作内容或个人路径。
- 本仓库有意排除了本地研究笔记、私有服务商文档、审计记录和测试工作区。

## 仓库结构

```text
src/main/       Electron 主进程、存储、AI、摘要、检索和后台任务
src/preload/    类型化 contextBridge 与 IPC 白名单
src/renderer/   React 界面、编辑器、左侧栏、对话和设置
scripts/        构建与校验脚本
build/          应用图标与构建资源
```

## 许可证

笔伴以 MIT License 发布，见 [LICENSE](LICENSE)。第三方组件和模型许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 贡献与安全

提交 Pull Request 前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。如果需要报告安全问题，请按照 [SECURITY.md](SECURITY.md) 中的说明进行私下报告；请不要在公开 issue 中发布凭证或用户数据。