import { useCollab } from './useCollab';
import { Editor } from './Editor';

export default function App() {
  const collab = useCollab();
  return (
    <div className="app">
      <header className="app-header">
        <div className="title-row">
          <span className={`conn-dot ${collab.connected ? 'on' : 'off'}`} />
          <h1>协同编辑器 · Demo</h1>
          <span className="doc-version">文档 v{collab.version ?? 1}</span>
        </div>
        <div className="online-row">
          <span className="online-label">在线 {collab.clients.length}</span>
          {collab.clients.map((c) => (
            <span key={c.clientId} className="user-pill" style={{ borderColor: c.color }}>
              <span className="user-dot" style={{ background: c.color }} />
              {c.name}
              {c.clientId === collab.myId && <em className="is-me">· 我</em>}
            </span>
          ))}
        </div>
      </header>

      <main className="app-main">
        <Editor collab={collab} />
      </main>

      <footer className="app-footer">
        <p>打开两个浏览器标签页（不同窗口）即可看到实时同步：一个用户编辑，另一个立刻能看到变化。</p>
        <p className="foot-muted">
          已实现：WebSocket 同步 · Block 结构 · 乐观更新 + ACK · 断线重连 + 操作重试 · 块级锁 · 在线用户 · 文档版本 · Undo/Redo。
          未实现（可继续）：光标同步 · OT/CRDT 冲突算法 · Snapshot 持久化。
        </p>
      </footer>
    </div>
  );
}