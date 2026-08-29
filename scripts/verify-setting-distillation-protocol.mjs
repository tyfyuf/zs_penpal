import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/main/services/setting-distillation.protocol.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText

const module = { exports: {} }
const load = new Function('module', 'exports', compiled)
load(module, module.exports)

const {
  settingExtractionPrompt,
  settingMergePrompt,
  settingOverviewPrompt
} = module.exports

const roles = [
  'entity-relationship',
  'entities',
  'relationships',
  'mechanisms',
  'terms',
  'rules',
  'constraints',
  'timeline'
]
const mergeKinds = [
  'entries',
  'relationships',
  'terms',
  'rules',
  'constraints',
  'timeline',
  'entity-relationship',
  'mechanisms'
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (const language of ['zh', 'en']) {
  for (const role of roles) {
    const prompt = settingExtractionPrompt(role, language)
    assert(prompt.includes('JSON'), `Missing JSON contract: extraction ${language}/${role}`)
    assert(prompt.includes('{') && prompt.includes('}'), `Missing shape: extraction ${language}/${role}`)
  }

  for (const kind of mergeKinds) {
    const prompt = settingMergePrompt(kind, language)
    assert(prompt.includes('sourceIds'), `Missing coverage contract: merge ${language}/${kind}`)
    assert(prompt.includes('{') && prompt.includes('}'), `Missing shape: merge ${language}/${kind}`)
  }

  const overview = settingOverviewPrompt(language)
  assert(overview.includes('overview') && overview.includes('scope'), `Invalid overview contract: ${language}`)
}

const chineseExtraction = roles.map((role) => settingExtractionPrompt(role, 'zh')).join('\n')
for (const obsolete of ['尽可能完整地提取', '完整描述', '完整释义', '不要设置条目数量上限']) {
  assert(!chineseExtraction.includes(obsolete), `Obsolete expansion instruction remains: ${obsolete}`)
}

const mechanisms = settingExtractionPrompt('mechanisms', 'zh')
for (const boundary of ['三类必须互斥', '仅因“有名称”不构成术语', '一次性历史事实', '普通困难']) {
  assert(mechanisms.includes(boundary), `Missing mechanism boundary: ${boundary}`)
}

const entityRelationship = settingExtractionPrompt('entity-relationship', 'zh')
for (const boundary of ['不要写完整生平', '低价值关系', 'description 留空']) {
  assert(entityRelationship.includes(boundary), `Missing entity/relationship boundary: ${boundary}`)
}

const merge = settingMergePrompt('mechanisms', 'zh')
for (const contract of ['语义压缩', '不表示必须保留候选原句', '禁止用换行直接拼接', '同一事实不得跨字段重复']) {
  assert(merge.includes(contract), `Missing merge contract: ${contract}`)
}

console.log(`Verified ${roles.length * 2} extraction prompts, ${mergeKinds.length * 2} merge prompts, and 2 overview prompts.`)
