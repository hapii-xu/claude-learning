import { feature } from 'bun:bundle'
import { satisfies } from 'src/utils/semver.js'
import { isRunningWithBun } from '../utils/bundledMode.js'
import { getPlatform } from '../utils/platform.js'
import type { KeybindingBlock } from './types.js'

/**
 * 与当前 Claude Code 行为匹配的默认快捷键。
 * 这些首先加载，然后用户 keybindings.json 覆盖它们。
 */

// 平台特定的图片粘贴快捷键：
// - Windows：alt+v（ctrl+v 是系统粘贴）
// - 其他平台：ctrl+v
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// 仅修饰符的和弦（如 shift+tab）在没有 VT 模式的 Windows Terminal 上可能失败
// 参见：https://github.com/microsoft/terminal/issues/879#issuecomment-618801651
// Node 在 24.2.0 / 22.17.0 中启用了 VT 模式：https://github.com/nodejs/node/pull/58358
// Bun 在 1.2.23 中启用了 VT 模式：https://github.com/oven-sh/bun/pull/21161
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' ||
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0'))

// 平台特定的模式循环快捷键：
// - 无 VT 模式的 Windows：meta+m（shift+tab 不可靠）
// - 其他平台：shift+tab
const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      // ctrl+c 和 ctrl+d 使用特殊的基于时间的双击处理。
      // 它们确实在此定义，以便解析器可以找到它们，但
      // 用户无法重新绑定它们 - reservedShortcuts.ts 中的
      // 验证会在用户尝试覆盖这些键时显示错误。
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+o': 'app:toggleTranscript',
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? { 'ctrl+shift+b': 'app:toggleBrief' as const }
        : {}),
      'ctrl+shift+o': 'app:toggleTeammatePreview',
      'ctrl+r': 'history:search',
      // 文件导航。cmd+ 绑定仅在 kitty 协议终端上触发；
      // ctrl+shift 是可移植的备选方案。
      ...(feature('QUICK_SEARCH')
        ? {
            'ctrl+shift+f': 'app:globalSearch' as const,
            'cmd+shift+f': 'app:globalSearch' as const,
            'ctrl+shift+p': 'app:quickOpen' as const,
            'cmd+shift+p': 'app:quickOpen' as const,
          }
        : {}),
      ...(feature('TERMINAL_PANEL') ? { 'meta+j': 'app:toggleTerminal' } : {}),
    },
  },
  {
    context: 'Chat',
    bindings: {
      escape: 'chat:cancel',
      // ctrl+x 和弦前缀避免遮蔽 readline 编辑键（ctrl+a/b/e/f/...）。
      'ctrl+x ctrl+k': 'chat:killAgents',
      [MODE_CYCLE_KEY]: 'chat:cycleMode',
      'meta+p': 'chat:modelPicker',
      'meta+o': 'chat:fastMode',
      'meta+t': 'chat:thinkingToggle',
      enter: 'chat:submit',
      up: 'history:previous',
      down: 'history:next',
      // 编辑快捷键（在此定义，迁移进行中）
      // 撤销有两个绑定以支持不同的终端行为：
      // - ctrl+_ 用于旧终端（发送 \x1f 控制字符）
      // - ctrl+shift+- 用于 Kitty 协议（发送带修饰符的物理键）
      'ctrl+_': 'chat:undo',
      'ctrl+shift+-': 'chat:undo',
      // ctrl+x ctrl+e 是 readline 原生的 edit-and-execute-command 绑定。
      'ctrl+x ctrl+e': 'chat:externalEditor',
      'ctrl+g': 'chat:externalEditor',
      'ctrl+s': 'chat:stash',
      // 图片粘贴快捷键（平台特定的键在上方定义）
      [IMAGE_PASTE_KEY]: 'chat:imagePaste',
      ...(feature('MESSAGE_ACTIONS')
        ? { 'shift+up': 'chat:messageActions' as const }
        : {}),
      // 语音激活（按住说话）。注册以便 getShortcutDisplay
      // 可以找到它而不命中备选的分析日志。要重新绑定，
      // 添加 voice:pushToTalk 条目（后者优先）；要禁用，使用 /voice
      // —— 将 space 设为 null 会命中 useKeybinding.ts 中预先存在的陷阱，
      // 其中 'unbound' 会吞掉事件（space 在输入时无效）。
      ...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {}),
    },
  },
  {
    context: 'Autocomplete',
    bindings: {
      tab: 'autocomplete:accept',
      escape: 'autocomplete:dismiss',
      up: 'autocomplete:previous',
      down: 'autocomplete:next',
    },
  },
  {
    context: 'Settings',
    bindings: {
      // 设置菜单仅使用 escape（而非 'n'）关闭
      escape: 'confirm:no',
      // 配置面板列表导航（复用 Select 操作）
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      // 左右循环枚举值（与 handleKeyDown 中的左右箭头相同）
      left: 'select:previousValue',
      right: 'select:nextValue',
      // 切换/激活所选设置（仅 space —— enter 保存并关闭）
      space: 'select:accept',
      // 保存并关闭配置面板
      enter: 'settings:close',
      // 进入搜索模式
      '/': 'settings:search',
      // 重试加载用量数据（仅在错误时激活）
      r: 'settings:retry',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
      enter: 'confirm:yes',
      escape: 'confirm:no',
      // 带列表的对话框导航
      up: 'confirm:previous',
      down: 'confirm:next',
      tab: 'confirm:nextField',
      space: 'confirm:toggle',
      // 切换模式（用于文件权限对话框和团队对话框）
      'shift+tab': 'confirm:cycleMode',
      // 在权限对话框中切换权限说明
      'ctrl+e': 'confirm:toggleExplanation',
      // 切换权限调试信息
      'ctrl+d': 'permission:toggleDebug',
    },
  },
  {
    context: 'FormField',
    bindings: {
      // 表单字段垂直导航（登录/设置面板）
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      up: 'tabs:previous',
      down: 'tabs:next',
    },
  },
  {
    context: 'Tabs',
    bindings: {
      // 标签页循环导航
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      right: 'tabs:next',
      left: 'tabs:previous',
    },
  },
  {
    context: 'Transcript',
    bindings: {
      'ctrl+e': 'transcript:toggleShowAll',
      'ctrl+c': 'transcript:exit',
      escape: 'transcript:exit',
      // q —— 分页器惯例（less、tmux 复制模式）。转录是
      // 没有提示的模态阅读视图，所以 q 作为字面字符没有拥有者。
      q: 'transcript:exit',
    },
  },
  {
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'historySearch:next',
      escape: 'historySearch:accept',
      tab: 'historySearch:accept',
      'ctrl+c': 'historySearch:cancel',
      enter: 'historySearch:execute',
    },
  },
  {
    context: 'Task',
    bindings: {
      // 后台运行前台任务（bash 命令、代理）
      // 在 tmux 中，用户必须按 ctrl+b 两次（tmux 前缀转义）
      'ctrl+b': 'task:background',
    },
  },
  {
    context: 'ThemePicker',
    bindings: {
      'ctrl+t': 'theme:toggleSyntaxHighlighting',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
      wheelup: 'scroll:lineUp',
      wheeldown: 'scroll:lineDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
      // 选择复制。ctrl+shift+c 是标准终端复制。
      // cmd+c 仅在使用 kitty 键盘协议
      // （kitty/WezTerm/ghostty/iTerm2）的终端上触发，
      // 其中 super 修饰符实际到达 pty —— 在其他地方无效。
      // Esc 清除和上下文 ctrl+c 通过原始 useInput 处理，
      // 以便它们可以有条件地传播。
      'ctrl+shift+c': 'selection:copy',
      'cmd+c': 'selection:copy',
    },
  },
  {
    context: 'Help',
    bindings: {
      escape: 'help:dismiss',
    },
  },
  // 附件导航（选择对话框图片附件）
  {
    context: 'Attachments',
    bindings: {
      right: 'attachments:next',
      left: 'attachments:previous',
      backspace: 'attachments:remove',
      delete: 'attachments:remove',
      down: 'attachments:exit',
      escape: 'attachments:exit',
    },
  },
  // 页脚指示器导航（任务、团队、差异、循环）
  {
    context: 'Footer',
    bindings: {
      up: 'footer:up',
      'ctrl+p': 'footer:up',
      down: 'footer:down',
      'ctrl+n': 'footer:down',
      right: 'footer:next',
      left: 'footer:previous',
      enter: 'footer:openSelected',
      escape: 'footer:clearSelection',
    },
  },
  // 消息选择器（回退对话框）导航
  {
    context: 'MessageSelector',
    bindings: {
      up: 'messageSelector:up',
      down: 'messageSelector:down',
      k: 'messageSelector:up',
      j: 'messageSelector:down',
      'ctrl+p': 'messageSelector:up',
      'ctrl+n': 'messageSelector:down',
      'ctrl+up': 'messageSelector:top',
      'shift+up': 'messageSelector:top',
      'meta+up': 'messageSelector:top',
      'shift+k': 'messageSelector:top',
      'ctrl+down': 'messageSelector:bottom',
      'shift+down': 'messageSelector:bottom',
      'meta+down': 'messageSelector:bottom',
      'shift+j': 'messageSelector:bottom',
      enter: 'messageSelector:select',
    },
  },
  // PromptInput 在光标活动时卸载 —— 无键冲突。
  ...(feature('MESSAGE_ACTIONS')
    ? [
        {
          context: 'MessageActions' as const,
          bindings: {
            up: 'messageActions:prev' as const,
            down: 'messageActions:next' as const,
            k: 'messageActions:prev' as const,
            j: 'messageActions:next' as const,
            // meta = cmd 在 macOS 上；super 用于 kitty 键盘协议 —— 两者都绑定。
            'meta+up': 'messageActions:top' as const,
            'meta+down': 'messageActions:bottom' as const,
            'super+up': 'messageActions:top' as const,
            'super+down': 'messageActions:bottom' as const,
            // 鼠标选择在存在 shift+箭头 时扩展
            // （ScrollKeybindingHandler:573）—— 正确的分层 UX：
            // esc 清除选择，然后 shift+↑ 跳转。
            'shift+up': 'messageActions:prevUser' as const,
            'shift+down': 'messageActions:nextUser' as const,
            escape: 'messageActions:escape' as const,
            'ctrl+c': 'messageActions:ctrlc' as const,
            // 镜像 MESSAGE_ACTIONS。不导入 —— 会将 React/ink 拉入此配置模块。
            enter: 'messageActions:enter' as const,
            c: 'messageActions:c' as const,
            p: 'messageActions:p' as const,
          },
        },
      ]
    : []),
  // 差异对话框导航
  {
    context: 'DiffDialog',
    bindings: {
      escape: 'diff:dismiss',
      left: 'diff:previousSource',
      right: 'diff:nextSource',
      up: 'diff:previousFile',
      down: 'diff:nextFile',
      enter: 'diff:viewDetails',
      // 注意：diff:back 在详情模式中由左箭头处理
    },
  },
  // 模型选择器努力程度循环（仅限 Anthropic 员工）
  {
    context: 'ModelPicker',
    bindings: {
      left: 'modelPicker:decreaseEffort',
      right: 'modelPicker:increaseEffort',
      space: 'modelPicker:toggle1M',
    },
  },
  // 努力程度面板（无参数的 /effort 斜杠命令）
  {
    context: 'EffortPanel',
    bindings: {
      left: 'effortPanel:decrease',
      right: 'effortPanel:increase',
      h: 'effortPanel:decrease',
      l: 'effortPanel:increase',
      home: 'effortPanel:home',
      end: 'effortPanel:end',
      enter: 'effortPanel:confirm',
      escape: 'effortPanel:cancel',
      q: 'effortPanel:cancel',
      'ctrl+c': 'effortPanel:cancel',
    },
  },
  // 选择组件导航（用于 /model、/resume、权限提示等）
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      down: 'select:next',
      j: 'select:next',
      k: 'select:previous',
      'ctrl+n': 'select:next',
      'ctrl+p': 'select:previous',
      enter: 'select:accept',
      escape: 'select:cancel',
    },
  },
  // 插件对话框操作（管理、浏览、发现插件）
  // 导航（select:*）使用上方的 Select 上下文
  {
    context: 'Plugin',
    bindings: {
      space: 'plugin:toggle',
      i: 'plugin:install',
    },
  },
]
