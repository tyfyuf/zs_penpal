export type SettingDistillationRole =
  | 'entity-relationship'
  | 'entities'
  | 'relationships'
  | 'mechanisms'
  | 'terms'
  | 'rules'
  | 'constraints'
  | 'timeline'

export type SettingMergeKind =
  | 'entries'
  | 'relationships'
  | 'terms'
  | 'rules'
  | 'constraints'
  | 'timeline'
  | 'entity-relationship'
  | 'mechanisms'

const EXTRACTION_SHAPES_ZH: Record<SettingDistillationRole, string> = {
  'entity-relationship': '{"entries":[{"name":"原文准确名称","category":"人物/势力/地点/物品/物种/职业/能力/体系/事件/其他","description":"压缩后的身份、职能、状态与独有事实"}],"relationships":[{"subject":"原文主体名称","predicate":"简短明确关系","object":"原文对象名称或值","description":"仅补充条件或例外，可为空"}]}',
  entities: '{"entries":[{"name":"原文准确名称","category":"人物/势力/地点/物品/物种/职业/能力/体系/事件/其他","description":"压缩后的身份、职能、状态与独有事实"}]}',
  relationships: '{"relationships":[{"subject":"原文主体名称","predicate":"简短明确关系","object":"原文对象名称或值","description":"仅补充条件或例外，可为空"}]}',
  mechanisms: '{"terms":[{"term":"原文准确术语","definition":"压缩后的概念定义"}],"rules":["可重复适用的机制或规律"],"constraints":["必须遵守的硬边界、前提、代价、上限或例外"]}',
  terms: '{"terms":[{"term":"原文准确术语","definition":"压缩后的概念定义"}]}',
  rules: '{"rules":["可重复适用的机制或规律"]}',
  constraints: '{"constraints":["必须遵守的硬边界、前提、代价、上限或例外"]}',
  timeline: '{"timeline":["时间锚点或顺序 + 一个关键事件或状态转变"]}'
}

const EXTRACTION_SHAPES_EN: Record<SettingDistillationRole, string> = {
  'entity-relationship': '{"entries":[{"name":"exact source name","category":"character/faction/place/item/species/occupation/ability/system/event/other","description":"compressed identity, function, state, and distinctive facts"}],"relationships":[{"subject":"exact source name","predicate":"short explicit relation","object":"exact source name or value","description":"conditions or exceptions only; may be empty"}]}',
  entities: '{"entries":[{"name":"exact source name","category":"character/faction/place/item/species/occupation/ability/system/event/other","description":"compressed identity, function, state, and distinctive facts"}]}',
  relationships: '{"relationships":[{"subject":"exact source name","predicate":"short explicit relation","object":"exact source name or value","description":"conditions or exceptions only; may be empty"}]}',
  mechanisms: '{"terms":[{"term":"exact source term","definition":"compressed concept definition"}],"rules":["reusable mechanism or law"],"constraints":["hard boundary, prerequisite, cost, limit, prohibition, or exception"]}',
  terms: '{"terms":[{"term":"exact source term","definition":"compressed concept definition"}]}',
  rules: '{"rules":["reusable mechanism or law"]}',
  constraints: '{"constraints":["hard boundary, prerequisite, cost, limit, prohibition, or exception"]}',
  timeline: '{"timeline":["time anchor or order + one key event or state transition"]}'
}

