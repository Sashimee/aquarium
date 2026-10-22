import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reloadForNewBuild, reloadHasStarted } from './staleBuild';

interface State {
  failed: boolean;
  updating: boolean;
  dismissed: boolean;
}

interface Props {
  children: ReactNode;
  what: string;
  scope: 'panel' | 'app';
  /** Adds a Dismiss button for failures in a feature that can be given up on without a reload. */
  onDismiss?: () => void;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, updating: false, dismissed: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.what} failed to render`, error, info.componentStack);
    if (isChunkLoadError(error) && (reloadForNewBuild() || reloadHasStarted())) {
      this.setState({ updating: true });
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { what, scope, onDismiss } = this.props;
    if (this.state.dismissed) return null;
    if (this.state.updating) {
      return (
        <p role="status" className="hint">
          A new version is available. Reloading.
        </p>
      );
    }
    return (
      <div role="alert" className={scope === 'app' ? 'crash crash-app' : 'crash'}>
        <p>{`Something went wrong with ${what}. Reload the page to try again.`}</p>
        <div className="row">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={() => {
                this.setState({ dismissed: true });
                onDismiss();
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    );
  }
}
