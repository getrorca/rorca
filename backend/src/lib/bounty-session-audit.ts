/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { query, transaction } from '../db';
import { hashBountyContract } from './bounty-contracts';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from './errors';

export const BOUNTY_REDACTION_VERSION = 'bounty-redaction.v1' as const;
export type BountySourceRole = 'worker' | 'validator' | 'reporter' | 'broker';
export type BountyActivityChannel = 'note' | 'lead' | 'primitive' | 'finding' | 'draft';

const sensitiveKey = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|private[-_]?key|session[-_]?key)/i;
const secretText = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk|pk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /([?&](?:access_token|api_key|apikey|token|key|secret|password)=)[^&#\s]+/gi,
] as const;
const required = (value: string, name: string, max = 256): void => {
  if (!value.trim() || value.length > max) throw new ValidationError(`${name} is required and must be at most ${max} characters`);
};
const integer = (value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new ValidationError(`${name} must be a non-negative safe integer`);
};

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of secretText.slice(0, 3)) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted.replace(secretText[3], '$1[REDACTED]');
}

/** Deterministically remove credential material before durable event or projection storage. */
export function redactBountyPayload(value: unknown, key = '', depth = 0): unknown {
  if (depth > 32) throw new ValidationError('Event payload nesting exceeds 32 levels');
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => redactBountyPayload(entry, '', depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, redactBountyPayload(entry, entryKey, depth + 1)]));
  }
  throw new ValidationError('Event payload must be JSON');
}

export interface BountySessionEventInput {
  workspaceId: string; missionId: string; eventIdentity: string; sourceRole: BountySourceRole;
  workerId: string; sessionId: string; eventType: string; payload: Record<string, unknown>; occurredAt: string;
}
export interface BountySessionEvent {
  id: string; cursor: number; eventIdentity: string; sourceRole: BountySourceRole; workerId: string;
  sessionId: string; eventType: string; payload: Record<string, unknown>; sourceHash: string; occurredAt: string;
}
interface SessionEventRow {
  id: string; cursor: string; event_identity: string; source_role: BountySourceRole; worker_id: string;
  session_id: string; event_type: string; redacted_payload: Record<string, unknown>; source_hash: string; occurred_at: Date;
}
function mapSessionEvent(row: SessionEventRow): BountySessionEvent {
  return { id: row.id, cursor: Number(row.cursor), eventIdentity: row.event_identity, sourceRole: row.source_role, workerId: row.worker_id,
    sessionId: row.session_id, eventType: row.event_type, payload: row.redacted_payload, sourceHash: row.source_hash, occurredAt: row.occurred_at.toISOString() };
}

/** Append once and allocate a gap-free per-mission cursor under one transaction. */
export async function appendBountySessionEvent(input: BountySessionEventInput): Promise<{ event: BountySessionEvent; replayed: boolean }> {
  for (const [value, name] of [[input.workspaceId, 'workspaceId'], [input.missionId, 'missionId'], [input.eventIdentity, 'eventIdentity'], [input.workerId, 'workerId'], [input.sessionId, 'sessionId'], [input.eventType, 'eventType']] as const) required(value, name);
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new ValidationError('occurredAt must be an ISO timestamp');
  const sourceHash = hashBountyContract('session-event-source', input);
  const redacted = redactBountyPayload(input.payload) as Record<string, unknown>;
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-session-event:${input.workspaceId}:${input.eventIdentity}`]);
    const replay = await client.query<SessionEventRow>(
      'SELECT * FROM bounty_authoritative_session_events WHERE workspace_id=$1 AND event_identity=$2', [input.workspaceId, input.eventIdentity],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].source_hash !== sourceHash) throw new ConflictError('Event identity was reused with different authoritative content');
      return { event: mapSessionEvent(replay.rows[0]), replayed: true };
    }
    const mission = await client.query('SELECT 1 FROM bounty_missions WHERE workspace_id=$1 AND id=$2', [input.workspaceId, input.missionId]);
    if (!mission.rowCount) throw new NotFoundError('Bounty mission');
    const cursor = await client.query<{ last_cursor: string }>(
      `INSERT INTO bounty_session_stream_heads(workspace_id,mission_id,last_cursor) VALUES($1,$2,1)
       ON CONFLICT(workspace_id,mission_id) DO UPDATE SET last_cursor=bounty_session_stream_heads.last_cursor+1
       RETURNING last_cursor`, [input.workspaceId, input.missionId],
    );
    const inserted = await client.query<SessionEventRow>(
      `INSERT INTO bounty_authoritative_session_events
       (workspace_id,mission_id,cursor,event_identity,source_role,worker_id,session_id,event_type,redacted_payload,source_hash,redaction_version,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [input.workspaceId, input.missionId, cursor.rows[0]!.last_cursor, input.eventIdentity, input.sourceRole, input.workerId, input.sessionId, input.eventType, redacted, sourceHash, BOUNTY_REDACTION_VERSION, occurredAt],
    );
    return { event: mapSessionEvent(inserted.rows[0]!), replayed: false };
  });
}

