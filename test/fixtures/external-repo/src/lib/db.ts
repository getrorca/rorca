export interface QueryResult<T> { rows: T[] }
export async function query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  void sql;
  void params;
  return { rows: [] };
}
