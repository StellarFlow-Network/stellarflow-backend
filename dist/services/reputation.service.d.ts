export declare class ReputationService {
    recordSuccess(providerName: string, endpoint: string | null, latencyMs?: number): Promise<void>;
    recordFailure(providerName: string, endpoint: string | null, errorType: 'offline' | 'incorrect'): Promise<void>;
    getReputation(providerName: string, endpoint?: string): Promise<any>;
    getLowReliabilityProviders(threshold?: number): Promise<any[]>;
    resetConsecutiveFailures(providerName: string, endpoint?: string): Promise<void>;
}
export declare const reputationService: ReputationService;
//# sourceMappingURL=reputation.service.d.ts.map