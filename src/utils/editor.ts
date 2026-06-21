import {
  type SpawnOptions,
  type SpawnSyncOptions,
  spawn,
  spawnSync,
} from 'child_process'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import { instances } from '@anthropic/ink'
import { logForDebugging } from './debug.js'
import { whichSync } from './which.js'

function isCommandAvailable(command: string): boolean {
  return !!whichSync(command)
}

// GUI 编辑器，在独立窗口中打开，可 detached 启动
// 而不会与 TUI 争夺 stdin。VS Code 系列（cursor、windsurf、codium）
// 被显式列出，因为没有一个是 'code' 的子串。
const GUI_EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'subl',
  'atom',
  'gedit',
  'notepad++',
  'notepad',
]

// 接受 +N 作为跳转行参数的编辑器。Windows 默认
//（'start /wait notepad'）不接受 —— notepad 会把 +42 当作文件名。
const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/

// VS Code 及其分支使用 -g file:line。subl 使用裸 file:line（无 -g）。
const VSCODE_FAMILY = new Set(['code', 'cursor', 'windsurf', 'codium'])

/**
 * 将编辑器分类为 GUI 与否。返回匹配的 GUI 系列名
 * 用于跳转行 argv 选择，终端编辑器返回 undefined。
 * 注意：这仅用于分类 —— 启动用户的实际二进制而非
 * 此返回值，因此 `code-insiders` / 绝对路径会被保留。
 *
 * 使用 basename 因此 /home/alice/code/bin/nvim 不会通过目录
 * 组件匹配 'code'。code-insiders → 仍匹配 'code'，
 * /usr/bin/code → 'code' → 匹配。
 */
export function classifyGuiEditor(editor: string): string | undefined {
  const base = basename(editor.split(' ')[0] ?? '')
  return GUI_EDITORS.find(g => base.includes(g))
}

/**
 * 为 GUI 编辑器构建跳转行 argv。VS Code 系列使用 -g file:line；
 * subl 使用裸 file:line；其他不支持跳转行。
 */
function guiGotoArgv(
  guiFamily: string,
  filePath: string,
  line: number | undefined,
): string[] {
  if (!line) return [filePath]
  if (VSCODE_FAMILY.has(guiFamily)) return ['-g', `${filePath}:${line}`]
  if (guiFamily === 'subl') return [`${filePath}:${line}`]
  return [filePath]
}

/**
 * 在用户的外部编辑器中打开文件。
 *
 * 对于 GUI 编辑器（code、subl 等）：detached 启动 —— 编辑器在
 * 独立窗口打开，Claude Code 保持交互。
 *
 * 对于终端编辑器（vim、nvim、nano 等）：通过 Ink 的 alt-screen
 * 移交阻塞直到编辑器退出。这与 promptEditor.ts 中
 * editFileInEditor() 的流程相同，只是不回读。
 *
 * 返回编辑器是否启动成功，若无可用编辑器则返回 false。
 */
export function openFileInExternalEditor(
  filePath: string,
  line?: number,
): boolean {
  const editor = getExternalEditor()
  if (!editor) return false

  // 启动用户的实际二进制（保留 code-insiders、绝对路径等）。
  // 拆分为二进制 + 额外参数，以便多词值如 'start /wait
  // notepad' 或 'code --wait' 将所有 token 传递给 spawn。
  const parts = editor.split(' ')
  const base = parts[0] ?? editor
  const editorArgs = parts.slice(1)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily) {
    const gotoArgv = guiGotoArgv(guiFamily, filePath, line)
    const detachedOpts: SpawnOptions = { detached: true, stdio: 'ignore' }
    let child
    if (process.platform === 'win32') {
      // win32 上 shell: true 以便 code.cmd / cursor.cmd / windsurf.cmd 解析 ——
      // CreateProcess 无法直接执行 .cmd/.bat。组装带引号的命令
      // 字符串；cmd.exe 在双引号内不展开 $() 或反引号。
      // 为每个参数加引号，使含空格的路径在 shell 拼接后存活。
      const gotoStr = gotoArgv.map(a => `"${a}"`).join(' ')
      child = spawn(`${editor} ${gotoStr}`, { ...detachedOpts, shell: true })
    } else {
      // POSIX：无 shell 的 argv 数组 —— 防注入。shell: true 会
      // 在双引号内展开 $() / 反引号，且 filePath 来自文件系统
      //（恶意仓库文件名可能导致 RCE）。
      child = spawn(base, [...editorArgs, ...gotoArgv], detachedOpts)
    }
    // spawn() 异步发出 ENOENT。$VISUAL/$EDITOR 上的 ENOENT 是
    // 用户配置错误，不是内部 bug —— 不要污染错误遥测。
    child.on('error', e =>
      logForDebugging(`editor spawn failed: ${e}`, { level: 'error' }),
    )
    child.unref()
    return true
  }

  // 终端编辑器 —— 需要 alt-screen 移交，因为它接管终端。
  // 阻塞直到编辑器退出。
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) return false
  // 仅为已知支持的编辑器前置 +N —— notepad 把 +42 当作
  // 要打开的文件名。测试 basename 以免 /home/vim/bin/kak
  // 通过目录段匹配 'vim'。
  const useGotoLine = line && PLUS_N_EDITORS.test(basename(base))
  inkInstance.enterAlternateScreen()
  try {
    const syncOpts: SpawnSyncOptions = { stdio: 'inherit' }
    let result
    if (process.platform === 'win32') {
      // Windows 上使用 shell: true 以便 cmd.exe 内置命令如 `start` 解析。
      // shell: true 不加引号拼接参数，因此用显式引号自行组装
      // 命令字符串（匹配 promptEditor.ts:74）。spawnSync
      // 将错误返回在 .error 中而非抛出。
      const lineArg = useGotoLine ? `+${line} ` : ''
      result = spawnSync(`${editor} ${lineArg}"${filePath}"`, {
        ...syncOpts,
        shell: true,
      })
    } else {
      // POSIX：直接 spawn（无 shell），argv 数组引号安全。
      const args = [
        ...editorArgs,
        ...(useGotoLine ? [`+${line}`, filePath] : [filePath]),
      ]
      result = spawnSync(base, args, syncOpts)
    }
    if (result.error) {
      logForDebugging(`editor spawn failed: ${result.error}`, {
        level: 'error',
      })
      return false
    }
    return true
  } finally {
    inkInstance.exitAlternateScreen()
  }
}

export const getExternalEditor = memoize((): string | undefined => {
  // 优先环境变量
  if (process.env.VISUAL?.trim()) {
    return process.env.VISUAL.trim()
  }

  if (process.env.EDITOR?.trim()) {
    return process.env.EDITOR.trim()
  }

  // `isCommandAvailable` 在 Windows 上会破坏 claude 进程的 stdin
  // 作为权宜之计，我们跳过它
  if (process.platform === 'win32') {
    return 'start /wait notepad'
  }

  // 按偏好顺序搜索可用编辑器
  const editors = ['code', 'vi', 'nano']
  return editors.find(command => isCommandAvailable(command))
})
