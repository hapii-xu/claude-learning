import { randomUUID } from 'crypto'
import { basename } from 'path'
import { useEffect, useMemo, useRef, useState } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { readFileSync } from 'src/utils/fileRead.js'
import { expandPath } from 'src/utils/path.js'
import type { PermissionOption } from '../components/permissions/FilePermissionDialog/permissionOptions.js'
import type {
  MCPServerConnection,
  McpSSEIDEServerConfig,
  McpWebSocketIDEServerConfig,
} from '../services/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import type { FileEdit } from '@claude-code-best/builtin-tools/tools/FileEditTool/types.js'
import {
  getEditsForPatch,
  getPatchForEdits,
} from '@claude-code-best/builtin-tools/tools/FileEditTool/utils.js'
import { getGlobalConfig } from '../utils/config.js'
import { getPatchFromContents } from '../utils/diff.js'
import { isENOENT } from '../utils/errors.js'
import {
  callIdeRpc,
  getConnectedIdeClient,
  getConnectedIdeName,
  hasAccessToIDEExtensionDiffFeature,
} from '../utils/ide.js'
import { WindowsToWSLConverter } from '../utils/idePathConversion.js'
import { logError } from '../utils/log.js'
import { getPlatform } from '../utils/platform.js'

type Props = {
  onChange(
    option: PermissionOption,
    input: {
      file_path: string
      edits: FileEdit[]
    },
  ): void
  toolUseContext: ToolUseContext
  filePath: string
  edits: FileEdit[]
  editMode: 'single' | 'multiple'
}

