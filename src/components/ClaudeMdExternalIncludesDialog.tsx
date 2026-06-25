import React, { useCallback } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Dialog, Link, Text } from '@anthropic/ink';
import type { ExternalClaudeMdInclude } from '../utils/claudemd.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';

type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalClaudeMdInclude[];
};

export function ClaudeMdExternalIncludesDialog({
  onDone,
  isStandaloneDialog,
  externalIncludes,
}: Props): React.ReactNode {
  React.useEffect(() => {
    // 记录对话框显示事件
    logEvent('tengu_claude_md_includes_dialog_shown', {});
  }, []);

  const handleSelection = useCallback(
    (value: 'yes' | 'no') => {
      if (value === 'no') {
        logEvent('tengu_claude_md_external_includes_dialog_declined', {});
        // 标记已展示过对话框但用户拒绝了
        saveCurrentProjectConfig(current => ({
          ...current,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: true,
        }));
      } else {
        logEvent('tengu_claude_md_external_includes_dialog_accepted', {});
        saveCurrentProjectConfig(current => ({
          ...current,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        }));
      }

      onDone();
    },
    [onDone],
  );

  const handleEscape = useCallback(() => {
    handleSelection('no');
  }, [handleSelection]);

  return (
    <Dialog
      title="是否允许导入外部 CLAUDE.md 文件？"
      color="warning"
      onCancel={handleEscape}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      <Text>本项目的 CLAUDE.md 导入了当前工作目录之外的文件。对于第三方仓库，切勿允许此操作。</Text>

      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>外部导入：</Text>
          {externalIncludes.map((include, i) => (
            <Text key={i} dimColor>
              {'  '}
              {include.path}
            </Text>
          ))}
        </Box>
      )}

      <Text dimColor>
        重要提示：仅对您信任的文件使用 Claude Code。访问不受信任的文件可能存在安全风险{' '}
        <Link url="https://code.claude.com/docs/en/security" />{' '}
      </Text>

      <Select
        options={[
          { label: '是，允许外部导入', value: 'yes' },
          { label: '否，禁用外部导入', value: 'no' },
        ]}
        onChange={value => handleSelection(value as 'yes' | 'no')}
      />
    </Dialog>
  );
}
