export type RorcaTier = 'public' | 'auth' | 'paid' | 'admin';
export type RorcaTierOrDenied = RorcaTier | 'denied';

export interface RorcaTierMetadata {
  tier: RorcaTierOrDenied;
  rationale?: string;
  publicApi?: boolean;
}

export interface RorcaTierOperationLike {
  'x-rorca-tier'?: string;
  'x-rorca-rationale'?: string;
  'x-rorca-public-api'?: boolean;
}

export interface RorcaTierSummary {
  public: number;
  auth: number;
  paid: number;
  admin: number;
  denied: number;
  publicApi: number;
}

export interface OpenApiTierSpecLike {
  paths?: Record<string, Record<string, RorcaTierOperationLike | undefined> | undefined>;
}

export function getRorcaTier(operation: RorcaTierOperationLike): RorcaTierMetadata {
  const raw = operation['x-rorca-tier'];
  if (raw === 'public' || raw === 'auth' || raw === 'paid' || raw === 'admin') {
    return {
      tier: raw,
      rationale: operation['x-rorca-rationale'],
      publicApi: operation['x-rorca-public-api'] === true,
    };
  }
  return { tier: 'denied' };
}

export function tierAllowedFromMcp(tier: RorcaTierOrDenied): boolean {
  return tier === 'public' || tier === 'auth';
}

export function summarizeRorcaTiers(spec: OpenApiTierSpecLike): RorcaTierSummary {
  const summary: RorcaTierSummary = {
    public: 0,
    auth: 0,
    paid: 0,
    admin: 0,
    denied: 0,
    publicApi: 0,
  };

  for (const methods of Object.values(spec.paths ?? {})) {
    if (!methods) continue;
    for (const operation of Object.values(methods)) {
      if (!operation) continue;
      const metadata = getRorcaTier(operation);
      summary[metadata.tier] += 1;
      if (metadata.tier === 'public' && metadata.publicApi) {
        summary.publicApi += 1;
      }
    }
  }

  return summary;
}
