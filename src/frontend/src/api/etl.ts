import apiClient from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EtlPipeline {
  id: string;
  name: string;
  description?: string;
  source_datasource_id: string;
  source_table: string;
  target_table: string;
  transform_config?: Record<string, any>;
  cron_expression?: string;
  is_active: boolean;
  last_run_at?: string;
  last_run_status?: string;
  last_run_duration_ms?: number;
  last_run_rows?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BiReport {
  id: string;
  name: string;
  description?: string;
  source_table: string;
  chart_type: string;
  config?: Record<string, any>;
  created_by: string;
  is_shared: boolean;
  share_approved: boolean;
  share_approved_by?: string;
  created_at: string;
  updated_at: string;
}

export interface BiDashboard {
  id: string;
  name: string;
  description?: string;
  layout?: Array<{ report_id: string; x: number; y: number; w: number; h: number }>;
  refresh_interval_seconds?: number;
  is_shared: boolean;
  share_approved: boolean;
  share_approved_by?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ReportExecuteResult {
  columns?: string[];
  data?: Record<string, any>[];
  row_count?: number;
  sql_preview?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Pipeline API
// ---------------------------------------------------------------------------

export const listPipelines = () =>
  apiClient.get<EtlPipeline[]>('/api/etl/pipelines').then((r) => r.data);

export const createPipeline = (data: {
  name: string;
  source_datasource_id: string;
  source_table: string;
  target_table: string;
  transform_config?: Record<string, any>;
  cron_expression?: string;
}) => apiClient.post<EtlPipeline>('/api/etl/pipelines', data).then((r) => r.data);

export const getPipeline = (id: string) =>
  apiClient.get<EtlPipeline>(`/api/etl/pipelines/${id}`).then((r) => r.data);

export const updatePipeline = (id: string, data: Partial<EtlPipeline>) =>
  apiClient.put<EtlPipeline>(`/api/etl/pipelines/${id}`, data).then((r) => r.data);

export const deletePipeline = (id: string) =>
  apiClient.delete(`/api/etl/pipelines/${id}`).then((r) => r.data);

export const runPipeline = (id: string) =>
  apiClient.post(`/api/etl/pipelines/${id}/run`).then((r) => r.data);

export const getPipelineHistory = (id: string) =>
  apiClient.get(`/api/etl/pipelines/${id}/history`).then((r) => r.data);

// ---------------------------------------------------------------------------
// Report API
// ---------------------------------------------------------------------------

export const listReports = () =>
  apiClient.get<BiReport[]>('/api/etl/reports').then((r) => r.data);

export const createReport = (data: {
  name: string;
  source_table: string;
  chart_type: string;
  config?: Record<string, any>;
}) => apiClient.post<BiReport>('/api/etl/reports', data).then((r) => r.data);

export const getReport = (id: string) =>
  apiClient.get<BiReport>(`/api/etl/reports/${id}`).then((r) => r.data);

export const updateReport = (id: string, data: Partial<BiReport>) =>
  apiClient.put<BiReport>(`/api/etl/reports/${id}`, data).then((r) => r.data);

export const deleteReport = (id: string) =>
  apiClient.delete(`/api/etl/reports/${id}`).then((r) => r.data);

export const executeReport = (id: string) =>
  apiClient.post<ReportExecuteResult>(`/api/etl/reports/${id}/execute`).then((r) => r.data);

export const shareReport = (id: string) =>
  apiClient.post(`/api/etl/reports/${id}/share`).then((r) => r.data);

export const approveReportShare = (id: string) =>
  apiClient.post(`/api/etl/reports/${id}/approve-share`).then((r) => r.data);

export const getAvailableTables = () =>
  apiClient.get<string[]>('/api/etl/reports/tables').then((r) => r.data);

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------

export const listDashboards = () =>
  apiClient.get<BiDashboard[]>('/api/etl/dashboards').then((r) => r.data);

export const createDashboard = (data: {
  name: string;
  description?: string;
  layout?: any[];
  refresh_interval_seconds?: number;
}) => apiClient.post<BiDashboard>('/api/etl/dashboards', data).then((r) => r.data);

export const getDashboard = (id: string) =>
  apiClient.get(`/api/etl/dashboards/${id}`).then((r) => r.data);

export const updateDashboard = (id: string, data: Partial<BiDashboard>) =>
  apiClient.put<BiDashboard>(`/api/etl/dashboards/${id}`, data).then((r) => r.data);

export const deleteDashboard = (id: string) =>
  apiClient.delete(`/api/etl/dashboards/${id}`).then((r) => r.data);

export const shareDashboard = (id: string) =>
  apiClient.post(`/api/etl/dashboards/${id}/share`).then((r) => r.data);

export const approveDashboardShare = (id: string) =>
  apiClient.post(`/api/etl/dashboards/${id}/approve-share`).then((r) => r.data);

export const exportDashboardPdf = (id: string) =>
  apiClient.get(`/api/etl/dashboards/${id}/export/pdf`, { responseType: 'blob' }).then((r) => r.data);

export const scheduleDashboardEmail = (id: string, data: { cron: string; recipients: string[] }) =>
  apiClient.post(`/api/etl/dashboards/${id}/schedule-email`, data).then((r) => r.data);
