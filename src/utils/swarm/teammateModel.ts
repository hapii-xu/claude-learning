import { CLAUDE_OPUS_4_6_CONFIG } from '../model/configs.js'
import { getAPIProvider } from '../model/providers.js'

// @[模型启动]: 更新下方的回退模型。
// 当用户从未在 /config 中设置 teammateDefaultModel 时，新 teammate
// 使用 Opus 4.6。必须感知提供者以便 Bedrock/Vertex/Foundry 客户获得
// 正确的模型 ID。
export function getHardcodedTeammateModelFallback(): string {
  return CLAUDE_OPUS_4_6_CONFIG[getAPIProvider()]
}
