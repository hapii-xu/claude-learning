import * as React from 'react';
import { pathToFileURL } from 'url';
import { Link, supportsHyperlinks, Text } from '@anthropic/ink';
import { getStoredImagePath } from '../utils/imageStore.js';
import type { Theme } from '../utils/theme.js';

type Props = {
  imageId: number;
  backgroundColor?: keyof Theme;
  isSelected?: boolean;
};

/**
 * 渲染像 [Image #1] 这样的图片引用为可点击链接。
 * 点击时在默认查看器中打开存储的图片文件。
 *
 * 在以下情况下回退为带样式的文本：
 * - 终端不支持超链接
 * - 存储中找不到图片文件
 */
export function ClickableImageRef({ imageId, backgroundColor, isSelected = false }: Props): React.ReactNode {
  const imagePath = getStoredImagePath(imageId);
  const displayText = `[Image #${imageId}]`;

  // 如果有存储的图片且终端支持超链接，则使其可点击
  if (imagePath && supportsHyperlinks()) {
    const fileUrl = pathToFileURL(imagePath).href;

    return (
      <Link
        url={fileUrl}
        fallback={
          <Text backgroundColor={backgroundColor} inverse={isSelected}>
            {displayText}
          </Text>
        }
      >
        <Text backgroundColor={backgroundColor} inverse={isSelected} bold={isSelected}>
          {displayText}
        </Text>
      </Link>
    );
  }

  // 回退方案：有样式但不可点击
  return (
    <Text backgroundColor={backgroundColor} inverse={isSelected}>
      {displayText}
    </Text>
  );
}
