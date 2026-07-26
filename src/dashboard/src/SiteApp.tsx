import { Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import DocsPage from './pages/DocsPage';
import ReferencePage from './pages/ReferencePage';
import SiteNotFoundPage from './pages/SiteNotFoundPage';

/**
 * Router for the public marketing site (DROP-070) — landing, docs, and the
 * API/CLI reference only. No auth context, no lazy-loading (the whole point
 * of the split is that this bundle is small on its own). `ApiServer` only
 * ever routes `/`, `/docs`, and `/reference` here (see server.ts), so this
 * Routes never sees an unknown path over the network in production — the
 * catch-all only covers stray client-side navigation, and renders a real
 * 404 (not a silent bounce to the landing page) so a future server/client
 * route divergence stays visible instead of looking like nothing's wrong.
 */
function SiteApp() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="docs" element={<DocsPage />} />
      <Route path="reference" element={<ReferencePage />} />
      <Route path="*" element={<SiteNotFoundPage />} />
    </Routes>
  );
}

export default SiteApp;
