import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ConnectionList from './pages/connections/ConnectionList';
import SchemaExplorer from './pages/schema/SchemaExplorer';
import ProtectedRoute from './components/ProtectedRoute';
import ComboList from './pages/combos/ComboList';
import InventorySearch from './pages/inventory/InventorySearch';
import MrpOverview from './pages/mrp/MrpOverview';
import MpsPage from './pages/mrp/MpsPage';
import PMDashboard from './pages/dashboards/PMDashboard';
import QualityDashboard from './pages/dashboards/QualityDashboard';
import SyncDashboard from './pages/dashboards/SyncDashboard';

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="connections" element={<ConnectionList />} />
        <Route path="schema" element={<SchemaExplorer />} />
        <Route path="combos" element={<ComboList />} />
        <Route path="inventory" element={<InventorySearch />} />
        <Route path="mrp" element={<MrpOverview />} />
        <Route path="mrp/mps" element={<MpsPage />} />
        <Route path="dashboards/pm" element={<PMDashboard />} />
        <Route path="dashboards/quality" element={<QualityDashboard />} />
        <Route path="dashboards/sync" element={<SyncDashboard />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};

export default App;
