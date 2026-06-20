import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js';
import { checkOverageGate, confirmOverage, launchRemoteReview } from './reviewRemote.js';
import { UltrareviewOverageDialog } from './UltrareviewOverageDialog.js';

function contentBlocksToString(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

async function launchAndDone(
  args: string,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: LocalJSXCommandOnDone,
  billingNote: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await launchRemoteReview(args, context, billingNote);
  // 用户在约 5 秒启动过程中按下了 Escape — 对话框已经显示
  // "cancelled" 并卸载，因此跳过 onDone（否则会写入一个已失效的
  // transcript slot），并让调用方跳过 confirmOverage。
  if (signal?.aborted) return;
  if (result) {
    onDone(contentBlocksToString(result), { shouldQuery: true });
  } else {
    // Precondition 失败现在已在上方返回具体的 ContentBlockParam[]。
    // 到这里为 null 仅可能发生在 teleport 失败（PR 模式）或非 github
    // repo — 两者都是 CCR/repo 连接性问题。
    onDone('Ultrareview failed to launch the remote session. Check that this is a GitHub repo and try again.', {
      display: 'system',
    });
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const gate = await checkOverageGate();

  if (gate.kind === 'not-enabled') {
    onDone('Free ultrareviews used. Enable Extra Usage at https://claude.ai/settings/billing to continue.', {
      display: 'system',
    });
    return null;
  }

  if (gate.kind === 'low-balance') {
    onDone(
      `Balance too low to launch ultrareview ($${gate.available.toFixed(2)} available, $10 minimum). Top up at https://claude.ai/settings/billing`,
      { display: 'system' },
    );
    return null;
  }

  if (gate.kind === 'needs-confirm') {
    return (
      <UltrareviewOverageDialog
        onProceed={async signal => {
          await launchAndDone(args, context, onDone, ' This review bills as Extra Usage.', signal);
          // 仅在非中断的启动之后才持久化确认 flag —
          // 否则启动过程中按 Escape 会使 flag 保持设置状态，
          // 从而在下一次尝试时跳过该对话框。
          if (!signal.aborted) confirmOverage();
        }}
        onCancel={() => onDone('Ultrareview cancelled.', { display: 'system' })}
      />
    );
  }

  // gate.kind === 'proceed'
  await launchAndDone(args, context, onDone, gate.billingNote);
  return null;
};
