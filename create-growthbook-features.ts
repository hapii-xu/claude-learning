#!/usr/bin/env bun
/**
 * 批量创建 GrowthBook 特性
 * 用法：bun run create-growthbook-features.ts
 */

// GrowthBook Personal Access Token
const GB_TOKEN = 'secret_user_BTgGLZMew1bkKc8PJE2NCSkMbhXu6PPj2wSRFdbs'
const GB_API_URL = 'https://api.growthbook.io/api/v1'

// 需要创建的特性列表（从 growthbook.ts 的 LOCAL_GATE_DEFAULTS 提取）
const FEATURES_TO_CREATE = [
  // P0: 纯本地特性
  {
    id: 'tengu_amber_json_tools',
    type: 'boolean',
    defaultValue: true,
    description: '节省 token 的 JSON 工具（约 4.5% 节省）',
  },
  {
    id: 'tengu_immediate_model_command',
    type: 'boolean',
    defaultValue: true,
    description: '查询期间即时 /model、/fast、/effort 命令',
  },
  {
    id: 'tengu_basalt_3kr',
    type: 'boolean',
    defaultValue: true,
    description: 'MCP 指令增量（仅发送更改）',
  },
  {
    id: 'tengu_pebble_leaf_prune',
    type: 'boolean',
    defaultValue: true,
    description: '会话存储叶子修剪',
  },
  {
    id: 'tengu_chair_sermon',
    type: 'boolean',
    defaultValue: true,
    description: '消息合并（合并相邻块）',
  },
  {
    id: 'tengu_lodestone_enabled',
    type: 'boolean',
    defaultValue: true,
    description: '深度链接协议（claude://）',
  },
  {
    id: 'tengu_fgts',
    type: 'boolean',
    defaultValue: true,
    description: '系统提示中的细粒度工具状态',
  },

  // P1: API 依赖特性
  {
    id: 'tengu_passport_quail',
    type: 'boolean',
    defaultValue: true,
    description: '自动记忆提取',
  },
  {
    id: 'tengu_moth_copse',
    type: 'boolean',
    defaultValue: true,
    description: '跳过记忆索引，使用预取的记忆',
  },
  {
    id: 'tengu_coral_fern',
    type: 'boolean',
    defaultValue: true,
    description: '"搜索过去上下文" 部分',
  },
  {
    id: 'tengu_chomp_inflection',
    type: 'boolean',
    defaultValue: true,
    description: '提示建议',
  },
  {
    id: 'tengu_hive_evidence',
    type: 'boolean',
    defaultValue: true,
    description: '验证代理',
  },
  {
    id: 'tengu_kairos_brief',
    type: 'boolean',
    defaultValue: true,
    description: '简短模式',
  },
  {
    id: 'tengu_kairos_brief_config',
    type: 'json',
    defaultValue: { enable_slash_command: true },
    description: '简短 /slash 命令可见性',
  },
  {
    id: 'tengu_sedge_lantern',
    type: 'boolean',
    defaultValue: true,
    description: '离开摘要',
  },
  {
    id: 'tengu_onyx_plover',
    type: 'json',
    defaultValue: { enabled: true },
    description: '自动梦境（记忆巩固）',
  },
  {
    id: 'tengu_willow_mode',
    type: 'string',
    defaultValue: 'dialog',
    description: '空闲返回提示',
  },

  // Kill switches: 终止开关
  {
    id: 'tengu_turtle_carbon',
    type: 'boolean',
    defaultValue: true,
    description: '超级思考扩展思考',
  },
  {
    id: 'tengu_amber_stoat',
    type: 'boolean',
    defaultValue: true,
    description: '内置探索/计划代理',
  },
  {
    id: 'tengu_amber_flint',
    type: 'boolean',
    defaultValue: true,
    description: '代理团队/群体',
  },
  {
    id: 'tengu_slim_subagent_claudemd',
    type: 'boolean',
    defaultValue: true,
    description: '子代理的精简 CLAUDE.md',
  },
  {
    id: 'tengu_birch_trellis',
    type: 'boolean',
    defaultValue: true,
    description: 'Tree-sitter bash 安全分析',
  },
  {
    id: 'tengu_collage_kaleidoscope',
    type: 'boolean',
    defaultValue: true,
    description: 'macOS 剪贴板图像读取',
  },
  {
    id: 'tengu_compact_cache_prefix',
    type: 'boolean',
    defaultValue: true,
    description: '压缩期间重用提示缓存',
  },
  {
    id: 'tengu_kairos_assistant',
    type: 'boolean',
    defaultValue: true,
    description: 'KAIROS 助手模式激活',
  },
  {
    id: 'tengu_kairos_cron_durable',
    type: 'boolean',
    defaultValue: true,
    description: '持久化 cron 任务',
  },
  {
    id: 'tengu_attribution_header',
    type: 'boolean',
    defaultValue: true,
    description: 'API 请求归属头',
  },
  {
    id: 'tengu_slate_prism',
    type: 'boolean',
    defaultValue: true,
    description: '代理进度摘要',
  },

  // Ultrareview
  {
    id: 'tengu_review_bughunter_config',
    type: 'json',
    defaultValue: { enabled: true },
    description: '/ultrareview 命令可见性',
  },
  {
    id: 'tengu_ccr_bundle_seed_enabled',
    type: 'boolean',
    defaultValue: true,
    description: '包种子：跳过分支模式的 GitHub App 检查',
  },
]

