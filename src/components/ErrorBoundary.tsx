/**
 * React error boundary — catches render/lifecycle errors in any child subtree
 * and renders a recovery UI instead of a blank page crash.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <Outlet />
 *   </ErrorBoundary>
 *
 * The boundary resets when the user clicks "Try again" or navigates away
 * (key prop driven by route location).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Optional custom fallback. Receives error + reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console for now; swap for a real error-reporting service later.
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (fallback) return fallback(error, this.reset);

      return (
        <div className="flex flex-1 flex-col items-center justify-center min-h-[60vh] px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 mb-4">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-1">Something went wrong</h2>
          <p className="text-sm text-ink-soft max-w-sm mb-6">
            An unexpected error occurred in this section. Your data is safe — this is a display issue.
          </p>
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={this.reset}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald text-paper px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
            <button
              onClick={() => window.location.assign("/app")}
              className="text-sm text-ink-soft hover:text-foreground transition"
            >
              Go to dashboard
            </button>
          </div>
          {/* Error detail — collapsed, for debugging */}
          <details className="mt-6 max-w-lg w-full text-left">
            <summary className="cursor-pointer text-xs text-ink-soft hover:text-foreground">
              Error details
            </summary>
            <pre className="mt-2 rounded-lg bg-muted p-3 text-[11px] font-mono overflow-auto text-destructive whitespace-pre-wrap">
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </pre>
          </details>
        </div>
      );
    }

    return children;
  }
}
