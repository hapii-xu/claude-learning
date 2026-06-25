// 占位实现 —— ant 专用组件，在反编译构建中不可用
import React, { useEffect } from 'react';

export function UndercoverAutoCallout({ onDone }: { onDone: () => void }): React.ReactElement | null {
  useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}
