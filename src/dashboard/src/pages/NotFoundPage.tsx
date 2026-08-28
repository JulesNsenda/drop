import { Link } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';

function NotFoundPage() {
  // This route renders outside Layout/AppShell (see App.tsx's catch-all `*`
  // route, PRD-025), so nothing else guarantees the `.drop-ui` token scope
  // or the `dark` class are applied before paint — mirrors the pattern
  // LandingPage/AuthLayout use for the same reason.
  useTheme();

  return (
    <div
      className="drop-ui flex min-h-screen flex-col items-center justify-center px-4 text-center bg-surface text-fg"
    >
      <p
        className="text-6xl font-bold text-faint font-mono"
      >
        404
      </p>
      <h1 className="mt-4 text-xl font-semibold text-fg">
        Page not found
      </h1>
      <p className="mt-2 text-muted">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Link
        to="/apps"
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors dui-btn-primary"
      >
        Back to dashboard
      </Link>
    </div>
  );
}

export default NotFoundPage;
