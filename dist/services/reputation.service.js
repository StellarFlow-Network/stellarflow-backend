import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export class ReputationService {
    async recordSuccess(providerName, endpoint, latencyMs) {
        const existing = await prisma.providerReputation.findUnique({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
        });
        const newTotalRequests = (existing?.totalRequests || 0) + 1;
        const newSuccessfulRequests = (existing?.successfulRequests || 0) + 1;
        const newConsecutiveFailures = 0;
        const newConsecutiveIncorrect = 0;
        // Calculate new average latency
        let newAvgLatency = existing?.averageLatency || null;
        if (latencyMs && existing?.averageLatency) {
            newAvgLatency = (existing.averageLatency * existing.successfulRequests + latencyMs) / newSuccessfulRequests;
        }
        else if (latencyMs) {
            newAvgLatency = latencyMs;
        }
        // Calculate reliability score
        const reliabilityScore = (newSuccessfulRequests / newTotalRequests) * 100;
        await prisma.providerReputation.upsert({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
            update: {
                totalRequests: newTotalRequests,
                successfulRequests: newSuccessfulRequests,
                averageLatency: newAvgLatency,
                lastSuccess: new Date(),
                consecutiveFailures: newConsecutiveFailures,
                consecutiveIncorrect: newConsecutiveIncorrect,
                status: 'online',
                reliabilityScore,
                lastUpdated: new Date(),
            },
            create: {
                providerName,
                endpoint: endpoint || '',
                status: 'online',
                totalRequests: 1,
                successfulRequests: 1,
                averageLatency: latencyMs || null,
                lastSuccess: new Date(),
                reliabilityScore: 100,
            },
        });
    }
    async recordFailure(providerName, endpoint, errorType) {
        const existing = await prisma.providerReputation.findUnique({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
        });
        const newTotalRequests = (existing?.totalRequests || 0) + 1;
        const newFailedRequests = (existing?.failedRequests || 0) + 1;
        let newConsecutiveFailures = (existing?.consecutiveFailures || 0) + 1;
        let newConsecutiveIncorrect = existing?.consecutiveIncorrect || 0;
        if (errorType === 'incorrect') {
            newConsecutiveIncorrect = (existing?.consecutiveIncorrect || 0) + 1;
        }
        // Determine status based on consecutive failures
        let status = 'online';
        if (newConsecutiveFailures >= 5) {
            status = 'offline';
        }
        else if (newConsecutiveFailures >= 2) {
            status = 'degraded';
        }
        // Calculate reliability score
        const successfulRequests = existing?.successfulRequests || 0;
        const reliabilityScore = (successfulRequests / newTotalRequests) * 100;
        await prisma.providerReputation.upsert({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
            update: {
                totalRequests: newTotalRequests,
                failedRequests: newFailedRequests,
                lastFailure: new Date(),
                consecutiveFailures: newConsecutiveFailures,
                ...(errorType === 'incorrect' && {
                    incorrectResponses: (existing?.incorrectResponses || 0) + 1,
                    lastIncorrect: new Date(),
                    consecutiveIncorrect: newConsecutiveIncorrect,
                }),
                status,
                reliabilityScore,
                lastUpdated: new Date(),
            },
            create: {
                providerName,
                endpoint: endpoint || '',
                status: 'degraded',
                totalRequests: 1,
                failedRequests: 1,
                lastFailure: new Date(),
                consecutiveFailures: 1,
                ...(errorType === 'incorrect' && {
                    incorrectResponses: 1,
                    lastIncorrect: new Date(),
                    consecutiveIncorrect: 1,
                }),
                reliabilityScore: 0,
            },
        });
    }
    async getReputation(providerName, endpoint) {
        return prisma.providerReputation.findUnique({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
        });
    }
    async getLowReliabilityProviders(threshold = 80) {
        return prisma.providerReputation.findMany({
            where: {
                reliabilityScore: { lt: threshold },
                totalRequests: { gt: 10 },
            },
            orderBy: { reliabilityScore: 'asc' },
        });
    }
    async resetConsecutiveFailures(providerName, endpoint) {
        await prisma.providerReputation.update({
            where: {
                providerName_endpoint: {
                    providerName,
                    endpoint: endpoint || '',
                },
            },
            data: {
                consecutiveFailures: 0,
                consecutiveIncorrect: 0,
                status: 'online',
            },
        });
    }
}
export const reputationService = new ReputationService();
//# sourceMappingURL=reputation.service.js.map