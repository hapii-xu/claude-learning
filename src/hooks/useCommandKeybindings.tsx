/**
 * 为命令绑定注册快捷键处理器的组件。
 *
 * 必须在 KeybindingSetup 内部渲染以访问快捷键上下文。
 * 从当前快捷键配置中读取 "command:*" 操作并注册
 * 通过 onSubmit 调用相应斜杠命令的处理器。
 *
 * 通过快捷键触发的命令被视为"立即"执行 - 它们立即运行
 * 并保留用户现有的输入文本（提示不会被清除）。
 */
import { useMemo } from 'react';
import { useIsModalOverlayActive } from '../context/overlayContext.js';
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import type { PromptInputHelpers } from '../utils/handlePromptSubmit.js';

type Props = {
  // onSubmit 接受比我们传递的更多的参数，
  // 因此我们使用剩余参数以允许任何额外的参数
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    ...rest: [speculationAccept?: undefined, options?: { fromKeybinding?: boolean }]
  ) => void;
  /** 设置为 false 以禁用命令快捷键（例如，当对话框打开时） */
  isActive?: boolean;
};

const NOOP_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
};

/**
 * 为用户快捷键配置中找到的所有 "command:*" 操作注册处理器。
 * 触发时，每个处理器提交相应的斜杠命令（例如，"command:commit" 提交 "/commit"）。
 */
export function CommandKeybindingHandlers({ onSubmit, isActive = true }: Props): null {
  const keybindingContext = useOptionalKeybindingContext();
  const isModalOverlayActive = useIsModalOverlayActive();

  // 从解析后的绑定中提取命令操作
  const commandActions = useMemo(() => {
    if (!keybindingContext) return new Set<string>();
    const actions = new Set<string>();
    for (const binding of keybindingContext.bindings) {
      if (binding.action?.startsWith('command:')) {
        actions.add(binding.action);
      }
    }
    return actions;
  }, [keybindingContext]);

  // 为所有命令操作构建处理器映射
  const handlers = useMemo(() => {
    const map: Record<string, () => void> = {};
    for (const action of commandActions) {
      const commandName = action.slice('command:'.length);
      map[action] = () => {
        onSubmit(`/${commandName}`, NOOP_HELPERS, undefined, {
          fromKeybinding: true,
        });
      };
    }
    return map;
  }, [commandActions, onSubmit]);

  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !isModalOverlayActive,
  });

  return null;
}
