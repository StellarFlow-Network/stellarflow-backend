import prisma from "../lib/prisma";

export interface IPWhitelistEntry {
  id: number;
  ipAddress: string;
  label: string;
  priority: number;
  isActive: boolean;
  rateLimitOverride: number;
  notes: string | null;
  lastAccessed: Date | null;
  totalRequests: number;
}

export interface VIPRequestContext {
  isVIP: boolean;
  entry?: IPWhitelistEntry;
  customRateLimit: number;
  priority: number;
}

export class IPWhitelistService {
  // In-memory cache for fast lookups
  private cache: Map<string, IPWhitelistEntry> = new Map();
  private cacheExpiry: number = 60000; // 1 minute cache
  private lastCacheUpdate: number = 0;

  /**
   * Check if an IP address is in the VIP whitelist
   * Returns VIP context with priority and custom rate limits
   */
  async checkIP(ipAddress: string): Promise<VIPRequestContext> {
    // Normalize IP address (handle IPv6 localhost, etc.)
    const normalizedIP = this.normalizeIP(ipAddress);

    await this.ensureCacheUpdated();

    const entry = this.cache.get(normalizedIP);

    if (entry && entry.isActive) {
      // Update access tracking asynchronously
      this.trackAccess(entry.id).catch(() => {});

      return {
        isVIP: true,
        entry,
        customRateLimit: entry.rateLimitOverride,
        priority: entry.priority,
      };
    }

    // Default context for non-VIP IPs
    return {
      isVIP: false,
      customRateLimit: 100, // Default rate limit
      priority: 0,
    };
  }

  /**
   * Add an IP address to the whitelist
   */
  async addIP(params: {
    ipAddress: string;
    label: string;
    priority?: number;
    rateLimitOverride?: number;
    notes?: string;
  }): Promise<IPWhitelistEntry> {
    const normalizedIP = this.normalizeIP(params.ipAddress);

    const entry = await prisma.iPWhitelist.create({
      data: {
        ipAddress: normalizedIP,
        label: params.label,
        priority: params.priority || 1,
        rateLimitOverride: params.rateLimitOverride || 1000,
        notes: params.notes || null,
        isActive: true,
      },
    });

    // Invalidate cache
    this.invalidateCache();

    return entry;
  }

  /**
   * Remove an IP address from the whitelist
   */
  async removeIP(ipAddress: string): Promise<boolean> {
    const normalizedIP = this.normalizeIP(ipAddress);

    const deleted = await prisma.iPWhitelist.delete({
      where: { ipAddress: normalizedIP },
    }).catch(() => null);

    if (deleted) {
      this.invalidateCache();
      return true;
    }

    return false;
  }

  /**
   * Deactivate an IP (soft delete)
   */
  async deactivateIP(ipAddress: string): Promise<IPWhitelistEntry | null> {
    const normalizedIP = this.normalizeIP(ipAddress);

    const updated = await prisma.iPWhitelist.update({
      where: { ipAddress: normalizedIP },
      data: { isActive: false },
    }).catch(() => null);

    if (updated) {
      this.invalidateCache();
    }

    return updated;
  }

  /**
   * Reactivate an IP
   */
  async reactivateIP(ipAddress: string): Promise<IPWhitelistEntry | null> {
    const normalizedIP = this.normalizeIP(ipAddress);

    const updated = await prisma.iPWhitelist.update({
      where: { ipAddress: normalizedIP },
      data: { isActive: true },
    }).catch(() => null);

    if (updated) {
      this.invalidateCache();
    }

    return updated;
  }

  /**
   * Update IP whitelist entry
   */
  async updateIP(
    ipAddress: string,
    params: {
      label?: string;
      priority?: number;
      rateLimitOverride?: number;
      notes?: string;
    }
  ): Promise<IPWhitelistEntry | null> {
    const normalizedIP = this.normalizeIP(ipAddress);

    const updated = await prisma.iPWhitelist.update({
      where: { ipAddress: normalizedIP },
      data: {
        ...(params.label && { label: params.label }),
        ...(params.priority !== undefined && { priority: params.priority }),
        ...(params.rateLimitOverride !== undefined && {
          rateLimitOverride: params.rateLimitOverride,
        }),
        ...(params.notes !== undefined && { notes: params.notes }),
      },
    }).catch(() => null);

    if (updated) {
      this.invalidateCache();
    }

    return updated;
  }

  /**
   * Get all active VIP IPs
   */
  async getActiveIPs(): Promise<IPWhitelistEntry[]> {
    await this.ensureCacheUpdated();

    return Array.from(this.cache.values())
      .filter((entry) => entry.isActive)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all VIP IPs (active and inactive)
   */
  async getAllIPs(): Promise<IPWhitelistEntry[]> {
    await this.ensureCacheUpdated();

    return Array.from(this.cache.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }

  /**
   * Get VIP statistics
   */
  async getVIPStats(): Promise<{
    totalVIPs: number;
    activeVIPs: number;
    inactiveVIPs: number;
    totalVIPRequests: number;
    topInstitutions: Array<{ label: string; totalRequests: number }>;
  }> {
    const allIPs = await this.getAllIPs();

    const activeVIPs = allIPs.filter((ip) => ip.isActive);
    const inactiveVIPs = allIPs.filter((ip) => !ip.isActive);
    const totalVIPRequests = allIPs.reduce(
      (sum, ip) => sum + ip.totalRequests,
      0
    );

    // Top institutions by request count
    const topInstitutions = allIPs
      .filter((ip) => ip.totalRequests > 0)
      .sort((a, b) => b.totalRequests - a.totalRequests)
      .slice(0, 10)
      .map((ip) => ({
        label: ip.label,
        totalRequests: ip.totalRequests,
      }));

    return {
      totalVIPs: allIPs.length,
      activeVIPs: activeVIPs.length,
      inactiveVIPs: inactiveVIPs.length,
      totalVIPRequests,
      topInstitutions,
    };
  }

  /**
   * Ensure cache is up to date
   */
  private async ensureCacheUpdated(): Promise<void> {
    const now = Date.now();

    if (now - this.lastCacheUpdate > this.cacheExpiry || this.cache.size === 0) {
      const entries = await prisma.iPWhitelist.findMany();

      this.cache.clear();
      for (const entry of entries) {
        this.cache.set(entry.ipAddress, {
          id: entry.id,
          ipAddress: entry.ipAddress,
          label: entry.label,
          priority: entry.priority,
          isActive: entry.isActive,
          rateLimitOverride: entry.rateLimitOverride,
          notes: entry.notes,
          lastAccessed: entry.lastAccessed,
          totalRequests: entry.totalRequests,
        });
      }

      this.lastCacheUpdate = now;
    }
  }

  /**
   * Invalidate cache (force refresh on next lookup)
   */
  private invalidateCache(): void {
    this.lastCacheUpdate = 0;
  }

  /**
   * Track access for an IP (updates lastAccessed and totalRequests)
   */
  private async trackAccess(entryId: number): Promise<void> {
    await prisma.iPWhitelist.update({
      where: { id: entryId },
      data: {
        lastAccessed: new Date(),
        totalRequests: { increment: 1 },
      },
    });
  }

  /**
   * Normalize IP address
   */
  private normalizeIP(ip: string): string {
    // Handle IPv6 localhost
    if (ip === "::1" || ip === "::ffff:127.0.0.1") {
      return "127.0.0.1";
    }

    // Remove IPv6 prefix if present
    if (ip.startsWith("::ffff:")) {
      return ip.substring(7);
    }

    return ip.trim();
  }
}

// Export singleton instance
export const ipWhitelistService = new IPWhitelistService();
