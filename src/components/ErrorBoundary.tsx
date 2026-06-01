/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional label shown in fallback (e.g. panel name) */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.label ?? 'unknown', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full bg-panel border border-border rounded-xl p-6 text-center">
            <div className="mx-auto w-10 h-10 rounded-full bg-error/15 flex items-center justify-center mb-4">
              <AlertTriangle size={20} className="text-error" />
            </div>
            <h3 className="text-base font-semibold text-primary mb-1">
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
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
            >
              <RotateCcw size={14} />
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
