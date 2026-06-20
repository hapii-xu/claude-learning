import { useState, useEffect, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';
import { Save, X, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CodeEditorProps {
  code: string;
  language?: string;
  filePath: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * 基于 CodeMirror 6 的文件编辑器
 * 支持语法高亮、行号、Ctrl+S 保存、主题切换
 */
export function CodeEditor({ code, language = 'typescript', filePath, onSave, onCancel }: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const [value, setValue] = useState(code);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // Detect language for CodeMirror
  const cmLang = useCallback(() => {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const isJsx = ext === 'tsx' || ext === 'jsx';
    const isTs = ext === 'ts' || ext === 'tsx';
    return javascript({ typescript: isTs, jsx: isJsx });
  }, [filePath]);

  // Track dirty state
  useEffect(() => {
    setDirty(value !== code);
  }, [value, code]);

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [value, saving]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleSave = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (dirty) {
      if (window.confirm('有未保存的修改，确定放弃？')) {
        onCancel();
      }
    } else {
      onCancel();
    }
  };

  const lineCount = value.split('\n').length;

  return (
    <div className="rounded-xl border bg-code-bg overflow-hidden flex flex-col" ref={editorRef}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-surface-1/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground truncate">{filePath}</span>
          {dirty && (
            <span className="text-[10px] text-status-warning bg-status-warning/10 px-1.5 py-0.5 rounded font-medium">
              未保存
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">{lineCount} lines</span>
        </div>

        <div className="flex items-center gap-1.5">
          {error && (
            <span className="flex items-center gap-1 text-[10px] text-status-error mr-2">
              <AlertCircle className="size-3" />
              {error}
            </span>
          )}

          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={handleCancel} disabled={saving}>
            <X className="size-3" />
            取消
          </Button>

          <Button
            size="sm"
            className={cn('h-7 px-3 text-xs gap-1', dirty ? '' : 'opacity-50')}
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            保存
          </Button>
        </div>
      </div>

      {/* CodeMirror editor */}
      <div className="flex-1 overflow-auto" style={{ maxHeight: 'calc(100vh - 12rem)' }}>
        <CodeMirror
          value={value}
          height="100%"
          minHeight="400px"
          theme={resolvedTheme === 'dark' ? oneDark : 'light'}
          extensions={[cmLang()]}
          onChange={val => setValue(val)}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightSpecialChars: true,
            foldGutter: true,
            drawSelection: true,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            rectangularSelection: true,
            crosshairCursor: false,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            closeBracketsKeymap: true,
            searchKeymap: true,
            foldKeymap: true,
            completionKeymap: true,
            lintKeymap: true,
          }}
        />
      </div>

      {/* Footer hint */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t bg-surface-1/30">
        <span className="text-[10px] text-muted-foreground">Ctrl+S 保存 · 支持代码折叠、自动补全、括号匹配</span>
        <span className="text-[10px] text-muted-foreground">{dirty ? '已修改' : '未修改'}</span>
      </div>
    </div>
  );
}
