import React, { useEffect } from 'react';
import { Drawer, Form, Input, InputNumber, Select, Button, Space, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createConnection, updateConnection, getSupportedTypes } from '../../api/connections';
import { DataSource, DataSourceCreate } from '../../api/types';

interface ConnectionFormProps {
  open: boolean;
  editingRecord: DataSource | null;
  onClose: () => void;
}

const defaultPorts: Record<string, number> = {
  oracle: 1521,
  postgresql: 5432,
  mysql: 3306,
  mssql: 1433,
};

const ConnectionForm: React.FC<ConnectionFormProps> = ({ open, editingRecord, onClose }) => {
  const [form] = Form.useForm();
  const queryClient = useQueryClient();
  const isEditing = !!editingRecord;

  const { data: supportedTypes } = useQuery({
    queryKey: ['supported-types'],
    queryFn: getSupportedTypes,
  });

  useEffect(() => {
    if (open) {
      if (editingRecord) {
        form.setFieldsValue({
          name: editingRecord.name,
          db_type: editingRecord.db_type,
          host: editingRecord.host,
          port: editingRecord.port,
          database_name: editingRecord.database_name,
          username: editingRecord.username,
          password: '',
        });
      } else {
        form.resetFields();
      }
    }
  }, [open, editingRecord, form]);

  const createMutation = useMutation({
    mutationFn: (data: DataSourceCreate) => createConnection(data),
    onSuccess: () => {
      message.success('連線建立成功');
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
    onError: () => {
      message.error('建立連線失敗');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: DataSourceCreate) => updateConnection(editingRecord!.id, data),
    onSuccess: () => {
      message.success('連線更新成功');
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
    onError: () => {
      message.error('更新連線失敗');
    },
  });

  const handleDbTypeChange = (value: string) => {
    const port = defaultPorts[value];
    if (port) {
      form.setFieldValue('port', port);
    }
  };

  const onFinish = (values: DataSourceCreate) => {
    if (isEditing) {
      updateMutation.mutate(values);
    } else {
      createMutation.mutate(values);
    }
  };

  const typeOptions = supportedTypes?.map((t) => ({
    value: t.value,
    label: t.label,
  })) || [
    { value: 'oracle', label: 'Oracle' },
    { value: 'postgresql', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' },
    { value: 'mssql', label: 'SQL Server' },
  ];

  return (
    <Drawer
      title={isEditing ? '編輯連線' : '新增連線'}
      open={open}
      onClose={onClose}
      width={480}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            onClick={() => form.submit()}
            loading={createMutation.isPending || updateMutation.isPending}
          >
            {isEditing ? '更新' : '建立'}
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={onFinish}
        initialValues={{ port: 5432 }}
      >
        <Form.Item
          name="name"
          label="連線名稱"
          rules={[{ required: true, message: '請輸入連線名稱' }]}
        >
          <Input placeholder="例如：MRP 正式環境" />
        </Form.Item>

        <Form.Item
          name="db_type"
          label="資料庫類型"
          rules={[{ required: true, message: '請選擇資料庫類型' }]}
        >
          <Select
            placeholder="請選擇"
            options={typeOptions}
            onChange={handleDbTypeChange}
          />
        </Form.Item>

        <Form.Item
          name="host"
          label="主機位址"
          rules={[{ required: true, message: '請輸入主機位址' }]}
        >
          <Input placeholder="例如：192.168.1.100" />
        </Form.Item>

        <Form.Item
          name="port"
          label="連接埠"
          rules={[{ required: true, message: '請輸入連接埠' }]}
        >
          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          name="database_name"
          label="資料庫名稱"
          rules={[{ required: true, message: '請輸入資料庫名稱' }]}
        >
          <Input placeholder="例如：MRP_DB" />
        </Form.Item>

        <Form.Item
          name="username"
          label="使用者名稱"
          rules={[{ required: true, message: '請輸入使用者名稱' }]}
        >
          <Input placeholder="資料庫帳號" />
        </Form.Item>

        <Form.Item
          name="password"
          label="密碼"
          rules={isEditing ? [] : [{ required: true, message: '請輸入密碼' }]}
        >
          <Input.Password placeholder={isEditing ? '留空表示不修改' : '資料庫密碼'} />
        </Form.Item>
      </Form>
    </Drawer>
  );
};

export default ConnectionForm;
