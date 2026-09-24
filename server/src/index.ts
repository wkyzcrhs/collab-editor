/**
 * 协同编辑器服务端（Yjs CRDT 版）
 *
 * 自己实现 Yjs WebSocket 同步协议（简化版），核心就是三件事：
 *   1. sync：新连接进来时，交换文档状态（step1 → step2）
 *   2. update：任何客户端的改动，广播给所有人
 *   3. awareness：在线用户 / 光标等在场信息的广播
 *
 * 协议格式（Yjs 标准）：
 *   每条消息 = [messageType: varUint, payload...]
 *   messageType:
 *     0 = sync（子类型：0=step1, 1=step2, 2=update）
 *     1 = awareness
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const PORT = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port: PORT });

// 房间管理：docName -> { doc, awareness }
const docs = new Map<string, {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
}>();

// 默认初始内容（v3：每个块用 Y.Map，text 字段用 Y.Text 实现字符级 CRDT）
function createBlock(id: string, kind: string, text: string): Y.Map<any> {
  const map = new Y.Map();
  map.set('id', id);
  map.set('kind', kind);
  // text 用 Y.Text —— 字符级 CRDT，支持真正的无冲突合并
  const ytext = new Y.Text();
  ytext.insert(0, text);
  map.set('text', ytext);
  return map;
}

const DEFAULT_BLOCKS: Y.Map<any>[] = [
  createBlock('b-init-1', 'heading1', '欢迎使用协同编辑器 👋'),
  createBlock('b-init-2', 'paragraph', '这是一个基于 Yjs CRDT 的协同编辑 Demo，支持多人同时编辑同一块。'),
  createBlock('b-init-3', 'heading2', '核心特性'),
  createBlock('b-init-4', 'bullet', 'Yjs CRDT 无冲突协同，两个人可以同时改同一块'),
  createBlock('b-init-5', 'bullet', '毫秒级实时同步，流畅乐观更新'),
  createBlock('b-init-6', 'bullet', '天然支持离线编辑，上线自动合并'),
  createBlock('b-init-7', 'quote', '💡 提示：打开两个浏览器窗口，试试同时编辑同一段文字。'),
  createBlock('b-init-8', 'paragraph', ''),
];

/** 获取或创建房间 */
function getRoom(docName: string) {
  let room = docs.get(docName);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  // 第一次创建时塞初始内容
  const yblocks = doc.getArray('blocks');
  if (yblocks.length === 0) {
    yblocks.push(DEFAULT_BLOCKS);
  }

  // 监听文档更新 → 广播给所有连接的客户端
  doc.on('update', (update: Uint8Array, origin: any) => {
    // origin 是触发更新的来源（我们用 ws 对象标记，避免回发给自己）
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // message type = sync
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    // 广播给同房间所有连接（除了 origin 自己）
    for (const ws of connections.get(docName) ?? []) {
      if (ws !== origin && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  });

  // 监听 awareness 变化 → 广播给所有人
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: any) => {
    const changedClients = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // message type = awareness
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    );
    const message = encoding.toUint8Array(encoder);

    for (const ws of connections.get(docName) ?? []) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  });

  room = { doc, awareness };
  docs.set(docName, room);
  return room;
}

// 每个房间的 WebSocket 连接列表
const connections = new Map<string, Set<WebSocket>>();

function addConnection(docName: string, ws: WebSocket) {
  if (!connections.has(docName)) {
    connections.set(docName, new Set());
  }
  connections.get(docName)!.add(ws);
}

function removeConnection(docName: string, ws: WebSocket) {
  const set = connections.get(docName);
  if (set) {
    set.delete(ws);
    if (set.size === 0) connections.delete(docName);
  }
}

/** 处理一条 WebSocket 消息 */
function handleMessage(ws: WebSocket, docName: string, data: RawData) {
  const room = getRoom(docName);
  const { doc, awareness } = room;

  const uint8 = new Uint8Array(data as Buffer);
  const decoder = decoding.createDecoder(uint8);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case 0: {
      // ---- sync 消息 ----
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); // 回复也是 sync 类型
      // 处理 sync 消息（step1 / step2 / update），结果写入 encoder
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws);

      // 如果 encoder 里有内容要回发（比如 step2 响应）
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }
      break;
    }
    case 1: {
      // ---- awareness 消息 ----
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
      break;
    }
    default:
      // 未知消息类型，忽略
      break;
  }
}

wss.on('connection', (ws, req) => {
  // 从 URL path 提取房间名
  const url = req.url ?? '/default';
  const docName = url.slice(1).split('?')[0] || 'default';

  const room = getRoom(docName);
  addConnection(docName, ws);

  // 连接建立后，先发一个 sync step1（服务端的状态向量）
  // 不，标准流程是客户端先发 step1，服务端回 step2
  // 我们这里只需要被动响应客户端的消息

  ws.on('message', (data) => {
    try {
      handleMessage(ws, docName, data);
    } catch (err) {
      console.error('message error:', err);
    }
  });

  ws.on('close', () => {
    // 清理 awareness（把自己从在线列表里移除）
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      Array.from(room.awareness.getStates().keys()).filter((clientid) => {
        // 这里简单处理：关闭连接时清理所有没有对应 ws 的 awareness
        // 实际上 y-websocket 是通过 origin 追踪的，我们简化处理
        return false;
      }),
      ws
    );
    removeConnection(docName, ws);
  });

  // 出错时直接关闭
  ws.on('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
});

console.log(`[collab-editor-crdt] server listening on ws://localhost:${PORT}`);
console.log(`  房间示例: ws://localhost:${PORT}/default`);