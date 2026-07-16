import { swaggerSpec } from '../swagger';
import { getMcpToolDefinitions } from '../mcp-http';

test('recovery contracts are discoverable with correct REST/MCP authority', () => {
  const spec = swaggerSpec as any;
  expect(spec.paths['/api/pipeline/telemetry']?.get).toMatchObject({
    'x-rorca-tier': 'public', 'x-rorca-public-api': true,
  });
  expect(spec.paths['/api/pipeline/telemetry']?.get.responses['200'].content['application/json'].schema.required)
    .toEqual(expect.arrayContaining(['contractVersion', 'observedAt', 'runs']));
  expect(spec.paths['/api/admin/recovery/checkpoints/reconcile']?.post).toMatchObject({
    'x-rorca-tier': 'admin', 'x-rorca-mcp': false,
  });

  const toolNames = getMcpToolDefinitions(spec).map((definition) => definition.toolName);
  expect(toolNames).toContain('rorca_pipeline_telemetry');
  expect(toolNames).not.toContain('rorca_admin_recovery_checkpoints_reconcile');
  expect(toolNames).not.toContain('rorca_repair_checkpoints_reconcile');
});
