// 用于提高 voice_stream 端点 STT 准确性的语音关键词。
//
// 提供领域特定的词汇提示（Deepgram "keywords"），以便 STT
// 引擎能正确识别编码术语、项目名称和分支
// 名称，否则这些会被听错。

import { basename } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'

// ─── 全局关键词 ────────────────────────────────────────────────

const GLOBAL_KEYTERMS: readonly string[] = [
  // Deepgram 在没有关键词提示时经常听错的术语。
  // 注意："Claude" 和 "Anthropic" 已经是服务端基础关键词。
  // 避免没有人会按拼写大声说出的术语（stdout → "standard out"）。
  'MCP',
  'symlink',
  'grep',
  'regex',
  'localhost',
  'codebase',
  'TypeScript',
  'JSON',
  'OAuth',
  'webhook',
  'gRPC',
  'dotfiles',
  'subagent',
  'worktree',
]

// ─── 辅助函数 ────────────────────────────────────────────────

/**
 * 将标识符（camelCase、PascalCase、kebab-case、snake_case 或
 * 路径段）拆分为单个单词。2 个字符或更少的片段
 * 会被丢弃以避免噪声。
 */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_./\s]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && w.length <= 20)
}

function fileNameWords(filePath: string): string[] {
  const stem = basename(filePath).replace(/\.[^.]+$/, '')
  return splitIdentifier(stem)
}

// ─── 公共 API ─────────────────────────────────────────────────────

const MAX_KEYTERMS = 50

/**
 * 为 voice_stream STT 端点构建关键词列表。
 *
 * 将硬编码的全局编码术语与会话上下文（项目名称、
 * git 分支、最近文件）结合，无需任何模型调用。
 */
export async function getVoiceKeyterms(
  recentFiles?: ReadonlySet<string>,
): Promise<string[]> {
  const terms = new Set<string>(GLOBAL_KEYTERMS)

  // 项目根 basename 作为单个术语 —— 用户说"claude CLI internal"
  // 是作为短语，而不是孤立的单词。保留整个 basename 让
  // STT 的关键词提升匹配短语，不管分隔符是什么。
  try {
    const projectRoot = getProjectRoot()
    if (projectRoot) {
      const name = basename(projectRoot)
      if (name.length > 2 && name.length <= 50) {
        terms.add(name)
      }
    }
  } catch {
    // getProjectRoot() 如果尚未初始化可能抛出 —— 忽略
  }

  // Git 分支词（例如 "feat/voice-keyterms" → "feat"、"voice"、"keyterms"）
  try {
    const branch = await getBranch()
    if (branch) {
      for (const word of splitIdentifier(branch)) {
        terms.add(word)
      }
    }
  } catch {
    // getBranch() 如果不在 git 仓库中可能失败 —— 忽略
  }

  // 最近文件名 —— 仅扫描足够填满剩余槽位的数量
  if (recentFiles) {
    for (const filePath of recentFiles) {
      if (terms.size >= MAX_KEYTERMS) break
      for (const word of fileNameWords(filePath)) {
        terms.add(word)
      }
    }
  }

  return [...terms].slice(0, MAX_KEYTERMS)
}
