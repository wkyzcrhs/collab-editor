/**
 * useYjsDoc — 基于 Yjs CRDT 的协同文档 Hook（v3 字符级 CRDT）
 *
 * v3 核心变化：
 *   - 每个块的 text 从字符串 → Y.Text（字符级 CRDT）
 *   - 真正的无冲突合并，同一块并发打字自动穿插
 *   - 光标位置通过 Awareness + Y.RelativePosition 同步
 *
 * 数据结构：
 *   Y.Array (blocks)
 *     └─ Y.Map (单个块)
 *         ├─ id: string
 *         ├─ kind: string (paragraph/heading1/bullet/...)
 *         └─ text: Y.Text ← 字符级 CRDT
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as encoding from 'lib0/encoding';
import type { Block, BlockKind } from '../../shared/protocol';

// 用户颜色池
const COLORS = ['#4B3FE3', '#27D2BF', '#F87454', '#EFAA17', '#22A5F7', '#9b5de5', '#e63946', '#2a9d8f'];

export interface OnlineUser {
  clientId: string; // Yjs 的 clientId（数字，转成字符串）
  name: string;
  color: string;
}

/** 远程光标信息 */
export interface RemoteCursor {
  clientId: string;
  name: string;
  color: string;
  blockId: string | null;
  /** Y.RelativePosition 的 JSON 表示，用于光标同步 */
  relativePos: string | null;
}

