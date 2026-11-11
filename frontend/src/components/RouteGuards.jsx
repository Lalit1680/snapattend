import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import LoadingBlock from './ui/LoadingBlock.jsx';

/**
 * The three route guards. Each works both as a wrapper (`<ProtectedRoute><Page/>
 * </ProtectedRoute>`) and as a react-router layout element (`element={
 * <ProtectedRoute />}` over nested routes), which is why every one of them falls
 * back to `<Outlet />`.
 */

/** `children` may legitimately be absent; only then do we defer to the router. */
function renderChildren(children) {
  return children === undefined || children === null ? <Outlet /> : <>{children}</>;
}

function Bootstrapping() {
  return (
    // Nothing has rendered around this yet, so the loader has to own its own
    // vertical space — there is no shell to centre inside.
    <div className="center" style={{ minHeight: '70vh' }}>
      <LoadingBlock label="Restoring your session…" />
    </div>
  );
}

/** `/login?next=…` so the user lands where they were headed after signing in. */
function useLoginRedirect() {
  const location = useLocation();
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export function ProtectedRoute({ children }) {
  const { user, initializing } = useAuth();
  const loginTo = useLoginRedirect();

  // Redirecting during the bootstrap would sign out every user who hard-refreshes:
  // the tokens are in localStorage but `/api/auth/me` has not answered yet.
  if (initializing) return <Bootstrapping />;
  if (!user) return <Navigate to={loginTo} replace />;
  return renderChildren(children);
}

export function RoleRoute({ roles, children }) {
  const { user, role, initializing, homePath } = useAuth();
  const loginTo = useLoginRedirect();

  if (initializing) return <Bootstrapping />;
  if (!user) return <Navigate to={loginTo} replace />;

  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(role)) {
    // Their own home rather than a 403 page: friendlier, and it does not confirm
    // that the path they guessed at exists.
    return <Navigate to={homePath()} replace />;
  }
  return renderChildren(children);
}

export function PublicOnlyRoute({ children }) {
  const { user, initializing, homePath } = useAuth();

  if (initializing) return <Bootstrapping />;
  if (user) return <Navigate to={homePath()} replace />;
  return renderChildren(children);
}
