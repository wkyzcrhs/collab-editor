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
import { LeveldbPersistence } from 'y-leveldb';
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const PORT = Number(process.env.PORT ?? 8787);

// ---- HTTP 服务器（同时承载 WebSocket 和 AI 接口） ----
const httpServer = createServer(async (req, res) => {
  // CORS（本地开发用，生产环境应限制域名）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- AI 聊天接口（SSE 流式返回） ----
  if (req.method === 'POST' && req.url === '/api/ai/chat') {
    await handleAiChat(req, res);
    return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, docs: docs.size }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

const wss = new WebSocketServer({ server: httpServer });

// ---- LevelDB 持久化 ----
// 数据存在 server/data 目录下，服务重启后数据还在
const persistence = new LeveldbPersistence('./data');

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

/** 获取或创建房间（支持持久化） */
async function getRoom(docName: string) {
  let room = docs.get(docName);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  // ---- 先注册 update 监听器，再初始化数据 ----
  // 这样无论是加载持久化数据还是设置默认内容，产生的 update 都会被存进 LevelDB
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

    // ---- 持久化：每次更新都存到 LevelDB ----
    persistence.storeUpdate(docName, update).then(() => {
      console.log(`[persistence] update stored for "${docName}" (${update.length} bytes)`);
    }).catch((err) => {
      console.error('[persistence] store error:', err);
    });
  });

  // ---- 持久化：从 LevelDB 加载已有数据 ----
  const persistedDoc = await persistence.getYDoc(docName);
  const persistedBlocks = persistedDoc.getArray('blocks');
  if (persistedBlocks.length > 0) {
    // 有实际内容，加载到当前 doc
    const update = Y.encodeStateAsUpdate(persistedDoc);
    Y.applyUpdate(doc, update);
    const yblocks = doc.getArray('blocks');
    console.log(`[persistence] loaded doc "${docName}" from LevelDB (${yblocks.length} blocks)`);
  } else {
    // 没有持久化数据，塞初始内容（会触发上面的 update 监听器，把默认内容也存进 LevelDB）
    const yblocks = doc.getArray('blocks');
    yblocks.push(DEFAULT_BLOCKS);
    console.log(`[persistence] no data for "${docName}", initialized with default content (${yblocks.length} blocks)`);
  }

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

    const connSet = connections.get(docName);
    let broadcastCount = 0;
    for (const ws of connSet ?? []) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
        broadcastCount++;
      }
    }

    // 诊断日志：追踪 awareness 广播
    const totalOnline = awareness.getStates().size;
    if (added.length > 0 || removed.length > 0) {
      console.log(
        `[awareness] room="${docName}" total=${totalOnline} ` +
        `added=[${added.join(',')}] updated=[${updated.join(',')}] ` +
        `removed=[${removed.join(',')}] broadcastTo=${broadcastCount} conns`
      );
    }
  });

  room = { doc, awareness };
  docs.set(docName, room);
  return room;
}

// 每个房间的 WebSocket 连接列表
const connections = new Map<string, Set<WebSocket>>();
// 每个 ws 关联的 awareness clientID 集合
const wsClientIds = new WeakMap<WebSocket, Set<number>>();
// clientID → 当前归属的 ws（用于刷新竞态：同 ID 重连后，旧连接的 close 不得删掉新连接的状态）
const clientIdOwner = new Map<number, WebSocket>();

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
async function handleMessage(ws: WebSocket, docName: string, data: RawData, clientId: number | null) {
  const room = await getRoom(docName);
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
    case 3: {
      // ---- queryAwareness（客户端主动拉取完整在线列表）----
      // 手机端页面从后台切回来时，可能错过了一些增量更新，
      // 主动发 queryAwareness，服务端回传完整 awareness 快照
      const allClientIds = Array.from(awareness.getStates().keys());
      const respEncoder = encoding.createEncoder();
      encoding.writeVarUint(respEncoder, 1); // 回复用 awareness 消息类型
      encoding.writeVarUint8Array(
        respEncoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, allClientIds)
      );
      ws.send(encoding.toUint8Array(respEncoder));
      console.log(
        `[awareness] query from clientId=${clientId ?? 'unknown'}, ` +
        `replied with ${allClientIds.length} users`
      );
      break;
    }
    default:
      // 未知消息类型，忽略
      break;
  }
}

