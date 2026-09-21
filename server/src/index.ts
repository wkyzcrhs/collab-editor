/**
 * 协同编辑器服务端：单一「房间」，内存态。
 * 职责：
 *   - 维护文档（块列表）与版本号
 *   - 接收操作并去重（幂等）、落库、广播
 *   - 块级锁（Block 锁）
 *   - 在线用户（presence）
 * 说明：为保证演示简单，文档仅存内存；真实场景可换成
 *   Snapshot + 操作日志持久化（PostgreSQL/Redis），并做持久层事务。
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { applyOp } from '../../shared/mutate.js';
import type { Block, ClientMessage, ClientInfo, DocSnapshot, Op, ServerMessage } from '../../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port: PORT });

// ---- 房间状态 ----
let blocks: Block[] = [
  { id: 'b-init-1', kind: 'heading1', text: '欢迎使用协同编辑器 👋' },
  { id: 'b-init-2', kind: 'paragraph', text: '这是一个轻量级的 Block-based 协同编辑 Demo，支持多人实时同步。' },
  { id: 'b-init-3', kind: 'heading2', text: '核心特性' },
  { id: 'b-init-4', kind: 'bullet', text: 'WebSocket 实时同步，毫秒级延迟' },
  { id: 'b-init-5', kind: 'bullet', text: '乐观更新 + ACK 确认，流畅又可靠' },
  { id: 'b-init-6', kind: 'bullet', text: '块级锁机制，防止并发冲突' },
  { id: 'b-init-7', kind: 'quote', text: '提示：打开两个浏览器窗口，试试两边同时编辑不同的块。' },
  { id: 'b-init-8', kind: 'paragraph', text: '' },
];
let version = 1;
const appliedOpVersions = new Map<string, number>(); // opId -> 生效时的版本（幂等去重）
const locks: Record<string, string> = {}; // blockId -> clientId 持有者
const clients = new Map<string, ClientInfo & { ws: WebSocket }>();

const COLORS = ['#4B3FE3', '#27D2BF', '#F87454', '#EFAA17', '#22A5F7', '#9b5de5', '#e63946', '#2a9d8f'];

function snapshot(): DocSnapshot {
  return { blocks, version };
}

function isOpen(ws: WebSocket | undefined): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const c of clients.values()) {
    if (isOpen(c.ws)) c.ws.send(data);
  }
}

function sendTo(clientId: string, msg: ServerMessage) {
  const c = clients.get(clientId);
  if (c && isOpen(c.ws)) c.ws.send(JSON.stringify(msg));
}

function presence(): ClientInfo[] {
  return [...clients.values()].map(({ clientId, name, color }) => ({ clientId, name, color }));
}

function releaseLocksOf(clientId: string) {
  for (const blockId of Object.keys(locks)) {
    if (locks[blockId] === clientId) {
      delete locks[blockId];
      broadcast({ type: 'lockReleased', blockId });
    }
  }
}

function handleHello(clientId: string, name: string, ws: WebSocket) {
  if (!clients.has(clientId)) {
    clients.set(clientId, { clientId, name, color: COLORS[clients.size % COLORS.length], ws });
  } else {
    clients.get(clientId)!.ws = ws;
  }
  sendTo(clientId, { type: 'welcome', clientId, name, snapshot: snapshot(), locks: { ...locks } });
  broadcast({ type: 'presence', clients: presence() });
  broadcast({ type: 'toast', message: `${name} 已加入` });
}

function handleOp(op: Op) {
  // 幂等：同一 opId 只生效一次。客户端重连重试时会重发，直接返回当前版本即可。
  if (appliedOpVersions.has(op.id)) {
    sendTo(op.clientId, { type: 'ack', opId: op.id, rejected: false, version });
    return;
  }
  const next = applyOp(blocks, op);
  if (next === blocks) {
    // 目标块不存在等无效操作：拒绝（客户端会回滚乐观更新）
    sendTo(op.clientId, { type: 'ack', opId: op.id, rejected: true, version });
    return;
  }
  blocks = next;
  version += 1;
  appliedOpVersions.set(op.id, version);
  if (appliedOpVersions.size > 2000) {
    const first = appliedOpVersions.keys().next().value;
    if (first !== undefined) appliedOpVersions.delete(first);
  }
  broadcast({ type: 'state', version, blocks, appliedOps: [op.id] });
  sendTo(op.clientId, { type: 'ack', opId: op.id, rejected: false, version });
}

function handleLock(clientId: string, blockId: string, want: boolean) {
  const exists = blocks.some((b) => b.id === blockId);
  if (!exists) return;
  if (want) {
    if (locks[blockId] && locks[blockId] !== clientId) return; // 被他人锁住
    locks[blockId] = clientId;
    sendTo(clientId, { type: 'lockGranted', blockId });
    broadcast({ type: 'lockTaken', blockId, by: clientId });
  } else if (locks[blockId] === clientId) {
    delete locks[blockId];
    broadcast({ type: 'lockReleased', blockId });
  }
}

function onMessage(ws: WebSocket, data: RawData) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(data.toString()) as ClientMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case 'hello':
      handleHello(msg.clientId, msg.name, ws);
      break;
    case 'op':
      handleOp(msg.op);
      break;
    case 'lock':
      handleLock(msg.clientId, msg.blockId, msg.want);
      break;
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => onMessage(ws, data));
  ws.on('close', () => {
    // 找到按 ws 匹配的 clientId 并清理
    const entry = [...clients.entries()].find(([, c]) => c.ws === ws);
    if (!entry) return;
    const [clientId, info] = entry;
    releaseLocksOf(clientId);
    clients.delete(clientId);
    broadcast({ type: 'presence', clients: presence() });
    broadcast({ type: 'toast', message: `${info.name} 已离开` });
  });
});

console.log(`[collab-editor] server listening on ws://localhost:${PORT}`);