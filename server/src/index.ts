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

/** 不同文档的默认初始内容（只存定义：[块类型, 文本]）
 *  注意：这里不能直接存 Y.Map 实例 —— Y.Map 一旦被集成进某个 Y.Doc 就与该文档绑定，
 *  同一实例再进另一个文档会损坏 CRDT 结构，导致内容跨文档串台、块重复。
 *  所以每次初始化都由 getDefaultBlocks 现场创建全新实例 */
const DEFAULT_BLOCK_DEFS: Record<string, Array<[string, string]>> = {
  prd: [
    ['heading1', '欢迎使用协同编辑器 👋'],
    ['paragraph', '这是一个基于 Yjs CRDT 的协同编辑 Demo，支持多人同时编辑同一块。'],
    ['heading2', '核心特性'],
    ['bullet', 'Yjs CRDT 无冲突协同，两个人可以同时改同一块'],
    ['bullet', '毫秒级实时同步，流畅乐观更新'],
    ['bullet', '天然支持离线编辑，上线自动合并'],
    ['quote', '💡 提示：打开两个浏览器窗口，试试同时编辑同一段文字。'],
    ['paragraph', ''],
  ],
  meeting: [
    // 注意：文档名已在侧边栏/面包屑显示，默认内容不再放同名 H1 标题，直接从正文开始
    ['paragraph', '日期：2026-09-23 ｜ 参会人：产品、前端、后端'],
    ['heading2', '议题一：并发编辑 Bug 排查'],
    ['paragraph', '两端在同一块高频输入时出现"倒三角"块分裂现象，块数量指数级增长。'],
    ['bullet', '根因：块级 CRDT 每次更新是"删旧+插新"，并发下双方操作都被保留'],
    ['bullet', '解决方案：升级到字符级 CRDT（Y.Text），操作粒度降到单字符'],
    ['bullet', '预计工作量：2 天，前端 + 服务端同步改造'],
    ['heading2', '议题二：在线用户同步'],
    ['paragraph', '手机端有时少显示一个在线用户，电脑端正常。'],
    ['bullet', '根因：Awareness 只广播增量更新，手机后台重连可能漏掉某个用户的初始状态'],
    ['bullet', '解决方案：服务端定期全量广播 + 客户端回前台主动拉取'],
    ['heading2', '待跟进事项'],
    ['bullet', '前端：完成光标劈叉 Bug 修复（Bug 7）'],
    ['bullet', '后端：接入 AI 助手接口，支持跨文档问答'],
    ['bullet', '运维：周日前完成公网 Demo 部署'],
  ],
  todo: [
    ['heading2', '本周'],
    ['bullet', '完成字符级 CRDT 改造（v3）✅'],
    ['bullet', '修复并发光标劈叉问题（Bug 7）✅'],
    ['bullet', '在线用户多端同步修复 ✅'],
    ['bullet', '工作区多文档打通 🚧 进行中'],
    ['bullet', 'AI 助手跨文档问答 🚧 进行中'],
    ['heading2', '下周'],
    ['bullet', '公网 Demo 部署（阿里云轻量 + Nginx）'],
    ['bullet', '富文本格式支持（加粗 / 斜体 / 链接）'],
    ['bullet', '版本快照与历史回退'],
    ['heading2', '长期'],
    ['bullet', '评论 / 批注功能'],
    ['bullet', '精确光标渲染（文本内光标竖线）'],
    ['bullet', '团队工作区 / 权限管理'],
  ],
  daily: [
    ['heading2', '2026-09-25 周五'],
    ['bullet', '上午：修复在线用户多端同步 Bug，手机端少显示一人的问题'],
    ['bullet', '下午：打通工作区多文档，AI 助手改为读取整个工作区上下文'],
    ['bullet', '晚上：精简 README，移除面试相关措辞，增加 AI 助手展示模块'],
    ['quote', '💡 今日收获：分布式状态同步问题看似简单，实际涉及心跳检测、幽灵节点、增量 vs 全量广播等经典问题。'],
    ['heading2', '2026-09-24 周四'],
    ['bullet', '完成 v3 字符级 CRDT 改造，Y.Text 替代整块 string 替换'],
    ['bullet', '修复 Bug 7 光标劈叉问题，改用 Y.RelativePosition'],
    ['bullet', '接入 DeepSeek AI 助手，SSE 流式输出'],
    ['heading2', '2026-09-23 周三'],
    ['bullet', '真机测试 v2 块级 CRDT，发现倒三角分裂、删除失效等问题'],
    ['bullet', '确认升级字符级 CRDT 的技术方案，开始 v3 开发'],
  ],
};

