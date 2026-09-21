import { useCallback, useRef, useState } from 'react';
import type { Block, BlockKind } from '../../shared/protocol';
import type { useCollab } from './useCollab';

type Collab = ReturnType<typeof useCollab>;

interface HistoryEntry {
  blockId: string;
  before: string;
  after: string;
}

const BLOCK_KINDS: { kind: BlockKind; label: string; icon: string }[] = [
  { kind: 'paragraph', label: '正文', icon: '¶' },
  { kind: 'heading1', label: '一级标题', icon: 'H1' },
  { kind: 'heading2', label: '二级标题', icon: 'H2' },
  { kind: 'bullet', label: '无序列表', icon: '•' },
  { kind: 'quote', label: '引用', icon: '❝' },
];

interface EditorProps {
  collab: Collab;
}

export function Editor({ collab }: EditorProps) {
  const { blocks, locks, myId, applyLocalOp, requestLock } = collab;
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const undoRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);

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
    applyLocalOp({ type: 'addBlock', blockId: id, pos: blocks.length, kind: 'paragraph', text: '' });
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

  const onChangeKind = useCallback(
    (blockId: string, kind: BlockKind) => {
      applyLocalOp({ type: 'changeBlockKind', blockId, kind });
      setMenuOpen(null);
    },
    [applyLocalOp]
  );

  // 字数统计
  const wordCount = blocks.reduce((sum, b) => sum + b.text.length, 0);

  return (
    <>
      {/* 工具栏 */}
      <div className="toolbar">
        <div className="tb-group">
          <button
            className="tb-btn"
            title="一级标题"
            onClick={() => {
              const first = blocks.find((b) => lockedByMe(b.id));
              if (first) onChangeKind(first.id, 'heading1');
            }}
          >
            H1
          </button>
          <button
            className="tb-btn"
            title="二级标题"
            onClick={() => {
              const first = blocks.find((b) => lockedByMe(b.id));
              if (first) onChangeKind(first.id, 'heading2');
            }}
          >
            H2
          </button>
          <div className="tb-sep" />
          <button
            className="tb-btn"
            title="正文"
            onClick={() => {
              const first = blocks.find((b) => lockedByMe(b.id));
              if (first) onChangeKind(first.id, 'paragraph');
            }}
          >
            ¶
          </button>
          <button
            className="tb-btn"
            title="无序列表"
            onClick={() => {
              const first = blocks.find((b) => lockedByMe(b.id));
              if (first) onChangeKind(first.id, 'bullet');
            }}
          >
            •
          </button>
          <button
            className="tb-btn"
            title="引用"
            onClick={() => {
              const first = blocks.find((b) => lockedByMe(b.id));
              if (first) onChangeKind(first.id, 'quote');
            }}
          >
            ❝
          </button>
        </div>
        <div className="tb-right">
          <button className="tb-btn" title="撤销" onClick={onUndo}>
            ↶
          </button>
          <button className="tb-btn" title="重做" onClick={onRedo}>
            ↷
          </button>
        </div>
      </div>

      {/* 文档区 */}
      <div className="doc-scroller">
        <div className="doc-content">
          <div className="doc-title" contentEditable suppressContentEditableWarning>
            产品需求文档
          </div>

          {blocks.map((block: Block) => {
            const isLockedOther = lockedByOther(block.id);
            const isLockedMe = lockedByMe(block.id);
            const showMenu = menuOpen === block.id;

            return (
              <div
                key={block.id}
                className={`block kind-${block.kind} ${isLockedOther ? 'block-locked-other' : ''} ${
                  isLockedMe ? 'block-locked-me' : ''
                }`}
              >
                <div
                  className="block-handle"
                  title="切换块类型"
                  onClick={() => setMenuOpen(showMenu ? null : block.id)}
                >
                  ⋮⋮
                </div>

                {showMenu && (
                  <div className="block-menu" onClick={(e) => e.stopPropagation()}>
                    {BLOCK_KINDS.map((k) => (
                      <div
                        key={k.kind}
                        className={`block-menu-item ${block.kind === k.kind ? 'active' : ''}`}
                        onClick={() => onChangeKind(block.id, k.kind)}
                      >
                        <span className="block-menu-icon">{k.icon}</span>
                        {k.label}
                      </div>
                    ))}
                  </div>
                )}

                <textarea
                  className="block-content"
                  rows={Math.max(1, block.text.split('\n').length)}
                  value={block.text}
                  readOnly={isLockedOther}
                  placeholder={block.kind === 'heading1' ? '一级标题' : block.kind === 'heading2' ? '二级标题' : block.kind === 'quote' ? '引用…' : block.kind === 'bullet' ? '列表项' : "输入 '/' 使用命令"}
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

                {isLockedOther && <span className="block-lock-badge">🔒 他人编辑中</span>}
                {isLockedMe && <span className="block-lock-badge" style={{ background: 'var(--brand-soft)', color: 'var(--brand-text)' }}>✏️ 编辑中</span>}

                <button
                  className="block-delete-btn"
                  disabled={isLockedOther}
                  onClick={() => onRemoveBlock(block.id)}
                  title="删除此块"
                >
                  ×
                </button>
              </div>
            );
          })}

          <div className="add-block-row">
            <button className="add-block-btn" onClick={onAddBlock}>
              <span className="add-block-plus">+</span>
              添加一个块
            </button>
          </div>
        </div>
      </div>

      {/* 底部状态栏 */}
      <div className="status-bar">
        <div className="status-item">就绪</div>
        <div className="status-right">
          <div className="status-item">{blocks.length} 块</div>
          <div className="status-item">{wordCount} 字</div>
          <div className="status-item">自动保存 · 已同步</div>
        </div>
      </div>
    </>
  );
}