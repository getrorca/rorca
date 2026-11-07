/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Short, copyable hash chip. Full hash strings (sha256:…) are never rendered
 * as content: the chip shows the first characters, keeps the complete value in
 * the tooltip, and copies it on activation with an explicit Copied confirmation.
 */
export function shortenLifecycleHash(value: string): string {
  const withoutPrefix = value.replace(/^sha256:/i, '');
  if (withoutPrefix.length <= 12) return withoutPrefix;
  return `${withoutPrefix.slice(0, 10)}…`;
}

interface LifecycleHashChipProps {
  value: string;
  label: string;
  ariaLabel?: string;
}

export default function LifecycleHashChip({ value, label, ariaLabel }: LifecycleHashChipProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="lifecycle-hash-chip"
      title={value}
      aria-label={ariaLabel ?? `Copy ${label}: ${shortenLifecycleHash(value)}`}
    >
      <code className="lifecycle-hash-chip__value">{shortenLifecycleHash(value)}</code>
      {copied
        ? <span className="lifecycle-hash-chip__copied"><Check size={11} aria-hidden="true" /> Copied</span>
        : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}

interface ProseWithHashesProps {
  text: string | null | undefined;
}

/**
 * Renders server-authored prose without exposing full SHA-256 values as text.
 * Each embedded hash remains available through the standard copyable hash chip.
 */
export function ProseWithHashes({ text }: ProseWithHashesProps) {
  if (!text) return null;

  const parts: ReactNode[] = [];
  const pattern = /sha256:[a-f0-9]{64}/gi;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const value = match[0];
    const shortReference = shortenLifecycleHash(value);
    parts.push(
      <LifecycleHashChip
        key={`${match.index}:${value}`}
        value={value}
        label="hash"
        ariaLabel={`${shortReference} copy full hash`}
      />,
    );
    cursor = match.index + value.length;
    match = pattern.exec(text);
  }
  if (cursor === 0) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
