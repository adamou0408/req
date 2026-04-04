import React from 'react';
import { Card, List, Tag, Typography, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { getActiveCombos } from '../../api/combos';

const { Text } = Typography;

const ActiveCombos: React.FC = () => {
  const { data: combos = [], isLoading } = useQuery({
    queryKey: ['combos', 'active'],
    queryFn: getActiveCombos,
    refetchInterval: 30000,
  });

  return (
    <Card
      title="目前主力生產組合"
      size="small"
      style={{ marginBottom: 16 }}
    >
      {isLoading ? (
        <Spin size="small" />
      ) : combos.length === 0 ? (
        <Text type="secondary">目前無啟用中的組合</Text>
      ) : (
        <List
          size="small"
          dataSource={combos}
          renderItem={(combo) => (
            <List.Item>
              <Space direction="vertical" size={0} style={{ width: '100%' }}>
                <Text strong>
                  {combo.controller_model} + {combo.flash_model}
                </Text>
                <Tag color="blue">{combo.target_ratio}%</Tag>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
};

// Inline Space since we use it simply
const Space: React.FC<{
  direction?: string;
  size?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ style, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
    {children}
  </div>
);

export default ActiveCombos;
