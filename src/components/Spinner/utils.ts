import type { RGBColor as RGBColorString } from '@anthropic/ink'
import type { RGBColor as RGBColorType } from './types.js'

export function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✱', '✶', '✻', '*'] // ✱ 替代 ✳（emoji，在 Ghostty 中渲染偏移）；* 替代 ✽（相同）
  }
  // ✳ (U+2733) 会被 Node.js 中的 emoji-regex 匹配 → stringWidth 返回 2 而非 1，
  // 导致 spinner 循环帧时出现布局抖动。✱ (U+2731) 视觉上相似但不是 emoji。
  return process.platform === 'darwin'
    ? ['·', '✢', '✱', '✶', '✻', '✽']
    : ['·', '✢', '✱', '✶', '✻', '✽']
}

// 在两个 RGB 颜色之间插值
export function interpolateColor(
  color1: RGBColorType,
  color2: RGBColorType,
  t: number, // 0 到 1
): RGBColorType {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

// 把 RGB 对象转换为 Text 组件使用的 rgb() 颜色字符串
export function toRGBColor(color: RGBColorType): RGBColorString {
  return `rgb(${color.r},${color.g},${color.b})`
}

// HSL 色相（0-360）转 RGB，使用 voice-mode 波形参数（s=0.7，l=0.6）。
export function hueToRgb(hue: number): RGBColorType {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColorType | null>()

export function parseRGB(colorStr: string): RGBColorType | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  const result = match
    ? {
        r: parseInt(match[1]!, 10),
        g: parseInt(match[2]!, 10),
        b: parseInt(match[3]!, 10),
      }
    : null
  RGB_CACHE.set(colorStr, result)
  return result
}
