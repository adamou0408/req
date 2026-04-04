import React, { useEffect, useMemo, useState } from 'react';
import {
  Drawer, Form, Select, Input, Radio, InputNumber, TimePicker,
  Checkbox, Button, Space, Typography, Alert,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import { listConnections } from '../../api/connections';
import { SyncConfig, SyncConfigCreate } from '../../api/sync';
import dayjs, { Dayjs } from 'dayjs';

const { Text } = Typography;

interface Props {
  open: boolean;
  editingRecord: SyncConfig | null;
  onClose: () => void;
  onSubmit: (values: SyncConfigCreate) => void;
  submitting?: boolean;
}

type FrequencyType = 'every_n_min' | 'hourly' | 'daily' | 'weekly' | 'custom';

const WEEKDAYS = [
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
  { label: '日', value: 0 },
];

function cronToReadable(cron: string | null): string {
  if (!cron) return '-';
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;

  if (min.startsWith('*/')) return `每 ${min.slice(2)} 分鐘`;
  if (hour === '*' && min !== '*') return `每小時第 ${min} 分`;
  if (dow !== '*') {
    const dayMap: Record<string, string> = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
    const days = dow.split(',').map(d => dayMap[d] || d).join('、');
    return `每週${days} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (hour !== '*' && min !== '*') return `每日 ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  return cron;
}

function buildCron(freq: FrequencyType, values: {
  everyNMin?: number;
  hourlyMinute?: number;
  dailyTime?: Dayjs;
  weeklyDays?: number[];
  weeklyTime?: Dayjs;
  customCron?: string;
}): string {
  switch (freq) {
    case 'every_n_min':
      return `*/${values.everyNMin || 15} * * * *`;
    case 'hourly':
      return `${values.hourlyMinute ?? 0} * * * *`;
    case 'daily': {
      const t = values.dailyTime || dayjs().hour(6).minute(0);
      return `${t.minute()} ${t.hour()} * * *`;
    }
    case 'weekly': {
      const t = values.weeklyTime || dayjs().hour(6).minute(0);
      const days = (values.weeklyDays || [1]).join(',');
      return `${t.minute()} ${t.hour()} * * ${days}`;
    }
    case 'custom':
      return values.customCron || '0 * * * *';
    default:
      return '0 * * * *';
  }
}

function parseCronToFormValues(cron: string | null): {
  frequency: FrequencyType;
  everyNMin?: number;
  hourlyMinute?: number;
  dailyTime?: Dayjs;
  weeklyDays?: number[];
  weeklyTime?: Dayjs;
  customCron?: string;
} {
  if (!cron) return { frequency: 'hourly', hourlyMinute: 0 };
  const parts = cron.split(' ');
  if (parts.length !== 5) return { frequency: 'custom', customCron: cron };
  const [min, hour, , , dow] = parts;

  if (min.startsWith('*/')) {
    const n = parseInt(min.slice(2), 10);
    if ([5, 10, 15, 30].includes(n)) return { frequency: 'every_n_min', everyNMin: n };
  }
  if (dow !== '*') {
    const days = dow.split(',').map(Number);
    return {
      frequency: 'weekly',
      weeklyDays: days,
      weeklyTime: dayjs().hour(parseInt(hour, 10)).minute(parseInt(min, 10)),
    };
  }
  if (hour !== '*' && min !== '*' && !min.startsWith('*/')) {
    return {
      frequency: 'daily',
      dailyTime: dayjs().hour(parseInt(hour, 10)).minute(parseInt(min, 10)),
    };
  }
  if (hour === '*' && !min.startsWith('*/')) {
    return { frequency: 'hourly', hourlyMinute: parseInt(min, 10) };
  }
  return { frequency: 'custom', customCron: cron };
}

function getNextExecution(cron: string): string {
  try {
    const parts = cron.split(' ');
    if (parts.length !== 5) return '-';
    const [min, hour, , , dow] = parts;
    const now = dayjs();
    let next = now.second(0).millisecond(0);

    if (min.startsWith('*/')) {
      const interval = parseInt(min.slice(2), 10);
      const currentMin = now.minute();
      const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
      if (nextMin >= 60) {
        next = next.add(1, 'hour').minute(0);
      } else {
        next = next.minute(nextMin);
      }
      return next.format('YYYY-MM-DD HH:mm:ss');
    }

    const targetMin = parseInt(min, 10) || 0;
    if (hour === '*') {
      next = next.minute(targetMin);
      if (next.isBefore(now)) next = next.add(1, 'hour');
      return next.format('YYYY-MM-DD HH:mm:ss');
    }

    const targetHour = parseInt(hour, 10) || 0;
    next = next.hour(targetHour).minute(targetMin);

    if (dow !== '*') {
      const days = dow.split(',').map(Number);
      for (let i = 0; i < 8; i++) {
        const candidate = next.add(i, 'day');
        if (days.includes(candidate.day()) && candidate.isAfter(now)) {
          return candidate.format('YYYY-MM-DD HH:mm:ss');
        }
      }
    }

    if (next.isBefore(now)) next = next.add(1, 'day');
    return next.format('YYYY-MM-DD HH:mm:ss');
  } catch {
    return '-';
  }
}

const SyncConfigForm: React.FC<Props> = ({ open, editingRecord, onClose, onSubmit, submitting }) => {
  const [form] = Form.useForm();
  const [syncMode, setSyncMode] = useState<'cdc' | 'batch'>('batch');
  const [frequency, setFrequency] = useState<FrequencyType>('hourly');
  const [cronPreview, setCronPreview] = useState('');

  const { data: connections = [] } = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections,
  });

  useEffect(() => {
    if (open) {
      if (editingRecord) {
        const mode = editingRecord.sync_mode;
        setSyncMode(mode);
        const cronVals = parseCronToFormValues(editingRecord.cron_expression);
        setFrequency(cronVals.frequency);
        form.setFieldsValue({
          data_source_id: editingRecord.data_source_id,
          table_name: editingRecord.table_name,
          sync_mode: mode,
          is_active: editingRecord.is_active,
          frequency: cronVals.frequency,
          everyNMin: cronVals.everyNMin,
          hourlyMinute: cronVals.hourlyMinute,
          dailyTime: cronVals.dailyTime,
          weeklyDays: cronVals.weeklyDays,
          weeklyTime: cronVals.weeklyTime,
          customCron: cronVals.customCron,
        });
      } else {
        form.resetFields();
        setSyncMode('batch');
        setFrequency('hourly');
        form.setFieldsValue({ sync_mode: 'batch', is_active: true, frequency: 'hourly', hourlyMinute: 0 });
      }
    }
  }, [open, editingRecord, form]);

  const currentCron = useMemo(() => {
    if (syncMode === 'cdc') return null;
    const vals = form.getFieldsValue();
    return buildCron(frequency, {
      everyNMin: vals.everyNMin,
      hourlyMinute: vals.hourlyMinute,
      dailyTime: vals.dailyTime,
      weeklyDays: vals.weeklyDays,
      weeklyTime: vals.weeklyTime,
      customCron: vals.customCron,
    });
  }, [syncMode, frequency, cronPreview, form]);

  const updatePreview = () => {
    setCronPreview(Date.now().toString());
  };

  const handleFinish = (values: any) => {
    const cron = syncMode === 'cdc' ? null : buildCron(frequency, {
      everyNMin: values.everyNMin,
      hourlyMinute: values.hourlyMinute,
      dailyTime: values.dailyTime,
      weeklyDays: values.weeklyDays,
      weeklyTime: values.weeklyTime,
      customCron: values.customCron,
    });
    onSubmit({
      data_source_id: values.data_source_id,
      table_name: values.table_name,
      sync_mode: syncMode,
      cron_expression: cron,
      is_active: values.is_active ?? true,
    });
  };

  return (
    <Drawer
      title={editingRecord ? '編輯同步設定' : '新增同步設定'}
      open={open}
      onClose={onClose}
      width={520}
      destroyOnClose
      footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => form.submit()}>
              儲存
            </Button>
          </Space>
        </div>
      }
    >
      <Form form={form} layout="vertical" onFinish={handleFinish} onValuesChange={updatePreview}>
        <Form.Item
          name="data_source_id"
          label="資料來源"
          rules={[{ required: true, message: '請選擇資料來源' }]}
        >
          <Select placeholder="請選擇資料來源">
            {connections.map((c: any) => (
              <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item
          name="table_name"
          label="資料表名稱"
          rules={[{ required: true, message: '請輸入資料表名稱' }]}
        >
          <Input placeholder="例如: ima_file" />
        </Form.Item>

        <Form.Item name="sync_mode" label="同步模式" rules={[{ required: true }]}>
          <Radio.Group onChange={(e) => setSyncMode(e.target.value)}>
            <Radio.Button value="cdc">CDC</Radio.Button>
            <Radio.Button value="batch">Batch</Radio.Button>
          </Radio.Group>
        </Form.Item>

        {syncMode === 'cdc' && (
          <Alert
            type="info"
            showIcon
            message="追蹤方式"
            description="系統將自動偵測資料變更"
            style={{ marginBottom: 24 }}
          />
        )}

        {syncMode === 'batch' && (
          <>
            <Form.Item name="frequency" label="頻率">
              <Radio.Group onChange={(e) => { setFrequency(e.target.value); updatePreview(); }}>
                <Radio.Button value="every_n_min">每 N 分鐘</Radio.Button>
                <Radio.Button value="hourly">每小時</Radio.Button>
                <Radio.Button value="daily">每日</Radio.Button>
                <Radio.Button value="weekly">每週</Radio.Button>
                <Radio.Button value="custom">自訂</Radio.Button>
              </Radio.Group>
            </Form.Item>

            {frequency === 'every_n_min' && (
              <Form.Item name="everyNMin" label="間隔分鐘數" initialValue={15}>
                <Select onChange={updatePreview}>
                  <Select.Option value={5}>5 分鐘</Select.Option>
                  <Select.Option value={10}>10 分鐘</Select.Option>
                  <Select.Option value={15}>15 分鐘</Select.Option>
                  <Select.Option value={30}>30 分鐘</Select.Option>
                </Select>
              </Form.Item>
            )}

            {frequency === 'hourly' && (
              <Form.Item name="hourlyMinute" label="每小時的第幾分鐘" initialValue={0}>
                <Select onChange={updatePreview}>
                  <Select.Option value={0}>第 0 分</Select.Option>
                  <Select.Option value={15}>第 15 分</Select.Option>
                  <Select.Option value={30}>第 30 分</Select.Option>
                  <Select.Option value={45}>第 45 分</Select.Option>
                </Select>
              </Form.Item>
            )}

            {frequency === 'daily' && (
              <Form.Item name="dailyTime" label="執行時間" initialValue={dayjs().hour(6).minute(0)}>
                <TimePicker format="HH:mm" onChange={updatePreview} style={{ width: '100%' }} />
              </Form.Item>
            )}

            {frequency === 'weekly' && (
              <>
                <Form.Item name="weeklyDays" label="執行星期" initialValue={[1]}>
                  <Checkbox.Group options={WEEKDAYS} onChange={updatePreview} />
                </Form.Item>
                <Form.Item name="weeklyTime" label="執行時間" initialValue={dayjs().hour(6).minute(0)}>
                  <TimePicker format="HH:mm" onChange={updatePreview} style={{ width: '100%' }} />
                </Form.Item>
              </>
            )}

            {frequency === 'custom' && (
              <Form.Item
                name="customCron"
                label="Cron 運算式"
                rules={[{ required: true, message: '請輸入 cron 運算式' }]}
              >
                <Input placeholder="例如: 0 */2 * * *" onChange={updatePreview} />
              </Form.Item>
            )}

            {currentCron && (
              <div style={{ marginBottom: 24, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}>
                <Text type="secondary">Cron: {currentCron}</Text>
                <br />
                <Text type="secondary">排程說明: {cronToReadable(currentCron)}</Text>
                <br />
                <Text strong>下次執行: {getNextExecution(currentCron)}</Text>
              </div>
            )}
          </>
        )}
      </Form>
    </Drawer>
  );
};

export default SyncConfigForm;
export { cronToReadable };