const ROLE_FOCUS_ZH: Record<SettingDistillationRole, string> = {
  'entity-relationship': [
    '本任务只提取实体与实体关系。',
    '实体 description 只写身份/类别、核心职能、当前状态和用于区分该实体的独有事实；不要写完整生平、历史流水账或重复关系三元组。',
    '关系只保留稳定、明确、具有检索价值的联系；普通属性优先写入实体描述，不要制造“年龄/颜色/尺寸”等低价值关系。',
    '同一事实若已由 subject-predicate-object 清楚表达，description 留空或只写必要条件与例外。'
  ].join('\n'),
  entities: [
    '本任务只提取具名且可独立引用的实体。',
    'description 只写身份/类别、核心职能、当前状态和用于区分该实体的独有事实；不要写完整生平、历史流水账、关系清单或机制说明。',
    '人物、势力、地点、物品、具名能力/体系/事件可作为实体；纯抽象概念和仅需释义的专门用语不属于实体。'
  ].join('\n'),
  relationships: [
    '本任务只提取稳定、明确、具有检索价值的实体关系。',
    '不要把年龄、颜色、尺寸、普通形容或可直接放入实体简介的属性制造为关系。',
    '三元组已表达清楚时 description 留空；只在存在条件、范围、时间限制或例外时补充极短说明。'
  ].join('\n'),
  mechanisms: [
    '本任务只提取术语、规则与约束，三类必须互斥，同一事实不得跨列表重复。',
    '术语只收录必须解释才能理解的概念或专门用语；人物、国家、势力、地点、物品和具名事件仅因“有名称”不构成术语。',
    '规则必须是可重复适用的运行机制、制度规律或“条件→结果”关系；一次性历史事实、人物经历、旗帜/外观和国家沿革不是规则。',
    '约束必须是硬边界、禁止事项、必须条件、代价、上限或明确例外；普通困难、风险、压力、愿望和一次性后果不是约束。'
  ].join('\n'),
  terms: [
    '本任务只提取必须解释才能理解的概念、制度概念或专门用语。',
    '人物、国家、势力、地点、物品和具名事件仅因“有名称”不构成术语；普通名称应留给实体任务。',
    'definition 只保留概念本质、用途和必要区别，不复制相关人物生平或历史背景。'
  ].join('\n'),
  rules: [
    '本任务只提取可重复适用的运行机制、制度规律或“条件→结果”关系。',
    '一次性历史事实、人物经历、计划过程、旗帜/外观、国家沿革和普通背景介绍不是规则。',
    '每条规则用一至两句写清适用条件、机制和结果；具体例子只有在构成例外或改变规则时才保留。'
  ].join('\n'),
  constraints: [
    '本任务只提取必须遵守的硬边界：禁止事项、必要前提、代价、上限、不可绕过的限制或明确例外。',
    '普通困难、政治压力、风险、愿望、环境不利、历史问题和一次性负面后果不是约束。',
    '每条只写“谁/什么受到何种限制，以及必要条件或例外”。'
  ].join('\n'),
  timeline: [
    '本任务只提取明确日期/时代/先后顺序，以及会改变世界或实体状态的关键节点。',
    '一条只写一个事件或状态转变；使用实体名称引用对象，不重复人物完整生平或事件全文。',
    '没有时间锚点、顺序价值或状态变化的普通事实不要进入时间线；原文无明确时间信息时输出空数组。'
  ].join('\n')
}

