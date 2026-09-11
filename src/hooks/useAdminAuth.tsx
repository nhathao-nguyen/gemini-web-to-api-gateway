import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { checkAdminSession, loginAdmin, logoutAdmin } from '../lib/api-client.js';
import { queryClient } from '../lib/query-client.js';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AdminAuthContextType {
  status: AuthStatus;
  login: (credential: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextType | undefined>(undefined);

export const AdminAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<AuthStatus>('loading');

  const checkSession = useCallback(async () => {
    try {
      const session = await checkAdminSession();
      if (session.authenticated) {
        setStatus('authenticated');
      } else {
        setStatus('unauthenticated');
      }
    } catch {
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const login = async (credential: string) => {
    const result = await loginAdmin(credential);
    if (result.success) {
      setStatus('authenticated');
      // Invalidate queries to trigger fresh data loading
      queryClient.invalidateQueries();
    }
    return result;
  };

  const logout = async () => {
    await logoutAdmin();
    setStatus('unauthenticated');
    queryClient.clear();
  };

  return (
    <AdminAuthContext.Provider value={{ status, login, logout, checkSession }}>
      {children}
    </AdminAuthContext.Provider>
  );
};

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return context;
}
