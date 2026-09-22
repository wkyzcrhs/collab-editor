/**
 * useYjsDoc — 基于 Yjs CRDT 的协同文档 Hook
 *
 * 替代旧版的 useCollab。核心区别：
 *   旧版：自己实现操作协议 + ACK + 幂等队列 + 块级锁
 *   新版：全部交给 Yjs CRDT 自动处理
 *
 * Yjs 提供的能力：
 *   - Y.Doc: 共享文档，所有改动自动同步
 *   - Y.Array: 共享数组（用来存 blocks）
 *   - Y.Text: 共享文本（如果需要细粒度文本同步可用）
 *   - Awareness: 在场协议（在线用户、光标位置等）
 *   - UndoManager: 撤销/重做（基于操作历史，不是手动栈）
 *   - 离线编辑：断网时继续改，连上自动合并
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Block, BlockKind } from '../../shared/protocol';

// 用户颜色池
const COLORS = ['#4B3FE3', '#27D2BF', '#F87454', '#EFAA17', '#22A5F7', '#9b5de5', '#e63946', '#2a9d8f'];

// 默认初始内容（文档第一次创建时用）
const DEFAULT_BLOCKS: Block[] = [
  { id: 'b-init-1', kind: 'heading1', text: '欢迎使用协同编辑器 👋' },
  { id: 'b-init-2', kind: 'paragraph', text: '这是一个基于 Yjs CRDT 的协同编辑 Demo，支持多人同时编辑同一块。' },
  { id: 'b-init-3', kind: 'heading2', text: '核心特性' },
  { id: 'b-init-4', kind: 'bullet', text: 'Yjs CRDT 无冲突协同，两个人可以同时改同一块' },
  { id: 'b-init-5', kind: 'bullet', text: '毫秒级实时同步，流畅乐观更新' },
  { id: 'b-init-6', kind: 'bullet', text: '天然支持离线编辑，上线自动合并' },
  { id: 'b-init-7', kind: 'quote', text: '💡 提示：打开两个浏览器窗口，试试同时编辑同一段文字。' },
  { id: 'b-init-8', kind: 'paragraph', text: '' },
];

export interface OnlineUser {
  clientId: string; // Yjs 的 clientId（数字，转成字符串）
  name: string;
  color: string;
}

export function useYjsDoc(roomName = 'default') {
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const yblocksRef = useRef<Y.Array<any> | null>(null);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [clients, setClients] = useState<OnlineUser[]>([]);
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState('');
  const [myColor, setMyColor] = useState(COLORS[0]);
  // 根据文档更新次数维护一个版本号
  // CRDT 没有全局单一版本号，这里用"操作累计次数"近似表示
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  // ---- 初始化 Y.Doc + WebSocket 连接 ----
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const wsHost = window.location.hostname || 'localhost';
    const provider = new WebsocketProvider(
      `ws://${wsHost}:8787`,
      roomName,
      ydoc,
      { connect: true }
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

    // ---- 同步 blocks 到 React state ----
    const syncBlocks = () => {
      setBlocks(yblocks.toArray() as Block[]);
    };

    // 初次同步完成（默认内容由服务端权威初始化，客户端不塞）
    const handleSync = (synced: boolean) => {
      setConnected(synced);
      if (synced) {
        syncBlocks();
      }
    };

    provider.on('sync', handleSync);

    // 监听 blocks 变化（别人改了 → 本地更新）
    const handleObserve = () => {
      syncBlocks();
      bumpVersion();
    };
    yblocks.observe(handleObserve);

    // ---- 在线用户（Awareness） ----
    const updateAwareness = () => {
      const states = provider.awareness.getStates() as Map<number, { user?: OnlineUser }>;
      const users: OnlineUser[] = [];
      states.forEach((state) => {
        if (state.user) {
          users.push(state.user);
        }
      });
      setClients(users);
    };

    provider.awareness.on('change', updateAwareness);
    updateAwareness();

    // 监听连接状态
    const handleStatus = ({ status }: { status: string }) => {
      setConnected(status === 'connected');
    };
    provider.on('status', handleStatus);

    // ---- UndoManager ----
    const undoManager = new Y.UndoManager(yblocks, {
      trackedOrigins: new Set([null]), // 只追踪本地用户操作
    });
    undoManagerRef.current = undoManager;

    return () => {
      // 清理
      yblocks.unobserve(handleObserve);
      provider.off('sync', handleSync);
      provider.off('status', handleStatus);
      provider.awareness.off('change', updateAwareness);
      undoManager.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  }, [roomName]);

  // ---- 操作函数 ----

  /** 替换某块的全部文本 */
  const updateBlockText = useCallback((blockId: string, newText: string) => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray();
    const idx = arr.findIndex((b: any) => b.id === blockId);
    if (idx === -1) return;

    // 更新数组中某一项的 text 字段
    // 注意：Y.Array 里放的是普通对象，直接赋值不行，要用 .get(i).set(...)
    // 但我们放的是 plain object，需要整体替换
    // 更规范的做法是用 Y.Map，但为了简单我们用整体替换
    const block = arr[idx];
    yblocks.doc?.transact(() => {
      yblocks.delete(idx, 1);
      yblocks.insert(idx, [{ ...block, text: newText }]);
    });
  }, []);

  /** 新增一个块 */
  const addBlock = useCallback((pos?: number, kind: BlockKind = 'paragraph') => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const insertPos = pos ?? yblocks.length;
    yblocks.insert(insertPos, [{ id, kind, text: '' }]);
    return id;
  }, []);

  /** 删除一个块 */
  const removeBlock = useCallback((blockId: string) => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray();
    const idx = arr.findIndex((b: any) => b.id === blockId);
    if (idx === -1) return;
    yblocks.delete(idx, 1);
  }, []);

  /** 切换块类型 */
  const changeBlockKind = useCallback((blockId: string, kind: BlockKind) => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray();
    const idx = arr.findIndex((b: any) => b.id === blockId);
    if (idx === -1) return;
    const block = arr[idx];
    yblocks.doc?.transact(() => {
      yblocks.delete(idx, 1);
      yblocks.insert(idx, [{ ...block, kind }]);
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
    connected,
    myId,
    myColor,
    updateBlockText,
    addBlock,
    removeBlock,
    changeBlockKind,
    undo,
    redo,
    version,
    canUndo: undoManagerRef.current?.canUndo() ?? false,
    canRedo: undoManagerRef.current?.canRedo() ?? false,
  };
}