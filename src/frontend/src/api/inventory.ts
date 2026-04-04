import apiClient from './client';

export interface InventorySearchParams {
  query?: string;
  warehouse?: string;
  status?: string;
}

export interface InventoryItem {
  id: string;
  product_model: string;
  part_number: string;
  warehouse: string;
  quantity: number;
  in_transit: number;
  status: 'sufficient' | 'low' | 'critical';
  last_updated: string;
}

export interface ProductSchedule {
  model: string;
  schedules: Array<{
    period: string;
    planned_qty: number;
    confirmed_qty: number;
    status: string;
  }>;
}

export interface InventorySummary {
  total_items: number;
  sufficient_count: number;
  low_count: number;
  critical_count: number;
  warehouses: string[];
}

export const searchInventory = async (params: InventorySearchParams): Promise<InventoryItem[]> => {
  const { data } = await apiClient.get('/api/inventory/search', { params });
  return data;
};

export const getProductSchedule = async (model: string): Promise<ProductSchedule> => {
  const { data } = await apiClient.get(`/api/inventory/product/${encodeURIComponent(model)}/schedule`);
  return data;
};

export const getInventorySummary = async (): Promise<InventorySummary> => {
  const { data } = await apiClient.get('/api/inventory/summary');
  return data;
};
