import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import {
  MACOS_RESERVED,
  NON_REBINDABLE,
  TERMINAL_RESERVED,
} from '../../keybindings/reservedShortcuts.js'
import type { KeybindingsSchemaType } from '../../keybindings/schema.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXT_DESCRIPTIONS,
  KEYBINDING_CONTEXTS,
} from '../../keybindings/schema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 构建所有上下文的 markdown 表格。
 */
function generateContextsTable(): string {
  return markdownTable(
    ['Context', 'Description'],
    KEYBINDING_CONTEXTS.map(ctx => [
      `\`${ctx}\``,
      KEYBINDING_CONTEXT_DESCRIPTIONS[ctx],
    ]),
  )
}

/**
 * 构建所有操作及其默认绑定和上下文的 markdown 表格。
 */
function generateActionsTable(): string {
  // 构建查找表：action -> { keys, context }
  const actionInfo: Record<string, { keys: string[]; context: string }> = {}
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (action) {
        if (!actionInfo[action as string]) {
          actionInfo[action as string] = { keys: [], context: block.context }
        }
        actionInfo[action as string].keys.push(key)
      }
    }
  }

  return markdownTable(
    ['Action', 'Default Key(s)', 'Context'],
    KEYBINDING_ACTIONS.map(action => {
      const info = actionInfo[action]
      const keys = info ? info.keys.map(k => `\`${k}\``).join(', ') : '(none)'
      const context = info ? info.context : inferContextFromAction(action)
      return [`\`${action}\``, keys, context]
    }),
  )
}

/**
 * 当操作不在 DEFAULT_BINDINGS 中时，从操作前缀推断上下文。
 */
function inferContextFromAction(action: string): string {
  const prefix = action.split(':')[0]
  const prefixToContext: Record<string, string> = {
    app: 'Global',
    history: 'Global or Chat',
    chat: 'Chat',
    autocomplete: 'Autocomplete',
    confirm: 'Confirmation',
    tabs: 'Tabs',
    transcript: 'Transcript',
    historySearch: 'HistorySearch',
    task: 'Task',
    theme: 'ThemePicker',
    help: 'Help',
    attachments: 'Attachments',
    footer: 'Footer',
    messageSelector: 'MessageSelector',
    diff: 'DiffDialog',
    modelPicker: 'ModelPicker',
    select: 'Select',
    permission: 'Confirmation',
  }
  return prefixToContext[prefix ?? ''] ?? 'Unknown'
}

/**
 * 构建保留快捷键列表。
 */
function generateReservedShortcuts(): string {
  const lines: string[] = []

  lines.push('### 不可重新绑定（会报错）')
  for (const s of NON_REBINDABLE) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  lines.push('')
  lines.push('### 终端保留键（会报错/警告）')
  for (const s of TERMINAL_RESERVED) {
    lines.push(
      `- \`${s.key}\` — ${s.reason} (${s.severity === 'error' ? '无法使用' : '可能冲突'})`,
    )
  }

  lines.push('')
  lines.push('### macOS 保留键（会报错）')
  for (const s of MACOS_RESERVED) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  return lines.join('\n')
}

const FILE_FORMAT_EXAMPLE: KeybindingsSchemaType = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    {
      context: 'Chat',
      bindings: {
        'ctrl+e': 'chat:externalEditor',
      },
    },
  ],
}

const UNBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+s': null,
  },
}

const REBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+g': null,
    'ctrl+e': 'chat:externalEditor',
  },
}

const CHORD_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Global',
  bindings: {
    'ctrl+k ctrl+t': 'app:toggleTodos',
  },
}

const SECTION_INTRO = [
  '# 快捷键技能',
  '',
  '创建或修改 `~/.hclaude/keybindings.json` 以自定义键盘快捷键。',
  '',
  '## 重要：写入前必须先读取',
  '',
  '**始终先读取 `~/.hclaude/keybindings.json`**（该文件可能尚不存在）。将更改与现有绑定合并——切勿替换整个文件。',
  '',
  '- 修改现有文件时使用 **Edit** 工具',
  '- 仅当文件不存在时才使用 **Write** 工具',
].join('\n')

const SECTION_FILE_FORMAT = [
  '## 文件格式',
  '',
  '```json',
  jsonStringify(FILE_FORMAT_EXAMPLE, null, 2),
  '```',
  '',
  '始终包含 `$schema` 和 `$docs` 字段。',
].join('\n')

const SECTION_KEYSTROKE_SYNTAX = [
  '## 按键语法',
  '',
  '**修饰键**（用 `+` 组合）：',
  '- `ctrl`（别名：`control`）',
  '- `alt`（别名：`opt`、`option`）— 注意：在终端中 `alt` 和 `meta` 是等价的',
  '- `shift`',
  '- `meta`（别名：`cmd`、`command`）',
  '',
  '**特殊键**：`escape`/`esc`、`enter`/`return`、`tab`、`space`、`backspace`、`delete`、`up`、`down`、`left`、`right`',
  '',
  '**和弦键**：空格分隔的按键序列，例如 `ctrl+k ctrl+s`（按键之间有 1 秒超时）',
  '',
  '**示例**：`ctrl+shift+p`、`alt+enter`、`ctrl+k ctrl+n`',
].join('\n')

