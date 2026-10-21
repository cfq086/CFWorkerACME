import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { App, Segmented } from 'antd';
import {
  ArrowLeft,
  LockKeyhole,
  Mail,
  RefreshCcw,
  UserPlus,
} from 'lucide-react';
import Logo from '@components/organisms/Logo';
import Kaomoji from '@components/molecules/Kaomoji';
import GradientText from '@components/molecules/GradientText';
import { useAuthStore } from '@stores/useAuthStore';
import { useBootstrapStore } from '@stores/useBootstrapStore';
import {
  loginUser,
  registerUser,
  resetPassword,
  sendMailCode,
} from '@api/auth';
import { isValidEmail } from '@utils/crypto';
import { APP_NAME } from '@utils/constants';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';
import ResetForm from './ResetForm';
import styles from './Login.module.css';

type LoginMode = 'login' | 'register' | 'reset';

const MODE_CONFIG: Record<
  LoginMode,
  { label: string; title: string; subtitle: string; icon: JSX.Element }
> = {
  login: {
    label: '登录',
    title: 'Welcome back',
    subtitle: '输入您的邮箱和密码以继续',
    icon: <LockKeyhole size={20} />,
  },
  register: {
    label: '注册',
    title: 'Create account',
    subtitle: '加入 CertHub，开启免费 SSL 之旅',
    icon: <UserPlus size={20} />,
  },
  reset: {
    label: '找回密码',
    title: 'Reset password',
    subtitle: '输入您的邮箱以重置密码',
    icon: <RefreshCcw size={20} />,
  },
};

