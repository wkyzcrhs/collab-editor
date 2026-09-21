import { useCallback, useEffect, useRef } from 'react';
import type { useCollab } from './useCollab';

type Collab = ReturnType<typeof useCollab>;

interface EditEntry {
  blockId: string;
  before: string;
  after: string;
}

interface EditorProps {
  collab: Collab;
}

export function Editor({ collab }: EditorProps) {
  const { blocks, locks, myId, applyLocalOp, requestLock } = collab;

  const undoRef = useRef<EditEntry[]>([]);
  const redoRef = useRef<EditEntry[]>([]);
  const focusRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAddedRef = useRef<string | null>(null);

  // 新增块后自动聚焦
  useEffect(() => {
    if (lastAddedRef.current && focusRef.current) {
      focusRef.current.focus();
      lastAddedRef.current = null;
    }
  }, [blocks]);

  const lockedByOther = useCallback(
    (blockId: string) => !!locks[blockId] && locks[blockId] !== myId,
    [locks, myId]
  );
  const lockedByMe = useCallback(
    (blockId: string) => locks[blockId] === myId,
    [locks, myId]
  );

  const onEdit = useCallback(
    (prev: string, blockId: string, next: string) => {
      undoRef.current.push({ blockId, before: prev, after: next });
      redoRef.current = [];
      applyLocalOp({ type: 'replaceText', blockId, start: 0, end: prev.length, text: next });
    },
    [applyLocalOp]
  );

  const onUndo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push(entry);
    applyLocalOp({ type: 'replaceText', blockId: entry.blockId, start: 0, end: entry.after.length, text: entry.before });
  }, [applyLocalOp]);

  const onRedo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(entry);
    applyLocalOp({ type: 'replaceText', blockId: entry.blockId, start: 0, end: entry.before.length, text: entry.after });
  }, [applyLocalOp]);

  const onAddBlock = useCallback(() => {
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    lastAddedRef.current = id;
    applyLocalOp({ type: 'addBlock', blockId: id, pos: blocks.length, text: '' });
    requestLock(id, true);
  }, [applyLocalOp, blocks.length, requestLock]);

  const onRemoveBlock = useCallback(
    (blockId: string) => {
      if (lockedByOther(blockId)) return;
      applyLocalOp({ type: 'removeBlock', blockId });
      requestLock(blockId, false);
    },
    [applyLocalOp, lockedByOther, requestLock]
  );

  return (
    <div className="editor">
      <div className="toolbar">
        <button className="btn-tool" onClick={onUndo} title="撤销（Ctrl+Z）">
          ↶ 撤销
        </button>
        <button className="btn-tool" onClick={onRedo} title="重做（Ctrl+Shift+Z）">
          ↷ 重做
        </button>
        <span className="toolbar-hint">操作经 WebSocket 同步 · 块级锁防止同块并发冲突</span>
      </div>
      <div className="blocks">
      {blocks.map((block) => {
        const isLockedOther = lockedByOther(block.id);
        const isLockedMe = lockedByMe(block.id);
        return (
          <div key={block.id} className={`block ${isLockedOther ? 'block-locked-other' : ''} ${isLockedMe ? 'block-locked-me' : ''}`}>
            <div className="block-head">
              <span className="block-index">{blocks.indexOf(block) + 1}</span>
              {isLockedOther ? (
                <span className="lock-badge badge-other">他人编辑中</span>
              ) : isLockedMe ? (
                <span className="lock-badge badge-me">我编辑中</span>
              ) : (
                <span className="lock-badge badge-idle">可编辑</span>
              )}
              <button
                className="btn-mini"
                disabled={isLockedOther}
                onClick={() => onRemoveBlock(block.id)}
                title="删除此块"
              >
                删除
              </button>
            </div>
            <textarea
              ref={isLockedMe && blocks[blocks.length - 1]?.id === block.id ? focusRef : undefined}
              className="block-input"
              rows={Math.max(2, block.text.split('\n').length)}
              value={block.text}
              readOnly={isLockedOther}
              placeholder="输入文字…"
              onFocus={() => requestLock(block.id, true)}
              onBlur={() => {
                if (lockedByMe(block.id)) requestLock(block.id, false);
              }}
              onChange={(e) => {
                if (isLockedOther) return;
                const prev = block.text;
                const next = e.target.value;
                if (prev === next) return;
                onEdit(prev, block.id, next);
              }}
            />
          </div>
        );
      })}
      <button className="btn-add" onClick={onAddBlock}>
        + 添加一个块
      </button>
    </div>
    </div>
  );
}