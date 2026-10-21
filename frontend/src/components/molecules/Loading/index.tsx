import type { CSSProperties } from 'react';
import Kaomoji from '../Kaomoji';
import styles from './Loading.module.css';

export interface LoadingProps {
  text?: string;
  full?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  style?: CSSProperties;
}

/**
 * 加载态组件 —— 颜文字 + 文案，比传统转圈更有温度
 */
export default function Loading({
  text = '加载中 - 首次加载较慢，请耐心等待',
  full = false,
  size = 'md',
  className,
  style,
}: LoadingProps) {
  const kaomojiSize = size === 'sm' ? 20 : size === 'lg' ? 36 : 28;

  return (
    <div
      className={[styles.wrap, full && styles.full, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <div className={styles.inner}>
        <Kaomoji mood="loading" size={kaomojiSize} className={styles.kaomoji} />
        {text && <div className={styles.text}>{text}</div>}
        <div className={styles.dots}>
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
