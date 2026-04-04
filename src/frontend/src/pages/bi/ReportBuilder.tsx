import React, { useState, useEffect, useMemo } from 'react';
import {
  Card, Steps, Select, Button, Form, Input, InputNumber, Space, Table as AntTable,
  Radio, Tag, message, Typography, Row, Col, Divider, Empty,
} from 'antd';
import {
  LineChartOutlined, BarChartOutlined, PieChartOutlined, AreaChartOutlined,
  DotChartOutlined, TableOutlined, SaveOutlined, ShareAltOutlined,
  PlusOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getAvailableTables, createReport, updateReport, getReport, executeReport,
  shareReport, BiReport,
} from '../../api/etl';

const { Title, Text } = Typography;
const { Option } = Select;

const CHART_TYPES = [
  { key: 'line', label: '折線圖', icon: <LineChartOutlined /> },
  { key: 'bar', label: '長條圖', icon: <BarChartOutlined /> },
  { key: 'pie', label: '圓餅圖', icon: <PieChartOutlined /> },
  { key: 'area', label: '面積圖', icon: <AreaChartOutlined /> },
  { key: 'scatter', label: '散佈圖', icon: <DotChartOutlined /> },
  { key: 'table', label: '資料表', icon: <TableOutlined /> },
];

const AGGREGATIONS = [
  { value: 'SUM', label: 'SUM (加總)' },
  { value: 'AVG', label: 'AVG (平均)' },
  { value: 'COUNT', label: 'COUNT (計數)' },
  { value: 'MAX', label: 'MAX (最大)' },
  { value: 'MIN', label: 'MIN (最小)' },
];

const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE'];

// Simulated columns per table
const TABLE_COLUMNS: Record<string, string[]> = {
  inventory_records: ['part_no', 'part_name', 'quantity', 'warehouse', 'last_updated'],
  mrp_results: ['part_no', 'net_requirement', 'current_stock', 'demand', 'action_message'],
  demand_records: ['product_model', 'period', 'quantity', 'source', 'created_at'],
  test_results: ['batch_id', 'product_model', 'yield_rate', 'total_units', 'test_date'],
  product_combos: ['controller_model', 'flash_model', 'target_ratio', 'status', 'created_at'],
};

interface FilterRow {
  column: string;
  operator: string;
  value: string;
}

