import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client.js';
import { AdminAuthProvider } from './hooks/useAdminAuth.js';

import { ProtectedLayout } from './layouts/ProtectedLayout.js';
import { AdminLayout } from './layouts/AdminLayout.js';

import { LoginPage } from './pages/LoginPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { AccountDetailPage } from './pages/AccountDetailPage.js';
import { ApiKeysPage } from './pages/ApiKeysPage.js';
import { ApiKeyDetailPage } from './pages/ApiKeyDetailPage.js';
import { PlaygroundPage } from './pages/PlaygroundPage.js';
import { KeepAlivePage } from './pages/KeepAlivePage.js';
import { LogsPage } from './pages/LogsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminAuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Login Route */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth" element={<LoginPage />} />

            {/* Protected Admin Console Routes */}
            <Route element={<ProtectedLayout />}>
              <Route element={<AdminLayout />}>
                <Route index element={<Navigate to="/overview" replace />} />
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
                <Route path="/api-keys" element={<ApiKeysPage />} />
                <Route path="/api-keys/:keyId" element={<ApiKeyDetailPage />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/keepalive" element={<KeepAlivePage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
            </Route>

            {/* 404 Catch-all */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AdminAuthProvider>
    </QueryClientProvider>
  );
}
