import apiClient from './client';
import { TableInfo, ColumnInfo, FunctionInfo } from './types';

export async function listTables(dsId: string): Promise<TableInfo[]> {
  const response = await apiClient.get<TableInfo[]>(`/api/schema/${dsId}/tables`);
  return response.data;
}

export async function listColumns(dsId: string, table: string): Promise<ColumnInfo[]> {
  const response = await apiClient.get<ColumnInfo[]>(
    `/api/schema/${dsId}/tables/${table}/columns`
  );
  return response.data;
}

export async function previewData(
  dsId: string,
  table: string,
  limit: number = 25
): Promise<Record<string, unknown>[]> {
  const response = await apiClient.get<Record<string, unknown>[]>(
    `/api/schema/${dsId}/tables/${table}/preview`,
    { params: { limit } }
  );
  return response.data;
}

export async function listFunctions(dsId: string): Promise<FunctionInfo[]> {
  const response = await apiClient.get<FunctionInfo[]>(`/api/schema/${dsId}/functions`);
  return response.data;
}

export async function searchSchema(
  dsId: string,
  query: string
): Promise<{ tables: TableInfo[]; columns: ColumnInfo[] }> {
  const response = await apiClient.get(`/api/schema/${dsId}/search`, {
    params: { q: query },
  });
  return response.data;
}
