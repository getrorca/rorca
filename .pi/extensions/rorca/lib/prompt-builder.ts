import { existsSync, readFileSync } from "fs";
import { join } from "path";

type Story = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
};

export async function buildStoryPrompt(params: {
  story: Story;
  specSlug: string;
  workspacePath: string;
}): Promise<string> {
  const { story, specSlug, workspacePath } = params;

  const sections: string[] = [];

  const contextFiles = [
    join(workspacePath, "CLAUDE.md"),
    join(workspacePath, "AGENTS.md"),
    join(workspacePath, "MEMORY.md"),
  ];

  for (const filePath of contextFiles) {
    if (!existsSync(filePath)) continue;
    sections.push(readFileSync(filePath, "utf8").trim());
  }

  sections.push(
    [
      "# === RORCA SPEC CONTEXT ===",
      "",
      `Spec ID: ${specSlug}`,
      `Current Story: ${story.id} - ${story.title}`,
      story.dependsOn.length > 0
        ? `Depends On:\n${story.dependsOn.map((dependency) => `- ${dependency}`).join("\n")}`
        : "Depends On:\n- none",
      "",
      `Your task (${story.id}):`,
      story.description,
      story.acceptanceCriteria.length > 0
        ? `\nAcceptance Criteria:\n${story.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
        : "",
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}
