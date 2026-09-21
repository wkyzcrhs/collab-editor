/**
 * 对文档块列表应用一个操作，返回新的块数组（不可变）。
 * 客户端用来做「乐观更新」，服务端用来实际落库，保证语义一致。
 */
import type { Block, Op } from './protocol';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function applyOp(blocks: Block[], op: Op): Block[] {
  switch (op.type) {
    case 'replaceText': {
      const target = blocks.find((b) => b.id === op.blockId);
      if (!target) return blocks;
      const start = clamp(op.start ?? 0, 0, target.text.length);
      const end = clamp(op.end ?? start, start, target.text.length);
      const text = target.text.slice(0, start) + (op.text ?? '') + target.text.slice(end);
      return blocks.map((b) => (b.id === op.blockId ? { ...b, text } : b));
    }
    case 'addBlock': {
      const block: Block = { id: op.blockId, text: op.text ?? '' };
      const pos = clamp(op.pos ?? blocks.length, 0, blocks.length);
      const next = [...blocks];
      next.splice(pos, 0, block);
      return next;
    }
    case 'removeBlock': {
      return blocks.filter((b) => b.id !== op.blockId);
    }
    default:
      return blocks;
  }
}