import React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '@anthropic/ink';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';

export type TranscriptShareResponse = 'yes' | 'no' | 'dont_ask_again';

type Props = {
  onSelect: (option: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};

const RESPONSE_INPUTS = ['1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];

const inputToResponse: Record<ResponseInput, TranscriptShareResponse> = {
  '1': 'yes',
  '2': 'no',
  '3': 'dont_ask_again',
} as const;

const isValidResponseInput = (input: string): input is ResponseInput =>
  (RESPONSE_INPUTS as readonly string[]).includes(input);

export function TranscriptSharePrompt({ onSelect, inputValue, setInputValue }: Props): React.ReactNode {
  useDebouncedDigitInput({
    inputValue,
    setInputValue,
    isValidDigit: isValidResponseInput,
    onDigit: digit => onSelect(inputToResponse[digit]),
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="ansi:cyan">{BLACK_CIRCLE} </Text>
        <Text bold>Anthropic 能否查看您的会话 transcript 以帮助我们改进 Claude Code？</Text>
      </Box>

      <Box marginLeft={2}>
        <Text dimColor>了解更多：https://code.claude.com/docs/en/data-usage#session-quality-surveys</Text>
      </Box>

      <Box marginLeft={2}>
        <Box width={10}>
          <Text>
            <Text color="ansi:cyan">1</Text>: 可以
          </Text>
        </Box>
        <Box width={10}>
          <Text>
            <Text color="ansi:cyan">2</Text>: 不行
          </Text>
        </Box>
        <Box>
          <Text>
            <Text color="ansi:cyan">3</Text>: 不再询问
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
