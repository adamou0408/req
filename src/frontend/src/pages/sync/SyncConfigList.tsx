import React, { useState, useMemo } from 'react';
import {
  Table, Button, Tag, Space, Badge, Popconfirm, message, Typography,
  Tabs, Tooltip, Switch, Descriptions,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listSyncConfigs,
  getSyncStatus,
  deleteSyncConfig,
  updateSyncConfig,
  triggerSync,
  createSyncConfig,
  SyncConfig,
  SyncConfigCreate,
  SyncStatus,
} from '../../api/sync';
import SyncConfigForm, { cronToReadable } from './SyncConfigForm';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-tw';

dayjs.extend(relativeTime);
dayjs.locale('zh-tw');

const { Title, Text } = Typography;

type TabKey = 'all' | 'cdc' | 'batch' | 'error';

interface MergedRow {
  id: string;
  config_id: string;
  data_source_id: string;
  data_source_name: string;
  table_name: string;
  sync_mode: 'cdc' | 'batch';
  cron_expression: string | null;
  is_active: boolean;
  last_sync_at: string | null;
  lag_seconds: number | null;
  health: 'healthy' | 'lagging' | 'failed' | 'inactive';
  error_message: string | null;
  error_at: string | null;
  created_at: string;
  updated_at: string;
}

const healthConfig: Record<string, { color: string; label: string; badgeStatus: 'success' | 'warning' | 'error' | 'default' }> = {
  healthy: { color: 'green', label: '正常', badgeStatus: 'success' },
  lagging: { color: 'orange', label: '延遲', badgeStatus: 'warning' },
  failed: { color: 'red', label: '失敗', badgeStatus: 'error' },
  inactive: { color: 'grey', label: '停用', badgeStatus: 'default' },
};

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  return dayjs(dateStr).fromNow();
}