const ROLE_FOCUS_EN: Record<SettingDistillationRole, string> = {
  'entity-relationship': [
    'Extract entities and entity relationships only.',
    'An entity description contains only identity/type, core function, current state, and distinctive facts. Do not reproduce a biography, historical narrative, or relationship list.',
    'Keep only stable, explicit, retrieval-worthy relations. Put ordinary attributes in the entity description instead of creating low-value relations.',
    'If the triple already states the fact, leave description empty or add only a necessary condition or exception.'
  ].join('\n'),
  entities: [
    'Extract only named, independently referenceable entities.',
    'Descriptions contain identity/type, core function, current state, and distinctive facts only. Do not include full biographies, chronologies, relation lists, or mechanism explanations.',
    'Characters, factions, places, items, named abilities/systems/events may be entities. Pure concepts and specialist words that only require a definition are not entities.'
  ].join('\n'),
  relationships: [
    'Extract only stable, explicit, retrieval-worthy entity relations.',
    'Do not turn age, color, size, generic adjectives, or ordinary profile attributes into relations.',
    'Leave description empty when the triple is sufficient; add only short conditions, scope, time limits, or exceptions.'
  ].join('\n'),
  mechanisms: [
    'Extract terms, rules, and constraints only. The three fields are mutually exclusive; never repeat one fact across lists.',
    'A term is a concept or specialist expression that requires definition. A person, country, faction, place, item, or named event is not a term merely because it has a name.',
    'A rule is a reusable mechanism, institutional law, or condition-to-result relation. One-time history, biography, appearance, flags, and national development are not rules.',
    'A constraint is a hard boundary, prohibition, prerequisite, cost, limit, or explicit exception. Ordinary difficulty, risk, pressure, desire, and one-time consequences are not constraints.'
  ].join('\n'),
  terms: [
    'Extract only concepts, institutional concepts, or specialist expressions that require definition.',
    'People, countries, factions, places, items, and named events are not terms merely because they have names.',
    'Definitions retain only the concept, function, and necessary distinction; do not copy biographies or historical background.'
  ].join('\n'),
  rules: [
    'Extract only reusable mechanisms, institutional laws, or condition-to-result relations.',
    'One-time history, biography, a specific plan, appearance, flags, national development, and ordinary background are not rules.',
    'Use one or two sentences for applicability, mechanism, and result. Keep an example only when it creates an exception or changes the rule.'
  ].join('\n'),
  constraints: [
    'Extract only hard boundaries: prohibitions, prerequisites, costs, upper limits, unavoidable restrictions, or explicit exceptions.',
    'Ordinary difficulty, political pressure, risk, desire, adverse environment, historical problems, and one-time negative consequences are not constraints.',
    'Each item states who or what is restricted, the restriction, and any necessary condition or exception.'
  ].join('\n'),
  timeline: [
    'Extract only explicit dates/eras/order and key nodes that change the state of the world or an entity.',
    'Each item contains one event or state transition. Refer to entities by name; do not repeat a complete biography or event narrative.',
    'Exclude facts with no temporal anchor, ordering value, or state change. An empty array is valid when the source has no explicit chronology.'
  ].join('\n')
}

export function settingExtractionPrompt(role: SettingDistillationRole, language: 'zh' | 'en'): string {
  if (language === 'en') {
    return [
      'You are a setting distiller, not an expander, commentator, or copy editor. Preserve the source knowledge while expressing it once, compactly, and in a retrieval-ready form.',
      'Protocol:',
      '1. Preserve exact source names. Never invent, infer missing facts, or resolve ambiguity.',
      '2. Preserve every independent fact, but discard rhetoric, repeated explanations, and examples that add no fact, condition, or exception.',
      '3. Assign each fact to one primary field. Do not duplicate the same information across entities, terms, rules, relationships, timeline, and constraints.',
      '4. Paraphrase concisely. Except for names, numbers, and fixed labels, do not copy a source span of 20 or more consecutive characters.',
      '5. One item expresses one semantic unit. Do not split one fact into multiple entries merely to increase item count.',
      '6. Typical budgets: entity description 25-80 words (exceptionally 120); term definition 15-50; relation description 0-30; rule/constraint/timeline item 15-60.',
      ROLE_FOCUS_EN[role],
      `Required JSON shape: ${EXTRACTION_SHAPES_EN[role]}`,
      'Output exactly one valid JSON object and nothing else.'
    ].join('\n')
  }

  return [
    '你是设定蒸馏器，不是扩写者、评论者或原文整理员。目标是在保留设定知识的前提下，让每项信息只出现一次，并以简短、清晰、可检索的形式表达。',
    '蒸馏协议：',
    '1. 保留原文准确名称；禁止编造、补全缺失事实或擅自消解歧义。',
    '2. 保留每个独立事实，但删除修辞、同义复述、重复说明，以及不增加事实/条件/例外的例子。',
    '3. 每个事实只能有一个主要归属字段，不得在实体、术语、规则、关系、时间线、约束之间重复搬运。',
    '4. 必须概括改写。除专名、数字和固定称谓外，不要连续照抄原文20字以上。',
    '5. 一项只表达一个语义单元；不要为了增加条目数量而把同一事实拆成多项。',
    '6. 长度预算：实体描述通常40-120字，复杂实体最多约240字；术语释义20-100字；关系说明0-60字；规则/约束/时间线单条20-100字。',
    ROLE_FOCUS_ZH[role],
    `必须输出的 JSON 结构：${EXTRACTION_SHAPES_ZH[role]}`,
    '只输出一个合法 JSON 对象，不要输出其他内容。'
  ].join('\n')
}

