import { isEnvTruthy } from '../utils/envUtils.js'

// 延迟读取，以便能拿到 globalSettings.env（在模块加载后应用）中的
// ENABLE_GROWTHBOOK_DEV。USER_TYPE 是构建期 define，安全无副作用。
export function getGrowthBookClientKey(): string {
  // 适配器优先：自定义 GrowthBook 服务器
  const adapterKey = process.env.CLAUDE_GB_ADAPTER_KEY
  if (adapterKey) return adapterKey

  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'
      : 'sdk-xRVcrliHIlrg4og4'
    : 'sdk-zAZezfDKGoZuXXKe'
}
