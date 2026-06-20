// 简单的 GrowthBook 测试，绕过配置系统
const GB_URL =
  'https://cdn.growthbook.io/api/client/key_secret_readonly_01Ojedi8UzrtVmVlc145ApFGvLUkybX2wilIWbVDZo.json'

console.log('🔍 从 GrowthBook CDN 加载特性配置...\n')

fetch(GB_URL)
  .then(res => res.json())
  .then(data => {
    console.log('✅ 成功加载 GrowthBook 配置\n')
    console.log('📋 可用特性数量:', Object.keys(data.features || {}).length)
    console.log('\n📊 前 10 个特性示例:')

    const features = Object.entries(data.features || {}).slice(0, 10)
    features.forEach(([key, value]) => {
      const defaultValue = value.defaultValue
      console.log(`  ${key}: ${defaultValue}`)
    })

    console.log('\n💡 这些特性在应用启动时会被加载并用于控制功能')
  })
  .catch(err => {
    console.error('❌ 加载失败:', err.message)
  })