export function useYjsDoc(roomName = 'default') {
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const yblocksRef = useRef<Y.Array<any> | null>(null);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [clients, setClients] = useState<OnlineUser[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState('');
  const [myColor, setMyColor] = useState(COLORS[0]);
  // 版本号（操作累计次数，近似表示）
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  // ---- 初始化 Y.Doc + WebSocket 连接 ----
  useEffect(() => {
    // sessionStorage 按标签页隔离：同一标签页刷新后身份不变，
    // 同浏览器的其他窗口是独立用户（localStorage 会导致多窗口撞成同一人）
    // 注意：每个房间的 clientID 加独立后缀 —— y-websocket 的 BroadcastChannel
    // 会检测"同浏览器同 clientID"并自动改 ID，导致在线用户名字乱跳。
    // 不同房间用不同 ID 既解决冲突，也符合"同一人在不同文档里是独立连接"的语义。
    const STORAGE_KEY = 'collab-editor-client-id';
    let storedId: number | null = null;
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      if (!isNaN(n)) storedId = n;
    }

    const ydoc = new Y.Doc();
    // 以基础 ID 为种子，每个房间派生一个独立 ID（保证同标签页同房间 ID 稳定）
    const baseId = storedId ?? ydoc.clientID;
    if (storedId === null) {
      sessionStorage.setItem(STORAGE_KEY, String(baseId));
    }
    // 用简单的字符串哈希 + 基础 ID 生成房间专属 clientID
    let hash = 0;
    for (let i = 0; i < roomName.length; i++) {
      hash = ((hash << 5) - hash + roomName.charCodeAt(i)) | 0;
    }
    (ydoc as any).clientID = Math.abs(baseId + hash);
    ydocRef.current = ydoc;

    // 切换文档时立即清空上一篇的界面状态，
    // 避免新文档同步完成前短暂显示上一篇的内容
    setBlocks([]);
    setClients([]);
    setRemoteCursors([]);
    setConnected(false);

    // ---- IndexedDB 持久化（离线编辑） ----
    // 把文档存在浏览器本地，断网、刷新、关浏览器后内容都还在
    // 连上网后自动和服务端同步合并
    // 库名带 v6：v5 之前的本地缓存含"跨文档串台 + 重复 H1 标题"时期的脏数据，已在 main.tsx 一次性清除
    // 每次修复内容重复类 Bug 时升级版本号，让旧缓存整体作废
    const idb = new IndexeddbPersistence(`collab-v6-${roomName}`, ydoc);

    const wsHost = window.location.hostname || 'localhost';
    const provider = new WebsocketProvider(
      `ws://${wsHost}:8787`,
      roomName,
      ydoc,
      {
        connect: true,
        params: { clientId: String(ydoc.clientID) },
        // 每 15 秒重新同步一次：保持连接流量（防 NAT 超时），断流时也能更快被发现
        resyncInterval: 15000,
      }
    );
    providerRef.current = provider;

    // 手机息屏/切后台恢复时，浏览器定时器被冻结过，可能错过重连窗口和 awareness 更新。
    // 页面重新可见时：
    //   1. 检查连接，断了就马上重连
    //   2. 主动发 queryAwareness 拉取最新完整在线列表（防止漏掉增量更新）
    const queryAwareness = () => {
      if (!provider.wsconnected || !provider.ws) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 3); // messageQueryAwareness
      provider.ws.send(encoding.toUint8Array(encoder));
      console.log('[awareness] queried full online list from server');
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!provider.wsconnected) {
          provider.connect();
          // 连接建立后拉一次（等 onopen 触发后自然会同步，但保险起见稍后再拉一次）
          setTimeout(queryAwareness, 1000);
        } else {
          // 已经连着，直接拉最新列表
          queryAwareness();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // 获取 blocks 共享数组
    const yblocks = ydoc.getArray<any>('blocks');
    yblocksRef.current = yblocks;

    // 我的身份
    const myClientId = String(ydoc.clientID);
    const colorIdx = Math.abs(ydoc.clientID) % COLORS.length;
    const color = COLORS[colorIdx];
    setMyId(myClientId);
    setMyColor(color);

    // 设置我的 awareness 信息（让别人看到我）
    const myName = `用户-${myClientId.slice(-4)}`;
    provider.awareness.setLocalStateField('user', {
      name: myName,
      color,
      clientId: myClientId,
    });
    // 光标位置（初始为空）
    provider.awareness.setLocalStateField('cursor', {
      blockId: null,
      relativePos: null,
    });

    // ---- 同步 blocks 到 React state ----
    // Y.Array 里每个元素是 Y.Map，text 字段是 Y.Text，转成普通对象给 React 用
    const syncBlocks = () => {
      const arr = yblocks.toArray() as Y.Map<any>[];
      const plain = arr.map((m) => ({
        id: m.get('id'),
        kind: m.get('kind'),
        text: (m.get('text') as Y.Text).toString(),
      })) as Block[];
      setBlocks(plain);
    };

    // 初次同步完成
    const handleSync = (synced: boolean) => {
      setConnected(synced);
      if (synced) {
        syncBlocks();
      }
    };

    provider.on('sync', handleSync);

    // 深度监听：Y.Array 增删 / Y.Map 字段变化 / Y.Text 字符变化 都能捕获
    const handleObserve = () => {
      syncBlocks();
      bumpVersion();
    };
    yblocks.observeDeep(handleObserve);

    // ---- 在线用户 + 远程光标（Awareness） ----
    const updateAwareness = () => {
      const states = provider.awareness.getStates() as Map<number, {
        user?: OnlineUser;
        cursor?: { blockId: string | null; relativePos: string | null };
      }>;
      const users: OnlineUser[] = [];
      const cursors: RemoteCursor[] = [];
      states.forEach((state, clientIdNum) => {
        const clientId = String(clientIdNum);
        if (state.user) {
          users.push(state.user);
        }
        // 收集远程光标（排除自己）
        if (state.cursor && clientId !== myClientId) {
          cursors.push({
            clientId,
            name: state.user?.name ?? '匿名',
            color: state.user?.color ?? '#888',
            blockId: state.cursor.blockId,
            relativePos: state.cursor.relativePos,
          });
        }
      });
      setClients(users);
      setRemoteCursors(cursors);
      // 诊断日志：追踪在线用户变化
      console.log(
        `[awareness] update: total=${users.length} users=[${users.map(u => u.name).join(', ')}]`
      );
    };

    provider.awareness.on('change', updateAwareness);
    updateAwareness();

    // 监听连接状态
    const handleStatus = ({ status }: { status: string }) => {
      setConnected(status === 'connected');
    };
    provider.on('status', handleStatus);

    // ---- UndoManager ----
    // scope 设为整个 ydoc，追踪所有共享类型变化（Y.Array / Y.Map / Y.Text）
    const undoManager = new Y.UndoManager(ydoc, {
      trackedOrigins: new Set([null]), // 只追踪本地用户操作
    });
    undoManagerRef.current = undoManager;

    return () => {
      // 清理顺序很重要：先停监听 → 清 awareness → 断连接 → 销毁文档
      yblocks.unobserveDeep(handleObserve);
      provider.off('sync', handleSync);
      provider.off('status', handleStatus);
      provider.awareness.off('change', updateAwareness);
      document.removeEventListener('visibilitychange', handleVisibility);

      // 先把自己从 awareness 里拿掉（null 状态 = 下线通知）
      // 防止 destroy 时 BroadcastChannel 编码出错（读不到 clock）
      try {
        provider.awareness.setLocalState(null);
      } catch { /* ignore */ }

      undoManager.destroy();
      try {
        provider.destroy();
      } catch { /* y-websocket 销毁时偶发 awareness 编码错误，忽略不影响功能 */ }
      try {
        idb.destroy();
      } catch { /* ignore */ }
      ydoc.destroy();
    };
  }, [roomName, bumpVersion]);

  // ---- 辅助：按 ID 找块的 Y.Map ----
  const getYBlock = useCallback((blockId: string): Y.Map<any> | null => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return null;
    const arr = yblocks.toArray() as Y.Map<any>[];
    const idx = arr.findIndex((m) => m.get('id') === blockId);
    if (idx === -1) return null;
    return arr[idx];
  }, []);

  // ---- 操作函数 ----

  /** 获取某块的 Y.Text 实例（供 Editor 做字符级操作） */
  const getYText = useCallback((blockId: string): Y.Text | null => {
    const ymap = getYBlock(blockId);
    if (!ymap) return null;
    return ymap.get('text') as Y.Text;
  }, [getYBlock]);

  /** 新增一个块（v3：text 是 Y.Text） */
  const addBlock = useCallback((pos?: number, kind: BlockKind = 'paragraph') => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const insertPos = pos ?? yblocks.length;
    const ymap = new Y.Map<any>();
    ymap.set('id', id);
    ymap.set('kind', kind);
    // text 用 Y.Text —— 字符级 CRDT
    const ytext = new Y.Text();
    ymap.set('text', ytext);
    yblocks.insert(insertPos, [ymap]);
    return id;
  }, []);

  /** 删除一个块 */
  const removeBlock = useCallback((blockId: string) => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray() as Y.Map<any>[];
    const idx = arr.findIndex((m) => m.get('id') === blockId);
    if (idx === -1) return;
    yblocks.delete(idx, 1);
  }, []);

  /** 切换块类型（Y.Map 原地修改） */
  const changeBlockKind = useCallback((blockId: string, kind: BlockKind) => {
    const ymap = getYBlock(blockId);
    if (!ymap) return;
    if (ymap.get('kind') === kind) return;
    ymap.set('kind', kind);
  }, [getYBlock]);

  /** 更新本地光标位置到 Awareness（让别人看到我的光标） */
  const updateMyCursor = useCallback((blockId: string | null, relPosJson: string | null) => {
    const provider = providerRef.current;
    if (!provider) return;
    provider.awareness.setLocalStateField('cursor', {
      blockId,
      relativePos: relPosJson,
    });
  }, []);

  /** 撤销 */
  const undo = useCallback(() => {
    undoManagerRef.current?.undo();
  }, []);

  /** 重做 */
  const redo = useCallback(() => {
    undoManagerRef.current?.redo();
  }, []);

  return {
    blocks,
    clients,
    remoteCursors,
    connected,
    myId,
    myColor,
    getYText,
    addBlock,
    removeBlock,
    changeBlockKind,
    updateMyCursor,
    undo,
    redo,
    version,
    canUndo: undoManagerRef.current?.canUndo() ?? false,
    canRedo: undoManagerRef.current?.canRedo() ?? false,
  };
}
