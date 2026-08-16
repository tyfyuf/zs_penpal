# VibeWrite 总结与蒸馏体系重构改进方案（v1.0，方案稿，待确认后实施）

> 依据：OpenFic（`research/OpenFic-main`）与 NeuroBook（`research/neuro-book-master`）本地源码精读报告 + VibeWrite 现状代码核对。
> 状态：只出方案，未改任何产品代码。

---

## 1. 对标项目记忆技术要点

### 1.1 OpenFic（会话压缩 + 项目级摘要，两套独立体系）

| 维度 | 机制 | 源码锚点 |
|---|---|---|
| 会话压缩存储 | `agent_context_compactions` 表：`session_id + start_seq/end_seq`（**非重叠区间**）+ 自由文本 summary + `source_input_tokens/summary_tokens` + trigger(auto/manual) | `backend/app/agent_runtime/persistence/model.py:60-103` |
| 压缩触发 | 自动：`context_tokens > max_context × AUTO_TRIGGER_RATIO(0.8)`；尾部保留 `min(TAIL_TOKEN_BUDGET=20_000, max_context × 0.5)`；可压缩量 < 2_000 token 或 < 2 turn 则放弃 | `context/compaction/config.py`、`graph/react_agent.py:242-330`、`context/compaction/window.py:78-116` |
| 压缩生成 | 单次 LLM 调用输出**自由文本**，固定小节：目标/决策和理由/相关内容/错误与修复/待办事项，无内容省略小节 | `prompts/session/compaction.yaml` |
| 读取（注入） | `apply_compaction_overlay`：把被压缩的 `[start_seq,end_seq]` 区间**整体替换**为一条 `<compaction-summary>` 消息——顺序替换，非累计摘要 | `context/compaction/overlay.py:20-65` |
| 项目级摘要 | `chapter_summaries` 表：单章摘要 + 每 10 章 `long_term` 聚合；状态机 `not_generated/queued/running/ready/failed`；**增量**生成；`source_content_normalized` + `source_chapter_summary_signatures_json`(sha256) 防漂移 | `storage/models/chapter_summary.py:11-41`、`memory/chapter/summary_generator.py` |
| 失效检测 | **惰性**：读时 `SequenceMatcher` 比对规范化源内容（去空白+标点），差异 > **100 字符**即 stale；长期摘要逐章比对 sha256 指纹 | `memory/chapter/summary_service.py:45,155-240` |
| 项目上下文注入 | 按阅读序分层：`latest`(当前章原文) → `near`(前 9 章原文) → `mid`(再前 10 章**摘要**) → `far`(长期区间摘要) → `chapter_list`(最新 50 章目录)；预算只估算、**无动态硬截断** | `memory/chapter/context_builder.py:52-125` |
| 检索式 | 工具 `read_chapter_summaries` / `read_range_summaries` / `list|read_character` / `list|read_world_entry`，均 `ready_only=True`（只读 ready 摘要） | `agent_runtime/tools/impls/context/*` |
| 生成协议 | **结构化工具调用**：`emit_chapter_summary`/`emit_long_term_summary`（Pydantic schema）**强制只调一次**；summary 200–300 字；"除工具调用外不输出任何内容" | `memory/chapter/summary_tools.py:8-61` |
| 刷新解耦 | refresh hooks 只在写成功后解析 diff 元数据、发变更事件，**不内联重算摘要** | `agent_runtime/tools/hooks/*_refresh.py` |
| 一致性兜底 | 无 llmlint；靠写前 `_ensure_non_overlapping` 冲突检测 + `filter_invalid` 修复残缺工具组；`canonical_mentions` 是"@引用 vs 实体改名"的引用规范化 | `persistence/compaction_repo.py:84-107`、`context/processors/filter.py` |

### 1.2 NeuroBook（事件溯源世界引擎 + 分层记忆）

