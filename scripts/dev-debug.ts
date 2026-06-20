// Session token 固定以便 launch.json 里的 attach URL 保持稳定
const port = process.env.DEBUG_PORT ?? '8888'
const session = process.env.DEBUG_SESSION ?? '2dc3gzl5xot'
process.env.BUN_INSPECT = `localhost:${port}/${session}`

const WS_URL = `ws://localhost:${port}/${session}`

console.log('')
console.log('\x1b[33m🟠 Bun Inspector 配置完成\x1b[0m')
console.log('')
console.log(`   attach URL  : \x1b[36m${WS_URL}\x1b[0m`)
console.log(`   端口        : ${port}`)
console.log('')
console.log('\x1b[32m👉 推荐用法（不要打开浏览器）：\x1b[0m')
console.log('')
console.log('   1. VS Code 左侧「Run and Debug」面板（Ctrl+Shift+D）')
console.log('   2. 选择对应配置（如「🚀 快速 Attach」），按 F5')
console.log('   3. 在源码左侧行号槽点一下下断点')
console.log('   4. 调用栈 / 变量 / Watch / 断点条件，都在 IDE 里')
console.log('')
console.log(
  '\x1b[2m   （preLaunchTask 会自动执行本脚本，通常不需要手动运行）\x1b[0m',
)
console.log('')
console.log(
  '\x1b[35m📝 手动运行时（PowerShell 多词 prompt 必须用 stdin）：\x1b[0m',
)
console.log('')
console.log('   echo "say hello" | bun run dev:inspect -- -p')
console.log('')
console.log(
  '\x1b[2m   （直接传 -p "say hello" 在 Windows PowerShell 5.1 会丢引号）\x1b[0m',
)
console.log('')

await import('./dev')
