import { useCallback, useState, useRef, useEffect } from 'react';
import type { Block, BlockKind } from '../../shared/protocol';
import type { useYjsDoc } from './useYjsDoc';

type Collab = ReturnType<typeof useYjsDoc>;

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
  const { blocks, updateBlockText, addBlock, removeBlock, changeBlockKind, undo, redo } = collab;
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  // 当前正在编辑的块（用 ref 避免 state 异步延迟）
  // 工具栏按钮点击时需要同步拿到最新的 blockId
  const activeBlockIdRef = useRef<string | null>(null);

  // 输入法 composition 状态
  // composition 期间只更新本地 textarea，不同步到 Yjs
  // 防止拼音中间态被记录进 UndoManager 历史
  const composingRef = useRef<{ blockId: string; text: string } | null>(null);

  // 保存光标位置（Yjs 更新触发 re-render 后恢复）
  const cursorRef = useRef<{ blockId: string; start: number; end: number } | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  // 同步 activeBlockId 到 ref
  const setActive = useCallback((blockId: string | null) => {
    activeBlockIdRef.current = blockId;
  }, []);

  // ---- 光标位置恢复 ----
  // 每次 blocks 更新后，如果当前有聚焦的块，恢复光标位置
  useEffect(() => {
    const saved = cursorRef.current;
    if (!saved) return;
    const ta = textareaRefs.current.get(saved.blockId);
    if (ta && document.activeElement === ta) {
      const maxLen = ta.value.length;
      ta.setSelectionRange(
        Math.min(saved.start, maxLen),
        Math.min(saved.end, maxLen)
      );
    }
  }, [blocks]);

  // ---- 编辑处理 ----
  const onEdit = useCallback(
    (blockId: string, next: string) => {
      // 输入法 composition 期间，不同步到 Yjs
      // 只在 composition 结束时一次性同步
      if (composingRef.current?.blockId === blockId) {
        composingRef.current.text = next;
        // composition 期间也要刷新光标（本地显示用）
        return;
      }
      updateBlockText(blockId, next);
    },
    [updateBlockText]
  );

  // ---- 输入法 composition 事件 ----
  const onCompositionStart = useCallback((blockId: string) => {
    // 开始输入拼音，标记 composition 状态
    const block = blocks.find((b) => b.id === blockId);
    composingRef.current = {
      blockId,
      text: block?.text ?? '',
    };
  }, [blocks]);

  const onCompositionEnd = useCallback((blockId: string, finalText: string) => {
    // 拼音上屏，一次性同步到 Yjs
    const wasComposing = composingRef.current?.blockId === blockId;
    composingRef.current = null;
    if (wasComposing) {
      updateBlockText(blockId, finalText);
    }
  }, [updateBlockText]);

  // ---- 焦点 / 光标追踪 ----
  const onFocus = useCallback((blockId: string, e: React.FocusEvent<HTMLTextAreaElement>) => {
    setActive(blockId);
    cursorRef.current = {
      blockId,
      start: e.target.selectionStart,
      end: e.target.selectionEnd,
    };
  }, [setActive]);

  const onBlur = useCallback((blockId: string) => {
    if (activeBlockIdRef.current === blockId) {
      cursorRef.current = null;
    }
  }, []);

  // 记录每次按键后的光标位置
  const onKeyUp = useCallback((blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.target as HTMLTextAreaElement;
    cursorRef.current = {
      blockId,
      start: ta.selectionStart,
      end: ta.selectionEnd,
    };
  }, []);

  // 在 select 事件里也记录（鼠标选中文本时）
  const onSelect = useCallback((blockId: string, e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.target as HTMLTextAreaElement;
    if (document.activeElement === ta) {
      cursorRef.current = {
        blockId,
        start: ta.selectionStart,
        end: ta.selectionEnd,
      };
    }
  }, []);

  const onAddBlock = useCallback(() => {
    addBlock(undefined, 'paragraph');
  }, [addBlock]);

  const onRemoveBlock = useCallback(
    (blockId: string) => {
      removeBlock(blockId);
    },
    [removeBlock]
  );

  const onChangeKind = useCallback(
    (blockId: string, kind: BlockKind) => {
      changeBlockKind(blockId, kind);
      setMenuOpen(null);
    },
    [changeBlockKind]
  );

  // 工具栏：改变当前激活块的类型
  const setActiveKind = (kind: BlockKind) => {
    if (activeBlockIdRef.current) {
      onChangeKind(activeBlockIdRef.current, kind);
    }
  };

  // 字数统计
  const wordCount = blocks.reduce((sum, b) => sum + b.text.length, 0);

  // 计算 textarea 显示的 value
  // 如果正在 composition 且是当前块，显示本地草稿（中间态不通过 Yjs）
  const getTextareaValue = (block: Block) => {
    if (composingRef.current?.blockId === block.id) {
      return composingRef.current.text;
    }
    return block.text;
  };

  return (
    <>
      {/* 工具栏 */}
      <div className="toolbar">
        <div className="tb-group">
          <button
            className="tb-btn"
            title="一级标题"
            onClick={() => setActiveKind('heading1')}
          >
            H1
          </button>
          <button
            className="tb-btn"
            title="二级标题"
            onClick={() => setActiveKind('heading2')}
          >
            H2
          </button>
          <div className="tb-sep" />
          <button
            className="tb-btn"
            title="正文"
            onClick={() => setActiveKind('paragraph')}
          >
            ¶
          </button>
          <button
            className="tb-btn"
            title="无序列表"
            onClick={() => setActiveKind('bullet')}
          >
            •
          </button>
          <button
            className="tb-btn"
            title="引用"
            onClick={() => setActiveKind('quote')}
          >
            ❝
          </button>
        </div>
        <div className="tb-right">
          <button className="tb-btn" title="撤销 (Ctrl+Z)" onClick={undo}>
            ↶
          </button>
          <button className="tb-btn" title="重做 (Ctrl+Y)" onClick={redo}>
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
            const showMenu = menuOpen === block.id;
            const value = getTextareaValue(block);

            return (
              <div
                key={block.id}
                className={`block kind-${block.kind}`}
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
                  ref={(el) => {
                    if (el) {
                      textareaRefs.current.set(block.id, el);
                    } else {
                      textareaRefs.current.delete(block.id);
                    }
                  }}
                  className="block-content"
                  rows={Math.max(1, value.split('\n').length)}
                  value={value}
                  placeholder={
                    block.kind === 'heading1'
                      ? '一级标题'
                      : block.kind === 'heading2'
                      ? '二级标题'
                      : block.kind === 'quote'
                      ? '引用…'
                      : block.kind === 'bullet'
                      ? '列表项'
                      : "输入 '/' 使用命令"
                  }
                  onFocus={(e) => onFocus(block.id, e)}
                  onBlur={() => onBlur(block.id)}
                  onKeyUp={(e) => onKeyUp(block.id, e)}
                  onSelect={(e) => onSelect(block.id, e)}
                  onCompositionStart={() => onCompositionStart(block.id)}
                  onCompositionEnd={(e) => onCompositionEnd(block.id, e.currentTarget.value)}
                  onChange={(e) => {
                    const next = e.target.value;
                    // 实时记录光标位置
                    cursorRef.current = {
                      blockId: block.id,
                      start: e.target.selectionStart,
                      end: e.target.selectionEnd,
                    };
                    if (block.text === next && composingRef.current?.blockId !== block.id) return;
                    onEdit(block.id, next);
                  }}
                />

                <button
                  className="block-delete-btn"
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
        <div className="status-item">就绪 · CRDT 实时协同</div>
        <div className="status-right">
          <div className="status-item">{blocks.length} 块</div>
          <div className="status-item">{wordCount} 字</div>
          <div className="status-item">自动保存 · 已同步</div>
        </div>
      </div>
    </>
  );
}
