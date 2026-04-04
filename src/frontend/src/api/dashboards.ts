import apiClient from './client';

export interface PmOverviewProject {
  id: string;
  product_model: string;
  combo: string;
  design_status: string;
  test_status: string;
  production_status: string;
  health: 'green' | 'yellow' | 'red';
}

export interface PmKpis {
  active_projects: number;
  on_track_pct: number;
  at_risk_pct: number;
  bottleneck_count: number;
}

export interface PmAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  project: string;
  timestamp: string;
}

export interface YieldSummary {
  average_yield: number;
  min_yield: number;
  max_yield: number;
  total_batches: number;
  by_test_type?: Array<{ type: string; count: number; yield: number }>;
}

export interface YieldTrendPoint {
  date: string;
  yield_pct: number;
  batch_count: number;
}

export interface QualityAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  model: string;
  timestamp: string;
}

export interface SyncOverview {
  total_configs: number;
  active: number;
  healthy: number;
  lagging: number;
  failed: number;
}

export interface SyncDetail {
  id: string;
  data_source: string;
  table_name: string;
  mode: 'CDC' | 'Batch';
  last_sync: string;
  lag_seconds: number;
  health: 'healthy' | 'lagging' | 'failed';
}

export const getPmOverview = async (): Promise<PmOverviewProject[]> => {
  const { data } = await apiClient.get('/api/dashboards/pm/overview');
  return data;
};

export const getPmKpis = async (): Promise<PmKpis> => {
  const { data } = await apiClient.get('/api/dashboards/pm/kpis');
  return data;
};

export const getPmAlerts = async (): Promise<PmAlert[]> => {
  const { data } = await apiClient.get('/api/dashboards/pm/alerts');
  return data;
};

export const getYieldSummary = async (params?: {
  model?: string;
  start_date?: string;
  end_date?: string;
}): Promise<YieldSummary> => {
  const { data } = await apiClient.get('/api/dashboards/quality/yield-summary', { params });
  return data;
};

export const getYieldTrend = async (
  model: string,
  period?: string
): Promise<YieldTrendPoint[]> => {
  const { data } = await apiClient.get(
    `/api/dashboards/quality/yield-trend/${encodeURIComponent(model)}`,
    { params: period ? { period } : undefined }
  );
  return data;
};

export const getQualityAlerts = async (): Promise<QualityAlert[]> => {
  const { data } = await apiClient.get('/api/dashboards/quality/alerts');
  return data;
};

export const getSyncOverview = async (): Promise<SyncOverview> => {
  const { data } = await apiClient.get('/api/dashboards/sync/overview');
  return data;
};

export const getSyncDetailed = async (): Promise<SyncDetail[]> => {
  const { data } = await apiClient.get('/api/dashboards/sync/detailed');
  return data;
};
