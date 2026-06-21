import React, { useContext, useRef } from 'react';
import { useTerminalViewport, Box } from '@anthropic/ink';
import { InVirtualListContext } from './messageActions.js';

type Props = {
  children: React.ReactNode;
};

/**
 * 当 children 滚动到终端 viewport 之上（进入 scrollback）时冻结它们。
 *
 * viewport 之上的任何内容变化都会强制 log-update.ts 进入 full terminal
 * reset（它无法部分更新已滚动出去的行）。对于基于 timer 更新的内容
 * —— spinner、elapsed 计数器 —— 这会产生每次 tick 一次 reset。
 *
 * 当 offscreen 时，返回上次可见渲染期间缓存的同一 ReactElement 引用。
 * React 的 reconciler 在相同 element ref 时会 bail，所以
 * 子树从不重新渲染，产生零 diff。
 *
 * 缓存只有一个槽位深：滚回 viewport 之后的第一次重新渲染
 * 会获取 live children。可见时内容仍正常更新。
 */
export function OffscreenFreeze({ children }: Props): React.ReactNode {
  // React Compiler：在 return 中读取 cached.current 是整个
  // freeze 机制 —— 对此组件进行 memoize 会破坏它。Opt out。
  'use no memo';
  const inVirtualList = useContext(InVirtualListContext);
  const [ref, { isVisible }] = useTerminalViewport();
  const cached = useRef(children);
  // Virtual list 没有 terminal scrollback —— ScrollBox 在
  // viewport 内部裁剪，所以没什么可冻结的。在那里冻结也会阻止
  // click-to-expand，因为 useTerminalViewport 的 visibility 计算可能与
  // ScrollBox 的虚拟滚动位置不一致。
  if (isVisible || inVirtualList) {
    cached.current = children;
  }
  return <Box ref={ref}>{cached.current}</Box>;
}
