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
    // Y.Array 里每个元素是 Y.Map，转成普通对象给 React 用
    const syncBlocks = () => {
      const arr = yblocks.toArray() as Y.Map<any>[];
      const plain = arr.map((m) => ({
        id: m.get('id'),
        kind: m.get('kind'),
        text: m.get('text'),
      })) as Block[];
      setBlocks(plain);
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
    // 用 observeDeep 才能监听 Y.Map 内部字段的变化（比如 text/kind 改变）
    const handleObserve = () => {
      syncBlocks();
      bumpVersion();
    };
    yblocks.observeDeep(handleObserve);

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
    // scope 设为整个 ydoc，确保 Y.Map 内部字段变化（text/kind）也能被追踪
    // 之前 scope 是 yblocks（Y.Array），Y.Map 内部 set 不会触发 Array 变化，Undo/Redo 会失效
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
  }, [roomName]);

  // ---- 操作函数 ----

  /** 替换某块的全部文本（Y.Map 原地修改，不会产生重复块） */
  const updateBlockText = useCallback((blockId: string, newText: string) => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray() as Y.Map<any>[];
    const idx = arr.findIndex((m) => m.get('id') === blockId);
    if (idx === -1) return;

    const ymap = arr[idx];
    // 如果文本没变，直接返回（减少不必要的操作）
    if (ymap.get('text') === newText) return;

    // 原地修改 map 的 text 字段（不再删了又插，不会产生重复块）
    ymap.set('text', newText);
  }, []);

  /** 新增一个块（用 Y.Map，支持原地修改） */
  const addBlock = useCallback((pos?: number, kind: BlockKind = 'paragraph') => {
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const insertPos = pos ?? yblocks.length;
    // 用 Y.Map 存块，字段可以原地修改
    const ymap = new Y.Map<any>();
    ymap.set('id', id);
    ymap.set('kind', kind);
    ymap.set('text', '');
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
    const yblocks = yblocksRef.current;
    if (!yblocks) return;
    const arr = yblocks.toArray() as Y.Map<any>[];
    const idx = arr.findIndex((m) => m.get('id') === blockId);
    if (idx === -1) return;
    const ymap = arr[idx];
    if (ymap.get('kind') === kind) return;
    ymap.set('kind', kind);
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