import type { Buffer } from 'buffer'
import { isInBundledMode } from 'src/utils/bundledMode.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // 先尝试加载原生图像处理器
    try {
      // 使用原生图像处理器模块
      const imageProcessor = await import('image-processor-napi')
      const sharpFn = (imageProcessor.sharp ??
        imageProcessor.default) as SharpFunction
      imageProcessorModule = { default: sharpFn }
      return sharpFn
    } catch {
      // 原生模块不可用时回退到 sharp
      console.warn(
        '原生图像处理器不可用，回退到 sharp',
      )
    }
  }

  // 对于非 bundled 构建或作为兜底，使用 sharp。
  // 单一结构性转型：我们的 SharpFunction 是 sharp 实际类型表面的一个子集。
  const imported = (await import(
    'sharp'
  )) as unknown as MaybeDefault<SharpFunction>
  const sharp = unwrapDefault(imported)
  imageProcessorModule = { default: sharp }
  return sharp
}

/**
 * 获取用于从零生成新图片的 image creator。
 * 注意：image-processor-napi 不支持图片创建，
 * 因此这里始终直接使用 sharp。
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const imported = (await import(
    'sharp'
  )) as unknown as MaybeDefault<SharpCreator>
  const sharp = unwrapDefault(imported)
  imageCreatorModule = { default: sharp }
  return sharp
}

// 动态 import 的形态随模块 interop 模式而变 —— ESM 返回 { default: fn }，CJS 直接返回 fn。
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
