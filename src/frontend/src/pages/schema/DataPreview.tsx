import React, { useState } from 'react';
import { Table, Select, Typography, Empty, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { previewData } from '../../api/schema';

const { Text } = Typography;

interface DataPreviewProps {
  dsId: string | null;
  tableName: string | null;
}

const DataPreview: React.FC<DataPreviewProps> = ({ dsId, tableName }) => {
  const [limit, setLimit] = useState(25);

  const { data, isLoading } = useQuery({
    queryKey: ['preview', dsId, tableName, limit],
    queryFn: () => previewData(dsId!, tableName!, limit),
    enabled: !!dsId && !!tableName,
  });

  if (!tableName || !dsId) {
    return (
      <Empty
        description="請先選擇一個資料表"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ marginTop: 48 }}
      />
    );
  }

  const tableColumns =
    data && data.length > 0
      ? Object.keys(data[0]).map((key) => ({
          title: key,
          dataIndex: key,
          key,
          ellipsis: true,
          width: 150,
          render: (value: unknown) => {
            if (value === null || value === undefined) {
              return <Text type="secondary" italic>NULL</Text>;
            }
            if (typeof value === 'object') {
              return <Text code>{JSON.stringify(value)}</Text>;
            }
            return String(value);
          },
        }))
      : [];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Text strong>
          資料表: {tableName}
        </Text>
        <Space>
          <Text type="secondary">顯示筆數:</Text>
          <Select
            value={limit}
            onChange={setLimit}
            size="small"
            style={{ width: 80 }}
            options={[
              { value: 10, label: '10' },
              { value: 25, label: '25' },
              { value: 50, label: '50' },
              { value: 100, label: '100' },
            ]}
          />
        </Space>
      </div>

      <Table
        columns={tableColumns}
        dataSource={data?.map((row, idx) => ({ ...row, _rowKey: idx }))}
        loading={isLoading}
        rowKey="_rowKey"
        size="small"
        scroll={{ x: 'max-content', y: 400 }}
        pagination={false}
      />

      {data && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Text type="secondary">
            目前顯示前 {data.length} 筆資料
          </Text>
        </div>
      )}
    </div>
  );
};

export default DataPreview;
