import React, { useState } from 'react';
import {
  Card, Row, Col, Button, Tag, Space, Typography, Radio, message, Empty,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, DeleteOutlined,
  CheckCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listDashboards, deleteDashboard, approveDashboardShare, BiDashboard } from '../../api/etl';

const { Title, Text, Paragraph } = Typography;

const DashboardList: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'mine' | 'shared'>('all');

  const { data: dashboards = [], isLoading } = useQuery({
    queryKey: ['bi-dashboards'],
    queryFn: listDashboards,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDashboard,
    onSuccess: () => {
      message.success('儀表板已刪除');
      queryClient.invalidateQueries({ queryKey: ['bi-dashboards'] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: approveDashboardShare,
    onSuccess: () => {
      message.success('已核准分享');
      queryClient.invalidateQueries({ queryKey: ['bi-dashboards'] });
    },
  });

  const filtered = dashboards.filter((d) => {
    if (filter === 'shared') return d.is_shared;
    return true;
  });

  const shareStatus = (d: BiDashboard) => {
    if (!d.is_shared) return null;
    if (d.share_approved) {
      return <Tag icon={<CheckCircleOutlined />} color="success">已核准</Tag>;
    }
    return <Tag icon={<ClockCircleOutlined />} color="warning">待核准</Tag>;
  };

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>自訂儀表板</Title>
          <Space>
            <Radio.Group value={filter} onChange={(e) => setFilter(e.target.value)}>
              <Radio.Button value="all">全部</Radio.Button>
              <Radio.Button value="mine">我的</Radio.Button>
              <Radio.Button value="shared">已分享</Radio.Button>
            </Radio.Group>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/bi/dashboards/new')}>
              新增 Dashboard
            </Button>
          </Space>
        </div>

        {filtered.length === 0 ? (
          <Empty description="尚無儀表板" />
        ) : (
          <Row gutter={[16, 16]}>
            {filtered.map((d) => (
              <Col key={d.id} xs={24} sm={12} lg={8}>
                <Card
                  hoverable
                  actions={[
                    <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/bi/dashboards/${d.id}`)}>
                      開啟
                    </Button>,
                    <Button type="link" icon={<EditOutlined />} onClick={() => navigate(`/bi/dashboards/${d.id}`)}>
                      編輯
                    </Button>,
                    <Button type="link" danger icon={<DeleteOutlined />} onClick={() => deleteMutation.mutate(d.id)}>
                      刪除
                    </Button>,
                  ]}
                >
                  <Card.Meta
                    title={
                      <Space>
                        {d.name}
                        {shareStatus(d)}
                      </Space>
                    }
                    description={
                      <div>
                        {d.description && <Paragraph ellipsis={{ rows: 2 }}>{d.description}</Paragraph>}
                        <Space>
                          <Text type="secondary">報表數: {d.layout?.length || 0}</Text>
                          <Text type="secondary">
                            更新: {d.updated_at ? new Date(d.updated_at).toLocaleDateString('zh-TW') : '--'}
                          </Text>
                        </Space>
                        {d.is_shared && !d.share_approved && (
                          <div style={{ marginTop: 8 }}>
                            <Button size="small" type="primary" onClick={(e) => {
                              e.stopPropagation();
                              approveMutation.mutate(d.id);
                            }}>
                              核准分享
                            </Button>
                          </div>
                        )}
                      </div>
                    }
                  />
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>
    </div>
  );
};

export default DashboardList;
