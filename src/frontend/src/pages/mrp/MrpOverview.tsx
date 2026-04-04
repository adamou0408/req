import React, { useState } from 'react';
import {
  Button, Card, Table, Tag, Input, Typography, Space, Spin, message, Tree, Empty,
} from 'antd';
import { ThunderboltOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { runMrp, getShortages, expandBom, Shortage, BomNode, MrpResult } from '../../api/mrp';

const { Title, Text } = Typography;

interface AntTreeNode {
  title: string;
  key: string;
  children?: AntTreeNode[];
}

const buildTreeData = (nodes: BomNode[], parentKey = ''): AntTreeNode[] =>
  nodes.map((n, i) => {
    const key = `${parentKey}-${i}`;
    return {
      title: `${n.part_number} - ${n.part_name} (x${n.quantity})`,
      key,
      children: n.children ? buildTreeData(n.children, key) : undefined,
    };
  });

const severityColor: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
};

const MrpOverview: React.FC = () => {
  const [bomSearch, setBomSearch] = useState('');
  const [bomTreeData, setBomTreeData] = useState<AntTreeNode[]>([]);
  const [bomLoading, setBomLoading] = useState(false);

  const { data: shortages = [], isLoading: shortagesLoading, refetch: refetchShortages } = useQuery({
    queryKey: ['mrp', 'shortages'],
    queryFn: getShortages,
  });

  const mrpMutation = useMutation({
    mutationFn: () => runMrp(),
    onSuccess: (result: MrpResult) => {
      message.success(`MRP 運算完成，共 ${result.summary.shortage_count} 項短缺`);
      refetchShortages();
    },
    onError: () => {
      message.error('MRP 運算失敗');
    },
  });

  const handleBomSearch = async () => {
    if (!bomSearch.trim()) return;
    setBomLoading(true);
    try {
      const nodes = await expandBom(bomSearch.trim());
      setBomTreeData(buildTreeData(nodes));
    } catch {
      message.error('BOM 查詢失敗');
      setBomTreeData([]);
    } finally {
      setBomLoading(false);
    }
  };

  const shortageColumns = [
    { title: '料號', dataIndex: 'part_number', key: 'part_number' },
    { title: '品名', dataIndex: 'part_name', key: 'part_name' },
    {
      title: '需求數量',
      dataIndex: 'required_qty',
      key: 'required_qty',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '可用數量',
      dataIndex: 'available_qty',
      key: 'available_qty',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '淨需求',
      dataIndex: 'net_requirement',
      key: 'net_requirement',
      render: (v: number, record: Shortage) => (
        <Text style={{ color: record.severity === 'critical' ? '#ff4d4f' : undefined }} strong>
          {v.toLocaleString()}
        </Text>
      ),
    },
    {
      title: '嚴重度',
      dataIndex: 'severity',
      key: 'severity',
      render: (s: string) => <Tag color={severityColor[s] || 'default'}>{s}</Tag>,
    },
    { title: '到期日', dataIndex: 'due_date', key: 'due_date' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>MRP 總覽</Title>
        <Space>
          <Link to="/mrp/mps">
            <Button>生產排程</Button>
          </Link>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => mrpMutation.mutate()}
            loading={mrpMutation.isPending}
          >
            執行 MRP 運算
          </Button>
        </Space>
      </div>

      <Card title="短缺警示" style={{ marginBottom: 24 }}>
        <Table<Shortage>
          rowKey="part_number"
          columns={shortageColumns}
          dataSource={shortages}
          loading={shortagesLoading}
          pagination={{ pageSize: 10 }}
          size="middle"
        />
      </Card>

      <Card title="BOM 查詢">
        <Space style={{ marginBottom: 16 }}>
          <Input
            placeholder="輸入料號查詢 BOM..."
            prefix={<SearchOutlined />}
            value={bomSearch}
            onChange={(e) => setBomSearch(e.target.value)}
            onPressEnter={handleBomSearch}
            style={{ width: 300 }}
          />
          <Button onClick={handleBomSearch} loading={bomLoading}>
            查詢
          </Button>
        </Space>
        {bomLoading ? (
          <Spin />
        ) : bomTreeData.length > 0 ? (
          <Tree
            treeData={bomTreeData}
            defaultExpandAll
            showLine
          />
        ) : (
          <Empty description="請輸入料號查詢 BOM 結構" />
        )}
      </Card>
    </div>
  );
};

export default MrpOverview;
