import React, { useEffect } from 'react';
import { Drawer, Form, Input, InputNumber, Button, Space, message } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createCombo, Combo, ComboCreate } from '../../api/combos';

interface ComboFormProps {
  open: boolean;
  onClose: () => void;
  editingCombo?: Combo | null;
}

const ComboForm: React.FC<ComboFormProps> = ({ open, onClose, editingCombo }) => {
  const [form] = Form.useForm();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: ComboCreate) => createCombo(values),
    onSuccess: () => {
      message.success(editingCombo ? '組合已更新' : '組合已建立');
      queryClient.invalidateQueries({ queryKey: ['combos'] });
      form.resetFields();
      onClose();
    },
    onError: () => {
      message.error('操作失敗，請稍後再試');
    },
  });

  useEffect(() => {
    if (open && editingCombo) {
      form.setFieldsValue({
        controller_model: editingCombo.controller_model,
        flash_model: editingCombo.flash_model,
        target_ratio: editingCombo.target_ratio,
      });
    } else if (open) {
      form.resetFields();
    }
  }, [open, editingCombo, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      mutation.mutate(values);
    } catch {
      // validation errors shown by form
    }
  };

  return (
    <Drawer
      title={editingCombo ? '編輯主力組合' : '新增主力組合'}
      open={open}
      onClose={onClose}
      width={480}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={handleSubmit} loading={mutation.isPending}>
            {editingCombo ? '更新' : '建立'}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="controller_model"
          label="控制器型號"
          rules={[{ required: true, message: '請輸入控制器型號' }]}
        >
          <Input placeholder="例如: PS5021-E21" />
        </Form.Item>
        <Form.Item
          name="flash_model"
          label="Flash 型號"
          rules={[{ required: true, message: '請輸入 Flash 型號' }]}
        >
          <Input placeholder="例如: B47R-TLC-512G" />
        </Form.Item>
        <Form.Item
          name="target_ratio"
          label="目標比例 (%)"
          rules={[
            { required: true, message: '請輸入目標比例' },
            {
              type: 'number',
              min: 0,
              max: 100,
              message: '比例必須在 0-100 之間',
            },
          ]}
        >
          <InputNumber
            min={0}
            max={100}
            addonAfter="%"
            style={{ width: '100%' }}
            placeholder="輸入 0-100"
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
};

export default ComboForm;