| 维度 | 机制 | 源码锚点 |
|---|---|---|
| 会话落盘 | `.nbook/agent/sessions/{id}.jsonl`，append-only（header/entry/batch），compaction 只**新增** compaction entry，不删旧 | `server/agent/session/session-repo.ts`(L912)、`server/agent/harness/compaction.ts` |
| 世界状态存储 | SQLite 三表 `WorldSubject/WorldSlice/WorldPatch`：patch = 对某 subject 某 JSON Pointer 路径的一次 op（`replace/increment/remove/append`），**事件溯源**，slice=某时刻的一组 patch | `server/world-engine/repository.ts`、`types.ts` |
| 动态 vs 稳定分层 | 判据一句话：**"会随剧情变吗"**——变 → World Engine（动态状态）；不变 → `lorebook/`（稳定设定）；profile 私有跨会话记忆 → `agent-context/{profile}/` | `docs/agent/index.md` |
| 写入边界 | 世界状态只在**剧情拍板后**写；writer 对世界引擎**只读**（硬边界）；补历史 = 向更早 instant 插 backstory slice | `docs/agent/tools.md`、`reference/world-engine/workflow.md` |
| 压缩参数 | 触发：`contextTokens > contextWindow − reserveTokens(25_600)`；压后保留 `keepRecentTokens(24_000)`——**"何时压"与"压后留多少"两个独立阈值** | `server/agent/profiles/profile-runtime-settings.ts` |
| 会话总结 | 后台 `summarizer` profile 每 **16 次 source invocation** 生成 `{title≤32字, summary≤240字}`，由 harness 写回 session | 同上 L22-27 |
| 读取 | 检索式 `subject_rag_search`（embedding 检索 events/memory jsonl，按 subject 分区隔离）+ 注入式（HistorySet custom_message）；writer 收"建议读清单"后**用只读工具主动读**，不 preload 正文 | `docs/agent/subject-rag-memory.md`、`docs/tasks/archived/writer-payload-context-injection/README.md` |
| 矛盾检测 | **规则化 issue catalog**：E1 broken-relative / E2 dangling-ref / E3 invalid-path / E4 cross-ref / E5 embedding-whole-replace（error，必须修）；A1 base-shifted / A2 masked（advisory）——写入/扫描时现算，不靠模型"觉得不对" | `server/world-engine/world-issue-catalog.ts` |
| 文风检查 | llmlint 只查文风（360 条规则、默认启 266 条，静态+LLM 两层），**不负责设定一致性** | `docs/core/llmlint.md` |
| 记录粒度 | "最少支持当前叙事"：LOD0-3 记录粒度 + 五级关注度（★1-★5 ↔ 0-10 条 backstory）；临时 NPC 不建 subject；每 subject 通常 1-2 条 slice | `reference/world-engine/workflow.md`、`docs/tasks/64-world-engine-prompt-engineering/recording-principles.md` |
| Schema 约束 | Zod 定义全部 schema；`Ref()` 用 `.describe("ref:type")` 标引用、`.unique()` 标集合；worldbook 初始化五步 prompt（历法→schema→锚点→开局 slice→教查询） | `assets/**/world-engine/schema/index.ts`、`world-engine-initialization-requirements.md` |

---

## 2. VibeWrite 现状盘点（对照基线）

| 能力 | 现状 | 代码锚点 |
|---|---|---|
| 文档摘要 | 一次性全量故事拆解（全文输入，60% 预算硬拒绝，失败重试一次）；`DocSummary = StorySummary + snapshotLength + snapshot(全文)`；失效检测 `estimateChangedChars`（行级差集 + 长度差，阈值 30% 或净增 500 字）→ **整份重生成** | `summary.service.ts:439-507`、`types.ts:131-137` |
| 资源蒸馏 | 启发式预筛（零信号才判定）→ LLM 三段采样分类 → confidence<0.8 需确认 → 类型不符重选 → story/generic 分解；**无失效检测**（改资源文件后摘要不会过期） | `summary.service.ts:626-703` |
| 聊天总结 | 全量逐条总结（一次调用，对话截 12 000 字符），变化检测仅靠 lastMessageId+messageCount；**无区间元数据、无聚合层**；失败进 retry 队列 | `summary.service.ts:535-613` |
| 注入管线 | 全注入式；active/pending/disabled 冻结状态机；预算 = 上下文 80%，**纯动态裁剪**：历史 → 资源摘要 → 对话摘要 → 文档摘要 → 全文截断（单一优先级，不可配） | `api.service.ts:161-197,204-252` |
| 输出协议 | 自由 JSON + `parseJson` 截断抢救；字段无字数上限、无 schema 强制 | `summary.service.ts:134-234` |
| 一致性 | 无任何矛盾/漂移检测；无摘要来源指纹 | — |

