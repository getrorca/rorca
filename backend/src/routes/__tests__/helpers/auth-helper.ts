export function buildTestAuthHeaders(user: { id: string; email: string }) {
  return {
    'x-test-user-id': user.id,
    'x-test-user-email': user.email,
  };
}
