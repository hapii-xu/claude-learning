#!/usr/bin/env bun
/**
 * 重新生成 knowledge graph。
 *
 * 1. 调用 graphify 扫描项目根目录（默认 ..）
 * 2. 将 graph.json 复制到 learning-web/.cache/graphify/graph.json
 *
 * 用法：
 *   bun run scripts/regen-graph.ts              # 扫描父目录（claude-code 根）
 *   bun run scripts/regen-graph.ts /abs/path    # 扫描任意目录
 *   SKIP_SCAN=1 bun run scripts/regen-graph.ts  # 仅从 graphify-out 复制（不重新扫描）
 *
 * 前置条件：
 *   pip install graphifyy
 *   确保 `graphify` 在 PATH 中，或设置 GRAPHIFY_BIN 环境变量指向可执行文件
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LEARNING_WEB_ROOT = path.resolve(import.meta.dirname, '..')
const PROJECT_ROOT = path.resolve(LEARNING_WEB_ROOT, process.argv[2] || '..')
const GRAPHIFY_OUT = path.join(PROJECT_ROOT, 'graphify-out')
const CACHE_DIR = path.join(LEARNING_WEB_ROOT, '.cache', 'graphify')
const TARGET = path.join(CACHE_DIR, 'graph.json')

function findGraphify(): string {
  if (process.env.GRAPHIFY_BIN && fs.existsSync(process.env.GRAPHIFY_BIN)) {
    return process.env.GRAPHIFY_BIN
  }
  // 默认 pip 安装路径 (Windows Python 3.14)
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA || '',
      'Python',
      'pythoncore-3.14-64',
      'Scripts',
      'graphify.exe',
    ),
    path.join(
      process.env.LOCALAPPDATA || '',
      'Python',
      'pythoncore-3.13-64',
      'Scripts',
      'graphify.exe',
    ),
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'Python',
      'Python313',
      'Scripts',
      'graphify.exe',
    ),
    '/usr/local/bin/graphify',
    '/usr/bin/graphify',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // try PATH
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['graphify'], { encoding: 'utf-8' }).trim()
    if (out) return out.split('\n')[0]
  } catch {}
  throw new Error(
    'graphify not found. Run: pip install graphifyy && set GRAPHIFY_BIN=<path> or add to PATH',
  )
}

async function runScan(graphifyBin: string): Promise<void> {
  console.log(`[regen-graph] Scanning ${PROJECT_ROOT} ...`)
  const result = spawnSync(
    graphifyBin,
    ['update', PROJECT_ROOT, '--no-cluster', '--force'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000, // 10 min max
    },
  )
  if (result.status !== 0) {
    throw new Error(`graphify exited with code ${result.status}`)
  }
}

function copyGraph(): void {
  const src = path.join(GRAPHIFY_OUT, 'graph.json')
  if (!fs.existsSync(src)) {
    throw new Error(`graph.json not found at ${src}. Run graphify first.`)
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`[regen-graph] Copying ${src} → ${TARGET}`)
  fs.copyFileSync(src, TARGET)
  const sizeMB = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(2)
  console.log(`[regen-graph] Done. graph.json: ${sizeMB} MB`)
}

async function main(): Promise<void> {
  const skipScan = process.env.SKIP_SCAN === '1'
  if (!skipScan) {
    const graphifyBin = findGraphify()
    console.log(`[regen-graph] Using graphify at: ${graphifyBin}`)
    await runScan(graphifyBin)
  } else {
    console.log('[regen-graph] SKIP_SCAN=1 — skipping graphify scan')
  }
  copyGraph()
}

main().catch(err => {
  console.error(
    '[regen-graph] ERROR:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
