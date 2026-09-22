import { useCallback, useState } from 'react';
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

  // 当前正在编辑的块（用来让工具栏知道该改哪个块的类型）
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);

  const onEdit = useCallback(
    (blockId: string, next: string) => {
      updateBlockText(blockId, next);
    },
    [updateBlockText]
  );

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
    if (activeBlockId) {
      onChangeKind(activeBlockId, kind);
    }
  };

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
                  className="block-content"
                  rows={Math.max(1, block.text.split('\n').length)}
                  value={block.text}
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
                  onFocus={() => setActiveBlockId(block.id)}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (block.text === next) return;
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