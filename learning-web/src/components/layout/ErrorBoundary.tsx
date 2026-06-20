import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Home, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-lg mx-auto px-6 py-20 text-center animate-fade-up">
          <div className="size-16 rounded-2xl bg-status-error/10 flex items-center justify-center mx-auto mb-6">
            <AlertTriangle className="size-8 text-status-error" />
          </div>
          <h1 className="text-xl font-semibold text-foreground mb-2">页面出错了</h1>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
            {this.state.error?.message || '发生了未知错误'}
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={() => this.setState({ hasError: false, error: null })}>
              <RotateCcw className="size-3.5" />
              重试
            </Button>
            <Button variant="brand" asChild>
              <Link to="/">
                <Home className="size-3.5" />
                返回首页
              </Link>
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
