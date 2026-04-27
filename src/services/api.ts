export const api = {
  async getPrices() {
    const res = await fetch('/api/prices')
    if (!res.ok) throw new Error('Failed to fetch prices')
    return res.json()
  },

  async getPortfolio() {
    const res = await fetch('/api/portfolio')
    if (!res.ok) throw new Error('Failed to fetch portfolio')
    return res.json()
  },
}