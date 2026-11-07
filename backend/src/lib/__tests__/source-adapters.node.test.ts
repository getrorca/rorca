/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  SourceAdapterRegistry,
  normalizeVersionedSource,
  type SourceAdapter,
  type SourceCandidate,
  type SourceNormalizationInput,
  type SourceNormalizationOptions,
  type SourceNormalizationResult,
  type SourceSectionSelection,
  type VersionedSource,
} from '../index';

class FixtureAdapter implements SourceAdapter {
  readonly id = 'fixture';
  readonly schemes = Object.freeze(['fixture']);

  canResolve(locator: string): boolean {
    return locator.startsWith('fixture://docs/');
  }

  async resolve(locator: string): Promise<readonly SourceCandidate[]> {
    return Object.freeze([Object.freeze({
      adapterId: this.id,
      locator,
      scheme: 'fixture',
      authority: 'docs',
      revision: 'rev-42',
    })]);
  }

  async fetch(candidate: SourceCandidate, selection?: SourceSectionSelection): Promise<VersionedSource> {
    assert.equal(candidate.revision, 'rev-42');
    const normalized = this.normalize({ content: 'alpha\nbeta\ngamma', revision: candidate.revision, selection });
    assert.equal(normalized.status, 'available');
    return normalized.source;
  }

  normalize(input: SourceNormalizationInput, options?: SourceNormalizationOptions): SourceNormalizationResult {
    return normalizeVersionedSource(input, options);
  }
}

describe('SourceAdapterRegistry', () => {
  it('resolves a known adapter and fetches frozen, versioned section provenance', async () => {
    const adapter = new FixtureAdapter();
    const registry = new SourceAdapterRegistry([adapter]);

    const resolution = await registry.resolveFor('fixture://docs/guide');
    assert.equal(resolution.status, 'available');
    if (resolution.status !== 'available') return;
    assert.deepEqual(resolution.adapterIds, ['fixture']);
    assert.equal(resolution.candidates.length, 1);
    assert.equal(Object.isFrozen(resolution.candidates), true);
    assert.equal(Object.isFrozen(resolution.candidates[0]), true);

    const source = await adapter.fetch(resolution.candidates[0], { start: 2, end: 2 });
    assert.equal(source.content, 'beta\n');
    assert.equal(source.revision, 'rev-42');
    assert.equal(source.sha256, createHash('sha256').update('beta\n').digest('hex'));
    assert.deepEqual(source.byteBounds, { start: 6, end: 11, total: 16, truncated: false });
    assert.deepEqual(source.sectionBounds, { start: 2, end: 2, total: 3 });
    assert.equal(Object.isFrozen(source), true);
    assert.equal(Object.isFrozen(source.byteBounds), true);
    assert.equal(Object.isFrozen(source.sectionBounds), true);
  });

  it('rejects malformed declared schemes instead of registering an adapter that can never match honestly', () => {
    const adapter = new FixtureAdapter();
    Object.defineProperty(adapter, 'schemes', { value: ['fixture://'] });

    assert.throws(
      () => new SourceAdapterRegistry([adapter]),
      /declares an invalid scheme/,
    );
  });

  it('returns honest unavailability for an unknown scheme without invoking an adapter', async () => {
    let invoked = false;
    const adapter = new FixtureAdapter();
    adapter.canResolve = () => {
      invoked = true;
      return true;
    };
    const result = await new SourceAdapterRegistry([adapter]).resolveFor('unknown://docs/guide');

    assert.deepEqual(result, {
      status: 'unavailable',
      locator: 'unknown://docs/guide',
      scheme: 'unknown',
      reason: 'unknown_scheme',
      message: 'No source adapter is registered for scheme "unknown".',
    });
    assert.equal(invoked, false);
  });

  it('fails closed when a locator is missing its authority', async () => {
    const result = await new SourceAdapterRegistry([new FixtureAdapter()]).resolveFor('fixture:///guide');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'missing_authority');
  });

  it('fails closed on whitespace that would otherwise rewrite locator authority', async () => {
    const registry = new SourceAdapterRegistry([new FixtureAdapter()]);
    const surrounding = await registry.resolveFor(' fixture://docs/guide');
    const authority = await registry.resolveFor('fixture://doc s/guide');

    assert.equal(surrounding.status, 'unavailable');
    assert.equal(surrounding.reason, 'invalid_locator');
    assert.equal(authority.status, 'unavailable');
    assert.equal(authority.reason, 'invalid_locator');
  });

  it('fails closed when an adapter returns a candidate for a different scheme', async () => {
    const adapter = new FixtureAdapter();
    adapter.resolve = async (locator) => [{
      adapterId: adapter.id,
      locator,
      scheme: 'other',
      authority: 'docs',
      revision: 'rev-42',
    }];

    const result = await new SourceAdapterRegistry([adapter]).resolveFor('fixture://docs/guide');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'adapter_failure');
  });

  it('fails closed when an adapter substitutes unverified locator authority', async () => {
    const adapter = new FixtureAdapter();
    adapter.resolve = async () => [{
      adapterId: adapter.id,
      locator: 'fixture://attacker/guide',
      scheme: 'fixture',
      authority: 'attacker',
      revision: 'rev-42',
    }];

    const result = await new SourceAdapterRegistry([adapter]).resolveFor('fixture://docs/guide');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'adapter_failure');
  });

  it('truncates oversized UTF-8 content on a character boundary and hashes returned data', () => {
    const result = new SourceAdapterRegistry().normalize(
      { content: 'ab🙂cd', revision: 'commit-abc' },
      { maxBytes: 5 },
    );

    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    assert.equal(result.source.content, 'ab');
    assert.equal(result.source.sha256, createHash('sha256').update('ab').digest('hex'));
    assert.deepEqual(result.source.byteBounds, { start: 0, end: 2, total: 8, truncated: true });
    assert.deepEqual(result.source.sectionBounds, { start: 1, end: 1, total: 1 });
    assert.equal(Object.isFrozen(result.source), true);
    assert.equal(Object.isFrozen(result.source.byteBounds), true);
    assert.equal(Object.isFrozen(result.source.sectionBounds), true);
  });

  it('rejects content that requires redaction', () => {
    const result = new SourceAdapterRegistry().normalize({
      content: 'secret',
      revision: 'commit-abc',
      redactionRequired: true,
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'redaction_required');
  });
});
