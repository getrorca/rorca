import path from 'path';
import {
  buildSnapshotFromOpenApi,
  bumpVersion,
  compareSnapshots,
  determineBumpType,
  fetchOpenApiFromServer,
  readSnapshot,
  writeContractMarkdown,
  writeSnapshot,
} from '../packages/rorca-public-contract/src/index';

const cwd = process.cwd();
const docsDir = path.join(cwd, 'docs');
const snapshotPath = path.join(docsDir, 'openapi-public-snapshot.json');
const markdownPath = path.join(docsDir, 'OPEN_API_CONTRACT.md');
const baseUrl = process.env.RORCA_CONTRACT_BASE_URL || 'http://127.0.0.1:3030';

async function main(): Promise<void> {
  const existingSnapshot = await readSnapshot(snapshotPath);
  const openApi = await fetchOpenApiFromServer(baseUrl);

  const provisionalVersion = existingSnapshot?.contractVersion ?? '1.0.0';
  const provisionalSnapshot = buildSnapshotFromOpenApi(openApi, provisionalVersion);

  let nextVersion = provisionalVersion;
  if (existingSnapshot) {
    const changes = compareSnapshots(existingSnapshot, provisionalSnapshot, openApi);
    nextVersion = bumpVersion(existingSnapshot.contractVersion, determineBumpType(changes));
  }

  const finalSnapshot = buildSnapshotFromOpenApi(openApi, nextVersion);
  await writeSnapshot(snapshotPath, finalSnapshot);
  await writeContractMarkdown(markdownPath, finalSnapshot);

  console.log(`Wrote ${path.relative(cwd, snapshotPath)} and ${path.relative(cwd, markdownPath)} (${finalSnapshot.routes.length} public routes, contract ${finalSnapshot.contractVersion})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
