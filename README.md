# Penpal

> Chinese users can read [README_zh.md](README_zh.md).

Penpal is a Windows desktop writing assistant for authors. It helps you organize projects, edit documents, manage reference material, and use controlled AI conversations to support creative decisions.

> Penpal assists the author; it does not replace the author. AI suggestions stay in the conversation area. Penpal does not silently rewrite your writing documents or publish a finished work without your decision.

## Download

For end users, download the Windows installer from the GitHub Release attachments:

- `Penpal-0.1.0-win-x64-setup.exe` — Windows x64 installer.
- `bge-small-zh-onnx.zip` — optional local embedding model package for vector retrieval.

The model package is optional. If you want to use local vector retrieval, extract its `bge-small-zh-onnx/` directory under `models/`, then launch Penpal. The installer and model package are distributed as Release attachments rather than committed to the source repository.
## Features

- Project and document management backed by a local workspace.
- Plain-text and Markdown editing with font size, paragraph alignment, first-line indentation, character count, save, and export features.
- Project conversations, document conversations, and slider-based conversations focused on selected text.
- Context actions for diagnosis, literary optimization, and story-direction exploration.
- Resource management for TXT, Markdown, CSV, DOC, and DOCX files.
- Resource distillation and relevance-based summary injection.
- Original-text retrieval and optional local vector indexing for long projects.
- Project Git history, archive, recycle bin, restore, and export workflows.
- Local-first storage. API keys are protected with the Windows data-protection facilities.
- An in-app feature guide project for first-time users.

## AI providers

Penpal uses OpenAI-compatible API conventions and includes compatibility handling for provider and model differences. Configure the API base URL, API key, model name, and model context limit in the settings window.

Models differ in their support for tools, structured output, reasoning fields, and context length. When a request fails, check the provider documentation for the selected model and its supported parameters.

## Local embedding model

Penpal uses the BAAI `bge-small-zh-v1.5` ONNX model for optional local vector retrieval. To keep the source repository lightweight, the model files are not committed to Git. Windows releases should provide the verified model package as a GitHub Release attachment and place it at `models/bge-small-zh-onnx/` before running packaged builds.

Required model files:

- `model.onnx`
- `config.json`
- `tokenizer.json`
- `tokenizer_config.json`
- `special_tokens_map.json`
- `vocab.txt`

Run `npm run verify:embedding-model` after extracting the model attachment. The release attachment should include the model license text copied from `THIRD_PARTY_LICENSES/BAAI-bge-small-zh-v1.5-LICENSE.txt`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for license information.

## Requirements

- Windows x64 for the current application target.
- Node.js 20 or newer for source development.
- Git is optional, but required for project version history. The application provides a fallback message when Git is unavailable.

## Quick start

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run typecheck  # TypeScript checks
npm run build      # Build the Electron application
npm run dist       # Build a Windows installer
```

For development, run the commands above from a terminal. To run an already-built application, use the packaged Windows installer from the Release attachments.

On first launch, choose a dedicated workspace folder. Projects, documents, chats, resources, and summaries are stored there. Do not commit real writing data to this repository.

## Data and privacy

- User workspaces are not included in the application package.
- Depending on your configuration, the current conversation and selected context may be sent to the AI provider you configure.
- Never commit API keys, authorization headers, private writing, or personal paths.
- This repository intentionally excludes local research notes, private provider documents, audit records, and test workspaces.

## Repository layout

```text
src/main/       Electron main process, storage, AI, summaries, retrieval, and tasks
src/preload/    Typed contextBridge and IPC allowlist
src/renderer/   React UI, editor, sidebar, chat, and settings
scripts/        Build and verification scripts
build/          Application icons and build resources
```

## License

Penpal is released under the MIT License. See [LICENSE](LICENSE). Third-party component and model notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and security

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security issues privately as described in [SECURITY.md](SECURITY.md); do not publish credentials or user data in an issue.
