/**
 * Anthropic 内部包的类型声明，这些包无法从公共 npm 安装。
 * 所有导出都标注为 `any` 以抑制报错，同时仍允许 IDE 跳转到实际源码。
 */

// ============================================================================
// bun:bundle —— 编译期宏
// ============================================================================
declare module 'bun:bundle' {
  export function feature(name: string): boolean
}

declare module 'bun:ffi' {
  export function dlopen<
    T extends Record<string, { args: readonly string[]; returns: string }>,
  >(
    path: string,
    symbols: T,
  ): {
    symbols: { [K in keyof T]: (...args: unknown[]) => unknown }
    close(): void
  }
}

// 无 @types 包的第三方模块
declare module 'bidi-js' {
  function getEmbeddingLevels(
    text: string,
    defaultDirection?: string,
  ): { paragraphLevel: number; levels: Uint8Array }
  function getReorderSegments(
    text: string,
    embeddingLevels: { paragraphLevel: number; levels: Uint8Array },
    start?: number,
    end?: number,
  ): [number, number][]
  function getVisualOrder(reorderSegments: [number, number][]): number[]
  export { getEmbeddingLevels, getReorderSegments, getVisualOrder }
  export default { getEmbeddingLevels, getReorderSegments, getVisualOrder }
}

declare module 'asciichart' {
  function plot(
    series: number[] | number[][],
    config?: Record<string, unknown>,
  ): string
  export { plot }
  export default { plot }
}

declare module '@napi-rs/keyring' {
  export class Entry {
    constructor(service: string, account: string)
    getPassword(): string | null
    setPassword(password: string): void
    deletePassword(): boolean
  }
}
