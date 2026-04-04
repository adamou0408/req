import React, { useState } from 'react';
import {
  Input, Table, Tag, Typography, Card, Row, Col, Collapse, Spin, Empty,
} from 'antd';
import { SearchOutlined, ScheduleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { searchInventory, getProductSchedule, InventoryItem } from '../../api/inventory';
import ActiveCombos from './ActiveCombos';

const { Title, Text } = Typography;

const statusColorMap: Record<string, string> = {
  sufficient: 'green',
  low: 'gold',
  critical: 'red',
};

const statusLabelMap: Record<string, string> = {
  sufficient: '充足',
  low: '偏低',
  critical: '不足',
};

const InventorySearch: React.FC = () => {
  const [searchText, setSearchText] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const { data: items = [], isLoading, isFetching } = useQuery({
    queryKey: ['inventory', searchText],
    queryFn: () => searchInventory({ query: searchText }),
    enabled: searchText.length > 0,
    staleTime: 10000,
  });

  const { data: schedule, isLoading: scheduleLoading } = useQuery({
    queryKey: ['productSchedule', selectedModel],
    queryFn: () => getProductSchedule(selectedModel!),
    enabled: !!selectedModel,
  });

  const columns = [
    {
      title: '產品型號',
      dataIndex: 'product_model',
      key: 'product_model',
      render: (val: string) => <Text strong>{val}</Text>,
    },
    {
      title: '倉庫',
      dataIndex: 'warehouse',
      key: 'warehouse',
    },
    {
      title: '庫存數量',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (val: number, record: InventoryItem) => (
        <Text style={{ color: statusColorMap[record.status] === 'red' ? '#ff4d4f' : undefined }}>
          {val.toLocaleString()}
        </Text>
      ),
    },
    {
      title: '在途數量',
      dataIndex: 'in_transit',
      key: 'in_transit',
      render: (val: number) => val.toLocaleString(),
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={statusColorMap[status] || 'default'}>
          {statusLabelMap[status] || status}
        </Tag>
      ),
    },
    {
      title: '最後更新',
      dataIndex: 'last_updated',
      key: 'last_updated',
      responsive: ['md' as const],
    },
    {
      title: '',
      key: 'schedule',
      render: (_: unknown, record: InventoryItem) => (
        <a onClick={() => setSelectedModel(record.product_model)}>
          <ScheduleOutlined /> 查看生產排程
        </a>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={18}>
          <Title level={4}>庫存查詢</Title>
          <Input
            size="large"
            placeholder="輸入產品型號或料號搜尋..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              setSelectedModel(null);
            }}
            allowClear
            style={{ marginBottom: 16, fontSize: 16 }}
          />

          {searchText.length === 0 ? (
            <Card>
              <Empty description="請輸入關鍵字開始搜尋" />
            </Card>
          ) : (
            <Table
              rowKey="id"
              columns={columns}
              dataSource={items}
              loading={isLoading || isFetching}
              pagination={{ pageSize: 10, simple: true }}
              scroll={{ x: 600 }}
              size="middle"
            />
          )}

          {selectedModel && (
            <Card
              title={`${selectedModel} 生產排程`}
              style={{ marginTop: 16 }}
              extra={<a onClick={() => setSelectedModel(null)}>關閉</a>}
            >
              {scheduleLoading ? (
                <Spin />
              ) : schedule?.schedules && schedule.schedules.length > 0 ? (
                <Collapse
                  items={schedule.schedules.map((s, i) => ({
                    key: i,
                    label: `${s.period} - ${s.status}`,
                    children: (
                      <div>
                        <p>計畫數量: {s.planned_qty.toLocaleString()}</p>
                        <p>確認數量: {s.confirmed_qty.toLocaleString()}</p>
                        <Tag>{s.status}</Tag>
                      </div>
                    ),
                  }))}
                />
              ) : (
                <Text type="secondary">無排程資料</Text>
              )}
            </Card>
          )}
        </Col>
        <Col xs={24} lg={6}>
          <div style={{ marginTop: 40 }}>
            <ActiveCombos />
          </div>
        </Col>
      </Row>
    </div>
  );
};

export default InventorySearch;