/** 获取指定文档的默认块列表（每次返回全新实例；未知文档 ID → 一块空段落，即空白文档） */
function getDefaultBlocks(docName: string): Y.Map<any>[] {
  const defs: Array<[string, string]> = DEFAULT_BLOCK_DEFS[docName] ?? [['paragraph', '']];
  return defs.map(([kind, text], i) => createBlock(`${docName}-init-${i + 1}`, kind, text));
}

/** 文档 ID → 侧边栏显示名（用于清理文档内与文档名重复的 H1 标题块） */
const WORKSPACE_DOC_NAMES: Record<string, string> = {
  prd: '产品需求文档',
  meeting: '会议纪要',
  todo: '待办清单',
  daily: '每日速记',
};

/** 所有工作区文档名集合 —— 任何文档名的 H1 出现在任何房间都是脏数据（含跨文档串台），一律清除 */
const ALL_DOC_NAMES = new Set(Object.values(WORKSPACE_DOC_NAMES));

/** 读取块文本（兼容历史数据里 text 为普通 string 的 v2 旧格式） */
function blockText(m: Y.Map<any>): string {
  const t = m.get('text');
  if (typeof t === 'string') return t;
  return t ? t.toString() : '';
}

/**
 * 内容健康检查：去重 + 清理冗余 H1
 *
 * 背景：开发期客户端 IndexedDB 常残留旧版本的脏数据，
 * 重连时 CRDT 会把两边内容都保留 → 默认内容翻倍、出现已删除的旧 H1 标题等。
 * 这个函数是服务端的最后一道防线：
 *   1. 按块 id 去重（同 id 只保留第一个）
 *   2. 删除所有与文档显示名相同的 H1 块
 * 返回被清理的块数量（供日志记录）。
 */
function dedupeAndCleanBlocks(docName: string, yblocks: Y.Array<any>): number {
  const blocks = yblocks.toArray() as Y.Map<any>[];
  if (blocks.length === 0) return 0;

  const seenIds = new Set<string>();
  const indicesToRemove: number[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const id = b.get('id') as string;
    const kind = b.get('kind') as string;

    // 规则 1：同 id 的块只保留第一个（重复的都是 CRDT 合并出来的脏数据）
    if (id && seenIds.has(id)) {
      indicesToRemove.push(i);
      continue;
    }
    if (id) seenIds.add(id);

    // 规则 2：任何工作区文档名的 H1 都是脏数据，一律删除。
    // 历史教训：早期版本给每个文档的默认内容都塞过 H1 标题，串台污染更是让
    // "产品需求文档"这个 H1 出现在会议纪要/待办清单/每日速记/新建文档里。
    // 只匹配"本房间文档名"会漏掉串台来的标题，所以这里匹配所有文档名。
    if (kind === 'heading1' && ALL_DOC_NAMES.has(blockText(b).trim())) {
      indicesToRemove.push(i);
    }
  }

  if (indicesToRemove.length === 0) return 0;

  // 从后往前删，保证前面的索引不失效
  // 注意：Y.Array.delete(idx, count) 是连续删除，用单删更精准
  for (let i = indicesToRemove.length - 1; i >= 0; i--) {
    yblocks.delete(indicesToRemove[i], 1);
  }

  console.log(
    `[cleanup] room="${docName}" removed ${indicesToRemove.length} blocks ` +
    `(duplicates + redundant H1), ${yblocks.length} remaining`
  );
  return indicesToRemove.length;
}

/** 房间创建的 Promise 缓存：防止并发首次访问同一房间时初始化两份默认内容 */
const roomPromises = new Map<string, Promise<{ doc: Y.Doc; awareness: awarenessProtocol.Awareness }>>();

/** 获取或创建房间（支持持久化 + 并发保护） */
function getRoom(docName: string) {
  const existing = docs.get(docName);
  if (existing) return Promise.resolve(existing);

  let p = roomPromises.get(docName);
  if (!p) {
    p = createRoom(docName);
    roomPromises.set(docName, p);
    p.finally(() => roomPromises.delete(docName)).catch(() => {});
  }
  return p;
}

