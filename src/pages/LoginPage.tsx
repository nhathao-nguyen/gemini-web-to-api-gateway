import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, ShieldCheck, ArrowRight, Loader2 } from 'lucide-react';
import { useAdminAuth } from '../hooks/useAdminAuth.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

export const LoginPage: React.FC = () => {
  useDocumentTitle('Admin Login');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { status, login } = useAdminAuth();

  const [enteredAdminKey, setEnteredAdminKey] = useState('');
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Validate returnTo parameter to prevent open redirect vulnerabilities
  const rawReturnTo = searchParams.get('returnTo');
  const safeReturnTo =
    rawReturnTo && rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//')
      ? rawReturnTo
      : '/overview';

  // If already authenticated, redirect
  React.useEffect(() => {
    if (status === 'authenticated') {
      navigate(safeReturnTo, { replace: true });
    }
  }, [status, navigate, safeReturnTo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enteredAdminKey.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setAuthErrorMessage('');

    try {
      const res = await login(enteredAdminKey.trim());
      if (res.success) {
        navigate(safeReturnTo, { replace: true });
      } else {
        setAuthErrorMessage(res.error || 'Invalid credentials. Please verify ADMIN_PASSWORD or ADMIN_API_KEY.');
      }
    } catch (err: any) {
      setAuthErrorMessage(err.message || 'Login failed. Please check network connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans selection:bg-zinc-900 selection:text-white">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="w-12 h-12 rounded-2xl bg-zinc-900 flex items-center justify-center text-white mx-auto shadow-md">
          <ShieldCheck className="w-6 h-6 text-emerald-400" />
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900">
          Gemini Gateway Console
        </h2>
        <p className="mt-2 text-xs text-zinc-500 max-w-sm mx-auto">
          Authenticate with your configured <code className="font-mono bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-700">ADMIN_PASSWORD</code> or <code className="font-mono bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-700">ADMIN_API_KEY</code>.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4">
        <div className="bg-white py-8 px-6 shadow-sm border border-zinc-200 rounded-2xl sm:px-10">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-2">
                Admin Secret Key
              </label>
              <div className="relative">
                <input
                  type="password"
                  required
                  autoFocus
                  placeholder="Enter administrator secret..."
                  value={enteredAdminKey}
                  onChange={(e) => setEnteredAdminKey(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-zinc-50 border border-zinc-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white transition-all text-zinc-900"
                />
              </div>
            </div>

            {authErrorMessage && (
              <div className="text-xs text-rose-700 bg-rose-50 p-3 rounded-xl border border-rose-200 leading-relaxed">
                {authErrorMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !enteredAdminKey.trim()}
              className="w-full mt-2 py-2.5 px-4 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-xs flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Unlocking...</span>
                </>
              ) : (
                <>
                  <span>Unlock Gateway</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-zinc-100 text-center">
            <p className="text-[11px] text-zinc-400">
              Session secured via HttpOnly cookie & in-memory CSRF validation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
