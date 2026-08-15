import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { api } from './lib/api'

// 渲染层错误上报到主进程错误日志（供维护查阅）
window.addEventListener('error', (e) => {
  void api.invoke('log:error', {
    source: 'renderer:error',
    message: e.message,
    stack: e.error instanceof Error ? e.error.stack : undefined
  })
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  void api.invoke('log:error', {
    source: 'renderer:unhandledrejection',
    message: r instanceof Error ? r.message : String(r),
    stack: r instanceof Error ? r.stack : undefined
  })
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
