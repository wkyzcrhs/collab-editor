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
    const STORAGE_KEY = 'collab-editor-client-id';
    let storedId: number | null = null;
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      if (!isNaN(n)) storedId = n;
    }

    const ydoc = new Y.Doc();
    if (storedId !== null) {
      (ydoc as any).clientID = storedId;
    } else {
      sessionStorage.setItem(STORAGE_KEY, String(ydoc.clientID));
    }
    ydocRef.current = ydoc;

    // ---- IndexedDB 持久化（离线编辑） ----
    // 把文档存在浏览器本地，断网、刷新、关浏览器后内容都还在
    // 连上网后自动和服务端同步合并
    new IndexeddbPersistence(`collab-${roomName}`, ydoc);

    const wsHost = window.location.hostname || 'localhost';
    const provider = new WebsocketProvider(
      `ws://${wsHost}:8787`,
      roomName,
      ydoc,
      {
        connect: true,
        params: { clientId: String(ydoc.clientID) },
      }
    );
    providerRef.current = provider;

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
      // 清理
      yblocks.unobserveDeep(handleObserve);
      provider.off('sync', handleSync);
      provider.off('status', handleStatus);
      provider.awareness.off('change', updateAwareness);
      undoManager.destroy();
      provider.destroy();
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
