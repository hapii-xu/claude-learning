/**
 * MCP 子命令处理器 — 从 main.tsx 抽出以便懒加载。
 * 仅在对应的 `claude mcp *` 命令执行时动态加载。
 */

import { stat } from 'fs/promises';
import pMap from 'p-map';
import { cwd } from 'process';
import { MCPServerDesktopImportDialog } from '../../components/MCPServerDesktopImportDialog.js';
import { wrappedRender as render } from '@anthropic/ink';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import {
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
  getMcpClientConfig,
  readClientSecret,
  saveMcpClientSecret,
} from '../../services/mcp/auth.js';
import { connectToServer, getMcpServerConnectionBatchSize } from '../../services/mcp/client.js';
import {
  addMcpConfig,
  getAllMcpConfigs,
  getMcpConfigByName,
  getMcpConfigsByScope,
  removeMcpConfig,
} from '../../services/mcp/config.js';
import type { ConfigScope, ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { describeMcpConfigFilePath, ensureConfigScope, getScopeLabel } from '../../services/mcp/utils.js';
import { AppStateProvider } from '../../state/AppState.js';
import { getCurrentProjectConfig, getGlobalConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { isFsInaccessible } from '../../utils/errors.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { safeParseJSON } from '../../utils/json.js';
import { getPlatform } from '../../utils/platform.js';
import { cliError, cliOk } from '../exit.js';

async function checkMcpServerHealth(name: string, server: ScopedMcpServerConfig): Promise<string> {
  try {
    const result = await connectToServer(name, server);
    if (result.type === 'connected') {
      return '✓ Connected';
    } else if (result.type === 'needs-auth') {
      return '! Needs authentication';
    } else {
      return '✗ Failed to connect';
    }
  } catch (_error) {
    return '✗ Connection error';
  }
}

// mcp serve（对应原 4512–4532 行）
export async function mcpServeHandler({ debug, verbose }: { debug?: boolean; verbose?: boolean }): Promise<void> {
  const providedCwd = cwd();
  logEvent('tengu_mcp_start', {});

  try {
    await stat(providedCwd);
  } catch (error) {
    if (isFsInaccessible(error)) {
      cliError(`Error: Directory ${providedCwd} does not exist`);
    }
    throw error;
  }

  try {
    const { setup } = await import('../../setup.js');
    await setup(providedCwd, 'default', false, false, undefined, false);
    const { startMCPServer } = await import('../../entrypoints/mcp.js');
    await startMCPServer(providedCwd, debug ?? false, verbose ?? false);
  } catch (error) {
    cliError(`Error: Failed to start MCP server: ${error}`);
  }
}

// mcp remove（对应原 4545–4635 行）
export async function mcpRemoveHandler(name: string, options: { scope?: string }): Promise<void> {
  // 删除前先查一下配置，以便清理安全存储
  const serverBeforeRemoval = getMcpConfigByName(name);

  const cleanupSecureStorage = () => {
    if (serverBeforeRemoval && (serverBeforeRemoval.type === 'sse' || serverBeforeRemoval.type === 'http')) {
      clearServerTokensFromLocalStorage(name, serverBeforeRemoval);
      clearMcpClientConfig(name, serverBeforeRemoval);
    }
  };

  try {
    if (options.scope) {
      const scope = ensureConfigScope(options.scope);
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      await removeMcpConfig(name, scope);
      cleanupSecureStorage();
      process.stdout.write(`Removed MCP server ${name} from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    }

    // 如果未指定 scope，则检查 server 实际存在的位置
    const projectConfig = getCurrentProjectConfig();
    const globalConfig = getGlobalConfig();

    // 检查 project scope（.mcp.json）中是否存在该 server
    const { servers: projectServers } = getMcpConfigsByScope('project');
    const mcpJsonExists = !!projectServers[name];

    // 统计该 server 存在于多少个 scope 中
    const scopes: Array<Exclude<ConfigScope, 'dynamic'>> = [];
    if (projectConfig.mcpServers?.[name]) scopes.push('local');
    if (mcpJsonExists) scopes.push('project');
    if (globalConfig.mcpServers?.[name]) scopes.push('user');

    if (scopes.length === 0) {
      cliError(`No MCP server found with name: "${name}"`);
    } else if (scopes.length === 1) {
      // server 只存在于一个 scope 中，直接移除
      const scope = scopes[0]!;
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      await removeMcpConfig(name, scope);
      cleanupSecureStorage();
      process.stdout.write(`Removed MCP server "${name}" from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    } else {
      // server 存在于多个 scope 中
      process.stderr.write(`MCP server "${name}" exists in multiple scopes:\n`);
      scopes.forEach(scope => {
        process.stderr.write(`  - ${getScopeLabel(scope)} (${describeMcpConfigFilePath(scope)})\n`);
      });
      process.stderr.write('\nTo remove from a specific scope, use:\n');
      scopes.forEach(scope => {
        process.stderr.write(`  claude mcp remove "${name}" -s ${scope}\n`);
      });
      cliError();
    }
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp list（对应原 4641–4688 行）
export async function mcpListHandler(): Promise<void> {
  logEvent('tengu_mcp_list', {});
  const { servers: configs } = await getAllMcpConfigs();
  if (Object.keys(configs).length === 0) {
    console.log('No MCP servers configured. Use `claude mcp add` to add a server.');
  } else {
    console.log('Checking MCP server health...\n');

    // 并发检查 servers
    const entries = Object.entries(configs);
    const results = await pMap(
      entries,
      async ([name, server]) => ({
        name,
        server,
        status: await checkMcpServerHealth(name, server),
      }),
      { concurrency: getMcpServerConnectionBatchSize() },
    );

    for (const { name, server, status } of results) {
      // 这里特意排除 sse-ide servers，因为它们是内部使用的
      if (server.type === 'sse') {
        console.log(`${name}: ${server.url} (SSE) - ${status}`);
      } else if (server.type === 'http') {
        console.log(`${name}: ${server.url} (HTTP) - ${status}`);
      } else if (server.type === 'claudeai-proxy') {
        console.log(`${name}: ${server.url} - ${status}`);
      } else if (!server.type || server.type === 'stdio') {
        const stdioServer = server as { command: string; args: string[]; type?: string };
        const args = Array.isArray(stdioServer.args) ? stdioServer.args : [];
        console.log(`${name}: ${stdioServer.command} ${args.join(' ')} - ${status}`);
      }
    }
  }
  // 使用 gracefulShutdown 来正确清理 MCP server 连接
  // （process.exit 会绕过清理钩子，导致子进程变成孤儿进程）
  await gracefulShutdown(0);
}

// mcp get（对应原 4694–4786 行）
export async function mcpGetHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_get', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
  const server = getMcpConfigByName(name);
  if (!server) {
    cliError(`No MCP server found with name: ${name}`);
  }

  console.log(`${name}:`);
  console.log(`  Scope: ${getScopeLabel(server.scope)}`);

  // 检查 server 健康状态
  const status = await checkMcpServerHealth(name, server);
  console.log(`  Status: ${status}`);

  // 这里特意排除 sse-ide servers，因为它们是内部使用的
  if (server.type === 'sse') {
    console.log(`  Type: sse`);
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        console.log(`    ${key}: ${value}`);
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = [];
      if (server.oauth.clientId) {
        parts.push('client_id configured');
        const clientConfig = getMcpClientConfig(name, server);
        if (clientConfig?.clientSecret) parts.push('client_secret configured');
      }
      if (server.oauth.callbackPort) parts.push(`callback_port ${server.oauth.callbackPort}`);
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'http') {
    console.log(`  Type: http`);
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        console.log(`    ${key}: ${value}`);
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = [];
      if (server.oauth.clientId) {
        parts.push('client_id configured');
        const clientConfig = getMcpClientConfig(name, server);
        if (clientConfig?.clientSecret) parts.push('client_secret configured');
      }
      if (server.oauth.callbackPort) parts.push(`callback_port ${server.oauth.callbackPort}`);
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'stdio') {
    console.log(`  Type: stdio`);
    console.log(`  Command: ${server.command}`);
    const args = Array.isArray(server.args) ? server.args : [];
    console.log(`  Args: ${args.join(' ')}`);
    if (server.env) {
      console.log('  Environment:');
      for (const [key, value] of Object.entries(server.env)) {
        console.log(`    ${key}=${value}`);
      }
    }
  }
  console.log(`\nTo remove this server, run: claude mcp remove "${name}" -s ${server.scope}`);
  // 使用 gracefulShutdown 来正确清理 MCP server 连接
  // （process.exit 会绕过清理钩子，导致子进程变成孤儿进程）
  await gracefulShutdown(0);
}

// mcp add-json（对应原 4801–4870 行）
export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope);
    const parsedJson = safeParseJSON(json);

    // 在写入配置前先读取 secret，避免取消时留下不完整状态
    const needsSecret =
      options.clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string' &&
      'oauth' in parsedJson &&
      parsedJson.oauth &&
      typeof parsedJson.oauth === 'object' &&
      'clientId' in parsedJson.oauth;
    const clientSecret = needsSecret ? await readClientSecret() : undefined;

    await addMcpConfig(name, parsedJson, scope);

    const transportType =
      parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson
        ? String(parsedJson.type || 'stdio')
        : 'stdio';

    if (
      clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string'
    ) {
      saveMcpClientSecret(name, { type: parsedJson.type, url: parsedJson.url }, clientSecret);
    }

    logEvent('tengu_mcp_add', {
      scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: 'json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      type: transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    cliOk(`Added ${transportType} MCP server ${name} to ${scope} config`);
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp add-from-claude-desktop（对应原 4881–4927 行）
export async function mcpAddFromDesktopHandler(options: { scope?: string }): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope);
    const platform = getPlatform();

    logEvent('tengu_mcp_add', {
      scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: 'desktop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    const { readClaudeDesktopMcpServers } = await import('../../utils/claudeDesktop.js');
    const servers = await readClaudeDesktopMcpServers();

    if (Object.keys(servers).length === 0) {
      cliOk('No MCP servers found in Claude Desktop configuration or configuration file does not exist.');
    }

    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPServerDesktopImportDialog
            servers={servers}
            scope={scope}
            onDone={() => {
              unmount();
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      { exitOnCtrlC: true },
    );
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp reset-project-choices（对应原 4935–4952 行）
export async function mcpResetChoicesHandler(): Promise<void> {
  logEvent('tengu_mcp_reset_mcpjson_choices', {});
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
  }));
  cliOk(
    'All project-scoped (.mcp.json) server approvals and rejections have been reset.\n' +
      'You will be prompted for approval next time you start Claude Code.',
  );
}
