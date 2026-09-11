import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAdminAuth } from '../hooks/useAdminAuth.js';
import { AppLoadingScreen } from '../components/AppLoadingScreen.js';

export const ProtectedLayout: React.FC = () => {
  const { status } = useAdminAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <AppLoadingScreen />;
  }

  if (status === 'unauthenticated') {
    const currentPath = location.pathname + location.search;
    const returnTo = currentPath && currentPath !== '/' ? encodeURIComponent(currentPath) : '';
    return <Navigate to={returnTo ? `/login?returnTo=${returnTo}` : '/login'} replace />;
  }

  return <Outlet />;
};
