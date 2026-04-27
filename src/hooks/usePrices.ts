import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'

export const usePrices = () => {
  return useQuery({
    queryKey: ['prices'],
    queryFn: api.getPrices,

    // 🔥 SWR behavior tuning
    staleTime: 10 * 1000,   // prices go stale fast
    refetchInterval: 15 * 1000, // auto refresh every 15s

    placeholderData: (previousData) => previousData, // 👈 instant UI
  })
}