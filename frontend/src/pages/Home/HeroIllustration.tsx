/**
 * 首页插画 —— 原创 SVG：圆润锁 + 云朵 + 小星星 + 光斑
 * 注：循环动画已全部移除（framer-motion 无限动画会持续占用合成线程导致卡顿），保留静态效果。
 */
export default function HeroIllustration() {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 480 480"
      xmlns="http://www.w3.org/2000/svg"
      style={{ maxWidth: 480 }}
      aria-label="CertHub illustration"
    >
      <defs>
        <linearGradient id="bgGlow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="lockGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--brand-ink)" />
        </linearGradient>
        <linearGradient id="cloudGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--bg-panel)" />
          <stop offset="100%" stopColor="var(--bg-code)" />
        </linearGradient>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow
            dx="0"
            dy="8"
            stdDeviation="10"
            floodColor="var(--brand)"
            floodOpacity="0.25"
          />
        </filter>
      </defs>

      {/* 背景光圈 */}
      <circle cx="240" cy="240" r="200" fill="url(#bgGlow)" opacity="0.5" />
      <circle cx="240" cy="240" r="160" fill="none" stroke="var(--brand-soft)" strokeWidth="1" strokeDasharray="4 8" opacity="0.5" />

      {/* 云朵（装饰） */}
      <g>
        <ellipse cx="100" cy="120" rx="42" ry="22" fill="url(#cloudGrad)" stroke="var(--line)" strokeWidth="1.5" />
        <ellipse cx="130" cy="110" rx="30" ry="18" fill="url(#cloudGrad)" stroke="var(--line)" strokeWidth="1.5" />
      </g>

      <g>
        <ellipse cx="380" cy="350" rx="36" ry="18" fill="url(#cloudGrad)" stroke="var(--line)" strokeWidth="1.5" />
        <ellipse cx="355" cy="342" rx="22" ry="14" fill="url(#cloudGrad)" stroke="var(--line)" strokeWidth="1.5" />
      </g>

      {/* 中央锁 */}
      <g filter="url(#softShadow)">
        {/* 锁主体 */}
        <rect
          x="160"
          y="230"
          width="160"
          height="140"
          rx="32"
          fill="url(#lockGrad)"
        />
        {/* 锁弓 */}
        <path
          d="M 190 230 V 195 a 50 50 0 0 1 100 0 V 230"
          fill="none"
          stroke="url(#lockGrad)"
          strokeWidth="18"
          strokeLinecap="round"
        />
        {/* 锁孔 */}
        <circle cx="240" cy="290" r="16" fill="var(--bg-panel)" />
        <rect x="232" y="290" width="16" height="32" rx="4" fill="var(--bg-panel)" />
        {/* 脸部小装饰（可爱感） */}
        <circle cx="210" cy="335" r="3" fill="var(--bg-panel)" opacity="0.6" />
        <circle cx="270" cy="335" r="3" fill="var(--bg-panel)" opacity="0.6" />
        <path
          d="M 225 345 Q 240 352 255 345"
          stroke="var(--bg-panel)"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
          opacity="0.6"
        />
      </g>

      {/* 小星星（静态装饰） */}
      <g>
        <path
          d="M 100 280 L 104 288 L 112 290 L 104 292 L 100 300 L 96 292 L 88 290 L 96 288 Z"
          fill="var(--accent)"
        />
        <path
          d="M 380 180 L 385 192 L 397 194 L 385 196 L 380 208 L 375 196 L 363 194 L 375 192 Z"
          fill="var(--lemon)"
        />
        <path
          d="M 350 100 L 353 107 L 360 108 L 353 109 L 350 116 L 347 109 L 340 108 L 347 107 Z"
          fill="var(--sakura)"
        />
      </g>

      {/* 环绕小圆点（静态装饰） */}
      <g>
        <circle cx="240" cy="60" r="4" fill="var(--brand)" opacity="0.6" />
        <circle cx="420" cy="240" r="4" fill="var(--accent)" opacity="0.6" />
        <circle cx="240" cy="420" r="4" fill="var(--lavender)" opacity="0.6" />
        <circle cx="60" cy="240" r="4" fill="var(--sakura)" opacity="0.6" />
      </g>
    </svg>
  );
}
