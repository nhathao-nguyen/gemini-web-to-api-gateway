import { useState, useCallback } from 'react';

export function usePlaygroundKey() {
  // Playground API key is held EXCLUSIVELY in React memory during current page session.
  // Never persisted to localStorage or sessionStorage.
  const [apiKey, setApiKeyState] = useState<string>('');

  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key.trim());
  }, []);

  const clearApiKey = useCallback(() => {
    setApiKeyState('');
  }, []);

  const isValidFormat = apiKey.startsWith('sk-gmgw-');

  return {
    apiKey,
    setApiKey,
    clearApiKey,
    isValidFormat,
  };
}
