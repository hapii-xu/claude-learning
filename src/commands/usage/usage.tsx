import { Settings } from '../../components/Settings/Settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

/**
 * /usage —— 统一命令，替代 /cost 与 /stats（对齐上游 v2.1.118）。
 *
 * 路由：
 *   - claude.ai 订阅用户 → Settings 面板 → Usage 标签页（套餐额度与超额）
 *   - API / 非订阅用户   → Stats 面板（会话成本、token 计数、活动情况）
 *
 * /cost 与 /stats 都被注册为本命令的别名，以保留用户既有的肌肉记忆。
 */
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Usage" />;
};
