/**
 * 安装后/启用后的配置提示。
 *
 * 给定一个 LoadedPlugin，同时检查顶层 manifest.userConfig 和按 channel
 * 的 userConfig。让 PluginOptionsDialog 依次遍历每一个未配置项，
 * 通过相应的存储函数保存。如果无需填任何内容，则立即调用
 * onDone('skipped')。
 */

import * as React from 'react';
import type { LoadedPlugin } from '../../types/plugin.js';
import { errorMessage } from '../../utils/errors.js';
import { loadMcpServerUserConfig, saveMcpServerUserConfig } from '../../utils/plugins/mcpbHandler.js';
import { getUnconfiguredChannels, type UnconfiguredChannel } from '../../utils/plugins/mcpPluginIntegration.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import {
  getUnconfiguredOptions,
  loadPluginOptions,
  type PluginOptionSchema,
  type PluginOptionValues,
  savePluginOptions,
} from '../../utils/plugins/pluginOptionsStorage.js';
import { PluginOptionsDialog } from './PluginOptionsDialog.js';

/**
 * 安装后查询：为刚安装的 pluginId 返回对应的 LoadedPlugin，
 * 以便调用方可以转交给 PluginOptionsFlow。如果该插件由于某种原因
 * 没有出现在最新加载结果中，则返回 undefined —— 调用方将 undefined
 * 视为"继续关闭"。
 *
 * Install 应该已经清理了缓存；loadAllPlugins 读取的是最新数据。
 */
export async function findPluginOptionsTarget(pluginId: string): Promise<LoadedPlugin | undefined> {
  const { enabled, disabled } = await loadAllPlugins();
  return [...enabled, ...disabled].find(p => p.repository === pluginId || p.source === pluginId);
}

/**
 * 遍历中的单个对话框步骤。顶层选项和 channel 都会折叠为此形状 ——
 * 唯一区别是运行的是哪个保存函数。
 */
type ConfigStep = {
  key: string;
  title: string;
  subtitle: string;
  schema: PluginOptionSchema;
  /** 返回任何已保存的值，以便 PluginOptionsDialog 可以预填，
   *  并在重新配置时跳过未变更的敏感字段。 */
  load: () => PluginOptionValues | undefined;
  save: (values: PluginOptionValues) => void;
};

type Props = {
  plugin: LoadedPlugin;
  /** `name@marketplace` —— savePluginOptions / saveMcpServerUserConfig 的 key。 */
  pluginId: string;
  /**
   * `configured` = 用户填完了所有字段。`skipped` = 无需配置，
   * 或用户点击了取消。`error` = 保存抛出异常。
   */
  onDone: (outcome: 'configured' | 'skipped' | 'error', detail?: string) => void;
};

export function PluginOptionsFlow({ plugin, pluginId, onDone }: Props): React.ReactNode {
  // 在挂载时一次性构造步骤列表。如果在保存后再调用，会丢掉刚刚配置的项。
  const [steps] = React.useState<ConfigStep[]>(() => {
    const result: ConfigStep[] = [];

    // 顶层 manifest.userConfig
    const unconfigured = getUnconfiguredOptions(plugin);
    if (Object.keys(unconfigured).length > 0) {
      result.push({
        key: 'top-level',
        title: `Configure ${plugin.name}`,
        subtitle: 'Plugin options',
        schema: unconfigured,
        load: () => loadPluginOptions(pluginId),
        save: values => savePluginOptions(pluginId, values, plugin.manifest.userConfig!),
      });
    }

    // 按 channel 的 userConfig（assistant-mode 的 channels）
    const channels: UnconfiguredChannel[] = getUnconfiguredChannels(plugin);
    for (const channel of channels) {
      result.push({
        key: `channel:${channel.server}`,
        title: `Configure ${channel.displayName}`,
        subtitle: `Plugin: ${plugin.name}`,
        schema: channel.configSchema,
        load: () => loadMcpServerUserConfig(pluginId, channel.server) ?? undefined,
        save: values => saveMcpServerUserConfig(pluginId, channel.server, values, channel.configSchema),
      });
    }

    return result;
  });

  const [index, setIndex] = React.useState(0);

  // 最新 ref：让 effect 闭包捕获当前的 onDone，而不会在父组件
  // 重新渲染时重复运行。
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  // 没有可配置的项 → 通知调用方并不渲染任何内容。使用 effect，
  // 而非内联调用：在我们的渲染过程中调用父组件的 setState
  // 会违反 React 的 hooks 规则。
  React.useEffect(() => {
    if (steps.length === 0) {
      onDoneRef.current('skipped');
    }
  }, [steps.length]);

  if (steps.length === 0) {
    return null;
  }

  const current = steps[index]!;

  function handleSave(values: PluginOptionValues): void {
    try {
      current.save(values);
    } catch (err) {
      onDone('error', errorMessage(err));
      return;
    }
    const next = index + 1;
    if (next < steps.length) {
      setIndex(next);
    } else {
      onDone('configured');
    }
  }

  // key 强制在进入下一步时重新挂载 —— 否则 React 会复用实例并
  // 把 PluginOptionsDialog 内部的 useState（字段索引、已输入值）
  // 带过去。
  return (
    <PluginOptionsDialog
      key={current.key}
      title={current.title}
      subtitle={current.subtitle}
      configSchema={current.schema}
      initialValues={current.load()}
      onSave={handleSave}
      onCancel={() => onDone('skipped')}
    />
  );
}
