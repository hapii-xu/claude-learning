export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

export interface SearchOptions {
  allowedDomains?: string[]
  blockedDomains?: string[]
  signal?: AbortSignal
  onProgress?: (progress: SearchProgress) => void
  /** 要返回的搜索结果数量（默认：8） */
  numResults?: number
  /** 实时抓取模式（默认：'fallback'） */
  livecrawl?: 'fallback' | 'preferred'
  /** 搜索类型（默认：'auto'） */
  searchType?: 'auto' | 'fast' | 'deep'
  /** 上下文字符串的最大字符数（默认：10000） */
  contextMaxCharacters?: number
}

export interface SearchProgress {
  type: 'query_update' | 'search_results_received'
  query?: string
  resultCount?: number
}

export interface WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}
