import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import DocsPage from './pages/DocsPage';
import ReferencePage from './pages/ReferencePage';

/**
 * Router for the public marketing site (DROP-070) — landing, docs, and the
 * API/CLI reference only. No auth context, no lazy-loading (the whole point
 * of the split is that this bundle is small on its own), and no catch-all
 * needed beyond a same-origin bounce: `ApiServer` only ever routes `/`,
 * `/docs`, and `/reference` here (see server.ts), so this Routes never sees
 * an unknown path in production — the wildcard just covers stray
 * client-side navigation.
 */
function SiteApp() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="docs" element={<DocsPage />} />
      <Route path="reference" element={<ReferencePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default SiteApp;
