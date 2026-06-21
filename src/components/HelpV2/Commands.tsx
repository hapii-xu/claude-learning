import * as React from 'react';
import { useMemo } from 'react';
import { type Command, formatDescriptionWithSource } from '../../commands.js';
import { truncate } from '../../utils/truncate.js';
import { Box, Text, useTabHeaderFocus } from '@anthropic/ink';
import { Select } from '../CustomSelect/select.js';

type Props = {
  commands: Command[];
  maxHeight: number;
  columns: number;
  title: string;
  onCancel: () => void;
  emptyMessage?: string;
};

export function Commands({ commands, maxHeight, columns, title, onCancel, emptyMessage }: Props): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const maxWidth = Math.max(1, columns - 10);
  const visibleCount = Math.max(1, Math.floor((maxHeight - 10) / 2));

  const options = useMemo(() => {
    // 自定义命令可能出现多次（例如同名命令位于 user 和 project scope）。
    // 按 name 去重以避免 Select 中 React key 冲突。
    const seen = new Set<string>();
    return commands
      .filter(cmd => {
        if (seen.has(cmd.name)) return false;
        seen.add(cmd.name);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cmd => ({
        label: `/${cmd.name}`,
        value: cmd.name,
        description: truncate(formatDescriptionWithSource(cmd), maxWidth, true),
      }));
  }, [commands, maxWidth]);

  return (
    <Box flexDirection="column" paddingY={1}>
      {commands.length === 0 && emptyMessage ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        <>
          <Text>{title}</Text>
          <Box marginTop={1}>
            <Select
              options={options}
              visibleOptionCount={visibleCount}
              onCancel={onCancel}
              disableSelection
              hideIndexes
              layout="compact-vertical"
              onUpFromFirstItem={focusHeader}
              isDisabled={headerFocused}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
