/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Rorca API',
      version: '2.0.0',
      description:
        'AI spec orchestration and pipeline management for autonomous Claude Code development. ' +
        'Rorca turns plain-English briefs into validated, structured specs via Claude, ' +
        'tracks approval/execution, and provides live pipeline monitoring.',
      contact: { name: 'Rorca', url: 'https://rorca.dev' },
      license: { name: 'MIT' },
    },
    servers: [{ url: 'http://localhost:3030', description: 'Local dev server' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Supabase bearer token obtained from the configured Supabase auth flow. ' +
            'Pass as: Authorization: Bearer <token>',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Error message' },
          },
        },
        Workspace: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'cashflow-ai' },
            label: { type: 'string', example: 'CashflowAI' },
            path: { type: 'string', example: '/Users/dev/cashflow-ai' },
            domain: { type: 'string', example: 'saas', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        UserStory: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'US-001' },
            title: { type: 'string', example: 'User login' },
            description: { type: 'string' },
            acceptanceCriteria: {
              type: 'array',
              items: { type: 'string' },
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              example: [],
            },
            passes: { type: 'boolean', example: false },
          },
        },
        Spec: {
          type: 'object',
          properties: {
            title: { type: 'string', example: 'my-spec-slug' },
            userStories: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserStory' },
            },
            model: {
              type: 'string',
              example: 'claude-sonnet-4-6',
            },
            generatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PipelineRun: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            workspace_id: { type: 'string' },
            spec_path: { type: 'string' },
            status: {
              type: 'string',
              enum: ['running', 'passed', 'failed', 'paused', 'cancelled'],
            },
            pid: { type: 'integer', nullable: true },
            started_at: { type: 'string', format: 'date-time' },
            finished_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            branch_name: { type: 'string', nullable: true },
            worktree_path: { type: 'string', nullable: true },
          },
        },
        StoryResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            run_id: { type: 'integer' },
            story_id: { type: 'string', example: 'US-001' },
            status: {
              type: 'string',
              enum: ['passed', 'failed', 'skipped'],
            },
            started_at: { type: 'string', format: 'date-time' },
            finished_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
          },
        },
        WalEvent: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            event_type: {
              type: 'string',
              enum: [
                'generate',
                'spec_approved',
                'spec_rejected',
                'run_started',
                'story_started',
                'story_passed',
                'story_failed',
                'story_skipped',
                'run_finished',
                'worktree_created',
                'worktree_merged',
              ],
            },
            spec_id: { type: 'string', nullable: true },
            workspace_id: { type: 'string', nullable: true },
            payload: { type: 'object' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        DirectionLayer: {
          type: 'object',
          properties: {
            layer: { type: 'integer', enum: [1, 2, 3] },
            workspace_id: { type: 'string', nullable: true },
            domain: { type: 'string', nullable: true },
            content_yaml: { type: 'string' },
            preferred_model: { type: 'string', nullable: true },
          },
        },
        Template: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            brief: { type: 'string' },
            story_structure: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            avg_rating: { type: 'number', nullable: true },
            rating_count: { type: 'integer' },
          },
        },
        GitWorktree: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            branch: { type: 'string' },
            head: { type: 'string' },
            isBare: { type: 'boolean' },
            isMain: { type: 'boolean' },
          },
        },
        Team: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication and user management' },
      { name: 'Workspaces', description: 'Git repository workspace management' },
      { name: 'Direction Stack', description: 'L1-L5 direction layer configuration' },
      { name: 'Specs', description: 'Spec generation, review, and approval' },
      { name: 'Pipeline', description: 'Pipeline execution, monitoring, and SSE streams' },
      { name: 'Worktrees', description: 'Git worktree management' },
      { name: 'Templates', description: 'Reusable spec templates' },
      { name: 'Stories', description: 'Cross-spec story search' },
      { name: 'WAL', description: 'Write-ahead log event stream' },
      { name: 'Context', description: 'Context extraction for direction layers' },
      { name: 'Analytics', description: 'Usage analytics, costs, velocity, and export' },
      { name: 'Health', description: 'Health check' },
      { name: 'GitHub', description: 'GitHub repository integration and webhooks' },
      { name: 'Vault', description: 'Encrypted API key vault management' },
      { name: 'Agent Profiles', description: 'Named agent configurations (model, temperature, etc.)' },
      { name: 'Agent Hooks', description: 'Pre/post story lifecycle hook management' },
      { name: 'Notifications', description: 'In-app notification preferences and history' },
      { name: 'Settings', description: 'User settings and preferences' },
      { name: 'Webhooks', description: 'Incoming webhook receivers (GitHub, etc.)' },
      { name: 'Environment Variables', description: 'Per-workspace environment variable injection' },
      { name: 'Users', description: 'Local user profile and account operations' },
      { name: 'Budget', description: 'Workspace spending limits and budget configuration' },
      { name: 'Activity', description: 'Activity feed and audit trail' },
      { name: 'Onboarding', description: 'Onboarding wizard state management' },
      { name: 'Admin', description: 'Administrative operations (backups, maintenance)' },
      { name: 'Config', description: 'Orchestration configuration (.rorca/config.json)' },
      { name: 'Context Routing', description: 'Virtual context routing rules' },
      { name: 'Context Files', description: 'Context file management (CLAUDE.md, MEMORY.md, AGENTS.md)' },
      { name: 'Skills', description: 'Skill library management (.rorca/skills/)' },
      { name: 'Personas', description: 'Agent persona definitions and management' },
      { name: 'Conventions', description: 'Convention discovery, checking, and drift detection' },
      { name: 'Packs', description: 'Convention pack installation and management' },
    ],
  },
  apis: [
    path.join(__dirname, '../routes/*.ts'),
    path.join(__dirname, '../routes/*.js'),
    path.join(__dirname, './swagger.ts'),
    path.join(__dirname, './swagger.js'),
  ],
};

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     security: []
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 ts: { type: string, format: date-time }
 */

let swaggerSpec: ReturnType<typeof swaggerJsdoc>;
try {
  swaggerSpec = swaggerJsdoc(options);
} catch (e) {
  // Swagger YAML parse errors are non-fatal — log and continue with empty spec
  console.warn('[swagger] Failed to parse swagger annotations:', (e as Error).message?.slice(0, 200));
  swaggerSpec = { openapi: '3.0.0', info: { title: 'Rorca API', version: '1.0.0' }, paths: {} };
}
export { swaggerSpec };
