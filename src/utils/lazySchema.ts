/**
 * 返回一个 memoized 工厂函数，在首次调用时构造值。
 * 用于将 Zod schema 的构造从模块初始化时延迟到首次访问时。
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => (cached ??= factory())
}
