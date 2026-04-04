import React, { useState, useEffect } from 'react';
import {
  Card, Button, Input, Space, Typography, Select, Modal, Form, InputNumber,
  Tag, message, Empty, Divider, Row, Col, Popconfirm,
} from 'antd';
import {
  SaveOutlined, ShareAltOutlined, FilePdfOutlined, MailOutlined,
  DeleteOutlined, ReloadOutlined, PlusOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import {
  listReports, getDashboard, createDashboard, updateDashboard,
  shareDashboard, exportDashboardPdf, scheduleDashboardEmail,
  BiReport,
} from '../../api/etl';

const { Title, Text } = Typography;
const { Option } = Select;

interface LayoutItem {
  report_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type SizePreset = 'small' | 'medium' | 'large';

const SIZE_PRESETS: Record<SizePreset, { w: number; h: number; label: string }> = {
  small: { w: 4, h: 3, label: '小 (4 欄)' },
  medium: { w: 6, h: 4, label: '中 (6 欄)' },
  large: { w: 12, h: 5, label: '大 (12 欄)' },
};

const DashboardBuilder: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dashboardName, setDashboardName] = useState('新儀表板');
  const [description, setDescription] = useState('');
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailForm] = Form.useForm();

  const { data: reports = [] } = useQuery({
    queryKey: ['bi-reports'],
    queryFn: listReports,
  });

  const { data: existingDashboard } = useQuery({
    queryKey: ['bi-dashboard', id],
    queryFn: () => getDashboard(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (existingDashboard) {
      setDashboardName(existingDashboard.name || '');
      setDescription(existingDashboard.description || '');
      setLayout(existingDashboard.layout || []);
      setRefreshInterval(existingDashboard.refresh_interval_seconds || null);
      if (existingDashboard.refresh_interval_seconds) {
        setAutoRefresh(true);
      }
    }
  }, [existingDashboard]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: dashboardName,
        description: description || undefined,
        layout,
        refresh_interval_seconds: autoRefresh ? refreshInterval : undefined,
      };
      if (id) {
        return updateDashboard(id, payload);
      }
      return createDashboard(payload);
    },
    onSuccess: (result: any) => {
      message.success('儀表板已儲存');
      queryClient.invalidateQueries({ queryKey: ['bi-dashboards'] });
      if (!id && result?.id) {
        navigate(`/bi/dashboards/${result.id}`);
      }
    },
    onError: () => message.error('儲存失敗'),
  });

  const shareMutation = useMutation({
    mutationFn: () => shareDashboard(id!),
    onSuccess: () => message.success('已送出分享申請'),
  });

  const exportMutation = useMutation({
    mutationFn: () => exportDashboardPdf(id!),
    onSuccess: (data: any) => {
      const blob = new Blob([data], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dashboard_${id}.html`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('匯出完成');
    },
  });

  const emailMutation = useMutation({
    mutationFn: async () => {
      const values = await emailForm.validateFields();
      return scheduleDashboardEmail(id!, {
        cron: values.cron,
        recipients: values.recipients.split(',').map((s: string) => s.trim()),
      });
    },
    onSuccess: () => {
      message.success('排程寄送已設定');
      setEmailModalOpen(false);
    },
  });

  const addReport = (reportId: string) => {
    const maxY = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    setLayout([
      ...layout,
      { report_id: reportId, x: 0, y: maxY, w: 6, h: 4 },
    ]);
  };

  const removeReport = (index: number) => {
    setLayout(layout.filter((_, i) => i !== index));
  };

  const resizeReport = (index: number, size: SizePreset) => {
    const updated = [...layout];
    updated[index] = { ...updated[index], w: SIZE_PRESETS[size].w, h: SIZE_PRESETS[size].h };
    setLayout(updated);
  };

  const getReportName = (reportId: string) => {
    const report = reports.find((r) => r.id === reportId);
    return report?.name || reportId;
  };

  const getReportChartType = (reportId: string) => {
    const report = reports.find((r) => r.id === reportId);
    return report?.chart_type || 'bar';
  };

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Space>
            <Input
              value={dashboardName}
              onChange={(e) => setDashboardName(e.target.value)}
              style={{ fontSize: 18, fontWeight: 'bold', width: 300 }}
              bordered={false}
            />
          </Space>
          <Space>
            <Button icon={<SaveOutlined />} type="primary" onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
              儲存
            </Button>
            {id && (
              <>
                <Button icon={<ShareAltOutlined />} onClick={() => shareMutation.mutate()} loading={shareMutation.isPending}>
                  分享
                </Button>
                <Button icon={<FilePdfOutlined />} onClick={() => exportMutation.mutate()} loading={exportMutation.isPending}>
                  匯出 PDF
                </Button>
                <Button icon={<MailOutlined />} onClick={() => setEmailModalOpen(true)}>
                  排程寄送
                </Button>
              </>
            )}
          </Space>
        </div>

        <Row gutter={16}>
          {/* Main canvas area */}
          <Col span={18}>
            <Card
              size="small"
              title="儀表板畫布 (12 欄格線)"
              style={{ minHeight: 500, background: '#fafafa' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Space style={{ marginBottom: 8 }}>
                  <Text type="secondary">自動更新:</Text>
                  <Select
                    value={autoRefresh ? String(refreshInterval || 60) : 'off'}
                    onChange={(v) => {
                      if (v === 'off') {
                        setAutoRefresh(false);
                        setRefreshInterval(null);
                      } else {
                        setAutoRefresh(true);
                        setRefreshInterval(Number(v));
                      }
                    }}
                    style={{ width: 140 }}
                  >
                    <Option value="off">關閉</Option>
                    <Option value="30">30 秒</Option>
                    <Option value="60">1 分鐘</Option>
                    <Option value="300">5 分鐘</Option>
                    <Option value="600">10 分鐘</Option>
                  </Select>
                </Space>

                {layout.length === 0 ? (
                  <Empty description="尚未加入報表，請從右側選取報表拖入" />
                ) : (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(12, 1fr)',
                    gap: 8,
                  }}>
                    {layout.map((item, index) => (
                      <div
                        key={`${item.report_id}-${index}`}
                        style={{
                          gridColumn: `span ${item.w}`,
                          border: '1px solid #d9d9d9',
                          borderRadius: 8,
                          padding: 12,
                          background: '#fff',
                          minHeight: item.h * 60,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <Text strong>{getReportName(item.report_id)}</Text>
                          <Space size="small">
                            <Select
                              size="small"
                              defaultValue="medium"
                              onChange={(v) => resizeReport(index, v as SizePreset)}
                              style={{ width: 100 }}
                            >
                              <Option value="small">小</Option>
                              <Option value="medium">中</Option>
                              <Option value="large">大</Option>
                            </Select>
                            <Button
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => removeReport(index)}
                            />
                          </Space>
                        </div>
                        <Tag>{getReportChartType(item.report_id)}</Tag>
                        <div style={{
                          height: Math.max(item.h * 40, 80),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: '#f5f5f5',
                          borderRadius: 4,
                          marginTop: 8,
                        }}>
                          <Text type="secondary">圖表預覽區域</Text>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </Col>

          {/* Right sidebar: available reports */}
          <Col span={6}>
            <Card size="small" title="可用報表" style={{ maxHeight: 600, overflow: 'auto' }}>
              {reports.length === 0 ? (
                <Empty description="尚無報表" />
              ) : (
                reports.map((r) => (
                  <Card
                    key={r.id}
                    size="small"
                    hoverable
                    style={{ marginBottom: 8 }}
                    onClick={() => addReport(r.id)}
                  >
                    <Space>
                      <PlusOutlined />
                      <div>
                        <Text strong>{r.name}</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {r.source_table} / {r.chart_type}
                        </Text>
                      </div>
                    </Space>
                  </Card>
                ))
              )}
            </Card>
          </Col>
        </Row>
      </Card>

      {/* Email schedule modal */}
      <Modal
        title="排程寄送設定"
        open={emailModalOpen}
        onOk={() => emailMutation.mutate()}
        onCancel={() => setEmailModalOpen(false)}
        confirmLoading={emailMutation.isPending}
      >
        <Form form={emailForm} layout="vertical">
          <Form.Item name="cron" label="排程 (Cron 表達式)" rules={[{ required: true }]}>
            <Input placeholder="0 8 * * 1 (每週一早上 8 點)" />
          </Form.Item>
          <Form.Item name="recipients" label="收件人 (逗號分隔)" rules={[{ required: true }]}>
            <Input placeholder="user1@company.com, user2@company.com" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DashboardBuilder;
