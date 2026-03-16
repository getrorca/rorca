import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        'surface-200': 'var(--surface-200)',
        border: 'var(--border)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-border': 'var(--accent-border)',
        muted: 'var(--text-muted)',
        skeleton: 'var(--skeleton)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        error: 'var(--error)',
        'terminal-bg': 'var(--terminal-bg)',
        'terminal-line': 'var(--terminal-line)',
        'switch-knob': 'var(--switch-knob)',
      },
    },
  },
  plugins: [],
};

export default config;
