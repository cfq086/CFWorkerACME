/**
 * 001_admin_console
 * -------------------------------------------------------------------------
 * 管理员后台首期迁移（幂等）。
 *
 * 目标：
 *   1. Users 表补齐 is_admin / quota 字段（若已存在则跳过）。
 *   2. Apply 表补齐 lock_until 字段（订单处理租约，若已存在则跳过）。
 *   3. 新建 Confs 表（key-value 配置）。
 *   4. 播种默认配置项（仅在 Confs 中首次不存在时插入）。
 *
 * 本脚本通过统一 DAO 适配层执行，避免与 DB_SOURCE 绑定。
 * 每次 Worker 首次请求到达时调用 `runMigrations(dao)` 即可，内部做了单次标记。
 */

import type {Dao} from "../dao";

// 默认配置播种项 ============================================================
// 命名约定：全大写 + 下划线；值一律以字符串形式存储，读取方自行解析。
const DEFAULT_CONFS: Record<string, string> = {
    INITIALIZED: "false",
    SITE_TITLE: "SSL 证书助手",
    SITE_HOST: "",
    ADMIN_MAIL: "",
    MAIL_ENABLED: "false",
    MAIL_KEYS: "",
    MAIL_SEND: "",
    // 注册策略 -----------------------------------------------------------
    REGISTER_ALLOW: "true",
    REGISTER_CODE: "",
    DEFAULT_QUOTA: "-1",
    // 通知开关 -----------------------------------------------------------
    NOTIFY_ON_SUCCESS: "true",
    NOTIFY_ON_FAIL: "true",
    NOTIFY_ON_EXPIRE7: "true",
    NOTIFY_ON_EXPIRED: "true",
    // 人机验证 -----------------------------------------------------------
    CERT_CAPTCHA_ENABLED: "false",
    BASE_CAPTCHA_ENABLED: "false",
    CERT_CAPTCHA_PROVIDER: "turnstile", // turnstile | hcaptcha | recaptcha
    // AUTH_KEYS / SITE_KEYS 即 captcha 的 secret / site key；
    // CERT_CAPTCHA_SITE_KEY / CERT_CAPTCHA_SECRET_KEY 作向下兼容别名保留。
    AUTH_KEYS: "",
    SITE_KEYS: "",
    CERT_CAPTCHA_SITE_KEY: "",
    CERT_CAPTCHA_SECRET_KEY: "",
    // 月度申请上限（0 表示不限制） --------------------------------------
    MONTHLY_APPLY_LIMIT: "0",
    // 开放 API 速率限制（次/分钟） --------------------------------------
    API_RATE_LIMIT: "60",
    // DCV（Cloudflare DNS 代理）----------------------------------------
    DCV_AGENT: "",
    DCV_EMAIL: "",
    DCV_TOKEN: "",
    DCV_ZONES: "",
    // 证书提供商 · Google Trust Services -------------------------------
    // *_useIt  是否启用； *_keyMC HMAC 密钥； *_keyID EAB kid； *_KeyTS 账户私钥 PEM
    GTS_useIt: "",
    GTS_keyMC: "",
    GTS_keyID: "",
    GTS_KeyTS: "",
    // 证书提供商 · SSL.com ---------------------------------------------
    SSL_useIt: "",
    SSL_keyMC: "",
    SSL_keyID: "",
    SSL_KeyTS: "",
    // 证书提供商 · ZeroSSL ---------------------------------------------
    ZRO_useIt: "",
    ZRO_keyMC: "",
    ZRO_keyID: "",
    ZRO_KeyTS: "",
    // 定时任务 / 订单锁 ------------------------------------------------
    // 自动续期阈值：证书剩余有效期小于该天数即触发续签
    CRON_RENEW_DAYS: "30",
    // DCV 记录保留天数，超过即清理（同时终止仍卡在验证的订单）
    DCV_KEEP_DAYS: "7",
    // 订单处理租约时长（毫秒）。必须大于单次 invocation 的最坏耗时，
    // 否则会出现"上一个 invocation 还在跑、锁已过期被下一个抢走"的情况。
    ORDER_LOCK_MS: "300000",
    // 单轮自动推进最多处理的订单数。
    // 取 3 的理由（个人使用 + Workers 免费套餐）：
    //   ① 子请求配额：免费版每 invocation 只有 50 个，单订单约 12 个 → 3 个订单个约 36，留有余量；
    //      取 10 会直接超配额定（Error 1027）。
    //   ② CPU：免费版每 invocation 只有 10ms CPU（平台强杀 Error 1102，try/catch 抓不到），
    //      单订单约 0.5~2ms，3 个约 1.5~6ms，仍在预算内。
    PROCESS_MAX_ORDERS: "3",
    // renewCerts 单轮最多处理多少个已签发订单。
    // 兜底防御用：正常路径下 SQL 层（flag=5 AND next<=阈值）已只返回"真的要续期"的几张，
    // 达不到这个上限；只有 next 大面积写错时按 time 升序只处理最老的 N 个。
    // 注意：续期判断读 Apply.next（getCerts 写入的 签发+90天），**不再解析证书**
    // —— 免费版每次 cron 只有 10ms CPU，逐个解析证书约 20~60ms 必超。
    CRON_RENEW_SCAN: "20",
    // 手动路径的"有界短轮询"预算（毫秒）：点"立即处理"后，提交成功最多再等这么久看结果。
    // cron 路径不使用（提交后立即返回，结果交给下一次触发读取）。
    MANUAL_WAIT_MS: "60000",
};