const MERGE_SHAPES: Record<SettingMergeKind, string> = {
  entries: '{"entries":[{"name":"...","category":"...","description":"...","sourceIds":["entry_id"]}]}',
  relationships: '{"relationships":[{"subject":"...","predicate":"...","object":"...","description":"...","sourceIds":["relationship_id"]}]}',
  terms: '{"terms":[{"term":"...","definition":"...","sourceIds":["term_id"]}]}',
  rules: '{"rules":[{"text":"...","sourceIds":["rule_id"]}]}',
  constraints: '{"constraints":[{"text":"...","sourceIds":["constraint_id"]}]}',
  timeline: '{"timeline":[{"text":"...","sourceIds":["timeline_id"]}]}',
  'entity-relationship': '{"entries":[{"name":"...","category":"...","description":"...","sourceIds":["entry_id"]}],"relationships":[{"subject":"...","predicate":"...","object":"...","description":"...","sourceIds":["relationship_id"]}]}',
  mechanisms: '{"terms":[{"term":"...","definition":"...","sourceIds":["term_id"]}],"rules":[{"text":"...","sourceIds":["rule_id"]}],"constraints":[{"text":"...","sourceIds":["constraint_id"]}]}'
}

const MERGE_FOCUS_ZH: Record<SettingMergeKind, string> = {
  entries: '把同名实体的候选事实压缩成一份高密度简介。保留身份、核心职能、当前状态和独有区别；不要拼接原句、完整生平、关系清单或时间线。',
  relationships: '合并相同或等价关系。三元组足以表达时 description 为空；description 只保留适用条件、范围和例外，不重复实体背景。',
  terms: '把同一概念的候选定义合并为简短释义，只保留概念本质、用途和必要区别；不要加入实体生平或历史沿革。',
  rules: '把同一机制的不同表述合并为一条可重复适用的规则，写清条件、机制和结果；不要保留一次性历史叙述或无新增信息的例子。',
  constraints: '把同一硬边界的不同表述合并，写清受限对象、限制、前提、代价、上限或例外；不要把普通困难、风险或历史压力改写成约束。',
  timeline: '合并同一时间节点或状态转变，一条只保留时间锚点、事件和关键结果；不要复制人物生平或完整事件经过。',
  'entity-relationship': '分别压缩实体与关系，并避免跨字段重复：实体简介不再复述已由关系三元组清楚表达的内容；关系 description 不复制实体背景。',
  mechanisms: '分别压缩术语、规则、约束，三类保持互斥：概念定义只进术语，可重复机制只进规则，硬边界只进约束；同一事实不得跨字段重复。'
}

const MERGE_FOCUS_EN: Record<SettingMergeKind, string> = {
  entries: 'Compress candidates for the same entity into one dense profile. Keep identity, core function, current state, and distinctive facts; do not concatenate source prose, full biographies, relation lists, or timelines.',
  relationships: 'Merge identical or equivalent relations. Leave description empty when the triple is sufficient; retain only scope, conditions, and exceptions, not entity background.',
  terms: 'Merge definitions of the same concept into a short definition containing only essence, function, and necessary distinctions; exclude biographies and historical development.',
  rules: 'Merge equivalent mechanism statements into one reusable rule with applicability, mechanism, and result; exclude one-time history and examples that add no fact or exception.',
  constraints: 'Merge statements of the same hard boundary and state the restricted subject, restriction, prerequisite, cost, limit, or exception; do not convert ordinary difficulty, risk, or historical pressure into constraints.',
  timeline: 'Merge the same time node or state transition. Keep only the time anchor, event, and key result; do not reproduce biographies or full event narratives.',
  'entity-relationship': 'Compress entities and relations separately while preventing cross-field repetition: entity profiles do not restate facts already clear in relation triples, and relation descriptions do not copy entity background.',
  mechanisms: 'Compress terms, rules, and constraints separately and keep them mutually exclusive: concepts belong to terms, reusable mechanisms to rules, and hard boundaries to constraints. Never repeat one fact across fields.'
}

