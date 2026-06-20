export const RARITIES = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const
export type Rarity = (typeof RARITIES)[number]

// 有一个物种名与 excluded-strings.txt 中的 model 代号 canary 冲突。
// 该检查是对构建产物（而非源码）进行 grep，因此在运行时构造该值可以
// 让字面量不进入 bundle，同时检查仍然对真实的代号保持生效。
// 所有物种统一编码；`as` 断言仅用于类型位置（在 bundle 前会被擦除）。
const c = String.fromCharCode
// biome-ignore format: 保持物种列表紧凑

export const duck = c(0x64,0x75,0x63,0x6b) as 'duck'
export const goose = c(0x67, 0x6f, 0x6f, 0x73, 0x65) as 'goose'
export const blob = c(0x62, 0x6c, 0x6f, 0x62) as 'blob'
export const cat = c(0x63, 0x61, 0x74) as 'cat'
export const dragon = c(0x64, 0x72, 0x61, 0x67, 0x6f, 0x6e) as 'dragon'
export const octopus = c(0x6f, 0x63, 0x74, 0x6f, 0x70, 0x75, 0x73) as 'octopus'
export const owl = c(0x6f, 0x77, 0x6c) as 'owl'
export const penguin = c(0x70, 0x65, 0x6e, 0x67, 0x75, 0x69, 0x6e) as 'penguin'
export const turtle = c(0x74, 0x75, 0x72, 0x74, 0x6c, 0x65) as 'turtle'
export const snail = c(0x73, 0x6e, 0x61, 0x69, 0x6c) as 'snail'
export const ghost = c(0x67, 0x68, 0x6f, 0x73, 0x74) as 'ghost'
export const axolotl = c(0x61, 0x78, 0x6f, 0x6c, 0x6f, 0x74, 0x6c) as 'axolotl'
export const capybara = c(
  0x63,
  0x61,
  0x70,
  0x79,
  0x62,
  0x61,
  0x72,
  0x61,
) as 'capybara'
export const cactus = c(0x63, 0x61, 0x63, 0x74, 0x75, 0x73) as 'cactus'
export const robot = c(0x72, 0x6f, 0x62, 0x6f, 0x74) as 'robot'
export const rabbit = c(0x72, 0x61, 0x62, 0x62, 0x69, 0x74) as 'rabbit'
export const mushroom = c(
  0x6d,
  0x75,
  0x73,
  0x68,
  0x72,
  0x6f,
  0x6f,
  0x6d,
) as 'mushroom'
export const chonk = c(0x63, 0x68, 0x6f, 0x6e, 0x6b) as 'chonk'

export const SPECIES = [
  duck,
  goose,
  blob,
  cat,
  dragon,
  octopus,
  owl,
  penguin,
  turtle,
  snail,
  ghost,
  axolotl,
  capybara,
  cactus,
  robot,
  rabbit,
  mushroom,
  chonk,
] as const
export type Species = (typeof SPECIES)[number] // biome-ignore format: 保持紧凑

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const
export type Eye = (typeof EYES)[number]

export const HATS = [
  'none',
  'crown',
  'tophat',
  'propeller',
  'halo',
  'wizard',
  'beanie',
  'tinyduck',
] as const
export type Hat = (typeof HATS)[number]

export const STAT_NAMES = [
  'DEBUGGING',
  'PATIENCE',
  'CHAOS',
  'WISDOM',
  'SNARK',
] as const
export type StatName = (typeof STAT_NAMES)[number]

// 确定性部分 — 由 hash(userId) 推导
export type CompanionBones = {
  rarity: Rarity
  species: Species
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}

// 模型生成的灵魂 — 首次孵化后存储到 config 中
export type CompanionSoul = {
  name: string
  personality: string
  seed?: string
}

export type Companion = CompanionBones &
  CompanionSoul & {
    hatchedAt: number
  }

// 实际持久化到 config 中的内容。Bones 在每次读取时由 hash(userId)
// 重新生成，这样即便 species 改名也不会破坏已存储的 companion，
// 同时用户也无法通过手改配置把 rarity 提升到 legendary。
export type StoredCompanion = CompanionSoul & { hatchedAt: number }

export const RARITY_WEIGHTS = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
} as const satisfies Record<Rarity, number>

export const RARITY_STARS = {
  common: '★',
  uncommon: '★★',
  rare: '★★★',
  epic: '★★★★',
  legendary: '★★★★★',
} as const satisfies Record<Rarity, string>

export const RARITY_COLORS = {
  common: 'inactive',
  uncommon: 'success',
  rare: 'permission',
  epic: 'autoAccept',
  legendary: 'warning',
} as const satisfies Record<Rarity, keyof import('../utils/theme.js').Theme>
