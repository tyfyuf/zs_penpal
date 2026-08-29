import { Compartment, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

export interface CenteredParagraph {
  from: number
  to: number
}

interface CenteredParagraphState {
  paragraphs: CenteredParagraph[]
  decorations: DecorationSet
}

const centeredLine = Decoration.line({ class: 'cm-paragraph-centered' })
const indentedLine = Decoration.line({ class: 'cm-paragraph-first-indent' })

export const setCenteredParagraphs = StateEffect.define<CenteredParagraph[]>()

function normalizeCenteredParagraphs(paragraphs: CenteredParagraph[]): CenteredParagraph[] {
  const sorted = paragraphs
    .filter((paragraph) => paragraph.from >= 0 && paragraph.to > paragraph.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const normalized: CenteredParagraph[] = []
  for (const paragraph of sorted) {
    const previous = normalized[normalized.length - 1]
    if (previous && paragraph.from <= previous.to) {
      previous.to = Math.max(previous.to, paragraph.to)
    } else {
      normalized.push({ ...paragraph })
    }
  }
  return normalized
}

function buildCenteredDecorations(doc: Text, paragraphs: CenteredParagraph[]): DecorationSet {
  const ranges = []
  for (const paragraph of paragraphs) {
    let line = doc.lineAt(Math.min(paragraph.from, doc.length))
    while (line.from <= paragraph.to) {
      ranges.push(centeredLine.range(line.from))
      if (line.number >= doc.lines) break
      line = doc.line(line.number + 1)
    }
  }
  return Decoration.set(ranges, true)
}

const centeredParagraphsField = StateField.define<CenteredParagraphState>({
  create(state) {
    return { paragraphs: [], decorations: buildCenteredDecorations(state.doc, []) }
  },
  update(value, transaction) {
    let paragraphs = value.paragraphs
    if (transaction.docChanged) {
      paragraphs = paragraphs
        .map((paragraph) => ({
          from: transaction.changes.mapPos(paragraph.from, -1),
          to: transaction.changes.mapPos(paragraph.to, 1)
        }))
        .filter((paragraph) => paragraph.to > paragraph.from)
    }
    for (const effect of transaction.effects) {
      if (effect.is(setCenteredParagraphs)) paragraphs = effect.value
    }
    const normalized = normalizeCenteredParagraphs(paragraphs)
    if (!transaction.docChanged && normalized === value.paragraphs) return value
    return {
      paragraphs: normalized,
      decorations: buildCenteredDecorations(transaction.state.doc, normalized)
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

function isTableDivider(text: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text)
}

function findNonIndentableTableLines(doc: Text): Set<number> {
  const lines = new Set<number>()
  for (let number = 2; number <= doc.lines; number += 1) {
    if (!isTableDivider(doc.line(number).text)) continue
    lines.add(number - 1)
    lines.add(number)
    for (let row = number + 1; row <= doc.lines; row += 1) {
      const text = doc.line(row).text
      if (!text.trim() || !text.includes('|')) break
      lines.add(row)
    }
  }
  return lines
}

function findNonIndentableSetextHeadingLines(doc: Text): Set<number> {
  const lines = new Set<number>()
  for (let number = 2; number <= doc.lines; number += 1) {
    if (!/^\s*(?:=+|-+)\s*$/.test(doc.line(number).text)) continue
    if (!doc.line(number - 1).text.trim()) continue
    lines.add(number - 1)
    lines.add(number)
  }
  return lines
}

function isIndentableLine(text: string, inFencedCodeBlock: boolean): boolean {
  if (inFencedCodeBlock) return false
  const trimmed = text.trimStart()
  if (!trimmed || /^#{1,6}(?:\s|$)/.test(trimmed)) return false
  if (/^(?:[-+*]\s+|\d+[.)]\s+|>\s?)/.test(trimmed)) return false
  if (/^(?:[-*_]\s*){3,}$/.test(trimmed) || trimmed.startsWith('|')) return false
  if (/^(?:\t| {4,})/.test(text)) return false
  return true
}

function buildFirstLineIndentDecorations(doc: Text): DecorationSet {
  const ranges = []
  const tableLines = findNonIndentableTableLines(doc)
  const setextHeadingLines = findNonIndentableSetextHeadingLines(doc)
  let inFencedCodeBlock = false
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    const trimmed = line.text.trimStart()
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFencedCodeBlock = !inFencedCodeBlock
      continue
    }
    if (!tableLines.has(number) && !setextHeadingLines.has(number) && isIndentableLine(line.text, inFencedCodeBlock)) {
      ranges.push(indentedLine.range(line.from))
    }
  }
  return Decoration.set(ranges, true)
}

const firstLineIndentField = StateField.define<DecorationSet>({
  create(state) {
    return buildFirstLineIndentDecorations(state.doc)
  },
  update(value, transaction) {
    return transaction.docChanged ? buildFirstLineIndentDecorations(transaction.state.doc) : value
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const centeredParagraphsExtension: Extension = centeredParagraphsField
export const firstLineIndentExtension: Extension = firstLineIndentField

function expandCenteredParagraphsToLines(doc: Text, paragraphs: CenteredParagraph[]): CenteredParagraph[] {
  const lines: CenteredParagraph[] = []
  for (const paragraph of paragraphs) {
    let line = doc.lineAt(Math.min(paragraph.from, doc.length))
    while (line.from <= paragraph.to) {
      if (line.text.trim()) lines.push({ from: line.from, to: line.to })
      if (line.number >= doc.lines) break
      line = doc.line(line.number + 1)
    }
  }
  return normalizeCenteredParagraphs(lines)
}

export function getCenteredParagraphs(state: EditorState): CenteredParagraph[] {
  return expandCenteredParagraphsToLines(state.doc, state.field(centeredParagraphsField).paragraphs)
}

export function getSelectedParagraphs(state: EditorState): CenteredParagraph[] {
  const selection = state.selection.main
  const startLine = state.doc.lineAt(selection.from).number
  const lastPosition = selection.empty ? selection.from : Math.max(selection.from, selection.to - 1)
  const endLine = state.doc.lineAt(lastPosition).number
  const ranges: CenteredParagraph[] = []

  // In this editor each logical writing line is treated as one paragraph. This avoids
  // accidentally centering an entire continuous Chinese text block that has no blank lines.
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    if (line.text.trim()) ranges.push({ from: line.from, to: line.to })
  }
  return ranges
}

export function isSelectedParagraphsCentered(state: EditorState): boolean {
  const selected = getSelectedParagraphs(state)
  if (!selected.length) return false
  const centered = getCenteredParagraphs(state)
  return selected.every((range) => centered.some((paragraph) => paragraph.from === range.from && paragraph.to === range.to))
}

export function toggleSelectedParagraphsCentered(view: EditorView): boolean {
  const selected = getSelectedParagraphs(view.state)
  if (!selected.length) return false
  const existing = getCenteredParagraphs(view.state)
  const allCentered = selected.every((range) => existing.some((paragraph) => paragraph.from === range.from && paragraph.to === range.to))
  const next = allCentered
    ? existing.filter((paragraph) => !selected.some((range) => paragraph.from === range.from && paragraph.to === range.to))
    : [...existing, ...selected]
  view.dispatch({ effects: setCenteredParagraphs.of(next) })
  return true
}

export function buildExtensions(onSave: () => boolean): Extension {
  const saveKeymap = {
    key: 'Mod-s',
    run: (): boolean => onSave()
  }
  return [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, saveKeymap]),
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    markdown()
  ]
}

export { Compartment, EditorState, EditorView }
