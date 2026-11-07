/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from './workspace-safe-fs';
import path from 'path';

export type DomainType = 'saas' | 'cli' | 'mobile' | 'ecommerce' | 'fintech' | 'data' | 'devtools' | 'web';

// Maps dependency/keyword signals to domains, ordered by specificity
const DOMAIN_SIGNALS: Array<{ domain: DomainType; deps: string[]; dirs: string[]; readmeKeywords: string[] }> = [
  {
    domain: 'mobile',
    deps: ['react-native', 'expo', '@expo/cli', 'react-native-cli', 'ionic', '@capacitor/core', 'flutter'],
    dirs: ['android', 'ios', 'mobile'],
    readmeKeywords: ['mobile app', 'ios app', 'android app', 'react native', 'expo'],
  },
  {
    domain: 'cli',
    deps: ['commander', 'yargs', 'inquirer', 'meow', 'oclif', '@oclif/core', 'clipanion', 'caporal', 'chalk', 'ora'],
    dirs: ['bin', 'cli'],
    readmeKeywords: ['command-line', 'cli tool', 'terminal', 'command line interface'],
  },
  {
    domain: 'ecommerce',
    deps: ['@shopify/shopify-api', 'medusa', '@medusajs/medusa', 'saleor', 'woocommerce', 'commerce.js', '@commercetools/sdk-client'],
    dirs: ['shop', 'store', 'checkout', 'cart'],
    readmeKeywords: ['ecommerce', 'e-commerce', 'online store', 'shopify', 'checkout', 'cart'],
  },
  {
    domain: 'fintech',
    deps: ['stripe', '@stripe/stripe-js', 'plaid', 'dwolla', 'razorpay', 'braintree', '@paddle/paddle-js'],
    dirs: ['payments', 'billing', 'ledger', 'transactions', 'finance'],
    readmeKeywords: ['fintech', 'payments', 'banking', 'financial', 'transactions', 'billing platform'],
  },
  {
    domain: 'data',
    deps: ['pandas', 'numpy', 'scikit-learn', 'tensorflow', 'torch', 'apache-beam', 'dbt', '@dbt-labs/dbt', 'airflow', 'dagster', 'prefect', 'great-expectations'],
    dirs: ['pipelines', 'dags', 'notebooks', 'models', 'transforms', 'etl'],
    readmeKeywords: ['data pipeline', 'machine learning', 'data engineering', 'etl', 'analytics pipeline'],
  },
  {
    domain: 'devtools',
    deps: ['vite', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx', 'lerna', 'ts-jest', 'vitest', 'eslint', 'prettier'],
    dirs: ['packages', 'plugins', 'tools'],
    readmeKeywords: ['developer tool', 'devtools', 'build tool', 'bundler', 'linter', 'monorepo tool'],
  },
  {
    domain: 'saas',
    deps: ['next', 'nuxt', 'remix', 'firebase', 'auth0', '@auth0/nextjs-auth0', 'lucia', 'next-auth', 'clerk'],
    dirs: ['apps', 'services'],
    readmeKeywords: ['saas', 'software as a service', 'subscription', 'multi-tenant', 'dashboard'],
  },
  {
    domain: 'web',
    deps: ['react', 'vue', 'angular', 'svelte', 'solid-js', 'preact', 'astro', 'gatsby'],
    dirs: ['public', 'static', 'assets'],
    readmeKeywords: ['web app', 'website', 'web application', 'frontend'],
  },
];

interface ScoreMap {
  [domain: string]: number;
}

export async function inferDomain(workspacePath: string): Promise<DomainType | null> {
  const scores: ScoreMap = {};

  const addScore = (domain: DomainType, points: number) => {
    scores[domain] = (scores[domain] ?? 0) + points;
  };

  // 1. Read package.json
  const pkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      for (const signal of DOMAIN_SIGNALS) {
        for (const dep of signal.deps) {
          if (allDeps.includes(dep)) {
            addScore(signal.domain, 3);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // 2. Read top-level directory names
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    const dirNames = entries.filter(e => e.isDirectory()).map(e => e.name.toLowerCase());
    for (const signal of DOMAIN_SIGNALS) {
      for (const dir of signal.dirs) {
        if (dirNames.includes(dir)) {
          addScore(signal.domain, 2);
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Read README.md (first 500 chars)
  const readmePath = path.join(workspacePath, 'README.md');
  if (fs.existsSync(readmePath)) {
    try {
      const readmeSnippet = fs.readFileSync(readmePath, 'utf-8').slice(0, 500).toLowerCase();
      for (const signal of DOMAIN_SIGNALS) {
        for (const kw of signal.readmeKeywords) {
          if (readmeSnippet.includes(kw)) {
            addScore(signal.domain, 2);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Pick the domain with the highest score, requiring at least 3 points for confidence
  let best: DomainType | null = null;
  let bestScore = 1; // minimum threshold — need at least 2 points (strictly greater)

  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = domain as DomainType;
    }
  }

  return best;
}
