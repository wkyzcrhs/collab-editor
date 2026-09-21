import { useCallback, useEffect, useRef, useState } from 'react';
import type { Block, ClientInfo, ClientMessage, Op, ServerMessage } from '../../shared/protocol';
import { applyOp } from '../../shared/mutate';

const WS_URL = `ws://${window.location.hostname || 'localhost'}:8787`;
const RETRY_MS = 3000;
const MAX_BACKOFF = 8000;

let UID = 0;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(UID++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface QueueItem {
  op: Op;
  sent: boolean;
  timer: number | null;
}

/**
 * 连接协同服务端，并封装一套小型「可靠同步」客户端：
 *   - 乐观更新：操作先应用本地，不等服务端确认
 *   - ACK 队列：按序发送，收到 ack 才出队、发送下一条
 *   - 重试 + 幂等：未确认操作周期性重发，服务端按 opId 去重
 *   - 断线重连：指数退避；重连后重发未确认队列
 *   - 冲突兜底：块级锁 + 最后写入生效（本 Demo 不使用 OT/CRDT）
 */
export function useCollab() {
  const myId = useRef(uid('c')).current;
  const name = useRef(`用户-${Math.floor(Math.random() * 9000 + 1000)}`).current;

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const blocksRef = useRef<Block[]>([]); // 本地工作副本（含乐观更新）
  const committedRef = useRef<Block[]>([]); // 最近一次服务端权威快照
  const seqRef = useRef(0);
  const backoffRef = useRef(1000);
  const connectTimerRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [version, setVersion] = useState(0);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [locks, setLocks] = useState<Record<string, string>>({});

  const sendJson = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** 未确认操作的重试：周期性重发，服务端按 opId 幂等去重 */
  const scheduleRetry = useCallback((item: QueueItem) => {
    if (item.timer) clearTimeout(item.timer);
    item.timer = window.setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'op', op: item.op } as ClientMessage));
      }
      scheduleRetry(item);
    }, RETRY_MS);
  }, []);

  const flush = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const item of queueRef.current) {
      if (!item.sent) {
        item.sent = true;
        ws.send(JSON.stringify({ type: 'op', op: item.op } as ClientMessage));
        scheduleRetry(item);
        break; // 同一时刻只推进到队首（按序保证）
      }
    }
  }, [scheduleRetry]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const onAck = useCallback((opId: string) => {
    const idx = queueRef.current.findIndex((q) => q.op.id === opId);
    if (idx >= 0) {
      const [item] = queueRef.current.splice(idx, 1);
      if (item.timer) clearTimeout(item.timer);
      flushRef.current();
    }
  }, []);

  const onRejected = useCallback(() => {
    // 操作被拒（如目标块已不存在）：撤销乐观更新，回到最近一次权威快照
    blocksRef.current = committedRef.current.map((b) => ({ ...b }));
    setBlocks([...blocksRef.current]);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        backoffRef.current = 1000;
        sendJson({ type: 'hello', clientId: myId, name });
        // 重连后：未确认的操作全部重置为未发送，按序重发
        for (const item of queueRef.current) item.sent = false;
        flushRef.current();
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        switch (msg.type) {
          case 'welcome':
            committedRef.current = msg.snapshot.blocks;
            blocksRef.current = msg.snapshot.blocks;
            setBlocks(msg.snapshot.blocks);
            setVersion(msg.snapshot.version);
            setLocks({ ...msg.locks });
            break;
          case 'state':
            committedRef.current = msg.blocks;
            blocksRef.current = msg.blocks;
            setBlocks(msg.blocks);
            setVersion(msg.version);
            break;
          case 'ack':
            if (msg.rejected) onRejected();
            setVersion(msg.version);
            onAck(msg.opId);
            break;
          case 'presence':
            setClients(msg.clients);
            break;
          case 'lockGranted':
            setLocks((l) => ({ ...l, [msg.blockId]: myId }));
            break;
          case 'lockTaken':
            setLocks((l) => ({ ...l, [msg.blockId]: msg.by }));
            break;
          case 'lockReleased':
            setLocks((l) => {
              const next = { ...l };
              delete next[msg.blockId];
              return next;
            });
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
        connectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
      wsRef.current?.close();
    };
  }, [myId, name, sendJson, onAck, onRejected]);
  /* eslint-enable react-hooks/exhaustive-deps */

  /** 本地应用一个操作（乐观更新）并入队，等待服务端 ack */
  const applyLocalOp = useCallback(
    (op: Partial<Op> & Pick<Op, 'type' | 'blockId'>) => {
      const full: Op = {
        id: op.id ?? uid('op'),
        clientId: myId,
        seq: ++seqRef.current,
        type: op.type,
        blockId: op.blockId,
        start: op.start,
        end: op.end,
        text: op.text,
        pos: op.pos
      };
      blocksRef.current = applyOp(blocksRef.current, full);
      setBlocks([...blocksRef.current]);
      queueRef.current.push({ op: full, sent: false, timer: null });
      flushRef.current();
    },
    [myId]
  );

  const requestLock = useCallback((blockId: string, want: boolean) => {
    sendJson({ type: 'lock', blockId, want });
  }, [sendJson]);

  return { blocks, version, connected, clients, locks, myId, name, applyLocalOp, requestLock };
}