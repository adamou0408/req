import apiClient from './client';
import { LoginResponse, User } from './types';

export async function login(username: string, password: string): Promise<LoginResponse> {
  const formData = new URLSearchParams();
  formData.append('username', username);
  formData.append('password', password);

  const response = await apiClient.post<LoginResponse>('/api/auth/login', formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data;
}

export async function getMe(): Promise<User> {
  const response = await apiClient.get<User>('/api/auth/me');
  return response.data;
}

export async function logout(): Promise<void> {
  await apiClient.post('/api/auth/logout');
}
