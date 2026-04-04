import React, { useState } from 'react';
import { Select, Input, Tabs, Typography, Card, Row, Col, Empty, Spin } from 'antd';
import { TableOutlined, FunctionOutlined, ProfileOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { listConnections } from '../../api/connections';
import { listTables, listColumns, listFunctions, searchSchema } from '../../api/schema';
import TableList from './TableList';
import ColumnDetail from './ColumnDetail';
import FunctionList from './FunctionList';
import DataPreview from './DataPreview';

const { Title, Text } = Typography;
const { Search } = Input;

const SchemaExplorer: React.FC = () => {
  const [selectedDs, setSelectedDs] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [rightTab, setRightTab] = useState('columns');

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections,
  });

  const activeConnections = connections?.filter((c) => c.is_active) || [];

  const { data: tables, isLoading: tablesLoading } = useQuery({
    queryKey: ['tables', selectedDs],
    queryFn: () => listTables(selectedDs!),
    enabled: !!selectedDs,
  });

  const { data: columns, isLoading: columnsLoading } = useQuery({
    queryKey: ['columns', selectedDs, selectedTable],
    queryFn: () => listColumns(selectedDs!, selectedTable!),
    enabled: !!selectedDs && !!selectedTable,
  });

  const { data: functions, isLoading: functionsLoading } = useQuery({
    queryKey: ['functions', selectedDs],
    queryFn: () => listFunctions(selectedDs!),
    enabled: !!selectedDs,
  });

  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['schema-search', selectedDs, searchQuery],
    queryFn: () => searchSchema(selectedDs!, searchQuery),
    enabled: !!selectedDs && searchQuery.length >= 2,
  });

  const handleDsChange = (value: string) => {
    setSelectedDs(value);
    setSelectedTable(null);
    setSearchQuery('');
  };

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName);
    setRightTab('columns');
  };

  const handleSearch = (value: string) => {
    setSearchQuery(value);
  };

  const displayTables = searchQuery.length >= 2 && searchResults
    ? searchResults.tables
    : tables || [];

  const dsOptions = activeConnections.map((c) => ({
    value: c.id,
    label: `${c.name} (${c.db_type.toUpperCase()} - ${c.host})`,
  }));

  const leftTabItems = [
    {
      key: 'tables',
      label: (
        <span>
          <TableOutlined /> 資料表 {tables ? `(${tables.length})` : ''}
        </span>
      ),
      children: (
        <TableList
          tables={displayTables}
          loading={tablesLoading || searchLoading}
          selectedTable={selectedTable}
          onSelectTable={handleSelectTable}
        />
      ),
    },
    {
      key: 'functions',
      label: (
        <span>
          <FunctionOutlined /> 函式 {functions ? `(${functions.length})` : ''}
        </span>
      ),
      children: (
        <FunctionList
          functions={functions || []}
          loading={functionsLoading}
        />
      ),
    },
  ];

  const rightTabItems = [
    {
      key: 'columns',
      label: (
        <span>
          <ProfileOutlined /> 欄位資訊
        </span>
      ),
      children: (
        <ColumnDetail
          columns={columns || []}
          loading={columnsLoading}
          tableName={selectedTable}
        />
      ),
    },
    {
      key: 'preview',
      label: (
        <span>
          <EyeOutlined /> 資料預覽
        </span>
      ),
      children: (
        <DataPreview
          dsId={selectedDs}
          tableName={selectedTable}
        />
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0, marginBottom: 12 }}>
          結構瀏覽器
        </Title>
        <Row gutter={16} align="middle">
          <Col xs={24} sm={12} md={10}>
            <Select
              placeholder="請選擇資料來源"
              value={selectedDs}
              onChange={handleDsChange}
              options={dsOptions}
              loading={connectionsLoading}
              style={{ width: '100%' }}
              size="large"
              showSearch
              optionFilterProp="label"
              notFoundContent={
                connectionsLoading ? (
                  <Spin size="small" />
                ) : (
                  <Text type="secondary">沒有可用的連線</Text>
                )
              }
            />
          </Col>
          <Col xs={24} sm={12} md={8}>
            {selectedDs && (
              <Search
                placeholder="搜尋資料表或欄位..."
                allowClear
                onSearch={handleSearch}
                onChange={(e) => {
                  if (!e.target.value) setSearchQuery('');
                }}
                size="large"
              />
            )}
          </Col>
        </Row>
      </div>

      {!selectedDs ? (
        <Card>
          <Empty
            description="請先選擇一個資料來源以瀏覽結構"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </Card>
      ) : (
        <Row gutter={16}>
          <Col xs={24} lg={8}>
            <Card
              size="small"
              style={{ height: 'calc(100vh - 260px)', overflow: 'auto' }}
              bodyStyle={{ padding: '0 8px' }}
            >
              <Tabs
                items={leftTabItems}
                size="small"
                style={{ marginTop: 4 }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={16}>
            <Card
              size="small"
              style={{ height: 'calc(100vh - 260px)', overflow: 'auto' }}
            >
              <Tabs
                items={rightTabItems}
                activeKey={rightTab}
                onChange={setRightTab}
                size="small"
              />
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
};

export default SchemaExplorer;
