/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

export function createTrustedProxyPredicate(configuredAddresses = process.env.RORCA_TRUSTED_PROXY_IPS ?? ''):
(address: string) => boolean {
  const addresses = new Set(configuredAddresses.split(',').map((address) => address.trim()).filter(Boolean));
  return (address: string) => addresses.has(address);
}
