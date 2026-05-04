/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * AnimatedList: Renders list items with staggered entrance animation
 * Used for: search results, spec cards, story cards, activity feeds
 * Stagger delay: 30ms between items
 */

import { motion, Variants } from 'framer-motion';
import { slideUp } from '../lib/animations';

interface AnimatedListProps {
  children: React.ReactNode[];
  className?: string;
  staggerDelay?: number; // Delay between items in seconds (default 0.03 = 30ms)
}

const containerVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.03,
    },
  },
};

export function AnimatedList({
  children,
  className = '',
  staggerDelay = 0.03,
}: AnimatedListProps) {
  return (
    <motion.div
      variants={containerVariants}
      initial="initial"
      animate="animate"
      className={className}
      transition={{
        staggerChildren: staggerDelay,
      }}
    >
      {children && children.map((child, index) => (
        <motion.div key={index} variants={slideUp}>
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}

export default AnimatedList;
