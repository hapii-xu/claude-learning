// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import * as React from 'react';
import { Suspense, useState } from 'react';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js';
import { Pane, Tab, Tabs } from '@anthropic/ink';
import { Status, buildDiagnostics } from './Status.js';
import { Config } from './Config.js';
import { Usage } from './Usage.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  context: LocalJSXCommandContext;
  defaultTab: 'Status' | 'Config' | 'Usage';
};

export function Settings({ onClose, context, defaultTab }: Props): React.ReactNode {
  const [selectedTab, setSelectedTab] = useState<string>(defaultTab);
  const [tabsHidden, setTabsHidden] = useState(false);
  // 当 Config 自身的 Esc 处理器激活时（内容获得焦点的搜索模式）为 true。
  // Settings 必须让出 Esc，以便搜索能先清空/退出。
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false);
  // 固定内容高度，避免切换 tab 时面板高度跳动。
  // Modal 外取 min(80% 视口, 30)。在 Modal 内，modal 的 innerSize.rows
  // 才是 ScrollBox 的视口——0.8 的系数会过度收缩，导致 Config 显示
  // "↓ 还有 N 项" 时留出空行。
  //
  // Modal 内的计算：Config 的 paneCap-10 chrome 估算值是为 marginY={1}
  //（2 行）调整的，在 Modal 内被剥离 → +2 补回。再 -2 给 Tabs 的标题行
  // + marginTop=1。再加上观察到 paneCap-10 估算略微偏大造成的 +1 间隙。
  // 最终：rows + 1。
  const insideModal = useIsInsideModal();
  const { rows } = useModalOrTerminalSize(useTerminalSize());
  const contentHeight = insideModal ? rows + 1 : Math.max(15, Math.min(Math.floor(rows * 0.8), 30));
  // 面板打开时启动一次诊断。Status 会 use() 它，因此每次 /config 调用
  // 只解析一次——切回 Status 时不会出现重新加载的闪烁（未选中的 Tab 会
  // 卸载其子组件）。
  const [diagnosticsPromise] = useState(() => buildDiagnostics().catch(() => []));

  useExitOnCtrlCDWithKeybindings();

  // 通过 keybinding 处理 Escape —— 仅在未进入子菜单时
  const handleEscape = () => {
    // 子菜单显示时（tabsHidden 为 true 表示子菜单已打开）不处理 Escape
    // 让子菜单自行处理 Escape 以返回主菜单
    if (tabsHidden) {
      return;
    }
    // TODO: 等我们定义了 '/settings' 后改为 "Settings" 对话框。
    onClose('Status dialog dismissed', { display: 'system' });
  };

  // 子菜单打开时禁用，以便子菜单的 Dialog 处理 ESC；Config 的搜索模式激活
  // 时也禁用，让其 useInput 处理器（清空查询 → 退出搜索）先处理 Escape。
  useKeybinding('confirm:no', handleEscape, {
    context: 'Settings',
    isActive: !tabsHidden && !(selectedTab === 'Config' && configOwnsEsc),
  });

  const tabs = [
    <Tab key="status" title="状态">
      <Status context={context} diagnosticsPromise={diagnosticsPromise} />
    </Tab>,
    <Tab key="config" title="配置">
      <Suspense fallback={null}>
        <Config
          context={context}
          onClose={onClose}
          setTabsHidden={setTabsHidden}
          onIsSearchModeChange={setConfigOwnsEsc}
          contentHeight={contentHeight}
        />
      </Suspense>
    </Tab>,
    <Tab key="usage" title="用量">
      <Usage />
    </Tab>,
  ];

  return (
    <Pane color="permission">
      <Tabs
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab}
        hidden={tabsHidden}
        // Config 包含可交互内容 —— 启动时标题不获得焦点，这样
        // left/right/tab 会循环切换选项的值，而不是切换 tab。
        initialHeaderFocused={defaultTab !== 'Config'}
        // 在 Modal 内跳过 Tabs 层级的高度上限，让较高的 tab（Status 的
        // MCP 列表）按自然高度排布，交由 Modal 的 ScrollBox 滚动。
        // Config 仍使用上面的 contentHeight —— 它内部自行分页，
        // 因此这里只影响 Status/Usage。
        contentHeight={tabsHidden || insideModal ? undefined : contentHeight}
      >
        {tabs}
      </Tabs>
    </Pane>
  );
}
