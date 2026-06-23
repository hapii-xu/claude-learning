import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { countCharInString } from 'src/utils/stringUtils.js'
import {
  DIFF_TIMEOUT_MS,
  getPatchForDisplay,
  getPatchFromContents,
} from 'src/utils/diff.js'
import { errorMessage, isENOENT } from 'src/utils/errors.js'
import {
  addLineNumbers,
  convertLeadingTabsToSpaces,
  readFileSyncCached,
} from 'src/utils/file.js'
import type { EditInput, FileEdit } from './types.js'

/**
 * 去除字符串中每一行末尾的空白字符，同时保留行尾符
 * @param str 要处理的字符串
 * @returns 每行末尾空白已去除的字符串
 */
export function stripTrailingWhitespace(str: string): string {
  // 处理不同的行尾符：CRLF、LF、CR
  // 使用正则表达式匹配并捕获行尾符
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        // 偶数索引为行内容
        result += part.replace(/\s+$/, '')
      } else {
        // 奇数索引为行尾符
        result += part
      }
    }
  }

  return result
}

/**
 * 在文件内容中查找精确字符串。
 *
 * @param fileContent 要搜索的文件内容
 * @param searchString 要搜索的字符串
 * @returns 找到则返回该字符串，否则返回 null
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }
  return null
}

/**
 * 对文件应用编辑并返回更新后的内容。
 * replace_all 为可选项，默认为 false。
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * 对文件应用单个编辑，返回补丁和更新后的文件内容。
 * 不会将文件写入磁盘。
 */
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll = false,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
  })
}

/**
 * 对文件依次应用一组编辑，返回补丁和更新后的文件内容。
 * 不会将文件写入磁盘。
 *
 * 注意：返回的补丁仅用于展示，其中使用空格而非制表符。
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  let updatedFile = fileContents
  const appliedNewStrings: string[] = []

  // 空文件的特殊处理。
  if (
    !fileContents &&
    edits.length === 1 &&
    edits[0] &&
    edits[0].old_string === '' &&
    edits[0].new_string === ''
  ) {
    const patch = getPatchForDisplay({
      filePath,
      fileContents,
      edits: [
        {
          old_string: fileContents,
          new_string: updatedFile,
          replace_all: false,
        },
      ],
    })
    return { patch, updatedFile: '' }
  }

  // 依次应用每个编辑并检查文件是否实际发生了变化
  for (const edit of edits) {
    // 检查前先去掉 old_string 末尾的换行
    const oldStringToCheck = edit.old_string.replace(/\n+$/, '')

    // 检查 old_string 是否是之前某个 new_string 的子串
    for (const previousNewString of appliedNewStrings) {
      if (
        oldStringToCheck !== '' &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          'Cannot edit file: old_string is a substring of a new_string from a previous edit.',
        )
      }
    }

    const previousContent = updatedFile
    updatedFile =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )

    // 如果此次编辑未产生任何变化，则抛出错误
    if (updatedFile === previousContent) {
      throw new Error('String not found in file. Failed to apply edit.')
    }

    // 记录已应用的 new_string
    appliedNewStrings.push(edit.new_string)
  }

  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

  // 已有前后内容，直接调用 getPatchFromContents 而非走 getPatchForDisplay。
  // 原来的路径会对 fileContents 做两次变换（preparedFileContents 和 reduce 内的
  // escapedOldString），还会执行一次无效的全内容 .replace()。对大文件可节省约 20%。
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })

  return { patch, updatedFile }
}

// edited_text_file 附件摘要的大小上限。格式化保存大文件时曾每轮注入整个文件
//（实测最大 16.1KB，约 14K tokens/session）。8KB 在保留有意义上下文的同时
// 控制了最坏情况下的开销。
const DIFF_SNIPPET_MAX_BYTES = 8192

/**
 * 用于附件，在文件发生变化时展示摘要片段。
 *
 * TODO: 与其他摘要逻辑统一。
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    {
      context: 8,
      timeout: DIFF_TIMEOUT_MS,
    },
  )

  if (!patch) {
    return ''
  }

  const full = patch.hunks
    .map(_ => ({
      startLine: _.oldStart,
      content: _.lines
        // 过滤掉已删除行和 diff 元数据行
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
        .map(_ => _.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // 在不超过上限的最后一个行边界处截断。
  // 标记格式与 BashTool/utils.ts 保持一致。
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

const CONTEXT_LINES = 4

/**
 * 获取文件中围绕补丁位置的上下文片段（带行号）。
 * @param patch 用于确定片段位置的 diff hunks
 * @param newFile 应用补丁后的文件内容
 * @returns 带行号的片段文本及起始行号
 */
