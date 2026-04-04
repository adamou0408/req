import apiClient from './client';

export interface Combo {
  id: string;
  controller_model: string;
  flash_model: string;
  target_ratio: number;
  status: 'draft' | 'pending_approval' | 'active' | 'archived';
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ComboCreate {
  controller_model: string;
  flash_model: string;
  target_ratio: number;
}

export interface ComboHistory {
  id: string;
  combo_id: string;
  action: string;
  actor: string;
  timestamp: string;
  details?: string;
}

export const listCombos = async (): Promise<Combo[]> => {
  const { data } = await apiClient.get('/api/combos');
  return data;
};

export const getActiveCombos = async (): Promise<Combo[]> => {
  const { data } = await apiClient.get('/api/combos/active');
  return data;
};

export const createCombo = async (payload: ComboCreate): Promise<Combo> => {
  const { data } = await apiClient.post('/api/combos', payload);
  return data;
};

export const submitForApproval = async (id: string): Promise<Combo> => {
  const { data } = await apiClient.post(`/api/combos/${id}/submit`);
  return data;
};

export const approveCombo = async (id: string): Promise<Combo> => {
  const { data } = await apiClient.post(`/api/combos/${id}/approve`);
  return data;
};

export const rejectCombo = async (id: string): Promise<Combo> => {
  const { data } = await apiClient.post(`/api/combos/${id}/reject`);
  return data;
};

export const publishCombo = async (id: string): Promise<Combo> => {
  const { data } = await apiClient.post(`/api/combos/${id}/publish`);
  return data;
};

export const archiveCombo = async (id: string): Promise<Combo> => {
  const { data } = await apiClient.post(`/api/combos/${id}/archive`);
  return data;
};

export const getComboHistory = async (): Promise<ComboHistory[]> => {
  const { data } = await apiClient.get('/api/combos/history');
  return data;
};
