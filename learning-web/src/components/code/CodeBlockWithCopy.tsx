import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

export function CodeBlockWithCopy({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-surface-2/80 hover:bg-surface-2 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-all"
        title={copied ? '已复制' : '复制代码'}
      >
        {copied ? <Check className="size-3.5 text-status-active" /> : <Copy className="size-3.5" />}
      </button>
      {children}
    </div>
  );
}
