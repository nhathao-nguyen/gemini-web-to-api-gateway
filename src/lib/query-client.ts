import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error: any) => {
        if (error?.message === 'UNAUTHORIZED' || error?.message === 'NOT_FOUND') {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