// 已经存在的特性（用户已手动创建）
const EXISTING_FEATURES = [
  'tengu_auto_background_agents',
  'tengu_kairos_cron',
  'tengu_keybinding_customization_release',
  'tengu_session_memory',
  'tengu_streaming_tool_execution2',
]

async function createFeature(feature: {
  id: string
  type: string
  defaultValue: any
  description: string
}) {
  const url = `${GB_API_URL}/features`

  // 根据类型格式化 defaultValue
  let formattedDefaultValue: string
  if (feature.type === 'json') {
    formattedDefaultValue = JSON.stringify(feature.defaultValue)
  } else if (feature.type === 'boolean') {
    formattedDefaultValue = String(feature.defaultValue)
  } else {
    formattedDefaultValue = String(feature.defaultValue)
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: feature.id,
      description: feature.description,
      valueType: feature.type,
      defaultValue: formattedDefaultValue,
      project: 'prj_2CcAQypXivwJKnftZJxoXN',
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`创建特性 ${feature.id} 失败: ${response.status} ${error}`)
  }

  return await response.json()
}

async function main() {
  console.log('🚀 开始批量创建 GrowthBook 特性\n')
  console.log('='.repeat(60))

  // 过滤掉已存在的特性
  const featuresToCreate = FEATURES_TO_CREATE.filter(
    f => !EXISTING_FEATURES.includes(f.id),
  )

  console.log(`\n📋 需要创建的特性: ${featuresToCreate.length} 个`)
  console.log(`⏭️  已存在的特性: ${EXISTING_FEATURES.length} 个 (跳过)\n`)

  let successCount = 0
  let failCount = 0

  for (const feature of featuresToCreate) {
    try {
      process.stdout.write(`创建 ${feature.id}... `)
      await createFeature(feature)
      console.log('✅')
      successCount++

      // 避免速率限制
      await new Promise(resolve => setTimeout(resolve, 200))
    } catch (error) {
      console.log('❌')
      console.error(
        `  错误: ${error instanceof Error ? error.message : String(error)}`,
      )
      failCount++
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('\n📊 创建结果:')
  console.log(`  ✅ 成功: ${successCount}`)
  console.log(`  ❌ 失败: ${failCount}`)
  console.log(`  ⏭️  跳过: ${EXISTING_FEATURES.length}`)

  if (successCount > 0) {
    console.log('\n💡 提示:')
    console.log('  - 在 GrowthBook 仪表板中查看新创建的特性')
    console.log('  - 确保为每个环境（production/dev）配置正确的值')
    console.log('  - 运行 bun run test-growthbook-verbose.ts 验证连接')
  }

  if (failCount > 0) {
    console.log('\n⚠️  注意:')
    console.log('  - 某些特性可能已存在或名称冲突')
    console.log('  - 检查 GrowthBook 仪表板确认特性状态')
  }
}

main().catch(error => {
  console.error('❌ 脚本执行失败:', error)
  process.exit(1)
})
