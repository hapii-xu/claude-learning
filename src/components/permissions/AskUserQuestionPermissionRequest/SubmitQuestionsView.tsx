import figures from 'figures';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js';
import { Select } from '../../CustomSelect/index.js';
import { Divider } from '@anthropic/ink';
import { PermissionRequestTitle } from '../PermissionRequestTitle.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';

type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  allQuestionsAnswered: boolean;
  permissionResult: PermissionDecision;
  minContentHeight?: number;
  onFinalResponse: (value: 'submit' | 'cancel') => void;
};

export function SubmitQuestionsView({
  questions,
  currentQuestionIndex,
  answers,
  allQuestionsAnswered,
  permissionResult,
  minContentHeight,
  onFinalResponse,
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider color="inactive" />
      <Box flexDirection="column" borderTop borderColor="inactive" paddingTop={0}>
        <QuestionNavigationBar questions={questions} currentQuestionIndex={currentQuestionIndex} answers={answers} />
        <PermissionRequestTitle title="审阅你的回答" color="text" />
        <Box flexDirection="column" marginTop={1} minHeight={minContentHeight}>
          {!allQuestionsAnswered && (
            <Box marginBottom={1}>
              <Text color="warning">{figures.warning} 你还有问题未回答</Text>
            </Box>
          )}
          {Object.keys(answers).length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              {questions
                .filter((q: Question) => q?.question && answers[q.question])
                .map((q: Question) => {
                  const answer = answers[q?.question];

                  return (
                    <Box key={q?.question || 'answer'} flexDirection="column" marginLeft={1}>
                      <Text>
                        {figures.bullet} {q?.question || 'Question'}
                      </Text>
                      <Box marginLeft={2}>
                        <Text color="success">
                          {figures.arrowRight} {answer}
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          )}

          <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
          <Text color="inactive">准备提交你的回答？</Text>
          <Box marginTop={1}>
            <Select
              options={[
                {
                  type: 'text' as const,
                  label: '提交回答',
                  value: 'submit',
                },
                { type: 'text' as const, label: '取消', value: 'cancel' },
              ]}
              onChange={value => onFinalResponse(value as 'submit' | 'cancel')}
              onCancel={() => onFinalResponse('cancel')}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
