import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text, Dialog } from '@anthropic/ink';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';

// 内联 require 打破了此文件原本会形成的循环依赖：
// sessionStorage → commands → exit → ExitFlow → 此处。所有调用点
// 都在回调内部，所以这个惰性 require 永远不会遇到 undefined 的 import。
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  onCancel?: () => void;
};

export function WorktreeExitDialog({ onDone, onCancel }: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();

  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // 检查是否有需要弹出的 commit
      if (worktreeSession) {
        // 获取 worktree 中不属于原分支的 commit
        const { stdout: commitsStr } = await execFileNoThrow('git', [
          'rev-list',
          '--count',
          `${worktreeSession.originalHeadCommit}..HEAD`,
        ]);
        const count = parseInt(commitsStr.trim(), 10) || 0;
        setCommitCount(count);

        // 如果没有更改也没有 commit，则静默清理
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree()
            .then(() => {
              process.chdir(worktreeSession.originalCwd);
              setCwd(worktreeSession.originalCwd);
              recordWorktreeExit();
              getPlansDirectory.cache.clear?.();
              setResultMessage('Worktree 已移除（无更改）');
            })
            .catch(error => {
              logForDebugging(`Failed to clean up worktree: ${error}`, {
                level: 'error',
              });
              setResultMessage('Worktree 清理失败，仍将退出');
            })
            .then(() => {
              setStatus('done');
            });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeSession]);

  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);

  if (!worktreeSession) {
    onDone('未找到活动的 worktree 会话', { display: 'system' });
    return null;
  }

  if (status === 'loading' || status === 'done') {
    return null;
  }

  async function handleSelect(value: string) {
    if (!worktreeSession) return;

    const hasTmux = Boolean(worktreeSession.tmuxSessionName);

    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(
          `Worktree 已保留。你的工作已保存在 ${worktreeSession.worktreePath}，位于分支 ${worktreeSession.worktreeBranch}。使用以下命令重新接入 tmux 会话：tmux attach -t ${worktreeSession.tmuxSessionName}`,
        );
      } else {
        setResultMessage(
          `Worktree 已保留。你的工作已保存在 ${worktreeSession.worktreePath}，位于分支 ${worktreeSession.worktreeBranch}`,
        );
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(
        `Worktree 已保留，位于 ${worktreeSession.worktreePath}，分支为 ${worktreeSession.worktreeBranch}。Tmux 会话已终止。`,
      );
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error',
        });
        setResultMessage('Worktree 清理失败，仍将退出');
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? ' Tmux 会话已终止。' : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(`Worktree 已移除。${commitCount} 个 commit 和未提交的更改已被丢弃。${tmuxNote}`);
      } else if (commitCount > 0) {
        setResultMessage(
          `Worktree 已移除。${worktreeSession.worktreeBranch} 分支上的 ${commitCount} 个 commit 已被丢弃。${tmuxNote}`,
        );
      } else if (changes.length > 0) {
        setResultMessage(`Worktree 已移除。未提交的更改已被丢弃。${tmuxNote}`);
      } else {
        setResultMessage(`Worktree 已移除。${tmuxNote}`);
      }
      setStatus('done');
    }
  }

  if (status === 'keeping') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在保留 worktree…</Text>
      </Box>
    );
  }

  if (status === 'removing') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在移除 worktree…</Text>
      </Box>
    );
  }

  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;

  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = `你在 ${branchName} 分支上有 ${changes.length} 个未提交的文件和 ${commitCount} 个 commit。如果移除，这些都会丢失。`;
  } else if (hasUncommitted) {
    subtitle = `你有 ${changes.length} 个未提交的文件。如果移除 worktree，这些将会丢失。`;
  } else if (hasCommits) {
    subtitle = `你在 ${branchName} 分支上有 ${commitCount} 个 commit。如果移除 worktree，该分支将被删除。`;
  } else {
    subtitle = '你正在一个 worktree 中工作。保留它以继续在那里工作，或移除它以进行清理。';
  }

  function handleCancel() {
    if (onCancel) {
      // 中止退出并返回会话
      onCancel();
      return;
    }
    // 回退：如果没有提供 onCancel，则把 Escape 当作"保留"处理
    void handleSelect('keep');
  }

  const removeDescription = hasUncommitted || hasCommits ? '所有更改和 commit 都将丢失。' : '清理 worktree 目录。';

  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);

  const options = hasTmuxSession
    ? [
        {
          label: '保留 worktree 和 tmux 会话',
          value: 'keep-with-tmux',
          description: `保留在 ${worktreeSession.worktreePath}。重新接入命令：tmux attach -t ${worktreeSession.tmuxSessionName}`,
        },
        {
          label: '保留 worktree，终止 tmux 会话',
          value: 'keep-kill-tmux',
          description: `将 worktree 保留在 ${worktreeSession.worktreePath}，终止 tmux 会话。`,
        },
        {
          label: '移除 worktree 和 tmux 会话',
          value: 'remove-with-tmux',
          description: removeDescription,
        },
      ]
    : [
        {
          label: '保留 worktree',
          value: 'keep',
          description: `保留在 ${worktreeSession.worktreePath}`,
        },
        {
          label: '移除 worktree',
          value: 'remove',
          description: removeDescription,
        },
      ];

  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';

  return (
    <Dialog title="正在退出 worktree 会话" subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>
  );
}
