import { getGlobalConfig } from '../utils/config.js'
import {
  type Companion,
  type CompanionBones,
  type CompanionSoul,
  EYES,
  HATS,
  RARITIES,
  RARITY_WEIGHTS,
  type Rarity,
  SPECIES,
  STAT_NAMES,
  type StatName,
} from './types.js'

// Mulberry32 — 轻量带种子的伪随机数生成器，足够用来抽取 ducks
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  if (typeof Bun !== 'undefined') {
    return Number(BigInt(Bun.hash(s)) & 0xffffffffn)
  }
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function rollRarity(rng: () => number): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  let roll = rng() * total
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity
  }
  return 'common'
}

const RARITY_FLOOR: Record<Rarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50,
}

// 一项 peak（巅峰）属性、一项 dump（短板）属性，其余随机分散。稀有度会抬高下限。
function rollStats(
  rng: () => number,
  rarity: Rarity,
): Record<StatName, number> {
  const floor = RARITY_FLOOR[rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)

  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }
  return stats
}

const SALT = 'friend-2026-401'

export type Roll = {
  bones: CompanionBones
  inspirationSeed: number
}

function rollFrom(rng: () => number): Roll {
  const rarity = rollRarity(rng)
  const bones: CompanionBones = {
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  }
  return { bones, inspirationSeed: Math.floor(rng() * 1e9) }
}

// 从三处热路径（500ms sprite tick、每次按键的 PromptInput、
// 每轮 observer）以相同 userId 调用 → 缓存确定性结果。
let rollCache: { key: string; value: Roll } | undefined
export function roll(userId: string): Roll {
  const key = userId + SALT
  if (rollCache?.key === key) return rollCache.value
  const value = rollFrom(mulberry32(hashString(key)))
  rollCache = { key, value }
  return value
}

export function rollWithSeed(seed: string): Roll {
  return rollFrom(mulberry32(hashString(seed)))
}

export function generateSeed(): string {
  return `rehatch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function companionUserId(): string {
  const config = getGlobalConfig()
  return config.oauthAccount?.accountUuid ?? config.userID ?? 'anon'
}

const WORD_BOUNDARY = '[^a-z0-9]+'

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|${WORD_BOUNDARY})${word}($|${WORD_BOUNDARY})`).test(
    text,
  )
}

export function inferLegacyCompanionBones(
  stored: CompanionSoul,
): Partial<Pick<CompanionBones, 'species' | 'rarity'>> {
  if (stored.seed) return {}
  const text = `${stored.name} ${stored.personality}`.toLowerCase()
  const inferred: Partial<Pick<CompanionBones, 'species' | 'rarity'>> = {}
  const species = SPECIES.find(species => hasWord(text, species))
  const rarity = RARITIES.find(rarity => hasWord(text, rarity))
  if (species) inferred.species = species
  if (rarity) inferred.rarity = rarity
  return inferred
}

// 从 seed 或 userId 重新生成 bones，与已存储的 soul 合并。
export function getCompanion(): Companion | undefined {
  const stored = getGlobalConfig().companion
  if (!stored) return undefined
  const seed = stored.seed ?? companionUserId()
  const { bones } = rollWithSeed(seed)
  const legacyBones = inferLegacyCompanionBones(stored)
  // 带 seed 的 companion 使用重新生成的 bones。不带 seed 的旧版 companion
  // 可能在生成时已经把 species/rarity 写入 soul 文本中；当 userId 推导出的
  // roll 发生漂移时，仍保留这部分可见的身份信息以保持一致。
  return { ...stored, ...bones, ...legacyBones }
}
