import React, { useState } from 'react';
import {
  Card, Table, Button, Tag, Space, Typography, Radio, message,
} from 'antd';
import {
  PlusOutlined, LineChartOutlined, BarChartOutlined, PieChartOutlined,
  AreaChartOutlined, DotChartOutlined, TableOutlined, EditOutlined,
  DeleteOutlined, CheckCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listReports, deleteReport, approveReportShare, BiReport } from '../../api/etl';

const { Title } = Typography;

const chartIcons: Record<string, React.ReactNode> = {
  line: <LineChartOutlined />,
  bar: <BarChartOutlined />,
  pie: <PieChartOutlined />,
  area: <AreaChartOutlined />,
  scatter: <DotChartOutlined />,
  table: <TableOutlined />,
};

const ReportList: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'mine' | 'shared'>('all');

  const { data: reports = [], isLoading } = useQuery({
    queryKey: ['bi-reports'],
    queryFn: listReports,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteReport,
    onSuccess: () => {
      message.success('報表已刪除');
      queryClient.invalidateQueries({ queryKey: ['bi-reports'] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: approveReportShare,
    onSuccess: () => {
      message.success('已核准分享');
      queryClient.invalidateQueries({ queryKey: ['bi-reports'] });
    },
  });

  const filtered = reports.filter((r) => {
    if (filter === 'shared') return r.is_shared;
    return true;
  });

  const shareStatus = (r: BiReport) => {
    if (!r.is_shared) return null;
    if (r.share_approved) {
      return <Tag icon={<CheckCircleOutlined />} color="success">已核准</Tag>;
    }
    return <Tag icon={<ClockCircleOutlined />} color="warning">待核准</Tag>;
  };

  const columns = [
    {
      title: '圖表',
      dataIndex: 'chart_type',
      key: 'chart_type',
      width: 60,
      render: (t: string) => <span style={{ fontSize: 20 }}>{chartIcons[t] || t}</span>,
    },
    { title: '名稱', dataIndex: 'name', key: 'name' },
    { title: '資料表', dataIndex: 'source_table', key: 'source_table' },
    {
      title: '分享狀態',
      key: 'share',
      render: (_: any, r: BiReport) => shareStatus(r),
    },
    {
      title: '更新時間',
      dataIndex: 'updated_at',
      key: 'updated_at',
      render: (v: string) => v ? new Date(v).toLocaleString('zh-TW') : '--',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, r: BiReport) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/bi/reports/${r.id}`)}>
            編輯
          </Button>
          {r.is_shared && !r.share_approved && (
            <Button size="small" type="primary" onClick={() => approveMutation.mutate(r.id)}>
              核准
            </Button>
          )}
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteMutation.mutate(r.id)}>
            刪除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>BI 報表列表</Title>
        <Space>
          <Radio.Group value={filter} onChange={(e) => setFilter(e.target.value)}>
            <Radio.Button value="all">全部</Radio.Button>
            <Radio.Button value="mine">我的報表</Radio.Button>
            <Radio.Button value="shared">已分享</Radio.Button>
          </Radio.Group>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/bi/reports/new')}>
            新增報表
          </Button>
        </Space>
      </div>
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 10 }}
      />
    </Card>
  );
};

export default ReportList;
