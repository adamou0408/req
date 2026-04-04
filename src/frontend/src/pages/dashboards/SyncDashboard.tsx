import React from 'react';
import {
  Card, Row, Col, Statistic, Table, Tag, Badge, Typography, Spin,
} from 'antd';
import {
  SyncOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { getSyncOverview, getSyncDetailed, SyncDetail } from '../../api/dashboards';

const { Title } = Typography;

const healthConfig: Record<string, { status: 'success' | 'warning' | 'error'; label: string }> = {
  healthy: { status: 'success', label: '正常' },
  lagging: { status: 'warning', label: '延遲' },
  failed: { status: 'error', label: '失敗' },
};

const healthOrder: Record<string, number> = { failed: 0, lagging: 1, healthy: 2 };

const SyncDashboard: React.FC = () => {
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['sync', 'overview'],
    queryFn: getSyncOverview,
    refetchInterval: 15000,
  });

  const { data: details = [], isLoading: detailsLoading } = useQuery({
    queryKey: ['sync', 'detailed'],
    queryFn: getSyncDetailed,
    refetchInterval: 15000,
  });

  const sortedDetails = [...details].sort(
    (a, b) => (healthOrder[a.health] ?? 3) - (healthOrder[b.health] ?? 3)
  );

  const columns = [
    { title: '資料來源', dataIndex: 'data_source', key: 'data_source' },
    { title: '資料表', dataIndex: 'table_name', key: 'table_name' },
    {
      title: '模式',
      dataIndex: 'mode',
      key: 'mode',
      render: (mode: string) => (
        <Tag color={mode === 'CDC' ? 'blue' : 'purple'}>{mode}</Tag>
      ),
    },
    {
      title: '最後同步',
      dataIndex: 'last_sync',
      key: 'last_sync',
    },
    {
      title: '延遲 (秒)',
      dataIndex: 'lag_seconds',
      key: 'lag_seconds',
      render: (val: number) => (
        <span style={{ color: val > 60 ? '#ff4d4f' : val > 30 ? '#faad14' : undefined }}>
          {val}
        </span>
      ),
    },
    {
      title: '健康狀態',
      dataIndex: 'health',
      key: 'health',
      render: (health: string) => {
        const cfg = healthConfig[health] || { status: 'default' as const, label: health };
        return <Badge status={cfg.status} text={cfg.label} />;
      },
    },
  ];

  return (
    <div>
      <Title level={4}>同步監控儀表板</Title>

      {overviewLoading ? (
        <Spin />
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={4}>
            <Card>
              <Statistic
                title="總設定數"
                value={overview?.total_configs ?? 0}
                prefix={<SyncOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={5}>
            <Card>
              <Statistic
                title="啟用中"
                value={overview?.active ?? 0}
                valueStyle={{ color: '#1890ff' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={5}>
            <Card>
              <Statistic
                title="正常"
                value={overview?.healthy ?? 0}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={5}>
            <Card>
              <Statistic
                title="延遲"
                value={overview?.lagging ?? 0}
                valueStyle={{ color: '#faad14' }}
                prefix={<WarningOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={5}>
            <Card>
              <Statistic
                title="失敗"
                value={overview?.failed ?? 0}
                valueStyle={{ color: (overview?.failed ?? 0) > 0 ? '#cf1322' : undefined }}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Card title="同步詳細狀態">
        <Table<SyncDetail>
          rowKey="id"
          columns={columns}
          dataSource={sortedDetails}
          loading={detailsLoading}
          pagination={{ pageSize: 20 }}
          size="middle"
        />
      </Card>
    </div>
  );
};

export default SyncDashboard;
