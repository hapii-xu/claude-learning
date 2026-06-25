import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { memo } from 'react';
import { useSettings } from '../hooks/useSettings.js';
import { Box, NoSelect, RawAnsi, useTheme } from '@anthropic/ink';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import sliceAnsi from '../utils/sliceAnsi.js';
import { expectColorDiff } from './StructuredDiff/colorDiff.js';
import { StructuredDiffFallback } from './StructuredDiff/Fallback.js';

type Props = {
  patch: StructuredPatchHunk;
  dim: boolean;
  filePath: string; // 文件路径，用于语言检测
  firstLine: string | null; // 文件首行，用于 shebang 检测
  fileContent?: string; // 完整文件内容，用于语法上下文（多行字符串等）
  width: number;
  skipHighlighting?: boolean; // 跳过语法高亮
};

// REPL.tsx 在两个互不重叠的树位置渲染 <Messages>（transcript 提前返回 vs
// 嵌套在 FullscreenLayout 中的 prompt 模式），所以 ctrl+o 会卸载/重新挂载
// 整个消息树，React 的 memo 缓存会丢失。把 NAPI 结果和预切分的 gutter/content
// 两列都保留在模块级，这样重新挂载时只需一次 WeakMap 查找加两个
// <ink-raw-ansi> 叶子节点 — 无需重新做语法高亮，也无需 N 次 sliceAnsi 调用 + 6N 个 Yoga 节点。
//
// PR #21439（全屏默认开启）使 gutterWidth>0 成为默认路径，
// 重新激活了 PR #20378 曾绕过的逐行 <DiffLine> 分支。
// 在此处缓存切分结果恢复了每个 diff O(1) 叶子节点的不变量。
type CachedRender = {
  lines: string[];
  // 两个 RawAnsi 列替代了原先 N 个 DiffLine 行。sliceAnsi 工作从每次
  // 重新挂载移到冷缓存一次性完成；parseToSpans 被完全消除
  //（RawAnsi 绕过了 Ansi 解析）。
  gutterWidth: number;
  gutters: string[] | null;
  contents: string[] | null;
};
const RENDER_CACHE = new WeakMap<StructuredPatchHunk, Map<string, CachedRender>>();

// gutter 宽度与 Rust 模块的布局一致：标记符 (1) + 空格 + 右对齐的
// 行号 (max_digits) + 空格。仅依赖于 patch 身份（WeakMap 的键），
// 因此可以与 NAPI 输出一起缓存。
function computeGutterWidth(patch: StructuredPatchHunk): number {
  const maxLineNumber = Math.max(patch.oldStart + patch.oldLines - 1, patch.newStart + patch.newLines - 1, 1);
  return maxLineNumber.toString().length + 3; // 标记符 + 2 个填充空格
}

function renderColorDiff(
  patch: StructuredPatchHunk,
  firstLine: string | null,
  filePath: string,
  fileContent: string | null,
  theme: string,
  width: number,
  dim: boolean,
  splitGutter: boolean,
): CachedRender | null {
  const ColorDiff = expectColorDiff();
  if (!ColorDiff) return null;

  // 防御性处理：若 gutter 会占满整个渲染宽度（窄终端），则跳过切分。
  // Rust 已经按 `width` 换行，所以单列输出仍然正确；我们只是失去 noSelect。
  // 若不这样做，sliceAnsi(line, gutterWidth) 会返回空内容，而
  // RawAnsi(width<=0) 是未测试行为。
  const rawGutterWidth = splitGutter ? computeGutterWidth(patch) : 0;
  const gutterWidth = rawGutterWidth > 0 && rawGutterWidth < width ? rawGutterWidth : 0;

  const key = `${theme}|${width}|${dim ? 1 : 0}|${gutterWidth}|${firstLine ?? ''}|${filePath}`;

  let perHunk = RENDER_CACHE.get(patch);
  const hit = perHunk?.get(key);
  if (hit) return hit;

  const lines = new ColorDiff(patch, firstLine, filePath, fileContent).render(theme, width, dim);
  if (lines === null) return null;

  // 预先切分 gutter 列（冷缓存时一次性完成）。sliceAnsi 会保留切分处的样式；
  // Rust 模块已将 gutter 填充至 gutterWidth，因此窄 RawAnsi 列的宽度与其单元格匹配。
  let gutters: string[] | null = null;
  let contents: string[] | null = null;
  if (gutterWidth > 0) {
    gutters = lines.map(l => sliceAnsi(l, 0, gutterWidth));
    contents = lines.map(l => sliceAnsi(l, gutterWidth));
  }

  const entry: CachedRender = { lines, gutterWidth, gutters, contents };

  if (!perHunk) {
    perHunk = new Map();
    RENDER_CACHE.set(patch, perHunk);
  }
  // 限制内部 map 的容量：width 是 key 的一部分，因此 diff 可见时调整终端
  // 大小会按不同宽度各累积一份完整渲染副本。四个变体（两种宽度 × dim 开关）
  // 已覆盖稳态；超过此数量说明用户正在主动调整，旧宽度已过期。
  if (perHunk.size >= 4) perHunk.clear();
  perHunk.set(key, entry);
  return entry;
}

export const StructuredDiff = memo(function StructuredDiff({
  patch,
  dim,
  filePath,
  firstLine,
  fileContent,
  width,
  skipHighlighting = false,
}: Props): React.ReactNode {
  const [theme] = useTheme();
  const settings = useSettings();
  const syntaxHighlightingDisabled = settings.syntaxHighlightingDisabled ?? false;

  // 确保 width 至少为 1，以防止 Rust NAPI 模块崩溃
  //（该模块期望 u32，无法处理负数）
  const safeWidth = Math.max(1, Math.floor(width));

  // 仅在全屏模式下切分出 noSelect gutter — 否则使用终端原生选区，
  // noSelect 无意义。两个分支现在重新挂载时都是每个 diff O(1) Yoga 叶子
  //（2 vs 1），所以这个门控只在全屏关闭时节省冷缓存 sliceAnsi 工作。
  const splitGutter = isFullscreenEnvEnabled();

  const cached =
    skipHighlighting || syntaxHighlightingDisabled
      ? null
      : renderColorDiff(patch, firstLine, filePath, fileContent ?? null, theme, safeWidth, dim, splitGutter);

  if (!cached) {
    return (
      <Box>
        <StructuredDiffFallback patch={patch} dim={dim} width={width} />
      </Box>
    );
  }

  const { lines, gutterWidth, gutters, contents } = cached;

  // 双列布局：gutter (noSelect) + content。NoSelect 将 Box 的计算边界
  // 标记为不可选；RawAnsi 的 measure 函数设置 rawHeight=lines.length，
  // 因此一个高叶子节点可获得与 N 个逐行 Box 相同的 noSelect 覆盖 ——
  // 而无需逐行 Yoga 开销。
  if (gutterWidth > 0 && gutters && contents) {
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge>
          <RawAnsi lines={gutters} width={gutterWidth} />
        </NoSelect>
        <RawAnsi lines={contents} width={safeWidth - gutterWidth} />
      </Box>
    );
  }

  return (
    <Box>
      <RawAnsi lines={lines} width={safeWidth} />
    </Box>
  );
});
