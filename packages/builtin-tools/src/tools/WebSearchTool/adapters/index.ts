/**
 * 搜索适配器工厂 — 选择合适的后端。
 *
 * 优先级（从高到低）：
 *   1. WEB_SEARCH_ADAPTER 环境变量（显式覆盖）
 *   2. settings.webSearchAdapter（可通过 /web-tools 面板由用户配置）
 *   3. 默认：tavily
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { TavilySearchAdapter } from './tavilyAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

export type SearchAdapterKey = 'api' | 'bing' | 'brave' | 'exa' | 'tavily'

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: SearchAdapterKey | null = null

export function createAdapter(): WebSearchAdapter {
  // 1. 显式环境变量覆盖
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  // 2. 设置项（通过 /web-tools 面板设置）
  const settingsAdapter = getSettings_DEPRECATED().webSearchAdapter

  const adapterKey: SearchAdapterKey =
    envAdapter === 'api' ||
    envAdapter === 'bing' ||
    envAdapter === 'brave' ||
    envAdapter === 'exa' ||
    envAdapter === 'tavily'
      ? envAdapter
      : settingsAdapter === 'api' ||
          settingsAdapter === 'bing' ||
          settingsAdapter === 'brave' ||
          settingsAdapter === 'exa' ||
          settingsAdapter === 'tavily'
        ? settingsAdapter
        : 'tavily' // 3. 默认

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  switch (adapterKey) {
    case 'api':
      cachedAdapter = new ApiSearchAdapter()
      break
    case 'bing':
      cachedAdapter = new BingSearchAdapter()
      break
    case 'brave':
      cachedAdapter = new BraveSearchAdapter()
      break
    case 'exa':
      cachedAdapter = new ExaSearchAdapter()
      break
    case 'tavily':
    default:
      cachedAdapter = new TavilySearchAdapter()
      break
  }

  cachedAdapterKey = adapterKey
  return cachedAdapter
}
