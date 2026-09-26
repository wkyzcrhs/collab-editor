import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// ---- 一次性清理旧版本缓存（必须在 App 渲染前执行） ----
// 历史上出现过"文档内容跨房间串台"的 Bug，被污染的文档状态留在了浏览器的
// IndexedDB / localStorage 里。CRDT 的"不丢数据"特性意味着：只要旧缓存还在，
// 客户端一重连就会把脏数据合并回服务端（不同 ID 的重复块全部保留 = 内容翻倍）。
// 因此每次修复此类 Bug 时升级 CACHE_VERSION：新缓存用新前缀，旧缓存整体作废删除。
const CACHE_VERSION = '6';
const CURRENT_PREFIX = `collab-v${CACHE_VERSION}-`;

async function purgeStaleCaches() {
  // localStorage：清掉旧文档列表与上次打开的文档（版本号控制，只清一次）
  if (localStorage.getItem('cacheVersion') !== CACHE_VERSION) {
    localStorage.removeItem('workspaceDocs');
    localStorage.removeItem('activeDocId');
    localStorage.setItem('cacheVersion', CACHE_VERSION);
  }
  // IndexedDB：删除所有旧命名规则的本地文档库（当前版本只保留 collab-v4-*）
  try {
    if ('databases' in indexedDB) {
      const dbs = await indexedDB.databases();
      const stale = dbs
        .map((db) => db.name ?? '')
        .filter((name) => name.startsWith('collab') && !name.startsWith(CURRENT_PREFIX));
      await Promise.all(
        stale.map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve(); // 旧标签页占用时也不阻塞启动
            })
        )
      );
    }
  } catch {
    // 老浏览器不支持 indexedDB.databases()：新前缀本身已避开旧库，跳过即可
  }
}

purgeStaleCaches().finally(() => {
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(<App />);
  }
});
