import type { ReactNode } from 'react';
import styles from './PageShell.module.css';

export interface PageShellProps {
  children?: ReactNode;
  className?: string;
  maxWidth?: number | string;
  padded?: boolean;
}

/**
 * 页面外壳 —— 统一管理内容边距
 * 注：入场动画已移除（路由切换不做淡入淡出，保持瞬时切换）
 */
export default function PageShell({
  children,
  className,
  maxWidth = 2560,
  padded = true,
}: PageShellProps) {
  return (
    <div
      className={[styles.shell, padded && styles.padded, className]
        .filter(Boolean)
        .join(' ')}
      style={{
        maxWidth:
          typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
      }}
    >
      {children}
    </div>
  );
}
