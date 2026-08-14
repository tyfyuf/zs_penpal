import { useAppStore, type Tab } from '../../store/app.store'
import Sidebar from './Sidebar'
import Tabs from './Tabs'
import EditorPane from '../editor/EditorPane'
import ChatPane from '../chat/ChatPane'
import SettingsPane from '../settings/SettingsPane'
import ResourceViewer from '../ResourceViewer'

function MainContent(): JSX.Element | null {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const active: Tab | undefined = tabs.find((t) => t.id === activeTabId)

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>
        从左侧选择或新建文档 / 对话开始
      </div>
    )
  }

  switch (active.kind) {
    case 'doc':
      return <EditorPane key={active.id} tab={active} />
    case 'chat':
      return <ChatPane key={active.id} tab={active} />
    case 'settings':
      return <SettingsPane />
    case 'resource':
      return <ResourceViewer key={active.id} tab={active} />
    default:
      return null
  }
}

export default function AppLayout(): JSX.Element {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Tabs />
        <div className="min-h-0 flex-1">
          <MainContent />
        </div>
      </div>
    </div>
  )
}
