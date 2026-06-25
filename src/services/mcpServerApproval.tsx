import { MCPServerApprovalDialog } from '../components/MCPServerApprovalDialog.js';
import { MCPServerMultiselectDialog } from '../components/MCPServerMultiselectDialog.js';
import type { Root } from '@anthropic/ink';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../state/AppState.js';
import { getMcpConfigsByScope } from './mcp/config.js';
import { getProjectMcpServerStatus } from './mcp/utils.js';

/**
 * 为待审批的 project servers 显示 MCP server 审批对话框。
 * 使用传入的 Ink root 进行渲染（复用 main.tsx 中的现有实例，
 * 而非单独创建一个新实例）。
 */
export async function handleMcpjsonServerApprovals(root: Root): Promise<void> {
  const { servers: projectServers } = getMcpConfigsByScope('project');
  const pendingServers = Object.keys(projectServers).filter(
    serverName => getProjectMcpServerStatus(serverName) === 'pending',
  );

  if (pendingServers.length === 0) {
    return;
  }

  await new Promise<void>(resolve => {
    const done = (): void => void resolve();
    if (pendingServers.length === 1 && pendingServers[0] !== undefined) {
      const serverName = pendingServers[0];
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <MCPServerApprovalDialog serverName={serverName} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
    } else {
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <MCPServerMultiselectDialog serverNames={pendingServers} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
    }
  });
}
