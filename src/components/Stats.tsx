import { feature } from 'bun:bundle';
import { plot as asciichart } from 'asciichart';
import chalk from 'chalk';
import figures from 'figures';
import React, { Suspense, use, useCallback, useEffect, useMemo, useState } from 'react';
import stripAnsi from 'strip-ansi';
import type { CommandResultDisplay } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 原生 j/k/方向键统计导航
import {
  Ansi,
  applyColor,
  Box,
  Text,
  useInput,
  stringWidth as getStringWidth,
  type Color,
  Pane,
  Tab,
  Tabs,
  useTabHeaderFocus,
} from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getGlobalConfig } from '../utils/config.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import { generateHeatmap } from '../utils/heatmap.js';
import { renderModelName } from '../utils/model/model.js';
import { copyAnsiToClipboard } from '../utils/screenshotClipboard.js';
import {
  aggregateClaudeCodeStatsForRange,
  type ClaudeCodeStats,
  type DailyModelTokens,
  type StatsDateRange,
} from '../utils/stats.js';
import { resolveThemeSetting } from '../utils/systemTheme.js';
import { getTheme, themeColorToAnsi } from '../utils/theme.js';
import { Spinner } from './Spinner.js';

function formatPeakDay(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

type StatsResult = { type: 'success'; data: ClaudeCodeStats } | { type: 'error'; message: string } | { type: 'empty' };

const DATE_RANGE_LABELS: Record<StatsDateRange, string> = {
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  all: '全部时间',
};

const DATE_RANGE_ORDER: StatsDateRange[] = ['all', '7d', '30d'];

function getNextDateRange(current: StatsDateRange): StatsDateRange {
  const currentIndex = DATE_RANGE_ORDER.indexOf(current);
  return DATE_RANGE_ORDER[(currentIndex + 1) % DATE_RANGE_ORDER.length]!;
}

/**
 * 创建一个永不 reject 的统计加载 promise。
 * 始终加载全时间段的统计数据用于热力图。
 */
function createAllTimeStatsPromise(): Promise<StatsResult> {
  return aggregateClaudeCodeStatsForRange('all')
    .then((data): StatsResult => {
      if (!data || data.totalSessions === 0) {
        return { type: 'empty' };
      }
      return { type: 'success', data };
    })
    .catch((err): StatsResult => {
      const message = err instanceof Error ? err.message : '加载统计数据失败';
      return { type: 'error', message };
    });
}

export function Stats({ onClose }: Props): React.ReactNode {
  // 始终先加载全时间段统计（用于热力图）
  const allTimePromise = useMemo(() => createAllTimeStatsPromise(), []);

  return (
    <Suspense
      fallback={
        <Box marginTop={1}>
          <Spinner />
          <Text> 正在加载你的 Claude Code 统计…</Text>
        </Box>
      }
    >
      <StatsContent allTimePromise={allTimePromise} onClose={onClose} />
    </Suspense>
  );
}

type StatsContentProps = {
  allTimePromise: Promise<StatsResult>;
  onClose: Props['onClose'];
};

/**
 * 内部组件，使用 React 19 的 use() 读取 stats promise。
 * 加载全时间段统计时会挂起（suspend），之后处理日期范围切换时不再挂起。
 */
function StatsContent({ allTimePromise, onClose }: StatsContentProps): React.ReactNode {
  const allTimeResult = use(allTimePromise);
  const [dateRange, setDateRange] = useState<StatsDateRange>('all');
  const [statsCache, setStatsCache] = useState<Partial<Record<StatsDateRange, ClaudeCodeStats>>>({});
  const [isLoadingFiltered, setIsLoadingFiltered] = useState(false);
  const [activeTab, setActiveTab] = useState<'Overview' | 'Models'>('Overview');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  // 当日期范围变化时加载过滤后的统计（带缓存）
  useEffect(() => {
    if (dateRange === 'all') {
      return;
    }

    // 已缓存
    if (statsCache[dateRange]) {
      return;
    }

    let cancelled = false;
    setIsLoadingFiltered(true);

    aggregateClaudeCodeStatsForRange(dateRange)
      .then(data => {
        if (!cancelled) {
          setStatsCache(prev => ({ ...prev, [dateRange]: data }));
          setIsLoadingFiltered(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoadingFiltered(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dateRange, statsCache]);

  // 使用当前范围的缓存统计
  const displayStats =
    dateRange === 'all'
      ? allTimeResult.type === 'success'
        ? allTimeResult.data
        : null
      : (statsCache[dateRange] ?? (allTimeResult.type === 'success' ? allTimeResult.data : null));

  // 用于热力图的全时间段统计（始终使用全时间段）
  const allTimeStats = allTimeResult.type === 'success' ? allTimeResult.data : null;

  const handleClose = useCallback(() => {
    onClose('统计对话框已关闭', { display: 'system' });
  }, [onClose]);

  useKeybinding('confirm:no', handleClose, { context: 'Confirmation' });

  useInput((input, key) => {
    // 处理 ctrl+c 和 ctrl+d 以关闭对话框
    if (key.ctrl && (input === 'c' || input === 'd')) {
      onClose('统计对话框已关闭', { display: 'system' });
    }
    // 追踪 tab 切换
    if (key.tab) {
      setActiveTab(prev => (prev === 'Overview' ? 'Models' : 'Overview'));
    }
    // r 键循环切换日期范围
    if (input === 'r' && !key.ctrl && !key.meta) {
      setDateRange(getNextDateRange(dateRange));
    }
    // Ctrl+S 复制截图到剪贴板
    if (key.ctrl && input === 's' && displayStats) {
      void handleScreenshot(displayStats, activeTab, setCopyStatus);
    }
  });

  if (allTimeResult.type === 'error') {
    return (
      <Box marginTop={1}>
        <Text color="error">加载统计数据失败：{allTimeResult.message}</Text>
      </Box>
    );
  }

  if (allTimeResult.type === 'empty') {
    return (
      <Box marginTop={1}>
        <Text color="warning">暂无统计数据。开始使用 Claude Code 吧！</Text>
      </Box>
    );
  }

  if (!displayStats || !allTimeStats) {
    return (
      <Box marginTop={1}>
        <Spinner />
        <Text> 正在加载统计…</Text>
      </Box>
    );
  }

  return (
    <Pane color="claude">
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Tabs title="" color="claude" defaultTab="Overview">
          <Tab title="概览">
            <OverviewTab
              stats={displayStats}
              allTimeStats={allTimeStats}
              dateRange={dateRange}
              isLoading={isLoadingFiltered}
            />
          </Tab>
          <Tab title="模型">
            <ModelsTab stats={displayStats} dateRange={dateRange} isLoading={isLoadingFiltered} />
          </Tab>
        </Tabs>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          Esc 取消 · r 切换日期范围 · ctrl+s 复制
          {copyStatus ? ` · ${copyStatus}` : ''}
        </Text>
      </Box>
    </Pane>
  );
}

function DateRangeSelector({
  dateRange,
  isLoading,
}: {
  dateRange: StatsDateRange;
  isLoading: boolean;
}): React.ReactNode {
  return (
    <Box marginBottom={1} gap={1}>
      <Box>
        {DATE_RANGE_ORDER.map((range, i) => (
          <Text key={range}>
            {i > 0 && <Text dimColor> · </Text>}
            {range === dateRange ? (
              <Text bold color="claude">
                {DATE_RANGE_LABELS[range]}
              </Text>
            ) : (
              <Text dimColor>{DATE_RANGE_LABELS[range]}</Text>
            )}
          </Text>
        ))}
      </Box>
      {isLoading && <Spinner />}
    </Box>
  );
}

function OverviewTab({
  stats,
  allTimeStats,
  dateRange,
  isLoading,
}: {
  stats: ClaudeCodeStats;
  allTimeStats: ClaudeCodeStats;
  dateRange: StatsDateRange;
  isLoading: boolean;
}): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize();

  // 计算最常用模型和总 token 数
  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // 缓存 factoid，使其在切换 tab 时不会变化
  const factoid = useMemo(() => generateFunFactoid(stats, totalTokens), [stats, totalTokens]);

  // 根据所选日期范围计算天数
  const rangeDays = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : stats.totalDays;

  // 计算 shot 统计数据（仅 ant，由 feature flag 控制）
  let shotStatsData: {
    avgShots: string;
    buckets: { label: string; count: number; pct: number }[];
  } | null = null;
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution;
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    if (total > 0) {
      const totalShots = Object.entries(dist).reduce((s, [count, sessions]) => s + parseInt(count, 10) * sessions, 0);
      const bucket = (min: number, max?: number) =>
        Object.entries(dist)
          .filter(([k]) => {
            const n = parseInt(k, 10);
            return n >= min && (max === undefined || n <= max);
          })
          .reduce((s, [, v]) => s + v, 0);
      const pct = (n: number) => Math.round((n / total) * 100);
      const b1 = bucket(1, 1);
      const b2_5 = bucket(2, 5);
      const b6_10 = bucket(6, 10);
      const b11 = bucket(11);
      shotStatsData = {
        avgShots: (totalShots / total).toFixed(1),
        buckets: [
          { label: '1-shot', count: b1, pct: pct(b1) },
          { label: '2\u20135 shot', count: b2_5, pct: pct(b2_5) },
          { label: '6\u201310 shot', count: b6_10, pct: pct(b6_10) },
          { label: '11+ shot', count: b11, pct: pct(b11) },
        ],
      };
    }
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 活动热力图 - 始终显示全时间段数据 */}
      {allTimeStats.dailyActivity.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Ansi>{generateHeatmap(allTimeStats.dailyActivity, { terminalWidth })}</Ansi>
        </Box>
      )}

      {/* 日期范围选择器 */}
      <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />

      {/* 第 1 区：使用情况 */}
      <Box flexDirection="row" gap={4} marginBottom={1}>
        <Box flexDirection="column" width={28}>
          {favoriteModel && (
            <Text wrap="truncate">
              最常用模型：{' '}
              <Text color="claude" bold>
                {renderModelName(favoriteModel[0])}
              </Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            总 token 数：<Text color="claude">{formatNumber(totalTokens)}</Text>
          </Text>
        </Box>
      </Box>

      {/* 第 2 区：活动 - 第 1 行：会话数 | 最长会话 */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            会话数：<Text color="claude">{formatNumber(stats.totalSessions)}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          {stats.longestSession && (
            <Text wrap="truncate">
              最长会话：<Text color="claude">{formatDuration(stats.longestSession.duration)}</Text>
            </Text>
          )}
        </Box>
      </Box>

      {/* 第 2 行：活跃天数 | 最长连续天数 */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            活跃天数：<Text color="claude">{stats.activeDays}</Text>
            <Text color="subtle">/{rangeDays}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            最长连续：{' '}
            <Text color="claude" bold>
              {stats.streaks.longestStreak}
            </Text>{' '}
            {stats.streaks.longestStreak === 1 ? '天' : '天'}
          </Text>
        </Box>
      </Box>

      {/* 第 3 行：最活跃的一天 | 当前连续天数 */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          {stats.peakActivityDay && (
            <Text wrap="truncate">
              最活跃的一天：<Text color="claude">{formatPeakDay(stats.peakActivityDay)}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            当前连续：{' '}
            <Text color="claude" bold>
              {allTimeStats.streaks.currentStreak}
            </Text>{' '}
            {allTimeStats.streaks.currentStreak === 1 ? '天' : '天'}
          </Text>
        </Box>
      </Box>

      {/* Speculation 节省的时间（仅 ant） */}
      {process.env.USER_TYPE === 'ant' && stats.totalSpeculationTimeSavedMs > 0 && (
        <Box flexDirection="row" gap={4}>
          <Box flexDirection="column" width={28}>
            <Text wrap="truncate">
              Speculation 节省：<Text color="claude">{formatDuration(stats.totalSpeculationTimeSavedMs)}</Text>
            </Text>
          </Box>
        </Box>
      )}

      {/* Shot 统计（仅 ant） */}
      {shotStatsData && (
        <>
          <Box marginTop={1}>
            <Text>Shot 分布</Text>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[0]!.label}: <Text color="claude">{shotStatsData.buckets[0]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[0]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[1]!.label}: <Text color="claude">{shotStatsData.buckets[1]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[1]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[2]!.label}: <Text color="claude">{shotStatsData.buckets[2]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[2]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[3]!.label}: <Text color="claude">{shotStatsData.buckets[3]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[3]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                平均/会话：<Text color="claude">{shotStatsData.avgShots}</Text>
              </Text>
            </Box>
          </Box>
        </>
      )}

      {/* 趣味事实 */}
      {factoid && (
        <Box marginTop={1}>
          <Text color="suggestion">{factoid}</Text>
        </Box>
      )}
    </Box>
  );
}

// 著名书籍及其近似 token 数（字数 * ~1.3）
// 按 token 升序排列以便比较逻辑使用
// 书名保留英文原名（作品名）
const BOOK_COMPARISONS = [
  { name: 'The Little Prince', tokens: 22000 },
  { name: 'The Old Man and the Sea', tokens: 35000 },
  { name: 'A Christmas Carol', tokens: 37000 },
  { name: 'Animal Farm', tokens: 39000 },
  { name: 'Fahrenheit 451', tokens: 60000 },
  { name: 'The Great Gatsby', tokens: 62000 },
  { name: 'Slaughterhouse-Five', tokens: 64000 },
  { name: 'Brave New World', tokens: 83000 },
  { name: 'The Catcher in the Rye', tokens: 95000 },
  { name: "Harry Potter and the Philosopher's Stone", tokens: 103000 },
  { name: 'The Hobbit', tokens: 123000 },
  { name: '1984', tokens: 123000 },
  { name: 'To Kill a Mockingbird', tokens: 130000 },
  { name: 'Pride and Prejudice', tokens: 156000 },
  { name: 'Dune', tokens: 244000 },
  { name: 'Moby-Dick', tokens: 268000 },
  { name: 'Crime and Punishment', tokens: 274000 },
  { name: 'A Game of Thrones', tokens: 381000 },
  { name: 'Anna Karenina', tokens: 468000 },
  { name: 'Don Quixote', tokens: 520000 },
  { name: 'The Lord of the Rings', tokens: 576000 },
  { name: 'The Count of Monte Cristo', tokens: 603000 },
  { name: 'Les Misérables', tokens: 689000 },
  { name: 'War and Peace', tokens: 730000 },
];

// 会话时长的等价时间参考
const TIME_COMPARISONS = [
  { name: '一场 TED 演讲', minutes: 18 },
  { name: '一集《办公室》', minutes: 22 },
  { name: '听完 Abbey Road 专辑', minutes: 47 },
  { name: '一节瑜伽课', minutes: 60 },
  { name: '一场世界杯足球赛', minutes: 90 },
  { name: '一次半程马拉松（平均时长）', minutes: 120 },
  { name: '电影《盗梦空间》', minutes: 148 },
  { name: '看完《泰坦尼克号》', minutes: 195 },
  { name: '一次跨大西洋航班', minutes: 420 },
  { name: '一个完整的夜晚睡眠', minutes: 480 },
];

function generateFunFactoid(stats: ClaudeCodeStats, totalTokens: number): string {
  const factoids: string[] = [];

  if (totalTokens > 0) {
    const matchingBooks = BOOK_COMPARISONS.filter(book => totalTokens >= book.tokens);

    for (const book of matchingBooks) {
      const times = totalTokens / book.tokens;
      if (times >= 2) {
        factoids.push(`你使用的 token 数约为《${book.name}》的 ${Math.floor(times)} 倍`);
      } else {
        factoids.push(`你使用的 token 数与《${book.name}》相当`);
      }
    }
  }

  if (stats.longestSession) {
    const sessionMinutes = stats.longestSession.duration / (1000 * 60);
    for (const comparison of TIME_COMPARISONS) {
      const ratio = sessionMinutes / comparison.minutes;
      if (ratio >= 2) {
        factoids.push(`你最长的会话时长约为${comparison.name}的 ${Math.floor(ratio)} 倍`);
      }
    }
  }

  if (factoids.length === 0) {
    return '';
  }
  const randomIndex = Math.floor(Math.random() * factoids.length);
  return factoids[randomIndex]!;
}

function ModelsTab({
  stats,
  dateRange,
  isLoading,
}: {
  stats: ClaudeCodeStats;
  dateRange: StatsDateRange;
  isLoading: boolean;
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const [scrollOffset, setScrollOffset] = useState(0);
  const { columns: terminalWidth } = useTerminalSize();
  const VISIBLE_MODELS = 4; // 一次显示 4 个模型（每列 2 个）

  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );

  // 使用方向键处理滚动
  useInput(
    (_input, key) => {
      if (key.downArrow && scrollOffset < modelEntries.length - VISIBLE_MODELS) {
        setScrollOffset(prev => Math.min(prev + 2, modelEntries.length - VISIBLE_MODELS));
      }
      if (key.upArrow) {
        if (scrollOffset > 0) {
          setScrollOffset(prev => Math.max(prev - 2, 0));
        } else {
          focusHeader();
        }
      }
    },
    { isActive: !headerFocused },
  );

  if (modelEntries.length === 0) {
    return (
      <Box>
        <Text color="subtle">暂无模型使用数据</Text>
      </Box>
    );
  }

  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // 生成 token 使用图表 - 使用终端宽度做响应式 sizing
  const chartOutput = generateTokenChart(
    stats.dailyModelTokens,
    modelEntries.map(([model]) => model),
    terminalWidth,
  );

  // 获取可见模型并拆分为两列
  const visibleModels = modelEntries.slice(scrollOffset, scrollOffset + VISIBLE_MODELS);
  const midpoint = Math.ceil(visibleModels.length / 2);
  const leftModels = visibleModels.slice(0, midpoint);
  const rightModels = visibleModels.slice(midpoint);

  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < modelEntries.length - VISIBLE_MODELS;
  const showScrollHint = modelEntries.length > VISIBLE_MODELS;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Token 使用图表 */}
      {chartOutput && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>每日 Token 数</Text>
          <Ansi>{chartOutput.chart}</Ansi>
          <Text color="subtle">{chartOutput.xAxisLabels}</Text>
          <Box>
            {chartOutput.legend.map((item, i) => (
              <Text key={item.model}>
                {i > 0 ? ' · ' : ''}
                <Ansi>{item.coloredBullet}</Ansi> {item.model}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* 日期范围选择器 */}
      <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />

      {/* 模型明细 - 固定宽度的两列 */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={36}>
          {leftModels.map(([model, usage]) => (
            <ModelEntry key={model} model={model} usage={usage} totalTokens={totalTokens} />
          ))}
        </Box>
        <Box flexDirection="column" width={36}>
          {rightModels.map(([model, usage]) => (
            <ModelEntry key={model} model={model} usage={usage} totalTokens={totalTokens} />
          ))}
        </Box>
      </Box>

      {/* 滚动提示 */}
      {showScrollHint && (
        <Box marginTop={1}>
          <Text color="subtle">
            {canScrollUp ? figures.arrowUp : ' '} {canScrollDown ? figures.arrowDown : ' '} {scrollOffset + 1}-
            {Math.min(scrollOffset + VISIBLE_MODELS, modelEntries.length)} / 共 {modelEntries.length} 个模型（↑↓ 滚动）
          </Text>
        </Box>
      )}
    </Box>
  );
}

type ModelEntryProps = {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
};

function ModelEntry({ model, usage, totalTokens }: ModelEntryProps): React.ReactNode {
  const modelTokens = usage.inputTokens + usage.outputTokens;
  const percentage = ((modelTokens / totalTokens) * 100).toFixed(1);

  return (
    <Box flexDirection="column">
      <Text>
        {figures.bullet} <Text bold>{renderModelName(model)}</Text> <Text color="subtle">({percentage}%)</Text>
      </Text>
      <Text color="subtle">
        {'  '}输入：{formatNumber(usage.inputTokens)} · 输出：{formatNumber(usage.outputTokens)}
      </Text>
    </Box>
  );
}

type ChartLegend = {
  model: string;
  coloredBullet: string; // 使用 chalk 预着色的圆点
};

type ChartOutput = {
  chart: string;
  legend: ChartLegend[];
  xAxisLabels: string;
};

function generateTokenChart(
  dailyTokens: DailyModelTokens[],
  models: string[],
  terminalWidth: number,
): ChartOutput | null {
  if (dailyTokens.length < 2 || models.length === 0) {
    return null;
  }

  // Y 轴标签约占 6 个字符，再加一些 padding
  // 上限 ~52 以与热力图宽度对齐（1 年的数据）
  const yAxisWidth = 7;
  const availableWidth = terminalWidth - yAxisWidth;
  const chartWidth = Math.min(52, Math.max(20, availableWidth));

  // 将数据分配到可用的图表宽度上
  let recentData: DailyModelTokens[];
  if (dailyTokens.length >= chartWidth) {
    // 数据多于空间：取最近 N 天
    recentData = dailyTokens.slice(-chartWidth);
  } else {
    // 数据少于空间：通过重复每个点来扩展
    const repeatCount = Math.floor(chartWidth / dailyTokens.length);
    recentData = [];
    for (const day of dailyTokens) {
      for (let i = 0; i < repeatCount; i++) {
        recentData.push(day);
      }
    }
  }

  // 不同模型的调色板 - 使用主题颜色
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme));
  const colors = [themeColorToAnsi(theme.suggestion), themeColorToAnsi(theme.success), themeColorToAnsi(theme.warning)];

  // 为每个模型准备 series 数据
  const series: number[][] = [];
  const legend: ChartLegend[] = [];

  // 只显示前 3 个模型以保持图表可读
  const topModels = models.slice(0, 3);

  for (let i = 0; i < topModels.length; i++) {
    const model = topModels[i]!;
    const data = recentData.map(day => day.tokensByModel[model] || 0);

    // 只在存在实际数据时才纳入
    if (data.some(v => v > 0)) {
      series.push(data);
      // 使用与图表匹配的主题颜色
      const bulletColors = [theme.suggestion, theme.success, theme.warning];
      legend.push({
        model: renderModelName(model),
        coloredBullet: applyColor(figures.bullet, bulletColors[i % bulletColors.length] as Color),
      });
    }
  }

  if (series.length === 0) {
    return null;
  }

  const chart = asciichart(series, {
    height: 8,
    colors: colors.slice(0, series.length),
    format: (x: number) => {
      let label: string;
      if (x >= 1_000_000) {
        label = (x / 1_000_000).toFixed(1) + 'M';
      } else if (x >= 1_000) {
        label = (x / 1_000).toFixed(0) + 'k';
      } else {
        label = x.toFixed(0);
      }
      return label.padStart(6);
    },
  });

  // 生成带日期的 X 轴标签
  const xAxisLabels = generateXAxisLabels(recentData, recentData.length, yAxisWidth);

  return { chart, legend, xAxisLabels };
}

function generateXAxisLabels(data: DailyModelTokens[], _chartWidth: number, yAxisOffset: number): string {
  if (data.length === 0) return '';

  // 均匀显示 3-4 个日期标签，但要为最后一个标签留出空间
  const numLabels = Math.min(4, Math.max(2, Math.floor(data.length / 8)));
  // 不要使用最后一个位置 - 为标签文本留出空间
  const usableLength = data.length - 6; // 为最后一个标签预留 ~6 个字符（例如 "Dec 7"）
  const step = Math.floor(usableLength / (numLabels - 1)) || 1;

  const labelPositions: { pos: number; label: string }[] = [];

  for (let i = 0; i < numLabels; i++) {
    const idx = Math.min(i * step, data.length - 1);
    const date = new Date(data[idx]!.date);
    const label = date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    });
    labelPositions.push({ pos: idx, label });
  }

  // 构建带正确间距的标签字符串
  let result = ' '.repeat(yAxisOffset);
  let currentPos = 0;

  for (const { pos, label } of labelPositions) {
    const spaces = Math.max(1, pos - currentPos);
    result += ' '.repeat(spaces) + label;
    currentPos = pos + label.length;
  }

  return result;
}

// 截图功能
async function handleScreenshot(
  stats: ClaudeCodeStats,
  activeTab: 'Overview' | 'Models',
  setStatus: (status: string | null) => void,
): Promise<void> {
  setStatus('正在复制…');

  const ansiText = renderStatsToAnsi(stats, activeTab);
  const result = await copyAnsiToClipboard(ansiText);

  setStatus(result.success ? '已复制！' : '复制失败');

  // 2 秒后清除状态
  setTimeout(setStatus, 2000, null);
}

function renderStatsToAnsi(stats: ClaudeCodeStats, activeTab: 'Overview' | 'Models'): string {
  const lines: string[] = [];

  if (activeTab === 'Overview') {
    lines.push(...renderOverviewToAnsi(stats));
  } else {
    lines.push(...renderModelsToAnsi(stats));
  }

  // 去除尾部空行
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1]!).trim() === '') {
    lines.pop();
  }

  // 在最后一行右对齐添加 "/stats"
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]!;
    const lastLineLen = getStringWidth(lastLine);
    // 根据布局使用已知的内容宽度：
    // Overview：两列统计 = COL2_START(40) + COL2_LABEL_WIDTH(18) + max_value(~12) = 70
    // Models：图表宽度 = 80
    const contentWidth = activeTab === 'Overview' ? 70 : 80;
    const statsLabel = '/stats';
    const padding = Math.max(2, contentWidth - lastLineLen - statsLabel.length);
    lines[lines.length - 1] = lastLine + ' '.repeat(padding) + chalk.gray(statsLabel);
  }

  return lines.join('\n');
}

function renderOverviewToAnsi(stats: ClaudeCodeStats): string[] {
  const lines: string[] = [];
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme));
  const h = (text: string) => applyColor(text, theme.claude as Color);

  // 带固定间距的双列助手
  // 列 1：label（18 字符）+ value + padding 到列 2
  // 列 2 从字符位置 40 开始
  const COL1_LABEL_WIDTH = 18;
  const COL2_START = 40;
  const COL2_LABEL_WIDTH = 18;

  const row = (l1: string, v1: string, l2: string, v2: string): string => {
    // 构建列 1：label + value
    const label1 = (l1 + ':').padEnd(COL1_LABEL_WIDTH);
    const col1PlainLen = label1.length + v1.length;

    // 计算列 1 value 与列 2 label 之间需要的空格数
    const spaceBetween = Math.max(2, COL2_START - col1PlainLen);

    // 构建列 2：label + value
    const label2 = (l2 + ':').padEnd(COL2_LABEL_WIDTH);

    // 组装，颜色只应用到 value 上
    return label1 + h(v1) + ' '.repeat(spaceBetween) + label2 + h(v2);
  };

  // 热力图 - 截图使用固定宽度（56 = 52 周 + 4 个日标签）
  if (stats.dailyActivity.length > 0) {
    lines.push(generateHeatmap(stats.dailyActivity, { terminalWidth: 56 }));
    lines.push('');
  }

  // 计算各项数值
  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // Row 1: Favorite model | Total tokens
  if (favoriteModel) {
    lines.push(row('最常用模型', renderModelName(favoriteModel[0]), '总 token 数', formatNumber(totalTokens)));
  }
  lines.push('');

  // Row 2: Sessions | Longest session
  lines.push(
    row(
      '会话数',
      formatNumber(stats.totalSessions),
      '最长会话',
      stats.longestSession ? formatDuration(stats.longestSession.duration) : '无',
    ),
  );

  // Row 3: Current streak | Longest streak
  const currentStreakVal = `${stats.streaks.currentStreak} 天`;
  const longestStreakVal = `${stats.streaks.longestStreak} 天`;
  lines.push(row('当前连续', currentStreakVal, '最长连续', longestStreakVal));

  // Row 4: Active days | Peak hour
  const activeDaysVal = `${stats.activeDays}/${stats.totalDays}`;
  const peakHourVal =
    stats.peakActivityHour !== null ? `${stats.peakActivityHour}:00-${stats.peakActivityHour + 1}:00` : '无';
  lines.push(row('活跃天数', activeDaysVal, '高峰时段', peakHourVal));

  // Speculation time saved (ant-only)
  if (process.env.USER_TYPE === 'ant' && stats.totalSpeculationTimeSavedMs > 0) {
    const label = 'Speculation 节省：'.padEnd(COL1_LABEL_WIDTH);
    lines.push(label + h(formatDuration(stats.totalSpeculationTimeSavedMs)));
  }

  // Shot stats (ant-only)
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution;
    const totalWithShots = Object.values(dist).reduce((s, n) => s + n, 0);
    if (totalWithShots > 0) {
      const totalShots = Object.entries(dist).reduce((s, [count, sessions]) => s + parseInt(count, 10) * sessions, 0);
      const avgShots = (totalShots / totalWithShots).toFixed(1);
      const bucket = (min: number, max?: number) =>
        Object.entries(dist)
          .filter(([k]) => {
            const n = parseInt(k, 10);
            return n >= min && (max === undefined || n <= max);
          })
          .reduce((s, [, v]) => s + v, 0);
      const pct = (n: number) => Math.round((n / totalWithShots) * 100);
      const fmtBucket = (count: number, p: number) => `${count} (${p}%)`;
      const b1 = bucket(1, 1);
      const b2_5 = bucket(2, 5);
      const b6_10 = bucket(6, 10);
      const b11 = bucket(11);
      lines.push('');
      lines.push('Shot \u5206\u5e03');
      lines.push(row('1-shot', fmtBucket(b1, pct(b1)), '2\u20135 shot', fmtBucket(b2_5, pct(b2_5))));
      lines.push(row('6\u201310 shot', fmtBucket(b6_10, pct(b6_10)), '11+ shot', fmtBucket(b11, pct(b11))));
      lines.push(`${'\u5e73\u5747/\u4f1a\u8bdd\uff1a'.padEnd(COL1_LABEL_WIDTH)}${h(avgShots)}`);
    }
  }

  lines.push('');

  // Fun factoid
  const factoid = generateFunFactoid(stats, totalTokens);
  lines.push(h(factoid));
  lines.push(chalk.gray(`\u6700\u8fd1 ${stats.totalDays} \u5929\u7684\u7edf\u8ba1`));

  return lines;
}

