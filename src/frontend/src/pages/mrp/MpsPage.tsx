import React, { useState } from 'react';
import {
  Button, Card, Table, Tag, Typography, Space, message, InputNumber,
  Row, Col, Spin, Progress,
} from 'antd';
import { ScheduleOutlined, BarChartOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMps, generateMps, runCrp, MpsEntry, Bottleneck } from '../../api/mrp';
import apiClient from '../../api/client';

const { Title, Text } = Typography;

const statusConfig: Record<string, { color: string; label: string }> = {
  planned: { color: 'blue', label: '已計畫' },
  confirmed: { color: 'green', label: '已確認' },
  in_progress: { color: 'orange', label: '進行中' },
  completed: { color: 'default', label: '已完成' },
};

const MpsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<number>(0);
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[]>([]);
  const [crpLoaded, setCrpLoaded] = useState(false);

  const { data: mpsEntries = [], isLoading } = useQuery({
    queryKey: ['mps'],
    queryFn: () => getMps(),
  });

  const generateMutation = useMutation({
    mutationFn: generateMps,
    onSuccess: () => {
      message.success('排程已產生');
      queryClient.invalidateQueries({ queryKey: ['mps'] });
    },
    onError: () => {
      message.error('排程產生失敗');
    },
  });

  const crpMutation = useMutation({
    mutationFn: runCrp,
    onSuccess: (result) => {
      setBottlenecks(result.bottlenecks);
      setCrpLoaded(true);
      message.success('產能分析完成');
    },
    onError: () => {
      message.error('產能分析失敗');
    },
  });

  const handleSaveConfirmedQty = async (id: string) => {
    try {
      await apiClient.patch(`/api/mrp/mps/${id}`, { confirmed_qty: editingValue });
      message.success('已更新確認數量');
      queryClient.invalidateQueries({ queryKey: ['mps'] });
      setEditingKey(null);
    } catch {
      message.error('更新失敗');
    }
  };

  const columns = [
    { title: '產品型號', dataIndex: 'product_model', key: 'product_model' },
    { title: '期間', dataIndex: 'period', key: 'period' },
    {
      title: '計畫數量',
      dataIndex: 'planned_qty',
      key: 'planned_qty',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '確認數量',
      dataIndex: 'confirmed_qty',
      key: 'confirmed_qty',
      render: (val: number, record: MpsEntry) => {
        if (editingKey === record.id) {
          return (
            <Space>
              <InputNumber
                size="small"
                value={editingValue}
                onChange={(v) => setEditingValue(v ?? 0)}
                min={0}
              />
              <Button size="small" type="link" onClick={() => handleSaveConfirmedQty(record.id)}>
                儲存
              </Button>
              <Button size="small" type="link" onClick={() => setEditingKey(null)}>
                取消
              </Button>
            </Space>
          );
        }
        return (
          <a
            onClick={() => {
              setEditingKey(record.id);
              setEditingValue(val);
            }}
          >
            {val.toLocaleString()}
          </a>
        );
      },
    },
    { title: '組合', dataIndex: 'combo', key: 'combo' },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const cfg = statusConfig[status] || { color: 'default', label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
  ];

  const bottleneckStatusColor: Record<string, string> = {
    normal: '#52c41a',
    warning: '#faad14',
    overloaded: '#ff4d4f',
  };

  const barChartOption = {
    tooltip: { trigger: 'axis' as const },
    xAxis: {
      type: 'category' as const,
      data: bottlenecks.map((b) => b.work_center),
      axisLabel: { rotate: 30 },
    },
    yAxis: {
      type: 'value' as const,
      max: 100,
      axisLabel: { formatter: '{value}%' },
    },
    series: [
      {
        name: '產能利用率',
        type: 'bar',
        data: bottlenecks.map((b) => ({
          value: Math.round(b.utilization * 100),
          itemStyle: { color: bottleneckStatusColor[b.status] || '#1890ff' },
        })),
        markLine: {
          data: [{ yAxis: 85, name: '警戒線', lineStyle: { color: '#ff4d4f', type: 'dashed' as const } }],
        },
      },
    ],
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>生產排程 (MPS)</Title>
        <Button
          type="primary"
          icon={<ScheduleOutlined />}
          onClick={() => generateMutation.mutate()}
          loading={generateMutation.isPending}
        >
          產生排程
        </Button>
      </div>

      <Card style={{ marginBottom: 24 }}>
        <Table<MpsEntry>
          rowKey="id"
          columns={columns}
          dataSource={mpsEntries}
          loading={isLoading}
          pagination={{ pageSize: 10 }}
          size="middle"
        />
      </Card>

      <Card
        title="產能需求規劃 (CRP)"
        extra={
          <Button
            icon={<BarChartOutlined />}
            onClick={() => crpMutation.mutate()}
            loading={crpMutation.isPending}
          >
            分析產能
          </Button>
        }
      >
        {crpMutation.isPending ? (
          <Spin />
        ) : !crpLoaded ? (
          <Text type="secondary">點擊「分析產能」查看產能利用狀況</Text>
        ) : (
          <>
            <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
              {bottlenecks
                .filter((b) => b.status !== 'normal')
                .map((b) => (
                  <Col xs={24} sm={12} md={8} key={b.work_center}>
                    <Card size="small">
                      <Text strong>{b.work_center}</Text>
                      <Progress
                        percent={Math.round(b.utilization * 100)}
                        status={b.status === 'overloaded' ? 'exception' : undefined}
                        strokeColor={bottleneckStatusColor[b.status]}
                      />
                      <Text type="secondary">
                        負載: {b.load.toLocaleString()} / 產能: {b.capacity.toLocaleString()}
                      </Text>
                    </Card>
                  </Col>
                ))}
            </Row>
            {bottlenecks.length > 0 && (
              <ReactECharts option={barChartOption} style={{ height: 350 }} />
            )}
          </>
        )}
      </Card>
    </div>
  );
};

export default MpsPage;