/** Exclusive cursor pagination: reconnecting with nextCursor cannot repeat or skip a committed event. */
export async function readBountySessionEvents(workspaceId: string, missionId: string, afterCursor: number, limit = 200): Promise<{ events: BountySessionEvent[]; nextCursor: number; hasMore: boolean }> {
  required(workspaceId, 'workspaceId'); required(missionId, 'missionId'); integer(afterCursor, 'afterCursor'); integer(limit, 'limit', 500);
  if (limit < 1) throw new ValidationError('limit must be at least 1');
  const rows = await query<SessionEventRow>(
    `SELECT * FROM bounty_authoritative_session_events WHERE workspace_id=$1 AND mission_id=$2 AND cursor>$3
     ORDER BY cursor ASC LIMIT $4`, [workspaceId, missionId, afterCursor, limit + 1],
  );
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(mapSessionEvent);
  return { events, nextCursor: events.at(-1)?.cursor ?? afterCursor, hasMore };
}

const initialState: Record<BountyActivityChannel, string> = { note: 'active', lead: 'candidate', primitive: 'candidate', finding: 'draft', draft: 'drafting' };
const transitions: Record<BountyActivityChannel, ReadonlySet<string>> = {
  note: new Set(['active>archived']),
  lead: new Set(['candidate>investigating', 'candidate>rejected', 'investigating>validated', 'investigating>rejected', 'validated>promoted']),
  primitive: new Set(['candidate>verified', 'candidate>rejected', 'verified>promoted']),
  finding: new Set(['draft>validating', 'validating>confirmed', 'validating>false-positive', 'validating>oracle', 'confirmed>reported']),
  draft: new Set(['drafting>review', 'review>approved', 'review>rejected', 'rejected>drafting', 'approved>submitted']),
};
export function isLegalBountyActivityTransition(channel: BountyActivityChannel, previous: string | null, next: string): boolean {
  return previous === null ? initialState[channel] === next : transitions[channel].has(`${previous}>${next}`);
}

