# GrowthBook 特性说明文档

## 已启用的特性总览

✅ **35 个特性已全部启用**（production 和 dev 环境）

---

## 特性分类与功能说明

### P0 - 本地核心特性（无需 API 调用）

这些特性优化本地性能，减少 token 消耗：

#### 1. `tengu_amber_json_tools` ✅
- **功能**: 使用 JSON 格式定义工具（而非 YAML）
- **效果**: 节省约 4.5% 的系统提示 token
- **代码位置**: `src/services/api/claude.ts`

#### 2. `tengu_immediate_model_command` ✅
- **功能**: 即时执行 /model、/fast、/effort 命令
- **效果**: 无需等待 API 响应，立即切换模型/模式
- **使用方式**: 在对话中输入 `/model sonnet` 或 `/fast`

#### 3. `tengu_basalt_3kr` ✅
- **功能**: MCP 指令增量更新
- **效果**: 只发送变更的 MCP 指令，而非全部重新发送
- **代码位置**: `src/services/mcp/`

#### 4. `tengu_pebble_leaf_prune` ✅
- **功能**: 会话存储叶子修剪
- **效果**: 优化会话存储，移除不必要的叶子节点
- **代码位置**: `src/state/`

#### 5. `tengu_chair_sermon` ✅
- **功能**: 消息合并（合并相邻块）
- **效果**: 减少消息数量，优化 API 调用
- **代码位置**: `src/query.ts`

#### 6. `tengu_lodestone_enabled` ✅
- **功能**: 深度链接协议（claude://）
- **效果**: 支持 `claude://` URL scheme 打开应用
- **使用方式**: `claude://open?session=xxx`

#### 7. `tengu_fgts` ✅
- **功能**: 系统提示中的细粒度工具状态
- **效果**: 在系统提示中提供更详细的工具状态信息
- **代码位置**: `src/context.ts`

---

### P1 - API 依赖特性（需要后端支持）

这些特性依赖 Anthropic API 或自定义后端：

#### 8. `tengu_passport_quail` ✅
- **功能**: 自动记忆提取
- **效果**: 自动从对话中提取重要信息保存到记忆
- **代码位置**: `src/services/memory/`

#### 9. `tengu_moth_copse` ✅
- **功能**: 跳过记忆索引，使用预取的记忆
- **效果**: 加速记忆访问，避免重复索引
- **代码位置**: `src/services/memory/`

#### 10. `tengu_coral_fern` ✅
- **功能**: "搜索过去上下文" 功能
- **效果**: 允许搜索历史会话上下文
- **使用方式**: 在对话中引用过去的上下文

#### 11. `tengu_chomp_inflection` ✅
- **功能**: 提示建议
- **效果**: 基于当前对话提供下一步建议
- **代码位置**: `src/commands/prompt/`

#### 12. `tengu_hive_evidence` ✅
- **功能**: 验证代理
- **效果**: 使用独立代理验证工具调用结果
- **代码位置**: `src/agents/verification/`

#### 13. `tengu_kairos_brief` ✅
- **功能**: 简短模式
- **效果**: 生成更简洁的回复
- **使用方式**: `/brief` 命令切换

#### 14. `tengu_kairos_brief_config` ✅
- **功能**: 简短模式的 /slash 命令可见性
- **类型**: JSON 配置
- **默认值**: `{ "enable_slash_command": true }`

#### 15. `tengu_sedge_lantern` ✅
- **功能**: 离开摘要
- **效果**: 当用户离开会话时生成摘要
- **代码位置**: `src/services/summary/`

#### 16. `tengu_onyx_plover` ✅
- **功能**: 自动梦境（记忆巩固）
- **效果**: 在后台自动巩固和整理记忆
- **类型**: JSON 配置
- **默认值**: `{ "enabled": true }`

#### 17. `tengu_willow_mode` ✅
- **功能**: 空闲返回提示
- **类型**: string
- **默认值**: `"dialog"`
- **效果**: 控制空闲时的行为模式

---

### Kill Switches - 终止开关

这些是安全开关，可以禁用特定功能：

