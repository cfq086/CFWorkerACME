import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { App as AntdApp } from 'antd';
import { useAuthStore } from '@stores/useAuthStore';
import Loading from '@components/molecules/Loading';

export interface ProtectedRouteProps {
  children: ReactNode;
  /** 是否要求管理员身份；默认 false */
  requireAdmin?: boolean;
}

/**
 * 路由守卫
 * ---------------------------------------------------------------
 *   - 未登录：跳转 /login
 *   - requireAdmin=true 但当前不是管理员：跳转 /panel 并 toast 提示
 */
export default function ProtectedRoute({
  children,
  requireAdmin = false,
}: ProtectedRouteProps) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const checked = useAuthStore((s) => s.checked);
  const loading = useAuthStore((s) => s.loading);
  const { message } = AntdApp.useApp();
  const warnedRef = useRef(false);

  // 只在确认为「非管理员访问管理员页面」时触发一次 toast
  useEffect(() => {
    if (
      requireAdmin &&
      checked &&
      !loading &&
      isLoggedIn &&
      !isAdmin &&
      !warnedRef.current
    ) {
      warnedRef.current = true;
      message.warning('无权限访问该页面');
    }
  }, [requireAdmin, checked, loading, isLoggedIn, isAdmin, message]);

  // 首次检查尚未完成，显示 loading
  if (!checked || loading) {
    return <Loading full text="加载中 - 首次加载较慢，请耐心等待。" />;
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/panel" replace />;
  }

  return <>{children}</>;
}
