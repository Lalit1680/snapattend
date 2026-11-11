import { Navigate } from 'react-router-dom';

import { LoadingBlock } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * `/` — a signpost, never a destination.
 *
 * The wait matters: on a hard refresh the tokens are already in localStorage but
 * `/api/auth/me` has not answered, so redirecting immediately would send every
 * returning user to the sign-in page they are already signed in to.
 */
export default function RootRedirect() {
  const { user, initializing, homePath } = useAuth();

  if (initializing) {
    return (
      <div className="center">
        <LoadingBlock label="Restoring your session…" />
      </div>
    );
  }

  // `replace` so the back button reaches wherever the user came from rather than
  // bouncing through this route again.
  return <Navigate to={user ? homePath() : '/login'} replace />;
}
