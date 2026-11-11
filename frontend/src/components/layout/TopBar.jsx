import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext.jsx';
import { ROLE_LABELS } from '../../lib/constants.js';
import { initials } from '../../lib/format.js';
import Badge from '../ui/Badge.jsx';

/**
 * Read once at module load: Vite inlines `import.meta.env` at build time, so this
 * is a constant, not a lookup. Empty in production, set to "staging"/"demo"
 * elsewhere so nobody mistakes a test deployment for the real institution's data.
 */
const ENV_LABEL = String(import.meta.env.VITE_ENV_LABEL || '').trim();

/**
 * The bar above the page content. `children` is the heading slot — a page that
 * wants its title up here passes it; most render their own `.page-header` instead.
 */
export default function TopBar({ navOpen = false, onToggleNav, children }) {
  const { user, role, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.key]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    // mousedown, not click: a click listener would fire in the same gesture that
    // opened the menu on some browsers, and a press that starts outside should
    // dismiss immediately rather than waiting for the release.
    const onPointerDown = (event) => {
      if (actionsRef.current && !actionsRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    setMenuOpen(false);
    try {
      await logout();
    } finally {
      // `finally`, because the tokens are cleared even when the API call fails;
      // staying on a page whose requests will all 401 is worse than a redirect.
      navigate('/login', { replace: true });
    }
  }

  return (
    <header className="app-topbar">
      <button
        type="button"
        className="sidebar-toggle only-sm"
        aria-label="Open navigation"
        aria-expanded={navOpen}
        aria-controls="app-nav"
        onClick={onToggleNav}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <div className="topbar-heading">{children}</div>

      <div className="topbar-actions" ref={actionsRef}>
        {ENV_LABEL ? <Badge tone="warn">{ENV_LABEL}</Badge> : null}

        {/* The name is .hide-sm, so on a phone the chip is initials only; without
            an explicit label the button would have no accessible name there. */}
        {user ? (
          <button
            type="button"
            className="user-chip"
            aria-label={`Account: ${user.name || 'signed in'}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="avatar" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="hide-sm">{user.name}</span>
          </button>
        ) : null}

        {/* No role="menu": that contract promises arrow-key navigation this does
            not implement, and the native tab order through a link and a button
            is already usable. */}
        {menuOpen && user ? (
          <div className="menu">
            <div className="menu-item">
              <span className="stack-sm">
                <span className="strong nowrap">{user.name}</span>
                <span className="small muted nowrap">{ROLE_LABELS[role] || 'Signed in'}</span>
              </span>
            </div>
            <div className="menu-separator" />
            <Link className="menu-item" to="/account" onClick={() => setMenuOpen(false)}>
              Account settings
            </Link>
            <button type="button" className="menu-item" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
