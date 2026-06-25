import React from 'react';
import { pathToFileURL } from 'url';
import { Link } from '@anthropic/ink';

type Props = {
  /** 绝对文件路径 */
  filePath: string;
  /** 可选的显示文本（默认为 filePath） */
  children?: React.ReactNode;
};

/**
 * 将文件路径渲染为 OSC 8 超链接。
 * 这有助于 iTerm 等终端正确识别文件路径，
 * 即便路径出现在括号或其他文本中也能识别。
 */
export function FilePathLink({ filePath, children }: Props): React.ReactNode {
  return <Link url={pathToFileURL(filePath).href}>{children ?? filePath}</Link>;
}