export interface BountyActivityTransitionInput {
  workspaceId: string; missionId: string; artifactId: string; eventIdentity: string; channel: BountyActivityChannel;
  expectedState: string | null; state: string; title: string; body: Record<string, unknown>; sourceCursor: number; actor: string;
}
/** Apply a legal lifecycle event to a rebuildable channel projection using a stable caller-owned artifact ID. */
export async function transitionBountyActivity(input: BountyActivityTransitionInput): Promise<{ artifactId: string; channel: BountyActivityChannel; state: string; replayed: boolean }> {
  for (const [value, name] of [[input.workspaceId, 'workspaceId'], [input.missionId, 'missionId'], [input.artifactId, 'artifactId'], [input.eventIdentity, 'eventIdentity'], [input.title, 'title'], [input.actor, 'actor']] as const) required(value, name, name === 'title' ? 512 : 256);
  integer(input.sourceCursor, 'sourceCursor');
  if (input.sourceCursor < 1) throw new ValidationError('sourceCursor must be positive');
  if (!isLegalBountyActivityTransition(input.channel, input.expectedState, input.state)) throw new UnprocessableError('Illegal bounty activity lifecycle transition', 'ILLEGAL_BOUNTY_ACTIVITY_TRANSITION');
  const body = redactBountyPayload(input.body) as Record<string, unknown>;
  const transitionHash = hashBountyContract('activity-transition', input);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-activity:${input.workspaceId}:${input.artifactId}`]);
    const replay = await client.query<{ transition_hash: string }>(
      'SELECT transition_hash FROM bounty_activity_lifecycle_events WHERE workspace_id=$1 AND event_identity=$2', [input.workspaceId, input.eventIdentity],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].transition_hash !== transitionHash) throw new ConflictError('Lifecycle event identity was reused');
      return { artifactId: input.artifactId, channel: input.channel, state: input.state, replayed: true };
    }
    const source = await client.query('SELECT 1 FROM bounty_authoritative_session_events WHERE workspace_id=$1 AND mission_id=$2 AND cursor=$3', [input.workspaceId, input.missionId, input.sourceCursor]);
    if (!source.rowCount) throw new NotFoundError('Authoritative bounty session event');
    const current = await client.query<{ current_state: string; channel: BountyActivityChannel }>(
      'SELECT current_state,channel FROM bounty_activity_projections WHERE workspace_id=$1 AND artifact_id=$2 FOR UPDATE', [input.workspaceId, input.artifactId],
    );
    if ((current.rows[0]?.current_state ?? null) !== input.expectedState || (current.rows[0] && current.rows[0].channel !== input.channel)) throw new ConflictError('Stale or mismatched activity projection state');
    if (!current.rows[0]) {
      await client.query(
        `INSERT INTO bounty_activity_projections(workspace_id,mission_id,artifact_id,channel,current_state,title,redacted_body,source_cursor)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.workspaceId, input.missionId, input.artifactId, input.channel, input.state, input.title, body, input.sourceCursor],
      );
    } else {
      await client.query(
        `UPDATE bounty_activity_projections SET current_state=$1,title=$2,redacted_body=$3,source_cursor=$4,updated_at=now()
         WHERE workspace_id=$5 AND artifact_id=$6`, [input.state, input.title, body, input.sourceCursor, input.workspaceId, input.artifactId],
      );
    }
    await client.query(
      `INSERT INTO bounty_activity_lifecycle_events(workspace_id,mission_id,artifact_id,event_identity,transition_hash,channel,previous_state,state,source_cursor,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.workspaceId, input.missionId, input.artifactId, input.eventIdentity, transitionHash, input.channel, input.expectedState, input.state, input.sourceCursor, input.actor],
    );
    return { artifactId: input.artifactId, channel: input.channel, state: input.state, replayed: false };
  });
}

export interface BountyActivityProjection {
  artifactId: string; channel: BountyActivityChannel; state: string; title: string;
  body: Record<string, unknown>; sourceCursor: number; updatedAt: string;
}
export async function readBountyActivities(workspaceId: string, missionId: string, channel?: BountyActivityChannel): Promise<BountyActivityProjection[]> {
  required(workspaceId, 'workspaceId'); required(missionId, 'missionId');
  const rows = await query<{ artifact_id: string; channel: BountyActivityChannel; current_state: string; title: string; redacted_body: Record<string, unknown>; source_cursor: string; updated_at: Date }>(
    `SELECT artifact_id,channel,current_state,title,redacted_body,source_cursor,updated_at FROM bounty_activity_projections
     WHERE workspace_id=$1 AND mission_id=$2 AND ($3::text IS NULL OR channel=$3)
     ORDER BY channel,source_cursor,artifact_id`, [workspaceId, missionId, channel ?? null],
  );
  return rows.map((row) => ({ artifactId: row.artifact_id, channel: row.channel, state: row.current_state, title: row.title, body: row.redacted_body, sourceCursor: Number(row.source_cursor), updatedAt: row.updated_at.toISOString() }));
}

export interface BountyNudgeInput {
  workspaceId: string; missionId: string; missionEpoch: number; operatorId: string; workerId: string;
  checkpointId: string; idempotencyKey: string; text: string; expiresAt: string;
}
export interface BountyNudge {
  id: string; operatorId: string; missionId: string; missionEpoch: number; workerId: string;
  checkpointId: string; textHash: string; text: string; expiresAt: string;
}
/** Persist an advisory-only nudge. This contract intentionally has no authority-bearing field. */
export async function issueBountyCheckpointNudge(input: BountyNudgeInput, now = new Date()): Promise<{ nudge: BountyNudge; replayed: boolean }> {
  for (const [value, name] of [[input.workspaceId, 'workspaceId'], [input.missionId, 'missionId'], [input.operatorId, 'operatorId'], [input.workerId, 'workerId'], [input.checkpointId, 'checkpointId'], [input.idempotencyKey, 'idempotencyKey']] as const) required(value, name);
  required(input.text, 'text', 4000); integer(input.missionEpoch, 'missionEpoch');
  if (input.missionEpoch < 1) throw new ValidationError('missionEpoch must be positive');
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry <= now || expiry.getTime() - now.getTime() > 86_400_000) throw new ValidationError('Nudge expiry must be within the next 24 hours');
  const textHash = hashBountyContract('checkpoint-nudge-text', input.text);
  const redactedText = redactString(input.text);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-nudge:${input.workspaceId}:${input.operatorId}:${input.idempotencyKey}`]);
    const replay = await client.query<{ id: string; mission_id: string; mission_epoch: string; operator_id: string; worker_id: string; checkpoint_id: string; text_hash: string; redacted_text: string; expires_at: Date }>(
      'SELECT * FROM bounty_checkpoint_nudges WHERE workspace_id=$1 AND operator_id=$2 AND idempotency_key=$3', [input.workspaceId, input.operatorId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.mission_id !== input.missionId || Number(row.mission_epoch) !== input.missionEpoch || row.worker_id !== input.workerId || row.checkpoint_id !== input.checkpointId || row.text_hash !== textHash || row.expires_at.getTime() !== expiry.getTime()) throw new ConflictError('Nudge idempotency key was reused with different bindings');
      return { nudge: mapNudge(row), replayed: true };
    }
    const authority = await client.query<{ epoch: string; state: string; process_mission: string | null; process_epoch: string | null; checkpoint_mission: string | null; exited_at: Date | null }>(
      `SELECT m.epoch,m.state,p.mission_id AS process_mission,p.authority_epoch AS process_epoch,p.exited_at,c.mission_id AS checkpoint_mission
       FROM bounty_missions m
       LEFT JOIN bounty_worker_processes p ON p.workspace_id=m.workspace_id AND p.id=$3
       LEFT JOIN bounty_continuation_checkpoints c ON c.workspace_id=m.workspace_id AND c.id=$4
       WHERE m.workspace_id=$1 AND m.id=$2 FOR UPDATE OF m`, [input.workspaceId, input.missionId, input.workerId, input.checkpointId],
    );
    const row = authority.rows[0];
    if (!row) throw new NotFoundError('Bounty mission');
    if (row.state !== 'active' || Number(row.epoch) !== input.missionEpoch) throw new ForbiddenError('Nudge mission authority is stale or inactive');
    if (row.process_mission !== input.missionId || Number(row.process_epoch) !== input.missionEpoch || row.exited_at || row.checkpoint_mission !== input.missionId) throw new ForbiddenError('Nudge worker and checkpoint must be live members of the exact mission epoch');
    const id = randomUUID();
    const inserted = await client.query<{ id: string; mission_id: string; mission_epoch: string; operator_id: string; worker_id: string; checkpoint_id: string; text_hash: string; redacted_text: string; expires_at: Date }>(
      `INSERT INTO bounty_checkpoint_nudges(id,workspace_id,mission_id,mission_epoch,operator_id,worker_id,checkpoint_id,idempotency_key,redacted_text,text_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [id, input.workspaceId, input.missionId, input.missionEpoch, input.operatorId, input.workerId, input.checkpointId, input.idempotencyKey, redactedText, textHash, expiry],
    );
    return { nudge: mapNudge(inserted.rows[0]!), replayed: false };
  });
}
function mapNudge(row: { id: string; mission_id: string; mission_epoch: string; operator_id: string; worker_id: string; checkpoint_id: string; text_hash: string; redacted_text: string; expires_at: Date }): BountyNudge {
  return { id: row.id, operatorId: row.operator_id, missionId: row.mission_id, missionEpoch: Number(row.mission_epoch), workerId: row.worker_id, checkpointId: row.checkpoint_id, textHash: row.text_hash, text: row.redacted_text, expiresAt: row.expires_at.toISOString() };
}

export interface BountyTelemetryInput {
  workspaceId: string; missionId: string; eventIdentity: string; workerId: string; phase: string; activity: string; skill: string; model: string; occurredAt: string;
  inputTokens: number; outputTokens: number; reasoningTokens: number; contextTokens: number; cacheHits: number; cacheHitTokens: number;
  toolCalls: number; effectCalls: number; requests: number; callbacks: number; wallTimeMs: number; costMicrousd: number;
  authLoopRequests: number; authLoopCostMicrousd: number; falsePositiveOutcomes: number; oracleOutcomes: number; highConfidenceAlerts: number;
}
const telemetryNumbers: Array<keyof BountyTelemetryInput> = ['inputTokens','outputTokens','reasoningTokens','contextTokens','cacheHits','cacheHitTokens','toolCalls','effectCalls','requests','callbacks','wallTimeMs','costMicrousd','authLoopRequests','authLoopCostMicrousd','falsePositiveOutcomes','oracleOutcomes','highConfidenceAlerts'];
/** Record additive accounting with all mission/worker/phase/activity/skill/model dimensions. */
export async function recordBountyTelemetry(input: BountyTelemetryInput): Promise<{ id: string; replayed: boolean }> {
  for (const [value, name] of [[input.workspaceId,'workspaceId'],[input.missionId,'missionId'],[input.eventIdentity,'eventIdentity'],[input.workerId,'workerId'],[input.phase,'phase'],[input.activity,'activity'],[input.skill,'skill'],[input.model,'model']] as const) required(value, name);
  for (const name of telemetryNumbers) integer(input[name] as number, name);
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new ValidationError('occurredAt must be an ISO timestamp');
  const metricHash = hashBountyContract('activity-telemetry', input);
  return transaction(async (client) => {
    const mission = await client.query('SELECT 1 FROM bounty_missions WHERE workspace_id=$1 AND id=$2', [input.workspaceId, input.missionId]);
    if (!mission.rowCount) throw new NotFoundError('Bounty mission');
    const id = randomUUID();
    const result = await client.query<{ id: string }>(
      `INSERT INTO bounty_activity_telemetry
       (id,workspace_id,mission_id,event_identity,metric_hash,worker_id,phase,activity,skill,model,input_tokens,output_tokens,reasoning_tokens,context_tokens,cache_hits,cache_hit_tokens,tool_calls,effect_calls,requests,callbacks,wall_time_ms,cost_microusd,auth_loop_requests,auth_loop_cost_microusd,false_positive_outcomes,oracle_outcomes,high_confidence_alerts,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT(workspace_id,event_identity) DO NOTHING RETURNING id`,
      [id,input.workspaceId,input.missionId,input.eventIdentity,metricHash,input.workerId,input.phase,input.activity,input.skill,input.model,input.inputTokens,input.outputTokens,input.reasoningTokens,input.contextTokens,input.cacheHits,input.cacheHitTokens,input.toolCalls,input.effectCalls,input.requests,input.callbacks,input.wallTimeMs,input.costMicrousd,input.authLoopRequests,input.authLoopCostMicrousd,input.falsePositiveOutcomes,input.oracleOutcomes,input.highConfidenceAlerts,new Date(input.occurredAt)],
    );
    if (result.rows[0]) return { id, replayed: false };
    const existing = await client.query<{ id: string; metric_hash: string }>('SELECT id,metric_hash FROM bounty_activity_telemetry WHERE workspace_id=$1 AND event_identity=$2', [input.workspaceId, input.eventIdentity]);
    if (existing.rows[0]!.metric_hash !== metricHash) throw new ConflictError('Telemetry identity was reused with different metrics');
    return { id: existing.rows[0]!.id, replayed: true };
  });
}

export interface BountyTelemetrySummary { workerId: string; phase: string; activity: string; skill: string; model: string; [metric: string]: string }
export async function summarizeBountyTelemetry(workspaceId: string, missionId: string): Promise<BountyTelemetrySummary[]> {
  required(workspaceId, 'workspaceId'); required(missionId, 'missionId');
  return query<BountyTelemetrySummary>(
    `SELECT worker_id AS "workerId",phase,activity,skill,model,
      sum(input_tokens) AS "inputTokens",sum(output_tokens) AS "outputTokens",sum(reasoning_tokens) AS "reasoningTokens",
      sum(context_tokens) AS "contextTokens",sum(cache_hits) AS "cacheHits",sum(cache_hit_tokens) AS "cacheHitTokens",sum(tool_calls) AS "toolCalls",
      sum(effect_calls) AS "effectCalls",sum(requests) AS requests,sum(callbacks) AS callbacks,sum(wall_time_ms) AS "wallTimeMs",
      sum(cost_microusd) AS "costMicrousd",sum(auth_loop_requests) AS "authLoopRequests",sum(auth_loop_cost_microusd) AS "authLoopCostMicrousd",
      sum(false_positive_outcomes) AS "falsePositiveOutcomes",sum(oracle_outcomes) AS "oracleOutcomes",sum(high_confidence_alerts) AS "highConfidenceAlerts"
     FROM bounty_activity_telemetry WHERE workspace_id=$1 AND mission_id=$2 GROUP BY worker_id,phase,activity,skill,model
     ORDER BY phase,activity,skill,model,worker_id`, [workspaceId, missionId],
  );
}

export interface BountyAlertProjection { alertId: string; sourceCursor: number; confidence: number; severity: 'low'|'medium'|'high'|'critical'; triageState: 'new'|'triaged'|'escalated'|'dismissed'|'resolved'; summary: string; outcome?: 'confirmed'|'false-positive'|'oracle' }
export interface BountyAlertProjectionInput extends BountyAlertProjection { workspaceId: string; missionId: string; expectedState: BountyAlertProjection['triageState'] | null }
const severityRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const alertTransitions = new Set(['new>triaged','new>escalated','new>dismissed','triaged>escalated','triaged>dismissed','triaged>resolved','escalated>resolved','escalated>dismissed']);
/** Stable ordering used by both API triage and the 50-alert/day load fixture. */
export function rankBountyAlerts(alerts: readonly BountyAlertProjection[]): BountyAlertProjection[] {
  return [...alerts].sort((left, right) => right.confidence - left.confidence || severityRank[right.severity] - severityRank[left.severity] || left.sourceCursor - right.sourceCursor || left.alertId.localeCompare(right.alertId));
}

/** Persist or legally transition a rebuildable alert projection tied to authoritative evidence. */
export async function projectBountyAlert(input: BountyAlertProjectionInput): Promise<BountyAlertProjection> {
  required(input.workspaceId, 'workspaceId'); required(input.missionId, 'missionId'); required(input.alertId, 'alertId'); required(input.summary, 'summary', 2000);
  integer(input.sourceCursor, 'sourceCursor');
  if (input.sourceCursor < 1 || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new ValidationError('Alert source cursor or confidence is invalid');
  if (input.expectedState === null ? input.triageState !== 'new' : !alertTransitions.has(`${input.expectedState}>${input.triageState}`)) throw new UnprocessableError('Illegal alert triage transition', 'ILLEGAL_ALERT_TRANSITION');
  const summary = redactString(input.summary);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-alert:${input.workspaceId}:${input.alertId}`]);
    const source = await client.query('SELECT 1 FROM bounty_authoritative_session_events WHERE workspace_id=$1 AND mission_id=$2 AND cursor=$3', [input.workspaceId, input.missionId, input.sourceCursor]);
    if (!source.rowCount) throw new NotFoundError('Authoritative bounty session event');
    const current = await client.query<{ triage_state: BountyAlertProjection['triageState'] }>('SELECT triage_state FROM bounty_alert_projections WHERE workspace_id=$1 AND alert_id=$2 FOR UPDATE', [input.workspaceId, input.alertId]);
    if ((current.rows[0]?.triage_state ?? null) !== input.expectedState) throw new ConflictError('Stale alert triage state');
    if (!current.rows[0]) {
      await client.query(
        `INSERT INTO bounty_alert_projections(workspace_id,mission_id,alert_id,source_cursor,confidence,severity,triage_state,redacted_summary,outcome)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.workspaceId,input.missionId,input.alertId,input.sourceCursor,input.confidence,input.severity,input.triageState,summary,input.outcome ?? null],
      );
    } else {
      await client.query(
        `UPDATE bounty_alert_projections SET source_cursor=$1,confidence=$2,severity=$3,triage_state=$4,redacted_summary=$5,outcome=$6,updated_at=now()
         WHERE workspace_id=$7 AND alert_id=$8`, [input.sourceCursor,input.confidence,input.severity,input.triageState,summary,input.outcome ?? null,input.workspaceId,input.alertId],
      );
    }
    return { alertId: input.alertId, sourceCursor: input.sourceCursor, confidence: input.confidence, severity: input.severity, triageState: input.triageState, summary, ...(input.outcome ? { outcome: input.outcome } : {}) };
  });
}

export async function readBountyAlerts(workspaceId: string, missionId: string): Promise<BountyAlertProjection[]> {
  required(workspaceId, 'workspaceId'); required(missionId, 'missionId');
  const rows = await query<{ alert_id: string; source_cursor: string; confidence: string; severity: BountyAlertProjection['severity']; triage_state: BountyAlertProjection['triageState']; redacted_summary: string; outcome: BountyAlertProjection['outcome'] | null }>(
    `SELECT alert_id,source_cursor,confidence,severity,triage_state,redacted_summary,outcome FROM bounty_alert_projections
     WHERE workspace_id=$1 AND mission_id=$2 AND triage_state IN ('new','triaged','escalated')`, [workspaceId, missionId],
  );
  return rankBountyAlerts(rows.map((row) => ({ alertId: row.alert_id, sourceCursor: Number(row.source_cursor), confidence: Number(row.confidence), severity: row.severity, triageState: row.triage_state, summary: row.redacted_summary, ...(row.outcome ? { outcome: row.outcome } : {}) })));
}