// 模块级标记：避免在同一 Worker 实例中重复迁移。
let _migrated = false;

/**
 * 迁移版本标记（写在 Confs 表里）。
 * ⚠️ **每次新增/修改迁移逻辑时都要更新这个值**，否则已有标记的实例会跳过新迁移。
 */
const SCHEMA_VERSION = "2026-10-21";
const SCHEMA_VERSION_KEY = "_schema_version";

/**
 * 执行一次迁移（幂等）。
 *
 * ⚠️ 关键优化（2026-10-21）：先查一个**持久化**的版本标记，已是最新就整段跳过。
 * 原来只有模块级的 `_migrated`，Worker 冷启动后归零 → 每次冷启动都要跑 20+ 个 D1 查询
 * （建表 ×5 / PRAGMA ×2 / 索引 ×3 / 播种 8 个默认配置），跨太平洋每个 ~500ms，
 * 实测首屏 `/bootstrap` 的 TTFB 高达 **12.24 秒**。
 * 加标记后冷启动只查 1 次，降到 ~0.5 秒。
 *
 * @param dao 当前请求上下文使用的 DAO 实例。
 */
export async function runMigrations(dao: Dao): Promise<void> {
    if (_migrated) return;

    // 快速路径：查持久化标记（1 个查询）。表还不存在时会抛错 → 落到下面的完整迁移。
    try {
        const ready = await dao.getConf(SCHEMA_VERSION_KEY);
        if (ready === SCHEMA_VERSION) {
            _migrated = true;
            return;
        }
    } catch {
        /* Confs 表不存在（全新库）→ 走完整迁移 */
    }

    try {
        await ensureConfsTable(dao);
        await ensureBaseTables(dao);
        await ensureUsersColumns(dao);
        await ensureApplyColumns(dao);
        await ensureApplyIndexes(dao);
        await seedDefaultConfs(dao);
        // 标记放在**最后**：中途失败则不写，下次还会重试（保持幂等与可恢复）
        await dao.upsertConf(SCHEMA_VERSION_KEY, SCHEMA_VERSION, Date.now());
        _migrated = true;
    } catch (e) {
        // 迁移失败不应阻断所有请求；记录日志后由上层降级处理。
        console.error("[migrations] 001_admin_console failed:", e);
    }
}

/** 建 Confs 表（若不存在） */
async function ensureConfsTable(dao: Dao): Promise<void> {
    await dao.exec(
        "CREATE TABLE IF NOT EXISTS Confs (" +
        "name TEXT NOT NULL PRIMARY KEY UNIQUE, " +
        "data TEXT, " +
        "time INTEGER)"
    );
}

/**
 * 建 Users / Apply 基础表（若不存在）。
 * 与 schema.set.sql 的 DDL 保持一致；新库在此一次性建齐所有列（含 is_admin / quota），
 * 随后 ensureUsersColumns 的 PRAGMA 检查会全部命中、跳过 ALTER。
 * 老库（已有 Users 但缺字段）则由 ensureUsersColumns 通过 ALTER 补齐，向前兼容。
 */
async function ensureBaseTables(dao: Dao): Promise<void> {
    await dao.exec(
        "CREATE TABLE IF NOT EXISTS Users (" +
        "mail TEXT NOT NULL PRIMARY KEY UNIQUE, " +
        "flag TEXT DEFAULT '0' NOT NULL, " +
        "code TEXT, " +
        "keys TEXT, " +
        "pass TEXT, " +
        "apis TEXT, " +
        "time INTEGER, " +
        "is_admin INTEGER NOT NULL DEFAULT 0, " +
        "quota INTEGER NOT NULL DEFAULT -1)"
    );
    await dao.exec(
        "CREATE TABLE IF NOT EXISTS Apply (" +
        "uuid TEXT NOT NULL PRIMARY KEY UNIQUE, " +
        "mail TEXT NOT NULL, " +
        "sign INTEGER, " +
        "type INTEGER, " +
        "auto INTEGER NOT NULL DEFAULT 0, " +
        "flag INTEGER NOT NULL DEFAULT 0, " +
        "time INTEGER DEFAULT 0, " +
        "next INTEGER DEFAULT 0, " +
        "main TEXT NOT NULL, " +
        "list TEXT NOT NULL, " +
        "keys TEXT, " +
        "cert TEXT, " +
        "data TEXT, " +
        "text TEXT, " +
        "lock_until INTEGER NOT NULL DEFAULT 0, " +
        "last_run INTEGER NOT NULL DEFAULT 0, " +
        "notify_flags INTEGER NOT NULL DEFAULT 0)"
    );
}

