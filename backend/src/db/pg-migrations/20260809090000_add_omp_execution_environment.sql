-- MIG-002: OMP may become the qualified default only after MIG-001's sandbox
-- qualification marker is enabled. Existing remote workers must advertise the
-- already-supported OMP lane or qualified dispatch would fail readiness after
-- option resolution.
UPDATE execution_environments
SET supported_agents = array_append(supported_agents, 'omp'),
    updated_at = NOW()
WHERE id = 'remote-rorca'
  AND NOT ('omp' = ANY(supported_agents));
