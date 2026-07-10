import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/dashboard">
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
