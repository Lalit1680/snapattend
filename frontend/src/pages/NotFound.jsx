import { Link, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

/**
 * The catch-all route.
 *
 * It uses the standalone auth layout rather than `AppShell` because the most
 * common way to land here is a stale link from an email — an expired invite, a QR
 * code for a session that ended — and the person following it is often not signed
 * in at all.
 */
export default function NotFound() {
  const { user, homePath } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useDocumentTitle('Page not found');

  const home = user ? homePath() : '/login';

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-card">
          <div className="stack">
            <div className="auth-header">
              <h1 className="auth-title">404</h1>
              <p className="auth-sub">
                We could not find that page — the address may be mistyped, or the link that
                brought you here may have expired.
              </p>
            </div>

            <p className="small mono truncate">{location.pathname}</p>

            <div className="row row-sm">
              <Link className="btn btn-primary" to={home}>
                {user ? 'Back to my dashboard' : 'Go to sign in'}
              </Link>
              {/* A direct hit on a bad URL has no previous entry, and navigate(-1)
                  quietly does nothing in that case — which is why the link above,
                  not this button, is the primary action. */}
              <Button variant="secondary" onClick={() => navigate(-1)}>
                Go back
              </Button>
            </div>

            <p className="auth-footer small faint">
              Invite and password-reset links are single-use. If you followed one from an email,
              ask your administrator to send a fresh one.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
