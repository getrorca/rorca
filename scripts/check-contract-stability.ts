import path from 'path';
import {
  buildSnapshotFromOpenApi,
  compareSnapshots,
  determineBumpType,
  fetchOpenApiFromServer,
  formatDiff,
  getReferenceDate,
  isMajorVersionBump,
  isMinorOrGreaterBump,
  loadPackageVersionFromGit,
  loadSnapshotFromGit,
  loadTextFromGit,
  parseBreakMarkers,
  readSnapshot,
  readTextFile,
  resolveMarkersForChanges,
  snapshotRoutesEqual,
} from '../packages/rorca-public-contract/src/index';

const cwd = process.cwd();
const snapshotFile = 'docs/openapi-public-snapshot.json';
const breakingChangesFile = 'docs/contract-breaking-changes.md';
const snapshotPath = path.join(cwd, snapshotFile);
const breakMarkdownPath = path.join(cwd, breakingChangesFile);
const baseUrl = process.env.RORCA_CONTRACT_BASE_URL || 'http://127.0.0.1:3030';
const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null;

async function main(): Promise<void> {
  const committedSnapshot = await readSnapshot(snapshotPath);
  if (!committedSnapshot) {
    throw new Error(`Missing committed baseline at ${snapshotFile}. Run npm run build:contract and commit the result.`);
  }

  const openApi = await fetchOpenApiFromServer(baseUrl);
  const freshSnapshot = buildSnapshotFromOpenApi(openApi, committedSnapshot.contractVersion);

  if (!snapshotRoutesEqual(committedSnapshot, freshSnapshot)) {
    const drift = compareSnapshots(committedSnapshot, freshSnapshot, openApi);
    throw new Error(
      [
        'Committed public API snapshot is stale.',
        'Run `npm run build:contract` and commit the updated docs artifacts.',
        formatDiff(drift),
      ].join('\n'),
    );
  }

  const currentBreakMarkdown = await readTextFile(breakMarkdownPath);
  const currentMarkers = parseBreakMarkers(currentBreakMarkdown);
  const referenceDate = getReferenceDate();

  const baseSnapshot = baseRef
    ? loadSnapshotFromGit(baseRef, snapshotFile, cwd)
    : null;
  const effectiveBaseSnapshot = baseSnapshot ?? committedSnapshot;

  const changes = compareSnapshots(effectiveBaseSnapshot, committedSnapshot, openApi);
  const bumpType = determineBumpType(changes);
  const baseVersion = effectiveBaseSnapshot.contractVersion;
  const headVersion = committedSnapshot.contractVersion;

  if (baseSnapshot) {
    if (bumpType === 'none' && headVersion !== baseVersion) {
      throw new Error(`Contract version changed without contract change: ${baseVersion} -> ${headVersion}`);
    }
    if (bumpType === 'minor' && !isMinorOrGreaterBump(baseVersion, headVersion)) {
      throw new Error(`Added public API routes require a contract minor bump: ${baseVersion} -> ${headVersion} was not sufficient.`);
    }
    if (bumpType === 'major' && !isMajorVersionBump(baseVersion, headVersion)) {
      throw new Error(`Breaking public API changes require a contract major bump: ${baseVersion} -> ${headVersion} was not sufficient.`);
    }
  } else if (headVersion !== '1.0.0') {
    throw new Error(`Bootstrap baseline must start at contractVersion 1.0.0, found ${headVersion}.`);
  }

  const markerResolution = resolveMarkersForChanges(changes, currentMarkers, referenceDate);
  if (markerResolution.expired.length > 0) {
    throw new Error([
      'Breaking-change override markers exist but are older than 30 days relative to the PR date.',
      ...markerResolution.expired.map(item => `Expired marker: ${item}`),
    ].join('\n'));
  }

  if (markerResolution.uncovered.length > 0) {
    throw new Error([
      'Breaking public API changes require a fresh marker in docs/contract-breaking-changes.md.',
      ...markerResolution.uncovered.map(item => `Missing marker: ${item}`),
      formatDiff(changes),
    ].join('\n'));
  }

  const baseBreakMarkdown = baseRef
    ? loadTextFromGit(baseRef, breakingChangesFile, cwd)
    : null;
  const baseMarkers = parseBreakMarkers(baseBreakMarkdown ?? '');
  const newMarkerLines = new Set(currentMarkers.map(marker => marker.line));
  for (const marker of baseMarkers) {
    newMarkerLines.delete(marker.line);
  }

  if (newMarkerLines.size > 0) {
    const headPackageVersion = JSON.parse(await readTextFile(path.join(cwd, 'package.json'))) as { version: string };
    const basePackageVersion = baseRef
      ? loadPackageVersionFromGit(baseRef, cwd)
      : null;

    if (!basePackageVersion) {
      throw new Error('New contract-breaking markers were added but the base package.json version could not be read.');
    }

    if (!isMajorVersionBump(basePackageVersion, headPackageVersion.version)) {
      throw new Error(
        `New entries in ${breakingChangesFile} require a package major version bump: ${basePackageVersion} -> ${headPackageVersion.version} was not sufficient.`,
      );
    }
  }

  console.log(formatDiff(changes));
  if (markerResolution.covered.length > 0) {
    console.log(`Override markers acknowledged: ${markerResolution.covered.join(', ')}`);
  }
  console.log(`Contract check passed against ${baseSnapshot ? baseRef : 'bootstrap baseline'}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
