import { useState, useRef, useEffect, useCallback } from 'react';
import { getBrowserOnboardingStatus, startBrowserOnboarding, cancelBrowserOnboarding, OnboardingSessionState } from '../lib/api-client.js';

interface UseBrowserOnboardingOptions {
  onCompleted?: (session: OnboardingSessionState) => void;
}

export function useBrowserOnboarding(options?: UseBrowserOnboardingOptions) {
  const [session, setSession] = useState<OnboardingSessionState | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!session || ['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(session.step)) {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
      return;
    }

    pollerRef.current = setInterval(async () => {
      try {
        const updated = await getBrowserOnboardingStatus(session.sessionId);
        setSession(updated);
        if (updated.step === 'COMPLETED') {
          optionsRef.current?.onCompleted?.(updated);
        }
      } catch (err: any) {
        console.warn('Error polling onboarding session:', err);
      }
    }, 1800);

    return () => {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    };
  }, [session]);

  const start = useCallback(async (params: {
    accountId?: string;
    isReLogin?: boolean;
    name: string;
    emailLabel: string;
    proxyUrl?: string;
    priority?: number;
    weight?: number;
  }) => {
    setIsStarting(true);
    setError(null);
    setSession(null);
    try {
      const newSession = await startBrowserOnboarding(params);
      setSession(newSession);
      return newSession;
    } catch (err: any) {
      setError(err.message || 'Không thể khởi động phiên đăng nhập trình duyệt');
      throw err;
    } finally {
      setIsStarting(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!session) return;
    try {
      await cancelBrowserOnboarding(session.sessionId);
    } catch {}
    setSession((prev) => (prev ? { ...prev, step: 'CANCELLED' } : null));
  }, [session]);

  const reset = useCallback(() => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
    setSession(null);
    setError(null);
    setIsStarting(false);
  }, []);

  return {
    session,
    setSession,
    isStarting,
    error,
    setError,
    start,
    cancel,
    reset,
  };
}
