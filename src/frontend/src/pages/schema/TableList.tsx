import React, { useMemo, useState } from 'react';
import { List, Input, Tag, Typography, Empty } from 'antd';
import { TableOutlined } from '@ant-design/icons';
import { TableInfo } from '../../api/types';

const { Text } = Typography;
const { Search } = Input;

interface TableListProps {
  tables: TableInfo[];
  loading: boolean;
  selectedTable: string | null;
  onSelectTable: (tableName: string) => void;
}

const TableList: React.FC<TableListProps> = ({
  tables,
  loading,
  selectedTable,
  onSelectTable,
}) => {
  const [filterText, setFilterText] = useState('');

  const filteredTables = useMemo(() => {
    if (!filterText) return tables;
    const lower = filterText.toLowerCase();
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.schema.toLowerCase().includes(lower) ||
        (t.comment && t.comment.toLowerCase().includes(lower))
    );
  }, [tables, filterText]);

  const groupedTables = useMemo(() => {
    const groups: Record<string, TableInfo[]> = {};
    filteredTables.forEach((t) => {
      const schema = t.schema || 'default';
      if (!groups[schema]) groups[schema] = [];
      groups[schema].push(t);
    });
    return groups;
  }, [filteredTables]);

  const schemas = Object.keys(groupedTables).sort();

  return (
    <div>
      <Search
        placeholder="搜尋資料表..."
        allowClear
        onChange={(e) => setFilterText(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {loading ? (
        <List loading={true} dataSource={[]} renderItem={() => null} />
      ) : filteredTables.length === 0 ? (
        <Empty description="沒有資料表" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        schemas.map((schema) => (
          <div key={schema} style={{ marginBottom: 8 }}>
            {schemas.length > 1 && (
              <Text
                type="secondary"
                strong
                style={{ fontSize: 12, display: 'block', marginBottom: 4, paddingLeft: 4 }}
              >
                {schema}
              </Text>
            )}
            <List
              size="small"
              dataSource={groupedTables[schema]}
              renderItem={(item) => (
                <List.Item
                  onClick={() => onSelectTable(item.name)}
                  style={{
                    cursor: 'pointer',
                    padding: '8px 12px',
                    background:
                      selectedTable === item.name ? '#e6f4ff' : 'transparent',
                    borderRadius: 6,
                    border: selectedTable === item.name ? '1px solid #91caff' : '1px solid transparent',
                    marginBottom: 2,
                  }}
                >
                  <List.Item.Meta
                    avatar={<TableOutlined style={{ color: '#1677ff', marginTop: 4 }} />}
                    title={
                      <Text
                        strong={selectedTable === item.name}
                        style={{ fontSize: 13 }}
                      >
                        {item.name}
                      </Text>
                    }
                    description={
                      <div style={{ fontSize: 12 }}>
                        {item.comment && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {item.comment}
                          </Text>
                        )}
                        {item.row_count_estimate > 0 && (
                          <Tag
                            style={{ marginLeft: 4, fontSize: 11 }}
                            color="default"
                          >
                            ~{item.row_count_estimate.toLocaleString()} 筆
                          </Tag>
                        )}
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          </div>
        ))
      )}
    </div>
  );
};

export default TableList;