export function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): { formattedSnippet: string; startLine: number } {
  if (patch.length === 0) {
    // 没有变化，返回空片段
    return { formattedSnippet: '', startLine: 1 }
  }

  // 找出所有 hunks 中第一行和最后一行的变更位置
  let minLine = Infinity
  let maxLine = -Infinity

  for (const hunk of patch) {
    if (hunk.oldStart < minLine) {
      minLine = hunk.oldStart
    }
    // 末行需考虑 newLines 数量，因为我们展示的是新文件
    const hunkEnd = hunk.oldStart + (hunk.newLines || 0) - 1
    if (hunkEnd > maxLine) {
      maxLine = hunkEnd
    }
  }

  // 计算带上下文的范围
  const startLine = Math.max(1, minLine - CONTEXT_LINES)
  const endLine = maxLine + CONTEXT_LINES

  // 将新文件按行分割并获取片段
  const fileLines = newFile.split(/\r?\n/)
  const snippetLines = fileLines.slice(startLine - 1, endLine)
  const snippet = snippetLines.join('\n')

  // 添加行号
  const formattedSnippet = addLineNumbers({
    content: snippet,
    startLine,
  })

  return { formattedSnippet, startLine }
}

/**
 * 获取围绕单次编辑位置的上下文片段（带行号）。
 * 便捷函数，使用原始算法实现。
 * @param originalFile 原始文件内容
 * @param oldString 被替换的文本
 * @param newString 替换后的文本
 * @param contextLines 变更前后各显示的行数
 * @returns 片段内容及起始行号
 */
export function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines: number = 4,
): { snippet: string; startLine: number } {
  // 使用 FileEditTool.tsx 中的原始算法
  const before = originalFile.split(oldString)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = applyEditToFile(
    originalFile,
    oldString,
    newString,
  ).split(/\r?\n/)

  // 计算片段的起始和结束行号
  const startLine = Math.max(0, replacementLine - contextLines)
  const endLine =
    replacementLine + contextLines + newString.split(/\r?\n/).length

  // 获取片段
  const snippetLines = newFileLines.slice(startLine, endLine)
  const snippet = snippetLines.join('\n')

  return { snippet, startLine: startLine + 1 }
}

export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
  return patch.map(hunk => {
    // 提取此 hunk 中的变更内容
    const contextLines: string[] = []
    const oldLines: string[] = []
    const newLines: string[] = []

    // 解析每一行并按类型分类
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // 上下文行 —— 在新旧版本中均存在
        contextLines.push(line.slice(1))
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        // 已删除行 —— 仅在旧版本中存在
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        // 新增行 —— 仅在新版本中存在
        newLines.push(line.slice(1))
      }
    }

    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

/**
 * 用于对 Claude 输出的字符串进行反转义的替换映射。
 * 由于 Claude 看不到这些字符串（API 侧已做转义），
 * 它会在编辑响应中输出转义后的版本。
 */
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

/**
 * 通过应用特定替换规则对匹配字符串进行规范化。
 * 用于处理因格式差异导致精确匹配失败的情况。
 * @returns 规范化后的字符串以及已应用的替换列表
 */
function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)

    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

/**
 * 规范化 FileEditTool 的输入。
 * 若在文件中找不到要替换的字符串，则尝试使用规范化版本。
 * 规范化成功则返回规范化后的输入，否则返回原始输入。
 */
