import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import SiteApp from './SiteApp';

// CSS reset (Tailwind preflight only — see the file comment) — the landing/
// docs/reference pages were authored assuming this reset was in effect, back
// when they still shipped inside the dashboard bundle that pulls it in via
// index.css.
import './styles/site-reset.css';

// Self-hosted fonts (same-origin assets — required by the marketing site's
// strict CSP, which blocks external Google Fonts). This is the single load
// point for the marketing/docs/reference pages, mirroring how main.tsx loads
// them once for the dashboard bundle (see LandingPage.tsx's comment).
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SiteApp />
    </BrowserRouter>
  </React.StrictMode>
);
