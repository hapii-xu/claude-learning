import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import React, { Suspense, use, useCallback, useMemo, useRef, useState } from 'react';
import { useSettings } from '../../../hooks/useSettings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth, useTheme } from '@anthropic/ink';
import { useKeybindings } from '../../../keybindings/useKeybinding.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { AskUserQuestionTool } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js';
import type { PastedContent } from '../../../utils/config.js';
import type { ImageDimensions } from '../../../utils/imageResizer.js';
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js';
import { logError } from '../../../utils/log.js';
import { applyMarkdown } from '../../../utils/markdown.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { getPlanFilePath } from '../../../utils/plans.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { QuestionView } from './QuestionView.js';
import { SubmitQuestionsView } from './SubmitQuestionsView.js';
import { useMultipleChoiceState } from './use-multiple-choice-state.js';

const MIN_CONTENT_HEIGHT = 12;
const MIN_CONTENT_WIDTH = 40;
// 内容区域周围的 chrome 占用行数（导航栏、标题、footer、帮助文本等）
const CONTENT_CHROME_OVERHEAD = 15;

export function AskUserQuestionPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    return <AskUserQuestionPermissionRequestBody {...props} highlight={null} />;
  }
  return (
    <Suspense fallback={<AskUserQuestionPermissionRequestBody {...props} highlight={null} />}>
      <AskUserQuestionWithHighlight {...props} />
    </Suspense>
  );
}

function AskUserQuestionWithHighlight(props: PermissionRequestProps): React.ReactNode {
  const highlight = use(getCliHighlightPromise());
  return <AskUserQuestionPermissionRequestBody {...props} highlight={highlight} />;
}

