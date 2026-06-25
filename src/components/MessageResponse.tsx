import * as React from 'react';
import { useContext } from 'react';
import { Box, NoSelect, Text, Ratchet } from '@anthropic/ink';

type Props = {
  children: React.ReactNode;
  height?: number;
};

export function MessageResponse({ children, height }: Props): React.ReactNode {
  const isMessageResponse = useContext(MessageResponseContext);
  if (isMessageResponse) {
    return children;
  }
  const content = (
    <MessageResponseProvider>
      <Box flexDirection="row" height={height} overflowY="hidden">
        <NoSelect fromLeftEdge flexShrink={0}>
          <Text dimColor>{'  '}⎿ &nbsp;</Text>
        </NoSelect>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    </MessageResponseProvider>
  );
  if (height !== undefined) {
    return content;
  }
  return <Ratchet lock="offscreen">{content}</Ratchet>;
}

// 这是一个 context，用于判断消息响应是否作为另一个 MessageResponse 的
// 后代被渲染。我们用它来避免渲染嵌套的 ⎿ 字符。
const MessageResponseContext = React.createContext(false);

function MessageResponseProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  return <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>;
}
