export const CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION = "2026-07-ucc-007.v1";
export const CONTEXT_EVENT_TYPES = ["agent_cli_session", "ide_session", "shell_command", "editor_activity", "explicit_memory", "git_commit", "ci_pr"];
export const TRUST_TIERS = ["untrusted", "local", "verified", "privileged"];
export const CONTEXT_EVENT_IDEMPOTENCY_GUIDANCE = {
    agent_cli_session: "sha256:event_type + source_system + tool_name + session_id + workspace_id + occurred_at_minute + command_hash",
    ide_session: "sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at_hour",
    shell_command: "sha256:event_type + source_system + session_id + workspace_id + occurred_at + phase + command_hash + exit_code",
    editor_activity: "sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at + activity_type + related_file_paths",
    explicit_memory: "sha256:event_type + source_system + tool_name + session_id + workspace_id + memory_hash + occurred_at",
    git_commit: "sha256:event_type + source_system + workspace_id + git_sha",
    ci_pr: "sha256:event_type + source_system + workspace_id + provider + repository + pr_number + head_sha + run_id",
};
