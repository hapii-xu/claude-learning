// 外部构建的桩文件——真实的 hook 仅限内部使用。
//
// 自包含：无相对导入。类型检查在 overlay 之前看到的此文件位于
// scripts/external-stubs/src/moreright/，其中 ../types/
// 会解析到 scripts/external-stubs/src/types/（不存在）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type M = any;

export function useMoreRight(_args: {
  enabled: boolean;
  setMessages: (action: M[] | ((prev: M[]) => M[])) => void;
  inputValue: string;
  setInputValue: (s: string) => void;
  setToolJSX: (args: M) => void;
}): {
  onBeforeQuery: (input: string, all: M[], n: number) => Promise<boolean>;
  onTurnComplete: (all: M[], aborted: boolean) => Promise<void>;
  render: () => null;
} {
  return {
    onBeforeQuery: async () => true,
    onTurnComplete: async () => {},
    render: () => null,
  };
}
