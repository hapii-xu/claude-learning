import * as React from 'react';
import { useCallback } from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '@anthropic/ink';
import type { ToolPermissionContext } from '../../../Tool.js';
import { applyPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  directoryPath: string;
  onRemove: () => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  setPermissionContext: (context: ToolPermissionContext) => void;
};

export function RemoveWorkspaceDirectory({
  directoryPath,
  onRemove,
  onCancel,
  permissionContext,
  setPermissionContext,
}: Props): React.ReactNode {
  const handleRemove = useCallback(() => {
    const updatedContext = applyPermissionUpdate(permissionContext, {
      type: 'removeDirectories',
      directories: [directoryPath],
      destination: 'session',
    });

    setPermissionContext(updatedContext);
    onRemove();
  }, [directoryPath, permissionContext, setPermissionContext, onRemove]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'yes') {
        handleRemove();
      } else {
        onCancel();
      }
    },
    [handleRemove, onCancel],
  );

  return (
    <Dialog title="从工作区移除目录？" onCancel={onCancel} color="error">
      <Box marginX={2} flexDirection="column">
        <Text bold>{directoryPath}</Text>
      </Box>
      <Text>Claude Code 将不再能访问此目录中的文件。</Text>
      <Select
        onChange={handleSelect}
        onCancel={onCancel}
        options={[
          { label: '是', value: 'yes' },
          { label: '否', value: 'no' },
        ]}
      />
    </Dialog>
  );
}