function renderModelsToAnsi(stats: ClaudeCodeStats): string[] {
  const lines: string[] = [];

  const modelEntries = Object.entries(stats.modelUsage).sort(
    ([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );

  if (modelEntries.length === 0) {
    lines.push(chalk.gray('暂无模型使用数据'));
    return lines;
  }

  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // Generate chart if we have data - use fixed width for screenshot
  const chartOutput = generateTokenChart(
    stats.dailyModelTokens,
    modelEntries.map(([model]) => model),
    80, // Fixed width for screenshot
  );

  if (chartOutput) {
    lines.push(chalk.bold('每日 Token 数'));
    lines.push(chartOutput.chart);
    lines.push(chalk.gray(chartOutput.xAxisLabels));
    // Legend - use pre-colored bullets from chart output
    const legendLine = chartOutput.legend.map(item => `${item.coloredBullet} ${item.model}`).join(' · ');
    lines.push(legendLine);
    lines.push('');
  }

  // Summary
  lines.push(
    `${figures.star} 最常用：${chalk.magenta.bold(renderModelName(favoriteModel?.[0] || ''))} · ${figures.circle} 总计：${chalk.magenta(formatNumber(totalTokens))} tokens`,
  );
  lines.push('');

  // Model breakdown - only show top 3 for screenshot
  const topModels = modelEntries.slice(0, 3);
  for (const [model, usage] of topModels) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const percentage = ((modelTokens / totalTokens) * 100).toFixed(1);
    lines.push(`${figures.bullet} ${chalk.bold(renderModelName(model))} ${chalk.gray(`(${percentage}%)`)}`);
    lines.push(chalk.dim(`  输入：${formatNumber(usage.inputTokens)} · 输出：${formatNumber(usage.outputTokens)}`));
  }

  return lines;
}
