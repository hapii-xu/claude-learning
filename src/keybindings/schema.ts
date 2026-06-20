/**
 * keybindings.json 配置的 Zod schema。
 * 用于验证和 JSON schema 生成。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * 可应用快捷键的有效上下文名称。
 */
export const KEYBINDING_CONTEXTS = [
  'Global',
  'Chat',
  'Autocomplete',
  'Confirmation',
  'Help',
  'Transcript',
  'HistorySearch',
  'Task',
  'ThemePicker',
  'Settings',
  'Tabs',
  // 快捷键迁移的新上下文
  'Attachments',
  'Footer',
  'MessageSelector',
  'DiffDialog',
  'ModelPicker',
  'Select',
  'Plugin',
] as const

/**
 * 每个快捷键上下文的易读描述。
 */
export const KEYBINDING_CONTEXT_DESCRIPTIONS: Record<
  (typeof KEYBINDING_CONTEXTS)[number],
  string
> = {
  Global: 'Active everywhere, regardless of focus',
  Chat: 'When the chat input is focused',
  Autocomplete: 'When autocomplete menu is visible',
  Confirmation: 'When a confirmation/permission dialog is shown',
  Help: 'When the help overlay is open',
  Transcript: 'When viewing the transcript',
  HistorySearch: 'When searching command history (ctrl+r)',
  Task: 'When a task/agent is running in the foreground',
  ThemePicker: 'When the theme picker is open',
  Settings: 'When the settings menu is open',
  Tabs: 'When tab navigation is active',
  Attachments: 'When navigating image attachments in a select dialog',
  Footer: 'When footer indicators are focused',
  MessageSelector: 'When the message selector (rewind) is open',
  DiffDialog: 'When the diff dialog is open',
  ModelPicker: 'When the model picker is open',
  Select: 'When a select/list component is focused',
  Plugin: 'When the plugin dialog is open',
}

/**
 * 所有有效的快捷键操作标识符。
 */
export const KEYBINDING_ACTIONS = [
  // 应用级操作（Global 上下文）
  'app:interrupt',
  'app:exit',
  'app:toggleTodos',
  'app:toggleTranscript',
  'app:toggleBrief',
  'app:toggleTeammatePreview',
  'app:toggleTerminal',
  'app:redraw',
  'app:globalSearch',
  'app:quickOpen',
  // 历史导航
  'history:search',
  'history:previous',
  'history:next',
  // 聊天输入操作
  'chat:cancel',
  'chat:killAgents',
  'chat:cycleMode',
  'chat:modelPicker',
  'chat:fastMode',
  'chat:thinkingToggle',
  'chat:submit',
  'chat:newline',
  'chat:undo',
  'chat:externalEditor',
  'chat:stash',
  'chat:imagePaste',
  'chat:messageActions',
  // 自动补全菜单操作
  'autocomplete:accept',
  'autocomplete:dismiss',
  'autocomplete:previous',
  'autocomplete:next',
  // 确认对话框操作
  'confirm:yes',
  'confirm:no',
  'confirm:previous',
  'confirm:next',
  'confirm:nextField',
  'confirm:previousField',
  'confirm:cycleMode',
  'confirm:toggle',
  'confirm:toggleExplanation',
  // 标签页导航操作
  'tabs:next',
  'tabs:previous',
  // 转录查看器操作
  'transcript:toggleShowAll',
  'transcript:exit',
  // 历史搜索操作
  'historySearch:next',
  'historySearch:accept',
  'historySearch:cancel',
  'historySearch:execute',
  // 任务/代理操作
  'task:background',
  // 主题选择器操作
  'theme:toggleSyntaxHighlighting',
  // 帮助菜单操作
  'help:dismiss',
  // 附件导航（选择对话框中的图片附件）
  'attachments:next',
  'attachments:previous',
  'attachments:remove',
  'attachments:exit',
  // 页脚指示器操作
  'footer:up',
  'footer:down',
  'footer:next',
  'footer:previous',
  'footer:openSelected',
  'footer:clearSelection',
  'footer:close',
  // 消息选择器（回退）操作
  'messageSelector:up',
  'messageSelector:down',
  'messageSelector:top',
  'messageSelector:bottom',
  'messageSelector:select',
  // 差异对话框操作
  'diff:dismiss',
  'diff:previousSource',
  'diff:nextSource',
  'diff:back',
  'diff:viewDetails',
  'diff:previousFile',
  'diff:nextFile',
  // 模型选择器操作（仅限 Anthropic 员工）
  'modelPicker:decreaseEffort',
  'modelPicker:increaseEffort',
  'modelPicker:toggle1M',
  // 努力程度面板操作（无参数的 /effort 斜杠命令）
  'effortPanel:decrease',
  'effortPanel:increase',
  'effortPanel:home',
  'effortPanel:end',
  'effortPanel:confirm',
  'effortPanel:cancel',
  // 选择组件操作（与 confirm: 区分以避免冲突）
  'select:next',
  'select:previous',
  'select:accept',
  'select:cancel',
  // 插件对话框操作
  'plugin:toggle',
  'plugin:install',
  // 权限对话框操作
  'permission:toggleDebug',
  // 设置配置面板操作
  'settings:search',
  'settings:retry',
  'settings:close',
  'select:previousValue',
  'select:nextValue',
  // 语音操作
  'voice:pushToTalk',
] as const

/**
 * 单个快捷键块的 schema。
 */
export const KeybindingBlockSchema = lazySchema(() =>
  z
    .object({
      context: z
        .enum(KEYBINDING_CONTEXTS)
        .describe(
          'UI context where these bindings apply. Global bindings work everywhere.',
        ),
      bindings: z
        .record(
          z
            .string()
            .describe('Keystroke pattern (e.g., "ctrl+k", "shift+tab")'),
          z
            .union([
              z.enum(KEYBINDING_ACTIONS),
              z
                .string()
                .regex(/^command:[a-zA-Z0-9:\-_]+$/)
                .describe(
                  'Command binding (e.g., "command:help", "command:compact"). Executes the slash command as if typed.',
                ),
              z.null().describe('Set to null to unbind a default shortcut'),
            ])
            .describe(
              'Action to trigger, command to invoke, or null to unbind',
            ),
        )
        .describe('Map of keystroke patterns to actions'),
    })
    .describe('A block of keybindings for a specific context'),
)

/**
 * 整个 keybindings.json 文件的 schema。
 * 使用带可选 $schema 和 $docs 元数据的对象包装格式。
 */
export const KeybindingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z
        .string()
        .optional()
        .describe('JSON Schema URL for editor validation'),
      $docs: z.string().optional().describe('Documentation URL'),
      bindings: z
        .array(KeybindingBlockSchema())
        .describe('Array of keybinding blocks by context'),
    })
    .describe(
      'Claude Code keybindings configuration. Customize keyboard shortcuts by context.',
    ),
)

/**
 * 从 schema 派生的 TypeScript 类型。
 */
export type KeybindingsSchemaType = z.infer<
  ReturnType<typeof KeybindingsSchema>
>
