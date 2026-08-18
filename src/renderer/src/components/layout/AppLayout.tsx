import { useAppStore, type Tab } from '../../store/app.store'
import Sidebar from './Sidebar'
import Tabs from './Tabs'
import EditorPane from '../editor/EditorPane'
import ChatPane from '../chat/ChatPane'
import SettingsPane from '../settings/SettingsPane'
import ResourceViewer from '../ResourceViewer'

function renderActiveTab(tab: Tab): JSX.Element | null {
  switch (tab.kind) {
    case 'doc':
      return <EditorPane key={tab.id} tab={tab} />
    case 'settings':
      return <SettingsPane />
    case 'resource':
      return <ResourceViewer key={tab.id} tab={tab} />
    default:
      return null
  }
}

function MainContent(): JSX.Element | null {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const active: Tab | undefined = tabs.find((t) => t.id === activeTabId)
  const chatTabs = tabs.filter((tab) => tab.kind === 'chat')

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--muted)' }}>
        从左侧选择或新建文档 / 对话开始
      </div>
    )
  }

  return (
    <div className="h-full">
      {chatTabs.map((tab) => {
        const visible = active.kind === 'chat' && active.id === tab.id
        return (
          <div key={tab.id} className={visible ? 'h-full' : 'hidden'}>
            <ChatPane tab={tab} isActive={visible} />
          </div>
        )
      })}
      {active.kind !== 'chat' && <div className="h-full">{renderActiveTab(active)}</div>}
    </div>
  )
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
