/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { BASE_URL, getAccessToken, ApiError } from './apiFetch';

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: string;
}

export async function uploadAttachment(specId: string, file: File): Promise<Attachment> {
  const formData = new FormData();
  formData.append('file', file);

  const at = await getAccessToken();
  const headers: Record<string, string> = {};
  if (at) {
    headers['Authorization'] = `Bearer ${at}`;
  }

  const res = await fetch(`${BASE_URL}/api/specs/${encodeURIComponent(specId)}/attachments`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    let message: string;
    try {
      const json = JSON.parse(text);
      message = json.message || json.error || text;
    } catch {
      message = text || `HTTP ${res.status}`;
    }

    if (res.status === 413) {
      throw new ApiError(413, 'FILE_TOO_LARGE', 'File size exceeds 10MB limit');
    }
    if (res.status === 400) {
      throw new ApiError(400, 'INVALID_FILE', message);
    }
    if (res.status === 404) {
      throw new ApiError(404, 'SPEC_NOT_FOUND', `Spec not found: ${specId}`);
    }
    throw new ApiError(res.status, `HTTP_${res.status}`, message);
  }

  return res.json() as Promise<Attachment>;
}