**核心差距**（按重要性排序）：
1. **无失效检测**：资源摘要永不失效；文档摘要靠全文快照对比（存储翻倍且只查"改了多少"，不查"改在哪"）。
2. **无增量/聚合**：一切摘要都是"全量重算"，长文档、长对话成本线性膨胀，60% 预算硬拒绝后没有退路。
3. **预算模型单薄**：单一动态裁剪顺序，无法表达"近原文/中摘要/远聚合"的分层意图，也不可配置。
4. **无区间元数据**：聊天总结重复压缩有错乱风险；文档摘要无"已覆盖范围"概念。
5. **输出协议靠抢救**：字段漂移靠 normalize 兜底，无字数/枚举强约束。
6. **无一致性规则**：设定冲突、伏笔悬空、别名打架无人管。
7. **无"稳定 vs 动态"分层**：StorySummary 的 keySettings 与 characters 当前状态混在一起，设定漂移无法根治。

---

## 3. 改进方案（分五期，每期独立可交付）

### P0 摘要元数据 + 失效检测（成本低、收益最大，建议最先做）

1. **新增统一摘要元数据** `SummaryMeta`：`schemaVersion`、`sourceFingerprint`（规范化源内容 sha256：去空白+标点）、`sourceLength`、`createdAt/updatedAt`。三处摘要文件（doc/chat/resource）共用。
2. **DocSummary 瘦身**：`snapshot` 字段弃用 → 只留 `snapshotLength` + `sourceFingerprint`（省一半存储；旧格式读入时剥离 snapshot 补算指纹）。
   - 迁移：读旧格式时 `snapshot` 不再作为失效比对源，转为补算 fingerprint 后落新格式（一次性自动迁移，非批量）。
3. **资源摘要补失效检测**：注入/展示前读时惰性比对 fingerprint（读文件 → 规范化 → 比对 → stale 标记）。stale 的摘要：注入时降权（放注入清单尾部）+ 摘要区黄标"待更新"，用户一键重蒸馏（复用现有 regenerate 入口）。
   - 阈值：归一化差异 > 100 字符（借鉴 OpenFic `SUMMARY_STALE_DIFF_THRESHOLD=100`）或 长度变化 > 30%。
4. **聊天摘要补区间元数据**：`ChatSummary.items` 之外增加 `compacted: [{startIndex, endIndex, summary, updatedAt}]`（非重叠区间），写前查重叠（借鉴 `_ensure_non_overlapping`）。

**借鉴来源**：OpenFic 指纹/100 字符阈值/非重叠区间；NeuroBook schemaVersion 思路。
**成本**：低（~300 行 + 迁移逻辑）；**风险**：低（读写侧兼容分支）。

### P1 注入分层静态预算（中成本）

1. 把 `applyBudget` 从"总量 80% + 单一裁剪序"改为**分层配额**（可配置，写入 `AppConfig`）：
   - L0 关联文档全文/切片：30%
   - L1 文档摘要（含当前文档摘要）：30%
   - L2 资源摘要：20%
   - L3 对话摘要：10%
   - L4 对话历史：剩余（动态裁剪兜底）
   层内超配时按规则裁剪（L2/L3 按 updatedAt 新旧 + 内容量裁剪，L0 按现有 truncateToTokens）。
2. **双阈值分离**：`injectBudget`（80%，何时开始裁剪）与 `keepRecentBudget`（裁剪后历史至少保留多少，如 20%）——借鉴 NeuroBook reserveTokens/keepRecentTokens 分离思想。
3. 失效降权联动 P0：stale 摘要计入本层配额尾部，优先被裁。

**借鉴来源**：OpenFic latest/near/mid/far 分层；NeuroBook 双阈值。
**成本**：中（重写 applyBudget + 设置项 UI）；**风险**：中（预算行为变化需用户验证）。

### P2 聊天总结增量压缩 + 聚合层（中成本）

