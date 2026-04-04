import React from 'react';
import { List, Typography, Tag, Empty, Collapse } from 'antd';
import { FunctionOutlined } from '@ant-design/icons';
import { FunctionInfo } from '../../api/types';

const { Text } = Typography;

interface FunctionListProps {
  functions: FunctionInfo[];
  loading: boolean;
}

const FunctionList: React.FC<FunctionListProps> = ({ functions, loading }) => {
  if (!loading && functions.length === 0) {
    return (
      <Empty
        description="沒有函式或預存程序"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  const items = functions.map((fn, index) => ({
    key: String(index),
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FunctionOutlined style={{ color: '#722ed1' }} />
        <Text strong style={{ fontSize: 13 }}>
          {fn.schema ? `${fn.schema}.${fn.name}` : fn.name}
        </Text>
        {fn.return_type && (
          <Tag color="purple" style={{ fontSize: 11 }}>
            {fn.return_type}
          </Tag>
        )}
      </div>
    ),
    children: (
      <div>
        {fn.parameters && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">參數: </Text>
            <Text code>{fn.parameters}</Text>
          </div>
        )}
        {fn.return_type && (
          <div>
            <Text type="secondary">回傳型別: </Text>
            <Text code>{fn.return_type}</Text>
          </div>
        )}
        {fn.schema && (
          <div style={{ marginTop: 4 }}>
            <Text type="secondary">Schema: </Text>
            <Text>{fn.schema}</Text>
          </div>
        )}
      </div>
    ),
  }));

  return (
    <div>
      {loading ? (
        <List loading={true} dataSource={[]} renderItem={() => null} />
      ) : (
        <Collapse
          items={items}
          size="small"
          accordion
          ghost
        />
      )}
    </div>
  );
};

export default FunctionList;
