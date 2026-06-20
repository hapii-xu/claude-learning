import * as React from 'react';
import { Box } from '@anthropic/ink';

type QueuedMessageContextValue = {
  isQueued: boolean;
  isFirst: boolean;
  /** 容器内边距的宽度减少（例如，paddingX={2} 时为 4） */
  paddingWidth: number;
};

const QueuedMessageContext = React.createContext<QueuedMessageContextValue | undefined>(undefined);

export function useQueuedMessage(): QueuedMessageContextValue | undefined {
  return React.useContext(QueuedMessageContext);
}

const PADDING_X = 2;

type Props = {
  isFirst: boolean;
  useBriefLayout?: boolean;
  children: React.ReactNode;
};

export function QueuedMessageProvider({ isFirst, useBriefLayout, children }: Props): React.ReactNode {
  // 简要模式已经通过 HighlightedThinkingText /
  // BriefTool UI 中的 paddingLeft 进行缩进——在此处添加 paddingX
  // 会导致队列的双重缩进。
  const padding = useBriefLayout ? 0 : PADDING_X;
  const value = React.useMemo(() => ({ isQueued: true, isFirst, paddingWidth: padding * 2 }), [isFirst, padding]);

  return (
    <QueuedMessageContext.Provider value={value}>
      <Box paddingX={padding}>{children}</Box>
    </QueuedMessageContext.Provider>
  );
}