function AskUserQuestionPermissionRequestBody({
  toolUseConfirm,
  onDone,
  onReject,
  highlight,
}: PermissionRequestProps & {
  highlight: CliHighlight | null;
}): React.ReactNode {
  // memo 化解析结果：safeParse 每次调用都返回新对象（和新 `questions`
  // 数组）。若不 memo，下方渲染体中的 ref 写入会使 React Compiler 跳过此
  // 组件，导致没有任何自动 memo 化——`questions` 每次渲染都换标识，
  // `globalContentHeight` useMemo（对每个预览运行 applyMarkdown）永远
  // 命中不了缓存。`toolUseConfirm.input` 在对话框生命周期内稳定
  // （此工具直接返回 `behavior: 'ask'`，从不经过分类器）。
  const result = useMemo(() => AskUserQuestionTool.inputSchema.safeParse(toolUseConfirm.input), [toolUseConfirm.input]);
  const questions = result.success ? result.data.questions || [] : [];
  const { rows: terminalRows } = useTerminalSize();
  const [theme] = useTheme();

  // 为所有问题计算一致的内容尺寸，防止布局抖动。
  // globalContentHeight 表示 nav/title 下方内容区域的总高度，
  // 包含 footer 和帮助文本，使所有视图（问题、预览、提交）保持一致。
  const { globalContentHeight, globalContentWidth } = useMemo(() => {
    let maxHeight = 0;
    let maxWidth = 0;

    // footer（分隔线 + "Chat about this" + 可选 plan）+ 帮助文本 ≈ 7 行
    const FOOTER_HELP_LINES = 7;

    // 上限为终端高度减去 chrome 开销，但确保至少为 MIN_CONTENT_HEIGHT
    const maxAllowedHeight = Math.max(MIN_CONTENT_HEIGHT, terminalRows - CONTENT_CHROME_OVERHEAD);

    // PREVIEW_OVERHEAD 与 PreviewQuestionView.tsx 中的常量一致——内容
    // 区域内非预览元素（外边距、边框、备注、footer、帮助文本）占用的
    // 行数。此处用于截断预览内容上限，使 globalContentHeight 反映的是
    // 截断后高度，而非原始高度。
    const PREVIEW_OVERHEAD = 11;

    for (const q of questions) {
      const hasPreview = q.options.some(opt => opt.preview);

      if (hasPreview) {
        // 计算截断后实际会显示的最大预览内容行数，
        // 与 PreviewQuestionView 中的逻辑保持一致。
        const maxPreviewContentLines = Math.max(1, maxAllowedHeight - PREVIEW_OVERHEAD);

        // 对于带预览的问题，总高度 = 并排高度 + footer/help
        // 并排高度 = max(左面板, 右面板)
        // 右面板 = 预览框（内容 + 边框 + 截断指示器）+ 备注
        let maxPreviewBoxHeight = 0;
        for (const opt of q.options) {
          if (opt.preview) {
            // 测量渲染后的 markdown（与 PreviewBox 同一转换），使
            // 行数和宽度与实际显示一致。
            // applyMarkdown 会移除代码围栏标记、粗体/斜体语法等。
            const rendered = applyMarkdown(opt.preview, theme, highlight);
            const previewLines = rendered.split('\n');
            const isTruncated = previewLines.length > maxPreviewContentLines;
            const displayedLines = isTruncated ? maxPreviewContentLines : previewLines.length;
            // 预览框：显示内容 + 截断指示器 + 2 行边框
            maxPreviewBoxHeight = Math.max(maxPreviewBoxHeight, displayedLines + (isTruncated ? 1 : 0) + 2);
            for (const line of previewLines) {
              maxWidth = Math.max(maxWidth, stringWidth(line));
            }
          }
        }
        // 右面板：预览框 + 备注（含外边距共 2 行）
        const rightPanelHeight = maxPreviewBoxHeight + 2;
        // 左面板：选项 + 描述
        const leftPanelHeight = q.options.length + 2;
        const sideByHeight = Math.max(leftPanelHeight, rightPanelHeight);
        maxHeight = Math.max(maxHeight, sideByHeight + FOOTER_HELP_LINES);
      } else {
        // 对于常规问题：选项 + "Other" + footer/help
        maxHeight = Math.max(maxHeight, q.options.length + 3 + FOOTER_HELP_LINES);
      }
    }

    return {
      globalContentHeight: Math.min(Math.max(maxHeight, MIN_CONTENT_HEIGHT), maxAllowedHeight),
      globalContentWidth: Math.max(maxWidth, MIN_CONTENT_WIDTH),
    };
  }, [questions, terminalRows, theme, highlight]);
  const metadataSource = result.success ? result.data.metadata?.source : undefined;

  const [pastedContentsByQuestion, setPastedContentsByQuestion] = useState<
    Record<string, Record<number, PastedContent>>
  >({});
  const nextPasteIdRef = useRef(0);

  function onImagePaste(
    questionText: string,
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    _sourcePath?: string,
  ) {
    const pasteId = nextPasteIdRef.current++;
    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: base64Image,
      mediaType: mediaType || 'image/png',
      filename: filename || 'Pasted image',
      dimensions,
    };
    cacheImagePath(newContent);
    void storeImage(newContent);
    setPastedContentsByQuestion(prev => ({
      ...prev,
      [questionText]: { ...(prev[questionText] ?? {}), [pasteId]: newContent },
    }));
  }

  const onRemoveImage = useCallback((questionText: string, id: number) => {
    setPastedContentsByQuestion(prev => {
      const questionContents = { ...(prev[questionText] ?? {}) };
      delete questionContents[id];
      return { ...prev, [questionText]: questionContents };
    });
  }, []);

  const allImageAttachments = Object.values(pastedContentsByQuestion)
    .flatMap(contents => Object.values(contents))
    .filter(c => c.type === 'image');

  const toolPermissionContextMode = useAppState(s => s.toolPermissionContext.mode);
  const isInPlanMode = toolPermissionContextMode === 'plan';
  const planFilePath = isInPlanMode ? getPlanFilePath() : undefined;

  const state = useMultipleChoiceState();
  const {
    currentQuestionIndex,
    answers,
    questionStates,
    isInTextInput,
    nextQuestion,
    prevQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode,
  } = state;

  const currentQuestion = currentQuestionIndex < (questions?.length || 0) ? questions?.[currentQuestionIndex] : null;

  const isInSubmitView = currentQuestionIndex === (questions?.length || 0);
  const allQuestionsAnswered = questions?.every((q: Question) => q?.question && !!answers[q.question]) ?? false;

  // 当只有一个问题且为单选时隐藏提交标签页（自动提交场景）
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect;

  const handleCancel = useCallback(() => {
    // 如有元数据来源，记录拒绝事件
    if (metadataSource) {
      logEvent('tengu_ask_user_question_rejected', {
        source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        questionCount: questions.length,
        isInPlanMode,
        interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled(),
      });
    }
    onDone();
    onReject();
    toolUseConfirm.onReject();
  }, [onDone, onReject, toolUseConfirm, metadataSource, questions.length, isInPlanMode]);

  const handleRespondToClaude = useCallback(async () => {
    const questionsWithAnswers = questions
      .map((q: Question) => {
        const answer = answers[q.question];
        if (answer) {
          return `- "${q.question}"\n  Answer: ${answer}`;
        }
        return `- "${q.question}"\n  (No answer provided)`;
      })
      .join('\n');

    const feedback = `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:\n${questionsWithAnswers}`;

    if (metadataSource) {
      logEvent('tengu_ask_user_question_respond_to_claude', {
        source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        questionCount: questions.length,
        isInPlanMode,
        interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled(),
      });
    }

    const imageBlocks = await convertImagesToBlocks(allImageAttachments);

    onDone();
    toolUseConfirm.onReject(feedback, imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined);
  }, [questions, answers, onDone, toolUseConfirm, metadataSource, isInPlanMode, allImageAttachments]);

  const handleFinishPlanInterview = useCallback(async () => {
    const questionsWithAnswers = questions
      .map((q: Question) => {
        const answer = answers[q.question];
        if (answer) {
          return `- "${q.question}"\n  Answer: ${answer}`;
        }
        return `- "${q.question}"\n  (No answer provided)`;
      })
      .join('\n');

    const feedback = `The user has indicated they have provided enough answers for the plan interview.
Stop asking clarifying questions and proceed to finish the plan with the information you have.

Questions asked and answers provided:\n${questionsWithAnswers}`;

    if (metadataSource) {
      logEvent('tengu_ask_user_question_finish_plan_interview', {
        source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        questionCount: questions.length,
        isInPlanMode,
        interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled(),
      });
    }

    const imageBlocks = await convertImagesToBlocks(allImageAttachments);

    onDone();
    toolUseConfirm.onReject(feedback, imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined);
  }, [questions, answers, onDone, toolUseConfirm, metadataSource, isInPlanMode, allImageAttachments]);

  const submitAnswers = useCallback(
    async (answersToSubmit: Record<string, string>) => {
      // 如有元数据来源，记录接受事件
      if (metadataSource) {
        logEvent('tengu_ask_user_question_accepted', {
          source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          questionCount: questions.length,
          answerCount: Object.keys(answersToSubmit).length,
          isInPlanMode,
          interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled(),
        });
      }
      // 从 questionStates 构建标注（例如选中的预览、用户备注）
      const annotations: Record<string, { preview?: string; notes?: string }> = {};
      for (const q of questions) {
        const answer = answersToSubmit[q.question];
        const notes = questionStates[q.question]?.textInputValue;
        // 查找所选选项的预览内容
        const selectedOption = answer ? q.options.find(opt => opt.label === answer) : undefined;
        const preview = selectedOption?.preview;
        if (preview || notes?.trim()) {
          annotations[q.question] = {
            ...(preview && { preview }),
            ...(notes?.trim() && { notes: notes.trim() }),
          };
        }
      }

      const updatedInput = {
        ...toolUseConfirm.input,
        answers: answersToSubmit,
        ...(Object.keys(annotations).length > 0 && { annotations }),
      };

      const contentBlocks = await convertImagesToBlocks(allImageAttachments);

      onDone();
      toolUseConfirm.onAllow(
        updatedInput,
        [],
        undefined,
        contentBlocks && contentBlocks.length > 0 ? contentBlocks : undefined,
      );
    },
    [toolUseConfirm, onDone, metadataSource, questions, questionStates, isInPlanMode, allImageAttachments],
  );

  const handleQuestionAnswer = useCallback(
    (questionText: string, label: string | string[], textInput?: string, shouldAdvance: boolean = true) => {
      let answer: string;
      const isMultiSelect = Array.isArray(label);
      if (isMultiSelect) {
        answer = label.join(', ');
      } else {
        if (textInput) {
          const questionImages = Object.values(pastedContentsByQuestion[questionText] ?? {}).filter(
            c => c.type === 'image',
          );
          answer = questionImages.length > 0 ? `${textInput} (Image attached)` : textInput;
        } else if (label === '__other__') {
          // Image-only submission — check if this question has images
          const questionImages = Object.values(pastedContentsByQuestion[questionText] ?? {}).filter(
            c => c.type === 'image',
          );
          answer = questionImages.length > 0 ? '(Image attached)' : label;
        } else {
          answer = label;
        }
      }

      // 单选且只有一个问题时，自动提交而非显示审阅界面
      const isSingleQuestion = questions.length === 1;
      if (!isMultiSelect && isSingleQuestion && shouldAdvance) {
        const updatedAnswers = {
          ...answers,
          [questionText]: answer,
        };
        void submitAnswers(updatedAnswers).catch(logError);
        return;
      }

      setAnswer(questionText, answer, shouldAdvance);
    },
    [setAnswer, questions.length, answers, submitAnswers, pastedContentsByQuestion],
  );

  function handleFinalResponse(value: 'submit' | 'cancel'): void {
    if (value === 'cancel') {
      handleCancel();
      return;
    }

    if (value === 'submit') {
      void submitAnswers(answers).catch(logError);
    }
  }

  // 当提交标签页被隐藏时，不允许导航超过最后一个问题
  const maxIndex = hideSubmitTab ? (questions?.length || 1) - 1 : questions?.length || 0;

  // 问题标签页的有界导航回调
  const handleTabPrev = useCallback(() => {
    if (currentQuestionIndex > 0) {
      prevQuestion();
    }
  }, [currentQuestionIndex, prevQuestion]);

  const handleTabNext = useCallback(() => {
    if (currentQuestionIndex < maxIndex) {
      nextQuestion();
    }
  }, [currentQuestionIndex, maxIndex, nextQuestion]);

  // 使用快捷键系统进行问题导航（左右方向键、tab/shift+tab）
  // 直接使用 useInput 不起作用，因为快捷键系统会将左右方向键解析为
  // tabs:next/tabs:previous，并在 useInput 触发前可能调用
  // stopImmediatePropagation。子组件（如 PreviewQuestionView）也会注册
  // 自己的 tabs:next/tabs:previous 快捷键，以确保无论监听器顺序如何
  // 都能可靠处理。
  useKeybindings(
    {
      'tabs:previous': handleTabPrev,
      'tabs:next': handleTabNext,
    },
    { context: 'Tabs', isActive: !(isInTextInput && !isInSubmitView) },
  );

  if (currentQuestion) {
    return (
      <>
        <QuestionView
          question={currentQuestion}
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          questionStates={questionStates}
          hideSubmitTab={hideSubmitTab}
          minContentHeight={globalContentHeight}
          minContentWidth={globalContentWidth}
          planFilePath={planFilePath}
          onUpdateQuestionState={updateQuestionState}
          onAnswer={handleQuestionAnswer}
          onTextInputFocus={setTextInputMode}
          onCancel={handleCancel}
          onSubmit={nextQuestion}
          onTabPrev={handleTabPrev}
          onTabNext={handleTabNext}
          onRespondToClaude={handleRespondToClaude}
          onFinishPlanInterview={handleFinishPlanInterview}
          onImagePaste={(base64, mediaType, filename, dims, path) =>
            onImagePaste(currentQuestion.question, base64, mediaType, filename, dims, path)
          }
          pastedContents={pastedContentsByQuestion[currentQuestion.question] ?? {}}
          onRemoveImage={id => onRemoveImage(currentQuestion.question, id)}
        />
      </>
    );
  }

  if (isInSubmitView) {
    return (
      <>
        <SubmitQuestionsView
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          allQuestionsAnswered={allQuestionsAnswered}
          permissionResult={toolUseConfirm.permissionResult}
          minContentHeight={globalContentHeight}
          onFinalResponse={handleFinalResponse}
        />
      </>
    );
  }

  // 此处理不应被到达
  return null;
}

async function convertImagesToBlocks(images: PastedContent[]): Promise<ImageBlockParam[] | undefined> {
  if (images.length === 0) return undefined;
  return Promise.all(
    images.map(async img => {
      const block: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType || 'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      };
      const resized = await maybeResizeAndDownsampleImageBlock(block);
      return resized.block;
    }),
  );
}
