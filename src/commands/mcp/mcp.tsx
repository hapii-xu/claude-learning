import React, { useEffect, useRef } from 'react';
import { MCPSettings } from '../../components/mcp/index.js';
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import { useAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { PluginSettings } from '../plugin/PluginSettings.js';

// TODO：这是个 hack，用于从 toggleMcpServer 拿到 context 值（useContext 只能在组件中使用）
// 理想情况下，所有 MCP 状态和函数都应放在全局 state 中。
function MCPToggle({
  action,
  target,
  onComplete,
}: {
  action: 'enable' | 'disable';
  target: string;
  onComplete: (result: string) => void;
}): null {
  const mcpClients = useAppState(s => s.mcp.clients);
  const toggleMcpServer = useMcpToggleEnabled();
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const isEnabling = action === 'enable';
    const clients = mcpClients.filter(c => c.name !== 'ide');
    const toToggle =
      target === 'all'
        ? clients.filter(c => (isEnabling ? c.type === 'disabled' : c.type !== 'disabled'))
        : clients.filter(c => c.name === target);

    if (toToggle.length === 0) {
      onComplete(
        target === 'all'
          ? `All MCP servers are already ${isEnabling ? 'enabled' : 'disabled'}`
          : `MCP server "${target}" not found`,
      );
      return;
    }

    for (const s of toToggle) {
      void toggleMcpServer(s.name);
    }

    onComplete(
      target === 'all'
        ? `${isEnabling ? 'Enabled' : 'Disabled'} ${toToggle.length} MCP server(s)`
        : `MCP server "${target}" ${isEnabling ? 'enabled' : 'disabled'}`,
    );
  }, [action, target, mcpClients, toggleMcpServer, onComplete]);

  return null;
}

export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  if (args) {
    const parts = args.trim().split(/\s+/);

    // 允许 /mcp no-redirect 绕过重定向以便测试
    if (parts[0] === 'no-redirect') {
      return <MCPSettings onComplete={onDone} />;
    }

    if (parts[0] === 'reconnect' && parts[1]) {
      return <MCPReconnect serverName={parts.slice(1).join(' ')} onComplete={onDone} />;
    }

    if (parts[0] === 'enable' || parts[0] === 'disable') {
      return (
        <MCPToggle action={parts[0]} target={parts.length > 1 ? parts.slice(1).join(' ') : 'all'} onComplete={onDone} />
      );
    }
  }

  // 对 ant 用户，将基础 /mcp 命令重定向到 /plugins 的 installed 标签页
  if (process.env.USER_TYPE === 'ant') {
    return <PluginSettings onComplete={onDone} args="manage" showMcpRedirectMessage />;
  }

  return <MCPSettings onComplete={onDone} />;
}
