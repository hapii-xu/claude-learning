import { relative } from 'path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { DiagnosticTrackingService } from '../services/diagnosticTracking.js';
import type { Attachment } from '../utils/attachments.js';
import { getCwd } from '../utils/cwd.js';
import { CtrlOToExpand } from './CtrlOToExpand.js';
import { MessageResponse } from './MessageResponse.js';

type DiagnosticsAttachment = Extract<Attachment, { type: 'diagnostics' }>;

type DiagnosticsDisplayProps = {
  attachment: DiagnosticsAttachment;
  verbose: boolean;
};

export function DiagnosticsDisplay({ attachment, verbose }: DiagnosticsDisplayProps): React.ReactNode {
  // 仅当有诊断信息可报告时才显示
  if (attachment.files.length === 0) return null;

  // 统计问题总数
  const totalIssues = attachment.files.reduce((sum, file) => sum + file.diagnostics.length, 0);

  const fileCount = attachment.files.length;

  if (verbose) {
    // 详细模式下显示所有诊断信息（ctrl+o）
    return (
      <Box flexDirection="column">
        {attachment.files.map((file, fileIndex) => (
          <React.Fragment key={fileIndex}>
            <MessageResponse>
              <Text dimColor wrap="wrap">
                <Text bold>{relative(getCwd(), file.uri.replace('file://', '').replace('_claude_fs_right:', ''))}</Text>{' '}
                <Text dimColor>
                  {file.uri.startsWith('file://')
                    ? '(file://)'
                    : file.uri.startsWith('_claude_fs_right:')
                      ? '(claude_fs_right)'
                      : `(${file.uri.split(':')[0]})`}
                </Text>
                :
              </Text>
            </MessageResponse>
            {file.diagnostics.map((diagnostic, diagIndex) => (
              <MessageResponse key={diagIndex}>
                <Text dimColor wrap="wrap">
                  {'  '}
                  {DiagnosticTrackingService.getSeveritySymbol(diagnostic.severity)}
                  {' [行 '}
                  {diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}
                  {'] '}
                  {diagnostic.message}
                  {diagnostic.code ? ` [${diagnostic.code}]` : ''}
                  {diagnostic.source ? ` (${diagnostic.source})` : ''}
                </Text>
              </MessageResponse>
            ))}
          </React.Fragment>
        ))}
      </Box>
    );
  } else {
    // 普通模式下显示摘要
    return (
      <MessageResponse>
        <Text dimColor wrap="wrap">
          在 {fileCount} 个{fileCount === 1 ? '文件' : '文件'}中发现 <Text bold>{totalIssues}</Text> 个新诊断{' '}
          {totalIssues === 1 ? '问题' : '问题'} <CtrlOToExpand />
        </Text>
      </MessageResponse>
    );
  }
}
