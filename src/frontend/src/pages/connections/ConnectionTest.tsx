import React from 'react';
import { Modal, Button, Descriptions, Result, Spin, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { testConnection } from '../../api/connections';
import { DataSource, ConnectionTestResult } from '../../api/types';

const { Text } = Typography;

interface ConnectionTestProps {
  record: DataSource | null;
  onClose: () => void;
}

const ConnectionTest: React.FC<ConnectionTestProps> = ({ record, onClose }) => {
  const mutation = useMutation({
    mutationFn: (id: string) => testConnection(id),
  });

  const handleTest = () => {
    if (record) {
      mutation.mutate(record.id);
    }
  };

  const renderResult = (result: ConnectionTestResult) => {
    if (result.success) {
      return (
        <Result
          status="success"
          icon={<CheckCircleOutlined />}
          title="連線成功"
          subTitle={result.message}
          extra={
            result.server_version && (
              <Text type="secondary">
                伺服器版本: {result.server_version}
              </Text>
            )
          }
        />
      );
    }
    return (
      <Result
        status="error"
        icon={<CloseCircleOutlined />}
        title="連線失敗"
        subTitle={result.message}
      />
    );
  };

  return (
    <Modal
      title="測試資料庫連線"
      open={!!record}
      onCancel={() => {
        mutation.reset();
        onClose();
      }}
      footer={[
        <Button
          key="close"
          onClick={() => {
            mutation.reset();
            onClose();
          }}
        >
          關閉
        </Button>,
        <Button
          key="test"
          type="primary"
          icon={<ApiOutlined />}
          onClick={handleTest}
          loading={mutation.isPending}
        >
          測試連線
        </Button>,
      ]}
      width={520}
    >
      {record && (
        <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
          <Descriptions.Item label="名稱">{record.name}</Descriptions.Item>
          <Descriptions.Item label="類型">{record.db_type.toUpperCase()}</Descriptions.Item>
          <Descriptions.Item label="主機">{record.host}</Descriptions.Item>
          <Descriptions.Item label="連接埠">{record.port}</Descriptions.Item>
          <Descriptions.Item label="資料庫">{record.database_name}</Descriptions.Item>
          <Descriptions.Item label="使用者">{record.username}</Descriptions.Item>
        </Descriptions>
      )}

      {mutation.isPending && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin size="large" tip="正在測試連線..." />
        </div>
      )}

      {mutation.isSuccess && renderResult(mutation.data)}

      {mutation.isError && (
        <Result
          status="error"
          icon={<CloseCircleOutlined />}
          title="測試失敗"
          subTitle="無法連線到伺服器，請確認網路設定"
        />
      )}
    </Modal>
  );
};

export default ConnectionTest;
