/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as path from "node:path";
import type { PipelineRunDetailResponse, PipelineRunSummary, StoryResultSummary, WatchSnapshot, Workspace } from "./types.js";

export function specSlugFromPath(specPath: string): string {
  return path.basename(specPath, ".json");
}

export function buildWatchSnapshot(runDetail: PipelineRunDetailResponse, cwd: string = process.cwd()): WatchSnapshot {
  const stories = runDetail.stories || [];
  const counts = summarizeStories(stories);
  return {
    runId: runDetail.run.id,
    status: runDetail.run.status,
    specSlug: specSlugFromPath(runDetail.run.spec_path),
    storyCounts: counts,
    stories,
    worktreePath: runDetail.run.worktree_path,
    branchName: runDetail.run.branch_name,
    triggeredVia: runDetail.run.triggered_via,
    progressDir: path.join(cwd, ".rorca", "progress", `run-${runDetail.run.id}`),
  };
}

export function summarizeStories(stories: StoryResultSummary[]): WatchSnapshot["storyCounts"] {
  const counts: WatchSnapshot["storyCounts"] = {
    total: stories.length,
    pass: 0,
    fail: 0,
    running: 0,
    blocked: 0,
    queued: 0,
    skipped: 0,
  };

  for (const story of stories) {
    const status = (story.status || "").toLowerCase();
    if (status === "pass" || status === "passed") counts.pass += 1;
    else if (status === "fail" || status === "failed") counts.fail += 1;
    else if (status === "running") counts.running += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "queued") counts.queued += 1;
    else if (status === "skipped") counts.skipped += 1;
  }

  return counts;
}

export function formatRunWidget(snapshot: WatchSnapshot): string[] {
  const counts = snapshot.storyCounts;
  const lines = [
    `Rorca Run #${snapshot.runId} — ${snapshot.status}`,
    `Spec: ${snapshot.specSlug}`,
    `Stories: ${counts.pass}/${counts.total} pass · ${counts.fail} fail · ${counts.running} running · ${counts.blocked} blocked · ${counts.queued} queued`,
  ];

  if (snapshot.branchName) lines.push(`Branch: ${snapshot.branchName}`);
  if (snapshot.worktreePath) lines.push(`Worktree: ${snapshot.worktreePath}`);
  if (snapshot.progressDir) lines.push(`Progress logs: ${snapshot.progressDir}`);

  const recentStories = snapshot.stories.slice(0, 6).map((story) => `- ${story.story_id}: ${story.status}`);
  return lines.concat(recentStories);
}

export function formatRunNotify(snapshot: WatchSnapshot): string {
  const counts = snapshot.storyCounts;
  return [
    `Run #${snapshot.runId} — ${snapshot.status}`,
    `Spec: ${snapshot.specSlug}`,
    `Stories: ${counts.total} total, ${counts.pass} pass, ${counts.fail} fail, ${counts.running} running, ${counts.blocked} blocked, ${counts.queued} queued.`,
    snapshot.progressDir ? `Progress logs: ${snapshot.progressDir}` : undefined,
  ].filter(Boolean).join("\n");
}

export function formatRunList(runs: PipelineRunSummary[], workspaces: Workspace[]): string {
  if (runs.length === 0) return "No pipeline runs found.";

  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace.label || workspace.id]));
  return runs
    .map((run) => {
      const workspaceLabel = workspaceMap.get(run.workspace_id || "") || run.workspace_id || "-";
      return `#${run.id} ${run.status.padEnd(10)} ${specSlugFromPath(run.spec_path)} (${workspaceLabel})`;
    })
    .join("\n");
}
