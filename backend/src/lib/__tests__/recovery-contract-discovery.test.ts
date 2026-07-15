import { swaggerSpec } from '../swagger';
import { buildMcpToolTierResolver, getMcpToolDefinitions, MCP_FRIENDLY_ALIASES } from '../mcp-http';

test('recovery contracts are discoverable through OpenAPI and MCP', () => {
  const spec = swaggerSpec as any;
  expect(spec.paths['/api/pipeline/telemetry']?.get).toMatchObject({
    'x-rorca-tier': 'public',
    'x-rorca-public-api': true,
  });
  expect(spec.paths['/api/repair/checkpoints/reconcile']?.post).toMatchObject({
    'x-rorca-tier': 'auth',
  });

  const definitions = getMcpToolDefinitions(spec);
  expect(definitions.map((definition) => definition.toolName)).toEqual(expect.arrayContaining([
    'rorca_pipeline_telemetry',
    'rorca_repair_checkpoints_reconcile',
  ]));
  expect(MCP_FRIENDLY_ALIASES).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolName: 'rorca_reconcile_checkpoint' }),
  ]));
  expect(buildMcpToolTierResolver(spec)('rorca_repair_checkpoints_reconcile')).toBe('public');
});
