import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// -- 依赖

// query() 的 I/O 依赖。将 `deps` 覆盖传入 QueryParams
// 让测试直接注入假实现，而不是每个模块 spyOn——最常见的 mock
// （callModel、autocompact）目前各在 6-8 个测试文件中被间谍，
// 伴随着模块导入和间谍样板代码。
//
// 使用 `typeof fn` 自动保持签名与真实实现同步。此文件导入真实函数
// 用于类型定义和生产工厂——为类型定义导入此文件的测试
// 已经在导入 query.ts（它导入了一切），所以没有新的模块图成本。
//
// 范围特意缩小（4 个依赖）以证明此模式。后续 PR 可以添加
// runTools、handleStopHooks、logEvent、队列操作等。
export type QueryDeps = {
  // -- 模型
  callModel: typeof queryModelWithStreaming

  // -- 压缩
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- 平台
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
