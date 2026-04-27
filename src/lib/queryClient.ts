import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,          // 30s → data considered fresh
      gcTime: 5 * 60 * 1000,         // cache persists 5 mins
      refetchOnWindowFocus: false,   // 🔥 your requirement
      refetchOnReconnect: true,
      retry: 2,
    },
  },
})