1. **增量压缩**：尾部保留窗口（最近 N 条逐条摘要，N 默认 20 或按 6 000 token 估）不重算；窗口之前的历史压缩为**区间摘要**（自由文本，固定小节：进展/决策/待办/关键设定变更，借鉴 OpenFic compaction.yaml）。
   - 触发：消息数 > 40 或 对话 token 估算 > 输入预算 60% 时，把尾部窗口之前的新增部分压缩进区间。
2. **聚合层 rollup**：每 10 条消息生成一条 ≤200 字聚合摘要（借鉴 OpenFic 每 10 章 long_term）；注入时先注 rollup，逐条摘要仅当配额充足时注入。
3. 区间写前查重叠（P0 已建元数据）。

**借鉴来源**：OpenFic 窗口压缩 + 区间替换 + 10 章聚合；NeuroBook summarizer 16 次触发。
**成本**：中（重写 generateChatSummary + 注入块构造）；**风险**：中（旧对话摘要迁移：旧 items 视为"全部逐条"，标记为"未压缩"）。

### P3 摘要生成协议强化（低成本，可与 P0 并行）

1. **Prompt 强化**（不依赖模型 function-calling 的基线）：三个分解 prompt 增加：字段枚举值约束（plot.function 枚举、foreshadowing.status 枚举）、字数上限（overview ≤200 字、plot 单点 ≤80 字、keySettings 每条 ≤40 字）、负例（"缺失信息留空数组/空串，禁止编造"）、"除 JSON 外不输出任何内容"（已有，保留）。
2. **解析后校验**：normalize 之外增加 `validateSummary`（必填字段存在性、枚举合法性、字数上限警告），校验失败按现有"重试一次"路径走。
3. **可选升级**：模型支持 function-calling 时走 `emit_story_summary` 工具协议（OpenFic emit_* 模式，强制一次调用），不支持时回退 JSON 文本协议。判定标准：`/api/models` 能力探测或模型名白名单。

**借鉴来源**：OpenFic emit_* + Pydantic；NeuroBook Zod + 字数硬上限（240 字）。
**成本**：低；**风险**：低（纯 prompt + 校验函数）。

### P4 一致性规则扫描（轻量起步，可选）

1. **蒸馏后自动扫描 + 摘要区展示**（不自动改文）：纯规则，零 LLM 成本：
   - R1 别名冲突：两个角色 name 不同但 aliases 交集非空；
   - R2 伏笔悬空：`foreshadowing.status=unresolved` 且同文档 plot 已无未消费铺垫（粗略：unresolved 数量 > plot 点的铺垫总数）；
   - R3 设定条目重复：keySettings 归一化后相似度 > 0.8；
   - R4 摘要漂移：P0 的 stale 标记（与一致性提示同区展示）。
2. 分级：error（必须看：R1/R4）与 advisory（建议看：R2/R3），借鉴 NeuroBook E/A 分级。
3. 暂不引入 llmlint 式文风检查（360 规则成本高、非本轮诉求）；暂不引入 embedding 检索（保持无数据库、纯文件原则）。

**借鉴来源**：NeuroBook world-issue-catalog（E1-E5/A1-A2 分级思想）。
**成本**：低-中；**风险**：低（只读扫描 + 展示）。

### P5 设定条目化与检索（远期，暂不承诺）

- 若未来需要"设定随剧情演变"：把 StorySummary.keySettings 提升为条目（每条含 name/aliases/content/version/updatedAt），resources 下的设定类文件蒸馏后自动合并进项目级设定索引（JSONL 倒排关键词即可，不引入 SQLite/embedding）。
- 注入时按"会随剧情变吗"分桶：稳定设定（常驻）vs 动态状态（近章优先）——借鉴 NeuroBook 分层判据。
- **默认不做**，等 P0-P4 落地后按实际痛点决定。

---

## 4. 迁移兼容策略

1. `schemaVersion` 写进所有摘要文件；读写侧均做兼容分支（旧格式→剥离/补算→落新格式）。
2. 现有"旧格式摘要 → null"逻辑扩展为"旧格式 → 标记 stale 待重生成"（不再静默丢弃，摘要区显示"旧版摘要，点击重新生成"）。
3. 现有 active/pending/disabled 冻结状态机**不变**（用户已接受的交互模型），P1 预算改造只动注入内容的裁剪，不动开关语义。
4. 语言驱动不变（zh/en 摘要语言）；理性务实 prompt 风格不变。
5. 数据落盘仍全部走现有 atomicWrite/JSONL 通道；不新增数据库。
6. 隐私红线不变：摘要仍只存用户工作区与 userData，不新增任何上传通道。

