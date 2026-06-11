import { Link } from 'react-router-dom';

function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 px-4 text-center">
      <p className="text-6xl font-bold text-gray-300 dark:text-gray-700">404</p>
      <h1 className="mt-4 text-xl font-semibold text-gray-900 dark:text-white">Page not found</h1>
      <p className="mt-2 text-gray-500 dark:text-gray-400">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Link
        to="/apps"
        className="mt-6 inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        Back to dashboard
      </Link>
    </div>
  );
}

export default NotFoundPage;
