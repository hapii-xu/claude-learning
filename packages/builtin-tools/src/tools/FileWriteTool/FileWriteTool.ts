import { dirname, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { diagnosticTracker } from 'src/services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from 'src/services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from 'src/services/lsp/manager.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from 'src/services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loadSkillsDir.js'
import type { ToolUseContext } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from 'src/utils/diff.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isENOENT } from 'src/utils/errors.js'
import { getFileModificationTime, writeTextContent } from 'src/utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/utils/fileHistory.js'
import { logFileOperation } from 'src/utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from 'src/utils/fileRead.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { fetchSingleFileGitDiff, type ToolUseDiff } from 'src/utils/gitDiff.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from 'src/utils/permissions/filesystem.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe('要写入的文件的绝对路径（必须为绝对路径，而非相对路径）'),
    content: z.string().describe('要写入文件的内容'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe('是创建了新文件还是更新了已有文件'),
    filePath: z.string().describe('被写入文件的路径'),
    content: z.string().describe('已写入文件的内容'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('展示变更内容的 Diff 补丁'),
    originalFile: z
      .string()
      .nullable()
      .describe('写入前的原始文件内容（新文件为 null）'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return '将文件写入本地文件系统。'
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `正在写入 ${summary}` : '正在写入文件'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx 中记载 file_path 必须为绝对路径；此处展开是为了避免
    // 通过 ~ 或相对路径绕过 hook 白名单。
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText() {
    // 记录渲染时会展示 content（create，通过 HighlightedCode）
    // 或结构化 diff（update）。启发式规则中的 'content' 白名单键
    // 即便在 update 模式（此时并不展示原始内容）也会索引原始内容字符串——
    // 属于幽灵索引。低估更稳妥：tool_use 已经索引了 file_path。
    return ''
  },
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)

    // 拒绝写入包含密钥的团队内存文件
    const secretError = checkTeamMemSecrets(fullFilePath, content)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // 根据权限设置检查路径是否应被忽略
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message: '该文件位于被您的权限设置拒绝访问的目录中。',
        errorCode: 1,
      }
    }

    // 安全：跳过对 UNC 路径的文件系统操作，以防止 NTLM 凭据泄漏。
    // 在 Windows 上，对 UNC 路径调用 fs.existsSync() 会触发 SMB 认证，
    // 可能把凭据泄漏给恶意服务器。交给权限检查来处理 UNC 路径。
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)

    // 复用上面 stat 得到的 mtime —— 避免通过 getFileModificationTime
    // 再做一次多余的 statSync。
    if (readTimestamp) {
      const lastWriteTime = Math.floor(fileMtimeMs)
      if (lastWriteTime > readTimestamp.timestamp) {
        return {
          result: false,
          message:
            '文件自读取后已被修改（由用户或 linter 等工具）。请先重新读取再尝试写入。',
          errorCode: 3,
        }
      }
    }

    return { result: true }
  },
  async call(
    { file_path, content },
    { readFileState, updateFileHistoryState, dynamicSkillDirTriggers },
    _,
    parentMessage,
  ) {
    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)

    // 从该文件路径发现 skills（fire-and-forget，非阻塞）
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // 存储已发现的目录用于附件展示
      for (const dir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(dir)
      }
      // 不 await —— 让 skill 在后台加载
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // 激活路径模式匹配该文件的条件性 skills
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    await diagnosticTracker.beforeFileEdited(fullFilePath)

    // 在原子化的“读取-修改-写入”区段之前，确保父目录已存在。
    // 必须停留在下方临界区之外（新鲜度检查与 writeTextContent 之间任何让步
    // 都会让并发编辑交错），并且要在写入之前完成（ENOENT 时的懒加载 mkdir
    // 会在 writeFileSyncAndFlush_DEPRECATED 内部触发一个虚假的
    // tengu_atomic_write_error，先于 ENOENT 传播回来）。
    await getFsImplementation().mkdir(dir)
    if (fileHistoryEnabled()) {
      // 备份捕获的是编辑前的内容 —— 在新鲜度检查之前调用是安全的
      // （v1 备份以内容哈希为键，幂等；若后续新鲜度校验失败，只是多出
      // 一个未使用的备份，并不会造成状态损坏）。
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullFilePath,
        parentMessage.uuid,
      )
    }

    // 加载当前状态并确认自上次读取后未发生变更。
    // 请避免从这里到写入磁盘之间执行任何异步操作，以保持原子性。
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        meta = null
      } else {
        throw e
      }
    }

    if (meta !== null) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // 时间戳表明文件已被修改，但在 Windows 上即便内容未变时间戳也可能变化
        // （云同步、杀毒软件等）。对于完整读取，使用内容比对作为兜底，
        // 以避免误报。
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        // meta.content 已经过 CRLF 归一化 —— 与 readFileState 的归一化形式一致。
        if (!isFullRead || meta.content !== lastRead.content) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    const enc = meta?.encoding ?? 'utf8'
    const oldContent = meta?.content ?? null

    // 写入是整内容替换 —— 模型在 `content` 中发送了明确的换行符，
    // 且本意如此。不要改写它们。过去我们会保留旧文件的换行符
    // （或对新文件用 ripgrep 采样仓库的换行风格），结果会在覆盖 CRLF 文件、
    // 或 cwd 中的二进制文件污染了仓库样本时，静默破坏 Linux 上的
    // bash 脚本（混入 \r）。
    writeTextContent(fullFilePath, content, enc, 'LF')

    // 通知 LSP 服务器文件已修改（didChange）和已保存（didSave）
    const lspManager = getLspServerManager()
    if (lspManager) {
      // 清除此前已投递的诊断，以便展示新的诊断
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // didChange：内容已被修改
      lspManager.changeFile(fullFilePath, content).catch((err: Error) => {
        logForDebugging(
          `LSP：通知服务器文件变更失败 ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
      // didSave：文件已保存到磁盘（在 TypeScript 服务器中触发诊断）
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP：通知服务器文件保存失败 ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // 通知 VSCode 文件已变更，用于 diff 视图
    notifyVscodeFileUpdated(fullFilePath, oldContent, content)

    // 更新读取时间戳，以使陈旧写入失效
    readFileState.set(fullFilePath, {
      content,
      timestamp: getFileModificationTime(fullFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 写入 CLAUDE.md 时记录日志
    if (fullFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }

    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(fullFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isWriteTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    if (oldContent) {
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: content,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content,
        structuredPatch: patch,
        originalFile: oldContent,
        ...(gitDiff && { gitDiff }),
      }
      // 在返回结果之前，统计文件更新中新增与删除的行数
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    const data = {
      type: 'create' as const,
      filePath: file_path,
      content,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff && { gitDiff }),
    }

    // 对于新文件创建，在返回结果之前，将所有行统计为新增行
    countLinesChanged([], content)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam({ filePath, type }, toolUseID) {
    switch (type) {
      case 'create':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `文件已在以下路径成功创建：${filePath}`,
        }
      case 'update':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `文件 ${filePath} 已成功更新。`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
