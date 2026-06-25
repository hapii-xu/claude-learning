import figures from 'figures';
import * as React from 'react';
import { Suspense, use } from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { Box, Text, useTheme } from '@anthropic/ink';
import { type AppState, useAppState } from '../../state/AppState.js';
import { getCwd } from '../../utils/cwd.js';
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js';
import {
  buildAccountProperties,
  buildAPIProviderProperties,
  buildIDEProperties,
  buildInstallationDiagnostics,
  buildInstallationHealthDiagnostics,
  buildMcpProperties,
  buildMemoryDiagnostics,
  buildSandboxProperties,
  buildSettingSourcesProperties,
  type Diagnostic,
  getModelDisplayLabel,
  type Property,
} from '../../utils/status.js';
import type { ThemeName } from '../../utils/theme.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';

type Props = {
  context: LocalJSXCommandContext;
  diagnosticsPromise: Promise<Diagnostic[]>;
};

function buildPrimarySection(): Property[] {
  const sessionId = getSessionId();
  const customTitle = getCurrentSessionTitle(sessionId);
  const nameValue = customTitle ?? <Text dimColor>使用 /rename 添加名称</Text>;

  return [
    { label: '版本', value: MACRO.VERSION },
    { label: '会话名称', value: nameValue },
    { label: '会话 ID', value: sessionId },
    { label: 'cwd', value: getCwd() },
    ...buildAccountProperties(),
    ...buildAPIProviderProperties(),
  ];
}

function buildSecondarySection({
  mainLoopModel,
  mcp,
  theme,
  context,
}: {
  mainLoopModel: AppState['mainLoopModel'];
  mcp: AppState['mcp'];
  theme: ThemeName;
  context: LocalJSXCommandContext;
}): Property[] {
  const modelLabel = getModelDisplayLabel(mainLoopModel);

  return [
    { label: '模型', value: modelLabel },
    ...buildIDEProperties(mcp.clients, context.options.ideInstallationStatus, theme),
    ...buildMcpProperties(mcp.clients, theme),
    ...buildSandboxProperties(),
    ...buildSettingSourcesProperties(),
  ];
}

export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [
    ...(await buildInstallationDiagnostics()),
    ...(await buildInstallationHealthDiagnostics()),
    ...(await buildMemoryDiagnostics()),
  ];
}

function PropertyValue({ value }: { value: Property['value'] }): React.ReactNode {
  if (Array.isArray(value)) {
    return (
      <Box flexWrap="wrap" columnGap={1} flexShrink={99}>
        {value.map((item, i) => {
          return (
            <Text key={i}>
              {item}
              {i < value.length - 1 ? ',' : ''}
            </Text>
          );
        })}
      </Box>
    );
  }

  if (typeof value === 'string') {
    return <Text>{value}</Text>;
  }

  return value;
}

export function Status({ context, diagnosticsPromise }: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const mcp = useAppState(s => s.mcp);
  const [theme] = useTheme();

  // 各区块是同步的 —— 在渲染时计算，保证永不为空。
  // diagnosticsPromise 在 Settings.tsx 中只创建一次，因此每次面板调用
  // 只解析一次，而不是每次切换 tab 都重新加载（未选中的 Tab 会卸载其
  // 子组件，曾导致闪烁）。
  const sections = React.useMemo(
    () => [buildPrimarySection(), buildSecondarySection({ mainLoopModel, mcp, theme, context })],
    [mainLoopModel, mcp, theme, context],
  );

  // 使用 flexGrow 让 "Esc 取消" 页脚在内容较短时固定到 Modal 内部
  // ScrollBox 的底部。ScrollBox 的内容容器具有 flexGrow:1（至少填满
  // 视口），因此这里会拉伸到与之匹配。若不这样做，较短的 Status 内容
  // 会浮在顶部，页脚悬在 Modal 中间，下方留出 2-3 行空白。在 Modal
  // 之外（非全屏）则保持原布局 —— 没有 ScrollBox 需要填充。
  const grow = useIsInsideModal() ? 1 : undefined;

  return (
    <Box flexDirection="column" flexGrow={grow}>
      <Box flexDirection="column" gap={1} flexGrow={grow}>
        {sections.map(
          (properties, i) =>
            properties.length > 0 && (
              <Box key={i} flexDirection="column">
                {properties.map(({ label, value }, j) => (
                  <Box key={j} flexDirection="row" gap={1} flexShrink={0}>
                    {label !== undefined && <Text bold>{label}:</Text>}
                    <PropertyValue value={value} />
                  </Box>
                ))}
              </Box>
            ),
        )}

        <Suspense fallback={null}>
          <Diagnostics promise={diagnosticsPromise} />
        </Suspense>
      </Box>
      <Text dimColor>
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="取消" />
      </Text>
    </Box>
  );
}

function Diagnostics({ promise }: { promise: Promise<Diagnostic[]> }): React.ReactNode {
  const diagnostics = use(promise);
  if (diagnostics.length === 0) return null;
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Text bold>系统诊断</Text>
      {diagnostics.map((diagnostic, i) => (
        <Box key={i} flexDirection="row" gap={1} paddingX={1}>
          <Text color="error">{figures.warning}</Text>
          {typeof diagnostic === 'string' ? <Text wrap="wrap">{diagnostic}</Text> : diagnostic}
        </Box>
      ))}
    </Box>
  );
}
