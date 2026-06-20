import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatSession, ChatMessage } from '@/data/types'

interface CreateSessionOpts {
  contextFile?: string
  contextSymbol?: string
}

interface UseChatSessionReturn {
  sessions: ChatSession[]
  activeSession: ChatSession | null
  activeSessionId: string | null
  setActiveSessionId: (id: string | null) => void
  createNewSession: (opts?: CreateSessionOpts) => Promise<ChatSession>
  sendMessage: (content: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  streaming: boolean
  error: string | null
}

export function useChatSession(): UseChatSessionReturn {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Load session list on mount
  useEffect(() => {
    let cancelled = false
    fetch('/api/chat/sessions')
      .then(r => r.json())
      .then((data: { sessions: ChatSession[] }) => {
        if (!cancelled) setSessions(data.sessions ?? [])
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load sessions',
          )
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load full session when activeSessionId changes
  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null)
      return
    }
    let cancelled = false
    fetch(`/api/chat/sessions/${activeSessionId}`)
      .then(r => r.json())
      .then((data: ChatSession) => {
        if (!cancelled) setActiveSession(data)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'Failed to load session',
          )
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  const createNewSession = useCallback(
    async (opts?: CreateSessionOpts): Promise<ChatSession> => {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      })
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
      const session: ChatSession = await res.json()
      setSessions(prev => [session, ...prev])
      setActiveSessionId(session.id)
      setActiveSession(session)
      return session
    },
    [],
  )

  const sendMessage = useCallback(
    async (content: string): Promise<void> => {
      if (!activeSession) return
      if (streaming) {
        abortRef.current?.abort()
      }

      setError(null)

      // 1. Optimistic: append user message to local state
      const userMsg: ChatMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      }
      const updatedMessages = [...activeSession.messages, userMsg]
      setActiveSession(prev =>
        prev ? { ...prev, messages: updatedMessages } : prev,
      )

      // 2. Persist user message to disk
      try {
        await fetch(`/api/chat/sessions/${activeSession.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [userMsg] }),
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save message')
        return
      }

      // 3. Stream assistant response
      const controller = new AbortController()
      abortRef.current = controller
      setStreaming(true)

      let assistantText = ''

      // Add a placeholder assistant message for streaming
      setActiveSession(prev => {
        if (!prev) return prev
        const placeholder: ChatMessage = {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        }
        return { ...prev, messages: [...prev.messages, placeholder] }
      })

      try {
        const messagesForApi = updatedMessages.map(m => ({
          role: m.role,
          content: m.content,
        }))

        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messagesForApi,
            context: { currentFile: activeSession.contextFile },
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          throw new Error(`AI request failed: ${res.status}`)
        }

        if (!res.body) throw new Error('No response body')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('event: delta')) {
              continue
            }
            if (line.startsWith('event: error')) {
              continue
            }
            if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim()
              if (!raw) continue
              try {
                const parsed = JSON.parse(raw) as {
                  text?: string
                  error?: string
                  usage?: unknown
                }
                if (parsed.text !== undefined) {
                  assistantText += parsed.text
                  setActiveSession(prev => {
                    if (!prev) return prev
                    const msgs = [...prev.messages]
                    const last = msgs[msgs.length - 1]
                    if (last?.role === 'assistant') {
                      msgs[msgs.length - 1] = {
                        ...last,
                        content: assistantText,
                      }
                    }
                    return { ...prev, messages: msgs }
                  })
                } else if (parsed.error) {
                  setError(parsed.error)
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // cancelled intentionally
        } else {
          setError(err instanceof Error ? err.message : 'Streaming failed')
          setStreaming(false)
          return
        }
      }

      setStreaming(false)

      // 5. Persist assistant message to disk
      if (assistantText) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          timestamp: Date.now(),
        }
        try {
          const saved = await fetch(
            `/api/chat/sessions/${activeSession.id}/messages`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: [assistantMsg] }),
            },
          )
          if (saved.ok) {
            const updated: ChatSession = await saved.json()
            setSessions(prev =>
              prev.map(s =>
                s.id === updated.id
                  ? { ...updated, messages: updated.messages.slice(-3) }
                  : s,
              ),
            )
          }
        } catch {
          // ignore persistence error — message already in local state
        }
      }
    },
    [activeSession, streaming],
  )

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' })
      setSessions(prev => prev.filter(s => s.id !== id))
      if (activeSessionId === id) {
        setActiveSessionId(null)
        setActiveSession(null)
      }
    },
    [activeSessionId],
  )

  const renameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) return
      const updated: ChatSession = await res.json()
      setSessions(prev =>
        prev.map(s =>
          s.id === id
            ? { ...updated, messages: updated.messages.slice(-3) }
            : s,
        ),
      )
      if (activeSessionId === id) {
        setActiveSession(prev => (prev ? { ...prev, title } : prev))
      }
    },
    [activeSessionId],
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  return {
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
  }
}
