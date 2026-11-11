/**
 * The application entry point: one stylesheet, one root, one provider stack.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';

// The only import of the stylesheet in the whole app. Importing it from a second
// module would work, but it would also make the cascade order depend on module
// evaluation order, which changes between dev and a production build.
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  // Nothing below can render, and a blank page with no console output is the
  // hardest possible version of this bug to diagnose.
  throw new Error('SnapAttend could not start: no #root element in index.html.');
}

createRoot(container).render(
  <StrictMode>
    {/* Order is load-bearing, outermost first:
        - BrowserRouter outermost, so the route guards can read the location they
          need to build `/login?next=…` from.
        - ErrorBoundary above the providers, so a throw inside one of them still
          lands on the fallback panel instead of a white page.
        - ToastProvider above AuthProvider, because signing out can fail and
          AuthProvider needs somewhere to say so. */}
    <BrowserRouter>
      <ErrorBoundary>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
