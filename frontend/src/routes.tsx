import { lazy, Suspense, useEffect } from 'react';
import { App as AntdApp } from 'antd';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { configureApiHandlers } from '@api/request';
import { useAuthStore } from '@stores/useAuthStore';
import { useBootstrapStore } from '@stores/useBootstrapStore';
import Loading from '@components/molecules/Loading';

// 布局与侧边栏页面全部同步引入：
// 之前用 lazy() 懒加载，首次点击侧边栏时浏览器现场下载 JS chunk，
// Suspense 会闪现全屏 Loading（"闪一下"）。同步引入后这些页面已在主包里，
// 切换永远零等待。只有首屏的 Home/Login/Setup 保留懒加载，控制首包体积。
import PublicLayout from '@layouts/PublicLayout';
import AdminLayout from '@layouts/AdminLayout';
import ProtectedRoute from '@components/Layout/ProtectedRoute';
import Panel from '@pages/Panel';
import Certs from '@pages/Certs';
import Apply from '@pages/Apply';
import Order from '@pages/Order';
import Account from '@pages/Account';
import ApiDoc from '@pages/Account/ApiDoc';
import Help from '@pages/Help';
import About from '@pages/About';
import AdminUsers from '@pages/Admin/Users';
import AdminCerts from '@pages/Admin/Certs';
import AdminSystem from '@pages/Admin/System';

// 首屏懒加载（进入时正常加载一次，不涉及侧边栏切换闪屏）
const Home = lazy(() => import('@pages/Home'));
const Login = lazy(() => import('@pages/Login'));
const Setup = lazy(() => import('@pages/Setup'));

function AppRoutes() {
  const location = useLocation();
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const ensureBootstrap = useBootstrapStore((s) => s.ensureLoaded);
  const bootstrap = useBootstrapStore((s) => s.info);
  const bootstrapLoading = useBootstrapStore((s) => s.loading);
  const { message } = AntdApp.useApp();

  useEffect(() => {
    // 配置 API 全局错误处理
    configureApiHandlers({
      onError: (msg) => message.error(msg),
      onUnauthorized: () => {
        clearAuth();
        if (!location.pathname.startsWith('/login') && location.pathname !== '/') {
          window.location.hash = '#/login';
        }
      },
    });
    // 启动时：先拉取系统状态，再检查登录
    ensureBootstrap();
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // initialized=false 时，除 /setup 与静态资源外一律重定向到 /setup
  const needsSetup = bootstrap && !bootstrap.initialized;
  const isSetupPath = location.pathname.startsWith('/setup');
  if (needsSetup && !isSetupPath) {
    return (
      <Suspense fallback={<Loading full />}>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // 尚未获取到 bootstrap 时展示全局 loading，避免闪烁
  if (!bootstrap && bootstrapLoading) {
    return <Loading full />;
  }

  return (
    <Suspense fallback={<Loading full />}>
      <Routes location={location} key={location.pathname}>
          {/* Setup 页面：initialized 后自行跳登录 */}
          <Route path="/setup" element={<Setup />} />

          {/* 公共路由 */}
          <Route element={<PublicLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
          </Route>

          {/* 受保护路由 */}
          <Route
            element={
              <ProtectedRoute>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/panel" element={<Panel />} />
            <Route path="/certs" element={<Certs />} />
            <Route path="/apply" element={<Apply />} />
            <Route path="/order/:uuid" element={<Order />} />
            <Route path="/account" element={<Account />} />
            <Route path="/account/apidoc" element={<ApiDoc />} />
            <Route path="/help" element={<Help />} />
            <Route path="/about" element={<About />} />
          </Route>

          {/* 管理员路由 */}
          <Route
            element={
              <ProtectedRoute requireAdmin>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/certs" element={<AdminCerts />} />
            <Route path="/admin/system" element={<AdminSystem />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    </Suspense>
  );
}

export default AppRoutes;
