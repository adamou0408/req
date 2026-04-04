import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, message, Space } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const { Title, Text } = Typography;

const LoginPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success('登入成功');
      navigate('/dashboard');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { detail?: string } } };
      message.error(err.response?.data?.detail || '登入失敗，請檢查帳號密碼');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card
        style={{
          width: 400,
          maxWidth: '90vw',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%', textAlign: 'center' }}>
          <Title level={3} style={{ marginBottom: 0 }}>
            群聯電子 MRP 資料整合平台
          </Title>
          <Text type="secondary">請使用公司 AD 帳號登入</Text>
        </Space>

        <Form
          name="login"
          onFinish={onFinish}
          autoComplete="off"
          layout="vertical"
          style={{ marginTop: 32 }}
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: '請輸入帳號' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="AD 帳號"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '請輸入密碼' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密碼"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
            >
              登入
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default LoginPage;
