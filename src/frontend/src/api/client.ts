import axios, { AxiosInstance } from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
const DEMO_MODE = !process.env.REACT_APP_API_URL && !window.location.hostname.includes('localhost');

// ── Mock Data for Demo Mode ──────────────────────────

const MOCK_USER = {
  id: 'demo-001',
  ad_username: 'demo_user',
  display_name: 'Demo User',
  department: 'Big Data',
  role: 'big_data',
};

const MOCK_CONNECTIONS = [
  { id: 'ds-001', name: 'Tiptop ERP (Oracle)', db_type: 'oracle', host: '10.0.1.100', port: 1521, database_name: 'TIPTOP', username: 'erp_reader', password: '********', is_active: true, created_at: '2026-03-15T08:00:00Z' },
  { id: 'ds-002', name: 'Test Data (PostgreSQL)', db_type: 'postgresql', host: '10.0.2.50', port: 5432, database_name: 'test_results', username: 'qa_reader', password: '********', is_active: true, created_at: '2026-03-20T10:00:00Z' },
  { id: 'ds-003', name: 'Legacy System (PostgreSQL)', db_type: 'postgresql', host: '10.0.3.10', port: 5432, database_name: 'legacy_db', username: 'readonly', password: '********', is_active: false, created_at: '2026-01-10T08:00:00Z' },
];

const MOCK_TABLES = [
  { name: 'ima_file', schema: 'TIPTOP', row_count_estimate: 125000, comment: 'Item Master - BOM main table' },
  { name: 'pmn_file', schema: 'TIPTOP', row_count_estimate: 85000, comment: 'Purchase orders' },
  { name: 'ina_file', schema: 'TIPTOP', row_count_estimate: 340000, comment: 'Inventory records' },
  { name: 'oca_file', schema: 'TIPTOP', row_count_estimate: 67000, comment: 'Sales orders' },
  { name: 'bma_file', schema: 'TIPTOP', row_count_estimate: 450000, comment: 'BOM detail records' },
  { name: 'mps_schedule', schema: 'PROD', row_count_estimate: 12000, comment: 'Production schedule' },
  { name: 'work_center', schema: 'PROD', row_count_estimate: 85, comment: 'Work center master' },
];

const MOCK_COLUMNS = [
  { name: 'ima_part_no', data_type: 'VARCHAR2(40)', nullable: false, is_pk: true, is_fk: false, comment: 'Part number (PK)' },
  { name: 'ima_part_desc', data_type: 'NVARCHAR2(120)', nullable: false, is_pk: false, is_fk: false, comment: 'Part description' },
  { name: 'ima_unit', data_type: 'VARCHAR2(4)', nullable: true, is_pk: false, is_fk: false, comment: 'Unit of measure' },
  { name: 'ima_catg', data_type: 'VARCHAR2(10)', nullable: true, is_pk: false, is_fk: true, comment: 'Category code (FK to category)' },
  { name: 'ima_on_hand', data_type: 'NUMBER(16,4)', nullable: true, is_pk: false, is_fk: false, comment: 'On hand quantity' },
  { name: 'ima_safety_stk', data_type: 'NUMBER(16,4)', nullable: true, is_pk: false, is_fk: false, comment: 'Safety stock level' },
  { name: 'ima_lead_time', data_type: 'NUMBER(6)', nullable: true, is_pk: false, is_fk: false, comment: 'Lead time (days)' },
  { name: 'ima_update_date', data_type: 'DATE', nullable: true, is_pk: false, is_fk: false, comment: 'Last update date' },
];

const MOCK_FUNCTIONS = [
  { name: 'get_bom_explosion', schema: 'TIPTOP', parameters: '(p_part_no VARCHAR2, p_level NUMBER DEFAULT 99)', return_type: 'SYS_REFCURSOR' },
  { name: 'calc_mrp_demand', schema: 'TIPTOP', parameters: '(p_product VARCHAR2, p_start_date DATE, p_end_date DATE)', return_type: 'SYS_REFCURSOR' },
  { name: 'get_inventory_status', schema: 'TIPTOP', parameters: '(p_part_no VARCHAR2, p_warehouse VARCHAR2 DEFAULT NULL)', return_type: 'SYS_REFCURSOR' },
];

