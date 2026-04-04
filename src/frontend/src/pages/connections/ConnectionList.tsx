import React, { useState } from 'react';
import { Table, Button, Tag, Space, Popconfirm, message, Typography } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listConnections, deleteConnection } from '../../api/connections';
import { DataSource } from '../../api/types';
import ConnectionForm from './ConnectionForm';
import ConnectionTest from './ConnectionTest';

const { Title } = Typography;

const ConnectionList: React.FC = () => {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DataSource | null>(null);
  const [testingRecord, setTestingRecord] = useState<DataSource | null>(null);

  const { data: connections, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => {
      message.success('已刪除連線');
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: () => {
      message.error('刪除失敗');
    },
  });

  const handleEdit = (record: DataSource) => {
    setEditingRecord(record);
    setFormOpen(true);
  };

  const handleAdd = () => {
    setEditingRecord(null);
    setFormOpen(true);
  };

  const columns = [
    {
      title: '名稱',
      dataIndex: 'name',
      key: 'name',
      sorter: (a: DataSource, b: DataSource) => a.name.localeCompare(b.name),
    },
    {
      title: '類型',
      dataIndex: 'db_type',
      key: 'db_type',
      filters: [
        { text: 'Oracle', value: 'oracle' },
        { text: 'PostgreSQL', value: 'postgresql' },
        { text: 'MySQL', value: 'mysql' },
        { text: 'SQL Server', value: 'mssql' },
      ],
      onFilter: (value: React.Key | boolean, record: DataSource) => record.db_type === value,
      render: (type: string) => <Tag color="blue">{type.toUpperCase()}</Tag>,
    },
    {
      title: '主機',
      dataIndex: 'host',
      key: 'host',
    },
    {
      title: '連接埠',
      dataIndex: 'port',
      key: 'port',
    },
    {
      title: '資料庫',
      dataIndex: 'database_name',
      key: 'database_name',
    },
    {
      title: '狀態',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (active: boolean) =>
        active ? <Tag color="success">啟用</Tag> : <Tag color="error">停用</Tag>,
      filters: [
        { text: '啟用', value: true },
        { text: '停用', value: false },
      ],
      onFilter: (value: React.Key | boolean, record: DataSource) => record.is_active === value,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: DataSource) => (
        <Space>
          <Button
            type="link"
            icon={<ApiOutlined />}
            onClick={() => setTestingRecord(record)}
          >
            測試
          </Button>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            編輯
          </Button>
          <Popconfirm
            title="確認刪除"
            description={`確定要刪除連線「${record.name}」嗎？`}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="確認"
            cancelText="取消"
          >
            <Button type="link" danger icon={<DeleteOutlined />}>
              刪除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>資料庫連線管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新增連線
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={connections}
        loading={isLoading}
        rowKey="id"
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 筆` }}
      />

      <ConnectionForm
        open={formOpen}
        editingRecord={editingRecord}
        onClose={() => {
          setFormOpen(false);
          setEditingRecord(null);
        }}
      />

      <ConnectionTest
        record={testingRecord}
        onClose={() => setTestingRecord(null)}
      />
    </div>
  );
};

export default ConnectionList;