// ---- WebSocket 保活（ping/pong） ----
// 手机浏览器息屏/切后台时会静默断开 TCP，服务端不主动探测就感知不到，
// 出现"幽灵在线用户"。定期 ping，连续无 pong 则踢掉连接（触发 close 清理）。
// PING_INTERVAL = 5s：一个周期没 pong 就判定断线，最多 10 秒内踢掉（接近 5s 目标）
const PING_INTERVAL = 5000;
setInterval(() => {
  let dropped = 0;
  for (const set of connections.values()) {
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if ((ws as any).isAlive === false) {
        ws.terminate(); // 触发 close 事件 → 清理 awareness → 广播下线
        dropped++;
        continue;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }
  if (dropped > 0) {
    console.log(`[keepalive] dropped ${dropped} unresponsive connections`);
  }
}, PING_INTERVAL);
console.log(`[keepalive] ping every ${PING_INTERVAL / 1000}s, unresponsive connections dropped within ~${PING_INTERVAL / 1000 * 2}s`);

// ---- Awareness 定期全量广播（保底机制）----
// 解决手机端可能漏掉增量更新的问题：每 10 秒推送一次完整在线列表
// 即使某个客户端错过了某个用户的上线/下线消息，也能在下一次全量广播时纠正
const FULL_AWARENESS_INTERVAL = 10000;
setInterval(() => {
  for (const [docName, room] of docs) {
    const allIds = Array.from(room.awareness.getStates().keys());
    if (allIds.length === 0) continue;
    const connSet = connections.get(docName);
    if (!connSet || connSet.size === 0) continue;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // message type = awareness
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, allIds)
    );
    const message = encoding.toUint8Array(encoder);

    let sent = 0;
    for (const ws of connSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
        sent++;
      }
    }
    if (sent > 0) {
      console.log(
        `[awareness] full broadcast room="${docName}" users=${allIds.length} clients=${sent}`
      );
    }
  }
}, FULL_AWARENESS_INTERVAL);
console.log(`[awareness] full broadcast every ${FULL_AWARENESS_INTERVAL / 1000}s (safety net)`);

wss.on('connection', async (ws, req) => {
  // 保活标记：pong 回来时置 true，ping 周期里检查
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });

  // 从 URL 提取房间名和 clientId
  const fullUrl = req.url ?? '/default';
  const [pathPart, queryPart] = fullUrl.split('?');
  const docName = pathPart.slice(1) || 'default';
  const params = new URLSearchParams(queryPart ?? '');
  const clientIdStr = params.get('clientId');
  const clientId = clientIdStr ? Number(clientIdStr) : null;

  // 异步加载房间（等待持久化数据加载完成）
  const room = await getRoom(docName);
  addConnection(docName, ws);

  // 如果前端传了 clientId，直接关联到这个 ws，并记录归属
  if (clientId !== null && !isNaN(clientId)) {
    let idSet = wsClientIds.get(ws);
    if (!idSet) {
      idSet = new Set();
      wsClientIds.set(ws, idSet);
    }
    idSet.add(clientId);
    // 新连接接管这个 clientID（旧连接若之后才 close，会发现归属已易主，不会误删）
    clientIdOwner.set(clientId, ws);
  }

  // 把房间里现有的 awareness 状态（其他在线用户）发给新连接
  // 否则刷新后的页面只知道自己是 1 个人
  const existingStates = Array.from(room.awareness.getStates().keys());
  const connCount = connections.get(docName)?.size ?? 0;
  console.log(
    `[ws] new client connected room="${docName}" clientId=${clientId ?? 'unknown'} ` +
    `existingAwareness=${existingStates.length} totalConns=${connCount} ` +
    `states=[${existingStates.join(',')}]`
  );
  if (existingStates.length > 0 && ws.readyState === WebSocket.OPEN) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // message type = awareness
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, existingStates)
    );
    ws.send(encoding.toUint8Array(encoder));
    console.log(`[ws]   → sent awareness snapshot (${existingStates.length} users) to new client`);
  }

  ws.on('message', async (data) => {
    try {
      await handleMessage(ws, docName, data, clientId);
    } catch (err) {
      console.error('message error:', err);
    }
  });

  ws.on('close', () => {
    // 清理 awareness：只删仍归这个 ws 所有的 clientID
    const clientIds = wsClientIds.get(ws);
    let removedCount = 0;
    if (clientIds && clientIds.size > 0) {
      const toRemove = Array.from(clientIds).filter((id) => clientIdOwner.get(id) === ws);
      if (toRemove.length > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, toRemove, ws);
        removedCount = toRemove.length;
        for (const id of toRemove) {
          clientIdOwner.delete(id);
        }
      }
      wsClientIds.delete(ws);
    }
    removeConnection(docName, ws);
    const remaining = room.awareness.getStates().size;
    console.log(
      `[ws] client disconnected room="${docName}" clientId=${clientId ?? 'unknown'} ` +
      `removedAwareness=${removedCount} remainingOnline=${remaining}`
    );
  });

  // 出错时直接关闭
  ws.on('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
});

// ---- AI 聊天接口实现 ----
async function handleAiChat(req: IncomingMessage, res: ServerResponse) {
  // 读取请求体
  let body = '';
  for await (const chunk of req as any) {
    body += chunk;
  }

  let data: any = {};
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { question, documentContent, roomName } = data;
  if (!question || typeof question !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'question is required' }));
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY not configured' }));
    return;
  }

  // 组装系统提示：把文档内容作为上下文
  const systemPrompt = `你是一个协同文档写作助手。请基于以下文档内容回答用户的问题。
如果答案不在文档中，请明确说明，并给出你认为有帮助的建议。
回答要简洁、结构化，使用 Markdown 格式。

当前文档内容：
---
${documentContent || '(文档为空)'}
---`;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        stream: true,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DeepSeek API error', detail: errText }));
      return;
    }

    // SSE 流式返回
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const reader = response.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        try {
          const json = JSON.parse(payload);
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        } catch {
          // 忽略解析失败的片段
        }
      }
    }
    res.end();
  } catch (err: any) {
    console.error('[ai] chat error:', err.message);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`[collab-editor-crdt] server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/<roomName>`);
  console.log(`  AI API:    POST http://localhost:${PORT}/api/ai/chat`);
  console.log(`  健康检查:   GET  http://localhost:${PORT}/health`);
});