const MOCK_PREVIEW = [
  { ima_part_no: 'PS5021-E21', ima_part_desc: 'PS5021 PCIe Gen5 Controller', ima_unit: 'PCS', ima_catg: 'CTRL', ima_on_hand: 15000, ima_safety_stk: 5000, ima_lead_time: 45 },
  { ima_part_no: 'YMTC-X3-9070', ima_part_desc: 'YMTC 232L QLC NAND 1TB', ima_unit: 'PCS', ima_catg: 'FLASH', ima_on_hand: 82000, ima_safety_stk: 20000, ima_lead_time: 30 },
  { ima_part_no: 'PS5026-E26', ima_part_desc: 'PS5026 PCIe Gen5 Controller', ima_unit: 'PCS', ima_catg: 'CTRL', ima_on_hand: 8500, ima_safety_stk: 3000, ima_lead_time: 45 },
  { ima_part_no: 'KIOXIA-BICS6-512', ima_part_desc: 'Kioxia BiCS6 162L TLC 512GB', ima_unit: 'PCS', ima_catg: 'FLASH', ima_on_hand: 45000, ima_safety_stk: 10000, ima_lead_time: 25 },
  { ima_part_no: 'SK-176L-1T', ima_part_desc: 'SK Hynix 176L TLC NAND 1TB', ima_unit: 'PCS', ima_catg: 'FLASH', ima_on_hand: 62000, ima_safety_stk: 15000, ima_lead_time: 28 },
];

const MOCK_COMBOS = [
  { id: 'combo-001', controller_model: 'PS5021-E21', flash_model: 'YMTC-X3-9070', target_ratio: 40.0, status: 'active', approved_by: null, approved_at: '2026-03-28T10:00:00Z', published_at: '2026-03-28T14:00:00Z', created_by: null, created_at: '2026-03-25T09:00:00Z', updated_at: '2026-03-28T14:00:00Z' },
  { id: 'combo-002', controller_model: 'PS5021-E21', flash_model: 'KIOXIA-BICS6-512', target_ratio: 30.0, status: 'active', approved_by: null, approved_at: '2026-03-28T10:00:00Z', published_at: '2026-03-28T14:00:00Z', created_by: null, created_at: '2026-03-25T09:00:00Z', updated_at: '2026-03-28T14:00:00Z' },
  { id: 'combo-003', controller_model: 'PS5026-E26', flash_model: 'SK-176L-1T', target_ratio: 30.0, status: 'active', approved_by: null, approved_at: '2026-04-01T08:00:00Z', published_at: '2026-04-01T09:00:00Z', created_by: null, created_at: '2026-03-30T14:00:00Z', updated_at: '2026-04-01T09:00:00Z' },
  { id: 'combo-004', controller_model: 'PS5026-E26', flash_model: 'YMTC-X3-9070', target_ratio: 25.0, status: 'pending_approval', approved_by: null, approved_at: null, published_at: null, created_by: null, created_at: '2026-04-03T11:00:00Z', updated_at: '2026-04-03T11:00:00Z' },
];

const MOCK_INVENTORY = [
  { model: 'PS5021-E21 + YMTC 1TB SSD', warehouse: 'Hsinchu HQ', quantity: 15200, in_transit: 3000, last_updated: '2026-04-04T06:00:00Z' },
  { model: 'PS5021-E21 + Kioxia 512GB SSD', warehouse: 'Hsinchu HQ', quantity: 8700, in_transit: 5000, last_updated: '2026-04-04T06:00:00Z' },
  { model: 'PS5026-E26 + SK Hynix 1TB SSD', warehouse: 'Hsinchu HQ', quantity: 4200, in_transit: 2000, last_updated: '2026-04-04T06:00:00Z' },
  { model: 'PS5021-E21 + YMTC 1TB SSD', warehouse: 'Zhubei Factory', quantity: 22000, in_transit: 0, last_updated: '2026-04-04T06:00:00Z' },
  { model: 'PS5026-E26 + SK Hynix 1TB SSD', warehouse: 'Zhubei Factory', quantity: 1500, in_transit: 8000, last_updated: '2026-04-04T06:00:00Z' },
];

