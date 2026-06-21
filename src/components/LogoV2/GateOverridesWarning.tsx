import * as React from 'react';

/**
 * 仅内部使用的组件。当 feature-gate overrides（CLAUDE_INTERNAL_FC_OVERRIDES）
 * 处于激活状态时显示警告。已 stub — 在非内部构建中返回 null。
 */
export function GateOverridesWarning(): React.ReactNode {
  return null;
}
