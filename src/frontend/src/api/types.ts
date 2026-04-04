export interface User {
  id: string;
  ad_username: string;
  display_name: string;
  department: string;
  role: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export interface DataSource {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  is_active: boolean;
  created_at: string;
}

export interface DataSourceCreate {
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password: string;
}

export interface DataSourceUpdate {
  name?: string;
  db_type?: string;
  host?: string;
  port?: number;
  database_name?: string;
  username?: string;
  password?: string;
  is_active?: boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  row_count_estimate: number;
  comment: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
  is_fk: boolean;
  comment: string;
}

export interface FunctionInfo {
  name: string;
  schema: string;
  parameters: string;
  return_type: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  server_version: string;
}

export interface SupportedType {
  value: string;
  label: string;
  default_port: number;
}