#### 18. `tengu_turtle_carbon` ✅
- **功能**: 超级思考扩展思考
- **效果**: 启用深度思考和扩展推理
- **代码位置**: `src/agents/thinking/`

#### 19. `tengu_amber_stoat` ✅
- **功能**: 内置探索/计划代理
- **效果**: 使用内置代理进行代码探索和规划
- **代码位置**: `src/agents/explore/`, `src/agents/plan/`

#### 20. `tengu_amber_flint` ✅
- **功能**: 代理团队/群体
- **效果**: 支持多个代理协作完成任务
- **代码位置**: `src/agents/swarm/`

#### 21. `tengu_slim_subagent_claudemd` ✅
- **功能**: 子代理的精简 CLAUDE.md
- **效果**: 子代理使用精简版的 CLAUDE.md，减少 token
- **代码位置**: `src/agents/`

#### 22. `tengu_birch_trellis` ✅
- **功能**: Tree-sitter bash 安全分析
- **效果**: 使用 Tree-sitter 分析 bash 脚本安全性
- **代码位置**: `src/tools/bash/`

#### 23. `tengu_collage_kaleidoscope` ✅
- **功能**: macOS 剪贴板图像读取
- **效果**: 支持从剪贴板读取图像（仅 macOS）
- **代码位置**: `src/tools/clipboard/`

#### 24. `tengu_compact_cache_prefix` ✅
- **功能**: 压缩期间重用提示缓存
- **效果**: 在压缩对话时保留缓存前缀，提高命中率
- **代码位置**: `src/services/compaction/`

#### 25. `tengu_kairos_assistant` ✅
- **功能**: KAIROS 助手模式激活
- **效果**: 启用 KAIROS 助手功能
- **代码位置**: `src/services/kairos/`

#### 26. `tengu_kairos_cron_durable` ✅
- **功能**: 持久化 cron 任务
- **效果**: cron 任务在重启后仍然保留
- **代码位置**: `src/services/cron/`

#### 27. `tengu_attribution_header` ✅
- **功能**: API 请求归属头
- **效果**: 在 API 请求中添加归属信息
- **代码位置**: `src/services/api/`

#### 28. `tengu_slate_prism` ✅
- **功能**: 代理进度摘要
- **效果**: 显示代理任务的进度摘要
- **代码位置**: `src/agents/`

---

### 特殊功能特性

#### 29. `tengu_auto_background_agents` ✅
- **功能**: 自动后台代理
- **效果**: 自动在后台运行代理任务
- **代码位置**: `src/agents/background/`

#### 30. `tengu_kairos_cron` ✅
- **功能**: Cron 定时任务
- **效果**: 支持定时执行任务
- **使用方式**: 通过 `/cron` 命令管理

#### 31. `tengu_keybinding_customization_release` ✅
- **功能**: 自定义键绑定
- **效果**: 允许自定义键盘快捷键
- **代码位置**: `src/ui/keybindings/`

#### 32. `tengu_session_memory` ✅
- **功能**: 会话记忆
- **效果**: 在会话中保持上下文记忆
- **代码位置**: `src/services/memory/`

#### 33. `tengu_streaming_tool_execution2` ✅
- **功能**: 流式工具执行
- **效果**: 工具调用结果实时流式显示
- **代码位置**: `src/tools/`

#### 34. `tengu_review_bughunter_config` ✅
- **功能**: /ultrareview 命令可见性
- **类型**: JSON 配置
- **默认值**: `{ "enabled": true }`
- **使用方式**: `/ultrareview` 进行代码审查

#### 35. `tengu_ccr_bundle_seed_enabled` ✅
- **功能**: 包种子：跳过分支模式的 GitHub App 检查
- **效果**: 优化包管理流程
- **代码位置**: `src/services/packages/`

---

## 如何观察 GrowthBook 效果

### 1. 查看启动日志

运行应用时会看到 GrowthBook 初始化日志：

```bash
bun run dev
```

由于 `USER_TYPE=ant`，会显示详细的调试日志，包括：
- GrowthBook 客户端初始化
- 特性加载过程
- 特性值查询

### 2. 验证特性值

查看 `src/services/analytics/growthbook.ts` 中的日志输出：

