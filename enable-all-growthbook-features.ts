#!/usr/bin/env bun
/**
 * 批量启用所有 GrowthBook 特性（在所有环境中设置为 true）
 * 用法：bun run enable-all-growthbook-features.ts
 */

const GB_TOKEN = 'secret_user_BTgGLZMew1bkKc8PJE2NCSkMbhXu6PPj2wSRFdbs'
const GB_API_URL = 'https://api.growthbook.io/api/v1'
const PROJECT_ID = 'prj_2CcAQypXivwJKnftZJxoXN'

// 所有特性列表
const ALL_FEATURES = [
  // 已手动创建的 5 个
  'tengu_auto_background_agents',
  'tengu_kairos_cron',
  'tengu_keybinding_customization_release',
  'tengu_session_memory',
  'tengu_streaming_tool_execution2',
  // API 创建的 30 个
  'tengu_amber_json_tools',
  'tengu_immediate_model_command',
  'tengu_basalt_3kr',
  'tengu_pebble_leaf_prune',
  'tengu_chair_sermon',
  'tengu_lodestone_enabled',
  'tengu_fgts',
  'tengu_passport_quail',
  'tengu_moth_copse',
  'tengu_coral_fern',
  'tengu_chomp_inflection',
  'tengu_hive_evidence',
  'tengu_kairos_brief',
  'tengu_kairos_brief_config',
  'tengu_sedge_lantern',
  'tengu_onyx_plover',
  'tengu_willow_mode',
  'tengu_turtle_carbon',
  'tengu_amber_stoat',
  'tengu_amber_flint',
  'tengu_slim_subagent_claudemd',
  'tengu_birch_trellis',
  'tengu_collage_kaleidoscope',
  'tengu_compact_cache_prefix',
  'tengu_kairos_assistant',
  'tengu_kairos_cron_durable',
  'tengu_attribution_header',
  'tengu_slate_prism',
  'tengu_review_bughunter_config',
  'tengu_ccr_bundle_seed_enabled',
]

async function enableFeature(featureId: string) {
  const url = `${GB_API_URL}/features/${featureId}/toggle`

  // 构建更新请求：在所有环境中启用
  const updateBody = {
    environments: {
      production: true,
      dev: true,
    },
  }

  const updateResponse = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateBody),
  })

  if (!updateResponse.ok) {
    const error = await updateResponse.text()
    throw new Error(
      `更新特性 ${featureId} 失败: ${updateResponse.status} ${error}`,
    )
  }

  return await updateResponse.json()
}

async function main() {
  console.log('🚀 批量启用所有 GrowthBook 特性\n')
  console.log('='.repeat(60))
  console.log(`\n📋 共 ${ALL_FEATURES.length} 个特性需要启用\n`)

  let successCount = 0
  let failCount = 0

  for (const featureId of ALL_FEATURES) {
    try {
      process.stdout.write(`启用 ${featureId}... `)
      await enableFeature(featureId)
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
  console.log('\n📊 启用结果:')
  console.log(`  ✅ 成功: ${successCount}`)
  console.log(`  ❌ 失败: ${failCount}`)

  if (successCount > 0) {
    console.log('\n💡 下一步:')
    console.log('  运行 bun run dev 查看 GrowthBook 的实际效果')
    console.log('  你会看到调试日志显示所有特性都已启用')
  }
}

main().catch(error => {
  console.error('❌ 脚本执行失败:', error)
  process.exit(1)
})
