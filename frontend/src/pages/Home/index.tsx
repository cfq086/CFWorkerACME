import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Github,
  LayoutDashboard,
  LogIn,
  RefreshCw,
  Shield,
  Sparkles,
  UserPlus,
  Zap,
} from 'lucide-react';
import GradientText from '@components/molecules/GradientText';
import Kaomoji from '@components/molecules/Kaomoji';
import Pill from '@components/atoms/Pill';
import CodeInline from '@components/atoms/CodeInline';
import { APP_NAME, APP_VERSION, GITHUB_URL } from '@utils/constants';
import HeroIllustration from './HeroIllustration';
import styles from './Home.module.css';

const TYPE_LINES = [
  { prompt: '$ whoami', output: '> guest 🐱', delay: 0 },
  { prompt: '$ cat welcome.txt', output: '> loading...', delay: 200 },
];

export default function Home() {
  const [typingDone, setTypingDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setTypingDone(true), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={styles.home}>
      <div className={styles.hero}>
        {/* 左侧：终端 Banner */}
        <motion.div
          className={styles.left}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.1, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* 终端窗口 */}
          <div className={styles.terminal}>
            <div className={styles.terminalHeader}>
              <span className={`${styles.dot} ${styles.dotRed}`} />
              <span className={`${styles.dot} ${styles.dotYellow}`} />
              <span className={`${styles.dot} ${styles.dotGreen}`} />
              <span className={styles.terminalTitle}>~ / certhub</span>
            </div>

            <div className={styles.terminalBody}>
              {TYPE_LINES.map((line, i) => (
                <motion.div
                  key={i}
                  className={styles.terminalLine}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: line.delay / 1000, duration: 0.1 }}
                >
                  <span className={styles.terminalPromptSymbol}>$</span>
                  <span className={styles.terminalCmd}>
                    {line.prompt.replace('$ ', '')}
                  </span>
                </motion.div>
              ))}
              <motion.div
                className={styles.terminalOutput}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35, duration: 0.1 }}
              >
                guest ·{' '}
                <span className={styles.muted}>
                  welcome to CertHub, please login.
                </span>
              </motion.div>

              {/* ASCII banner */}
              <motion.pre
                className={styles.banner}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: typingDone ? 1 : 0, y: typingDone ? 0 : 8 }}
                transition={{ duration: 0.1 }}
              >
                {`╔═══════════════════════════╗
║   Free SSL Certificates    ║
║    in ~60 seconds ✨       ║
╚═══════════════════════════╝`}
              </motion.pre>
            </div>
          </div>

          {/* 副标题 */}
          <motion.p
            className={styles.subtitle}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.1 }}
          >
            免费 · 全自动 · 开源的 SSL 证书申请与下发平台
            <br />
            <span className={styles.subtitleSoft}>
              支持 <CodeInline color="brand">Let&apos;s Encrypt</CodeInline>
              {' '}·{' '}
              <CodeInline color="accent">ZeroSSL</CodeInline>
              {' '}·{' '}
              <CodeInline color="lavender">Google Trust</CodeInline>
              {' '}·{' '}
              <CodeInline color="sakura">SSL.com</CodeInline>
            </span>
          </motion.p>

          {/* CTA 按钮组 */}
          <motion.div
            className={styles.ctaGroup}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.1 }}
          >
            <Link to="/panel" className={`${styles.cta} ${styles.ctaPrimary}`}>
              <LayoutDashboard size={18} />
              <span>进入控制台</span>
              <ArrowRight size={16} className={styles.ctaArrow} />
            </Link>

            <Link
              to="/login?mode=register"
              className={`${styles.cta} ${styles.ctaSecondary}`}
            >
              <UserPlus size={18} />
              <span>注册账号</span>
            </Link>

            <Link
              to="/login"
              className={`${styles.cta} ${styles.ctaGhost}`}
            >
              <LogIn size={18} />
              <span>登录</span>
            </Link>

            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${styles.cta} ${styles.ctaGhost}`}
            >
              <Github size={18} />
              <span>GitHub</span>
            </a>
          </motion.div>
        </motion.div>

        {/* 右侧：插画 + 特性 */}
        <motion.div
          className={styles.right}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1, duration: 0.1 }}
        >
          <div className={styles.illustration}>
            <HeroIllustration />
          </div>

          <motion.div
            className={styles.features}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.65, duration: 0.1 }}
          >
            <FeatureItem
              icon={<Shield size={18} />}
              title="全自动申请"
              desc="无需配置服务器"
              accent="brand"
            />
            <FeatureItem
              icon={<Zap size={18} />}
              title="极速签发"
              desc="约 60 秒完成"
              accent="accent"
            />
            <FeatureItem
              icon={<RefreshCw size={18} />}
              title="自动续期"
              desc="到期前 7 天"
              accent="lavender"
            />
            <FeatureItem
              icon={<Sparkles size={18} />}
              title="完全免费"
              desc="开源 MIT 协议"
              accent="sakura"
            />
          </motion.div>
        </motion.div>
      </div>

      {/* 底部 */}
      <motion.footer
        className={styles.footer}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.75, duration: 0.1 }}
      >
        <div className={styles.footerLeft}>
          <Pill variant="neutral" size="xs">
            v{APP_VERSION}
          </Pill>
          <Pill variant="brand" size="xs">
            TypeScript
          </Pill>
          <Pill variant="lavender" size="xs">
            React 18
          </Pill>
          <Pill variant="accent" size="xs">
            Cloudflare
          </Pill>
        </div>
        <div className={styles.footerRight}>
          <Kaomoji mood="welcome" inline size={14} />
          <span>Made with love</span>
        </div>
      </motion.footer>
    </div>
  );
}

function FeatureItem({
  icon,
  title,
  desc,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  accent: 'brand' | 'accent' | 'lavender' | 'sakura';
}) {
  return (
    <div className={`${styles.feature} ${styles[`feature-${accent}`]}`}>
      <span className={styles.featureIcon}>{icon}</span>
      <div className={styles.featureText}>
        <div className={styles.featureTitle}>{title}</div>
        <div className={styles.featureDesc}>{desc}</div>
      </div>
    </div>
  );
}

// 重新 export 以便让 lazy-load 有默认导出
export { HeroIllustration };