```typescript
// 启用调试日志（USER_TYPE=ant 时自动启用）
if (process.env.USER_TYPE === 'ant') {
  console.log('[GrowthBook] Feature value:', featureName, value)
}
```

### 3. 测试具体功能

#### 测试即时模型切换
```bash
bun run dev
# 在对话中输入：
/model sonnet
/fast
/effort high
```
应该立即生效，无需等待。

#### 测试简短模式
```bash
/brief
# 然后进行对话，观察回复是否更简洁
```

#### 测试流式工具执行
```bash
# 执行任何工具调用，观察结果是否实时流式显示
```

### 4. 查看 GrowthBook 仪表板

访问：https://app.growthbook.io/project/prj_2CcAQypXivwJKnftZJxoXN

可以看到：
- 所有特性的状态
- 特性修改历史
- 环境配置

---

## GrowthBook 在项目中的角色

### 核心作用

1. **特性开关管理**: 集中管理 35+ 个功能特性
2. **A/B 测试支持**: 可以对不同用户群体启用不同特性
3. **灰度发布**: 逐步 rollout 新功能
4. **远程控制**: 无需重新部署即可启用/禁用功能
5. **配置管理**: 存储和管理 JSON 配置

### 技术架构

```
┌─────────────────────────────────────┐
│   GrowthBook Cloud (cdn.growthbook.io)  │
└──────────────┬──────────────────────┘
               │
               │ 加载特性配置
               ↓
┌─────────────────────────────────────┐
│  src/services/analytics/growthbook.ts   │
│  - initializeGrowthBook()               │
│  - getFeatureValue_CACHED_MAY_BE_STALE() │
└──────────────┬──────────────────────┘
               │
               │ 查询特性值
               ↓
┌─────────────────────────────────────┐
│   各个功能模块                        │
│   - 工具优化                          │
│   - 代理系统                          │
│   - 记忆管理                          │
│   - UI 功能                           │
└─────────────────────────────────────┘
```

### 数据流

1. **初始化**: 应用启动时调用 `initializeGrowthBook()`
2. **加载配置**: 从 GrowthBook CDN 加载特性配置
3. **缓存**: 特性值缓存在内存中（30 分钟刷新一次）
4. **查询**: 代码通过 `getFeatureValue_CACHED_MAY_BE_STALE()` 查询特性值
5. **决策**: 基于特性值启用/禁用功能

---

## 环境变量配置

`.env` 文件中的关键配置：

```bash
# GrowthBook API 地址
CLAUDE_GB_ADAPTER_URL=https://cdn.growthbook.io

# GrowthBook Client Key（只读）
CLAUDE_GB_ADAPTER_KEY=secret_readonly_01Ojedi8UzrtVmVlc145ApFGvLUkybX2wilIWbVDZo

# 用户类型（ant 启用调试日志）
USER_TYPE=ant
```

---

## API 访问

### Personal Access Token
```
secret_user_BTgGLZMew1bkKc8PJE2NCSkMbhXu6PPj2wSRFdbs
```

### 常用 API 端点

```bash
# 列出所有特性
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.growthbook.io/api/v1/features"

# 启用特性（dev 和 production）
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"environments":{"dev":true,"production":true}}' \
  "https://api.growthbook.io/api/v1/features/{feature_id}/toggle"

# 获取单个特性详情
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.growthbook.io/api/v1/features/{feature_id}"
```

---

## 总结

✅ **已完成**:
- 注册 GrowthBook 账户
- 创建项目（prj_2CcAQypXivwJKnftZJxoXN）
- 创建 35 个特性
- 在所有环境中启用所有特性
- 配置 .env 文件

🎯 **下一步**:
- 运行 `bun run dev` 观察 GrowthBook 日志
- 测试各项功能（/model、/fast、/brief 等）
- 在 GrowthBook 仪表板中查看特性状态
- 根据需要调整特性值

📚 **相关文档**:
- GrowthBook 官方文档: https://docs.growthbook.io/
- 项目代码: `src/services/analytics/growthbook.ts`
- 特性定义: `LOCAL_GATE_DEFAULTS` in `growthbook.ts`
