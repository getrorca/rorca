/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

interface RorcaLogoProps {
  size?: number;
  variant?: 'gradient' | 'flat';
  className?: string;
}

export default function RorcaLogo({ size = 32, variant = 'gradient', className }: RorcaLogoProps) {
  const uid = variant === 'gradient' ? 'g' : 'f';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="116 60 280 392"
      width={size}
      height={size}
      className={className}
      aria-label="Rorca logo"
      role="img"
    >
      <defs>
        {variant === 'gradient' ? (
          <>
            <linearGradient id={`lg-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#1A1D24" />
              <stop offset="100%" stopColor="#050505" />
            </linearGradient>
            <linearGradient id={`rg-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#515B6B" />
              <stop offset="100%" stopColor="#232934" />
            </linearGradient>
          </>
        ) : null}
        <clipPath id={`cd-${uid}`}>
          <rect x="132" y="132" width="248" height="248" rx="36" transform="rotate(45 256 256)" />
        </clipPath>
      </defs>

      {/* Diamond outline — white stroke so it's visible on both themes */}
      <rect x="116" y="116" width="280" height="280" rx="44" transform="rotate(45 256 256)" fill="currentColor" opacity="0.12" />
      <rect x="120" y="120" width="272" height="272" rx="40" transform="rotate(45 256 256)" fill="#FFFFFF" stroke="currentColor" strokeWidth="2" strokeOpacity="0.15" />

      <g clipPath={`url(#cd-${uid})`}>
        <rect x="0" y="0" width="256" height="512" fill={variant === 'gradient' ? `url(#lg-${uid})` : '#0A0A0A'} />
        <rect x="256" y="0" width="256" height="512" fill={variant === 'gradient' ? `url(#rg-${uid})` : '#374151'} />
        <line x1="256" y1="0" x2="256" y2="512" stroke="#E5E7EB" strokeWidth="12" />

        <g transform="rotate(45 256 256)">
          <rect x="224" y="156" width="124" height="60" rx="16" fill="#00E5FF" />
          <rect x="232" y="164" width="108" height="44" rx="8" fill="none" stroke="#000000" strokeWidth="5" opacity="0.9" />
        </g>
      </g>
    </svg>
  );
}
