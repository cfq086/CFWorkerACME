import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

export type ThemeMode = 'light' | 'dark';

const baseToken = {
  // 字体
  fontFamily:
    '"Plus Jakarta Sans", "Nunito", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontFamilyCode:
    '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
  fontSize: 14,
  fontSizeLG: 16,
  fontSizeSM: 13,
  fontSizeHeading1: 36,
  fontSizeHeading2: 28,
  fontSizeHeading3: 22,
  fontSizeHeading4: 18,
  fontSizeHeading5: 16,

  // 圆角
  borderRadius: 12,
  borderRadiusLG: 18,
  borderRadiusSM: 8,
  borderRadiusXS: 6,

  // 控件
  controlHeight: 40,
  controlHeightLG: 48,
  controlHeightSM: 32,

  // 其他
  wireframe: false,
  motionDurationFast: '0.06s',
  motionDurationMid: '0.1s',
  motionDurationSlow: '0.15s',
  motionEaseOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  motionEaseInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
};

// 组件级自定义
const baseComponents = {
  Button: {
    borderRadius: 12,
    borderRadiusLG: 14,
    borderRadiusSM: 10,
    controlHeight: 40,
    fontWeight: 600,
    paddingInline: 18,
  },
  Input: {
    borderRadius: 12,
    controlHeight: 42,
    paddingInline: 14,
  },
  Select: {
    borderRadius: 12,
    controlHeight: 42,
    optionPadding: '8px 12px',
    optionSelectedFontWeight: 600,
  },
  Table: {
    borderRadiusLG: 16,
    cellPaddingBlock: 14,
    cellPaddingInline: 16,
    headerSplitColor: 'transparent',
  },
  Card: {
    borderRadiusLG: 18,
    paddingLG: 24,
    headerBg: 'transparent',
  },
  Modal: {
    borderRadiusLG: 24,
    paddingContentHorizontal: 24,
  },
  Message: {
    borderRadiusLG: 999,
    contentPadding: '8px 18px',
  },
  Tag: {
    borderRadiusSM: 999,
    defaultBg: 'var(--bg-code)',
    defaultColor: 'var(--text-2)',
  },
  Tabs: {
    horizontalItemGutter: 24,
    inkBarColor: 'var(--brand)',
    itemActiveColor: 'var(--brand-ink)',
    itemHoverColor: 'var(--brand-ink)',
    itemSelectedColor: 'var(--brand-ink)',
  },
  Segmented: {
    borderRadius: 999,
    borderRadiusLG: 999,
    borderRadiusSM: 999,
    itemSelectedBg: 'var(--bg-panel)',
    itemSelectedColor: 'var(--brand-ink)',
    trackBg: 'var(--bg-code)',
    trackPadding: 3,
  },
  Switch: {
    trackHeight: 24,
    trackMinWidth: 44,
    handleSize: 20,
  },
  Progress: {
    defaultColor: 'var(--brand)',
  },
  Form: {
    labelFontSize: 13,
    labelColor: 'var(--text-2)',
    verticalLabelPadding: '0 0 6px',
  },
  Drawer: {
    borderRadiusLG: 0,
  },
};

// 白天主题 token
const lightTheme: ThemeConfig = {
  token: {
    ...baseToken,
    colorPrimary: '#2EC4A6',
    colorSuccess: '#10B981',
    colorWarning: '#F59E0B',
    colorError: '#EF4444',
    colorInfo: '#3B82F6',
    colorLink: '#0F766E',
    colorLinkHover: '#2EC4A6',

    colorBgBase: '#F8F5EF',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorBgLayout: '#F8F5EF',

    colorText: '#1C1917',
    colorTextSecondary: '#57534E',
    colorTextTertiary: '#A8A29E',
    colorTextQuaternary: '#D6D3D1',

    colorBorder: '#E7E2D6',
    colorBorderSecondary: '#EFEADC',

    colorFillTertiary: '#EEEAE0',
    colorFillQuaternary: '#F8F5EF',

    boxShadow: '0 2px 8px rgba(120, 90, 60, 0.08)',
    boxShadowSecondary: '0 8px 24px rgba(120, 90, 60, 0.1)',
    boxShadowTertiary: '0 1px 2px rgba(120, 90, 60, 0.06)',
  },
  components: baseComponents,
};

// 暗黑主题 token
const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...baseToken,
    colorPrimary: '#5EEAD4',
    colorSuccess: '#34D399',
    colorWarning: '#FBBF24',
    colorError: '#F87171',
    colorInfo: '#60A5FA',
    colorLink: '#5EEAD4',
    colorLinkHover: '#99F6E4',

    colorBgBase: '#0B1110',
    colorBgContainer: '#141B1A',
    colorBgElevated: '#1A2221',
    colorBgLayout: '#0B1110',

    colorText: '#F5F5F4',
    colorTextSecondary: '#B8B5AD',
    colorTextTertiary: '#6B6864',
    colorTextQuaternary: '#3A3836',

    colorBorder: 'rgba(94, 234, 212, 0.22)',
    colorBorderSecondary: 'rgba(94, 234, 212, 0.12)',

    colorFillTertiary: 'rgba(94, 234, 212, 0.08)',
    colorFillQuaternary: 'rgba(94, 234, 212, 0.04)',

    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
    boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.6)',
    boxShadowTertiary: '0 1px 2px rgba(0, 0, 0, 0.4)',
  },
  components: baseComponents,
};

export function getAntdTheme(mode: ThemeMode): ThemeConfig {
  return mode === 'dark' ? darkTheme : lightTheme;
}
