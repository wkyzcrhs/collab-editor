import { useState, useRef, useEffect, useCallback } from 'react';
import type { Block, BlockKind } from '../../shared/protocol';

interface AIPanelProps {
  blocks: Block[];
  wsHost: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const QUICK_PROMPTS = [
  { label: '📝 总结文档', question: '请用 3 句话总结这篇文档的核心内容。' },
  { label: '✅ 检查待办', question: '文档里有没有待办事项、TODO、或者需要跟进的事情？列出来。' },
  { label: '💡 改进建议', question: '这篇文档有哪些可以改进的地方？给出 3 条具体建议。' },
  { label: '🔍 提炼大纲', question: '请根据文档内容，提炼一个结构化的大纲（一级/二级标题）。' },
];

const KIND_PREFIX: Record<BlockKind, string> = {
  heading1: '# ',
  heading2: '## ',
  bullet: '- ',
  quote: '> ',
  paragraph: '',
};

export function AIPanel({ blocks, wsHost }: AIPanelProps) {
  // 窄屏（手机/平板）默认收起，宽屏默认展开
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia('(max-width: 1024px)').matches;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 把所有块拼成纯文本作为文档内容
  const getDocumentContent = useCallback(() => {
    return blocks.map((b) => {
      const prefix = KIND_PREFIX[b.kind] ?? '';
      return prefix + b.text;
    }).join('\n\n');
  }, [blocks]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // 发送消息
  const sendMessage = useCallback(async (question: string) => {
    if (!question.trim() || loading) return;

    const documentContent = getDocumentContent();
    const userMsg: ChatMessage = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
    setMessages((prev) => [...prev, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`http://${wsHost}:8787/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, documentContent }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: '请求失败' }));
        throw new Error(err.error || '请求失败');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应');

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
          if (payload === '[DONE]') return;
          try {
            const json = JSON.parse(payload);
            if (json.content) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                  next[next.length - 1] = { ...last, content: last.content + json.content };
                }
                return next;
              });
            }
          } catch {
            // 忽略
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          next[next.length - 1] = { role: 'assistant', content: `❌ ${err.message || '出错了'}` };
        }
        return next;
      });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [loading, getDocumentContent, wsHost]);

  const stopGenerate = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const clearChat = () => {
    setMessages([]);
    setInput('');
  };

  if (!open) {
    return (
      <button className="ai-toggle ai-toggle-collapsed" onClick={() => setOpen(true)} title="打开 AI 助手">
        ✨<br />AI
      </button>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <div className="ai-title">
          <span className="ai-icon">✨</span>
          AI 助手
        </div>
        <div className="ai-header-actions">
          <button className="ai-icon-btn" onClick={clearChat} title="清空对话">
            🗑
          </button>
          <button className="ai-icon-btn" onClick={() => setOpen(false)} title="收起面板">
            ›
          </button>
        </div>
      </div>

      <div className="ai-hint">基于当前文档内容回答问题</div>

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon">🤖</div>
            <div className="ai-empty-text">
              选择一个快捷指令，<br />
              或者直接输入你的问题
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ai-msg-${msg.role}`}>
            <div className="ai-msg-avatar">
              {msg.role === 'user' ? '🧑' : '🤖'}
            </div>
            <div className="ai-msg-content">{msg.content || (loading && msg.role === 'assistant' ? '▌' : '')}</div>
          </div>
        ))}
      </div>

      <div className="ai-quick">
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p.label}
            className="ai-quick-btn"
            onClick={() => sendMessage(p.question)}
            disabled={loading}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="ai-input-wrap">
        <textarea
          className="ai-input"
          placeholder="输入你的问题..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage(input);
            }
          }}
          rows={2}
          disabled={loading}
        />
        {loading ? (
          <button className="ai-send ai-stop" onClick={stopGenerate}>
            停止
          </button>
        ) : (
          <button
            className="ai-send"
            onClick={() => sendMessage(input)}
            disabled={!input.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
