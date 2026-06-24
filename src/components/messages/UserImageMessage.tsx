import * as React from 'react';
import { pathToFileURL } from 'url';
import { Box, Link, supportsHyperlinks, Text } from '@anthropic/ink';
import { getStoredImagePath } from '../../utils/imageStore.js';
import { MessageResponse } from '../MessageResponse.js';

type Props = {
  imageId?: number;
  addMargin?: boolean;
};

/**
 * 在用户消息中渲染图片附件。
 * 如果图片已存储且终端支持超链接，则显示为可点击链接。
 * 使用 MessageResponse 样式以呈现为与上方消息相连的效果，
 * 除非 addMargin 为 true（图片在没有文本的情况下开始新的用户 turn）。
 */
export function UserImageMessage({ imageId, addMargin }: Props): React.ReactNode {
  const label = imageId ? `[图片 #${imageId}]` : '[图片]';
  const imagePath = imageId ? getStoredImagePath(imageId) : null;

  const content =
    imagePath && supportsHyperlinks() ? (
      <Link url={pathToFileURL(imagePath).href}>
        <Text>{label}</Text>
      </Link>
    ) : (
      <Text>{label}</Text>
    );

  // 当此图片开始新的用户 turn（其前面没有文本）时，
  // 显示 margin 而不是相连的 line 样式
  if (addMargin) {
    return <Box marginTop={1}>{content}</Box>;
  }

  return <MessageResponse>{content}</MessageResponse>;
}
