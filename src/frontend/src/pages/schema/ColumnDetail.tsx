import React from 'react';
import { Table, Tag, Typography, Empty } from 'antd';
import { KeyOutlined, LinkOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { ColumnInfo } from '../../api/types';

const { Text } = Typography;

interface ColumnDetailProps {
  columns: ColumnInfo[];
  loading: boolean;
  tableName: string | null;
}

const ColumnDetail: React.FC<ColumnDetailProps> = ({ columns, loading, tableName }) => {
  if (!tableName) {
    return (
      <Empty
        description="請先選擇一個資料表"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ marginTop: 48 }}
      />
    );
  }

  const tableColumns = [
    {
      title: '欄位名稱',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: ColumnInfo) => (
        <Text
          strong={record.is_pk}
          style={{ color: record.is_pk ? '#1677ff' : record.is_fk ? '#52c41a' : undefined }}
        >
          {record.is_pk && <KeyOutlined style={{ marginRight: 4, color: '#1677ff' }} />}
          {record.is_fk && <LinkOutlined style={{ marginRight: 4, color: '#52c41a' }} />}
          {name}
        </Text>
      ),
    },
    {
      title: '資料型別',
      dataIndex: 'data_type',
      key: 'data_type',
      render: (type: string) => <Tag>{type}</Tag>,
    },
    {
      title: '允許 NULL',
      dataIndex: 'nullable',
      key: 'nullable',
      width: 100,
      align: 'center' as const,
      render: (nullable: boolean) =>
        nullable ? (
          <CheckOutlined style={{ color: '#52c41a' }} />
        ) : (
          <CloseOutlined style={{ color: '#ff4d4f' }} />
        ),
    },
    {
      title: 'PK',
      dataIndex: 'is_pk',
      key: 'is_pk',
      width: 60,
      align: 'center' as const,
      render: (isPk: boolean) =>
        isPk ? <KeyOutlined style={{ color: '#1677ff' }} /> : null,
    },
    {
      title: 'FK',
      dataIndex: 'is_fk',
      key: 'is_fk',
      width: 60,
      align: 'center' as const,
      render: (isFk: boolean) =>
        isFk ? <LinkOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: '備註',
      dataIndex: 'comment',
      key: 'comment',
      ellipsis: true,
      render: (comment: string) =>
        comment ? <Text type="secondary">{comment}</Text> : null,
    },
  ];

  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 12 }}>
        資料表: {tableName} ({columns.length} 個欄位)
      </Text>
      <Table
        columns={tableColumns}
        dataSource={columns}
        loading={loading}
        rowKey="name"
        size="small"
        pagination={false}
        scroll={{ y: 500 }}
      />
    </div>
  );
};

export default ColumnDetail;
