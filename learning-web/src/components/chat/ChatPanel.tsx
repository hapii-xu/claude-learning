import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';
import { useConsole } from '@/hooks/useConsole';
import { useChatSession } from '@/hooks/useChatSession';
import { ChatSessionList } from './ChatSessionList';
import { PlusCircle, Send, MessageSquare, ChevronDown, Loader2, Bot, User, X } from 'lucide-react';

export function ChatPanel() {
  const { chatContext } = useConsole();
  const {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createNewSession,
    sendMessage,
    deleteSession,
    renameSession,
    streaming,
    error,
  } = useChatSession();

  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevChatContextRef = useRef<typeof chatContext>(undefined);
  const creatingForContextRef = useRef(false);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages]);

  // Auto-resize textarea
  const adjustTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineH = 20;
    const maxH = lineH * 4 + 16;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, []);

  // When chatContext changes, create a new session with that context if needed
  useEffect(() => {
    if (!chatContext) return;
    const prev = prevChatContextRef.current;
    const sameContext = prev && prev.filePath === chatContext.filePath && prev.symbolName === chatContext.symbolName;
    if (sameContext) return;
    prevChatContextRef.current = chatContext;

    // If a sessionId is provided, just switch to it
    if (chatContext.sessionId) {
      setActiveSessionId(chatContext.sessionId);
      return;
    }

    // Check if there's already a session with the same context
    const existing = sessions.find(
      s => s.contextFile === chatContext.filePath && s.contextSymbol === (chatContext.symbolName ?? undefined),
    );
    if (existing) {
      setActiveSessionId(existing.id);
      return;
    }

    // Create a new session
    if (creatingForContextRef.current) return;
    creatingForContextRef.current = true;
    createNewSession({
      contextFile: chatContext.filePath,
      contextSymbol: chatContext.symbolName,
    })
      .catch(() => {})
      .finally(() => {
        creatingForContextRef.current = false;
      });
  }, [chatContext, sessions, createNewSession, setActiveSessionId]);

  const handleSend = useCallback(async () => {
    const content = inputValue.trim();
    if (!content || streaming) return;

    // If no active session, create one first
    if (!activeSession) {
      try {
        await createNewSession();
      } catch {
        return;
      }
    }

    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    await sendMessage(content);
  }, [inputValue, streaming, activeSession, createNewSession, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCreateNew = async () => {
    try {
      await createNewSession();
    } catch {
      // ignore
    }
  };

  const contextChip = activeSession?.contextFile ? (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand/10 text-brand text-[10px] font-mono max-w-[200px]">
      <span className="truncate">
        {activeSession.contextFile.split('/').pop()}
        {activeSession.contextSymbol ? `#${activeSession.contextSymbol}` : ''}
      </span>
      <button
        onClick={() => renameSession(activeSession.id, activeSession.title).catch(() => {})}
        className="hover:text-brand/60 shrink-0"
        title="移除上下文"
      >
        <X className="size-2.5" />
      </button>
    </div>
  ) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="h-9 flex items-center gap-2 px-3 border-b shrink-0">
        <div className="relative">
          <button
            onClick={() => setSessionListOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-foreground hover:text-brand transition-colors max-w-[180px]"
          >
            <MessageSquare className="size-3.5 text-brand shrink-0" />
            <span className="truncate font-medium">{activeSession?.title ?? '选择对话'}</span>
            <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
          </button>
          <ChatSessionList
            open={sessionListOpen}
            onClose={() => setSessionListOpen(false)}
            sessions={sessions}
            activeId={activeSessionId}
            onSelect={setActiveSessionId}
            onDelete={deleteSession}
            onCreate={handleCreateNew}
          />
        </div>

        <div className="flex-1" />

        {contextChip}

        <button
          onClick={handleCreateNew}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-brand transition-colors"
          title="新建对话"
        >
          <PlusCircle className="size-3.5" />
          新建对话
        </button>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {!activeSession || activeSession.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground">
            <Bot className="size-8 mb-3 text-brand/40" />
            <p className="text-sm font-medium">还没有对话</p>
            <p className="text-xs mt-1">点击新建对话开始，或者直接输入消息</p>
          </div>
        ) : (
          activeSession.messages.map((msg, idx) => {
            const isUser = msg.role === 'user';
            const isLastAssistant = !isUser && idx === activeSession.messages.length - 1 && streaming;
            return (
              <div key={idx} className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
                {!isUser && (
                  <div className="size-6 rounded-full bg-brand/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="size-3.5 text-brand" />
                  </div>
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-xl px-3 py-2 text-sm',
                    isUser ? 'bg-brand/10 text-foreground' : 'bg-surface-1 text-foreground',
                  )}
                >
                  {isUser ? (
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content || ''}</ReactMarkdown>
                      {isLastAssistant && msg.content === '' && <span className="animate-pulse text-brand">▌</span>}
                      {isLastAssistant && msg.content !== '' && (
                        <span className="animate-pulse text-brand ml-0.5">▌</span>
                      )}
                    </div>
                  )}
                </div>
                {isUser && (
                  <div className="size-6 rounded-full bg-accent flex items-center justify-center shrink-0 mt-0.5">
                    <User className="size-3.5 text-muted-foreground" />
                  </div>
                )}
              </div>
            );
          })
        )}
        {error && (
          <div className="text-xs text-status-error bg-status-error/10 rounded-lg px-3 py-2">错误：{error}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="border-t px-3 py-2 flex items-end gap-2 shrink-0">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={e => {
            setInputValue(e.target.value);
            adjustTextarea();
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行…"
          disabled={streaming}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand/40',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'min-h-[36px] max-h-[96px] overflow-y-auto leading-5',
          )}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || streaming}
          className={cn(
            'size-9 rounded-lg flex items-center justify-center transition-all shrink-0',
            inputValue.trim() && !streaming
              ? 'bg-brand text-white hover:bg-brand/90'
              : 'bg-accent text-muted-foreground cursor-not-allowed',
          )}
          title="发送"
        >
          {streaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
    </div>
  );
}
