/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

#!/usr/bin/env tsx

import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface CommitInfo {
  hash: string;
  message: string;
  category: string;
}

interface VersionEntry {
  version: string;
  date: string;
  compareUrl: string;
  commits: Map<string, string[]>;
}

const CONVENTIONAL_PREFIX_REGEX = /^(\w+)(?:\([^)]*\))?:\s*(.+)/;
const CATEGORY_MAP: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  refactor: 'Changed',
  perf: 'Changed',
  chore: 'ignored',
  ci: 'ignored',
  docs: 'ignored',
  build: 'ignored',
  test: 'ignored',
  style: 'ignored',
};

function getRepoInfo(): { owner: string; repo: string; remote: string } {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    // Parse "git@github.com:owner/repo.git" or "https://github.com/owner/repo.git"
    const match = remote.match(
      /(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/
    );

    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        remote,
      };
    }
  } catch {
    // Fall back to default
  }

  return {
    owner: 'getrorca',
    repo: 'rorca',
    remote: 'https://github.com/getrorca/rorca.git',
  };
}

function getGitTags(): string[] {
  try {
    const tags = execSync('git tag', {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
      .trim()
      .split('\n')
      .filter((tag) => tag.startsWith('v') && tag.length > 1);

    // Sort semver-style: v0.1.0, v0.2.0, v1.0.0
    return tags.sort((a, b) => {
      const aVer = a.substring(1).split('.').map(Number);
      const bVer = b.substring(1).split('.').map(Number);
      for (let i = 0; i < Math.max(aVer.length, bVer.length); i++) {
        const aDiff = (aVer[i] || 0) - (bVer[i] || 0);
        if (aDiff !== 0) return aDiff;
      }
      return 0;
    });
  } catch {
    return [];
  }
}

function parseConventionalCommit(message: string): { category: string; title: string } {
  const match = message.match(CONVENTIONAL_PREFIX_REGEX);
  if (!match) {
    return { category: 'Other', title: message };
  }

  const prefix = match[1].toLowerCase();
  const title = match[2];
  const category = CATEGORY_MAP[prefix] || 'Other';

  return { category, title };
}

function getCommitsBetween(from: string | null, to: string): CommitInfo[] {
  let logRange = to;
  if (from) {
    logRange = `${from}..${to}`;
  }

  try {
    const log = execSync(`git log ${logRange} --pretty=format:%H%n%s`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!log) return [];

    const lines = log.split('\n');
    const commits: CommitInfo[] = [];

    for (let i = 0; i < lines.length; i += 2) {
      const hash = lines[i];
      const message = lines[i + 1];

      if (hash && message) {
        const { category, title } = parseConventionalCommit(message);
        if (category !== 'ignored') {
          commits.push({ hash, message: title, category });
        }
      }
    }

    return commits;
  } catch {
    return [];
  }
}

function getTagDate(tag: string): string {
  try {
    const timestamp = execSync(`git log -1 --format=%ai ${tag}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
      .trim()
      .split(' ')[0];

    return timestamp;
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function buildCompareUrl(
  owner: string,
  repo: string,
  fromTag: string | null,
  toTag: string
): string {
  const base = `https://github.com/${owner}/${repo}`;

  if (!fromTag) {
    return `${base}/releases/tag/${toTag}`;
  }

  return `${base}/compare/${fromTag}...${toTag}`;
}

function groupCommitsByCategory(commits: CommitInfo[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const commit of commits) {
    if (!grouped.has(commit.category)) {
      grouped.set(commit.category, []);
    }
    grouped.get(commit.category)!.push(commit.message);
  }

  // Ensure standard sections appear in order
  const ordered = new Map<string, string[]>();
  const sectionOrder = ['Added', 'Changed', 'Fixed', 'Removed', 'Other'];

  for (const section of sectionOrder) {
    if (grouped.has(section)) {
      ordered.set(section, grouped.get(section)!);
    }
  }

  // Add any remaining custom sections
  for (const [section, items] of grouped) {
    if (!ordered.has(section)) {
      ordered.set(section, items);
    }
  }

  return ordered;
}

function formatVersionSection(
  version: string,
  date: string,
  url: string,
  commits: Map<string, string[]>
): string {
  let section = `## [${version}] - ${date}\n\n`;
  if (url && version !== '[Unreleased]') {
    // Keep the Compare URL in Markdown but don't render it as a clickable link inline
    section = `## [${version}] - ${date}\n\n`;
  }

  for (const [category, messages] of commits) {
    if (messages.length === 0) continue;

    section += `### ${category}\n\n`;
    for (const message of messages) {
      section += `- ${message}\n`;
    }
    section += '\n';
  }

  return section;
}

function main() {
  const repoInfo = getRepoInfo();
  const tags = getGitTags();

  let changelog = '# Changelog\n\n';
  changelog +=
    'All notable changes to this project will be documented in this file.\n\n';
  changelog +=
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\n';
  changelog += 'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n';

  if (tags.length === 0) {
    // Empty state: all commits as "Unreleased / Initial Release"
    const allCommits = getCommitsBetween(null, 'HEAD');
    const grouped = groupCommitsByCategory(allCommits);

    changelog += '## [Unreleased]\n\n';
    if (allCommits.length > 0) {
      changelog += '### Initial Release\n\n';
      for (const [category, messages] of grouped) {
        if (messages.length === 0) continue;
        changelog += `### ${category}\n\n`;
        for (const message of messages) {
          changelog += `- ${message}\n`;
        }
        changelog += '\n';
      }
    } else {
      changelog += 'No commits yet.\n\n';
    }
  } else {
    // Process each tag
    const versions: VersionEntry[] = [];

    for (let i = tags.length - 1; i >= 0; i--) {
      const currentTag = tags[i];
      const previousTag = i > 0 ? tags[i - 1] : null;
      const date = getTagDate(currentTag);

      const commits = getCommitsBetween(previousTag, currentTag);
      const grouped = groupCommitsByCategory(commits);

      const compareUrl = buildCompareUrl(
        repoInfo.owner,
        repoInfo.repo,
        previousTag,
        currentTag
      );

      versions.push({
        version: currentTag,
        date,
        compareUrl,
        commits: grouped,
      });
    }

    // Check for unreleased commits
    const latestTag = tags[tags.length - 1];
    const unreleasedCommits = getCommitsBetween(latestTag, 'HEAD');

    if (unreleasedCommits.length > 0) {
      const grouped = groupCommitsByCategory(unreleasedCommits);
      changelog += '## [Unreleased]\n\n';
      for (const [category, messages] of grouped) {
        if (messages.length === 0) continue;
        changelog += `### ${category}\n\n`;
        for (const message of messages) {
          changelog += `- ${message}\n`;
        }
        changelog += '\n';
      }
    }

    // Add released versions
    for (const version of versions) {
      changelog += formatVersionSection(version.version, version.date, version.compareUrl, version.commits);
    }
  }

  // Add footer with compare link references for markdown
  if (tags.length > 0) {
    changelog += '\n';
    for (let i = tags.length - 1; i >= 0; i--) {
      const currentTag = tags[i];
      const previousTag = i > 0 ? tags[i - 1] : null;
      const compareUrl = buildCompareUrl(
        repoInfo.owner,
        repoInfo.repo,
        previousTag,
        currentTag
      );
      changelog += `[${currentTag}]: ${compareUrl}\n`;
    }
  }

  const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, changelog, 'utf-8');

  console.log(`✓ CHANGELOG.md generated at ${changelogPath}`);
  console.log(`  Processed ${tags.length} tag(s)`);
}

main();
