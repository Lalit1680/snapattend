import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';

/**
 * The layout route every signed-in page renders inside.
 *
 * It owns exactly one piece of state: whether the mobile drawer is showing.
 * Below 900px the sidebar is off-canvas, so the shell — not the sidebar — has to
 * decide when it is visible, because the scrim and the body scroll lock live out
 * here alongside it.
 */
export default function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  const closeNav = useCallback(() => setNavOpen(false), []);

  // Keyed on `location.key` rather than `pathname`: tapping the link for the page
  // you are already on pushes a new entry with the same path, and leaving the
  // drawer up in that case looks exactly like the link being broken.
  useEffect(() => {
    setNavOpen(false);
  }, [location.key]);

  useEffect(() => {
    if (!navOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return undefined;
    // Modal locks body scroll the same way. Capturing and restoring the previous
    // value means whichever of the two closes last does not unlock the other's
    // lock, which is what a blind reset to '' would do.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  return (
    <div className="app-shell">
      <Sidebar open={navOpen} onNavigate={closeNav} />
      {navOpen ? <div className="scrim" onClick={closeNav} aria-hidden="true" /> : null}
      <div className="app-main">
        <TopBar navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