export function useDiffInIDE({
  onChange,
  toolUseContext,
  filePath,
  edits,
  editMode,
}: Props): {
  closeTabInIDE: () => void
  showingDiffInIDE: boolean
  ideName: string
  hasError: boolean
} {
  const isUnmounted = useRef(false)
  const [hasError, setHasError] = useState(false)

  const sha = useMemo(() => randomUUID().slice(0, 6), [])
  const tabName = useMemo(
    () => `✻ [Claude Code] ${basename(filePath)} (${sha}) ⧉`,
    [filePath, sha],
  )

  const shouldShowDiffInIDE =
    hasAccessToIDEExtensionDiffFeature(toolUseContext.options.mcpClients) &&
    getGlobalConfig().diffTool === 'auto' &&
    // Diff 应仅用于文件编辑。
    // 文件写入可能会走到这里但不支持 diff。
    !filePath.endsWith('.ipynb')

  const ideName =
    getConnectedIdeName(toolUseContext.options.mcpClients) ?? 'IDE'

  async function showDiff(): Promise<void> {
    if (!shouldShowDiffInIDE) {
      return
    }

    try {
      logEvent('tengu_ext_will_show_diff', {})

      const { oldContent, newContent } = await showDiffInIDE(
        filePath,
        edits,
        toolUseContext,
        tabName,
      )
      // 如果组件已卸载则跳过
      if (isUnmounted.current) {
        return
      }

      logEvent('tengu_ext_diff_accepted', {})

      const newEdits = computeEditsFromContents(
        filePath,
        oldContent,
        newContent,
        editMode,
      )

      if (newEdits.length === 0) {
        // 无更改 —— 编辑被拒绝（例如，已还原）
        logEvent('tengu_ext_diff_rejected', {})
        // 我们在这里关闭标签页，因为 'no' 不再自动关闭
        const ideClient = getConnectedIdeClient(
          toolUseContext.options.mcpClients,
        )
        if (ideClient) {
          // 在 IDE 中关闭标签页
          await closeTabInIDE(tabName, ideClient)
        }
        onChange(
          { type: 'reject' },
          {
            file_path: filePath,
            edits: edits,
          },
        )
        return
      }

      // 文件已修改 - 编辑被接受
      onChange(
        { type: 'accept-once' },
        {
          file_path: filePath,
          edits: newEdits,
        },
      )
    } catch (error) {
      logError(error as Error)
      setHasError(true)
    }
  }

  useEffect(() => {
    void showDiff()

    // 在卸载时设置标志
    return () => {
      isUnmounted.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    closeTabInIDE() {
      const ideClient = getConnectedIdeClient(toolUseContext.options.mcpClients)

      if (!ideClient) {
        return Promise.resolve()
      }

      return closeTabInIDE(tabName, ideClient)
    },
    showingDiffInIDE: shouldShowDiffInIDE && !hasError,
    ideName: ideName,
    hasError,
  }
}

/**
 * 从新旧内容重新计算编辑。这是必要的，
 * 以应用用户可能对新内容所做的任何编辑。
 */
export function computeEditsFromContents(
  filePath: string,
  oldContent: string,
  newContent: string,
  editMode: 'single' | 'multiple',
): FileEdit[] {
  // 使用未格式化的补丁，否则编辑将被格式化。
  const singleHunk = editMode === 'single'
  const patch = getPatchFromContents({
    filePath,
    oldContent,
    newContent,
    singleHunk,
  })

  if (patch.length === 0) {
    return []
  }

  // 对于单编辑模式，验证我们只得到一个块
  if (singleHunk && patch.length > 1) {
    logError(
      new Error(
        `Unexpected number of hunks: ${patch.length}. Expected 1 hunk.`,
      ),
    )
  }

  // 重新计算编辑以匹配补丁
  return getEditsForPatch(patch)
}

/**
 * 完成条件：
 *
 * 1. 标签页在 IDE 中被关闭
 * 2. 标签页在 IDE 中被保存（然后我们关闭标签页）
 * 3. 用户在 IDE 中选择了选项
 * 4. 用户在终端中选择了选项（或按了 esc）
 *
 * 以新文件内容解析。
 *
 * TODO: 在 5 分钟不活动后超时？
 * TODO: 当 IDE 退出时更新自动批准 UI
 * TODO: 当批准提示卸载时关闭 IDE 标签页
 */
async function showDiffInIDE(
  file_path: string,
  edits: FileEdit[],
  toolUseContext: ToolUseContext,
  tabName: string,
): Promise<{ oldContent: string; newContent: string }> {
  let isCleanedUp = false

  const oldFilePath = expandPath(file_path)
  let oldContent = ''
  try {
    oldContent = readFileSync(oldFilePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      throw e
    }
  }

  async function cleanup() {
    // 注意避免竞态条件，因为此
    // 函数可能从多个地方被调用。
    if (isCleanedUp) {
      return
    }
    isCleanedUp = true

    // 如果失败不要抛出
    try {
      await closeTabInIDE(tabName, ideClient)
    } catch (e) {
      logError(e as Error)
    }

    process.off('beforeExit', cleanup)
    toolUseContext.abortController.signal.removeEventListener('abort', cleanup)
  }

  // 如果用户按 esc 取消工具调用则清理 - 或在退出时清理
  toolUseContext.abortController.signal.addEventListener('abort', cleanup)
  process.on('beforeExit', cleanup)

  // 在 IDE 中打开 diff
  const ideClient = getConnectedIdeClient(toolUseContext.options.mcpClients)
  try {
    const { updatedFile } = getPatchForEdits({
      filePath: oldFilePath,
      fileContents: oldContent,
      edits,
    })

    if (!ideClient || ideClient.type !== 'connected') {
      throw new Error('IDE client not available')
    }
    let ideOldPath = oldFilePath

    // 仅当我们在 WSL 中且 IDE 在 Windows 上时才转换路径
    const ideRunningInWindows =
      (ideClient.config as McpSSEIDEServerConfig | McpWebSocketIDEServerConfig)
        .ideRunningInWindows === true
    if (
      getPlatform() === 'wsl' &&
      ideRunningInWindows &&
      process.env.WSL_DISTRO_NAME
    ) {
      const converter = new WindowsToWSLConverter(process.env.WSL_DISTRO_NAME)
      ideOldPath = converter.toIDEPath(oldFilePath)
    }

    const rpcResult = await callIdeRpc(
      'openDiff',
      {
        old_file_path: ideOldPath,
        new_file_path: ideOldPath,
        new_file_contents: updatedFile,
        tab_name: tabName,
      },
      ideClient,
    )

    // 将原始 RPC 结果转换为 ToolCallResponse 格式
    const data = Array.isArray(rpcResult) ? rpcResult : [rpcResult]

    // 如果用户保存了文件，则获取新内容并用其解析。
    if (isSaveMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: data[1].text,
      }
    } else if (isClosedMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: updatedFile,
      }
    } else if (isRejectedMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: oldContent,
      }
    }

    // 表示工具调用完成但没有预期的
    // 结果。用户是否关闭了 IDE？
    throw new Error('Not accepted')
  } catch (error) {
    logError(error as Error)
    void cleanup()
    throw error
  }
}

async function closeTabInIDE(
  tabName: string,
  ideClient?: MCPServerConnection | undefined,
): Promise<void> {
  try {
    if (!ideClient || ideClient.type !== 'connected') {
      throw new Error('IDE client not available')
    }

    // 使用直接 RPC 关闭标签页
    await callIdeRpc('close_tab', { tab_name: tabName }, ideClient)
  } catch (error) {
    logError(error as Error)
    // 不要抛出 - 这是清理操作
  }
}

function isClosedMessage(data: unknown): data is { text: 'TAB_CLOSED' } {
  return (
    Array.isArray(data) &&
    typeof data[0] === 'object' &&
    data[0] !== null &&
    'type' in data[0] &&
    data[0].type === 'text' &&
    'text' in data[0] &&
    data[0].text === 'TAB_CLOSED'
  )
}

function isRejectedMessage(data: unknown): data is { text: 'DIFF_REJECTED' } {
  return (
    Array.isArray(data) &&
    typeof data[0] === 'object' &&
    data[0] !== null &&
    'type' in data[0] &&
    data[0].type === 'text' &&
    'text' in data[0] &&
    data[0].text === 'DIFF_REJECTED'
  )
}

function isSaveMessage(
  data: unknown,
): data is [{ text: 'FILE_SAVED' }, { text: string }] {
  return (
    Array.isArray(data) &&
    data[0]?.type === 'text' &&
    data[0].text === 'FILE_SAVED' &&
    typeof data[1].text === 'string'
  )
}
