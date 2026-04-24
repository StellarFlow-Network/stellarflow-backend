export const NGN_PROVIDER_WEIGHTS = {
  vtpassCoinGeckoUsd: 0.35,
  coinGeckoDirectNgn: 0.25,
  coinGeckoExchangeRateUsdNgn: 1.0,
} as const;

export type NGNProviderWeightKey = keyof typeof NGN_PROVIDER_WEIGHTS;

export function getNGNProviderWeight(provider: NGNProviderWeightKey): number {
  const configuredWeight = NGN_PROVIDER_WEIGHTS[provider];

  if (
    typeof configuredWeight !== "number" ||
    !Number.isFinite(configuredWeight) ||
    configuredWeight < 0 ||
    configuredWeight > 1
  ) {
    throw new Error(
      `Invalid NGN provider weight for "${provider}". Expected a number between 0.0 and 1.0.`,
    );
  }

  return configuredWeight;
}
