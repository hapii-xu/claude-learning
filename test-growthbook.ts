#!/usr/bin/env bun
/**
 * GrowthBook 连接测试脚本
 */

import {
  initializeGrowthBook,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from './src/services/analytics/growthbook.js'

async function testGrowthBook() {
  console.log('🔍 开始测试 GrowthBook 连接...\n')

  console.log('环境变量:')
  console.log('  CLAUDE_GB_ADAPTER_URL:', process.env.CLAUDE_GB_ADAPTER_URL)
  console.log(
    '  CLAUDE_GB_ADAPTER_KEY:',
    process.env.CLAUDE_GB_ADAPTER_KEY
      ? '***' + process.env.CLAUDE_GB_ADAPTER_KEY.slice(-10)
      : '未设置',
  )
  console.log('  USER_TYPE:', process.env.USER_TYPE)
  console.log()

  try {
    console.log('⏳ 初始化 GrowthBook...')
    const client = await initializeGrowthBook()

    if (!client) {
      console.log('❌ GrowthBook 初始化失败：客户端为 null')
      console.log('   可能原因：')
      console.log('   - CLAUDE_GB_ADAPTER_KEY 未设置或无效')
      console.log('   - 网络连接问题')
      return
    }

    console.log('✅ GrowthBook 初始化成功！\n')

    // 测试几个特性
    const testFeatures = [
      'tengu_streaming_tool_execution2',
      'tengu_auto_background_agents',
      'tengu_keybinding_customization_release',
    ]

    console.log('📋 测试特性值:')
    for (const feature of testFeatures) {
      const value = getFeatureValue_CACHED_MAY_BE_STALE(feature, false)
      console.log(`  ${feature}: ${value}`)
    }

    console.log('\n✅ 测试完成！GrowthBook 连接正常。')
  } catch (error) {
    console.error('❌ 测试失败:', error)
  }
}

testGrowthBook().catch(console.error)
