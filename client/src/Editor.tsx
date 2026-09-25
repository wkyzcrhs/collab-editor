import { useCallback, useState, useRef, useEffect } from 'react';
import * as Y from 'yjs';
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

/**
 * 计算两段文本的差异，应用到 Y.Text
 * 策略：找公共前缀 + 公共后缀，中间部分先删后插
 */
function applyDiffToYText(ytext: Y.Text, oldVal: string, newVal: string) {
  // 公共前缀长度
  let start = 0;
  const minLen = Math.min(oldVal.length, newVal.length);
  while (start < minLen && oldVal[start] === newVal[start]) {
    start++;
  }
  // 公共后缀长度（从后往前找）
  let oldEnd = oldVal.length;
  let newEnd = newVal.length;
  while (oldEnd > start && newEnd > start && oldVal[oldEnd - 1] === newVal[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  // 删除旧的中间部分
  if (oldEnd > start) {
    ytext.delete(start, oldEnd - start);
  }
  // 插入新的中间部分
  if (newEnd > start) {
    ytext.insert(start, newVal.slice(start, newEnd));
  }
}

export function Editor({ collab }: EditorProps) {
  const {
    blocks,
    remoteCursors,
    addBlock,
    removeBlock,
    changeBlockKind,
    getYText,
    updateMyCursor,
    undo,
    redo,
  } = collab;

  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  // 当前正在编辑的块（用 ref 避免 state 异步延迟）
  const activeBlockIdRef = useRef<string | null>(null);

  // 输入法 composition 状态（用 state 驱动渲染）
  const [composing, setComposing] = useState<{ blockId: string; text: string } | null>(null);

  // 保存光标相对位置（Y.RelativePosition）
  // 对方在光标前插入字符时，光标会自动往前挪，不会被"钉死"在中间
  const cursorRelRef = useRef<{
    blockId: string;
    startRel: Y.RelativePosition;
    endRel: Y.RelativePosition;
  } | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  // 记录每个块"上次应用到 Y.Text 的值"，用于计算 diff
  // 防止 onChange → Y.Text 更新 → observe 触发 re-render → onChange 循环
  const lastAppliedRef = useRef<Map<string, string>>(new Map());

  // ---- 工具：保存光标为 Y.RelativePosition ----
  // 用相对位置保存，对方在光标前插入字符时光标自动前移
  const saveCursorRel = useCallback(
    (blockId: string, start: number, end: number) => {
      const ytext = getYText(blockId);
      if (!ytext) return;
      const startRel = Y.createRelativePositionFromTypeIndex(ytext, start);
      const endRel = Y.createRelativePositionFromTypeIndex(ytext, end);
      cursorRelRef.current = { blockId, startRel, endRel };
    },
    [getYText]
  );

  // ---- 工具：广播光标位置 ----
  const broadcastCursor = useCallback(
    (blockId: string | null, pos: number) => {
      if (!blockId) {
        updateMyCursor(null, null);
        return;
      }
      const ytext = getYText(blockId);
      if (!ytext) return;
      // 用 Y.RelativePosition 编码光标位置
      // 即使文本有插入删除，相对位置也能保持正确
      const relPos = Y.createRelativePositionFromTypeIndex(ytext, pos);
      const json = JSON.stringify(relPos);
      updateMyCursor(blockId, json);
    },
    [getYText, updateMyCursor]
  );

  // ---- 焦点 / 光标追踪 ----
  const setActive = useCallback((blockId: string | null) => {
    activeBlockIdRef.current = blockId;
  }, []);

  const onFocus = useCallback(
    (blockId: string, e: React.FocusEvent<HTMLTextAreaElement>) => {
      setActive(blockId);
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      saveCursorRel(blockId, start, end);
      broadcastCursor(blockId, start);
    },
    [setActive, saveCursorRel, broadcastCursor]
  );

  const onBlur = useCallback(
    (blockId: string) => {
      if (activeBlockIdRef.current === blockId) {
        cursorRelRef.current = null;
      }
      // 失焦时清空光标广播
      if (activeBlockIdRef.current === blockId) {
        updateMyCursor(null, null);
      }
    },
    [updateMyCursor]
  );

  // 记录每次按键后的光标位置并广播
  const onKeyUp = useCallback(
    (blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.target as HTMLTextAreaElement;
      saveCursorRel(blockId, ta.selectionStart, ta.selectionEnd);
      broadcastCursor(blockId, ta.selectionStart);
    },
    [saveCursorRel, broadcastCursor]
  );

  // 鼠标选中文本时也记录
  const onSelect = useCallback(
    (blockId: string, e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.target as HTMLTextAreaElement;
      if (document.activeElement === ta) {
        saveCursorRel(blockId, ta.selectionStart, ta.selectionEnd);
        broadcastCursor(blockId, ta.selectionStart);
      }
    },
    [saveCursorRel, broadcastCursor]
  );

  // ---- 光标位置恢复 ----
  // Yjs 更新后，用 Y.RelativePosition 把光标映射回正确的绝对位置
  // 对方在光标前插入字符 → 光标自动前移，不会被"劈"在中间
  useEffect(() => {
    if (composing) return; // composition 期间由本地控制，不恢复
    const saved = cursorRelRef.current;
    if (!saved) return;
    const ta = textareaRefs.current.get(saved.blockId);
    if (!ta || document.activeElement !== ta) return;

    const ytext = getYText(saved.blockId);
    if (!ytext || !ytext.doc) return;

    // 把相对位置解析成绝对索引（会自动考虑对方插入的字符）
    const startAbs = Y.createAbsolutePositionFromRelativePosition(saved.startRel, ytext.doc);
    const endAbs = Y.createAbsolutePositionFromRelativePosition(saved.endRel, ytext.doc);

    const start = startAbs?.index ?? 0;
    const end = endAbs?.index ?? start;
    const maxLen = ta.value.length;

    ta.setSelectionRange(Math.min(start, maxLen), Math.min(end, maxLen));
    // 恢复后重新广播光标位置
    broadcastCursor(saved.blockId, Math.min(start, maxLen));
  }, [blocks, composing, getYText, broadcastCursor]);

  // ---- 编辑处理（字符级，通过 diff 应用到 Y.Text） ----
  const onEdit = useCallback(
    (blockId: string, next: string) => {
      // 输入法 composition 期间，只更新本地草稿，不同步到 Yjs
      if (composing?.blockId === blockId) {
        setComposing({ blockId, text: next });
        return;
      }

      const ytext = getYText(blockId);
      if (!ytext) return;

      const lastApplied = lastAppliedRef.current.get(blockId) ?? '';
      // 如果和上次应用的值一样，跳过（防止 Y.Text → observe → onChange 循环）
      if (next === lastApplied) return;

      // 计算 diff 并应用到 Y.Text
      applyDiffToYText(ytext, lastApplied, next);

      // 更新"上次应用的值"
      lastAppliedRef.current.set(blockId, next);
    },
    [composing, getYText]
  );

  // 同步 lastAppliedRef 与最新 blocks
  // Y.Text 变化触发 observeDeep → setBlocks → 这里更新缓存
  useEffect(() => {
    for (const b of blocks) {
      lastAppliedRef.current.set(b.id, b.text);
    }
  }, [blocks]);

  // ---- 输入法 composition 事件 ----
  const onCompositionStart = useCallback((blockId: string) => {
    const block = blocks.find((b) => b.id === blockId);
    setComposing({
      blockId,
      text: block?.text ?? '',
    });
  }, [blocks]);

  const onCompositionEnd = useCallback(
    (blockId: string, finalText: string) => {
      const wasComposing = composing?.blockId === blockId;
      setComposing(null);
      if (wasComposing) {
        // 拼音上屏，计算整段差异应用到 Y.Text
        const ytext = getYText(blockId);
        if (ytext) {
          const lastApplied = lastAppliedRef.current.get(blockId) ?? '';
          applyDiffToYText(ytext, lastApplied, finalText);
          lastAppliedRef.current.set(blockId, finalText);
        }
      }
    },
    [composing, getYText]
  );

  // ---- 块操作 ----
  const onAddBlock = useCallback(() => {
    addBlock(undefined, 'paragraph');
  }, [addBlock]);

  const onRemoveBlock = useCallback(
    (blockId: string) => {
      removeBlock(blockId);
      lastAppliedRef.current.delete(blockId);
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
  const getTextareaValue = (block: Block) => {
    if (composing?.blockId === block.id) {
      return composing.text;
    }
    return block.text;
  };

  // 某块有哪些远程用户在编辑
  const getRemoteUsersInBlock = (blockId: string) => {
    return remoteCursors.filter((c) => c.blockId === blockId);
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
            const remoteUsers = getRemoteUsersInBlock(block.id);
            const hasRemoteUser = remoteUsers.length > 0;

            return (
              <div
                key={block.id}
                className={`block kind-${block.kind} ${hasRemoteUser ? 'has-remote' : ''}`}
                style={hasRemoteUser ? {
                  // 有远程用户时，左边框显示对方颜色
                  borderLeftColor: remoteUsers[0].color,
                } : undefined}
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

                {/* 远程用户标签（显示在块右上角） */}
                {hasRemoteUser && (
                  <div className="remote-user-tag" style={{ backgroundColor: remoteUsers[0].color }}>
                    {remoteUsers[0].name}
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
                    // 实时记录光标相对位置
                    saveCursorRel(block.id, e.target.selectionStart, e.target.selectionEnd);
                    if (block.text === next && composing?.blockId !== block.id) return;
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
        <div className="status-item">就绪 · 字符级 CRDT 实时协同</div>
        <div className="status-right">
          <div className="status-item">{blocks.length} 块</div>
          <div className="status-item">{wordCount} 字</div>
          <div className="status-item">自动保存 · 已同步</div>
        </div>
      </div>
    </>
  );
}