const MOCK_SHORTAGES = [
  { part_number: 'YMTC-X3-9070', part_name: 'YMTC 232L QLC NAND 1TB', net_requirement: 35000, current_stock: 82000, demand: 120000, action_message: 'New PO needed — lead time 30 days' },
  { part_number: 'DRAM-DDR5-8G', part_name: 'DDR5 8GB Cache DRAM', net_requirement: 12000, current_stock: 5000, demand: 18000, action_message: 'Expedite — critical shortage' },
];

const MOCK_PM_KPIS = {
  total_products: 6,
  active_mps_count: 4,
  avg_yield: 94.2,
  bottleneck_count: 1,
  on_track_pct: 66.7,
  at_risk_pct: 16.7,
  delayed_pct: 16.6,
};

const MOCK_PM_OVERVIEW = [
  { product_model: 'PS5021+YMTC 1TB', combo: 'PS5021-E21 / YMTC-X3-9070', design_status: 'complete', test_status: 'passing (96.1%)', production_status: 'in_progress', overall_health: 'green' },
  { product_model: 'PS5021+Kioxia 512G', combo: 'PS5021-E21 / KIOXIA-BICS6-512', design_status: 'complete', test_status: 'passing (93.8%)', production_status: 'planned', overall_health: 'green' },
  { product_model: 'PS5026+SK 1TB', combo: 'PS5026-E26 / SK-176L-1T', design_status: 'complete', test_status: 'warning (88.5%)', production_status: 'in_progress', overall_health: 'yellow' },
  { product_model: 'PS5026+YMTC 1TB', combo: 'PS5026-E26 / YMTC-X3-9070', design_status: 'in_review', test_status: 'pending', production_status: 'planned', overall_health: 'yellow' },
];

const MOCK_PM_ALERTS = [
  { type: 'crp_bottleneck', severity: 'critical', message: 'SMT Line 2 utilization at 97% — capacity bottleneck', source: 'CRP', timestamp: '2026-04-04T07:30:00Z' },
  { type: 'mrp_shortage', severity: 'warning', message: 'DRAM-DDR5-8G shortage: need 12,000 more units', source: 'MRP', timestamp: '2026-04-04T06:00:00Z' },
  { type: 'quality', severity: 'warning', message: 'PS5026+SK 1TB yield dropped to 88.5% (threshold: 90%)', source: 'QA', timestamp: '2026-04-04T05:00:00Z' },
  { type: 'sync_lag', severity: 'info', message: 'Tiptop inventory sync lagging 8 minutes', source: 'Sync', timestamp: '2026-04-04T08:00:00Z' },
];

const MOCK_YIELD_SUMMARY = {
  avg_yield: 94.2, min_yield: 88.5, max_yield: 97.3, total_batches: 156, total_units: 890000,
  by_product: [
    { model: 'PS5021+YMTC 1TB', avg_yield: 96.1, trend: 'up' },
    { model: 'PS5021+Kioxia 512G', avg_yield: 93.8, trend: 'stable' },
    { model: 'PS5026+SK 1TB', avg_yield: 88.5, trend: 'down' },
  ],
};

const MOCK_YIELD_TREND = [
  { period: '2026-03-01', yield_rate: 93.5, total_units: 28000 },
  { period: '2026-03-08', yield_rate: 94.1, total_units: 32000 },
  { period: '2026-03-15', yield_rate: 93.8, total_units: 30000 },
  { period: '2026-03-22', yield_rate: 95.2, total_units: 35000 },
  { period: '2026-03-29', yield_rate: 94.8, total_units: 33000 },
  { period: '2026-04-04', yield_rate: 94.2, total_units: 31000 },
];

