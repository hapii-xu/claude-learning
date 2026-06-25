import React, { useCallback, useEffect, useState } from 'react';
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js';
import { writeToStdout } from 'src/utils/process.js';
import { Box, color, Text, useTheme, Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import { addMcpConfig, getAllMcpConfigs } from '../services/mcp/config.js';
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js';
import { plural } from '../utils/stringUtils.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';

type Props = {
  servers: Record<string, McpServerConfig>;
  scope: ConfigScope;
  onDone(): void;
};

export function MCPServerDesktopImportDialog({ servers, scope, onDone }: Props): React.ReactNode {
  const serverNames = Object.keys(servers);
  const [existingServers, setExistingServers] = useState<Record<string, ScopedMcpServerConfig>>({});

  useEffect(() => {
    void getAllMcpConfigs().then(({ servers }) => setExistingServers(servers));
  }, []);

  const collisions = serverNames.filter(name => existingServers[name] !== undefined);

  async function onSubmit(selectedServers: string[]) {
    let importedCount = 0;

    for (const serverName of selectedServers) {
      const serverConfig = servers[serverName];
      if (serverConfig) {
        // 如果服务器名称已存在，则使用 _1、_2 等后缀查找新名称
        let finalName = serverName;
        if (existingServers[finalName] !== undefined) {
          let counter = 1;
          while (existingServers[`${serverName}_${counter}`] !== undefined) {
            counter++;
          }
          finalName = `${serverName}_${counter}`;
        }

        await addMcpConfig(finalName, serverConfig, scope);
        importedCount++;
      }
    }

    done(importedCount);
  }

  const [theme] = useTheme();

  // 在 useCallback 中使用前先定义 done
  const done = useCallback(
    (importedCount: number) => {
      if (importedCount > 0) {
        writeToStdout(
          `\n${color('success', theme)(`成功导入了 ${importedCount} 个 MCP ${plural(importedCount, 'server')} 到 ${scope} 配置。`)}\n`,
        );
      } else {
        writeToStdout('\n未导入任何服务器。');
      }
      onDone();

      void gracefulShutdown();
    },
    [theme, scope, onDone],
  );

  // 处理 ESC 取消（导入 0 个服务器）
  const handleEscCancel = useCallback(() => {
    done(0);
  }, [done]);

  return (
    <>
      <Dialog
        title="从 Claude Desktop 导入 MCP 服务器"
        subtitle={`在 Claude Desktop 中发现 ${serverNames.length} 个 MCP ${plural(serverNames.length, 'server')}。`}
        color="success"
        onCancel={handleEscCancel}
        hideInputGuide
      >
        {collisions.length > 0 && (
          <Text color="warning">注意：部分服务器已存在同名。如果选中，它们将以数字后缀的形式导入。</Text>
        )}
        <Text>请选择你想要导入的服务器：</Text>

        <SelectMulti
          options={serverNames.map(server => ({
            label: `${server}${collisions.includes(server) ? '（已存在）' : ''}`,
            value: server,
          }))}
          defaultValue={serverNames.filter(name => !collisions.includes(name))} // 只预选不冲突的服务器
          onSubmit={onSubmit}
          onCancel={handleEscCancel}
          hideIndexes
        />
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Space" action="select" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </>
  );
}
