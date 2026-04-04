import React, { useState } from 'react';
import {
  Table, Tag, Button, Space, Tabs, Popconfirm, message, Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCombos,
  submitForApproval,
  approveCombo,
  rejectCombo,
  publishCombo,
  archiveCombo,
  Combo,
} from '../../api/combos';
import ComboForm from './ComboForm';

const { Title } = Typography;

const statusConfig: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  pending_approval: { color: 'orange', label: '待審核' },
  active: { color: 'green', label: '啟用中' },
  archived: { color: 'default', label: '已封存' },
};

const ComboList: React.FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const queryClient = useQueryClient();

  const { data: combos = [], isLoading } = useQuery({
    queryKey: ['combos'],
    queryFn: listCombos,
  });

  const createAction = (fn: (id: string) => Promise<Combo>, successMsg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      message.success(successMsg);
      queryClient.invalidateQueries({ queryKey: ['combos'] });
    },
    onError: () => {
      message.error('操作失敗');
    },
  });

  const submitMutation = useMutation(createAction(submitForApproval, '已送出審核'));
  const approveMutation = useMutation(createAction(approveCombo, '已核准'));
  const rejectMutation = useMutation(createAction(rejectCombo, '已退回'));
  const publishMutation = useMutation(createAction(publishCombo, '已發佈'));
  const archiveMutation = useMutation(createAction(archiveCombo, '已封存'));

  const filteredCombos = statusFilter === 'all'
    ? combos
    : combos.filter((c) => c.status === statusFilter);

  const columns = [
    {
      title: '控制器型號',
      dataIndex: 'controller_model',
      key: 'controller_model',
    },
    {
      title: 'Flash 型號',
      dataIndex: 'flash_model',
      key: 'flash_model',
    },
    {
      title: '目標比例 (%)',
      dataIndex: 'target_ratio',
      key: 'target_ratio',
      render: (val: number) => `${val}%`,
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const cfg = statusConfig[status] || { color: 'default', label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: Combo) => {
        const actions: React.ReactNode[] = [];
        if (record.status === 'draft') {
          actions.push(
            <Button
              key="submit"
              size="small"
              type="link"
              onClick={() => submitMutation.mutate(record.id)}
            >
              送審
            </Button>
          );
        }
        if (record.status === 'pending_approval') {
          actions.push(
            <Popconfirm
              key="approve"
              title="確認核准此組合？"
              onConfirm={() => approveMutation.mutate(record.id)}
            >
              <Button size="small" type="link" style={{ color: '#52c41a' }}>
                核准
              </Button>
            </Popconfirm>,
            <Popconfirm
              key="reject"
              title="確認退回此組合？"
              onConfirm={() => rejectMutation.mutate(record.id)}
            >
              <Button size="small" type="link" danger>
                退回
              </Button>
            </Popconfirm>
          );
        }
        if (record.status === 'active') {
          actions.push(
            <Button
              key="publish"
              size="small"
              type="link"
              onClick={() => publishMutation.mutate(record.id)}
            >
              發佈
            </Button>,
            <Popconfirm
              key="archive"
              title="確認封存此組合？"
              onConfirm={() => archiveMutation.mutate(record.id)}
            >
              <Button size="small" type="link" danger>
                封存
              </Button>
            </Popconfirm>
          );
        }
        return <Space>{actions}</Space>;
      },
    },
  ];

  const tabItems = [
    { key: 'all', label: '全部' },
    { key: 'draft', label: '草稿' },
    { key: 'pending_approval', label: '待審核' },
    { key: 'active', label: '啟用中' },
    { key: 'archived', label: '已封存' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>主力組合管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
          新增主力組合
        </Button>
      </div>
      <Tabs
        activeKey={statusFilter}
        onChange={setStatusFilter}
        items={tabItems}
      />
      <Table
        rowKey="id"
        columns={columns}
        dataSource={filteredCombos}
        loading={isLoading}
        pagination={{ pageSize: 10 }}
      />
      <ComboForm
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
};

export default ComboList;
