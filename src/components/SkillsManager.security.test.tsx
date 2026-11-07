/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { validateSkillImportUrl } from './SkillsManager';

describe('skill import URL validation', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/markdown,pwned',
    'javascript:alert(1)',
    'https://operator:secret@example.test/skill.md',
    'not a URL',
  ])('rejects malformed or credential-bearing URL %s', (value) => {
    expect(validateSkillImportUrl(value)).toEqual(expect.any(String));
  });

  it('accepts a normal absolute HTTPS URL for backend policy validation', () => {
    expect(validateSkillImportUrl('https://raw.githubusercontent.com/acme/skills/main/SKILL.md')).toBeNull();
  });
});
