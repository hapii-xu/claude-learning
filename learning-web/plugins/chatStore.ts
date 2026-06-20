import fs from 'node:fs'
import path from 'node:path'

/**
 * 学习助教 Chat 会话持久化
 * 存储路径: .cache/learning-web/chat-sessions.json
 */

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  contextFile?: string
  contextSymbol?: string
  createdAt: number
  updatedAt: number
}

type ChatStore = Record<string, ChatSession>

const CACHE_DIR = '.cache/learning-web'
const CHAT_FILE = 'chat-sessions.json'
const MAX_MESSAGES_PER_SESSION = 50

function getChatPath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIR, CHAT_FILE)
}

function ensureDir(projectRoot: string): void {
  const dir = path.join(projectRoot, CACHE_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readChatStore(projectRoot: string): ChatStore {
  try {
    return JSON.parse(
      fs.readFileSync(getChatPath(projectRoot), 'utf-8'),
    ) as ChatStore
  } catch {
    return {}
  }
}

function writeChatStore(projectRoot: string, store: ChatStore): void {
  ensureDir(projectRoot)
  fs.writeFileSync(
    getChatPath(projectRoot),
    JSON.stringify(store, null, 2),
    'utf-8',
  )
}

export function listSessions(projectRoot: string): ChatSession[] {
  const store = readChatStore(projectRoot)
  return Object.values(store)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(s => ({ ...s, messages: s.messages.slice(-3) })) // only last 3 messages in list view
}

export function getSession(
  projectRoot: string,
  id: string,
): ChatSession | null {
  return readChatStore(projectRoot)[id] ?? null
}

export function createSession(
  projectRoot: string,
  opts: { contextFile?: string; contextSymbol?: string },
): ChatSession {
  const id = crypto.randomUUID()
  const now = Date.now()
  const title = opts.contextFile
    ? `${opts.contextFile.split('/').pop() ?? opts.contextFile}${opts.contextSymbol ? ` · ${opts.contextSymbol}` : ''}`
    : `会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  const session: ChatSession = {
    id,
    title,
    messages: [],
    contextFile: opts.contextFile,
    contextSymbol: opts.contextSymbol,
    createdAt: now,
    updatedAt: now,
  }
  const store = readChatStore(projectRoot)
  store[id] = session
  writeChatStore(projectRoot, store)
  return session
}

export function appendMessages(
  projectRoot: string,
  id: string,
  messages: ChatMessage[],
): ChatSession | null {
  const store = readChatStore(projectRoot)
  const session = store[id]
  if (!session) return null

  session.messages = [...session.messages, ...messages]
  // Trim to keep only last MAX_MESSAGES_PER_SESSION
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION)
  }
  session.updatedAt = Date.now()

  // Auto-title: use first user message if title is still generic
  if (session.messages.length === 1 && session.messages[0].role === 'user') {
    const firstMsg = session.messages[0].content.trim().slice(0, 40)
    if (!session.contextFile) {
      session.title =
        firstMsg + (session.messages[0].content.length > 40 ? '…' : '')
    }
  }

  store[id] = session
  writeChatStore(projectRoot, store)
  return session
}

export function renameSession(
  projectRoot: string,
  id: string,
  title: string,
): ChatSession | null {
  const store = readChatStore(projectRoot)
  const session = store[id]
  if (!session) return null
  session.title = title
  session.updatedAt = Date.now()
  store[id] = session
  writeChatStore(projectRoot, store)
  return session
}

export function deleteSession(projectRoot: string, id: string): boolean {
  const store = readChatStore(projectRoot)
  if (!(id in store)) return false
  delete store[id]
  writeChatStore(projectRoot, store)
  return true
}
