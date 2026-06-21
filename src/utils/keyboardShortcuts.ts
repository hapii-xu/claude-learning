// macOS Option+键产生的特殊字符，映射到对应的
// 键绑定等价物。用于在未启用"Option 作为 Meta"的 macOS
// 终端上检测 Option+键 快捷方式。
export const MACOS_OPTION_SPECIAL_CHARS = {
  '†': 'alt+t', // Option+T -> 思考切换
  π: 'alt+p', // Option+P -> 模型选择器
  ø: 'alt+o', // Option+O -> 快速模式
} as const satisfies Record<string, string>

export function isMacosOptionChar(
  char: string,
): char is keyof typeof MACOS_OPTION_SPECIAL_CHARS {
  return char in MACOS_OPTION_SPECIAL_CHARS
}