async function createRoom(docName: string) {
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
  }
  persistedDoc.destroy();

  const yblocks = doc.getArray('blocks');

  // ---- 初始化标记：默认内容只允许写入一次 ----
  // meta 是文档内的 Y.Map，会随文档一起持久化。无论初始化代码被意外执行多少次
  // （并发建房、热更新、未来误改），标记存在就绝不再插入第二份默认内容
  const ymeta = doc.getMap('meta');
  if (ymeta.get('initialized') !== true) {
    ymeta.set('initialized', true);
    if (yblocks.length === 0) {
      // 没有持久化数据，塞初始内容（会触发上面的 update 监听器，把默认内容也存进 LevelDB）
      yblocks.push(getDefaultBlocks(docName));
      console.log(`[persistence] no data for "${docName}", initialized with default content (${yblocks.length} blocks)`);
    }
  }

  // ---- 内容健康检查：去重 + 清理冗余 H1 ----
  // 开发期常见问题：客户端 IndexedDB 存了旧版本的脏数据，重连时通过 CRDT 合并回服务端，
  // 导致默认内容翻倍、出现已删除的"文档同名 H1 标题"等。
  // 这里做两道清理：
  //   1. 按块的 id 去重（同 id 的块只保留第一个）——解决内容翻倍
  //   2. 删除所有与文档名相同的 H1 块——解决侧边栏/面包屑已显示标题，文档内再写一遍就冗余
  // 这是服务端的最后一道防线，即使客户端缓存再脏，服务端也能自动纠正。
  dedupeAndCleanBlocks(docName, yblocks);

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

  const room = { doc, awareness };
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
/**
 * 向指定房间的所有连接广播完整的 awareness 列表（全量同步）。
 *
 * 用途：
 *   1. 新用户加入时立即广播一次——让老用户瞬间看到新人，不等 10s 全量周期
 *   2. 定时兜底广播——防止增量更新丢帧导致的在线列表不一致
 * 返回实际发送的客户端数量。
 */
function broadcastFullAwareness(docName: string, awareness: awarenessProtocol.Awareness): number {
  const allIds = Array.from(awareness.getStates().keys());
  if (allIds.length === 0) return 0;
  const connSet = connections.get(docName);
  if (!connSet || connSet.size === 0) return 0;

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1); // message type = awareness
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, allIds)
  );
  const message = encoding.toUint8Array(encoder);

  let sent = 0;
  for (const ws of connSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
    }
  }
  return sent;
}

const FULL_AWARENESS_INTERVAL = 10000;
setInterval(() => {
  for (const [docName, room] of docs) {
    const sent = broadcastFullAwareness(docName, room.awareness);
    if (sent > 0) {
      const userCount = room.awareness.getStates().size;
      console.log(
        `[awareness] full broadcast room="${docName}" users=${userCount} clients=${sent}`
      );
    }
  }
}, FULL_AWARENESS_INTERVAL);
console.log(`[awareness] full broadcast every ${FULL_AWARENESS_INTERVAL / 1000}s (safety net)`);

