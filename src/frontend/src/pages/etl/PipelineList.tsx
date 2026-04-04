import React, { useState } from 'react';
import {
  Table, Button, Tag, Space, Drawer, Form, Input, Select, InputNumber,
  message, Popconfirm, Typography, Card, Spin,
} from 'antd';
import {
  PlusOutlined, PlayCircleOutlined, ReloadOutlined, SyncOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listPipelines, createPipeline, updatePipeline, deletePipeline, runPipeline,
  EtlPipeline,
} from '../../api/etl';

const { Title } = Typography;

const PipelineList: React.FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<EtlPipeline | null>(null);
  const [form] = Form.useForm();
  const queryClient = useQueryClient();

  const { data: pipelines = [], isLoading } = useQuery({
    queryKey: ['etl-pipelines'],
    queryFn: listPipelines,
  });

  const createMutation = useMutation({
    mutationFn: createPipeline,
    onSuccess: () => {
      message.success('Pipeline 建立成功');
      queryClient.invalidateQueries({ queryKey: ['etl-pipelines'] });
      setDrawerOpen(false);
      form.resetFields();
    },
    onError: () => message.error('建立失敗'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EtlPipeline> }) =>
      updatePipeline(id, data),
    onSuccess: () => {
      message.success('Pipeline 更新成功');
      queryClient.invalidateQueries({ queryKey: ['etl-pipelines'] });
      setDrawerOpen(false);
      form.resetFields();
      setEditingPipeline(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePipeline,
    onSuccess: () => {
      message.success('Pipeline 已停用');
      queryClient.invalidateQueries({ queryKey: ['etl-pipelines'] });
    },
  });

  const runMutation = useMutation({
    mutationFn: runPipeline,
    onSuccess: (result: any) => {
      if (result.status === 'success') {
        message.success(`執行完成，共 ${result.rows ?? 0} 筆資料`);
      } else {
        message.warning(`執行結果: ${result.status}`);
      }
      queryClient.invalidateQueries({ queryKey: ['etl-pipelines'] });
    },
    onError: () => message.error('執行失敗'),
  });

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const payload = {
      name: values.name,
      source_datasource_id: values.source_datasource_id,
      source_table: values.source_table,
      target_table: values.target_table,
      transform_config: values.select_columns
        ? { select_columns: values.select_columns.split(',').map((s: string) => s.trim()) }
        : undefined,
      cron_expression: values.cron_expression || undefined,
    };
    if (editingPipeline) {
      updateMutation.mutate({ id: editingPipeline.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const openEdit = (pipeline: EtlPipeline) => {
    setEditingPipeline(pipeline);
    form.setFieldsValue({
      name: pipeline.name,
      source_datasource_id: pipeline.source_datasource_id,
      source_table: pipeline.source_table,
      target_table: pipeline.target_table,
      select_columns: pipeline.transform_config?.select_columns?.join(', ') || '',
      cron_expression: pipeline.cron_expression || '',
    });
    setDrawerOpen(true);
  };

  const statusTag = (status?: string) => {
    if (!status) return <Tag>--</Tag>;
    switch (status) {
      case 'running':
        return <Tag icon={<SyncOutlined spin />} color="processing">執行中</Tag>;
      case 'success':
        return <Tag icon={<CheckCircleOutlined />} color="success">成功</Tag>;
      case 'failed':
        return <Tag icon={<CloseCircleOutlined />} color="error">失敗</Tag>;
      default:
        return <Tag>{status}</Tag>;
    }
  };

  const columns = [
    { title: '名稱', dataIndex: 'name', key: 'name' },
    {
      title: '來源 / 目標',
      key: 'tables',
      render: (_: any, r: EtlPipeline) => `${r.source_table} -> ${r.target_table}`,
    },
    { title: '排程', dataIndex: 'cron_expression', key: 'cron', render: (v: string) => v || '--' },
    {
      title: '最近執行',
      key: 'last_run',
      render: (_: any, r: EtlPipeline) => (
        <Space>
          {statusTag(r.last_run_status)}
          {r.last_run_duration_ms != null && <span>{r.last_run_duration_ms}ms</span>}
          {r.last_run_rows != null && <span>{r.last_run_rows} 筆</span>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, r: EtlPipeline) => (
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={() => runMutation.mutate(r.id)}
            loading={runMutation.isPending}
          >
            立即執行
          </Button>
          <Button size="small" onClick={() => openEdit(r)}>編輯</Button>
          <Popconfirm title="確定停用此 Pipeline？" onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger>停用</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>ETL Pipeline 管理</Title>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => queryClient.invalidateQueries({ queryKey: ['etl-pipelines'] })}
            >
              重新整理
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingPipeline(null);
                form.resetFields();
                setDrawerOpen(true);
              }}
            >
              新增 Pipeline
            </Button>
          </Space>
        </div>
        <Table
          dataSource={pipelines}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Drawer
        title={editingPipeline ? '編輯 Pipeline' : '新增 Pipeline'}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingPipeline(null); }}
        width={480}
        extra={
          <Button type="primary" onClick={handleSubmit} loading={createMutation.isPending || updateMutation.isPending}>
            {editingPipeline ? '更新' : '建立'}
          </Button>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Pipeline 名稱" rules={[{ required: true }]}>
            <Input placeholder="例如：庫存同步 Pipeline" />
          </Form.Item>
          <Form.Item name="source_datasource_id" label="資料來源 ID" rules={[{ required: true }]}>
            <Input placeholder="Data Source UUID" />
          </Form.Item>
          <Form.Item name="source_table" label="來源資料表" rules={[{ required: true }]}>
            <Input placeholder="例如：ina_file" />
          </Form.Item>
          <Form.Item name="target_table" label="目標資料表" rules={[{ required: true }]}>
            <Input placeholder="例如：inventory_records" />
          </Form.Item>
          <Form.Item name="select_columns" label="選取欄位 (逗號分隔)">
            <Input placeholder="col1, col2, col3" />
          </Form.Item>
          <Form.Item name="cron_expression" label="排程 (Cron 表達式)">
            <Input placeholder="0 */2 * * * (每兩小時)" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

export default PipelineList;