const MOCK_SYNC_CONFIGS = [
  { id: 'sc-001', data_source_id: 'ds-001', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'ina_file', sync_mode: 'cdc', cron_expression: null, is_active: true, created_at: '2026-03-15T08:00:00Z', updated_at: '2026-03-28T10:00:00Z' },
  { id: 'sc-002', data_source_id: 'ds-001', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'oca_file', sync_mode: 'cdc', cron_expression: null, is_active: true, created_at: '2026-03-15T09:00:00Z', updated_at: '2026-03-28T10:00:00Z' },
  { id: 'sc-003', data_source_id: 'ds-002', data_source_name: 'Test Data (PostgreSQL)', table_name: 'test_results', sync_mode: 'cdc', cron_expression: null, is_active: true, created_at: '2026-03-20T10:00:00Z', updated_at: '2026-03-28T10:00:00Z' },
  { id: 'sc-004', data_source_id: 'ds-001', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'pmn_file', sync_mode: 'batch', cron_expression: '0 * * * *', is_active: true, created_at: '2026-03-16T08:00:00Z', updated_at: '2026-03-28T10:00:00Z' },
  { id: 'sc-005', data_source_id: 'ds-001', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'bma_file', sync_mode: 'batch', cron_expression: '0 6 * * *', is_active: true, created_at: '2026-03-16T09:00:00Z', updated_at: '2026-03-28T10:00:00Z' },
  { id: 'sc-006', data_source_id: 'ds-003', data_source_name: 'Legacy System (PostgreSQL)', table_name: 'legacy_orders', sync_mode: 'batch', cron_expression: '*/30 * * * *', is_active: false, created_at: '2026-01-10T08:00:00Z', updated_at: '2026-02-15T10:00:00Z' },
];

const MOCK_SYNC_STATUS = [
  { config_id: 'sc-001', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'ina_file', sync_mode: 'cdc', cron_expression: null, is_active: true, last_sync_at: '2026-04-04T07:52:00Z', lag_seconds: 480, health: 'lagging', error_message: null, error_at: null },
  { config_id: 'sc-002', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'oca_file', sync_mode: 'cdc', cron_expression: null, is_active: true, last_sync_at: '2026-04-04T07:59:30Z', lag_seconds: 30, health: 'healthy', error_message: null, error_at: null },
  { config_id: 'sc-003', data_source_name: 'Test Data (PostgreSQL)', table_name: 'test_results', sync_mode: 'cdc', cron_expression: null, is_active: true, last_sync_at: '2026-04-04T07:59:55Z', lag_seconds: 5, health: 'healthy', error_message: null, error_at: null },
  { config_id: 'sc-004', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'pmn_file', sync_mode: 'batch', cron_expression: '0 * * * *', is_active: true, last_sync_at: '2026-04-04T07:00:00Z', lag_seconds: 3600, health: 'healthy', error_message: null, error_at: null },
  { config_id: 'sc-005', data_source_name: 'Tiptop ERP (Oracle)', table_name: 'bma_file', sync_mode: 'batch', cron_expression: '0 6 * * *', is_active: true, last_sync_at: '2026-04-04T06:00:00Z', lag_seconds: 7200, health: 'failed', error_message: 'ORA-12541: TNS:no listener — Oracle DB 連線逾時，無法建立連線至 10.0.1.100:1521', error_at: '2026-04-04T06:00:05Z' },
  { config_id: 'sc-006', data_source_name: 'Legacy System (PostgreSQL)', table_name: 'legacy_orders', sync_mode: 'batch', cron_expression: '*/30 * * * *', is_active: false, last_sync_at: '2026-02-15T10:00:00Z', lag_seconds: null, health: 'inactive', error_message: null, error_at: null },
];

const MOCK_SYNC_OVERVIEW = {
  total_configs: 8, active: 7, by_mode: { cdc: 3, batch: 5 }, healthy: 6, lagging: 1, failed: 0,
};

const MOCK_SYNC_DETAILED = [
  { data_source: 'Tiptop ERP', table_name: 'ina_file (Inventory)', mode: 'cdc', last_sync_at: '2026-04-04T07:52:00Z', lag_seconds: 480, health: 'lagging' },
  { data_source: 'Tiptop ERP', table_name: 'oca_file (Sales Orders)', mode: 'cdc', last_sync_at: '2026-04-04T07:59:30Z', lag_seconds: 30, health: 'healthy' },
  { data_source: 'Tiptop ERP', table_name: 'pmn_file (Purchase Orders)', mode: 'batch', last_sync_at: '2026-04-04T07:00:00Z', lag_seconds: 3600, health: 'healthy' },
  { data_source: 'Tiptop ERP', table_name: 'bma_file (BOM)', mode: 'batch', last_sync_at: '2026-04-04T06:00:00Z', lag_seconds: 7200, health: 'healthy' },
  { data_source: 'Test DB', table_name: 'test_results', mode: 'cdc', last_sync_at: '2026-04-04T07:59:55Z', lag_seconds: 5, health: 'healthy' },
];

