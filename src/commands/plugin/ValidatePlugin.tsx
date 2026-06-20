import figures from 'figures';
import * as React from 'react';
import { useEffect } from 'react';
import { Box, Text } from '@anthropic/ink';
import { errorMessage } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { validateManifest } from '../../utils/plugins/validatePlugin.js';
import { plural } from '../../utils/stringUtils.js';

type Props = {
  onComplete: (result?: string) => void;
  path?: string;
};

export function ValidatePlugin({ onComplete, path }: Props): React.ReactNode {
  useEffect(() => {
    async function runValidation() {
      // 如果未提供路径，显示用法
      if (!path) {
        onComplete(
          'Usage: /plugin validate <path>\n\n' +
            'Validate a plugin or marketplace manifest file or directory.\n\n' +
            'Examples:\n' +
            '  /plugin validate .claude-plugin/plugin.json\n' +
            '  /plugin validate /path/to/plugin-directory\n' +
            '  /plugin validate .\n\n' +
            'When given a directory, automatically validates .claude-plugin/marketplace.json\n' +
            'or .claude-plugin/plugin.json (prefers marketplace if both exist).\n\n' +
            'Or from the command line:\n' +
            '  claude plugin validate <path>',
        );
        return;
      }

      try {
        const result = await validateManifest(path);

        let output = '';

        // 添加头部
        output += `Validating ${result.fileType} manifest: ${result.filePath}\n\n`;

        // 显示错误
        if (result.errors.length > 0) {
          output += `${figures.cross} Found ${result.errors.length} ${plural(result.errors.length, 'error')}:\n\n`;

          result.errors.forEach(error => {
            output += `  ${figures.pointer} ${error.path}: ${error.message}\n`;
          });

          output += '\n';
        }

        // 显示警告
        if (result.warnings.length > 0) {
          output += `${figures.warning} Found ${result.warnings.length} ${plural(result.warnings.length, 'warning')}:\n\n`;

          result.warnings.forEach(warning => {
            output += `  ${figures.pointer} ${warning.path}: ${warning.message}\n`;
          });

          output += '\n';
        }

        // 显示成功或失败
        if (result.success) {
          if (result.warnings.length > 0) {
            output += `${figures.tick} Validation passed with warnings\n`;
          } else {
            output += `${figures.tick} Validation passed\n`;
          }

          // 以退出码 0 退出（成功）
          process.exitCode = 0;
        } else {
          output += `${figures.cross} Validation failed\n`;

          // 以退出码 1 退出（校验失败）
          process.exitCode = 1;
        }

        onComplete(output);
      } catch (error) {
        // 以退出码 2 退出（意外错误）
        process.exitCode = 2;

        logError(error);

        onComplete(`${figures.cross} Unexpected error during validation: ${errorMessage(error)}`);
      }
    }

    void runValidation();
  }, [onComplete, path]);

  return (
    <Box flexDirection="column">
      <Text>Running validation...</Text>
    </Box>
  );
}
