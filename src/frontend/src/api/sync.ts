import apiClient from './client';

export interface SyncConfig {
  id: string;
  data_source_id: string;
  data_source_name: string;
  table_name: string;
  sync_mode: 'cdc' | 'batch';
  cron_expression: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncConfigCreate {
  data_source_id: string;
  table_name: string;
  sync_mode: 'cdc' | 'batch';
  cron_expression: string | null;
  is_active: boolean;
}

export interface SyncConfigUpdate {
  data_source_id?: string;
  table_name?: string;
  sync_mode?: 'cdc' | 'batch';
  cron_expression?: string | null;
  is_active?: boolean;
}

export interface SyncStatus {
  config_id: string;
  data_source_name: string;
  table_name: string;
  sync_mode: 'cdc' | 'batch';
  cron_expression: string | null;
  is_active: boolean;
  last_sync_at: string | null;
  lag_seconds: number | null;
  health: 'healthy' | 'lagging' | 'failed' | 'inactive';
  error_message: string | null;
  error_at: string | null;
}

export async function listSyncConfigs(): Promise<SyncConfig[]> {
  const { data } = await apiClient.get<SyncConfig[]>('/api/sync/configs');
  return data;
}

export async function createSyncConfig(payload: SyncConfigCreate): Promise<SyncConfig> {
  const { data } = await apiClient.post<SyncConfig>('/api/sync/configs', payload);
  return data;
}

export async function updateSyncConfig(id: string, payload: SyncConfigUpdate): Promise<SyncConfig> {
  const { data } = await apiClient.put<SyncConfig>(`/api/sync/configs/${id}`, payload);
  return data;
}

export async function deleteSyncConfig(id: string): Promise<void> {
  await apiClient.delete(`/api/sync/configs/${id}`);
}

export async function triggerSync(id: string): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>(`/api/sync/configs/${id}/trigger`);
  return data;
}

export async function getSyncStatus(): Promise<SyncStatus[]> {
  const { data } = await apiClient.get<SyncStatus[]>('/api/sync/status');
  return data;
}