export function normalizeFileEditInput({
  file_path,
  edits,
}: {
  file_path: string
  edits: EditInput[]
}): {
  file_path: string
  edits: EditInput[]
} {
  if (edits.length === 0) {
    return { file_path, edits }
  }

  // Markdown 用两个尾部空格表示强制换行，去除会静默改变语义。
  // 对 .md/.mdx 文件跳过 stripTrailingWhitespace。
  const isMarkdown = /\.(md|mdx)$/i.test(file_path)

  try {
    const fullPath = expandPath(file_path)

    // 使用缓存文件读取以避免重复 I/O。
    // 若文件不存在，readFileSyncCached 会抛出 ENOENT，
    // 由下方的 catch 处理并返回原始输入（无 TOCTOU 预检查）。
    const fileContent = readFileSyncCached(fullPath)

    return {
      file_path,
      edits: edits.map(({ old_string, new_string, replace_all }) => {
        const normalizedNewString = isMarkdown
          ? new_string
          : stripTrailingWhitespace(new_string)

        // 精确字符串匹配成功则保持原样
        if (fileContent.includes(old_string)) {
          return {
            old_string,
            new_string: normalizedNewString,
            replace_all,
          }
        }

        // 精确匹配失败则尝试反转义
        const { result: desanitizedOldString, appliedReplacements } =
          desanitizeMatchString(old_string)

        if (fileContent.includes(desanitizedOldString)) {
          // 对 new_string 应用相同的替换规则
          let desanitizedNewString = normalizedNewString
          for (const { from, to } of appliedReplacements) {
            desanitizedNewString = desanitizedNewString.replaceAll(from, to)
          }

          return {
            old_string: desanitizedOldString,
            new_string: desanitizedNewString,
            replace_all,
          }
        }

        return {
          old_string,
          new_string: normalizedNewString,
          replace_all,
        }
      }),
    }
  } catch (error) {
    // 读取文件出错时直接返回原始输入。
    // ENOENT 是预期情况（如文件尚不存在，即新文件）。
    if (!isENOENT(error)) {
      logError(error)
    }
  }

  return { file_path, edits }
}

/**
 * 通过将两组编辑分别应用到原始内容并比较结果，判断它们是否等效。
 * 用于处理编辑形式不同但最终结果相同的情况。
 */
export function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
  // 快速路径：检查两组编辑是否字面量完全相同
  if (
    edits1.length === edits2.length &&
    edits1.every((edit1, index) => {
      const edit2 = edits2[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // 尝试分别应用两组编辑
  let result1: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error1: string | null = null
  let result2: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error2: string | null = null

  try {
    result1 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits1,
    })
  } catch (e) {
    error1 = errorMessage(e)
  }

  try {
    result2 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits2,
    })
  } catch (e) {
    error2 = errorMessage(e)
  }

  // 两者均抛出错误时，仅当错误信息相同才视为等效
  if (error1 !== null && error2 !== null) {
    // 规范化错误信息后再比较
    return error1 === error2
  }

  // 一个成功一个失败，不等效
  if (error1 !== null || error2 !== null) {
    return false
  }

  // 两者均成功 —— 比较结果
  return result1!.updatedFile === result2!.updatedFile
}

/**
 * 统一检查两个文件编辑输入是否等效。
 * 处理文件编辑（FileEditTool）场景。
 */
export function areFileEditsInputsEquivalent(
  input1: {
    file_path: string
    edits: FileEdit[]
  },
  input2: {
    file_path: string
    edits: FileEdit[]
  },
): boolean {
  // 快速路径：文件不同
  if (input1.file_path !== input2.file_path) {
    return false
  }

  // 快速路径：字面量完全相同
  if (
    input1.edits.length === input2.edits.length &&
    input1.edits.every((edit1, index) => {
      const edit2 = input2.edits[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // 语义比较（需要读取文件）。若文件不存在，
  // 则与空内容比较（无 TOCTOU 预检查）。
  let fileContent = ''
  try {
    fileContent = readFileSyncCached(input1.file_path)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }

  return areFileEditsEquivalent(input1.edits, input2.edits, fileContent)
}
