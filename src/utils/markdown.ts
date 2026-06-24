import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '@anthropic/ink'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth, supportsHyperlinks } from '@anthropic/ink'
import { createHyperlink } from '../utils/hyperlink.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'

import { stripPromptXMLTags } from './messages.js'
import type { ThemeName } from './theme.js'

// 无条件使用 \n——在 Windows 上 os.EOL 是 \r\n，多出的 \r 会破坏
// applyStylesToWrappedText 中的字符到分段映射，导致样式文本向右偏移。
const EOL = '\n'

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  // 禁用删除线解析——模型经常用 ~ 表示"约"（如 ~100），
  // 很少真正意图使用删除线格式
  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
    },
  })
}

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(_ => formatToken(_, theme, 0, null, null, highlight))
    .join('')
    .trim()
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // 为每行添加暗色竖线前缀。保持文字斜体但正常亮度——
      // chalk.dim 在深色主题下几乎不可见。
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map(line =>
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line,
        )
        .join(EOL)
    }
    case 'code': {
      if (!highlight) {
        return token.text + EOL
      }
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      return highlight.highlight(token.text, { language }) + EOL
    }
    case 'codespan': {
      // 行内代码
      return color('permission', theme)(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1: // 一级标题
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // 二级标题
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // 三级及以下标题
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'hr':
      return '---'
    case 'image':
      return token.href
    case 'link': {
      // 防止 mailto 链接显示为可点击链接
      if (token.href.startsWith('mailto:')) {
        // 从 mailto: 链接中提取邮箱地址，以纯文本显示
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // 从链接的子 token 中提取显示文本
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // 如果链接有有意义的显示文本（与 URL 不同），
      // 则以可点击的超链接形式展示。支持 OSC 8 的终端中，
      // 用户可以看到文本并悬停/点击查看 URL。
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // 当显示文本与 URL 相同（或为空）时，直接显示 URL
      return createHyperlink(token.href)
    }
    case 'list': {
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            token.ordered ? token.start + index : null,
            token,
            highlight,
          ),
        )
        .join('')
    }
    case 'list_item':
      return (token.tokens ?? [])
        .map(
          _ =>
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, token, highlight)}`,
        )
        .join('')
    case 'paragraph':
      return (
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, null, highlight))
          .join('') + EOL
      )
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // 已在 markdown 链接内部——链接处理器会将此文本包裹为 OSC 8 超链接。
        // 在此处再次链接化会嵌套第二个 OSC 8 序列，而终端会优先使用
        // 最内层的，从而覆盖链接的实际 href。
        return token.text
      }
      if (parent?.type === 'list_item') {
        return `${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} ${token.tokens ? token.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`
      }
      return linkifyIssueReferences(token.text)
    case 'table': {
      const tableToken = token as Tokens.Table

      // 获取实际显示文本（经 stripAnsi 处理后）的辅助函数
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? '',
        )
      }

      // 根据显示内容（不含格式符）确定列宽
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3) // 最小宽度为 3
      })

      // 格式化表头行
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput +=
          padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // 添加分隔行
      tableOutput += '|'
      columnWidths.forEach(width => {
        // 始终使用短横线，不在输出中显示对齐冒号
        const separator = '-'.repeat(width + 2) // +2 是每侧的空格
        tableOutput += separator + '|'
      })
      tableOutput += EOL

      // 格式化数据行
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens
              ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
              .join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput +=
            padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown 转义：\) → ), \\ → \，等
      return token.text
    case 'def':
    case 'del':
    case 'html':
      // 这些 token 类型不进行渲染
      return ''
  }
  return ''
}

// 匹配 owner/repo#NNN 格式的 GitHub issue/PR 引用。限定格式是无歧义的——
// 裸 #NNN 已被移除，因为它会猜测当前仓库，当 assistant 讨论其他仓库时会出错。
// owner 段不允许点号（GitHub 用户名仅含字母数字和连字符），
// 防止 docs.github.io/guide#42 等主机名产生误匹配。repo 段允许点号
//（如 cc.kurs.web）。避免使用 lookbehind——它会阻碍 JSC 中的 YARR JIT。
const ISSUE_REF_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * 将 owner/repo#123 引用替换为指向 GitHub 的可点击超链接。
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${num}`,
        `${repo}#${num}`,
      ),
  )
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

/**
 * 根据对齐方式将 `content` 填充至 `targetWidth`。`displayWidth` 是
 * `content` 的可见宽度（调用方计算，如对 stripAnsi 后的文本用 stringWidth，
 * 使 `content` 中的 ANSI 码不影响填充）。
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