const SECTION_UNBINDING = [
  '## 解绑默认快捷键',
  '',
  '将某个键设置为 `null` 即可移除其默认绑定：',
  '',
  '```json',
  jsonStringify(UNBIND_EXAMPLE, null, 2),
  '```',
].join('\n')

const SECTION_INTERACTION = [
  '## 用户绑定与默认绑定的交互方式',
  '',
  '- 用户绑定是**叠加的**——会附加在默认绑定之后',
  '- 要将绑定**移动**到其他键：将旧键设为 `null` 并添加新绑定',
  '- 只有在用户想修改某个上下文中的内容时，该上下文才需要出现在用户文件中',
].join('\n')

const SECTION_COMMON_PATTERNS = [
  '## 常见模式',
  '',
  '### 重新绑定一个键',
  '将外部编辑器快捷键从 `ctrl+g` 改为 `ctrl+e`：',
  '```json',
  jsonStringify(REBIND_EXAMPLE, null, 2),
  '```',
  '',
  '### 添加和弦绑定',
  '```json',
  jsonStringify(CHORD_EXAMPLE, null, 2),
  '```',
].join('\n')

const SECTION_BEHAVIORAL_RULES = [
  '## 行为规则',
  '',
  '1. 只包含用户想修改的上下文（最小化覆盖）',
  '2. 验证动作和上下文均来自下方的已知列表',
  '3. 若用户选择的键与保留快捷键或常用工具（如 tmux 的 `ctrl+b`、screen 的 `ctrl+a`）冲突，应主动警告用户',
  '4. 为现有动作添加新绑定时，新绑定是叠加的（除非显式解绑，否则原默认绑定仍有效）',
  '5. 要完全替换默认绑定，需解绑旧键并添加新键',
].join('\n')

const SECTION_DOCTOR = [
  '## 使用 /doctor 验证',
  '',
  '`/doctor` 命令包含"快捷键配置问题"部分，用于验证 `~/.hclaude/keybindings.json`。',
  '',
  '### 常见问题及修复方法',
  '',
  markdownTable(
    ['问题', '原因', '修复方法'],
    [
      [
        '`keybindings.json must have a "bindings" array`',
        '缺少包装对象',
        '将绑定包裹在 `{ "bindings": [...] }` 中',
      ],
      [
        '`"bindings" must be an array`',
        '`bindings` 不是数组',
        '将 `"bindings"` 设为数组：`[{ context: ..., bindings: ... }]`',
      ],
      [
        '`Unknown context "X"`',
        '上下文名称拼写错误或无效',
        '使用"可用上下文"表格中的精确名称',
      ],
      [
        '`Duplicate key "X" in Y bindings`',
        '同一上下文中同一键被定义了两次',
        '移除重复项；JSON 只使用最后一个值',
      ],
      [
        '`"X" may not work: ...`',
        '键与终端/操作系统保留快捷键冲突',
        '选择其他键（参见"保留快捷键"部分）',
      ],
      [
        '`Could not parse keystroke "X"`',
        '键语法无效',
        '检查语法：修饰键之间使用 `+`，键名必须有效',
      ],
      [
        '`Invalid action for "X"`',
        '动作值不是字符串或 null',
        '动作必须是字符串（如 `"app:help"`）或 `null`（解绑）',
      ],
    ],
  ),
  '',
  '### /doctor 输出示例',
  '',
  '```',
  'Keybinding Configuration Issues',
  'Location: ~/.hclaude/keybindings.json',
  '  └ [Error] Unknown context "chat"',
  '    → Valid contexts: Global, Chat, Autocomplete, ...',
  '  └ [Warning] "ctrl+c" may not work: Terminal interrupt (SIGINT)',
  '```',
  '',
  '**错误**会导致绑定失效，必须修复。**警告**表示存在潜在冲突，但绑定可能仍然有效。',
].join('\n')

export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings-help',
    description:
      '当用户想要自定义键盘快捷键、重新绑定按键、添加和弦绑定或修改 ~/.hclaude/keybindings.json 时使用。示例："rebind ctrl+s"、"add a chord shortcut"、"change the submit key"、"customize keybindings"。',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: isKeybindingCustomizationEnabled,
    async getPromptForCommand(args) {
      // 从真实数据源数组动态生成参考表
      const contextsTable = generateContextsTable()
      const actionsTable = generateActionsTable()
      const reservedShortcuts = generateReservedShortcuts()

      const sections = [
        SECTION_INTRO,
        SECTION_FILE_FORMAT,
        SECTION_KEYSTROKE_SYNTAX,
        SECTION_UNBINDING,
        SECTION_INTERACTION,
        SECTION_COMMON_PATTERNS,
        SECTION_BEHAVIORAL_RULES,
        SECTION_DOCTOR,
        `## 保留快捷键\n\n${reservedShortcuts}`,
        `## 可用上下文\n\n${contextsTable}`,
        `## 可用动作\n\n${actionsTable}`,
      ]

      if (args) {
        sections.push(`## 用户请求\n\n${args}`)
      }

      return [{ type: 'text', text: sections.join('\n\n') }]
    },
  })
}

/**
 * 从表头和行数据构建 markdown 表格。
 */
function markdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => '---')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}
