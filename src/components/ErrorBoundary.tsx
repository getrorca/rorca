/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Component, createRef, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

let nextErrorBoundaryId = 0;

interface Props {
  children: ReactNode;
  /** Optional label shown in fallback (e.g. panel name) */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  incidentReference: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, incidentReference: null };
  private readonly headingRef = createRef<HTMLHeadingElement>();
  private readonly headingId = `panel-error-heading-${++nextErrorBoundaryId}`;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const incidentReference = `UI-${Date.now().toString(36).toUpperCase()}`;
    console.error('[ErrorBoundary]', incidentReference, this.props.label ?? 'unknown', error, info.componentStack);
    this.setState({ incidentReference }, () => this.headingRef.current?.focus());
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, incidentReference: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div
            className="max-w-md w-full bg-panel border border-border rounded-xl p-6 text-center"
            role="alert"
            aria-labelledby={this.headingId}
          >
            <div className="mx-auto w-10 h-10 rounded-full bg-error/15 flex items-center justify-center mb-4">
              <AlertTriangle size={20} className="text-error" aria-hidden="true" />
            </div>
            <h3
              ref={this.headingRef}
              id={this.headingId}
              tabIndex={-1}
              className="text-base font-semibold text-[var(--text)] mb-1"
            >
              Something went wrong
            </h3>
            {this.props.label && (
              <p className="text-xs text-muted mb-2">in {this.props.label}</p>
            )}
            {import.meta.env.DEV && (
              <p className="text-sm text-secondary mb-4 font-mono break-all">
                {this.state.error?.message || 'An unexpected error occurred'}
              </p>
            )}
            {this.state.incidentReference && (
              <p className="mb-4 text-xs text-muted">
                Incident reference: <code className="font-mono text-[var(--text)]">{this.state.incidentReference}</code>
              </p>
            )}
            {!import.meta.env.DEV && (
              <p className="mb-4 text-sm text-muted">
                Retry this panel. If it fails again, include the incident reference when reporting the problem.
              </p>
            )}
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-[var(--accent-contrast)] text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              <RotateCcw size={14} aria-hidden="true" />
              Retry
            </button>
            <a href="/today" className="ml-3 inline-flex px-3 py-2 text-sm font-medium text-muted hover:text-[var(--text)]">
              Return to Today
            </a>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
