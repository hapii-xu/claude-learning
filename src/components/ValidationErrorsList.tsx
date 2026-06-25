import setWith from 'lodash-es/setWith.js';
import * as React from 'react';
import { Box, Text, useTheme } from '@anthropic/ink';
import type { ValidationError } from '../utils/settings/validation.js';
import { type TreeNode, treeify } from '../utils/treeify.js';

/**
 * 从点分路径构建嵌套树结构
 * 使用 lodash setWith 以避免自动创建数组
 */
function buildNestedTree(errors: ValidationError[]): TreeNode {
  const tree: TreeNode = {};

  errors.forEach(error => {
    if (!error.path) {
      // 根级错误 —— 用空字符串作为 key
      tree[''] = error.message;
      return;
    }

    // 尝试用有意义的值增强路径
    const pathParts = error.path.split('.');
    let modifiedPath = error.path;

    // 如果有无效值，尝试让路径更易读
    if (error.invalidValue !== null && error.invalidValue !== undefined && pathParts.length > 0) {
      const newPathParts: string[] = [];

      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (!part) continue;

        const numericPart = parseInt(part, 10);

        // 如果这是一个数字索引，且是我们拥有无效值的最后一部分
        if (!isNaN(numericPart) && i === pathParts.length - 1) {
          // 格式化用于显示的值
          let displayValue: string;
          if (typeof error.invalidValue === 'string') {
            displayValue = `"${error.invalidValue}"`;
          } else if (error.invalidValue === null) {
            displayValue = 'null';
          } else if (error.invalidValue === undefined) {
            displayValue = 'undefined';
          } else {
            displayValue = String(error.invalidValue);
          }

          newPathParts.push(displayValue);
        } else {
          // 其他部分保持不变
          newPathParts.push(part);
        }
      }

      modifiedPath = newPathParts.join('.');
    }

    setWith(tree, modifiedPath, error.message, Object);
  });

  return tree;
}

/**
 * 使用 treeify 对校验错误分组并显示，同时去重
 */
export function ValidationErrorsList({ errors }: { errors: ValidationError[] }): React.ReactNode {
  const [themeName] = useTheme();

  if (errors.length === 0) {
    return null;
  }

  // 按文件分组错误
  const errorsByFile = errors.reduce<Record<string, ValidationError[]>>((acc, error) => {
    const file = error.file || '（未指定文件）';
    if (!acc[file]) {
      acc[file] = [];
    }
    acc[file]!.push(error);
    return acc;
  }, {});

  // 按字母顺序对文件排序
  const sortedFiles = Object.keys(errorsByFile).sort();

  return (
    <Box flexDirection="column">
      {sortedFiles.map(file => {
        const fileErrors = errorsByFile[file] || [];

        // 按路径排序错误
        fileErrors.sort((a, b) => {
          if (!a.path && b.path) return -1;
          if (a.path && !b.path) return 1;
          return (a.path || '').localeCompare(b.path || '');
        });

        // 从错误路径构建嵌套树结构
        const errorTree = buildNestedTree(fileErrors);

        // 收集去重后的 suggestion+docLink 配对
        const suggestionPairs = new Map<string, { suggestion?: string; docLink?: string }>();

        fileErrors.forEach(error => {
          if (error.suggestion || error.docLink) {
            // 从 suggestion+docLink 组合创建一个 key
            const key = `${error.suggestion || ''}|${error.docLink || ''}`;
            if (!suggestionPairs.has(key)) {
              suggestionPairs.set(key, {
                suggestion: error.suggestion,
                docLink: error.docLink,
              });
            }
          }
        });

        // 渲染树
        const treeOutput = treeify(errorTree, {
          showValues: true,
          themeName,
          treeCharColors: {
            treeChar: 'inactive',
            key: 'text',
            value: 'inactive',
          },
        });

        return (
          <Box key={file} flexDirection="column">
            <Text>{file}</Text>
            <Box marginLeft={1}>
              <Text dimColor>{treeOutput}</Text>
            </Box>
            {/* 显示去重后的 suggestion+docLink 配对 */}
            {suggestionPairs.size > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {Array.from(suggestionPairs.values()).map((pair, index) => (
                  <Box key={`suggestion-pair-${index}`} flexDirection="column" marginBottom={1}>
                    {pair.suggestion && (
                      <Text dimColor wrap="wrap">
                        {pair.suggestion}
                      </Text>
                    )}
                    {pair.docLink && (
                      <Text dimColor wrap="wrap">
                        了解更多：{pair.docLink}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