const ReportBuilder: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState(0);
  const [form] = Form.useForm();

  const [sourceTable, setSourceTable] = useState<string>('');
  const [chartType, setChartType] = useState<string>('bar');
  const [xAxis, setXAxis] = useState<string>('');
  const [yAxis, setYAxis] = useState<string>('');
  const [aggregation, setAggregation] = useState<string>('');
  const [groupBy, setGroupBy] = useState<string>('');
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [sortColumn, setSortColumn] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<string>('ASC');
  const [limit, setLimit] = useState<number>(1000);
  const [previewData, setPreviewData] = useState<any>(null);
  const [reportName, setReportName] = useState<string>('');
  const [reportDesc, setReportDesc] = useState<string>('');

  const { data: tables = [] } = useQuery({
    queryKey: ['bi-tables'],
    queryFn: getAvailableTables,
  });

  const { data: existingReport } = useQuery({
    queryKey: ['bi-report', id],
    queryFn: () => getReport(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (existingReport) {
      const r = existingReport as BiReport;
      setSourceTable(r.source_table);
      setChartType(r.chart_type);
      setReportName(r.name);
      setReportDesc(r.description || '');
      if (r.config) {
        setXAxis(r.config.x_axis || '');
        setYAxis(r.config.y_axis || '');
        setAggregation(r.config.aggregation || '');
        setGroupBy(r.config.group_by || '');
        setFilters(r.config.filters || []);
        setSortColumn(r.config.sort || '');
        setSortOrder(r.config.sort_order || 'ASC');
        setLimit(r.config.limit || 1000);
      }
    }
  }, [existingReport]);

  const columns = useMemo(() => {
    return TABLE_COLUMNS[sourceTable] || [];
  }, [sourceTable]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: reportName,
        source_table: sourceTable,
        chart_type: chartType,
        config: {
          x_axis: xAxis,
          y_axis: yAxis,
          aggregation,
          group_by: groupBy || undefined,
          filters: filters.length > 0 ? filters : undefined,
          sort: sortColumn || undefined,
          sort_order: sortOrder,
          limit,
        },
      };
      if (id) {
        return updateReport(id, { ...payload, description: reportDesc });
      }
      return createReport(payload);
    },
    onSuccess: (result: any) => {
      message.success('報表已儲存');
      queryClient.invalidateQueries({ queryKey: ['bi-reports'] });
      if (!id && result?.id) {
        navigate(`/bi/reports/${result.id}`);
      }
    },
    onError: () => message.error('儲存失敗'),
  });

  const executeMutation = useMutation({
    mutationFn: async () => {
      // For preview we need a saved report, or simulate
      if (id) {
        return executeReport(id);
      }
      // Simulate preview data for unsaved reports
      return {
        columns: [xAxis, yAxis].filter(Boolean),
        data: Array.from({ length: 5 }, (_, i) => ({
          [xAxis || 'x']: `Item ${i + 1}`,
          [yAxis || 'y']: Math.floor(Math.random() * 100),
        })),
        row_count: 5,
      };
    },
    onSuccess: (data) => {
      setPreviewData(data);
      message.success('預覽資料已載入');
    },
    onError: () => message.error('查詢失敗'),
  });

  const shareMutation = useMutation({
    mutationFn: () => shareReport(id!),
    onSuccess: () => message.success('已送出分享申請'),
  });

  const addFilter = () => {
    setFilters([...filters, { column: '', operator: '=', value: '' }]);
  };

  const removeFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, field: keyof FilterRow, value: string) => {
    const updated = [...filters];
    updated[index] = { ...updated[index], [field]: value };
    setFilters(updated);
  };

  const renderPreview = () => {
    if (!previewData || !previewData.data?.length) {
      return <Empty description="尚無預覽資料，請先執行查詢" />;
    }

    if (chartType === 'table') {
      const cols = (previewData.columns || []).map((c: string) => ({
        title: c,
        dataIndex: c,
        key: c,
      }));
      return (
        <AntTable
          dataSource={previewData.data.map((d: any, i: number) => ({ ...d, key: i }))}
          columns={cols}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      );
    }

    // Simple chart preview using a basic bar/visual representation
    return (
      <div style={{ padding: 16 }}>
        <Text type="secondary">
          圖表類型: {CHART_TYPES.find((t) => t.key === chartType)?.label || chartType}
        </Text>
        <Divider />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 200 }}>
          {previewData.data.slice(0, 20).map((row: any, i: number) => {
            const val = Number(row[yAxis] || row[Object.keys(row)[1]] || 0);
            const maxVal = Math.max(...previewData.data.map((r: any) =>
              Number(r[yAxis] || r[Object.keys(r)[1]] || 0)
            ), 1);
            const height = Math.max((val / maxVal) * 160, 4);
            const label = row[xAxis] || row[Object.keys(row)[0]] || `#${i}`;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                <Text style={{ fontSize: 10 }}>{val}</Text>
                <div style={{
                  width: '100%',
                  maxWidth: 40,
                  height,
                  backgroundColor: `hsl(${(i * 50) % 360}, 70%, 55%)`,
                  borderRadius: 4,
                }} />
                <Text style={{ fontSize: 10, marginTop: 4 }} ellipsis>{label}</Text>
              </div>
            );
          })}
        </div>
        <Divider />
        <Text type="secondary">共 {previewData.row_count} 筆資料</Text>
      </div>
    );
  };

  const steps = [
    {
      title: '選擇資料表',
      content: (
        <div style={{ maxWidth: 400 }}>
          <Form.Item label="資料來源表">
            <Select
              value={sourceTable || undefined}
              onChange={setSourceTable}
              placeholder="請選擇資料表"
              showSearch
            >
              {tables.map((t) => (
                <Option key={t} value={t}>{t}</Option>
              ))}
            </Select>
          </Form.Item>
        </div>
      ),
    },
    {
      title: '設定圖表',
      content: (
        <div>
          <Form.Item label="圖表類型">
            <Radio.Group value={chartType} onChange={(e) => setChartType(e.target.value)}>
              {CHART_TYPES.map((ct) => (
                <Radio.Button key={ct.key} value={ct.key}>
                  <Space>{ct.icon}{ct.label}</Space>
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="X 軸">
                <Select value={xAxis || undefined} onChange={setXAxis} placeholder="選擇欄位">
                  {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="Y 軸">
                <Select value={yAxis || undefined} onChange={setYAxis} placeholder="選擇欄位">
                  {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="聚合">
                <Select value={aggregation || undefined} onChange={setAggregation} placeholder="聚合" allowClear>
                  {AGGREGATIONS.map((a) => <Option key={a.value} value={a.value}>{a.label}</Option>)}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="分組 (Group By)">
                <Select value={groupBy || undefined} onChange={setGroupBy} placeholder="選擇欄位" allowClear>
                  {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="排序欄位">
                <Select value={sortColumn || undefined} onChange={setSortColumn} placeholder="選擇欄位" allowClear>
                  {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="排序方向">
                <Select value={sortOrder} onChange={setSortOrder}>
                  <Option value="ASC">升冪</Option>
                  <Option value="DESC">降冪</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="筆數上限">
                <InputNumber value={limit} onChange={(v) => setLimit(v || 1000)} min={1} max={100000} />
              </Form.Item>
            </Col>
          </Row>

          <Divider>篩選條件</Divider>
          {filters.map((f, i) => (
            <Row key={i} gutter={8} style={{ marginBottom: 8 }}>
              <Col span={8}>
                <Select value={f.column || undefined} onChange={(v) => updateFilter(i, 'column', v)} placeholder="欄位">
                  {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </Col>
              <Col span={4}>
                <Select value={f.operator} onChange={(v) => updateFilter(i, 'operator', v)}>
                  {OPERATORS.map((op) => <Option key={op} value={op}>{op}</Option>)}
                </Select>
              </Col>
              <Col span={8}>
                <Input value={f.value} onChange={(e) => updateFilter(i, 'value', e.target.value)} placeholder="值" />
              </Col>
              <Col span={4}>
                <Button danger icon={<DeleteOutlined />} onClick={() => removeFilter(i)} />
              </Col>
            </Row>
          ))}
          <Button type="dashed" onClick={addFilter} icon={<PlusOutlined />} block>
            新增篩選條件
          </Button>
        </div>
      ),
    },
    {
      title: '預覽',
      content: (
        <div>
          <Button
            type="primary"
            onClick={() => executeMutation.mutate()}
            loading={executeMutation.isPending}
            style={{ marginBottom: 16 }}
          >
            執行查詢
          </Button>
          {renderPreview()}
        </div>
      ),
    },
    {
      title: '儲存',
      content: (
        <div style={{ maxWidth: 400 }}>
          <Form.Item label="報表名稱" required>
            <Input value={reportName} onChange={(e) => setReportName(e.target.value)} placeholder="請輸入報表名稱" />
          </Form.Item>
          <Form.Item label="描述">
            <Input.TextArea value={reportDesc} onChange={(e) => setReportDesc(e.target.value)} rows={3} />
          </Form.Item>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => saveMutation.mutate()}
              loading={saveMutation.isPending}
              disabled={!reportName || !sourceTable}
            >
              儲存報表
            </Button>
            {id && (
              <Button
                icon={<ShareAltOutlined />}
                onClick={() => shareMutation.mutate()}
                loading={shareMutation.isPending}
              >
                分享
              </Button>
            )}
          </Space>
        </div>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <Title level={4}>{id ? '編輯報表' : '建立 BI 報表'}</Title>
        <Steps current={currentStep} items={steps.map((s) => ({ title: s.title }))} style={{ marginBottom: 24 }} />
        <div style={{ minHeight: 300 }}>{steps[currentStep].content}</div>
        <Divider />
        <Space>
          {currentStep > 0 && <Button onClick={() => setCurrentStep(currentStep - 1)}>上一步</Button>}
          {currentStep < steps.length - 1 && (
            <Button type="primary" onClick={() => setCurrentStep(currentStep + 1)}>
              下一步
            </Button>
          )}
        </Space>
      </Card>
    </div>
  );
};

export default ReportBuilder;
