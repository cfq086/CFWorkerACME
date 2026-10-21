import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import App from './App';
import '@theme/reset.css';
import '@theme/variables.css';
import '@theme/animations.css';
import '@theme/antd-override.css';

// reducedMotion="always"：全局关闭所有 framer-motion 动画（入场/离场/无限循环），
// 组件直接跳到最终状态，消除 JS 动画引擎造成的页面卡顿。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="always">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
