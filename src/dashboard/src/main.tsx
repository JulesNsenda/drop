import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import GuestInvite from './pages/GuestInvite';
import './index.css';

// Self-hosted fonts (bundled as same-origin assets — required by the app CSP,
// which blocks external Google Fonts). JetBrains Mono + Hanken Grotesk are used
// by the landing page (`.drop-landing`) and the app design system (`.drop-ui`),
// so they are loaded once here rather than per-page.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';

// PRD-045: app-wide `.drop-ui` design-token layer, consumed by AppShell and
// AuthLayout (and the primitives in components/ui/).
import './styles/app-ui.css';

/**
 * The guest invitation page is mounted OUTSIDE `<App>` — outside the router and
 * outside `AuthContext` — rather than as a route inside it (DROP-155).
 *
 * A route could not have this property. `useAuthProvider()` runs at `<App>`'s
 * root and probes `/auth/me` on mount, and the app-wide `drop:unauthorized`
 * listener navigates to `/login` when that probe fails. For a guest the probe
 * MUST fail: they have no account. So a guest route inside `<App>` would be
 * torn off the screen before the visitor could press anything, and the fix
 * inside the tree would mean weakening the redirect the account-holder flow
 * depends on.
 *
 * A pathname check, not a route match, for the same reason — the decision has
 * to be made before any provider mounts.
 */
const isGuestInvite = window.location.pathname.replace(/\/+$/, '') === '/dashboard/app-invite';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isGuestInvite ? (
      <GuestInvite />
    ) : (
      <BrowserRouter basename="/dashboard">
        <App />
      </BrowserRouter>
    )}
  </React.StrictMode>
);
