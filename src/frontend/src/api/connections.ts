import apiClient from './client';
import {
  DataSource,
  DataSourceCreate,
  DataSourceUpdate,
  ConnectionTestResult,
  SupportedType,
} from './types';

export async function listConnections(): Promise<DataSource[]> {
  const response = await apiClient.get<DataSource[]>('/api/connections');
  return response.data;
}

export async function createConnection(data: DataSourceCreate): Promise<DataSource> {
  const response = await apiClient.post<DataSource>('/api/connections', data);
  return response.data;
}

export async function updateConnection(id: string, data: DataSourceUpdate): Promise<DataSource> {
  const response = await apiClient.put<DataSource>(`/api/connections/${id}`, data);
  return response.data;
}

export async function deleteConnection(id: string): Promise<void> {
  await apiClient.delete(`/api/connections/${id}`);
}

export async function testConnection(id: string): Promise<ConnectionTestResult> {
  const response = await apiClient.post<ConnectionTestResult>(`/api/connections/${id}/test`);
  return response.data;
}

export async function getSupportedTypes(): Promise<SupportedType[]> {
  const response = await apiClient.get<SupportedType[]>('/api/connections/supported-types');
  return response.data;
}
