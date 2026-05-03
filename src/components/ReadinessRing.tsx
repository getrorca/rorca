/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { HelpTooltip } from './HelpTooltip';

interface ReadinessRingProps {
  percent: number;
  size?: number;
  showHelp?: boolean;
}

export function ReadinessRing({ percent, size = 32, showHelp }: ReadinessRingProps) {
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  const color =
    percent >= 80
      ? 'text-success'
      : percent >= 50
      ? 'text-warning'
      : 'text-error';

  return (
    <div className="inline-flex items-center gap-1">
      <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-border"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={color}
          />
        </svg>
        <span className={`absolute text-[9px] font-semibold ${color}`}>
          {percent}
        </span>
      </div>
      {showHelp && <HelpTooltip helpKey="readiness-percent" size={10} />}
    </div>
  );
}
