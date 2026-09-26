import { useEffect, useState } from 'react';
import { useYjsDoc } from './useYjsDoc';
import { Editor } from './Editor';
import { AIPanel } from './AIPanel';

const DEFAULT_DOCS = [
  { id: 'prd',     icon: '📄', name: '产品需求文档' },
  { id: 'meeting', icon: '📝', name: '会议纪要' },
  { id: 'todo',    icon: '✅', name: '待办清单' },
  { id: 'daily',   icon: '🧠', name: '每日速记' },
];

/** 工作区文档列表（默认 4 篇 + 用户新建的），localStorage 持久化 */
function loadDocs() {
  if (typeof window === 'undefined') return DEFAULT_DOCS;
  try {
    const saved = localStorage.getItem('workspaceDocs');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0
        && parsed.every((d: any) => d && typeof d.id === 'string' && typeof d.name === 'string')) {
        return parsed;
      }
    }
  } catch { /* 损坏则回退默认 */ }
  return DEFAULT_DOCS;
}

export default function App() {
  const [docs, setDocs] = useState(loadDocs);

  // 当前打开的文档（localStorage 记住上次打开的）
  const [activeDocId, setActiveDocId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'prd';
    const saved = localStorage.getItem('activeDocId');
    if (saved && loadDocs().some((d) => d.id === saved)) return saved;
    return 'prd';
  });
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? docs[0];

  const collab = useYjsDoc(activeDocId);

  // 记住上次打开的文档 + 文档列表
  useEffect(() => {
    localStorage.setItem('activeDocId', activeDocId);
  }, [activeDocId]);
  useEffect(() => {
    localStorage.setItem('workspaceDocs', JSON.stringify(docs));
  }, [docs]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // 侧边栏折叠（窄屏用抽屉）
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia('(max-width: 768px)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  const firstLetter = (name: string) => name.replace(/^用户-/, '').slice(0, 1);

  const switchDoc = (docId: string) => {
    setActiveDocId(docId);
    // 窄屏下切换文档自动收起侧边栏
    if (window.matchMedia('(max-width: 768px)').matches) {
      setSidebarOpen(false);
    }
  };

  return (
    <div className="app">
      {/* 侧边栏 */}
      <aside className={`sidebar ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <div className="sidebar-brand">
          <div className="brand-logo" />
          <span className="brand-name">Collab Docs</span>
          <button
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            title="收起侧边栏"
          >
            ×
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">工作区</div>
          {docs.map((doc) => (
            <div
              key={doc.id}
              className={`doc-item ${doc.id === activeDocId ? 'active' : ''}`}
              onClick={() => switchDoc(doc.id)}
            >
              <span className="doc-item-icon">{doc.icon ?? '📄'}</span>
              <span>{doc.name}</span>
            </div>
          ))}
          <div
            className="doc-new"
            onClick={() => {
              const id = `doc-${Date.now().toString(36)}`;
              const name = `无标题文档 ${docs.length - DEFAULT_DOCS.length + 1}`;
              setDocs((prev) => [...prev, { id, icon: '📄', name }]);
              switchDoc(id);
            }}
          >
            + 新建文档
          </div>
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
            <button
              className="sidebar-open-btn"
              onClick={() => setSidebarOpen(true)}
              title="展开侧边栏"
            >
              ☰
            </button>
            <span>工作区</span>
            <span className="breadcrumb-sep">/</span>
            <strong>{activeDoc.name}</strong>
          </div>
          <div className="topbar-right">
            <div className="conn-status">
              <span className={`conn-dot ${collab.connected ? '' : 'off'}`} />
              {collab.connected ? '已连接' : '连接中…'}
            </div>
            <span className="version-chip">v{collab.version}</span>
            <button
              className="theme-toggle"
              onClick={toggleTheme}
              title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
            >
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </div>

        {/* key=activeDocId：切换文档时重挂载编辑器，清掉上一篇文档遗留的内部状态 */}
        <Editor key={activeDocId} collab={collab} docTitle={activeDoc.name} />
      </main>

      {/* AI 助手面板 */}
      <AIPanel docId={activeDocId} docs={docs} />

      {/* 窄屏遮罩层 */}
      {sidebarOpen && (
        <div className="mobile-overlay" onClick={() => setSidebarOpen(false)} />
      )}
    </div>
  );
}