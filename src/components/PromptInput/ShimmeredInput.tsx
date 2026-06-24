import * as React from 'react';
import { Ansi, Box, Text, useAnimationFrame } from '@anthropic/ink';
import { segmentTextByHighlights, type TextHighlight } from '../../utils/textHighlighting.js';
import { ShimmerChar } from '../Spinner/ShimmerChar.js';

type Props = {
  text: string;
  highlights: TextHighlight[];
};

type LinePart = {
  text: string;
  highlight: TextHighlight | undefined;
  start: number;
};

export function HighlightedInput({ text, highlights }: Props): React.ReactNode {
  // 当 ultrathink 关键字存在时，下方的闪光动画会以 20fps 速率重新渲染此组件。
  // text/highlights 在动画帧间引用稳定（父组件不会重新渲染），
  // 因此对所有派生值进行 memoize 处理：
  // segmentTextByHighlights 单次调用约 ~85µs（分词 + 排序 + O(n²) 重叠检测），
  // 以 20fps 运行时累积很快。
  const { lines, hasShimmer, sweepStart, cycleLength } = React.useMemo(() => {
    const segments = segmentTextByHighlights(text, highlights);

    // 按换行符将 segment 拆分为逐行组。Ink 的行方向 Box 会将多行子元素的续行
    // 缩进到该子元素的 X 偏移位置。通过在换行处拆分，每行独立渲染为一行，
    // 避免高亮文本后跟折行内容时出现错误缩进。
    const lines: LinePart[][] = [[]];
    let pos = 0;
    for (const segment of segments) {
      const parts = segment.text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push([]);
          pos += 1;
        }
        const part = parts[i]!;
        if (part.length > 0) {
          lines[lines.length - 1]!.push({
            text: part,
            highlight: segment.highlight,
            start: pos,
          });
        }
        pos += part.length;
      }
    }

    // 将扫光范围限定在闪光高亮区域，避免循环时长随输入长度增长。
    // 填充值在扫光之间制造屏外暂停效果。
    const hasShimmer = highlights.some(h => h.shimmerColor);
    let sweepStart = 0;
    let cycleLength = 1;
    if (hasShimmer) {
      const padding = 10;
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of highlights) {
        if (h.shimmerColor) {
          lo = Math.min(lo, h.start);
          hi = Math.max(hi, h.end);
        }
      }
      sweepStart = lo - padding;
      cycleLength = hi - lo + padding * 2;
    }

    return { lines, hasShimmer, sweepStart, cycleLength };
  }, [text, highlights]);

  const [ref, time] = useAnimationFrame(hasShimmer ? 50 : null);
  const glimmerIndex = hasShimmer ? sweepStart + (Math.floor(time / 50) % cycleLength) : -100;

  return (
    <Box ref={ref} flexDirection="column">
      {lines.map((lineParts, lineIndex) => (
        <Box key={lineIndex}>
          {lineParts.length === 0 ? (
            <Text> </Text>
          ) : (
            lineParts.map((part, partIndex) => {
              if (part.highlight?.shimmerColor && part.highlight.color) {
                return (
                  <Text key={partIndex}>
                    {part.text.split('').map((char, charIndex) => (
                      <ShimmerChar
                        key={charIndex}
                        char={char}
                        index={part.start + charIndex}
                        glimmerIndex={glimmerIndex}
                        messageColor={part.highlight!.color!}
                        shimmerColor={part.highlight!.shimmerColor!}
                      />
                    ))}
                  </Text>
                );
              }
              return (
                <Text
                  key={partIndex}
                  color={part.highlight?.color}
                  dimColor={part.highlight?.dimColor}
                  inverse={part.highlight?.inverse}
                >
                  <Ansi>{part.text}</Ansi>
                </Text>
              );
            })
          )}
        </Box>
      ))}
    </Box>
  );
}
