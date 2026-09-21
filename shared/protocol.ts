/**
 * 前后端共享的消息协议定义。
 * 两边都通过相对路径 import 这份文件，保证类型一致。
 */

export interface Block {
  id: string;
  text: string;
}

export type OpType = 'replaceText' | 'addBlock' | 'removeBlock';

export interface Op {
  id: string; // 客户端生成的唯一操作 ID，服务端用于去重（幂等）
  clientId: string;
  seq: number; // 每个客户端的本地操作序号
  type: OpType;
  blockId: string; // replaceText/removeBlock 目标块；addBlock 时为新块 id
  start?: number; // replaceText: 替换区间起点
  end?: number; // replaceText: 替换区间终点（含）
  text?: string; // replaceText: 新文本
  pos?: number; // addBlock: 插入位置
}

/** 一次快照，客户端收到后整体替换本地文档 */
export interface DocSnapshot {
  blocks: Block[];
  version: number;
}

export interface ClientInfo {
  clientId: string;
  name: string;
  color: string;
}

export type ClientMessage =
  | { type: 'hello'; clientId: string; name: string }
  | { type: 'op'; op: Op }
  | { type: 'lock'; blockId: string; want: boolean };

export type ServerMessage =
  | { type: 'welcome'; clientId: string; name: string; snapshot: DocSnapshot; locks: Record<string, string> }
  | { type: 'state'; version: number; blocks: Block[]; appliedOps: string[] }
  | { type: 'ack'; opId: string; rejected: boolean; version: number }
  | { type: 'presence'; clients: ClientInfo[] }
  | { type: 'lockGranted'; blockId: string }
  | { type: 'lockTaken'; blockId: string; by: string }
  | { type: 'lockReleased'; blockId: string }
  | { type: 'toast'; message: string };