export default function Login() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const bootstrap = useBootstrapStore((s) => s.info);
  const refreshBootstrap = useBootstrapStore((s) => s.refresh);

  // 进入登录页时主动刷新一次 bootstrap，保证拿到最新的：
  //   - base_captcha.enabled（管理员可能刚在后台开启）
  //   - register_allow / register_code_required
  // 避免因 ensureLoaded 的懒加载语义导致登录页拿到陈旧配置。
  useEffect(() => {
    refreshBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 注册策略（从 /bootstrap 获取）
  const registerAllow = bootstrap?.register_allow ?? true;
  const registerCodeRequired = bootstrap?.register_code_required ?? false;
  const [inviteCode, setInviteCode] = useState('');

  // 人机验证（从 /bootstrap 获取）
  // - 未启用：不渲染 widget，也不强制 token（避免发送验证码按钮一直被灰）
  // - 启用但 provider 非 turnstile 或 site_key 为空：当前前端只实现了 Turnstile，
  //   按"未启用"处理，避免卡死（后端若真的启用，会在提交时拒绝；这里只是保证 UX 可用）
  // 注意：登录 / 注册 / 找回密码使用 base_captcha（BASE_CAPTCHA_ENABLED），
  // 与证书申请的 cert_captcha（CERT_CAPTCHA_ENABLED）独立。
  const captchaCfg = bootstrap?.base_captcha;
  const captchaEnabled =
    !!captchaCfg?.enabled &&
    captchaCfg?.provider === 'turnstile' &&
    !!captchaCfg?.site_key;
  const captchaSiteKey = captchaCfg?.site_key || '';

  const mode: LoginMode = useMemo(() => {
    const m = params.get('mode');
    // 注册被禁用时，强制回到登录
    if (!registerAllow && m === 'register') return 'login';
    if (m === 'register' || m === 'reset') return m;
    return 'login';
  }, [params, registerAllow]);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [loading, setLoading] = useState(false);

  const setMode = (m: LoginMode) => {
    const next = new URLSearchParams(params);
    if (m === 'login') next.delete('mode');
    else next.set('mode', m);
    setParams(next, { replace: true });
    setTurnstileToken(''); // 切换模式时重置
  };

  useEffect(() => {
    document.title = `${APP_NAME} · ${MODE_CONFIG[mode].label}`;
  }, [mode]);

  const validateTurnstile = () => {
    if (!captchaEnabled) return true; // 未启用验证码，直接放行
    if (!turnstileToken) {
      message.warning('请先完成人机验证');
      return false;
    }
    return true;
  };

  const handleLogin = async (email: string, password: string) => {
    if (!isValidEmail(email)) {
      message.error('请输入正确的邮箱');
      return;
    }
    if (!validateTurnstile()) return;
    setLoading(true);
    try {
      const ok = await loginUser(email, password);
      if (ok) {
        // 登录成功后从后端拉取完整登录态（包含 is_admin / quota），
        // 否则 Admin 菜单需要刷新页面才会出现。
        await checkAuth();
        message.success('登录成功 ✨');
        navigate('/panel', { replace: true });
      } else {
        message.error('登录失败，请检查邮箱和密码');
      }
    } catch (e: any) {
      message.error(e?.message || e?.nonce || e?.texts || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (
    email: string,
    password: string,
    code: string,
  ) => {
    if (!isValidEmail(email)) {
      message.error('请输入正确的邮箱');
      return;
    }
    if (!code) {
      message.error('请输入邮箱验证码');
      return;
    }
    setLoading(true);
    try {
      const ok = await registerUser(email, password, code);
      if (ok) {
        message.success('注册成功，请登录 (◠‿◠)✿');
        setMode('login');
      } else {
        message.error('注册失败');
      }
    } catch (e: any) {
      message.error(e?.message || e?.nonce || e?.texts || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (
    email: string,
    password: string,
    code: string,
  ) => {
    if (!isValidEmail(email)) {
      message.error('请输入正确的邮箱');
      return;
    }
    if (!code) {
      message.error('请输入邮箱验证码');
      return;
    }
    setLoading(true);
    try {
      const ok = await resetPassword(email, password, code);
      if (ok) {
        message.success('密码重置成功，请登录');
        setMode('login');
      } else {
        message.error('密码重置失败');
      }
    } catch (e: any) {
      message.error(e?.message || e?.nonce || e?.texts || '密码重置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async (email: string) => {
    if (!isValidEmail(email)) {
      message.error('请输入正确的邮箱');
      throw new Error('invalid email');
    }
    if (!validateTurnstile()) {
      throw new Error('turnstile required');
    }
    // 注册路径上：若站点要求邀请码，则必须提供
    if (mode === 'register' && registerCodeRequired && !inviteCode.trim()) {
      message.error('请先填写邀请码');
      throw new Error('invite required');
    }
    try {
      await sendMailCode(
        email,
        turnstileToken,
        mode === 'register' ? 'register' : 'reset',
        mode === 'register' ? inviteCode.trim() : undefined,
      );
      setTurnstileToken(''); // 发送后会被后端消耗
      message.success('验证码已发送，请查收邮箱 ✨');
    } catch (e: any) {
      message.error(e?.message || e?.nonce || e?.texts || '发送失败');
      throw e;
    }
  };

  const currentCfg = MODE_CONFIG[mode];

  return (
    <div className={styles.login}>
      <div className={styles.container}>
        {/* 左侧装饰 */}
        <motion.div
          className={styles.left}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
        >
          <LoginIllustration />
          <div className={styles.leftContent}>
            <GradientText
              gradient="brand-accent"
              as="h1"
              className={styles.welcome}
            >
              Hello, friend!
            </GradientText>
            <p className={styles.welcomeSub}>
              欢迎来到 CertHub —— 免费、全自动、开源的 SSL 证书管理平台
            </p>
            <Kaomoji
              mood={mode === 'login' ? 'welcome' : 'happy'}
              size={32}
              className={styles.welcomeKaomoji}
            />
          </div>
        </motion.div>

        {/* 右侧：终端窗口造型表单 */}
        <motion.div
          className={styles.right}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <div className={styles.terminal}>
            {/* 终端标题栏 */}
            <div className={styles.terminalHeader}>
              <button
                type="button"
                className={`${styles.winBtn} ${styles.winRed}`}
                onClick={() => navigate('/')}
                aria-label="返回首页"
                title="返回首页"
              />
              <button
                type="button"
                className={`${styles.winBtn} ${styles.winYellow}`}
                onClick={() => navigate('/')}
                aria-label="最小化"
              />
              <button
                type="button"
                className={`${styles.winBtn} ${styles.winGreen}`}
                aria-label="全屏"
              />
              <span className={styles.terminalTitle}>
                {currentCfg.icon}
                <span>{currentCfg.label} · {APP_NAME}</span>
              </span>
            </div>

            <div className={styles.terminalBody}>
              <div className={styles.brand}>
                <Logo size={40} />
                <div>
                  <div className={styles.title}>{currentCfg.title}</div>
                  <div className={styles.subtitle}>{currentCfg.subtitle}</div>
                </div>
              </div>

              {/* 模式切换 */}
              <Segmented
                block
                value={mode}
                onChange={(v) => setMode(v as LoginMode)}
                options={[
                  { label: '登录', value: 'login' },
                  ...(registerAllow
                    ? [{ label: '注册', value: 'register' as const }]
                    : []),
                  { label: '找回', value: 'reset' },
                ]}
                className={styles.segmented}
              />

              {/* 表单内容 */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={mode}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25 }}
                >
                  {mode === 'login' && (
                    <LoginForm
                      loading={loading}
                      onSubmit={handleLogin}
                      onTurnstileChange={setTurnstileToken}
                      onForgot={() => setMode('reset')}
                      captchaEnabled={captchaEnabled}
                      captchaSiteKey={captchaSiteKey}
                    />
                  )}
                  {mode === 'register' && (
                    <RegisterForm
                      loading={loading}
                      onSubmit={handleRegister}
                      onTurnstileChange={setTurnstileToken}
                      onSendCode={handleSendCode}
                      turnstileReady={!captchaEnabled || !!turnstileToken}
                      captchaEnabled={captchaEnabled}
                      captchaSiteKey={captchaSiteKey}
                      inviteCodeRequired={registerCodeRequired}
                      inviteCode={inviteCode}
                      onInviteCodeChange={setInviteCode}
                    />
                  )}
                  {mode === 'reset' && (
                    <ResetForm
                      loading={loading}
                      onSubmit={handleReset}
                      onTurnstileChange={setTurnstileToken}
                      onSendCode={handleSendCode}
                      turnstileReady={!captchaEnabled || !!turnstileToken}
                      captchaEnabled={captchaEnabled}
                      captchaSiteKey={captchaSiteKey}
                    />
                  )}
                </motion.div>
              </AnimatePresence>

              {/* 底部 */}
              <div className={styles.footer}>
                <button
                  type="button"
                  className={styles.backBtn}
                  onClick={() => navigate('/')}
                >
                  <ArrowLeft size={14} />
                  <span>返回首页</span>
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/* ---------- 装饰插画 ---------- */
function LoginIllustration() {
  return (
    <svg
      viewBox="0 0 400 300"
      xmlns="http://www.w3.org/2000/svg"
      className={styles.illustration}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="envGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      {/* 信封 */}
      <rect
        x="100"
        y="90"
        width="200"
        height="140"
        rx="18"
        fill="url(#envGrad)"
        opacity="0.9"
      />
      <path
        d="M 100 108 L 200 170 L 300 108"
        fill="none"
        stroke="var(--bg-panel)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      {/* 信封上的锁 */}
      <circle cx="200" cy="195" r="18" fill="var(--bg-panel)" />
      <path
        d="M 192 195 V 190 a 8 8 0 0 1 16 0 V 195"
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="196" y="193" width="8" height="10" rx="2" fill="var(--brand-ink)" />

      {/* 装饰星 */}
      <circle cx="70" cy="80" r="4" fill="var(--lemon)" opacity="0.7" />
      <circle cx="340" cy="70" r="5" fill="var(--sakura)" opacity="0.7" />
      <circle cx="60" cy="240" r="3" fill="var(--lavender)" opacity="0.6" />
      <circle cx="350" cy="250" r="4" fill="var(--brand)" opacity="0.7" />
    </svg>
  );
}
