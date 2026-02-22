import * as fs from 'fs';
import * as path from 'path';

export interface DiagramOutput {
  mermaid: string;
  ascii: string;
}

export interface GeneratedStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

export interface GeneratedSpec {
  title: string;
  slug: string;
  stories: GeneratedStory[];
  diagrams: Record<string, DiagramOutput>;
}

export interface WriteResult {
  specPath: string;
  diagramsPath: string;
}

export function writeSpec(workspacePath: string, spec: GeneratedSpec): WriteResult {
  const pendingDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', 'pending');
  const specPath = path.join(pendingDir, `${spec.slug}.json`);
  const diagramsPath = path.join(pendingDir, `${spec.slug}-diagrams.md`);

  if (fs.existsSync(specPath)) {
    throw new Error(`Spec '${spec.slug}' already exists at ${specPath}. Delete it first or use a different title.`);
  }

  fs.mkdirSync(pendingDir, { recursive: true });

  // Write spec in run-loop.sh compatible format
  const specJson = {
    title: spec.title,
    userStories: spec.stories.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      dependsOn: s.dependsOn,
      passes: false
    }))
  };
  fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2), 'utf8');

  // Write diagrams as markdown
  const diagramSections = Object.entries(spec.diagrams).map(([type, output]) =>
    `## ${type}\n\n### Mermaid\n\`\`\`mermaid\n${output.mermaid}\n\`\`\`\n\n### ASCII\n\`\`\`\n${output.ascii}\n\`\`\``
  ).join('\n\n');
  const diagramsMd = `# ${spec.title} — Diagrams\n\nGenerated: ${new Date().toISOString()}\n\n${diagramSections}\n`;
  fs.writeFileSync(diagramsPath, diagramsMd, 'utf8');

  return { specPath, diagramsPath };
}
