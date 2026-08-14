import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

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

export { EditorState, EditorView }
