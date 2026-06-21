import { relative } from 'path';
import React, { useMemo } from 'react';
import { useDiffInIDE } from '../../../hooks/useDiffInIDE.js';
import { Box, Text } from '@anthropic/ink';
import type { ToolUseContext } from '../../../Tool.js';
import { getLanguageName } from '../../../utils/cliHighlight.js';
import { getCwd } from '../../../utils/cwd.js';
import { getFsImplementation, safeResolvePath } from '../../../utils/fsOperations.js';
import { expandPath } from '../../../utils/path.js';
import type { CompletionType } from '../../../utils/unaryLogging.js';
import { Select } from '../../CustomSelect/index.js';
import { ShowInIDEPrompt } from '../../ShowInIDEPrompt.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { ToolUseConfirm } from '../PermissionRequest.js';
import type { WorkerBadgeProps } from '../WorkerBadge.js';
import type { IDEDiffSupport } from './ideDiffConfig.js';
import type { FileOperationType, PermissionOption } from './permissionOptions.js';
import { type ToolInput, useFilePermissionDialog } from './useFilePermissionDialog.js';

export type FilePermissionDialogProps<T extends ToolInput = ToolInput> = {
  // 来自 PermissionRequestProps 的必填 props
  toolUseConfirm: ToolUseConfirm;
  toolUseContext: ToolUseContext;
  onDone: () => void;
  onReject: () => void;

  // 对话框定制
  title: string;
  subtitle?: React.ReactNode;
  question?: string | React.ReactNode;
  content?: React.ReactNode; // 可以是通用内容或 diff 组件

  // 日志记录
  completionType?: CompletionType;
  languageName?: string; // 覆盖值——未提供时根据路径推导

  // 文件/目录操作
  path: string | null;
  parseInput: (input: unknown) => T;
  operationType?: FileOperationType;

  // IDE diff 支持
  ideDiffSupport?: IDEDiffSupport<T>;

  // 用于 teammate 权限请求的 worker badge
  workerBadge: WorkerBadgeProps | undefined;
};

