import React, { useState } from 'react';
import { Layout, Menu, Button, Typography, Dropdown, theme } from 'antd';
import {
  DashboardOutlined,
  DatabaseOutlined,
  TableOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { token: themeToken } = theme.useToken();

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: '儀表板',
    },
    {
      key: '/connections',
      icon: <DatabaseOutlined />,
      label: '資料庫連線',
    },
    {
      key: '/schema',
      icon: <TableOutlined />,
      label: '結構瀏覽器',
    },
  ];

  const userMenuItems = [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '登出',
      onClick: async () => {
        await logout();
        navigate('/login');
      },
    },
  ];

  const getSelectedKey = () => {
    const path = location.pathname;
    if (path.startsWith('/connections')) return '/connections';
    if (path.startsWith('/schema')) return '/schema';
    return '/dashboard';
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        breakpoint="lg"
        onBreakpoint={(broken) => setCollapsed(broken)}
        style={{ background: themeToken.colorBgContainer }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
            padding: '0 16px',
          }}
        >
          <Text strong style={{ fontSize: collapsed ? 14 : 16, whiteSpace: 'nowrap' }}>
            {collapsed ? 'MRP' : 'MRP Platform'}
          </Text>
        </div>
        {!collapsed && (
          <div
            style={{
              padding: '8px 16px',
              textAlign: 'center',
              borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
            }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              群聯電子
            </Text>
          </div>
        )}
        <Menu
          mode="inline"
          selectedKeys={[getSelectedKey()]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: '0 24px',
            background: themeToken.colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Button type="text" icon={<UserOutlined />}>
              {user?.display_name || user?.ad_username || ''}
            </Button>
          </Dropdown>
        </Header>
        <Content
          style={{
            margin: 24,
            padding: 24,
            background: themeToken.colorBgContainer,
            borderRadius: themeToken.borderRadiusLG,
            minHeight: 280,
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
