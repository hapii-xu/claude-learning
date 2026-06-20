#!/usr/bin/env bun
/**
 * 测试 GrowthBook 连接并查看详细日志
 * 用法：bun run test-growthbook-verbose.ts
 */

console.log('🔍 GrowthBook 连接测试\n')
console.log('='.repeat(60))

// 显示环境变量
console.log('\n📋 环境变量:')
console.log(
  `  CLAUDE_GB_ADAPTER_URL: ${process.env.CLAUDE_GB_ADAPTER_URL || '未设置'}`,
)
console.log(
  `  CLAUDE_GB_ADAPTER_KEY: ${process.env.CLAUDE_GB_ADAPTER_KEY ? '***' + process.env.CLAUDE_GB_ADAPTER_KEY.slice(-10) : '未设置'}`,
)
console.log(`  USER_TYPE: ${process.env.USER_TYPE || '未设置'}`)

// 检查必要的配置
if (!process.env.CLAUDE_GB_ADAPTER_KEY) {
  console.log('\n❌ 错误: CLAUDE_GB_ADAPTER_KEY 未设置')
  console.log('   请在 .env 文件中设置 GrowthBook Client Key')
  process.exit(1)
}

if (!process.env.CLAUDE_GB_ADAPTER_URL) {
  console.log('\n❌ 错误: CLAUDE_GB_ADAPTER_URL 未设置')
  console.log('   请在 .env 文件中设置 GrowthBook API URL')
  process.exit(1)
}

console.log('\n✅ 环境变量配置正确')

// 尝试导入 GrowthBook 模块
console.log('\n⏳ 加载 GrowthBook 模块...')
try {
  const { initializeGrowthBook, getFeatureValue_CACHED_MAY_BE_STALE } =
    await import('./src/services/analytics/growthbook.js')
  console.log('✅ 模块加载成功')

  console.log('\n⏳ 初始化 GrowthBook 客户端...')
  const startTime = Date.now()
  const client = await initializeGrowthBook()
  const elapsed = Date.now() - startTime

  if (!client) {
    console.log('❌ GrowthBook 初始化失败: 客户端为 null')
    console.log('\n可能的原因:')
    console.log('  1. Client Key 无效或过期')
    console.log('  2. 网络连接问题')
    console.log('  3. GrowthBook 服务器不可用')
    process.exit(1)
  }

  console.log(`✅ GrowthBook 初始化成功 (${elapsed}ms)`)

  // 测试特性
  console.log('\n📋 测试特性值:')
  const testFeatures = [
    'tengu_streaming_tool_execution2',
    'tengu_auto_background_agents',
    'tengu_keybinding_customization_release',
    'tengu_kairos_cron',
    'tengu_session_memory',
  ]

  for (const feature of testFeatures) {
    const value = getFeatureValue_CACHED_MAY_BE_STALE(feature, false)
    console.log(`  ${feature}: ${value}`)
  }

  console.log('\n' + '='.repeat(60))
  console.log('✅ 测试完成！GrowthBook 连接正常。')
  console.log('\n💡 提示:')
  console.log('  - 在 GrowthBook 仪表板中修改特性值')
  console.log('  - 重新运行此测试查看变化')
  console.log('  - 运行 bun run dev 启动完整应用')
} catch (error) {
  console.log('\n❌ 测试失败:')
  console.log(error)

  console.log('\n💡 可能的解决方案:')
  console.log('  1. 检查 .env 文件中的配置')
  console.log('  2. 确认 Client Key 正确且未过期')
  console.log('  3. 检查网络连接')
  console.log('  4. 确认 GrowthBook 项目已发布')

  process.exit(1)
}