// ── Mock Response Handler ────────────────────────────

function mockResponse(data: any, delay = 200): Promise<any> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    }), delay)
  );
}

function createMockInterceptor(instance: AxiosInstance) {
  instance.interceptors.request.use(async (config) => {
    const url = config.url || '';
    const method = config.method?.toUpperCase() || 'GET';

    // Auth
    if (url.includes('/auth/login')) {
      config.adapter = () => mockResponse({ access_token: 'demo-token-12345', token_type: 'bearer', user: MOCK_USER });
      return config;
    }
    if (url.includes('/auth/me')) {
      config.adapter = () => mockResponse(MOCK_USER);
      return config;
    }

    // Connections
    if (url.match(/\/connections\/supported-types/)) {
      config.adapter = () => mockResponse(['oracle', 'postgresql', 'mysql', 'sqlserver']);
      return config;
    }
    if (url.match(/\/connections\/[^/]+\/test/) && method === 'POST') {
      config.adapter = () => mockResponse({ success: true, message: 'Connection successful', server_version: 'Oracle 19c Enterprise Edition' });
      return config;
    }
    if (url.match(/\/connections\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse(MOCK_CONNECTIONS);
      return config;
    }

    // Schema
    if (url.match(/\/schema\/[^/]+\/tables\/[^/]+\/columns/)) {
      config.adapter = () => mockResponse(MOCK_COLUMNS);
      return config;
    }
    if (url.match(/\/schema\/[^/]+\/tables\/[^/]+\/preview/)) {
      config.adapter = () => mockResponse(MOCK_PREVIEW);
      return config;
    }
    if (url.match(/\/schema\/[^/]+\/tables/)) {
      config.adapter = () => mockResponse(MOCK_TABLES);
      return config;
    }
    if (url.match(/\/schema\/[^/]+\/functions/)) {
      config.adapter = () => mockResponse(MOCK_FUNCTIONS);
      return config;
    }
    if (url.match(/\/schema\/[^/]+\/search/)) {
      const q = (config.params?.q || '').toLowerCase();
      const filtered = MOCK_TABLES.filter(t => t.name.includes(q) || t.comment.toLowerCase().includes(q));
      config.adapter = () => mockResponse(filtered);
      return config;
    }

    // Combos
    if (url.match(/\/combos\/active/)) {
      config.adapter = () => mockResponse(MOCK_COMBOS.filter(c => c.status === 'active'));
      return config;
    }
    if (url.match(/\/combos\/history/)) {
      config.adapter = () => mockResponse([]);
      return config;
    }
    if (url.match(/\/combos\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse(MOCK_COMBOS);
      return config;
    }

    // Inventory
    if (url.match(/\/inventory\/search/)) {
      config.adapter = () => mockResponse(MOCK_INVENTORY);
      return config;
    }
    if (url.match(/\/inventory\/summary/)) {
      config.adapter = () => mockResponse({ total_skus: 5, total_quantity: 51600, total_in_transit: 18000 });
      return config;
    }

    // MRP
    if (url.match(/\/mrp\/shortages/)) {
      config.adapter = () => mockResponse(MOCK_SHORTAGES);
      return config;
    }
    if (url.match(/\/mrp\/bom\/[^/]+\/expand/)) {
      config.adapter = () => mockResponse([
        { part_number: 'PS5021-E21', part_name: 'Controller', total_quantity: 1, level: 0, lead_time_days: 45 },
        { part_number: 'YMTC-X3-9070', part_name: 'NAND Flash 1TB', total_quantity: 4, level: 1, lead_time_days: 30 },
        { part_number: 'DRAM-DDR5-8G', part_name: 'DDR5 Cache DRAM', total_quantity: 1, level: 1, lead_time_days: 21 },
        { part_number: 'PCB-2280-M2', part_name: 'M.2 2280 PCB', total_quantity: 1, level: 1, lead_time_days: 14 },
        { part_number: 'CAP-0402-100N', part_name: 'MLCC Capacitor 100nF', total_quantity: 48, level: 2, lead_time_days: 7 },
      ]);
      return config;
    }
    if (url.match(/\/mrp\/mps/) && method === 'GET') {
      config.adapter = () => mockResponse([
        { id: 'mps-1', product_model: 'PS5021+YMTC 1TB', period_start: '2026-04-07', period_end: '2026-04-13', planned_quantity: 12000, confirmed_quantity: 10000, status: 'confirmed' },
        { id: 'mps-2', product_model: 'PS5021+Kioxia 512G', period_start: '2026-04-07', period_end: '2026-04-13', planned_quantity: 8000, confirmed_quantity: 0, status: 'planned' },
        { id: 'mps-3', product_model: 'PS5026+SK 1TB', period_start: '2026-04-07', period_end: '2026-04-13', planned_quantity: 6000, confirmed_quantity: 6000, status: 'in_progress' },
      ]);
      return config;
    }
    if (url.match(/\/mrp\/crp\/bottlenecks/)) {
      config.adapter = () => mockResponse([
        { work_center: 'SMT Line 2', utilization_pct: 97.2, required_capacity: 14580, available_capacity: 15000, is_bottleneck: true },
      ]);
      return config;
    }

    // Dashboards
    if (url.match(/\/dashboards\/pm\/kpis/)) {
      config.adapter = () => mockResponse(MOCK_PM_KPIS);
      return config;
    }
    if (url.match(/\/dashboards\/pm\/overview/)) {
      config.adapter = () => mockResponse(MOCK_PM_OVERVIEW);
      return config;
    }
    if (url.match(/\/dashboards\/pm\/alerts/)) {
      config.adapter = () => mockResponse(MOCK_PM_ALERTS);
      return config;
    }
    if (url.match(/\/dashboards\/quality\/yield-summary/)) {
      config.adapter = () => mockResponse(MOCK_YIELD_SUMMARY);
      return config;
    }
    if (url.match(/\/dashboards\/quality\/yield-trend/)) {
      config.adapter = () => mockResponse(MOCK_YIELD_TREND);
      return config;
    }
    if (url.match(/\/dashboards\/quality\/alerts/)) {
      config.adapter = () => mockResponse([
        { type: 'yield_drop', severity: 'warning', message: 'PS5026+SK 1TB yield at 88.5%, below 90% threshold', product_model: 'PS5026+SK 1TB' },
      ]);
      return config;
    }
    // Sync configs
    if (url.match(/\/sync\/configs\/[^/]+\/trigger/) && method === 'POST') {
      config.adapter = () => mockResponse({ message: '已成功觸發同步作業' });
      return config;
    }
    if (url.match(/\/sync\/configs\/[^/]+/) && method === 'PUT') {
      const id = url.match(/\/sync\/configs\/([^/]+)/)?.[1];
      const existing = MOCK_SYNC_CONFIGS.find(c => c.id === id);
      config.adapter = () => mockResponse({ ...existing, ...(config.data ? JSON.parse(config.data as string) : {}), updated_at: new Date().toISOString() });
      return config;
    }
    if (url.match(/\/sync\/configs\/[^/]+/) && method === 'DELETE') {
      config.adapter = () => mockResponse(null);
      return config;
    }
    if (url.match(/\/sync\/configs\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse(MOCK_SYNC_CONFIGS);
      return config;
    }
    if (url.match(/\/sync\/configs\/?$/) && method === 'POST') {
      const body = config.data ? JSON.parse(config.data as string) : {};
      const newConfig = { id: `sc-${Date.now()}`, ...body, data_source_name: 'New Source', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      config.adapter = () => mockResponse(newConfig);
      return config;
    }
    if (url.match(/\/sync\/status\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse(MOCK_SYNC_STATUS);
      return config;
    }

    if (url.match(/\/dashboards\/sync\/overview/)) {
      config.adapter = () => mockResponse(MOCK_SYNC_OVERVIEW);
      return config;
    }
    if (url.match(/\/dashboards\/sync\/detailed/)) {
      config.adapter = () => mockResponse(MOCK_SYNC_DETAILED);
      return config;
    }

    // ETL Pipelines
    if (url.match(/\/etl\/pipelines\/[^/]+\/run/) && method === 'POST') {
      config.adapter = () => mockResponse({ status: 'success', rows: 1250, duration_ms: 3420 });
      return config;
    }
    if (url.match(/\/etl\/pipelines\/[^/]+\/history/)) {
      config.adapter = () => mockResponse([]);
      return config;
    }
    if (url.match(/\/etl\/pipelines\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse([
        { id: 'pipe-001', name: '庫存資料同步', source_datasource_id: 'ds-001', source_table: 'ina_file', target_table: 'inventory_records', transform_config: { select_columns: ['ima_part_no', 'ima_on_hand', 'ima_safety_stk'] }, cron_expression: '0 */2 * * *', is_active: true, last_run_at: '2026-04-04T06:00:00Z', last_run_status: 'success', last_run_duration_ms: 3420, last_run_rows: 125000, created_by: 'demo-001', created_at: '2026-03-20T10:00:00Z', updated_at: '2026-04-04T06:00:00Z' },
        { id: 'pipe-002', name: 'BOM 結構匯入', source_datasource_id: 'ds-001', source_table: 'bma_file', target_table: 'bom_records', transform_config: { select_columns: ['bma_parent', 'bma_child', 'bma_qty'] }, cron_expression: '0 6 * * *', is_active: true, last_run_at: '2026-04-04T06:00:00Z', last_run_status: 'success', last_run_duration_ms: 8920, last_run_rows: 450000, created_by: 'demo-001', created_at: '2026-03-22T08:00:00Z', updated_at: '2026-04-04T06:00:00Z' },
        { id: 'pipe-003', name: '測試數據匯入', source_datasource_id: 'ds-002', source_table: 'test_results', target_table: 'test_records', transform_config: { select_columns: ['batch_id', 'yield_rate', 'total_units'] }, cron_expression: '30 * * * *', is_active: true, last_run_at: '2026-04-04T07:30:00Z', last_run_status: 'running', last_run_duration_ms: null, last_run_rows: null, created_by: 'demo-001', created_at: '2026-03-25T14:00:00Z', updated_at: '2026-04-04T07:30:00Z' },
      ]);
      return config;
    }
    if (url.match(/\/etl\/pipelines\/?$/) && method === 'POST') {
      const body = config.data ? JSON.parse(config.data as string) : {};
      config.adapter = () => mockResponse({ id: `pipe-${Date.now()}`, ...body, is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return config;
    }

    // ETL Reports
    if (url.match(/\/etl\/reports\/tables/)) {
      config.adapter = () => mockResponse(['inventory_records', 'mrp_results', 'demand_records', 'test_results', 'product_combos']);
      return config;
    }
    if (url.match(/\/etl\/reports\/[^/]+\/execute/) && method === 'POST') {
      config.adapter = () => mockResponse({
        columns: ['product_model', 'quantity'],
        data: [
          { product_model: 'PS5021+YMTC 1TB', quantity: 15200 },
          { product_model: 'PS5021+Kioxia 512G', quantity: 8700 },
          { product_model: 'PS5026+SK 1TB', quantity: 4200 },
          { product_model: 'PS5026+YMTC 1TB', quantity: 2100 },
        ],
        row_count: 4,
        sql_preview: 'SELECT "product_model", SUM("quantity") AS "quantity" FROM "inventory_records" GROUP BY "product_model" LIMIT 1000',
      });
      return config;
    }
    if (url.match(/\/etl\/reports\/[^/]+\/share/) && method === 'POST') {
      config.adapter = () => mockResponse({ status: 'shared' });
      return config;
    }
    if (url.match(/\/etl\/reports\/[^/]+\/approve-share/) && method === 'POST') {
      config.adapter = () => mockResponse({ status: 'approved' });
      return config;
    }
    if (url.match(/\/etl\/reports\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse([
        { id: 'rpt-001', name: '庫存分佈圖', source_table: 'inventory_records', chart_type: 'bar', config: { x_axis: 'warehouse', y_axis: 'quantity', aggregation: 'SUM' }, is_shared: true, share_approved: true, created_by: 'demo-001', created_at: '2026-03-28T10:00:00Z', updated_at: '2026-04-03T15:00:00Z' },
        { id: 'rpt-002', name: '良率趨勢', source_table: 'test_results', chart_type: 'line', config: { x_axis: 'test_date', y_axis: 'yield_rate', aggregation: 'AVG' }, is_shared: false, share_approved: false, created_by: 'demo-001', created_at: '2026-03-30T09:00:00Z', updated_at: '2026-04-02T11:00:00Z' },
        { id: 'rpt-003', name: '產品組合佔比', source_table: 'product_combos', chart_type: 'pie', config: { x_axis: 'controller_model', y_axis: 'target_ratio', aggregation: 'SUM' }, is_shared: true, share_approved: false, created_by: 'demo-001', created_at: '2026-04-01T08:00:00Z', updated_at: '2026-04-01T08:00:00Z' },
        { id: 'rpt-004', name: 'MRP 需求明細', source_table: 'mrp_results', chart_type: 'table', config: { x_axis: 'part_no', y_axis: 'net_requirement' }, is_shared: false, share_approved: false, created_by: 'demo-001', created_at: '2026-04-02T14:00:00Z', updated_at: '2026-04-02T14:00:00Z' },
      ]);
      return config;
    }
    if (url.match(/\/etl\/reports\/?$/) && method === 'POST') {
      const body = config.data ? JSON.parse(config.data as string) : {};
      config.adapter = () => mockResponse({ id: `rpt-${Date.now()}`, ...body, is_shared: false, share_approved: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return config;
    }

    // ETL Dashboards
    if (url.match(/\/etl\/dashboards\/[^/]+\/export\/pdf/)) {
      config.adapter = () => mockResponse('<html><body><h1>Dashboard PDF Export</h1></body></html>');
      return config;
    }
    if (url.match(/\/etl\/dashboards\/[^/]+\/schedule-email/) && method === 'POST') {
      config.adapter = () => mockResponse({ status: 'scheduled' });
      return config;
    }
    if (url.match(/\/etl\/dashboards\/[^/]+\/share/) && method === 'POST') {
      config.adapter = () => mockResponse({ status: 'shared' });
      return config;
    }
    if (url.match(/\/etl\/dashboards\/[^/]+/) && method === 'GET') {
      config.adapter = () => mockResponse({
        id: 'dash-001', name: '生產總覽儀表板', description: '即時生產與庫存狀態', layout: [
          { report_id: 'rpt-001', x: 0, y: 0, w: 6, h: 4 },
          { report_id: 'rpt-002', x: 6, y: 0, w: 6, h: 4 },
        ], refresh_interval_seconds: 300, is_shared: true, share_approved: true,
        reports_data: [],
      });
      return config;
    }
    if (url.match(/\/etl\/dashboards\/?$/) && method === 'GET') {
      config.adapter = () => mockResponse([
        { id: 'dash-001', name: '生產總覽儀表板', description: '即時生產與庫存狀態', layout: [{ report_id: 'rpt-001', x: 0, y: 0, w: 6, h: 4 }, { report_id: 'rpt-002', x: 6, y: 0, w: 6, h: 4 }], refresh_interval_seconds: 300, is_shared: true, share_approved: true, created_by: 'demo-001', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-04T06:00:00Z' },
        { id: 'dash-002', name: '品質監控面板', description: '良率與測試結果追蹤', layout: [{ report_id: 'rpt-002', x: 0, y: 0, w: 12, h: 5 }, { report_id: 'rpt-003', x: 0, y: 5, w: 6, h: 4 }], refresh_interval_seconds: 60, is_shared: false, share_approved: false, created_by: 'demo-001', created_at: '2026-04-02T14:00:00Z', updated_at: '2026-04-03T09:00:00Z' },
      ]);
      return config;
    }
    if (url.match(/\/etl\/dashboards\/?$/) && method === 'POST') {
      const body = config.data ? JSON.parse(config.data as string) : {};
      config.adapter = () => mockResponse({ id: `dash-${Date.now()}`, ...body, is_shared: false, share_approved: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return config;
    }

    // Default fallback for unhandled routes
    config.adapter = () => mockResponse([]);
    return config;
  });
}

// ── Create Client ────────────────────────────────────

const apiClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Add JWT token interceptor
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Handle 401 responses
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Enable mock mode when deployed without backend
if (DEMO_MODE) {
  console.log('[MRP Platform] Running in DEMO mode with mock data');
  createMockInterceptor(apiClient);
}

export default apiClient;
export { DEMO_MODE };
