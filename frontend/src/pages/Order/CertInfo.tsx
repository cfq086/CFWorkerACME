import { Button } from 'antd';
import { FileText, RefreshCw } from 'lucide-react';
import SectionHeader from '@components/Layout/SectionHeader';
import Pill from '@components/atoms/Pill';
import CodeInline from '@components/atoms/CodeInline';
import CopyButton from '@components/molecules/CopyButton';
import type { Order } from '@api/types';
import { SIGN_MAP, TYPE_MAP } from '@utils/constants';
import { fmtDateTime } from '@utils/format';
import { classifyFlag, expiredDays, remainDays } from '@utils/order';
import styles from './Order.module.css';

export interface CertInfoProps {
  order: Order;
  /** 切换自动续期（仅已签发订单会显示按钮） */
  onToggleAuto?: (on: boolean) => void;
  /** 有操作进行中时禁用按钮 */
  operating?: boolean;
}

export default function CertInfo({
  order,
  onToggleAuto,
  operating,
}: CertInfoProps) {
  const subjectParts = [
    order.main.C && `C=${order.main.C}`,
    order.main.S && `S=${order.main.S}`,
    order.main.ST && `ST=${order.main.ST}`,
    order.main.O && `O=${order.main.O}`,
    order.main.OU && `OU=${order.main.OU}`,
  ].filter(Boolean);

  const domains = (order.list || []).map((d) => d.name);

  return (
    <div className={styles.certCard}>
      <SectionHeader
        icon={<FileText size={16} />}
        title="证书信息"
        subtitle={`订单 ${order.uuid}`}
      />

      <dl className={styles.descList}>
        <InfoRow label="证书域名">
          <div className={styles.domainGroup}>
            {domains.map((d, i) => (
              <CodeInline key={i} color={d.startsWith('*') ? 'accent' : 'brand'}>
                {d}
              </CodeInline>
            ))}
          </div>
        </InfoRow>

        <InfoRow label="证书厂商">
          <Pill variant="lavender" size="sm">
            {SIGN_MAP[order.sign] || order.sign}
          </Pill>
        </InfoRow>

        <InfoRow label="加密算法">
          <Pill variant="accent" size="sm">
            {TYPE_MAP[order.type] || order.type}
          </Pill>
        </InfoRow>

        <InfoRow label="证书状态">
          {(() => {
            const status = classifyFlag(order as any);
            const variant =
              status === 'signed'
                ? 'ok'
                : status === 'failed'
                  ? 'err'
                  : status === 'expired'
                    ? 'warn'
                    : status === 'verifying'
                      ? 'lemon'
                      : 'info';
            const text =
              status === 'signed'
                ? '已签发'
                : status === 'expired'
                  ? '已过期'
                  : status === 'failed'
                    ? '已失效'
                    : status === 'verifying'
                      ? '验证中'
                      : '待验证';
            return (
              <Pill variant={variant} size="sm" solid={status === 'signed'}>
                {text}
              </Pill>
            );
          })()}
        </InfoRow>

        <InfoRow label="申请时间">
          <span className={styles.infoMono}>{fmtDateTime(order.time)}</span>
        </InfoRow>

        {order.flag === 5 && order.next && (
          <InfoRow label="过期时间">
            <span className={styles.infoMono}>{fmtDateTime(order.next)}</span>
            {(() => {
              const status = classifyFlag(order as any);
              if (status === 'signed') {
                const days = remainDays(order.next);
                return (
                  <Pill
                    variant={days <= 14 ? 'warn' : 'neutral'}
                    size="sm"
                    className={styles.inlinePill}
                  >
                    剩 {days > 0 ? days : 0} 天
                  </Pill>
                );
              }
              if (status === 'expired') {
                const days = expiredDays(order.next);
                const text =
                  days >= 30
                    ? `已过期 ${Math.floor(days / 30)} 个月`
                    : days > 0
                      ? `已过期 ${days} 天`
                      : '已过期';
                return (
                  <Pill variant="warn" size="sm" className={styles.inlinePill}>
                    {text}
                  </Pill>
                );
              }
              return null;
            })()}
          </InfoRow>
        )}

        <InfoRow label="自动续期">
          <span className={styles.autoRenewRow}>
            <Pill variant={order.auto ? 'ok' : 'neutral'} size="sm">
              {order.auto ? '已开启' : '未开启'}
            </Pill>
            {/* 只有已签发（flag=5）的证书才有自动续期的意义，其它状态只展示标识 */}
            {order.flag === 5 && onToggleAuto && (
              <Button
                size="small"
                icon={<RefreshCw size={12} />}
                disabled={operating}
                onClick={() => onToggleAuto(!order.auto)}
              >
                {order.auto ? '关闭' : '开启'}
              </Button>
            )}
          </span>
        </InfoRow>

        {subjectParts.length > 0 && (
          <InfoRow label="主体信息">
            <CodeInline>{subjectParts.join(' / ')}</CodeInline>
          </InfoRow>
        )}

        {order.text && (
          <InfoRow label="通知消息">
            <span className={styles.infoText}>{order.text}</span>
          </InfoRow>
        )}

        <InfoRow label="订单编号">
          <div className={styles.uuidRow}>
            <CodeInline>{order.uuid}</CodeInline>
            <CopyButton text={order.uuid} successMsg="订单ID已复制" />
          </div>
        </InfoRow>
      </dl>
    </div>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.descRow}>
      <dt className={styles.descKey}>{label}</dt>
      <dd className={styles.descVal}>{children}</dd>
    </div>
  );
}
