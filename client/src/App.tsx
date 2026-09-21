import { useEffect, useState } from 'react';
import { useCollab } from './useCollab';
import { Editor } from './Editor';

const DOCS = [
  { id: 'prd', icon: '📄', name: '产品需求文档', active: true },
  { id: 'meeting', icon: '📝', name: '会议纪要', active: false },
  { id: 'todo', icon: '✅', name: '待办清单', active: false },
  { id: 'daily', icon: '🧠', name: '每日速记', active: false },
];

export default function App() {
  const collab = useCollab();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  const firstLetter = (name: string) => name.replace(/^用户-/, '').slice(0, 1);

  return (
    <div className="app">
      {/* 侧边栏 */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo" />
          <span className="brand-name">Collab Docs</span>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">工作区</div>
          {DOCS.map((doc) => (
            <div key={doc.id} className={`doc-item ${doc.active ? 'active' : ''}`}>
              <span className="doc-item-icon">{doc.icon}</span>
              <span>{doc.name}</span>
            </div>
          ))}
          <div className="doc-new">+ 新建文档</div>
        </div>

        <div className="sidebar-footer">
          <div className="presence-title">
            <span>在线用户</span>
            <span className="presence-count">{collab.clients.length}</span>
          </div>
          <div className="presence-list">
            {collab.clients.map((c) => (
              <div key={c.clientId} className="presence-row">
                <div className="avatar" style={{ background: c.color }}>
                  {firstLetter(c.name)}
                </div>
                <span className="presence-name">{c.name}</span>
                {c.clientId === collab.myId && <em className="is-me-tag">· 我</em>}
                <span className="online-dot" />
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* 主区域 */}
      <main className="main">
        <div className="topbar">
          <div className="breadcrumb">
            <span>工作区</span>
            <span className="breadcrumb-sep">/</span>
            <strong>产品需求文档</strong>
          </div>
          <div className="topbar-right">
            <div className="conn-status">
              <span className={`conn-dot ${collab.connected ? '' : 'off'}`} />
              {collab.connected ? '已连接' : '连接中…'}
            </div>
            <span className="version-chip">v{collab.version ?? 1}</span>
            <button
              className="theme-toggle"
              onClick={toggleTheme}
              title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
            >
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </div>

        <Editor collab={collab} />
      </main>
    </div>
  );
}