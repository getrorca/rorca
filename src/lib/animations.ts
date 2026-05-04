/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Shared animation variants for Framer Motion
 * Uses Material Design standard easing: [0.4, 0, 0.2, 1]
 * All animations respect prefers-reduced-motion media query
 */

export const EASING = [0.4, 0, 0.2, 1] as const;

/**
 * Detect if user prefers reduced motion
 */
export const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/**
 * Get transition config, respecting prefers-reduced-motion
 */
const getTransition = (duration: number = 0.2) => {
  if (prefersReducedMotion()) {
    return { duration: 0 };
  }
  return {
    duration,
    ease: EASING,
  };
};

/**
 * Fade in animation
 * Used for: panel entry, general content appearance
 */
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: getTransition(0.2),
};

/**
 * Slide up animation with fade
 * Used for: panel transitions, dropdown menus, modals entering from bottom
 */
export const slideUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
  transition: getTransition(0.2),
};

/**
 * Slide down animation with fade
 * Used for: content entering from top, notifications
 */
export const slideDown = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: getTransition(0.2),
};

/**
 * Slide right animation with fade
 * Used for: toast notifications, drawers from left, success messages
 */
export const slideRight = {
  initial: { opacity: 0, x: -16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 16 },
  transition: getTransition(0.2),
};

/**
 * Slide left animation with fade
 * Used for: notifications exiting, drawers closing
 */
export const slideLeft = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: getTransition(0.2),
};

/**
 * Scale in animation with fade
 * Used for: modal/dialog entry, badges, success indicators
 */
export const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: getTransition(0.15),
};

/**
 * Pop scale animation (bouncy entry)
 * Used for: success checkmarks, positive feedback
 */
export const scalePop = {
  initial: { opacity: 0, scale: 0 },
  animate: { opacity: 1, scale: 1 },
  transition: {
    ...getTransition(0.4),
    ease: 'easeOut',
  },
};

/**
 * Stagger children animation
 * Used in parent Motion.div to stagger child animations
 * Example: <motion.div variants={staggerContainer} initial="initial" animate="animate">
 *            <motion.div variants={slideUp}>Item 1</motion.div>
 *            <motion.div variants={slideUp}>Item 2</motion.div>
 *          </motion.div>
 */
export const staggerContainer = {
  initial: 'initial',
  animate: 'animate',
  variants: {
    initial: {},
    animate: {
      transition: {
        staggerChildren: 0.03, // 30ms stagger delay between items
      },
    },
  },
};

/**
 * Stagger item variant for use with staggerContainer
 */
export const staggerItem = slideUp;

/**
 * Pulse/shimmer animation for loading states
 * Used for: skeleton screens, loading indicators
 */
export const pulse = {
  animate: {
    opacity: [0.5, 1, 0.5],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};

/**
 * Wave pulse animation for active running states
 * Used for: pipeline running indicator
 */
export const wavePulse = {
  animate: {
    backgroundColor: [
      'rgba(59, 130, 246, 0)',
      'rgba(59, 130, 246, 0.08)',
      'rgba(59, 130, 246, 0)',
      'rgba(59, 130, 246, 0.05)',
      'rgba(59, 130, 246, 0)',
    ],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 1.2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};

/**
 * Success flash animation
 * Used for: story pass confirmation, success states
 */
export const successFlash = {
  animate: {
    backgroundColor: [
      'rgba(16, 185, 129, 0.18)',
      'rgba(16, 185, 129, 0)',
    ],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.6,
    ease: 'easeOut',
  },
};

/**
 * Checkmark pop animation with slight overshoot
 * Used for: success indicators, checkmarks
 */
export const checkmarkPop = {
  initial: { scale: 0, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.4,
    ease: [0.34, 1.56, 0.64, 1], // Custom easing with overshoot
  },
};

/**
 * Dot fade in with pulse animation
 * Used for: status indicators, activity dots
 */
export const dotFadeInPulse = {
  initial: { opacity: 0, scale: 0.5 },
  animate: {
    opacity: [0, 1, 1],
    scale: [0.5, 1.15, 1],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.5,
    ease: 'easeOut',
  },
};

/**
 * Indeterminate progress bar animation
 * Used for: loading progress bars
 */
export const indeterminateProgress = {
  animate: {
    x: ['calc(-100%)', 'calc(250%)'],
    width: ['40%', '60%', '40%'],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 1.8,
    repeat: Infinity,
    ease: [0.65, 0, 0.35, 1],
  },
};

/**
 * Breath animation (subtle expand/contract)
 * Used for: focus states, interactive elements
 */
export const breath = {
  animate: {
    scale: [1, 1.02, 1],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 2,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};

/**
 * Flip animation (rotate on Y axis)
 * Used for: status flips, toggle animations
 */
export const flip = {
  initial: { rotateY: 0 },
  animate: { rotateY: 360 },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.6,
    ease: 'easeInOut',
  },
};

/**
 * Shake animation (for error states)
 * Used for: validation errors, alerts
 */
export const shake = {
  animate: {
    x: [-4, 4, -4, 4, 0],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.4,
    ease: 'easeInOut',
  },
};

/**
 * Bounce animation
 * Used for: attention-getting animations
 */
export const bounce = {
  animate: {
    y: [0, -6, 0],
  },
  transition: {
    duration: prefersReducedMotion() ? 0 : 0.6,
    repeat: Infinity,
    ease: 'easeInOut',
  },
};

/**
 * Pan/scroll animation for carousel/list items
 * Used for: horizontal scrolling content
 */
export const panLeft = {
  initial: { x: 100, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: -100, opacity: 0 },
  transition: getTransition(0.3),
};

export const panRight = {
  initial: { x: -100, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: 100, opacity: 0 },
  transition: getTransition(0.3),
};

/**
 * Nav drawer entry (full-height slide from left)
 * Used for: sidebar/drawer navigation
 */
export const navDrawerIn = {
  initial: { x: '-100%' },
  animate: { x: 0 },
  exit: { x: '-100%' },
  transition: getTransition(0.15),
};

/**
 * Create a custom stagger variant for n items
 * @param count Number of items to stagger
 * @param delay Delay between items in seconds
 * @returns Motion variants object
 */
export const createStaggerVariants = (count: number, delay: number = 0.03) => ({
  container: {
    initial: 'initial',
    animate: 'animate',
    variants: {
      initial: {},
      animate: {
        transition: {
          staggerChildren: delay,
        },
      },
    },
  },
  item: slideUp,
});

/**
 * Compose multiple animation variants
 * @param variants Array of variant objects to merge
 * @returns Merged variants
 */
export const composeVariants = (variants: Array<Record<string, any>>) => {
  return variants.reduce((acc, variant) => ({ ...acc, ...variant }), {});
};
