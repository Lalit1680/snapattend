import { Component } from 'react';

/**
 * The last line of defence against a render-time throw taking the whole app to a
 * blank page. Still a class component: there is no hook equivalent of
 * `componentDidCatch`.
 *
 * The fallback deliberately uses plain markup and a plain `<a href>` rather than
 * `Button`/`Link`. A boundary that depends on the component tree it is catching
 * for can fail to render the error it was built to report, and `<a href="/">`
 * works whether or not this sits inside the Router.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is the only place this can go: there is no error-reporting
    // service configured, and a toast needs a provider that may itself be gone.
    console.error('[SnapAttend] Unhandled render error', error, info && info.componentStack);
  }

  componentDidUpdate(prevProps) {
    const { error } = this.state;
    if (!error) return;
    // Without this, one broken page keeps its error panel on screen for the rest
    // of the session: navigating away re-renders the parent with new children but
    // never clears the boundary's state. Children identity changes on every parent
    // render, so a still-broken subtree simply throws again and re-sets the error.
    if (prevProps.resetKey !== this.props.resetKey || prevProps.children !== this.props.children) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = (error && error.message) || 'The page failed to render.';

    return (
      // The panel replaces the entire app, so it owns the viewport height; there
      // is no shell left to centre it against.
      <div className="auth-panel" style={{ minHeight: '100vh' }}>
        <div className="auth-card">
          <div className="stack">
            <div className="auth-header">
              <h1 className="auth-title">Something went wrong</h1>
              <p className="auth-sub">
                This page hit an unexpected error. Your attendance data is safe — nothing was
                submitted.
              </p>
            </div>

            <div className="alert is-danger">
              <div className="alert-content">
                <div className="alert-title">Error</div>
                <p className="small mono">{message}</p>
              </div>
            </div>

            <div className="row row-sm">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload the page
              </button>
              <a className="btn btn-secondary" href="/">
                Go to the dashboard
              </a>
            </div>

            <p className="auth-footer small faint">
              If this keeps happening, the browser console has the full details.
            </p>
          </div>
        </div>
      </div>
    );
  }
}
