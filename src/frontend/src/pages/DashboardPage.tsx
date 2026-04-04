import React from 'react';
import { Card, Col, Row, Typography, Statistic, Button, Space } from 'antd';
import {
  DatabaseOutlined,
  TableOutlined,
  LinkOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { listConnections } from '../api/connections';

const { Title, Paragraph } = Typography;

const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: connections } = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections,
  });

  const activeCount = connections?.filter((c) => c.is_active).length || 0;
  const totalCount = connections?.length || 0;

  return (
    <div>
      <Title level={3}>
        歡迎回來, {user?.display_name || user?.ad_username}
      </Title>
      <Paragraph type="secondary">
        MRP 資料整合平台 - 群聯電子
      </Paragraph>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="資料庫連線總數"
              value={totalCount}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="啟用中連線"
              value={activeCount}
              prefix={<LinkOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="停用連線"
              value={totalCount - activeCount}
              prefix={<DatabaseOutlined />}
              valueStyle={{ color: totalCount - activeCount > 0 ? '#ff4d4f' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} sm={12}>
          <Card title="資料庫連線管理" extra={<TableOutlined />}>
            <Paragraph>管理所有資料庫連線，新增、編輯、測試連線狀態。</Paragraph>
            <Space>
              <Button
                type="primary"
                icon={<ArrowRightOutlined />}
                onClick={() => navigate('/connections')}
              >
                前往管理
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card title="結構瀏覽器" extra={<TableOutlined />}>
            <Paragraph>瀏覽資料庫結構，查看資料表、欄位、函式等資訊。</Paragraph>
            <Space>
              <Button
                type="primary"
                icon={<ArrowRightOutlined />}
                onClick={() => navigate('/schema')}
              >
                開始瀏覽
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default DashboardPage;
