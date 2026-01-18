import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import SettingsPage from './pages/SettingsPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<AppsPage />} />
        <Route path="apps/:name" element={<AppDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
