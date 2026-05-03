import type { Request } from 'express';
import { swaggerSpec } from './swagger';

export type RorcaTier = 'public' | 'auth' | 'paid' | 'admin';
export type RorcaTierOrDenied = RorcaTier | 'denied';
export type RorcaPlan = 'free' | 'pro' | 'team' | 'enterprise';

export interface PlanCapabilities {
  teams: boolean;
  federatedMemory: boolean;
  grcAuditTraces: boolean;
  finops: boolean;
  marketplacePublish: boolean;
  cloudSync: boolean;
  multiEntity: boolean;
}

export type PlanCapability = keyof PlanCapabilities;

export const PLAN_CAPABILITIES: Record<RorcaPlan, PlanCapabilities> = {
  free: {
    teams: false,
    federatedMemory: false,
    grcAuditTraces: false,
    finops: false,
    marketplacePublish: false,
    cloudSync: false,
    multiEntity: false,
  },
  pro: {
    teams: true,
    federatedMemory: false,
    grcAuditTraces: false,
    finops: true,
    marketplacePublish: true,
    cloudSync: true,
    multiEntity: false,
  },
  team: {
    teams: true,
    federatedMemory: true,
    grcAuditTraces: true,
    finops: true,
    marketplacePublish: true,
    cloudSync: true,
    multiEntity: false,
  },
  enterprise: {
    teams: true,
    federatedMemory: true,
    grcAuditTraces: true,
    finops: true,
    marketplacePublish: true,
    cloudSync: true,
    multiEntity: true,
  },
};

export const PLAN_CAPABILITY_KEYS = Object.keys(PLAN_CAPABILITIES.free) as PlanCapability[];

export interface RorcaTierMetadata {
  tier: RorcaTierOrDenied;
  rationale?: string;
  publicApi?: boolean;
  capability: PlanCapability | null;
}

export interface RorcaTierOperationLike {
  'x-rorca-tier'?: string;
  'x-rorca-rationale'?: string;
  'x-rorca-public-api'?: boolean;
  'x-rorca-capability'?: string;
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

interface RouteMatcher {
  method: string;
  regex: RegExp;
  operation: RorcaTierOperationLike;
}

const routeMatcherCache = new WeakMap<object, RouteMatcher[]>();

function pathToRegex(pathname: string): RegExp {
  const escaped = pathname
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function buildMatchers(spec: OpenApiTierSpecLike): RouteMatcher[] {
  const matchers: RouteMatcher[] = [];

  for (const [pathname, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods) continue;

    for (const [method, operation] of Object.entries(methods)) {
      if (!operation) continue;
      const rawTier = operation['x-rorca-tier'];
      if (rawTier !== 'public' && rawTier !== 'auth' && rawTier !== 'paid' && rawTier !== 'admin') {
        continue;
      }

      matchers.push({
        method: method.toUpperCase(),
        regex: pathToRegex(pathname),
        operation,
      });
    }
  }

  return matchers.sort((a, b) => b.regex.source.length - a.regex.source.length);
}

function getMatchers(spec: OpenApiTierSpecLike): RouteMatcher[] {
  const key = spec as object;
  const cached = routeMatcherCache.get(key);
  if (cached) {
    return cached;
  }

  const built = buildMatchers(spec);
  routeMatcherCache.set(key, built);
  return built;
}

export function isPlanCapability(value: string | null | undefined): value is PlanCapability {
  return typeof value === 'string' && (PLAN_CAPABILITY_KEYS as string[]).includes(value);
}

export function planHasCapability(plan: RorcaPlan, cap: PlanCapability): boolean {
  return PLAN_CAPABILITIES[plan][cap];
}

export function resolveRorcaPlan(rawPlan: string | null | undefined): RorcaPlan {
  switch ((rawPlan ?? '').trim().toLowerCase()) {
    case 'pro':
      return 'pro';
    case 'team':
      return 'team';
    case 'enterprise':
      return 'enterprise';
    case 'solo':
      return 'free';
    default:
      return 'free';
  }
}

export function getRorcaTier(operation: RorcaTierOperationLike): RorcaTierMetadata {
  const raw = operation['x-rorca-tier'];
  const capability = isPlanCapability(operation['x-rorca-capability'])
    ? operation['x-rorca-capability']
    : null;
  if (raw === 'public' || raw === 'auth' || raw === 'paid' || raw === 'admin') {
    return {
      tier: raw,
      rationale: operation['x-rorca-rationale'],
      publicApi: operation['x-rorca-public-api'] === true,
      capability,
    };
  }
  return { tier: 'denied', capability };
}

export function tierAllowedFromMcp(tier: RorcaTierOrDenied): boolean {
  return tier === 'public' || tier === 'auth';
}

export function matchOperationFromRoute(
  req: Pick<Request, 'method' | 'path'>,
  spec: OpenApiTierSpecLike = swaggerSpec as OpenApiTierSpecLike,
): RorcaTierOperationLike | null {
  const method = req.method.toUpperCase();
  const pathname = req.path;

  for (const matcher of getMatchers(spec)) {
    if (matcher.method !== method) continue;
    if (matcher.regex.test(pathname)) {
      return matcher.operation;
    }
  }

  return null;
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
