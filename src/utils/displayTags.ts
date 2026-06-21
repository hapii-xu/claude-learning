/**
 * 匹配任何 XML 风格的 `<tag>…</tag>` 块（小写标签名，可选属性，
 * 多行内容）。用于从显示标题中剥离系统注入的包装标签 ——
 * IDE 上下文、斜杠命令标记、hook 输出、任务通知、频道消息等。
 * 通用模式避免了维护不断增长且总落后的白名单。
 *
 * 仅匹配小写标签名（`[a-z][\w-]*`），因此用户提及 JSX/HTML
 * 组件的散文（"fix the <Button> layout"、"<!DOCTYPE html>"）会通过 ——
 * 它们以大写或 `!` 开头。非贪婪主体配合反向引用闭合标签
 * 保持相邻块分离；未成对的尖括号（"when x < y"）不会匹配。
 */
const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 从文本中剥离 XML 风格的标签块，用于 UI 标题
 * （/rewind、/resume、bridge 会话标题）。系统注入的上下文 ——
 * IDE 元数据、hook 输出、任务通知 —— 以标签包装形式到达，
 * 不应作为标题显示。
 *
 * 若剥离后结果为空文本，返回原始未变更文本
 * （显示某些内容总比什么都不显示好）。
 */
export function stripDisplayTags(text: string): string {
  const result = text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
  return result || text
}

/**
 * 与 stripDisplayTags 类似，但当所有内容都是标签时返回空字符串。
 * 由 getLogDisplayTitle 使用以检测纯命令提示（如 /clear），
 * 使其能够降级到下一个标题回退方案；也由 extractTitleText 使用
 * 以在 bridge 标题推导期间跳过纯 XML 消息。
 */
export function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

const IDE_CONTEXT_TAGS_PATTERN =
  /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 仅剥离 IDE 注入的上下文标签（ide_opened_file、ide_selection）。
 * 由 textForResubmit 使用，使上键重新提交保留用户输入的内容
 * 包括小写 HTML 如 `<code>foo</code>`，同时丢弃 IDE 噪音。
 */
export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
