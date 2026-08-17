# 内置神经嵌入实施报告（2026-08-17）

## 1. 本轮目标与范围

本轮只处理本地向量检索的小模型接线，不扩展摘要/蒸馏 P1、模型选择 UI 或其他产品功能。

目标：在 Electron 主进程内优先使用本地 `bge-small-zh-v1.5` ONNX 生成中文语义向量；模型或原生运行时出现任何故障时，自动回退原有特征哈希，不能阻断对话和记忆规划。

## 2. 最终方案

- 运行位置：Electron 主进程。
- 推理栈：`@huggingface/transformers@4.2.0` + `onnxruntime-node@1.24.3`。
- 首发平台：Windows x64 CPU。
- 模型：`bge-small-zh-v1.5` FP32 ONNX。
- 输出：CLS pooling、L2 normalize、512 维。
- 查询：添加 `为这个句子生成表示以用于检索相关文章：`；文档块不添加指令。
- 推理批量：4。
- 兜底：现有 `fnv-ngram-256`，256 维。

模型标识固定为：

```text
bge-small-zh-v1.5-onnx-fp32-cls-qinst-v1
```

标识包含模型、精度、池化和查询指令版本。以后只要这些语义条件变化，就应使用新标识触发旧索引重建。

## 3. 代码与数据链路

### 3.1 模型加载

`src/main/services/neural-embed.service.ts`：

1. 开发环境从 `<repo>/models/bge-small-zh-onnx/` 加载；安装包从 `process.resourcesPath/models/bge-small-zh-onnx/` 加载。
2. 动态 import Transformers.js，设置 `allowLocalModels=true`、`allowRemoteModels=false`。
3. 显式使用绝对目录、`subfolder:''`、`dtype:'fp32'`、`device:'cpu'`。
4. 检查必要模型文件、输出形状、有限值、维度和向量范数。
5. 加载/推理失败后释放 pipeline，并进入 30 秒冷却；调用方得到 `null` 或异常后切换哈希。
6. 应用正常退出前主动 dispose。

### 3.2 分块

神经路径不再沿用 800 字硬切：

- 使用模型自身 tokenizer 精确计数；
- 每块最多 480 个内容 token，为 `[CLS]`、`[SEP]` 等特殊 token 留余量；
- 相邻块重叠最多 48 token；
- 在上限附近优先回退到换行、句号、问号、叹号、分号；
- 块内容始终来自原文 substring，不经 tokenizer decode 重建。

哈希路径保留原行为：800 字目标、100 字重叠。

### 3.3 索引一致性与回退

`src/main/services/vector.service.ts` 将索引升级到 schema v2：

- 索引记录 `embedModel`；
- schema、模型标识或向量维度不一致时全量重建；
- 单个索引只允许一种后端，禁止 512 维与 256 维向量混合；
- 神经构建任一步失败时丢弃内存中的中间块，从头使用哈希重建；
- 神经查询推理失败时改建哈希索引后再执行查询；
- 同一项目的并发构建通过 SingleFlight 合并；
- 空项目可以保存合法的零块索引，不会在每次查询时反复重建。

### 3.4 打包

- `electron.vite.config.ts` 外部化 Transformers.js、`onnxruntime-node`、`onnxruntime-web`，避免 Vite 打包原生 `.node`/WASM。
- `electron-builder.yml` 使用 `extraResources` 只复制六个模型运行文件，模型不进入 asar。
- 原生 ORT 和 sharp 相关模块使用 `asarUnpack`。
- 首发包裁掉 darwin、linux、Windows arm64、DirectML、DX 编译器及 ORT Web WASM/源码/source map 等无关资产。
- 裁剪后仍保留 Transformers.js Node ESM 所需的 ORT Web 模块入口；已从裁剪后的 `app.asar` 完成加载烟测。
- `npm run dist` 与 `npm run dist:dir` 会先执行模型完整性检查。

## 4. 完整性与隐私

打包前检查：

- 六个必要文件存在、为非空普通文件；
- `hidden_size=512`；
- `max_position_embeddings=512`；
- tokenizer `model_max_length=512`；
- `model.onnx` 和 `tokenizer.json` SHA-256 与批准资产一致。

隐私边界：

- 本地嵌入禁止远程模型下载；
- 文档与查询只在本机推理；
- `vector-events-YYYY-MM-DD.jsonl` 只记录阶段、后端、成功/失败、耗时、块数和截短错误；不记录项目 ID、查询、原文或向量；
- `models/`、原始权重目录、失败复现文档、构建输出均不进入 Git。

## 5. 验证结果

截至 2026-08-17 已通过：

- `npm run typecheck:node`；
- `npm run typecheck`；
- `npm run verify:embedding-model`；
- `npm run build`；
- `npm run dist:dir`；
- `npm run dist`：正式 NSIS 安装器构建成功，`dist/VibeWrite Setup 1.3.0.exe` 为 141,568,588 bytes（约 135.0 MiB），blockmap 为 148,572 bytes；
- `git diff --check`；
- Node 模型推理：`[1,512]`、L2≈1；
- Electron 33.4.11 开发依赖推理：`[2,512]`、L2≈1；
- 从裁剪后 `dist/win-unpacked/resources/app.asar` 加载 Transformers.js/ORT，并从 `resources/models/` 推理成功；
- 精确 tokenizer 长文本分块：多种中英混合、无标点、emoji 文本均未超过 480 token；
- 隔离工作区全链路：神经索引、语义查询、并发构建、schema v1→v2、模型缺失哈希回退、模型恢复重建、空项目稳定索引均通过。

裁剪后 `dist/win-unpacked`：约 427.7 MiB。确认无 darwin/linux/arm64 ORT、DirectML/DX 库和 ORT Web WASM；Windows x64 `onnxruntime_binding.node`、`onnxruntime.dll` 与六个模型文件存在。

## 6. 尚待决定的后续方向

以下不是本轮接线失败项，而是下一阶段可选工作：

1. **真实语料召回验收（建议最高优先）**：在用户实际小说项目中观察“本次记忆”向量命中，比较同义表达、人物别名、跨章节伏笔和抽象关系查询；据结果决定是否调整查询指令、分块、top-k、阈值或更换模型。
2. **索引 freshness**：当前文档/资源正文修改后不会自动使索引失效。建议给索引记录源指纹，并在保存后采用防抖全量重建或按源增量替换块。
3. **构建进度与取消**：大型项目首次索引可能耗时且占用数百 MB 内存，目前没有面向用户的进度、取消和“正在使用神经/哈希后端”状态展示。
4. **完整安装器验收**：还需实际安装/卸载 NSIS，在普通用户权限、离线环境、中文路径、低内存机器上测试首次加载、退出释放和杀毒软件误报。
5. **模型资产供应链**：模型不入 Git，因此发布机必须预置经过哈希校验的六个文件；后续需要决定是否建立受控下载、发布资产仓库或 CI 缓存流程。
6. **平台范围**：当前 builder 主动裁成 Windows x64 CPU；若支持 Windows arm64、macOS 或 Linux，需要分别恢复并验证对应 ORT 二进制与打包配置。
7. **索引格式与空间**：JSON 直接存储 512 维浮点数组，项目很大时体积和解析成本会增长。真实规模验证后可评估 Float32 二进制、压缩或轻量 ANN 索引，但不建议在没有规模证据前提前复杂化。

## 7. 本轮不做

- 不修改摘要/蒸馏生成机制；
- 不增加用户可选嵌入模型 UI；
- 不允许网络下载模型；
- 不删除特征哈希兜底；
- 不把模型、失败文档或构建产物提交到 Git。