import React, { useState } from 'react';
import {
  Card, Row, Col, Statistic, Select, DatePicker, Alert, Typography,
  Button, Modal, Input, Table, Space, Spin,
} from 'antd';
import ReactECharts from 'echarts-for-react';
import { useQuery } from '@tanstack/react-query';
import {
  getYieldSummary,
  getYieldTrend,
  getQualityAlerts,
  YieldTrendPoint,
} from '../../api/dashboards';
import apiClient from '../../api/client';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const severityTypeMap: Record<string, 'error' | 'warning' | 'info'> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};

const QualityDashboard: React.FC = () => {
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [period, setPeriod] = useState<string | undefined>();
  const [compareOpen, setCompareOpen] = useState(false);
  const [versionA, setVersionA] = useState('');
  const [versionB, setVersionB] = useState('');
  const [compareData, setCompareData] = useState<Record<string, unknown>[] | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['quality', 'yield-summary', selectedModel, period],
    queryFn: () =>
      getYieldSummary({
        model: selectedModel || undefined,
        ...(period ? { start_date: period } : {}),
      }),
  });

  const { data: trend = [], isLoading: trendLoading } = useQuery({
    queryKey: ['quality', 'yield-trend', selectedModel, period],
    queryFn: () => getYieldTrend(selectedModel, period),
    enabled: !!selectedModel,
  });

  const { data: alerts = [] } = useQuery({
    queryKey: ['quality', 'alerts'],
    queryFn: getQualityAlerts,
  });

  const lineChartOption = {
    tooltip: { trigger: 'axis' as const },
    xAxis: {
      type: 'category' as const,
      data: trend.map((p: YieldTrendPoint) => p.date),
    },
    yAxis: {
      type: 'value' as const,
      min: 0,
      max: 100,
      axisLabel: { formatter: '{value}%' },
    },
    series: [
      {
        name: '良率',
        type: 'line',
        data: trend.map((p: YieldTrendPoint) => p.yield_pct),
        smooth: true,
        markLine: {
          data: [{ yAxis: 90, name: '門檻', lineStyle: { color: '#ff4d4f' } }],
        },
      },
    ],
  };

  const pieChartOption = {
    tooltip: { trigger: 'item' as const },
    series: [
      {
        name: '失敗分析',
        type: 'pie',
        radius: ['40%', '70%'],
        data: (summary?.by_test_type ?? []).map((t) => ({
          name: t.type,
          value: t.count,
        })),
      },
    ],
  };

  const handleCompare = async () => {
    if (!versionA || !versionB) return;
    setCompareLoading(true);
    try {
      const { data } = await apiClient.get('/api/dashboards/quality/fw-compare', {
        params: { version_a: versionA, version_b: versionB },
      });
      setCompareData(data);
    } catch {
      setCompareData([]);
    } finally {
      setCompareLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>品質分析儀表板</Title>
        <Space wrap>
          <Select
            placeholder="選擇產品型號"
            style={{ width: 200 }}
            value={selectedModel || undefined}
            onChange={setSelectedModel}
            allowClear
            options={[
              { value: 'PS5021-E21', label: 'PS5021-E21' },
              { value: 'PS5019-E19', label: 'PS5019-E19' },
              { value: 'PS5027-E27', label: 'PS5027-E27' },
            ]}
          />
          <RangePicker
            onChange={(_, dateStrings) => {
              setPeriod(dateStrings[0] || undefined);
            }}
          />
          <Button onClick={() => setCompareOpen(true)}>FW 版本比較</Button>
        </Space>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <Card>
            {summaryLoading ? <Spin /> : (
              <Statistic
                title="平均良率"
                value={summary?.average_yield ?? 0}
                suffix="%"
                precision={1}
                valueStyle={{ color: (summary?.average_yield ?? 0) >= 90 ? '#3f8600' : '#cf1322' }}
              />
            )}
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="最低良率" value={summary?.min_yield ?? 0} suffix="%" precision={1} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="最高良率" value={summary?.max_yield ?? 0} suffix="%" precision={1} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title="總批次" value={summary?.total_batches ?? 0} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={16}>
          <Card title="良率趨勢">
            {!selectedModel ? (
              <Text type="secondary">請選擇產品型號以查看趨勢</Text>
            ) : trendLoading ? (
              <Spin />
            ) : (
              <ReactECharts option={lineChartOption} style={{ height: 350 }} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="失敗分析">
            {summaryLoading ? (
              <Spin />
            ) : (summary?.by_test_type ?? []).length === 0 ? (
              <Text type="secondary">無資料</Text>
            ) : (
              <ReactECharts option={pieChartOption} style={{ height: 350 }} />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="品質警示">
        {alerts.length === 0 ? (
          <Alert message="目前無品質警示" type="success" showIcon />
        ) : (
          alerts.map((a) => (
            <Alert
              key={a.id}
              message={`[${a.model}] ${a.message}`}
              type={severityTypeMap[a.severity] || 'info'}
              showIcon
              style={{ marginBottom: 8 }}
            />
          ))
        )}
      </Card>

      <Modal
        title="FW 版本比較"
        open={compareOpen}
        onCancel={() => {
          setCompareOpen(false);
          setCompareData(null);
        }}
        footer={null}
        width={700}
      >
        <Space style={{ marginBottom: 16 }}>
          <Input
            placeholder="版本 A"
            value={versionA}
            onChange={(e) => setVersionA(e.target.value)}
          />
          <Input
            placeholder="版本 B"
            value={versionB}
            onChange={(e) => setVersionB(e.target.value)}
          />
          <Button type="primary" onClick={handleCompare} loading={compareLoading}>
            比較
          </Button>
        </Space>
        {compareData && (
          <Table
            rowKey={(_, i) => String(i)}
            dataSource={compareData}
            columns={Object.keys(compareData[0] ?? {}).map((k) => ({
              title: k,
              dataIndex: k,
              key: k,
            }))}
            pagination={false}
            size="small"
          />
        )}
      </Modal>
    </div>
  );
};

export default QualityDashboard;