// ---- 内容健康检查定期执行（兜底机制）----
// 客户端带着旧 IndexedDB 缓存重连时，CRDT 合并可能产生重复块。
// 每 30 秒扫一遍所有房间，自动清理重复块和冗余 H1。
// 正常情况下什么都不做；真有脏数据也能在 30 秒内自动纠正。
const HEALTH_CHECK_INTERVAL = 30000;
setInterval(() => {
  let totalCleaned = 0;
  for (const [docName, room] of docs) {
    const yblocks = room.doc.getArray<any>('blocks');
    const removed = dedupeAndCleanBlocks(docName, yblocks);
    totalCleaned += removed;
  }
  if (totalCleaned > 0) {
    console.log(`[health-check] cleaned ${totalCleaned} dirty blocks across ${docs.size} rooms`);
  }
}, HEALTH_CHECK_INTERVAL);
console.log(`[health-check] runs every ${HEALTH_CHECK_INTERVAL / 1000}s (dedup + H1 cleanup)`);

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

  // 新用户加入时，立即向房间里所有人全量广播一次在线列表。
  // 原有的增量广播（awareness.on('update')）会通知老用户"来了新人"，
  // 但网络抖动可能导致某端丢帧，需要等 10 秒的全量周期才能补上。
  // 这里追加一次主动全量广播，把"最快看到对方"的延迟从"下一个 10 秒周期"
  // 降到"连接建立瞬间"，尤其改善手机端打开后在线用户列表迟迟不全的体验。
  // 注意：这一步在 clientId 写入 awareness 之前执行，等客户端回第一个 sync
  // 后 awareness update 会再触发一次增量广播——两次之间的极小窗口不影响正确性。
  // 为避免重复日志，只在确实有多个客户端时才打 log。
  if (connCount > 1) {
    const sent = broadcastFullAwareness(docName, room.awareness);
    if (sent > 0) {
      const userCount = room.awareness.getStates().size;
      console.log(
        `[awareness] join-triggered full broadcast room="${docName}" ` +
        `users=${userCount} clients=${sent}`
      );
    }
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

// 工作区文档列表（与前端侧边栏对应）
const WORKSPACE_DOCS = [
  { id: 'prd',     name: '产品需求文档' },
  { id: 'meeting', name: '会议纪要' },
  { id: 'todo',    name: '待办清单' },
  { id: 'daily',   name: '每日速记' },
];

/** 从 LevelDB 加载一篇文档的纯文本内容（只读，不修改共享状态） */
async function loadDocText(docId: string): Promise<string> {
  const ydoc = await persistence.getYDoc(docId);
  const yblocks = ydoc.getArray<any>('blocks');
  const lines: string[] = [];
  for (const ymap of yblocks.toArray() as Y.Map<any>[]) {
    const kind = ymap.get('kind') as string;
    const text = (ymap.get('text') as Y.Text)?.toString() ?? '';
    // 用块类型做前缀，让 AI 知道这是标题/正文/列表
    const prefix: Record<string, string> = {
      heading1: '# ',
      heading2: '## ',
      bullet: '- ',
      quote: '> ',
      paragraph: '',
    };
    lines.push((prefix[kind] ?? '') + text);
  }
  ydoc.destroy();
  return lines.join('\n');
}

/** 加载整个工作区所有文档，拼接为带标题的长文本（docs 由前端传入，含新建文档） */
async function loadWorkspaceContext(docsList: { id: string; name: string }[]): Promise<string> {
  const list = docsList.length > 0 ? docsList : WORKSPACE_DOCS;
  const parts: string[] = [];
  for (const doc of list) {
    const content = await loadDocText(doc.id);
    parts.push(`## ${doc.name}\n\n${content || '(文档为空)'}`);
  }
  return parts.join('\n\n---\n\n');
}

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

  const { question, roomName, docs: docsFromClient, scope } = data;
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

  // 解析范围：doc = 仅当前文档，workspace（默认）= 整个工作区
  const useScope: 'doc' | 'workspace' = scope === 'doc' ? 'doc' : 'workspace';

  // 构造文档列表
  const docsList: { id: string; name: string }[] = Array.isArray(docsFromClient)
    ? docsFromClient.filter((d: any) => d && typeof d.id === 'string' && typeof d.name === 'string')
    : [];

  const currentDocName = docsList.find((d) => d.id === roomName)?.name
    ?? WORKSPACE_DOCS.find((d) => d.id === roomName)?.name
    ?? '当前文档';

  // 根据范围加载上下文
  let context: string;
  let scopeLabel: string;
  if (useScope === 'doc') {
    context = await loadDocText(roomName);
    if (!context) context = '（文档为空）';
    scopeLabel = `当前文档：${currentDocName}`;
  } else {
    context = await loadWorkspaceContext(docsList);
    scopeLabel = `工作区全部 ${docsList.length || 4} 篇文档`;
  }

  console.log(
    `[ai] chat scope=${useScope} currentDoc="${currentDocName}" ` +
    `question="${question.slice(0, 60)}" contextLen=${context.length} chars`
  );

  // 组装系统提示（根据 scope 调整语气和引用规则）
  const docModeHint = useScope === 'doc'
    ? '回答基于当前这篇文档的内容。'
    : '回答基于工作区中的所有文档内容。引用内容时请注明来自哪篇文档。';
  const systemPrompt = `你是一个协同文档写作助手。
${docModeHint} 如果答案不在文档中，请明确说明。
回答要简洁、结构化，使用 Markdown 格式。

上下文范围：${scopeLabel}
用户当前正在查看的文档：${currentDocName}

文档内容：
---
${context}
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