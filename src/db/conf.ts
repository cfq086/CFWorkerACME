/**
 * 配置读取：Confs → env → 默认值
 * -------------------------------------------------------------------------
 * 使用场景：
 *   1. 业务侧（邮件、注册、验证码、限速）需要频繁读取同一配置，内存缓存 60 秒；
 *   2. 管理员写入后应调用 `invalidateConf(name)` 主动失效；
 *   3. `readAllConfs(env)` 一次性返回全部键的快照，用于系统管理页面渲染。
 *
 * 注意：本模块不直接持有 DAO 引用，每次读取时从 env 拿到新的 DAO，避免
 *      跨请求状态污染（Cloudflare Worker 实例可能在多请求间复用）。
 */

import {ensureDao, DbEnv} from "./index";
import {DEFAULT_CONF_MAP} from "./migrations/001_admin_console";

/** 缓存项：值 + 过期时间 */
interface CacheEntry {
    value: string | null;
    expireAt: number;
}

const CACHE_TTL_MS = 60_000;
const _cache = new Map<string, CacheEntry>();

/** 把 string → bool（"1"/"true" 均为 true） */
export function asBool(v: string | null | undefined, fallback = false): boolean {
    if (v == null) return fallback;
    const s = String(v).trim().toLowerCase();
    if (s === "" ) return fallback;
    return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** 把 string → number；失败返回 fallback */
export function asInt(v: string | null | undefined, fallback = 0): number {
    if (v == null || v === "") return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 读取配置项，按 Confs → env → 默认值 回退。
 * @param env 运行时 env（通常为 c.env）
 * @param name 配置键名（建议全大写）
 * @param envKey 可选：从 env 上读取的不同键名；默认与 name 一致
 */
export async function readConf(
    env: DbEnv & Record<string, any>,
    name: string,
    envKey?: string
): Promise<string | null> {
    // 1) 缓存命中
    const now = Date.now();
    const cached = _cache.get(name);
    if (cached && cached.expireAt > now) return cached.value;

    // 2) 从 Confs 读
    let value: string | null = null;
    try {
        const dao = await ensureDao(env);
        value = await dao.getConf(name);
    } catch {
        /* DB 不可用时走 env/默认值 */
    }

    // 3) 回退 env
    if (value === null || value === undefined) {
        const fromEnv = env?.[envKey ?? name];
        if (typeof fromEnv === "string" && fromEnv.length > 0) value = fromEnv;
    }

    // 4) 回退默认值
    if (value === null || value === undefined) {
        const def = DEFAULT_CONF_MAP[name];
        if (def !== undefined) value = def;
    }

    _cache.set(name, {value: value ?? null, expireAt: now + CACHE_TTL_MS});
    return value ?? null;
}

/** 读 bool 类型配置 */
export async function readBool(env: any, name: string, fallback = false): Promise<boolean> {
    return asBool(await readConf(env, name), fallback);
}

/** 读 int 类型配置 */
export async function readInt(env: any, name: string, fallback = 0): Promise<number> {
    return asInt(await readConf(env, name), fallback);
}

/** 写入配置并失效缓存 */
export async function writeConf(env: DbEnv, name: string, value: string): Promise<void> {
    const dao = await ensureDao(env);
    await dao.upsertConf(name, value, Date.now());
    invalidateConf(name);
}

/** 删除配置并失效缓存（回退到 env/默认值） */
export async function removeConf(env: DbEnv, name: string): Promise<void> {
    const dao = await ensureDao(env);
    await dao.deleteConf(name);
    invalidateConf(name);
}

/** 一次性失效指定键（写操作后应调用） */
export function invalidateConf(name: string): void {
    _cache.delete(name);
}

/** 全量清空缓存（调试用） */
export function invalidateAll(): void {
    _cache.clear();
}

/**
 * 一次性读取多项配置快照。返回 {name: value}。
 * 未命中的键使用 env/默认值回退，不写缓存以免干扰。
 */
export async function readConfMap(
    env: DbEnv & Record<string, any>,
    names: string[]
): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const n of names) result[n] = await readConf(env, n);
    return result;
}

/**
 * **批量读配置（1 个 D1 查询）** —— 区别于上面的 `readConfMap`（它其实是逐个 await）。
 *
 * 为什么需要：`/bootstrap` 一次要读十几个键，逐个 `readConf` 就是十几个串行 D1 查询，
 * 跨太平洋每个 ~500ms → 实测 5~6 秒。这里用 `dao.listConfs()` 一次拉全表（几十行）
 * 填进缓存，同样十几个键只要 **1 个查询**。
 *
 * 回退顺序与 `readConf` 保持一致：缓存 → Confs → env → 默认值。
 */
export async function readConfsBulk(
    env: DbEnv & Record<string, any>,
    names: string[]
): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const now = Date.now();
    const miss: string[] = [];
    for (const n of names) {
        const c = _cache.get(n);
        if (c && c.expireAt > now) out[n] = c.value;
        else miss.push(n);
    }
    if (miss.length === 0) return out;

    try {
        const dao = await ensureDao(env);
        const rows = await dao.listConfs();          // ← 1 个查询拿全部配置
        const map: Record<string, string | null> = {};
        for (const r of rows) map[r.name] = r.data ?? null;
        for (const n of miss) {
            const v: string | null = map[n] ?? null;
            out[n] = v;
            _cache.set(n, {value: v, expireAt: now + CACHE_TTL_MS});
        }
    } catch {
        // DB 不可用 → 与 readConf 相同的回退：env → 默认值
        for (const n of miss) {
            let v: string | null = null;
            const fromEnv = env?.[n];
            if (typeof fromEnv === "string" && fromEnv.length > 0) v = fromEnv;
            if (v === null) {
                const def = DEFAULT_CONF_MAP[n];
                if (def !== undefined) v = def;
            }
            out[n] = v;
            _cache.set(n, {value: v, expireAt: now + CACHE_TTL_MS});
        }
    }
    return out;
}