export function settingMergePrompt(kind: SettingMergeKind, language: 'zh' | 'en'): string {
  if (language === 'en') {
    return [
      'Distill the supplied setting candidates. This is semantic compression, not concatenation or prose expansion.',
      'Protocol:',
      '1. Preserve every independent fact, but express duplicate or overlapping facts once. Candidate wording, rhetoric, repeated explanation, and redundant examples are not independent facts.',
      '2. Multiple candidate ids may map to one output item. sourceIds means their facts were semantically absorbed; it does not require preserving their sentences.',
      '3. Every input id must appear in at least one sourceIds array. Preserve entry/term names and relationship subjects/objects exactly from a referenced candidate. Add no facts.',
      '4. Paraphrase into compact atomic statements; never join descriptions with line breaks or copy long candidate passages.',
      '5. When candidates conflict, do not decide which is true. State the disagreement compactly and cover both source ids.',
      '6. Typical budgets: entity description 25-80 words (exceptionally 120); term definition 15-50; relation description 0-30; rule/constraint/timeline item 15-60.',
      MERGE_FOCUS_EN[kind],
      `Required JSON shape: ${MERGE_SHAPES[kind]}`,
      'Output valid JSON only.'
    ].join('\n')
  }

  return [
    '请蒸馏给定的设定候选项。这是语义压缩任务，不是文本拼接、扩写或逐条改写任务。',
    '归并协议：',
    '1. 保留每个独立事实，但重复或重叠事实只表达一次。候选措辞、修辞、重复解释和无新增信息的例子不属于独立事实。',
    '2. 多个候选 id 可以合并为一个输出项。sourceIds 表示候选事实已被语义吸收，不表示必须保留候选原句。',
    '3. 每个输入 id 至少在一个 sourceIds 中出现。条目/术语名称和关系主体/对象必须来自所引用候选；禁止增加事实。',
    '4. 必须用紧凑的原子陈述概括改写；禁止用换行直接拼接多个描述，禁止大段复制候选文本。',
    '5. 候选事实冲突时不得自行裁决；用最短形式并列差异，并覆盖冲突双方的 sourceIds。',
    '6. 长度预算：实体描述通常40-120字，复杂实体最多约240字；术语释义20-100字；关系说明0-60字；规则/约束/时间线单条20-100字。',
    MERGE_FOCUS_ZH[kind],
    `必须输出的 JSON 结构：${MERGE_SHAPES[kind]}`,
    '只输出合法 JSON。'
  ].join('\n')
}

export function settingOverviewPrompt(language: 'zh' | 'en', synthesis = false): string {
  if (language === 'en') {
    return [
      synthesis ? 'Synthesize the supplied partial setting overviews.' : 'Write an overview from the supplied setting source or distilled data.',
      'Return exactly one JSON object: {"overview":"...","scope":"..."}.',
      'overview should be a compact 80-180 word orientation covering the premise, major domains, and defining mechanisms or conflicts. Do not enumerate entries, repeat details, quote long passages, or add facts.',
      'scope should be one short sentence naming the covered world/system, period, region, or topic.',
      'Output JSON only.'
    ].join('\n')
  }

  return [
    synthesis ? '请综合给定的多个设定概览。' : '请根据给定的设定原文或已蒸馏数据撰写总览。',
    '只输出一个 JSON 对象：{"overview":"...","scope":"..."}。',
    'overview 应是约150-350字的高密度导览，覆盖核心前提、主要领域及决定性机制或冲突；不要逐条枚举实体，不要重复细节，不要长段引用，不得增加事实。',
    'scope 用一句短句说明覆盖的世界/体系、时代、地域或主题范围。',
    '只输出 JSON。'
  ].join('\n')
}
