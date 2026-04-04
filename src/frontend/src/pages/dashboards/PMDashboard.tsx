import React from 'react';
import {
  Card, Row, Col, Statistic, Table, Alert, Typography, Badge, Spin,
} from 'antd';
import {
  ProjectOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { getPmOverview, getPmKpis, getPmAlerts, PmOverviewProject } from '../../api/dashboards';

const { Title } = Typography;

const healthBadge: Record<string, 'success' | 'warning' | 'error'> = {
  green: 'success',
  yellow: 'warning',
  red: 'error',
};

const severityTypeMap: Record<string, 'error' | 'warning' | 'info'> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};

const PMDashboard: React.FC = () => {
  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['pm', 'kpis'],
    queryFn: getPmKpis,
    refetchInterval: 30000,
  });

  const { data: projects = [], isLoading: projectsLoading } = useQuery({
    queryKey: ['pm', 'overview'],
    queryFn: getPmOverview,
    refetchInterval: 30000,
  });

  const { data: alerts = [] } = useQuery({
    queryKey: ['pm', 'alerts'],
    queryFn: getPmAlerts,
    refetchInterval: 30000,
  });

  const columns = [
    { title: '產品型號', dataIndex: 'product_model', key: 'product_model' },
    { title: '組合', dataIndex: 'combo', key: 'combo' },
    { title: '設計狀態', dataIndex: 'design_status', key: 'design_status' },
    { title: '測試狀態', dataIndex: 'test_status', key: 'test_status' },
    { title: '生產狀態', dataIndex: 'production_status', key: 'production_status' },
    {
      title: '健康度',
      dataIndex: 'health',
      key: 'health',
      render: (health: string) => (
        <Badge status={healthBadge[health] || 'default'} />
      ),
    },
  ];

  return (
    <div>
      <Title level={4}>PM 儀表板</Title>

      {kpisLoading ? (
        <Spin />
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="進行中專案"
                value={kpis?.active_projects ?? 0}
                prefix={<ProjectOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="如期進行"
                value={kpis?.on_track_pct ?? 0}
                suffix="%"
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="風險警示"
                value={kpis?.at_risk_pct ?? 0}
                suffix="%"
                valueStyle={{ color: '#faad14' }}
                prefix={<WarningOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="瓶頸數量"
                value={kpis?.bottleneck_count ?? 0}
                valueStyle={{
                  color: (kpis?.bottleneck_count ?? 0) > 0 ? '#cf1322' : undefined,
                }}
                prefix={<StopOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Card title="專案總覽" style={{ marginBottom: 24 }}>
        <Table<PmOverviewProject>
          rowKey="id"
          columns={columns}
          dataSource={projects}
          loading={projectsLoading}
          pagination={{ pageSize: 10 }}
          size="middle"
        />
      </Card>

      <Card title="警示通知">
        {alerts.length === 0 ? (
          <Alert message="目前無警示" type="success" showIcon />
        ) : (
          alerts
            .sort((a, b) => {
              const order = { critical: 0, warning: 1, info: 2 };
              return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
            })
            .map((alert) => (
              <Alert
                key={alert.id}
                message={`[${alert.project}] ${alert.message}`}
                type={severityTypeMap[alert.severity] || 'info'}
                showIcon
                style={{ marginBottom: 8 }}
              />
            ))
        )}
      </Card>
    </div>
  );
};

export default PMDashboard;
