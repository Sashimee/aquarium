import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, isReloadingForNewBuild, reloadForNewBuild } from './staleBuild';

interface State {
  failed: boolean;
  updating: boolean;
}

interface Props {
  children: ReactNode;
  what: string;
  scope: 'panel' | 'app';
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, updating: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.what} failed to render`, error, info.componentStack);
    if (isChunkLoadError(error) && reloadForNewBuild()) this.setState({ updating: true });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { what, scope } = this.props;
    if (this.state.updating || isReloadingForNewBuild()) {
      return (
        <p role="status" className="hint">
          A new version is available. Reloading.
        </p>
      );
    }
    return (
      <div role="alert" className={scope === 'app' ? 'crash crash-app' : 'crash'}>
        <p>{`Something went wrong with ${what}. Reload the page to try again.`}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