const SyncConfigList: React.FC = () => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<SyncConfig | null>(null);
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);

  const { data: configs = [], isLoading: configsLoading } = useQuery({
    queryKey: ['syncConfigs'],
    queryFn: listSyncConfigs,
  });

  const { data: statuses = [], isLoading: statusLoading } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: getSyncStatus,
    refetchInterval: 15000,
  });

  const merged: MergedRow[] = useMemo(() => {
    const statusMap = new Map<string, SyncStatus>();
    statuses.forEach((s) => statusMap.set(s.config_id, s));
    return configs.map((c) => {
      const s = statusMap.get(c.id);
      return {
        id: c.id,
        config_id: c.id,
        data_source_id: c.data_source_id,
        data_source_name: s?.data_source_name || c.data_source_name || '-',
        table_name: c.table_name,
        sync_mode: c.sync_mode,
        cron_expression: c.cron_expression,
        is_active: c.is_active,
        last_sync_at: s?.last_sync_at || null,
        lag_seconds: s?.lag_seconds ?? null,
        health: s?.health || (c.is_active ? 'healthy' : 'inactive'),
        error_message: s?.error_message || null,
        error_at: s?.error_at || null,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    });
  }, [configs, statuses]);

  const filtered = useMemo(() => {
    switch (activeTab) {
      case 'cdc':
        return merged.filter((r) => r.sync_mode === 'cdc');
      case 'batch':
        return merged.filter((r) => r.sync_mode === 'batch');
      case 'error':
        return merged.filter((r) => r.health === 'failed' || r.health === 'lagging');
      default:
        return merged;
    }
  }, [merged, activeTab]);

  const deleteMut = useMutation({
    mutationFn: deleteSyncConfig,
    onSuccess: () => {
      message.success('已停用同步設定');
      queryClient.invalidateQueries({ queryKey: ['syncConfigs'] });
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
    onError: () => message.error('操作失敗'),
  });

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      updateSyncConfig(id, { is_active }),
    onSuccess: () => {
      message.success('已更新狀態');
      queryClient.invalidateQueries({ queryKey: ['syncConfigs'] });
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
    onError: () => message.error('更新失敗'),
  });

  const triggerMut = useMutation({
    mutationFn: triggerSync,
    onSuccess: (res) => {
      message.success(res?.message || '已觸發同步');
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
    onError: () => message.error('觸發失敗'),
  });

  const createMut = useMutation({
    mutationFn: createSyncConfig,
    onSuccess: () => {
      message.success('已建立同步設定');
      setFormOpen(false);
      setEditingRecord(null);
      queryClient.invalidateQueries({ queryKey: ['syncConfigs'] });
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
    onError: () => message.error('建立失敗'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: SyncConfigCreate }) =>
      updateSyncConfig(id, data),
    onSuccess: () => {
      message.success('已更新同步設定');
      setFormOpen(false);
      setEditingRecord(null);
      queryClient.invalidateQueries({ queryKey: ['syncConfigs'] });
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    },
    onError: () => message.error('更新失敗'),
  });

  const handleEdit = (row: MergedRow) => {
    const config: SyncConfig = {
      id: row.id,
      data_source_id: row.data_source_id,
      data_source_name: row.data_source_name,
      table_name: row.table_name,
      sync_mode: row.sync_mode,
      cron_expression: row.cron_expression,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    setEditingRecord(config);
    setFormOpen(true);
  };

  const handleFormSubmit = (values: SyncConfigCreate) => {
    if (editingRecord) {
      updateMut.mutate({ id: editingRecord.id, data: values });
    } else {
      createMut.mutate(values);
    }
  };

  const columns = [
    {
      title: '資料來源',
      dataIndex: 'data_source_name',
      key: 'data_source_name',
      width: 160,
    },
    {
      title: '資料表',
      dataIndex: 'table_name',
      key: 'table_name',
      width: 160,
    },
    {
      title: '模式',
      dataIndex: 'sync_mode',
      key: 'sync_mode',
      width: 90,
      render: (mode: string) => (
        <Tag color={mode === 'cdc' ? 'blue' : 'green'}>
          {mode === 'cdc' ? 'CDC' : 'Batch'}
        </Tag>
      ),
    },
    {
      title: '排程',
      dataIndex: 'cron_expression',
      key: 'cron_expression',
      width: 140,
      render: (cron: string | null, row: MergedRow) =>
        row.sync_mode === 'cdc' ? (
          <Text type="secondary">即時</Text>
        ) : (
          <Text>{cronToReadable(cron)}</Text>
        ),
    },
    {
      title: '上次同步',
      dataIndex: 'last_sync_at',
      key: 'last_sync_at',
      width: 130,
      render: (val: string | null) => (
        <Tooltip title={val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'}>
          {formatRelativeTime(val)}
        </Tooltip>
      ),
    },
    {
      title: '延遲',
      dataIndex: 'lag_seconds',
      key: 'lag_seconds',
      width: 90,
      render: (val: number | null) => {
        if (val === null || val === undefined) return <Text type="secondary">-</Text>;
        const isHigh = val > 300;
        return (
          <Text style={isHigh ? { color: '#ff4d4f', fontWeight: 600 } : undefined}>
            {val} 秒
          </Text>
        );
      },
    },
    {
      title: '狀態',
      dataIndex: 'health',
      key: 'health',
      width: 90,
      render: (health: string) => {
        const cfg = healthConfig[health] || healthConfig.inactive;
        return <Badge status={cfg.badgeStatus} text={cfg.label} />;
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, row: MergedRow) => (
        <Space size="small">
          <Tooltip title="編輯">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(row)}>
              編輯
            </Button>
          </Tooltip>
          <Tooltip title="手動觸發同步">
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={!row.is_active}
              loading={triggerMut.isPending}
              onClick={() => triggerMut.mutate(row.id)}
            >
              觸發
            </Button>
          </Tooltip>
          <Tooltip title={row.is_active ? '停用' : '啟用'}>
            <Switch
              size="small"
              checked={row.is_active}
              loading={toggleActiveMut.isPending}
              onChange={(checked) => toggleActiveMut.mutate({ id: row.id, is_active: checked })}
            />
          </Tooltip>
          <Popconfirm
            title="確認停用"
            description={`確定要停用「${row.table_name}」的同步設定嗎？`}
            onConfirm={() => deleteMut.mutate(row.id)}
            okText="確認"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              刪除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const expandedRowRender = (row: MergedRow) => (
    <div style={{ padding: '8px 16px' }}>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="錯誤訊息">
          <Text type="danger">{row.error_message || '無'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="發生時間">
          {row.error_at ? dayjs(row.error_at).format('YYYY-MM-DD HH:mm:ss') : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="相關設定參數">
          <div>
            <Text>資料來源: {row.data_source_name}</Text>
            <br />
            <Text>資料表: {row.table_name}</Text>
            <br />
            <Text>模式: {row.sync_mode === 'cdc' ? 'CDC' : 'Batch'}</Text>
            {row.cron_expression && (
              <>
                <br />
                <Text>排程: {row.cron_expression} ({cronToReadable(row.cron_expression)})</Text>
              </>
            )}
          </div>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 12 }}>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          size="small"
          loading={triggerMut.isPending}
          onClick={() => triggerMut.mutate(row.id)}
        >
          重試
        </Button>
      </div>
    </div>
  );

  const tabItems = [
    { key: 'all', label: `全部 (${merged.length})` },
    { key: 'cdc', label: `CDC (${merged.filter((r) => r.sync_mode === 'cdc').length})` },
    { key: 'batch', label: `Batch (${merged.filter((r) => r.sync_mode === 'batch').length})` },
    { key: 'error', label: `異常 (${merged.filter((r) => r.health === 'failed' || r.health === 'lagging').length})` },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>同步設定管理</Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingRecord(null);
            setFormOpen(true);
          }}
        >
          新增同步設定
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabKey)}
        items={tabItems}
        style={{ marginBottom: 8 }}
      />

      <Table<MergedRow>
        columns={columns}
        dataSource={filtered}
        loading={configsLoading || statusLoading}
        rowKey="id"
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 筆` }}
        expandable={{
          expandedRowKeys,
          onExpand: (expanded, record) => {
            setExpandedRowKeys(expanded ? [record.id] : []);
          },
          expandedRowRender,
          rowExpandable: (record) => record.health === 'failed',
        }}
        rowClassName={(record) =>
          record.health === 'failed' ? 'sync-row-failed' : ''
        }
      />

      <SyncConfigForm
        open={formOpen}
        editingRecord={editingRecord}
        onClose={() => {
          setFormOpen(false);
          setEditingRecord(null);
        }}
        onSubmit={handleFormSubmit}
        submitting={createMut.isPending || updateMut.isPending}
      />

      <style>{`
        .sync-row-failed {
          background-color: #fff2f0 !important;
        }
        .sync-row-failed:hover > td {
          background-color: #ffccc7 !important;
        }
        .sync-row-failed > td {
          background-color: #fff2f0 !important;
        }
      `}</style>
    </div>
  );
};

export default SyncConfigList;