/**
 * 检查 Users 表是否已含 is_admin / quota 字段，缺则 ALTER TABLE 补齐。
 * SQLite / D1 / MySQL 三端语法略有差异：
 *   - SQLite/D1 不支持 `ADD COLUMN IF NOT EXISTS`，需先用 PRAGMA 判断；
 *   - MySQL 可直接 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（8.0.1+）。
 * 为简化，本处先查列名集合再决定是否 ALTER。
 */
async function ensureUsersColumns(dao: Dao): Promise<void> {
    const cols = await dao.columns("Users");
    if (!cols.includes("is_admin")) {
        await dao.exec(
            "ALTER TABLE Users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"
        );
    }
    if (!cols.includes("quota")) {
        await dao.exec(
            "ALTER TABLE Users ADD COLUMN quota INTEGER NOT NULL DEFAULT -1"
        );
    }
}

/**
 * 检查 Apply 表是否已含 lock_until 字段（订单处理租约），缺则 ALTER TABLE 补齐。
 * 与 ensureUsersColumns 同样先查列名集合再决定是否 ALTER
 * （SQLite / D1 不支持 `ADD COLUMN IF NOT EXISTS`）。
 *
 * lock_until 语义：毫秒时间戳，表示"该订单被某个 invocation 持有的截止时间"。
 *   0 或小于当前时间 = 空闲可抢；大于当前时间 = 有人正在处理。
 */
async function ensureApplyColumns(dao: Dao): Promise<void> {
    const cols = await dao.columns("Apply");
    if (!cols.includes("lock_until")) {
        await dao.exec(
            "ALTER TABLE Apply ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0"
        );
    }
    // last_run：该订单最后一次被 cron/手动"处理过"的时间（推进排队用）。
    // 为什么需要它：time 是"申请时间"、建单后永不更新，Processing() 若按 time 升序
    // 取最老的 N 个，排在前面的订单会反复占用单轮配额，后面的永远轮不到（饥饿）——
    // 批量续期时 20 张同时置 flag=0，就会卡在最老那 3 张上。
    // 0 = 从没被处理过（此时用 time 兜底，第一轮行为与原先一致，平滑过渡）。
    if (!cols.includes("last_run")) {
        await dao.exec(
            "ALTER TABLE Apply ADD COLUMN last_run INTEGER NOT NULL DEFAULT 0"
        );
    }
    // notify_flags：邮件通知去重位掩码（bit0=已发「7 天后到期」）。
    // 为什么需要：到期提醒在 daily cron 里扫，没有标记就会每天重复发同一封；
    // getCerts 签发成功时重置为 0（新证书重新计时）。见 src/notify.ts。
    if (!cols.includes("notify_flags")) {
        await dao.exec(
            "ALTER TABLE Apply ADD COLUMN notify_flags INTEGER NOT NULL DEFAULT 0"
        );
    }
}

/**
 * 给 Apply 建索引（幂等）。
 *
 * 为什么需要：`Processing()` 每次 cron tick 都会捞"待处理"订单（现在是
 * `flag IN (0,1,2,3,4)`，用 IN 是为了能走这个索引），`renewCerts()` 每次
 * `WHERE flag = 5 AND next <= 阈值`。订单量上來后这些都是全表扫描，
 * 而 D1 单条 SQL 最长 30 秒、单库单线程执行，全表扫描会挤占其它订单的处理时间。
 *
 * 逐个索引单独 try/catch：某个索引创建失败（例如已存在同名但定义不同的索引）
 * 不应让后面的步骤被跳过。`CREATE INDEX IF NOT EXISTS` 本身幂等。
 */
async function ensureApplyIndexes(dao: Dao): Promise<void> {
    // (flag, time)：覆盖 Processing / renewCerts 的过滤 + 最老优先排序
    try {
        await dao.exec(
            "CREATE INDEX IF NOT EXISTS idx_apply_flag_time ON Apply(flag, time)"
        );
    } catch (e) {
        console.error("[migrations] create idx_apply_flag_time failed:", e);
    }
    // (mail)：按用户查订单列表、删除账号时按 mail 定位
    try {
        await dao.exec(
            "CREATE INDEX IF NOT EXISTS idx_apply_mail ON Apply(mail)"
        );
    } catch (e) {
        console.error("[migrations] create idx_apply_mail failed:", e);
    }
}

/**
 * 播种默认配置：仅对 Confs 中尚不存在的 key 插入，保证幂等。
 */
async function seedDefaultConfs(dao: Dao): Promise<void> {
    const now = Date.now();
    for (const [name, data] of Object.entries(DEFAULT_CONFS)) {
        const existed = await dao.getConf(name);
        if (existed === null || existed === undefined) {
            await dao.upsertConf(name, data, now);
        }
    }
}

/** 暴露默认配置映射，便于 `readConf` 做兜底。 */
export const DEFAULT_CONF_MAP = DEFAULT_CONFS;

/** 测试 / 热重载场景下可手动重置迁移标记。 */
export function _resetMigrationFlagForTests(): void {
    _migrated = false;
}