export function FilePermissionDialog<T extends ToolInput = ToolInput>({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  title,
  subtitle,
  question = 'Do you want to proceed?',
  content,
  completionType = 'tool_use_single',
  path,
  parseInput,
  operationType = 'write',
  ideDiffSupport,
  workerBadge,
  languageName: languageNameOverride,
}: FilePermissionDialogProps<T>): React.ReactNode {
  // 除非调用方提供了显式覆盖（NotebookEdit 从 cell_type 传入 'python'/'markdown'），
  // 否则从路径推导。getLanguageName 为异步；下游的 UnaryEvent.language_name
  // 和 logPermissionEvent 已支持 Promise<string>。useMemo 使 promise 在
  // 多次渲染间保持稳定。
  const languageName = useMemo(
    () => languageNameOverride ?? (path ? getLanguageName(path) : 'none'),
    [languageNameOverride, path],
  );
  const unaryEvent = useMemo(
    () => ({
      completion_type: completionType,
      language_name: languageName,
    }),
    [completionType, languageName],
  );
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  const symlinkTarget = useMemo(() => {
    if (!path || operationType === 'read') {
      return null;
    }
    const expandedPath = expandPath(path);
    const fs = getFsImplementation();
    const { resolvedPath, isSymlink } = safeResolvePath(fs, expandedPath);
    if (isSymlink) {
      return resolvedPath;
    }
    return null;
  }, [path, operationType]);

  const fileDialogResult = useFilePermissionDialog({
    filePath: path || '',
    completionType,
    languageName,
    toolUseConfirm,
    onDone,
    onReject,
    parseInput,
    operationType,
  });

  // 使用文件对话框结果作为选项
  const {
    options,
    acceptFeedback,
    rejectFeedback,
    setFocusedOption,
    handleInputModeToggle,
    focusedOption,
    yesInputMode,
    noInputMode,
  } = fileDialogResult;

  // 使用提供的解析器解析 input
  const parsedInput = parseInput(toolUseConfirm.input);

  // 若启用 IDE diff 支持则进行设置。已 memo：getConfig 可能有磁盘 I/O
  // （FileWrite 的 getConfig 调用 readFileSync 读取旧内容 diff）。
  // 以原始 input 为 key——parseInput 是纯 Zod 解析，结果仅依赖
  // toolUseConfirm.input。
  const ideDiffConfig = useMemo(
    () => (ideDiffSupport ? ideDiffSupport.getConfig(parseInput(toolUseConfirm.input)) : null),
    [ideDiffSupport, toolUseConfirm.input],
  );

  // 根据 IDE diff 是否可用创建 diff 参数
  const diffParams = ideDiffConfig
    ? {
        onChange: (
          option: PermissionOption,
          input: {
            file_path: string;
            edits: Array<{
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>;
          },
        ) => {
          const transformedInput = ideDiffSupport!.applyChanges(parsedInput, input.edits);
          fileDialogResult.onChange(option, transformedInput);
        },
        toolUseContext,
        filePath: ideDiffConfig.filePath,
        edits: (ideDiffConfig.edits || []).map(e => ({
          old_string: e.old_string,
          new_string: e.new_string,
          replace_all: e.replace_all || false,
        })),
        editMode: ideDiffConfig.editMode || 'single',
      }
    : {
        onChange: () => {},
        toolUseContext,
        filePath: '',
        edits: [],
        editMode: 'single' as const,
      };

  const { closeTabInIDE, showingDiffInIDE, ideName } = useDiffInIDE(diffParams);

  const onChange = (option: PermissionOption, feedback?: string) => {
    closeTabInIDE?.();
    fileDialogResult.onChange(option, parsedInput, feedback?.trim());
  };

  if (showingDiffInIDE && ideDiffConfig && path) {
    return (
      <ShowInIDEPrompt
        onChange={(option: PermissionOption, _input, feedback?: string) => onChange(option, feedback)}
        options={options}
        filePath={path}
        input={parsedInput}
        ideName={ideName}
        symlinkTarget={symlinkTarget}
        rejectFeedback={rejectFeedback}
        acceptFeedback={acceptFeedback}
        setFocusedOption={setFocusedOption}
        onInputModeToggle={handleInputModeToggle}
        focusedOption={focusedOption}
        yesInputMode={yesInputMode}
        noInputMode={noInputMode}
      />
    );
  }

  const isSymlinkOutsideCwd = symlinkTarget != null && relative(getCwd(), symlinkTarget).startsWith('..');

  const symlinkWarning = symlinkTarget ? (
    <Box paddingX={1} marginBottom={1}>
      <Text color="warning">
        {isSymlinkOutsideCwd
          ? `This will modify ${symlinkTarget} (outside working directory) via a symlink`
          : `Symlink target: ${symlinkTarget}`}
      </Text>
    </Box>
  ) : null;

  return (
    <>
      <PermissionDialog title={title} subtitle={subtitle} innerPaddingX={0} workerBadge={workerBadge}>
        {symlinkWarning}
        {content}
        <Box flexDirection="column" paddingX={1}>
          {typeof question === 'string' ? <Text>{question}</Text> : question}
          <Select
            options={options}
            inlineDescriptions
            onChange={value => {
              const selected = options.find(opt => opt.value === value);
              if (selected) {
                // 对于拒绝选项
                if (selected.option.type === 'reject') {
                  const trimmedFeedback = rejectFeedback.trim();
                  onChange(selected.option, trimmedFeedback || undefined);
                  return;
                }
                // 对于 accept-once 选项，若有 accept 反馈则传入
                if (selected.option.type === 'accept-once') {
                  const trimmedFeedback = acceptFeedback.trim();
                  onChange(selected.option, trimmedFeedback || undefined);
                  return;
                }
                onChange(selected.option);
              }
            }}
            onCancel={() => onChange({ type: 'reject' })}
            onFocus={value => setFocusedOption(value)}
            onInputModeToggle={handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to reject
          {((focusedOption === 'yes' && !yesInputMode) || (focusedOption === 'no' && !noInputMode)) &&
            ' · Tab to add feedback'}
        </Text>
      </Box>
    </>
  );
}
