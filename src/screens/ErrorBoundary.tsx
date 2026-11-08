// src/screens/ErrorBoundary.tsx
// A class error boundary. There was none above the board (frontend-13): any
// thrown render error — an unknown card id in a deck panel, an unexpected
// gameover shape — unmounted the whole tree and left a white page with no way
// back except reload. Two uses:
//   • Root (index.tsx) wraps <App/> so a crash anywhere shows a recover panel.
//   • Around the live match client (MatchSeat / SoloClient) with `variant="board"`
//     so a board error tears down the match, not the session.
import React from 'react';

type Props = {
  children: React.ReactNode;
  /** 'board' narrows the copy to a single match; 'app' is the whole shell. */
  variant?: 'app' | 'board';
  /** Called by the "back" button. Board boundaries pass the host's leave fn. */
  onReset?: () => void;
};

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The one thing the old silent unmount never did: say what broke.
    try {
      // eslint-disable-next-line no-console
      console.error('[egregore] render error', error, info.componentStack);
    } catch { /* ignore */ }
  }

  private handleReset = () => {
    this.setState({ error: null });
    try { this.props.onReset?.(); } catch { /* ignore */ }
  };

  private handleReload = () => {
    try { window.location.reload(); } catch { /* ignore */ }
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const board = this.props.variant === 'board';
    return (
      <div role="alert" style={{
        position: 'fixed', inset: 0, zIndex: 9999, display: 'grid', placeItems: 'center',
        background: '#07060f', color: '#e9eef7',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif", padding: 24,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 440 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.04em', color: '#ffd98a' }}>
            Something broke
          </div>
          <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6, color: '#b9b2c9' }}>
            {board
              ? 'This match hit an unexpected error. You can leave it and get back to the hub — your session is still signed in.'
              : 'The app hit an unexpected error. Reload to get back in.'}
          </div>
          <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {board && this.props.onReset && (
              <button onClick={this.handleReset} style={btn('#6c4bd8')}>Back to hub</button>
            )}
            <button onClick={this.handleReload} style={btn('#2a2340')}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

function btn(bg: string): React.CSSProperties {
  return {
    minHeight: 44, padding: '10px 18px', borderRadius: 10, border: '1px solid #4a3f6a',
    background: bg, color: '#fff', cursor: 'pointer', fontWeight: 800, letterSpacing: '0.04em', fontSize: 13,
  };
}

export default ErrorBoundary;
