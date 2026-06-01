/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * AnimatedPanel: Wraps panel content with Framer Motion entrance animation
 * Automatically animates with slideUp + fadeIn on mount
 * Respects prefers-reduced-motion
 */

import { motion } from 'framer-motion';
import { slideUp } from '../lib/animations';

interface AnimatedPanelProps {
  children: React.ReactNode;
  className?: string;
  delay?: number; // Additional delay in seconds
}

export function AnimatedPanel({
  children,
  className = '',
  delay = 0,
}: AnimatedPanelProps) {
  return (
    <motion.div
      variants={slideUp}
      initial="initial"
      animate="animate"
      className={className}
      transition={{
        duration: 0.2,
        ease: [0.4, 0, 0.2, 1],
        delay,
      }}
    >
      {children}
    </motion.div>
  );
}

export default AnimatedPanel;
