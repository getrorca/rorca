/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { parsePiModelTable } from '../pi-detector';

describe('pi-detector', () => {
  it('parses Pi model tables emitted on stderr and ignores the header row', () => {
    const table = `provider      model                                                 context  max-out  thinking  images
omlx          Qwen3.6-27B-Claude-Opus-Reasoning-Distilled-mlx-8Bit  200K     200K     no        no    
openai-codex  gpt-5.1                                               272K     128K     yes       yes   
openai-codex  gpt-5.2                                               272K     128K     yes       yes   `;

    const models = parsePiModelTable(table);

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      provider: 'omlx',
      model: 'Qwen3.6-27B-Claude-Opus-Reasoning-Distilled-mlx-8Bit',
      contextTokens: 200_000,
      maxOutTokens: 200_000,
      thinking: false,
      images: false,
    });
    expect(models[1]).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.1',
      contextTokens: 272_000,
      maxOutTokens: 128_000,
      thinking: true,
      images: true,
    });
  });
});
