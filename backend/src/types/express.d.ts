import 'express-serve-static-core';
import type { BountyFeaturePolicy } from '../lib/bounty-feature-policy';
import type { HermesAuthorityDeclaration } from '../lib/hermes-authority';

declare global {
  namespace Express {
    interface UserShape {
      id: string;
      email: string;
      supabaseId: string;
      role?: string;
      plan?: string;
    }

    interface Request {
      user?: UserShape;
      /** Credential provenance resolved by authRequired; security-sensitive mutations must not infer this from role alone. */
      authSource?: 'bearer' | 'internal' | 'local-fallback';
      /** Effective policy attached only after the bounty effect gate passes. */
      bountyPolicy?: BountyFeaturePolicy;
      /** Narrow MCP-authenticated Hermes identity for exact campaign API routes. */
      campaignServiceAuth?: 'mcp-public' | 'mcp-admin';
      /** Validated declaration separating Hermes audit identity from effective action authority. */
      hermesAuthority?: HermesAuthorityDeclaration;
    }
  }
}

export {};
