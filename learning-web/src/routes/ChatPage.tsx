import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  MessageCircle,
  Plus,
  Send,
  Square,
  X,
  FileCode,
  Sparkles,
  AlertCircle,
  Loader2,
  Trash2,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownNote } from '@/components/notes/MarkdownNote';
import { chatWithClaude, type ChatUsage } from '@/lib/api';
import type { ChatMessage, ChatSession } from '@/data/types';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'claude-code-learning-chat-sessions';
const MAX_SESSIONS = 20; // 最多保留 N 个历史会话

function loadSessions(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
}

function createSession(title: string): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: title.slice(0, 40) || '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function ChatPage() {
  const [searchParams] = useSearchParams();

  // Sessions
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [currentId, setCurrentId] = useState<string | null>(null);

  // Input & streaming state
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Attached file context
  const [attachedFile, setAttachedFile] = useState<string | null>(null);

  // Read ?file= from URL
  useEffect(() => {
    const f = searchParams.get('file');
    if (f) setAttachedFile(f);
  }, [searchParams]);

  // Persist sessions whenever they change
  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  const currentSession = useMemo(() => sessions.find(s => s.id === currentId) || null, [sessions, currentId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [currentSession?.messages.length, streamingText]);

  // 确保当前有一个活跃 session；如果没有就自动创建
  useEffect(() => {
    if (!currentId && sessions.length === 0) {
      const s = createSession('新对话');
      setSessions([s]);
      setCurrentId(s.id);
    } else if (!currentId && sessions.length > 0) {
      setCurrentId(sessions[0].id);
    }
  }, [currentId, sessions]);

  const handleNewSession = () => {
    const s = createSession('新对话');
    setSessions(prev => [s, ...prev]);
    setCurrentId(s.id);
    setInput('');
    setStreamingText('');
    setError(null);
    setUsage(null);
    setAttachedFile(null);
  };

  const handleSelectSession = (id: string) => {
    if (streaming) return;
    setCurrentId(id);
    setInput('');
    setStreamingText('');
    setError(null);
    setUsage(null);
  };

  const handleDeleteSession = (id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (currentId === id) {
        if (next.length > 0) setCurrentId(next[0].id);
        else {
          const fresh = createSession('新对话');
          next.unshift(fresh);
          setCurrentId(fresh.id);
        }
      }
      return next;
    });
  };

  const updateCurrentSession = useCallback(
    (updater: (s: ChatSession) => ChatSession) => {
      setSessions(prev => prev.map(s => (s.id === currentId ? updater(s) : s)));
    },
    [currentId],
  );

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // 把已流式输出的内容固化成 assistant 消息
    if (streamingText) {
      updateCurrentSession(s => ({
        ...s,
        messages: [
          ...s.messages,
          { role: 'assistant', content: streamingText + '\n\n_(已停止)_', timestamp: Date.now() },
        ],
        updatedAt: Date.now(),
      }));
    }
    setStreaming(false);
    setStreamingText('');
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming || !currentId) return;

    // 1. 用户消息入列
    const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
    let sessionAfterAdd: ChatSession | null = null;
    updateCurrentSession(s => {
      const isFirst = s.messages.length === 0;
      sessionAfterAdd = {
        ...s,
        title: isFirst ? text.slice(0, 40) : s.title,
        messages: [...s.messages, userMsg],
        updatedAt: Date.now(),
      };
      return sessionAfterAdd;
    });

    setInput('');
    setError(null);
    setUsage(null);
    setStreaming(true);
    setStreamingText('');

    // 等 React 把 userMsg 写进去再读取
    // 用 requestAnimationFrame 确保 state 已 flush
    await new Promise(r => requestAnimationFrame(r));

    // 2. 构造 messages（包含刚加入的 userMsg）
    const sessionForApi = sessionAfterAdd || sessions.find(s => s.id === currentId);
    const history = sessionForApi?.messages || [userMsg];

    // 3. 流式调用
    let acc = '';
    const ctrl = chatWithClaude(
      history,
      { currentFile: attachedFile || undefined },
      delta => {
        acc += delta;
        setStreamingText(acc);
      },
      u => {
        setUsage(u);
        updateCurrentSession(s => ({
          ...s,
          messages: [...s.messages, { role: 'assistant', content: acc, timestamp: Date.now() }],
          updatedAt: Date.now(),
        }));
        setStreaming(false);
        setStreamingText('');
        abortRef.current = null;
      },
      err => {
        setError(err);
        if (acc) {
          updateCurrentSession(s => ({
            ...s,
            messages: [...s.messages, { role: 'assistant', content: acc, timestamp: Date.now() }],
            updatedAt: Date.now(),
          }));
        }
        setStreaming(false);
        setStreamingText('');
        abortRef.current = null;
      },
    );
    abortRef.current = ctrl;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  // Welcome screen when no messages yet
  const showWelcome = currentSession && currentSession.messages.length === 0 && !streaming;

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col animate-fade-up">
      {/* Header */}
      <div className="shrink-0 border-b bg-card px-4 py-2.5 flex items-center gap-2">
        <div className="size-8 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <MessageCircle className="size-4 text-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">{currentSession?.title || '学习对话'}</h1>
          <p className="text-[10px] text-muted-foreground">Claude 是你的 claude-code 学习助教</p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleNewSession} disabled={streaming}>
          <Plus className="size-3" />
          新对话
        </Button>
      </div>

      {/* Session chips */}
      {sessions.length > 1 && (
        <div className="shrink-0 border-b bg-surface-1/40 px-4 py-2 overflow-x-auto">
          <div className="flex items-center gap-1.5">
            {sessions.map(s => (
              <div
                key={s.id}
                className={cn(
                  'group flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors shrink-0',
                  s.id === currentId
                    ? 'border-brand/50 bg-brand/5 text-brand'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-brand/30',
                )}
              >
                <button onClick={() => handleSelectSession(s.id)} className="truncate max-w-32" title={s.title}>
                  {s.title}
                </button>
                <button
                  onClick={() => handleDeleteSession(s.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-status-error transition-all"
                  title="删除"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attached file banner */}
      {attachedFile && (
        <div className="shrink-0 border-b bg-brand/5 px-4 py-1.5 flex items-center gap-2 text-xs">
          <FileCode className="size-3.5 text-brand shrink-0" />
          <span className="text-muted-foreground">当前讨论文件：</span>
          <code className="font-mono text-brand truncate">{attachedFile}</code>
          <button
            onClick={() => setAttachedFile(null)}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
            title="取消附加"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4 max-w-3xl mx-auto">
          {showWelcome && <WelcomeScreen onPick={text => setInput(text)} />}

          {currentSession?.messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}

          {/* Streaming assistant message */}
          {streaming && streamingText && (
            <div className="flex gap-3">
              <div className="size-7 rounded-full bg-brand/10 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles className="size-3.5 text-brand" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="rounded-lg bg-surface-1/60 border px-3 py-2.5">
                  <MarkdownNote content={streamingText} compact />
                  <span className="inline-block w-1.5 h-3.5 bg-brand/70 ml-0.5 animate-pulse align-middle" />
                </div>
              </div>
            </div>
          )}

          {/* Streaming spinner (no text yet) */}
          {streaming && !streamingText && !error && (
            <div className="flex gap-3">
              <div className="size-7 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
                <Sparkles className="size-3.5 text-brand" />
              </div>
              <div className="rounded-lg bg-surface-1/60 border px-3 py-2.5 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                思考中...
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 flex items-start gap-2">
              <AlertCircle className="size-4 text-status-error shrink-0 mt-0.5" />
              <div className="flex-1 text-xs">
                <p className="text-status-error font-medium">调用失败</p>
                <p className="text-muted-foreground mt-1">{error}</p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input bar */}
      <div className="shrink-0 border-t bg-card px-4 py-3">
        <div className="max-w-3xl mx-auto">
          {usage && (
            <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="text-[9px] h-4 px-1">
                ↓{usage.input_tokens} ↑{usage.output_tokens}
              </Badge>
              {usage.cache_read > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 text-status-active">
                  cache {Math.round((usage.cache_read / (usage.cache_read + usage.cache_creation)) * 100)}%
                </Badge>
              )}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-lg border bg-surface-1/40 p-2 focus-within:border-brand/50 transition-colors">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="问任何关于 claude-code 代码库的问题… (Ctrl+Enter 发送)"
              rows={1}
              className="flex-1 min-h-[2.5rem] max-h-32 px-2 py-1.5 text-sm bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/50"
              disabled={streaming}
            />
            {streaming ? (
              <Button size="sm" variant="destructive" className="h-8 w-8 p-0" onClick={handleStop} title="停止生成">
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 w-8 p-0"
                onClick={handleSend}
                disabled={!input.trim()}
                title="发送 (Ctrl+Enter)"
              >
                <Send className="size-3.5" />
              </Button>
            )}
          </div>
          <div className="mt-1.5 text-[10px] text-muted-foreground flex items-center justify-between">
            <span>Ctrl+Enter 发送 · {currentSession?.messages.length || 0} 条消息</span>
            <button
              onClick={() => {
                if (attachedFile) setAttachedFile(null);
              }}
              className={cn('transition-opacity', attachedFile ? 'opacity-100' : 'opacity-0 pointer-events-none')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MessageBubble
   ───────────────────────────────────────────────────────────── */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'size-7 rounded-full flex items-center justify-center shrink-0 mt-0.5',
          isUser ? 'bg-foreground/10' : 'bg-brand/10',
        )}
      >
        {isUser ? <User className="size-3.5 text-foreground/70" /> : <Sparkles className="size-3.5 text-brand" />}
      </div>
      <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
        <div
          className={cn(
            'rounded-lg px-3 py-2.5 max-w-full',
            isUser ? 'bg-brand text-brand-foreground inline-block' : 'bg-surface-1/60 border',
          )}
        >
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <MarkdownNote content={message.content} compact />
          )}
        </div>
        <span className="text-[10px] text-muted-foreground mt-1 block px-1">
          {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   WelcomeScreen
   ───────────────────────────────────────────────────────────── */

function WelcomeScreen({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = [
    'claude-code 的核心入口是哪个文件？帮我梳理启动流程',
    'QueryEngine 在系统中扮演什么角色？',
    'feature flag 系统是怎么实现的？',
    '工具系统（Tool）的架构是什么？怎么加一个新工具？',
  ];
  return (
    <div className="py-8 text-center space-y-5">
      <div className="size-14 rounded-2xl bg-brand/10 flex items-center justify-center mx-auto">
        <MessageCircle className="size-7 text-brand" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">你好，我是学习助教 👋</h2>
        <p className="text-sm text-muted-foreground mt-1">
          可以问我任何关于 claude-code 代码库的问题，我会引用具体文件和行号回答
        </p>
      </div>
      <div className="grid gap-2 max-w-lg mx-auto text-left">
        {suggestions.map(s => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-xs text-left rounded-lg border px-3 py-2 text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-accent/50 transition-all"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
