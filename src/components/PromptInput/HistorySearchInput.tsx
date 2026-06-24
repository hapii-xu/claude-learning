import * as React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import TextInput from '../TextInput.js';

type Props = {
  value: string;
  onChange: (value: string) => void;
  historyFailedMatch: boolean;
};

function HistorySearchInput({ value, onChange, historyFailedMatch }: Props): React.ReactNode {
  return (
    <Box gap={1}>
      <Text dimColor>{historyFailedMatch ? '未找到匹配的提示词：' : '搜索提示词：'}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        // 强制将光标定位到搜索输入框末尾，因为导航操作应当取消搜索
        cursorOffset={value.length}
        onChangeCursorOffset={() => {}}
        columns={stringWidth(value) + 1}
        focus={true}
        showCursor={true}
        multiline={false}
        dimColor={true}
      />
    </Box>
  );
}

export default HistorySearchInput;
