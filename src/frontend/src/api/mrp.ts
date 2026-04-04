import apiClient from './client';

export interface MrpRunParams {
  planning_horizon?: number;
  include_safety_stock?: boolean;
}

export interface MrpResult {
  run_id: string;
  status: string;
  shortages: Shortage[];
  summary: {
    total_parts: number;
    shortage_count: number;
    run_date: string;
  };
}

export interface Shortage {
  part_number: string;
  part_name: string;
  required_qty: number;
  available_qty: number;
  net_requirement: number;
  severity: 'critical' | 'warning' | 'info';
  due_date: string;
}

export interface BomNode {
  part_number: string;
  part_name: string;
  quantity: number;
  level: number;
  children?: BomNode[];
}

export interface MpsEntry {
  id: string;
  product_model: string;
  period: string;
  planned_qty: number;
  confirmed_qty: number;
  combo: string;
  status: 'planned' | 'confirmed' | 'in_progress' | 'completed';
}

export interface MpsParams {
  product_model?: string;
  period?: string;
  status?: string;
}

export interface Bottleneck {
  work_center: string;
  utilization: number;
  capacity: number;
  load: number;
  status: 'normal' | 'warning' | 'overloaded';
}

export const runMrp = async (params?: MrpRunParams): Promise<MrpResult> => {
  const { data } = await apiClient.post('/api/mrp/run', params);
  return data;
};

export const getMrpResults = async (runId: string): Promise<MrpResult> => {
  const { data } = await apiClient.get(`/api/mrp/results/${runId}`);
  return data;
};

export const getShortages = async (): Promise<Shortage[]> => {
  const { data } = await apiClient.get('/api/mrp/shortages');
  return data;
};

export const getBom = async (model: string): Promise<BomNode> => {
  const { data } = await apiClient.get(`/api/mrp/bom/${encodeURIComponent(model)}`);
  return data;
};

export const expandBom = async (model: string): Promise<BomNode[]> => {
  const { data } = await apiClient.get(`/api/mrp/bom/${encodeURIComponent(model)}/expand`);
  return data;
};

export const generateMps = async (): Promise<{ message: string }> => {
  const { data } = await apiClient.post('/api/mrp/mps/generate');
  return data;
};

export const getMps = async (params?: MpsParams): Promise<MpsEntry[]> => {
  const { data } = await apiClient.get('/api/mrp/mps', { params });
  return data;
};

export const runCrp = async (): Promise<{ bottlenecks: Bottleneck[] }> => {
  const { data } = await apiClient.post('/api/mrp/crp/run');
  return data;
};

export const getBottlenecks = async (): Promise<Bottleneck[]> => {
  const { data } = await apiClient.get('/api/mrp/crp/bottlenecks');
  return data;
};