---

## 5. 分期建议与验收口径

| 期 | 内容 | 验收口径 | 建议顺序 |
|---|---|---|---|
| P0 | 元数据+失效检测+区间元数据 | 改资源后摘要区出现"待更新"；旧摘要打开不崩 | 第 1 批 |
| P3 | 生成协议强化 | 空字段/字数越界重试后可收敛；输出稳定 | 第 1 批（与 P0 并行） |
| P1 | 分层预算 | 超长上下文不再出现"整体裁剪到只剩系统提示"；配额可调 | 第 2 批 |
| P2 | 聊天增量压缩+聚合 | 60 条消息对话总结生成时间明显下降；rollup 注入生效 | 第 2 批 |
| P4 | 一致性规则扫描 | 构造冲突样例能出提示 | 第 3 批（可选） |
| P5 | 设定条目化 | — | 远期（视痛点再议） |

---

## 6. 已确认决策（本轮拍板）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | P0 快照瘦身 | **去快照换指纹**：DocSummary 只留 snapshotLength + sourceFingerprint，旧格式打开自动补算迁移 |
| 2 | 资源失效策略 | **惰性检测+黄标"待更新"**：读时比对指纹，用户一键重蒸馏，不自动重算 |
| 3 | P1 分层配额 | **采纳默认值 30/30/20/10 + 设置页开放调节** |
| 4 | P2 压缩阈值 | **采纳默认值**：消息数 >40 或 对话估算超输入预算 60% 时压缩；尾部保留最近 20 条逐条摘要 |
| 5 | P4 一致性扫描 | **R1（别名冲突）+ R4（摘要漂移）起步**，跑通后再评估扩档 |
| 6 | 实施节奏 | 待用户看到完整方案与体验变化后指示 |

## 7. 用户侧功能体验变化（按期）

### P0 元数据+失效检测
- **磁盘**：文档摘要文件体积约减半（去掉内嵌全文快照）。
- **资源摘要有了"保质期"**：资源文件被修改后，摘要区该条目出现黄色"待更新"标，点击一键重蒸馏（现状：改了资源，旧摘要照常注入，用户完全不知情）。
- **旧版摘要不再静默消失**：打开旧格式摘要显示"旧版摘要，点击重新生成"。
- 交互模型不变（active/pending/disabled 冻结状态机不动）。

### P3 生成协议强化
- **摘要更稳**：字段枚举/字数上限/负例约束 + 解析后校验，字段漂移与空字段减少，"摘要生成不完整"报错变少。
- **摘要更省**：总览 ≤200 字、单情节 ≤80 字，注入占用的上下文更少。
- 支持 function-calling 的模型自动走工具协议输出（用户无感知，更可靠）。

### P1 分层注入预算
- **上下文更可预期**：超长对话不再出现"历史整段砍光"或"摘要挤掉全文"的极端，每层都有保底份额。
- **设置页新增"注入预算分配"**：四个配额滑杆 + 实时百分比（全文 30% / 文档摘要 30% / 资源 20% / 对话 10%，历史动态兜底）。
- 过期摘要自动让位（层内尾部，先被裁）。

### P2 聊天总结增量压缩 + 聚合
- **长对话总结变快**：40+ 条消息的对话关闭后不再全量重写，只压缩新增部分（尾部最近 20 条逐条保留）。
- **注入更省**：先注入"每 10 条聚合摘要"，配额充足才逐条注入。
- 区间压缩写前查重叠，杜绝重复压缩错乱。

### P4 一致性扫描（R1+R4 起步）
- **摘要区新增"一致性提示"分组**：别名冲突（R1，红标 error）与摘要漂移（R4，黄标），点击跳转对应条目；只提示不自动改。
- 零 LLM 成本，纯规则扫描，无额外等待。

### 总体
更省（存储/token/时间）、更透明（摘要新旧可见）、更稳（上下文分配可预期）、更可信（冲突可见）；语言驱动、隐私红线、文件存储原则、注入开关交互均不变。
