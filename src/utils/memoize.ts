import { LRUCache } from 'lru-cache'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

type CacheEntry<T> = {
  value: T
  timestamp: number
  refreshing: boolean
}

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
  }
}

type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}

/**
 * 创建一个在后台并行刷新的同时返回缓存值的记忆化函数。
 * 实现透写缓存模式：
 * - 缓存新鲜：立即返回
 * - 缓存过期：返回旧值并在后台刷新
 * - 无缓存：阻塞并计算值
 *
 * @param f 要记忆化的函数
 * @param cacheLifetimeMs 缓存值的生存时间（毫秒）
 * @returns 函数的记忆化版本
 */
export function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000, // Default 5 minutes
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()

  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存
    if (!cached) {
      const value = f(...args)
      cache.set(key, {
        value,
        timestamp: now,
        refreshing: false,
      })
      return value
    }

    // 若有过期的缓存条目且未在刷新中
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新中，防止多个并行刷新
      cached.refreshing = true

      // 调度异步刷新（非阻塞）。.then 和 .catch 均有标识守卫：
      // 并发的 cache.clear() + 冷缺失会在此微任务排队期间存入更新条目。
      // .then 用过期刷新结果覆盖比 .catch 删除更糟
      //（前者在整个 TTL 期间持久保留错误数据，后者在下次调用时自我修复）。
      Promise.resolve()
        .then(() => {
          const newValue = f(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === cached) {
            cache.delete(key)
          }
        })

      // 立即返回旧值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 添加缓存清除方法
  memoized.cache = {
    clear: () => cache.clear(),
  }

  return memoized
}

/**
 * 创建一个在后台并行刷新的同时返回缓存值的异步记忆化函数。
 * 为异步函数实现透写缓存模式：
 * - 缓存新鲜：立即返回
 * - 缓存过期：返回旧值并在后台刷新
 * - 无缓存：阻塞并计算值
 *
 * @param f 要记忆化的异步函数
 * @param cacheLifetimeMs 缓存值的生存时间（毫秒）
 * @returns 异步函数的记忆化版本
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000, // Default 5 minutes
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  // 飞行中冷缺失去重。旧版同步 memoizeWithTTL 无意中提供了此功能：
  // 它在第一个 await 之前同步存储 Promise，所以并发调用方共享一个 f() 调用。
  // 此异步变体在 cache.set 之前 await，因此没有这个 map 的话，
  // 并发冷缺失调用方各自独立调用 f()。对于 refreshAndGetAwsCredentials，
  // 这意味着 N 个并发的 `aws sso login` spawn。
  // 与 auth.ts:1171 中的 pending401Handlers 模式相同。
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存——若抛出异常，则不会缓存任何内容
    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) return pending
      const promise = f(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        // 标识守卫：await 期间的 cache.clear() 应丢弃此结果
        //（clear 的意图是使缓存失效）。若仍在飞行中，则存入。
        // clear() 也会清空 inFlight，所以此检查能捕获该情况。
        if (inFlight.get(key) === promise) {
          cache.set(key, {
            value: result,
            timestamp: now,
            refreshing: false,
          })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
    }

    // 若有过期的缓存条目且未在刷新中
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新中，防止多个并行刷新
      cached.refreshing = true

      // 调度异步刷新（非阻塞）。.then 和 .catch 均对并发的
      // cache.clear() + 冷缺失（在刷新飞行期间存入更新条目）有标识守卫。
      // .then 用过期刷新结果覆盖比 .catch 删除更糟——
      // 错误数据在整个 TTL 期间持久保留
      //（例如，settings 变更后旧 awsAuthRefresh 命令的凭证）。
      const staleEntry = cached
      f(...args)
        .then(newValue => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === staleEntry) {
            cache.delete(key)
          }
        })

      // 立即返回旧值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 添加缓存清除方法。同时清除 inFlight：冷缺失 await 期间的 clear()
  // 不应让过期的飞行中 promise 返回给下一个调用方（违背 clear 的目的）。
  // 上方的 try/finally 对 inFlight.delete 有标识守卫，
  // 确保 clear+冷缺失在 finally 触发前发生时，过期 promise 不会删除新的。
  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }

  return memoized as ((...args: Args) => Promise<Result>) & {
    cache: { clear: () => void }
  }
}

/**
 * 创建使用 LRU（最近最少使用）淘汰策略的记忆化函数。
 * 当缓存达到最大容量时，淘汰最近最少使用的条目，防止内存无限增长。
 *
 * 注意：记忆化消息处理函数的缓存大小
 * 选择该值是为了在防止内存无限增长（使用 lodash memoize 时曾超过 300MB）
 * 的同时，在典型对话中保持良好的缓存命中率。
 *
 * @param f 要记忆化的函数
 * @returns 带有缓存管理方法的函数记忆化版本
 */
export function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({
    max: maxCacheSize,
  })

  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const result = f(...args)
    cache.set(key, result)
    return result
  }

  // 添加缓存管理方法
  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    // peek() 避免更新近期使用记录——我们只想观察，不促进
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  }

  return memoized
}
