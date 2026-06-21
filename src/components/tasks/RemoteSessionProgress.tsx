import React, { useRef } from 'react';
import type { RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { useSettings } from '../../hooks/useSettings.js';
import { Text, useAnimationFrame } from '@anthropic/ink';
import { count } from '../../utils/array.js';
import { getRainbowColor } from '../../utils/thinking.js';

const TICK_MS = 80;

type ReviewStage = NonNullable<NonNullable<RemoteAgentTaskState['reviewProgress']>['stage']>;

/**
 * 运行中 review 对应阶段的计数行。由单行 pill（下方）和
 * RemoteSessionDetailDialog 的 reviewCountsLine 共享，以避免两者不一致 —
 * 它们历史上曾对是否展示 refuted 计数、synthesizing 阶段叫什么产生分歧。
 *
 * 规范行为：文字标签（非 ✓/✗），refuted 为 0 时隐藏，
 * synthesizing 阶段使用 "deduping"（与详情对话框中的 STAGE_LABELS 一致）。
 */
export function formatReviewStageCounts(
  stage: ReviewStage | undefined,
  found: number,
  verified: number,
  refuted: number,
): string {
  // Pre-stage 的 orchestrator 镜像不会写入 stage 字段。
  if (!stage) return `${found} found · ${verified} verified`;
  if (stage === 'synthesizing') {
    const parts = [`${verified} verified`];
    if (refuted > 0) parts.push(`${refuted} refuted`);
    parts.push('deduping');
    return parts.join(' · ');
  }
  if (stage === 'verifying') {
    const parts = [`${found} found`, `${verified} verified`];
    if (refuted > 0) parts.push(`${refuted} refuted`);
    return parts.join(' · ');
  }
  // stage === 'finding'
  return found > 0 ? `${found} found` : 'finding';
}

// 逐字符的彩虹渐变，与 ultraplan 关键字相同的处理方式。
// phase 偏移让渐变循环 — 这样每一动画帧颜色会沿文本扫过，
// 而非静止不动。
function RainbowText({ text, phase = 0 }: { text: string; phase?: number }): React.ReactNode {
  return (
    <>
      {[...text].map((ch, i) => (
        <Text key={i} color={getRainbowColor(i + phase)}>
          {ch}
        </Text>
      ))}
    </>
  );
}

// 把计数平滑地逐帧递增到目标值，每帧 +1。与 SpinnerAnimationRow 中
// token 计数器相同的模式 — ref 在重新渲染间保持，动画时钟驱动 tick。
// 目标值跳变（2→5）会显示为 2→3→4→5 而非瞬变。当 `snap` 为真
// （减弱动画，或时钟冻结）时，跳过 tick 直接跳到目标值 —
// 否则冻结的 `time` 会让 ref 卡在初始值。
function useSmoothCount(target: number, time: number, snap: boolean): number {
  const displayed = useRef(target);
  const lastTick = useRef(time);
  if (snap || target < displayed.current) {
    displayed.current = target;
  } else if (target > displayed.current && time !== lastTick.current) {
    displayed.current += 1;
    lastTick.current = time;
  }
  return displayed.current;
}

function ReviewRainbowLine({ session }: { session: DeepImmutable<RemoteAgentTaskState> }): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const p = session.reviewProgress;
  const running = session.status === 'running';
  // 动画时钟仅在运行时走 — completed/failed 为静态。
  // 当用户偏好减弱动画时完全禁用。
  //
  // 故意丢弃 ref：此组件渲染在 <Text> 包裹器内部
  // （BackgroundTasksDialog、RemoteSessionDetailDialog），Ink 不能在 <Text>
  // 内嵌套 <Box>。丢弃 ref 意味着 useTerminalViewport 的 isVisible 保持为
  // true，因此即使滚出屏幕时钟仍会 tick — 对于单行 30 字符的行来说可接受。
  const [, time] = useAnimationFrame(running && !reducedMotion ? TICK_MS : null);

  const targetFound = p?.bugsFound ?? 0;
  const targetVerified = p?.bugsVerified ?? 0;
  const targetRefuted = p?.bugsRefuted ?? 0;
  // 当时钟不走时（减弱动画，或不在运行）snap — useAnimationFrame(null) 会把
  // `time` 冻结在挂载值，这会让 tick-gate 永远为 false。
  const snap = reducedMotion || !running;
  const found = useSmoothCount(targetFound, time, snap);
  const verified = useSmoothCount(targetVerified, time, snap);
  const refuted = useSmoothCount(targetRefuted, time, snap);

  // phase 每 3 个 tick 推进一次，让渐变扫光可见但不狂躁。
  // 取模让它保持在 7 色循环内。
  const phase = Math.floor(time / (TICK_MS * 3)) % 7;

  // ◇ 运行中为空心菱形（青色，匹配 cloud-session 强调色），◆
  // 终态时为实心。彩虹仅作用于 `ultrareview` 这个词 —
  // 根据设计反馈，"闪闪彩虹也要有度"。
  // 计数保持 dimColor。
  if (session.status === 'completed') {
    return (
      <>
        <Text color="background">{DIAMOND_FILLED} </Text>
        <RainbowText text="ultrareview" phase={0} />
        <Text dimColor> ready · shift+↓ to view</Text>
      </>
    );
  }
  if (session.status === 'failed') {
    return (
      <>
        <Text color="background">{DIAMOND_FILLED} </Text>
        <RainbowText text="ultrareview" phase={0} />
        <Text color="error" dimColor>
          {' · '}
          error
        </Text>
      </>
    );
  }

  // !p 分支（"setting up"）覆盖 orchestrator 写入首个进度快照之前的窗口 —
  // 容器启动 + 仓库 clone 可能需要 1-3 分钟，期间显示 "0 found" 看起来像卡住。
  const tail = !p ? 'setting up' : formatReviewStageCounts(p.stage, found, verified, refuted);
  return (
    <>
      <Text color="background">{DIAMOND_OPEN} </Text>
      <RainbowText text="ultrareview" phase={running ? phase : 0} />
      <Text dimColor> · {tail}</Text>
    </>
  );
}

export function RemoteSessionProgress({ session }: { session: DeepImmutable<RemoteAgentTaskState> }): React.ReactNode {
  // Lite-review：整行彩虹渐变，ultraplan 风格。
  // BackgroundTask.tsx 把整个 <Text> 包裹器委托给这里，以便渐变覆盖
  // title，而不仅是尾部的状态。
  if (session.isRemoteReview) {
    return <ReviewRainbowLine session={session} />;
  }

  if (session.status === 'completed') {
    return (
      <Text bold color="success" dimColor>
        done
      </Text>
    );
  }

  if (session.status === 'failed') {
    return (
      <Text bold color="error" dimColor>
        error
      </Text>
    );
  }

  if (!session.todoList.length) {
    return <Text dimColor>{session.status}…</Text>;
  }

  const completed = count(session.todoList, _ => _.status === 'completed');
  const total = session.todoList.length;
  return (
    <Text dimColor>
      {completed}/{total}
    </Text>
  );
}
