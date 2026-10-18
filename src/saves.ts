/**
 * 历史遗留数据访问层（薄包装）
 * -------------------------------------------------------------------------
 * 项目原先的业务代码（certs.ts / users.ts / index.ts）全部通过本文件读写 D1，
 * 形态为 `saves.selectDB(env.DB_CF, "Table", where)`。
 *
 * 重构后：本文件**不再直接调用 D1Database**，而是将每次调用委托给 D1Dao。
 * 这样做的好处：
 *   - 不破坏旧业务签名，兼容现有调用点；
 *   - 真正访问数据库的 SQL 语句集中在 D1Dao 中，迁移或替换时只改一处；
 *   - 后续新增的 admin / setup / api 等路由应直接使用 `ensureDao(env)`，
 *     而不是继续走本文件。
 */

import {D1Dao} from "./db/dao.d1";

/** 条件对象（维持旧签名，兼容现存调用点） */
export interface SelectWhere {
    [column: string]: { value: any; op?: string };
}

function toDao(DB: D1Database): D1Dao {
    return new D1Dao(DB);
}

/** SQL where 条件构造（内部使用，保持兼容） */
function buildFilter(where: SelectWhere | Record<string, any>, legacy: boolean): any {
    const eq: Record<string, any> = {};
    const neq: Record<string, any> = {};
    const like: Record<string, string> = {};
    const notLike: Record<string, string> = {};
    if (legacy) {
        for (const [k, cond] of Object.entries(where as SelectWhere)) {
            const op = (cond?.op ?? "=").toUpperCase();
            if (op === "LIKE") like[k] = String(cond.value);
            else if (op === "NOT LIKE") notLike[k] = String(cond.value);
            else if (op === "!=") neq[k] = cond.value;
            else eq[k] = cond.value;
        }
    } else {
        for (const [k, v] of Object.entries(where)) eq[k] = v;
    }
    return {eq, neq, like, notLike};
}

/** 更新数据 */
export async function updateDB(
    DB: D1Database, table: string,
    values: Record<string, any>, where: Record<string, any>
): Promise<any> {
    const dao = toDao(DB);
    // 拼 SQL 通过 dao.exec + prepared 不方便，这里直接用 dao 底层语义重实现
    const cols = Object.keys(values);
    const whereCols = Object.keys(where);
    if (cols.length === 0) return {success: true};
    const set = cols.map(c => `${c} = ?`).join(", ");
    const wh = whereCols.length > 0 ? " WHERE " + whereCols.map(c => `${c} = ?`).join(" AND ") : "";
    const sql = `UPDATE ${table} SET ${set}${wh}`;
    const params = [...Object.values(values), ...Object.values(where)];
    return await (DB as any).prepare(sql).bind(...params).run();
}

/** 插入数据 */
export async function insertDB(
    DB: D1Database, table: string,
    values: Record<string, any>
): Promise<any> {
    const cols = Object.keys(values);
    const ph = cols.map(() => "?").join(",");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph})`;
    return await (DB as any).prepare(sql).bind(...Object.values(values)).run();
}

/**
 * 允许拼进 SQL 的比较运算符白名单。
 * 注意：`op` 来自调用方代码而非用户输入，但仍走白名单，避免字符串拼接被注入。
 */
const CMP_OPS = new Set(["<", "<=", ">", ">="]);

/** 列名白名单：只允许 `[A-Za-z_][A-Za-z0-9_]*`，防止 `opts.cols` 被注入 */
const COL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 查询数据（兼容旧签名 `{col: {value, op}}`）。
 * 支持的操作符：`=`（默认）、`!=`、`LIKE`、`NOT LIKE`、`<`、`<=`、`>`、`>=`、`IN`。
 * 每个列只能给一个条件；同一列的多条件请自行用范围/JS 过滤。
 */
/**
 * 查询数据。
 *
 * @param opts.throwOnError 查询失败时是否抛错（默认 false，保持旧行为：静默返回空数组）。
 *        **调用方需要区分"查不到"和"查询失败"时必须传 true** —— 例如订单锁的读回兜底：
 *        静默返回空数组会让它误判成"没抢到锁"，而抛错则会走向正确的失败路径。
 * @param opts.cols 只查这些列（默认 `SELECT *`）。
 *        **读大字段表时强烈建议指定**：例如 `Processing()` 排队阶段只需要
 *        `uuid/mail/flag/time/last_run`，若 `SELECT *` 会把每行的私钥（keys）、
 *        证书链（cert）、ACME 对象（data）都搬进 JS 堆 —— 免费版每次 cron 只有
 *        10ms CPU，这些转换全是白花的开销。
 *        列名走 `COL_NAME_RE` 白名单，非法列名直接忽略（退回 `SELECT *` 由 D1 报错）。
 */
export async function selectDB(
    DB: D1Database, table: string,
    where: SelectWhere,
    opts?: { throwOnError?: boolean; cols?: string[] }
): Promise<Record<string, any>[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    for (const [k, c] of Object.entries(where)) {
        const op = (c?.op ?? "=").toUpperCase();
        if (op === "LIKE") {
            conditions.push(`${k} LIKE ?`);
            params.push(`%${c.value}%`);
        } else if (op === "NOT LIKE") {
            conditions.push(`${k} NOT LIKE ?`);
            params.push(`%${c.value}%`);
        } else if (op === "!=") {
            conditions.push(`${k} != ?`);
            params.push(c.value);
        } else if (op === "IN") {
            // IN：值全部走参数绑定，不拼进 SQL；空数组用 "1 = 0" 表示永远不匹配
            // （SQL 的 `IN ()` 是语法错误，不能直接拼）。
            const vals: any[] = Array.isArray(c.value) ? c.value : [c.value];
            if (vals.length === 0) {
                conditions.push("1 = 0");
            } else {
                conditions.push(`${k} IN (${vals.map(() => "?").join(", ")})`);
                params.push(...vals);
            }
        } else if (CMP_OPS.has(op)) {
            // 比较运算符：自动续期（next <= now）、订单锁超时判断等场景需要
            conditions.push(`${k} ${op} ?`);
            params.push(c.value);
        } else {
            conditions.push(`${k} = ?`);
            params.push(c.value);
        }
    }
    // 只取必要列（默认 *）；列名过白名单，非法的一律丢掉
    const wanted: string[] = Array.isArray(opts?.cols)
        ? opts!.cols!.filter((c) => COL_NAME_RE.test(String(c))) : [];
    const selectSql: string = wanted.length > 0 ? wanted.join(", ") : "*";
    let sql = `SELECT ${selectSql} FROM ${table} WHERE 1 = 1`;
    if (conditions.length > 0) sql += " AND " + conditions.join(" AND ");
    try {
        const {results} = await (DB as any).prepare(sql).bind(...params).all();
        return results as Record<string, any>[];
    } catch (e) {
        console.error("[saves.selectDB] error:", e);
        if (opts?.throwOnError) throw e;
        return [];
    }
}

/** 删除数据 */
export async function deleteDB(
    DB: D1Database, table: string, where: Record<string, any>
): Promise<number> {
    const conds = Object.keys(where);
    if (conds.length === 0) return 0;
    const sql = `DELETE FROM ${table} WHERE ${conds.map(c => `${c} = ?`).join(" AND ")}`;
    try {
        await (DB as any).prepare(sql).bind(...Object.values(where)).run();
        return 0;
    } catch (e) {
        console.error("[saves.deleteDB] error:", e);
        throw e;
    }
}