import { useParams } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { useFileContent } from '@/hooks/useFileContent';
import { CodeViewer } from '@/components/code/CodeViewer';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { fetchFile } from '@/lib/api';
import { useEffect } from 'react';
import { ArrowRight, GitCompare, Search, X } from 'lucide-react';

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    mdx: 'mdx',
    css: 'css',
  };
  return langMap[ext] || 'text';
}

export function FileComparePage() {
  const { '*': splatPath } = useParams<{ '*': string }>();
  const parts = splatPath?.split('__compare__') || [];
  const leftPath = parts[0] || '';
  const rightPath = parts[1] || '';

  const [leftInput, setLeftInput] = useState(leftPath);
  const [rightInput, setRightInput] = useState(rightPath);
  const [compareLeft, setCompareLeft] = useState(leftPath);
  const [compareRight, setCompareRight] = useState(rightPath);

  const { data: leftData, loading: leftLoading } = useFileContent(compareLeft || null);
  const { data: rightData, loading: rightLoading } = useFileContent(compareRight || null);

  // 从 URL 参数初始化
  useEffect(() => {
    if (leftPath) setLeftInput(leftPath);
    if (rightPath) setRightInput(rightPath);
  }, [leftPath, rightPath]);

  const handleCompare = () => {
    setCompareLeft(leftInput);
    setCompareRight(rightInput);
    // 更新 URL
    if (leftInput && rightInput) {
      window.history.replaceState(null, '', `/compare/${leftInput}__compare__${rightInput}`);
    }
  };

  return (
    <div className="max-w-full mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <GitCompare className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">文件对比</h1>
          <p className="text-sm text-muted-foreground">左右分栏对比两个源文件</p>
        </div>
      </div>

      {/* Input bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-6 p-3 rounded-lg border bg-card">
        <Input
          value={leftInput}
          onChange={e => setLeftInput(e.target.value)}
          placeholder="左侧文件路径，如 src/query.ts"
          className="flex-1 font-mono text-sm"
          onKeyDown={e => e.key === 'Enter' && handleCompare()}
        />
        <ArrowRight className="size-4 text-muted-foreground shrink-0 mx-auto hidden sm:block" />
        <Input
          value={rightInput}
          onChange={e => setRightInput(e.target.value)}
          placeholder="右侧文件路径，如 src/QueryEngine.ts"
          className="flex-1 font-mono text-sm"
          onKeyDown={e => e.key === 'Enter' && handleCompare()}
        />
        <Button onClick={handleCompare} variant="brand" size="sm">
          <GitCompare className="size-3.5" />
          对比
        </Button>
      </div>

      {/* Quick compare suggestions */}
      {!compareLeft && !compareRight && (
        <div className="mb-6">
          <p className="text-sm text-muted-foreground mb-2">快速对比：</p>
          <div className="flex gap-2 flex-wrap">
            {[
              ['src/query.ts', 'src/QueryEngine.ts'],
              ['src/Tool.ts', 'src/tools.ts'],
              ['src/state/AppState.tsx', 'src/state/store.ts'],
              ['build.ts', 'vite.config.ts'],
            ].map(([a, b]) => (
              <button
                key={`${a}-${b}`}
                onClick={() => {
                  setLeftInput(a);
                  setRightInput(b);
                  setCompareLeft(a);
                  setCompareRight(b);
                }}
                className="flex items-center gap-1 text-xs rounded-md border bg-card px-2.5 py-1.5 hover:bg-accent hover:border-brand/40 transition-all"
              >
                <code className="font-mono">{a.split('/').pop()}</code>
                <ArrowRight className="size-3 text-muted-foreground" />
                <code className="font-mono">{b.split('/').pop()}</code>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Split pane */}
      {(compareLeft || compareRight) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left */}
          <div>
            {compareLeft ? (
              leftLoading ? (
                <div className="rounded-xl border bg-code-bg p-8 text-center text-muted-foreground">加载中...</div>
              ) : leftData ? (
                <CodeViewer code={leftData.content} language={getLanguage(compareLeft)} filePath={compareLeft} />
              ) : (
                <div className="rounded-xl border bg-code-bg p-8 text-center text-muted-foreground">
                  文件未找到: {compareLeft}
                </div>
              )
            ) : (
              <div className="rounded-xl border border-dashed bg-surface-1 p-12 text-center text-muted-foreground">
                输入左侧文件路径
              </div>
            )}
          </div>

          {/* Right */}
          <div>
            {compareRight ? (
              rightLoading ? (
                <div className="rounded-xl border bg-code-bg p-8 text-center text-muted-foreground">加载中...</div>
              ) : rightData ? (
                <CodeViewer code={rightData.content} language={getLanguage(compareRight)} filePath={compareRight} />
              ) : (
                <div className="rounded-xl border bg-code-bg p-8 text-center text-muted-foreground">
                  文件未找到: {compareRight}
                </div>
              )
            ) : (
              <div className="rounded-xl border border-dashed bg-surface-1 p-12 text-center text-muted-foreground">
                输入右侧文件路径
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
