import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getAllOutputStyles, OUTPUT_STYLE_CONFIG, type OutputStyleConfig } from '../constants/outputStyles.js';
import { Box, Text, Dialog } from '@anthropic/ink';
import type { OutputStyle } from '../utils/config.js';
import { getCwd } from '../utils/cwd.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';

const DEFAULT_OUTPUT_STYLE_LABEL = '默认';
const DEFAULT_OUTPUT_STYLE_DESCRIPTION = 'Claude 高效完成编码任务并提供简洁的回复';

function mapConfigsToOptions(styles: { [styleName: string]: OutputStyleConfig | null }): OptionWithDescription[] {
  return Object.entries(styles).map(([style, config]) => ({
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    value: style,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION,
  }));
}

export type OutputStylePickerProps = {
  initialStyle: OutputStyle;
  onComplete: (style: OutputStyle) => void;
  onCancel: () => void;
  isStandaloneCommand?: boolean;
};

export function OutputStylePicker({
  initialStyle,
  onComplete,
  onCancel,
  isStandaloneCommand,
}: OutputStylePickerProps): React.ReactNode {
  const [styleOptions, setStyleOptions] = useState<OptionWithDescription[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 加载所有输出样式，包括自定义样式
    getAllOutputStyles(getCwd())
      .then(allStyles => {
        const options = mapConfigsToOptions(allStyles);
        setStyleOptions(options);
        setIsLoading(false);
      })
      .catch(() => {
        // 出错时，仅回退到内置样式
        const builtInOptions = mapConfigsToOptions(OUTPUT_STYLE_CONFIG);
        setStyleOptions(builtInOptions);
        setIsLoading(false);
      });
  }, []);

  const handleStyleSelect = useCallback(
    (style: string) => {
      const outputStyle = style as OutputStyle;
      onComplete(outputStyle);
    },
    [onComplete],
  );

  return (
    <Dialog
      title="偏好的输出样式"
      onCancel={onCancel}
      hideInputGuide={!isStandaloneCommand}
      hideBorder={!isStandaloneCommand}
    >
      <Box flexDirection="column" gap={1}>
        <Box marginTop={1}>
          <Text dimColor>这会改变 Claude Code 与你的沟通方式</Text>
        </Box>
        {isLoading ? (
          <Text dimColor>正在加载输出样式…</Text>
        ) : (
          <Select
            options={styleOptions}
            onChange={handleStyleSelect}
            visibleOptionCount={10}
            defaultValue={initialStyle}
          />
        )}
      </Box>
    </Dialog>
  );
}
