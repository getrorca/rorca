import { describe, expect, it } from 'vitest';
import {
  formatRunCostTelemetry,
  formatRunTokenTelemetry,
  normalizePipelineRun,
  normalizeRunTokenTelemetry,
} from '../run-metadata';

describe('run metadata normalization', () => {
  it('uses canonical metadata and does not fabricate Claude for legacy rows', () => {
    const run = normalizePipelineRun({ status: 'done', terminal_mode: 'pty' });

    expect(run).toMatchObject({
      agentType: 'unknown',
      agentModel: null,
      terminalMode: 'pty',
      lifecyclePhase: 'finished',
      lifecycleStatus: 'finished',
    });
  });

  it('preserves Pi and Terra from canonical and legacy DTO aliases', () => {
    expect(normalizePipelineRun({
      status: 'running',
      agent_type: 'pi',
      agent_model: 'openai-codex/gpt-5.6-terra',
    })).toMatchObject({
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-terra',
    });
  });

  it('uses the backend lifecycle status instead of guessing from stale status', () => {
    expect(normalizePipelineRun({
      status: 'running',
      lifecycle_status: 'pty_attached',
    }).lifecycleStatus).toBe('pty_attached');
  });

  it('renders unavailable interactive telemetry honestly and retains real zeroes', () => {
    const unavailablePi = normalizeRunTokenTelemetry();
    expect(formatRunTokenTelemetry(unavailablePi, 'pi')).toBe('Unavailable — Pi-managed billing');
    expect(formatRunCostTelemetry(unavailablePi, 'pi')).toBe('Pi-managed billing');

    const realZeroes = normalizeRunTokenTelemetry({ inputTokens: 0, outputTokens: 0, totalCostUsd: 0 });
    expect(formatRunTokenTelemetry(realZeroes, 'pi')).toBe('0 in / 0 out');
    expect(formatRunCostTelemetry(realZeroes, 'pi')).toBe('$0.00');
  });

  it('keeps partial and nonzero token telemetry rather than filling missing values', () => {
    const telemetry = normalizeRunTokenTelemetry({ inputTokens: 1234, outputTokens: null, totalCostUsd: 0.42 });
    expect(formatRunTokenTelemetry(telemetry, 'opencode')).toBe('1.2K in / Unavailable out');
    expect(formatRunCostTelemetry(telemetry, 'opencode')).toBe('$0.42');
  });
});
