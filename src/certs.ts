import * as acme from 'acme-client';
import {Client} from "acme-client";
import * as saves from './saves'
import * as index from './index'
import * as agent from "./agent";
import * as query from "./query";
import {Bindings} from './index'
import {hmacSHA2} from "./users";
import {errors} from "wrangler";
import {readConf, readInt} from "./db/conf";


const acme_url_map: Record<string, any> = {
    "lets-encrypt": acme.directory.letsencrypt.production,
    "google-trust": acme.directory.google.production,
    "bypass-trust": acme.directory.buypass.production,
    "zeroca-trust": acme.directory.zerossl.production,
    "sslcom-trust": "https://acme.ssl.com/sslcom-dv-",
}

// 错误消息提取 ====================================================================================
// 针对 acme-client / xior 抛出的错误对象，优先抽取 ACME Problem Details 中的友好信息，
// 方便写入订单 text 字段后展示给用户。
export function extractAcmeError(e: any): string {
    if (!e) return "未知错误";
    try {
        // xior / axios 风格：错误对象自带 response.data
        const resp = e.response ?? e?.config?.response;
        const data = resp?.data;
        // 附加的 HTTP / URL 上下文（便于排查）
        const status: any = resp?.status ?? e?.status;
        const statusText: string = resp?.statusText ?? e?.statusText ?? "";
        const url: string = e?.request?.url ?? e?.config?.url ?? resp?.url ?? "";
        const ctxParts: string[] = [];
        if (status) ctxParts.push(`HTTP ${status}${statusText ? " " + statusText : ""}`);
        if (url) ctxParts.push(url);
        const ctx = ctxParts.length ? ` [${ctxParts.join(" @ ")}]` : "";

        if (data) {
            // 1) RFC 8555 Problem Details: { type, detail, status, subproblems }
            if (typeof data === "object") {
                const detail = data.detail || data.Detail || "";
                const type = data.type || data.Type || "";
                const subs: any[] = Array.isArray(data.subproblems) ? data.subproblems : [];
                const subText = subs
                    .map((s) => {
                        const id = s?.identifier?.value ? `[${s.identifier.value}] ` : "";
                        return id + (s?.detail || s?.type || "");
                    })
                    .filter(Boolean)
                    .join("; ");
                const core = [detail, subText].filter(Boolean).join(" | ");
                if (core) return (type ? `${core} (${type})` : core) + ctx;
                if (type) return type + ctx;
                // 无 detail/type 时，把对象序列化做兜底
                try {
                    const jsonStr = JSON.stringify(data);
                    if (jsonStr && jsonStr !== "{}") return jsonStr + ctx;
                } catch { /* ignore */ }
            }
            // 2) 纯文本响应（典型：Cloudflare 网关返回的 `error code: 525` 等）
            if (typeof data === "string" && data.trim()) {
                const text = data.trim();
                // 识别 Cloudflare 错误码，给出更友好的中文提示
                const cfMatch = text.match(/error code:\s*(\d{3,4})/i);
                if (cfMatch) {
                    const code = cfMatch[1];
                    const cfHint: Record<string, string> = {
                        "520": "网关返回空响应",
                        "521": "源站拒绝连接",
                        "522": "源站连接超时",
                        "523": "源站不可达",
                        "524": "源站响应超时",
                        "525": "SSL 握手失败（源站 TLS 配置异常）",
                        "526": "源站 SSL 证书无效",
                        "527": "Railgun 连接中断",
                    };
                    const hint = cfHint[code] || "网关错误";
                    return `Cloudflare ${code} ${hint}：${text}${ctx}`;
                }
                return text + ctx;
            }
        }
        // 3) acme-client 的 HTTPError / 普通 Error
        if (e.message) return String(e.message) + ctx;
        // 4) 完全无结构：尽力序列化
        try {
            const s = JSON.stringify(e);
            if (s && s !== "{}") return s + ctx;
        } catch { /* ignore */ }
        return "未知错误" + ctx;
    } catch {
        return e?.message ? String(e.message) : String(e);
    }
}

// 订单级 CAS 租约锁 ===============================================================================
// 目的：手动触发（`/order/?op=process`）与 cron 自动推进（`Processing`）可能同时命中同一订单。
// 做法：用 D1 自身的**单条原子 UPDATE** 做 CAS —— D1 单库单线程逐条执行，天然互斥，
//      不需要引入 Durable Object 之类的额外组件。

/** 默认租约时长（毫秒）；实际取值由配置 `ORDER_LOCK_MS` 决定 */
const ORDER_LOCK_DEFAULT_MS = 300000;

/**
 * `Processing()` 单轮的时间预算（毫秒）。
 * `scheduled()` 有 15 分钟 duration 上限，这里留足余量；超预算就停，剩余订单留给下一轮。
 */
const PROCESS_BUDGET_MS = 5 * 60 * 1000;

/**
 * `renewCerts()` 单轮最多处理多少个已签发订单（默认值）。
 * 已是**兜底防御**：正常路径下 SQL 层就只返回"真的要续期"的几张，远达不到这个上限。
 * 只有 `next` 大面积写错（导致命中过多）时才会切到这里，按 `time` 升序只处理最老的 N 个，
 * 剩余下一轮继续（续期窗口 30 天，晚一天无实质影响）。
 */
const RENEW_SCAN_LIMIT = 20;

/**
 * 尝试取锁。取锁是**单条原子语句**：
 *
 * ```sql
 * UPDATE Apply SET lock_until = <now + lease>
 *  WHERE uuid = ? AND (lock_until IS NULL OR lock_until < now)
 * ```
 *
 * 只有影响到 1 行才算抢到。
 *
 * 为什么用"租约"而不是布尔标志：`lock_until` 是绝对时间戳，即使持有者被平台杀掉
 * （15 分钟 invocation 上限 / 客户端断连），锁也会自动过期，不会永久卡死。
 *
 * @returns 抢到时返回写入的 `lock_until` 值（释放时要用它校验持有者），没抢到返回 0
 */
async function acquireOrderLock(env: Bindings, uuid: string, leaseMs: number): Promise<number> {
    const now: number = Date.now();
    // +0~999ms 抖动：下面的读回校验兜底靠"值是否等于自己写进去的"来判断抢没抢到，
    // 若两个调用在同一毫秒算出同一个 until 就会误判为抢到。抖动让值几乎不可能撞车。
    const until: number = now + Math.max(1000, leaseMs) + Math.floor(Math.random() * 1000);
    const sql: string =
        "UPDATE Apply SET lock_until = ? WHERE uuid = ? AND (lock_until IS NULL OR lock_until < ?)";
    try {
        const res: any = await (env.DB_CF as any).prepare(sql).bind(until, uuid, now).run();
        const changes: number = Number(res?.meta?.changes ?? -1);
        if (changes >= 0) return changes === 1 ? until : 0;
        // 个别运行环境不返回 meta.changes → 读回校验兜底（值等于我们刚写进去的才算抢到）
        // ⚠️ 这里必须让查询失败**抛错**：静默返回空数组会让兜底误判成"没抢到锁"，
        //    订单就永远无法被自动推进。抛错由 withOrderLock 的调用方按失败处理。
        console.error("[orderLock] meta.changes 不可用，改用读回校验:", uuid);
    } catch (e) {
        console.error("[orderLock] 取锁失败:", uuid, e);
        return 0;
    }
    const cur: any = (await saves.selectDB(
        env.DB_CF, "Apply", {uuid: {value: uuid}}, {throwOnError: true}))[0];
    return (cur && Number(cur['lock_until']) === until) ? until : 0;
}

/**
 * 释放锁。带 `lock_until = until` 条件，确保**只释放自己持有的那把**
 * （若租约已过期并被别人接管，不会误清掉对方的锁）。
 */
async function releaseOrderLock(env: Bindings, uuid: string, until: number): Promise<void> {
    if (!until) return;
    try {
        await saves.updateDB(env.DB_CF, "Apply", {lock_until: 0}, {uuid, lock_until: until});
    } catch (e) {
        console.error("[orderLock] 释放锁失败:", uuid, e);
    }
}

/**
 * 在订单锁保护下执行 `fn`。
 * 取不到锁时返回 `{locked: false}`，由调用方决定怎么反馈（cron 跳过 / 手动提示"处理中"）。
 */
async function withOrderLock<T>(
    env: Bindings, uuid: string, fn: () => Promise<T>
): Promise<{ locked: boolean; value?: T }> {
    const leaseMs: number = await readInt(env, "ORDER_LOCK_MS", ORDER_LOCK_DEFAULT_MS);
    const until: number = await acquireOrderLock(env, uuid, leaseMs);
    if (!until) return {locked: false};
    try {
        return {locked: true, value: await fn()};
    } finally {
        await releaseOrderLock(env, uuid, until);
    }
}

/**
 * 订单的"排队键"：**最久没被处理过的排最前**。
 *
 * 为什么不能直接按 `time` 排：`time` 是"申请时间"、建单后**永不更新**，
 * 于是排在前面的订单会反复占用单轮配额（`PROCESS_MAX_ORDERS`），
 * 后面的订单永远轮不到 —— 这就是**饥饿**。批量续期时尤其明显：
 * `renewCerts` 一次把 20 张置成 `flag=0`，`Processing` 每轮只处理最老 3 张，
 * 而这 3 张处理完 `time` 还是最小 → 其余 17 张永远排不上，证书会真的过期。
 *
 * `last_run > 0` 用它（上次被处理的时间）；从没处理过（0）回退到 `time`
 * —— 这样第一轮行为与原先完全一致（最老优先），属于平滑过渡。
 */
function orderQueueKey(o: any): number {
    const last: number = Number(o?.['last_run'] ?? 0);
    if (last > 0) return last;
    return Number(o?.['time'] ?? 0);
}

/**
 * 标记订单"本轮已被处理过"（必须在**锁内**调用，且放在 `finally` 里）。
 * 让本单排到队尾，把单轮配额让给别的订单 —— 这是避免饥饿的关键一步。
 * 失败只记日志：它只是排序提示，写不成功顶多少轮转一次，不该让订单处理失败。
 */
async function markOrderRun(env: Bindings, uuid: string): Promise<void> {
    try {
        await saves.updateDB(env.DB_CF, "Apply", {last_run: Date.now()}, {uuid});
    } catch (e) {
        console.error("[Processing] 更新 last_run 失败:", uuid, e);
    }
}

/**
 * `Processing()` 排队阶段要处理的 flag 集合。
 * 用 `IN (0,1,2,3,4)` 而不是 `!= 5`：SQLite 的 `!=` 无法用索引定位（仍是全表扫描），
 * 而 `IN` 能走 `idx_apply_flag_time`。附带好处是 `flag >= 0` 的过滤可以直接省掉。
 *
 *    flag=2 的语义是「等 DNS 记录配好」
 *    **不进自动推进队列**，配好 DNS 后**手动**推进：
 *      - `GET /order/?op=verify`  → 置 flag=3 并触发一次验证
 *      - `GET /order/?op=process` → 置 flag=3 后一键推进到底
 *    （两条路径都在 `index.ts` 的 `/order/` 路由里，不经过本函数。）
 *    兜底：若始终不处理，`cleanDNS` 会在 DCV 记录超过 `DCV_KEEP_DAYS`（默认 7 天）时
 *    把这类卡死订单终止，避免产生永久僵尸单。
 */
const PROCESSABLE_FLAGS = [0, 1, 3, 4];

/**
 * `Processing()` 排队阶段**只需要**的列。
 * 刻意不含 `keys`（私钥）、`cert`（证书链）、`data`（ACME 对象）、`main`、`list`
 * —— 这些大字段要在锁内对**真正要处理**的那几个订单才取。
 * 否则一轮就要把全表所有行的私钥/证书都搬进 JS 堆，免费版 10ms CPU 下全是白花的开销。
 */
const QUEUE_COLS = ["uuid", "mail", "flag", "time", "last_run"];

// 整体处理进程 ====================================================================================
// 供 cron（自动推进）与 `/tests/`、`/tasks/` 调用。
//
// ⚠️ 只推进 `PROCESSABLE_FLAGS = [0,1,3,4]`，**刻意跳过 flag=2（待验证）**：
//    flag=2 要等用户自己配好 DNS 记录后手动推（`/order/?op=verify|process`），
//    自动去验证没有意义。详见 PROCESSABLE_FLAGS 的注释。
//
// ⚠️ 锁是**订单级**粒度：每个订单各自取锁/释放，所以一轮 cron 不会长时间占着一把大锁。
// ⚠️ **不要在 `opDomain` 内部再加锁** —— 它的 `dnsAuthy` 调用点只从本函数进入（已在锁内），
//    重复加锁会因租约未过期而取锁失败，等于把自己锁死。
//
// 查询分两段（CPU 优化，见 QUEUE_COLS 注释）：
//   ① 排队阶段：只查 QUEUE_COLS，用于筛选 + 排序，不碰大字段；
//   ② 锁内：按 uuid 重查**完整**订单给下游函数用（它们要 order_info.data / list）。
// 用户查询同理：移到锁内（取不到锁就不查）+ 按 mail 缓存（个人场景一轮只查一次）。
//
// 单轮上限（G8）：`scheduled()` 有 15 分钟 duration 上限，而每个订单的处理耗时不可控
// （还要受子请求配额约束，免费计划只有 50）。所以这里同时限制**订单数**与**总耗时**，
// 超出的订单留给下一轮。
export async function Processing(env: Bindings, opts?: { maxOrders?: number; budgetMs?: number }) {
    const maxOrders: number = opts?.maxOrders ?? await readInt(env, "PROCESS_MAX_ORDERS", 3);
    const budgetMs: number = opts?.budgetMs ?? PROCESS_BUDGET_MS;
    const startedAt: number = Date.now();

    // ① 排队阶段：只查最小列集 + 用 IN 走索引（详见 QUEUE_COLS / PROCESSABLE_FLAGS 注释）
    const queue: any[] = await saves.selectDB(env.DB_CF, "Apply",
        {flag: {value: PROCESSABLE_FLAGS, op: "IN"}},
        {cols: QUEUE_COLS});
    // 按"排队键"升序 = 最久没处理过的优先（见 orderQueueKey：不能直接用 time，
    // 否则老订单反复占配额 → 后面的饥饿）。
    const order_list: any[] = queue
        .slice()
        .sort((a: any, b: any) => orderQueueKey(a) - orderQueueKey(b));

    // ② 一轮内按 mail 缓存用户：个人使用场景下所有订单同一个 mail，
    //    没必要每个订单都把 Users（含 ACME 私钥）重查一遍。
    const userCache: Map<string, any> = new Map();
    const loadUser = async (mail: string): Promise<any> => {
        const key: string = String(mail ?? "");
        if (userCache.has(key)) return userCache.get(key);
        const u: any = (await saves.selectDB(
            env.DB_CF, "Users", {mail: {value: key}}))[0];
        userCache.set(key, u ?? null);
        return u ?? null;
    };

    let result: any[] = []
    let handled: number = 0;
    for (const order_item of order_list) { // 获取信息 ==================================================================
        if (handled >= maxOrders) {
            result.push({"texts": `达到单轮订单数上限 ${maxOrders}，剩余留到下一轮`, "skipped": true});
            break;
        }
        if (Date.now() - startedAt > budgetMs) {
            result.push({"texts": `达到单轮时间预算 ${budgetMs}ms，剩余留到下一轮`, "skipped": true});
            break;
        }
        const order_uuid: string = String(order_item['uuid']);
        // 订单级 CAS 租约锁：取不到说明另一个 invocation（手动点击 / 上一轮 cron）正在处理它
        // ⚠️ 整段包 try/catch：单个订单失败（CA 连接失败、订单数据损坏等）**不能中断整轮**，
        //    否则排在前面的坏订单会让后面的订单永远轮不到（级联故障）。
        //    withOrderLock 的 finally 保证锁在任何路径下都会释放。
        let locked: { locked: boolean; value?: any };
        try {
            locked = await withOrderLock(env, order_uuid, async () => {
                // ⚠️ finally 里标记 last_run：**无论成功、失败还是未推进**，都算"本轮处理过了"，
                //    让本单排到队尾。否则一个反复失败的坏订单会永远占据最老位置，
                //    把单轮配额吃光 → 别的订单饥饿（与上面 catch 的"级联故障"是两个不同问题）。
                //    放在锁内还能避免与另一个 invocation 竞争时写乱。
                try {
                    // 锁内才取完整订单与用户（取不到锁就完全不查，省掉无用功）。
                    // flag 也用这里的新值，不用排队阶段的旧快照。
                    const order_info: any = (await saves.selectDB(
                        env.DB_CF, "Apply", {uuid: {value: order_uuid}}))[0];
                    if (!order_info) return undefined; // 订单已被删除
                    const order_user: any = await loadUser(String(order_info['mail'] ?? ""));
                    const flag: number = Number(order_info['flag']);
                    if (flag === 0) return await newApply(env, order_user, order_info);// 执行创建订单操作
                    if (flag === 1) return await setApply(env, order_user, order_info);// 自动执行域名代理
                    // flag=3「验证中」：交给 dnsAuthy 继续验证。
                    // ⚠️ flag=2「待验证」**不在此处理**（它已不在 PROCESSABLE_FLAGS 里）：
                    //    自动去验证没有意义 —— 用户可能还没配好 DNS 记录，必然失败。
                    //    等用户配好后自行通过 `/order/?op=verify` 或 `op=process` 手动推进。
                    //    （原 G13 修复曾让 flag=2 也走 dnsAuthy，2026-10-16 按用户要求回退。）
                    if (flag === 3) return await dnsAuthy(env, order_user, order_info, 0);
                    if (flag === 4) return await getCerts(env, order_user, order_info);// 自动执行获取证书
                    return undefined;
                } finally {
                    await markOrderRun(env, order_uuid);
                }
            });
        } catch (e) {
            handled += 1;
            const reason: string = extractAcmeError(e);
            console.error("[Processing] 订单处理异常，本轮记为失败并继续:", order_uuid, reason);
            result.push({
                "uuid": order_uuid, "texts": "处理异常: " + reason, "failed": true
            });
            continue;
        }
        handled += 1;
        if (!locked.locked) {
            console.log("[Processing] 订单正被处理，本轮跳过:", order_uuid);
            result.push({"uuid": order_uuid, "texts": "订单正在处理中，本轮跳过", "skipped": true});
            continue;
        }
        // 未知 flag 没有对应处理分支，不往结果里塞 undefined
        if (locked.value !== undefined) result.push(locked.value);
    } // ========================================================================================================
    return result;
}

// 自动续期 ========================================================================================
/**
 * `auto` 字段的宽松判定（D1 里可能存 1 / "1" / true）。
 * 导出给 `index.ts` 的 `/order/?op=auto` 复用，避免两处各写一份判定。
 */
export function isAutoRenew(auto: any): boolean {
    if (auto === true) return true;
    const n = Number(auto);
    if (Number.isFinite(n)) return n === 1;
    return String(auto).toLowerCase() === "true";
}

/**
 * 自动续期检查（cron 每日维护的第一步）。
 *
 * 只做一件事：把「已签发（flag=5）且启用自动续期、剩余有效期不足 `CRON_RENEW_DAYS` 天」
 * 的订单重置为 `flag=0`。**后续的验证与签发完全交给 `Processing()`**，本函数不改动验证逻辑。
 *
 * 幂等性：重置后订单不再是 flag=5，下一轮不会被重复捞起。
 *
 * ── 到期日来源（关键设计）───────────────────────────────────────────────
 * 用 `Apply.next`，**不解析证书**。`next` 由 `getCerts` 在签发成功时写入
 * （`签发时间 + 90 天`），与证书真实 `notAfter` 只差几小时，而 LE / ZeroSSL / GTS
 * 的都是 90 天有效期 —— 对 30 天续期窗口没有影响。
 *
 * 把过滤推到 SQL 层换来两个决定性好处：
 *   ① **完全不做 X.509 解析** —— 免费版每次 cron 只有 10ms CPU，而逐个解析证书
 *      要约 20~60ms（必超；Error 1102 是平台强杀，try/catch 抓不到）；
 *      现在整轮约 0.2~0.5ms，20 张甚至 100 张证书都安全。
 *   ② **结果集从「全部已签发订单 + 每张几 KB 的 cert」缩到「真的要续期的那几张」**
 *      （顺带省掉小 100KB 的 JSON 行→对象转换）。
 *
 * 单轮上限（RENEW_SCAN_LIMIT）只是兜底防御：万一 `next` 大面积写错导致命中过多，
 * 按 `time` 升序只处理最老的 N 个，剩余下一轮（续期窗口 30 天，晚一天无实质影响）。
 *
 * ⚠️ 已知缺口（G7，v1 有意保留）：若续期过程中失败（订单落到 flag=-1），本函数不会再捞它，
 *    需要人工介入或后续版本加退避重试。
 */
export async function renewCerts(env: Bindings) {
    const renewDays: number = Math.max(1, await readInt(env, "CRON_RENEW_DAYS", 30));
    const threshold: number = Date.now() + renewDays * 24 * 60 * 60 * 1000;
    // SQL 层过滤：flag=5（已签发）且 next <= threshold（已进入续期窗口）。
    // ⚠️ selectDB 的 where 是对象、同一字段只能出现一次，所以「next > 0」放到下面的 JS 里补。
    const allDone: any[] = await saves.selectDB(env.DB_CF, "Apply", {
        flag: {value: 5},
        next: {value: threshold, op: "<="},
    });
    const candidates: any[] = allDone
        .slice()
        // 这里可以放心按 time 升序（不需要 orderQueueKey/last_run）：
        // 候选集是 flag=5，而续期一旦命中就把订单置成 flag=0、**自动退出候选集**，
        // 所以每轮处理的都是"当前还没续期过的最老几张"，天然轮转、不会饥饿。
        .sort((a: any, b: any) => Number(a?.['time'] ?? 0) - Number(b?.['time'] ?? 0));
    const scanLimit: number = await readInt(env, "CRON_RENEW_SCAN", RENEW_SCAN_LIMIT);
    const scanList: any[] = candidates.slice(0, Math.max(1, scanLimit));
    const unscanned: number = Math.max(0, candidates.length - scanList.length);

    let renewed: number = 0;
    let skipped: number = 0;
    for (const o of scanList) {
        if (!isAutoRenew(o?.['auto'])) { skipped++; continue; }        // 未启用自动续期
        const nextAt: number = Number(o?.['next'] ?? 0);
        if (nextAt <= 0) { skipped++; continue; }                      // 没有有效到期日（脏数据）
        if (nextAt > threshold) { skipped++; continue; }               // 双保险：理论上已被 SQL 过滤
        // 置 flag=0 触发全新申请。旧证书仍保留在 cert 字段，续期失败时用户手里还有可用证书。
        await saves.updateDB(env.DB_CF, "Apply", {
            flag: 0,
            text: `自动续期：到期日 ${new Date(nextAt).toISOString().slice(0, 10)}` +
                `（不足 ${renewDays} 天），已重新提交申请`,
        }, {uuid: o['uuid']});
        renewed++;
        console.log("[renewCerts] 已提交续期:", o['uuid'],
            "next=" + new Date(nextAt).toISOString());
    }
    return {
        "flag": true,
        "text": `自动续期检查完成：提交 \`${renewed}\` 个，跳过 \`${skipped}\` 个` +
            (unscanned > 0 ? `，未检查 \`${unscanned}\` 个（本轮上限 ${scanLimit}，下一轮继续）` : "") +
            `（阈值 ${renewDays} 天）`
    };
}

// 单订单一键推进 ==================================================================================
// 按当前 flag 循环推进状态机，直到进入需要外部介入的节点：
// - flag=2  需要用户配置 DNS（等用户触发验证）
// - flag=5  证书签发完成
// - flag=-1 失败
// - 或中间某步 flag 未发生变化（避免死循环）
//
// ⚠️ 本函数是**内部实现**，调用方必须已经持有订单锁（见下方的 `processOne`）。
//
// @param manual_wait_ms 透传给 dnsAuthy 的有界等待预算
async function processOneLocked(
    env: Bindings, order_uuid: string, manual_wait_ms: number
): Promise<any[]> {
    let result: any[] = [];
    // 自愈检查：订单已创建（data 存在）但 list 中某些域名 auth 缺失，则强制回到 flag=1 重跑 setApply
    {
        let cur: any = (await saves.selectDB(
            env.DB_CF, "Apply", {uuid: {value: order_uuid}}))[0];
        if (cur && cur['data'] && cur['list']) {
            let cur_flag = Number(cur['flag']);
            if (cur_flag >= 1 && cur_flag < 4) { // 只对尚未开始验证的中间态做自愈
                try {
                    let list_items: any[] = JSON.parse(cur['list']) || [];
                    let need_repair = list_items.length > 0 && list_items.some((it: any) => {
                        let auth_val = (it && (it['auth'] || it['text'])) || "";
                        return !auth_val;
                    });
                    if (need_repair && cur_flag !== 1) {
                        await saves.updateDB(env.DB_CF, "Apply", {flag: 1}, {uuid: order_uuid});
                        console.log("processOne self-heal: reset flag=1 for order " + order_uuid);
                    }
                } catch (e) {
                    console.error("processOne self-heal parse error:", e);
                }
            }
        }
    }
    for (let i = 0; i < 8; i++) { // 最多推进 8 步，防止极端情况死循环
        let order_info: any = (await saves.selectDB(
            env.DB_CF, "Apply", {uuid: {value: order_uuid}}))[0];
        if (!order_info) break;
        let flag = Number(order_info['flag']);
        if (flag === 2 || flag === 5 || flag < 0) break; // 终止条件
        let order_user: any = (await saves.selectDB(
            env.DB_CF, "Users", {mail: {value: order_info['mail']}}))[0];
        try {
            if (flag === 0) result.push(await newApply(env, order_user, order_info));
            else if (flag === 1) result.push(await setApply(env, order_user, order_info));
            else if (flag === 3) result.push(await dnsAuthy(env, order_user, order_info, manual_wait_ms));
            else if (flag === 4) result.push(await getCerts(env, order_user, order_info));
            else break; // 其它未知状态，停止推进
        } catch (e) {
            const msg = extractAcmeError(e);
            console.error("processOne error at flag=" + flag + ":", e);
            console.error("抛错5: ", extractAcmeError(e));
            // 将错误信息持久化到订单，供前端展示
            try {
                await saves.updateDB(env.DB_CF, "Apply",
                    {flag: -1, text: "处理失败: " + msg},
                    {uuid: order_uuid});
            } catch (ue) {
                console.error("processOne persist error failed:", ue);
            }
            result.push({"texts": "处理失败: " + msg});
            break;
        }
        // 若本轮处理后 flag 未推进，防止死循环
        let next_info: any = (await saves.selectDB(
            env.DB_CF, "Apply", {uuid: {value: order_uuid}}))[0];
        if (!next_info || Number(next_info['flag']) === flag) break;
    }
    return result;
}

/**
 * 单订单一键推进（**手动入口**：`POST /apply/`、`GET /order/?op=process`）。
 *
 * 整段推进（含自愈）都在**订单锁**内执行：拿不到锁说明另一个 invocation
 * （cron 或另一次手动点击）正在处理该订单，此时不等待、不排队，
 * 直接返回 `{locked: false}`，由路由层提示"订单正在处理中"。
 *
 * cron 自动推进走 `Processing()`，不经过这里，因此默认带"有界短轮询"预算是安全的。
 *
 * @param wait_ms 有界等待预算；不传则读 `MANUAL_WAIT_MS`（默认 60000）
 * @returns `{locked, results}`；`locked === false` 表示没抢到锁、本轮什么都没做
 */
export async function processOne(
    env: Bindings, order_uuid: string, wait_ms?: number
): Promise<{ locked: boolean; results: any[] }> {
    const manual_wait_ms: number = (wait_ms === undefined)
        ? await readInt(env, "MANUAL_WAIT_MS", 60000) : wait_ms;
    const locked = await withOrderLock<any[]>(
        env, order_uuid, () => processOneLocked(env, order_uuid, manual_wait_ms));
    if (!locked.locked) console.log("[processOne] 订单正被处理，跳过:", order_uuid);
    return {locked: locked.locked, results: locked.value ?? []};
}

// 新增证书订单 =====================================================================================
export async function newApply(env: Bindings, order_user: any, order_info: any) {
    // 获取申请域名信息 =============================================================================
    let client_data: any = await getStart(env, order_user, order_info); // 获取域名证书的申请操作接口
    if (client_data == null) return {"texts": "处理失败，详见日志输出"};
    let domain_list: any = await getNames(order_info, true) // 获取当前申请域名的详细信息和类型
    // console.log("domain_list: ", domain_list);
    try {
        let orders_data: any = JSON.stringify(await client_data.createOrder({identifiers: domain_list}));
        // 写入订单详细数据 =============================================================================
        const timestamp = new Date(new Date().setDate(new Date().getDate() + 7)).getTime();
        await saves.updateDB(env.DB_CF, "Apply", {flag: 1}, {uuid: order_info['uuid']}) // 更改状态码
        await saves.updateDB(env.DB_CF, "Apply", {next: timestamp}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {text: "订单创建成功"}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {data: orders_data}, {uuid: order_info['uuid']})
    } catch (e) {
        const msg = extractAcmeError(e);
        console.error("newApply createOrder failed:", e);
        // 记录到订单：标记失败 + 写入明确错误原因，便于前端显示
        try {
            await saves.updateDB(env.DB_CF, "Apply",
                {flag: -1, text: "订单创建失败: " + msg},
                {uuid: order_info['uuid']});
        } catch (ue) {
            console.error("newApply persist error failed:", ue);
        }
        // 包装后再抛出，调用方（processOne）可直接使用
        const wrapped: any = new Error(msg);
        wrapped.cause = e;
        throw wrapped;
    }
    return {"texts": "处理成功"};
    // ==============================================================================================
}

// 自动验证代理 =====================================================================================
export async function setApply(env: Bindings, order_user: any, order_info: any) {
    let domain_list: any = order_info['list'];
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    // console.log(domain_list, orders_data);
    // 执行验证部分 ================================================================================
    let author_save: Record<string, Record<string, any>> = await getAuthy(client_data, orders_data)
    let domain_save: any[] = []
    let domain_flag: number = 2
    let domain_text: string = ""
    for (let domain_item of JSON.parse(domain_list)) {
        if (domain_item['type'] == "dns-auto") {
            await agent.dnsDel(env, domain_item['auto']); // 删除原来
        }
    }
    for (let domain_item of JSON.parse(domain_list)) {
        let domain_name = domain_item.name;
        // if (domain_item.wild) domain_name = "*." + domain_name
        // console.log(domain_name, author_save, author_save[domain_name]);
        if (author_save[domain_name] == undefined) {
            // 未拿到挑战：保留原条目但标记未就绪，触发下次自愈重试覆盖写入
            domain_item['auth'] = domain_item['auth'] || "";
            domain_item.flag = 1;
            domain_flag = 1;
            domain_text += domain_item.name + ": 未获取到验证挑战，稍后重试；";
            domain_save.push(domain_item);
            continue;
        }
        // console.log(author_save);
        domain_item['auth'] = author_save[domain_name]['text'];
        // 对于http-01验证（web-self），额外保存token用于前端展示验证路径
        if (author_save[domain_name]['data']?.type === 'http-01') {
            domain_item['token'] = author_save[domain_name]['data']['token'];
        }
        domain_item.flag = 2
        if (domain_item['type'] == "dns-auto") {
            let domain_auto = await hmacSHA2(domain_name.replaceAll("*.", ""), order_user['mail'])
            const dcvAgent = (await readConf(env as any, "DCV_AGENT")) ?? ""
            domain_item['auto'] = domain_auto.substring(0, 16) + "." + dcvAgent
            // console.log(domain_item['auto'])
            try { // 设置域名内容 ====================================================
                let data: Record<string, any> = await agent.dnsAdd(
                    env, domain_item, domain_name);
                if (!data['success']) {
                    domain_item.flag = 1
                    domain_flag = 1
                    domain_text += domain_item.name +
                        ": 无法设置DNS记录: " + data['errors'][0]['message'].toString()
                }
            } catch (error) {
                console.error('Error:', error);
            }
        }
        // console.log(domain_item);
        domain_save.push(domain_item);
    }
    if (domain_text.length == 0) domain_text = "域名处理成功"
    await saves.updateDB(env.DB_CF, "Apply", {list: JSON.stringify(domain_save)}, {uuid: order_info['uuid']})
    await saves.updateDB(env.DB_CF, "Apply", {flag: domain_flag}, {uuid: order_info['uuid']})
    await saves.updateDB(env.DB_CF, "Apply", {text: domain_text}, {uuid: order_info['uuid']})
    // console.log(domain_save);
    return {"texts": domain_text};
}

// 修改验证状态 =====================================================================================
export async function opDomain(env: Bindings, order_user: any, order_info: any, sets_list: string[]) {
    let domain_list: any = order_info['list'];
    // 执行操作部分 =================================================================================
    let domain_save: any[] = []
    let domain_flag: number = 3
    for (let domain_item of JSON.parse(domain_list)) {
        // console.log(domain_item, sets_list);
        // console.log(sets_list.some(item => item.toLowerCase() === domain_item.name.toLowerCase()));
        if (domain_item.flag >= 4) {
            domain_save.push(domain_item);
            continue;
        }
        if (sets_list.some(item => item.toLowerCase() === domain_item.name.toLowerCase()
            || item.toLowerCase() === "all")) {
            domain_item.flag = 3;
        } else domain_flag = 2;
        if (sets_list.length == 0 && domain_item.flag == 3) {
            await dnsAuthy(env, order_user, order_info);
            break;
        }
        domain_save.push(domain_item);
    }
    if (sets_list.length !== 0) {
        await saves.updateDB(env.DB_CF, "Apply", {list: JSON.stringify(domain_save)}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {text: "订单域名验证状态修改成功"}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {flag: domain_flag}, {uuid: order_info['uuid']})
    }
    return {"texts": "处理成功"};
}

// 挑战状态探测 / 有界等待 ###########################################################################
// Step 1 的设计要点：把"同步长轮询"移出请求路径 ——
//   cron 路径：提交后立即返回，结果交给下一次触发读取；
//   手动路径：只做**有界**短轮询（默认 ≤60 秒）。

/** 挑战状态探测结果 */
interface ChallengeProbe {
    status: string; // pending | processing | valid | invalid | ""（读取失败）
    reason: string; // CA 的失败原因（invalid / 读取失败时有值）
}

/** 手动路径的有界轮询间隔 */
const CHALLENGE_POLL_INTERVAL_MS = 5000;
/** 提交前"本地可解析性复核"的重试预算（acme-client 默认 10 次退避 ≈3.5 分钟，压到 2 次 ≈1 秒） */
const VERIFY_CHALLENGE_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从挑战对象里取 CA 的失败原因（ACME Problem Details 的 detail）。
 * 挑战变 invalid 时 CA 会把原因放在 `challenge.error`（RFC 8555 §7.1.6）——
 * 这也是拆掉 waitForValidStatus 后**保住诊断信息**的关键（原先靠它抛异常的 message 带出来）。
 */
function challengeErrorReason(challenge: any): string {
    const err: any = challenge && challenge['error'];
    if (!err) return "";
    if (err['detail']) return String(err['detail']);
    try {
        return JSON.stringify(err);
    } catch {
        return "";
    }
}

/**
 * 单次探测某个挑战的真实状态：对挑战 URL 发一次 POST-as-GET（只读，不触发任何状态变更）。
 * **不重试**（只消耗 1 个 ACME 请求），失败返回 `status: ""`。
 * 相比走 `getOrder` + `getAuthorizations` 再找目标挑战，这里少发 N 个请求。
 */
async function probeChallenge(client_data: any, challenge: any): Promise<ChallengeProbe> {
    if (!challenge || !challenge['url']) return {status: "", reason: "挑战对象缺少 url"};
    try {
        const resp: any = await client_data.api.apiRequest(challenge['url'], null, [200]);
        return {
            status: String(resp?.data?.status || ""),
            reason: challengeErrorReason(resp?.data),
        };
    } catch (e: any) {
        const reason: string = (e && e.message) ? String(e.message) : extractAcmeError(e);
        console.error('probeChallenge failed:', reason);
        return {status: "", reason};
    }
}

/**
 * **有界**等待挑战进入终态：每 `CHALLENGE_POLL_INTERVAL_MS` 探测一次，最多等到 `maxMs`。
 * 仅手动路径使用；cron 路径不调用本函数（调用方直接跳过）。
 * 返回最后一次探测结果 —— 若仍是 pending/processing，表示"超时未定终态"，**不算失败**。
 */
async function waitForChallenge(client_data: any, challenge: any, maxMs: number): Promise<ChallengeProbe> {
    const deadline = Date.now() + Math.max(0, maxMs);
    for (;;) {
        const probe: ChallengeProbe = await probeChallenge(client_data, challenge);
        if (probe.status !== "pending" && probe.status !== "processing") return probe; // 已定终态或读取失败
        if (Date.now() + CHALLENGE_POLL_INTERVAL_MS > deadline) return probe;          // 到点，仍非终态
        await sleep(CHALLENGE_POLL_INTERVAL_MS);
    }
}

/**
 * 以受限预算执行 `verifyChallenge`。
 * acme-client 默认 `backoffOpts` 是 `attempts:10 / min:5000 / max:30000`，最坏会在一次同步请求里
 * 退避 ≈3.5 分钟；而"本地可解析性"外层已经用 `dnsCheck` 查过一次，没必要再等这么久。
 * 这里临时压缩预算（`finally` 恢复，避免污染同一 Client 实例上的其它调用）。
 * 压缩后失败会很快抛出，由订单级状态机（flag=2「待验证」）在下一轮重试。
 */
async function verifyChallengeBounded(client_data: any, authz: any, challenge: any) {
    const saved = client_data.backoffOpts;
    client_data.backoffOpts = {attempts: VERIFY_CHALLENGE_ATTEMPTS, min: 1000, max: 1000};
    try {
        return await client_data.verifyChallenge(authz, challenge);
    } finally {
        client_data.backoffOpts = saved;
    }
}

// 执行域名验证 ====================================================================================
// 挑战状态机（RFC 8555 §7.1.6）—— 本函数是唯一的判定点，语义显式：
//   valid      → CA 已完成，该域名推进到 flag=4（进入签发阶段）
//   invalid    → 终态失败，规范禁止重试，该域名置 flag=-1，必须重新申请
//   processing → 已触发，CA 正在核验。**只能"继续等"**：规范只允许对 pending 挑战发起触发，
//                重复提交是非法操作；且本轮开头的 getAuthy 已取到最新状态，无需再同步轮询
//                → 保持 flag=3，交由下一次触发 / 定时任务继续推进
//   pending    → 尚未触发，需要提交。**只有这一步才做本地 DNS 校验**（dnsCheck）：
//                本地未就绪 → flag=2「待验证」；
//                本地就绪 → verifyChallenge（受限预算）+ completeChallenge + 有界等待
//   其它/未知  → 保守处理：不推进、不判失败，保持"验证中"
//
// 三条核心原则：
//   ① **CA 的真实状态优先于本地 DNS 校验** —— 挑战已是 valid/invalid/processing 时，
//      本地 TXT 是否还在与判定无关（例如验证通过后清理了 DCV 记录），
//      绝不能用本地 dnsCheck 的结果把 CA 已完成的订单打回 flag=2。
//   ② **非终态失败不判死** —— 只有 CA 明确判 invalid 才置 -1；其余失败按
//      "尚未提交成功 → 2 / 已提交但未定终态 → 3" 分类，避免误杀健康订单。
//   ③ **长轮询不留在同步请求里（Step 1）** —— 提交成功后不再调用 waitForValidStatus：
//      cron 路径（wait_ms = 0）立即返回 flag=3，结果交给下一次触发读取；
//      手动路径（wait_ms > 0）只做有界短轮询，超时未定终态同样保持 flag=3。
//
// 订单级 flag 由循环结束后按显式规则汇总（见函数末尾），不再依赖 status_flag 初值隐式推进到 4。
//
// @param wait_ms 提交后的有界等待预算（毫秒）。0 = 自动路径（cron），提交后立即返回；
//                >0 = 手动路径，最多等这么久（由 `MANUAL_WAIT_MS` 配置提供）
export async function dnsAuthy(env: Bindings, order_user: any, order_info: any, wait_ms: number = 0) {
    let domain_list: any = order_info['list'];
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    let author_save: Record<string, Record<string, any>> = await getAuthy(client_data, orders_data)
    // 验证所有域名 ================================================================================
    let domain_save: any[] = [] // 需要最后保存的域名详细验证数据
    let domain_fail: string[] = [];    // 终态失败原因（写入订单 text）
    let domain_pending: string[] = []; // 「待验证」原因（写入订单 text）
    let domain_wait: string[] = [];    // 「验证中」原因（写入订单 text）
    let status_fail: boolean = false;     // 是否出现终态失败（-1）
    let status_pending: boolean = false;  // 是否有域名处于「待验证」（2）
    for (let domain_item of JSON.parse(domain_list)) { // 验证DNS
        if (status_fail) { // 已出现终态失败：其余域名只落库，不再发起 CA 请求
            domain_save.push(domain_item);
            continue
        }
        let author_data: Record<string, any> = author_save[domain_item.name]
        // 未取到挑战（该域名没拿到 dns-01 / http-01）→ 本地未就绪，等下次重试，不是终态失败
        if (author_data == undefined) {
            console.log(domain_item.name, false);
            domain_item.flag = 2;
            status_pending = true;
            domain_pending.push(domain_item.name + ": 未获取到验证挑战");
            domain_save.push(domain_item);
            continue
        }
        let challenge_status: string = String(author_data.data['status'] || "");
        console.log('挑战状态:', domain_item.name, challenge_status);
        // ① CA 的真实状态优先于本地 DNS 校验 ==========================================================
        if (challenge_status == "valid") { // CA 已完成 ================================================
            domain_item.flag = 4;
        } else if (challenge_status == "invalid") { // 终态失败 =========================================
            // 挑战在 CA 侧已是终态 invalid（RFC 8555 规定不可重试，必须新建订单）。
            // 原因从 `challenge.error.detail` 取 —— 拆掉 waitForValidStatus 后不再有异常携带它（G1）。
            const invalid_reason: string = challengeErrorReason(author_data.data);
            console.log('抛错:Challenge Already Invalid:', domain_item.name, invalid_reason,
                JSON.stringify(author_data.data));
            domain_fail.push(domain_item.name + ": " +
                (invalid_reason || "已被 CA 标记为 invalid（不可重试，需重新申请）"));
            domain_item.flag = -1;
            status_fail = true;
        } else if (challenge_status == "processing") { // 已提交，只能"继续等" ==========================
            // RFC 8555 §7.1.6：只有 pending 状态的挑战可以被触发，重复 POST 属非法操作
            // → **绝不重新提交**。
            // 也不在这里同步轮询：本轮开头的 getAuthy 取到的就是最新状态，
            // 能秒级定终态的 CA 早在上一轮 pending 分支的轮询里就返回了，
            // 再同步等 3.5 分钟收益极低，而长轮询正是此前"订单卡在验证中"的成因。
            // 语义 = "继续等"：保持 flag=3，交由下一次触发 / 定时任务继续推进。
            console.log('验证2:Domain Remote Upload Status: 跳过重复提交（挑战已在 processing，规范只允许 pending 触发）');
            domain_wait.push(domain_item.name + ": CA 仍在核验（processing）");
        } else if (challenge_status == "pending") { // 尚未触发：只有这里才做本地校验 ===================
            // web-self（http-01验证）不需要DNS检查，直接提交验证
            let author_flag: boolean = domain_item.type === "web-self"
                ? true : await dnsCheck(author_save, domain_item)
            console.log(domain_item.name, author_flag);
            if (!author_flag) {
                // 本地看不到 TXT/CNAME = DNS 尚未生效，等用户处理；这不是终态失败
                domain_item.flag = 2;
                status_pending = true;
                domain_pending.push(domain_item.name + ": 本地未查到 _acme-challenge 记录");
            } else {
                let submitted: boolean = false; // completeChallenge 是否已成功提交
                try {
                    // ① 提交前复核本地可解析性（预算已压缩到 ~1 秒，见 verifyChallengeBounded）
                    let upload_flag: boolean = await verifyChallengeBounded(client_data, author_data.auth, author_data.data);
                    console.log('验证1:Domain Server Verify Status:', upload_flag, JSON.stringify(upload_flag));
                    // ② 提交触发（RFC 8555：只有 pending 挑战可被触发）
                    let submit_flag = await client_data.completeChallenge(author_data.data);
                    submitted = true;
                    console.log('验证2:Domain Remote Upload Status:', submit_flag['status'], JSON.stringify(submit_flag));

                    // ③ 等待结果 —— **不再同步长轮询**
                    if (wait_ms > 0) {
                        // 手动路径：有界短轮询（默认 ≤60 秒）
                        const probe: ChallengeProbe = await waitForChallenge(client_data, author_data.data, wait_ms);
                        console.log('验证3:Domain Remote Verify Status:', probe.status, JSON.stringify(probe));
                        if (probe.status == "valid") {
                            domain_item.flag = 4;
                        } else if (probe.status == "invalid") {
                            // 轮询期间 CA 判了终态失败：与上面的 invalid 分支同义，直接落 -1
                            console.log('抛错:Challenge Invalid During Wait:', domain_item.name, probe.reason);
                            domain_fail.push(domain_item.name + ": " +
                                (probe.reason || "CA 判定验证失败（不可重试，需重新申请）"));
                            domain_item.flag = -1;
                            status_fail = true;
                        } else {
                            // 超时仍未定终态 / 状态读取失败 → 保持「验证中」，不算失败
                            domain_wait.push(domain_item.name + ": " +
                                (probe.status || "状态读取失败") + (probe.reason ? " —— " + probe.reason : ""));
                        }
                    } else if (String(submit_flag['status'] || "") == "valid") {
                        // 自动路径：CA 在提交响应里就给了 valid，直接推进
                        domain_item.flag = 4;
                    } else {
                        // 自动路径：提交成功但未定终态 → 立即返回 flag=3，
                        // 结果由下一次触发（cron / 手动）读取。**这就是 Step 1 的核心。**
                        domain_wait.push(domain_item.name + ": 已提交，等待 CA 核验");
                    }
                } catch (error: any) {
                    // 把 CA 返回的真实原因取出来（此前只打了 Error 对象，
                    // Cloudflare 日志只渲染 stack，message 被淹没）。
                    // acme-client 抛出的 Error.message 就是 ACME Problem Details 的 detail
                    // （见 util.formatResponseError）；其它错误用 extractAcmeError 兜底。
                    const reason: string = (error && error.message)
                        ? String(error.message) : extractAcmeError(error);
                    console.log('抛错1:Domain Remote Verify Reason:', reason);
                    console.log('抛错2:Domain Remote Verify Raw:', extractAcmeError(error));
                    console.log('抛错3:Domain Remote Verify Error:', error);
                    // 失败分类（不再一律置 -1）：只有 CA 明确判 invalid 才是终态失败。
                    //   ① CA 判 invalid → -1（真失败，必须重新申请）
                    //   ② 尚未提交成功（verifyChallenge / completeChallenge 失败）→ 2「待验证」：
                    //      CA 侧挑战多半仍是 pending，订单并没有死，可以重试
                    //   ③ 已提交但未定终态（网络中断 / 非 200 等）→ 3「验证中」，绝不误杀
                    const probe: ChallengeProbe = await probeChallenge(client_data, author_data.data);
                    if (probe.status === "invalid") {
                        domain_fail.push(domain_item.name + ": " + (probe.reason || reason));
                        domain_item.flag = -1;
                        status_fail = true;
                    } else if (!submitted) {
                        console.log('抛错:Domain Remote Verify 尚未提交成功，回到「待验证」；CA 侧状态:', probe.status || "(未取到)");
                        domain_item.flag = 2;
                        status_pending = true;
                        domain_pending.push(domain_item.name + ": " + reason);
                    } else {
                        console.log('抛错:Domain Remote Verify 已提交但未定终态，保持「验证中」；CA 侧状态:', probe.status || "(未取到)");
                        domain_wait.push(domain_item.name + ": " + reason);
                    }
                }
            }
        } else { // 未知状态：保守处理，不推进、不判失败 =================================================
            console.log('警告:Challenge Unknown Status:', domain_item.name, JSON.stringify(author_data.data));
            domain_wait.push(domain_item.name + ": 未知挑战状态 " + JSON.stringify(challenge_status));
        }
        domain_save.push(domain_item);
    }
    // 订单级 flag 汇总（显式规则，取代原先"status_flag 初值=4"的隐式推进）===========================
    //   -1 : 任一域名终态失败
    //    2 : 有域名处于「待验证」（本地未就绪 / 尚未提交成功）
    //    4 : 所有域名均已通过验证（全部 domain_item.flag >= 4）
    //    3 : 其余情况 —— 仍有域名在 CA 侧等待（pending/processing/未知），保持"验证中"
    let status_flag: number;
    if (status_fail) status_flag = -1;
    else if (status_pending) status_flag = 2;
    else if (domain_save.length > 0 && domain_save.every((d: any) => Number(d.flag) >= 4)) status_flag = 4;
    else status_flag = 3;

    orders_data = await client_data.getOrder(orders_text);
    // console.log(orders_data);
    await saves.updateDB(env.DB_CF, "Apply", {data: JSON.stringify(orders_data)}, {uuid: order_info['uuid']})
    await saves.updateDB(env.DB_CF, "Apply", {list: JSON.stringify(domain_save)}, {uuid: order_info['uuid']})
    await saves.updateDB(env.DB_CF, "Apply", {flag: status_flag}, {uuid: order_info['uuid']})
    if (status_flag == -1) await saves.updateDB(env.DB_CF, "Apply", {
        text: "域名验证失败:" + JSON.stringify(domain_fail)
    }, {uuid: order_info['uuid']})
    else if (status_flag == 2) await saves.updateDB(env.DB_CF, "Apply", {
        text: "待验证" + (domain_pending.length > 0 ? "：" + JSON.stringify(domain_pending) : "") + "，请处理后重试"
    }, {uuid: order_info['uuid']})
    else if (status_flag == 3) await saves.updateDB(env.DB_CF, "Apply", {
        text: "域名验证中：CA 仍在核验" +
            (domain_wait.length > 0 ? " —— " + JSON.stringify(domain_wait) : "") + "，请稍后重试"
    }, {uuid: order_info['uuid']})
    else await saves.updateDB(env.DB_CF, "Apply", {text: "域名验证通过"}, {uuid: order_info['uuid']})
    return {"texts": "处理成功"};
}

// 完成证书申请 #######################################################################################################
export async function getCerts(env: Bindings, order_user: any, order_info: any) {
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    // console.log(orders_data);
    console.log('Orders Remote Verify Status:', orders_data.status);
    if (orders_data.status == "invalid") {
        await saves.updateDB(env.DB_CF, "Apply", {flag: -1}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {text: "证书签发失败"}, {uuid: order_info['uuid']})
        return {"texts": "验证状态无效"};
    }
    if (orders_data.status === 'ready') {
        let domainsListCSR: any = await getNames(order_info, false);
        let privateKeyText = null // 私钥创建过程 ===================================================================
        if (order_info['type'] == "rsa2048") privateKeyText = await acme.crypto.createPrivateRsaKey(2048);
        if (order_info['type'] == "eccp256") privateKeyText = await acme.crypto.createPrivateEcdsaKey('P-256');
        if (order_info['type'] == "eccp384") privateKeyText = await acme.crypto.createPrivateEcdsaKey('P-384');
        let [privateKeyBuff, certificateCSR] = await acme.crypto.createCsr({ // 创建证书请求 ==============================
            altNames: domainsListCSR, commonName: domainsListCSR[0], country: order_info['C'], state: order_info['S'],
            locality: order_info['ST'], organization: order_info['O'], organizationUnit: order_info['OU']
        }, privateKeyText || "");
        await saves.updateDB(env.DB_CF, "Apply", {keys: privateKeyBuff.toString()}, {uuid: order_info['uuid']})
        const finish_text: any = await client_data.finalizeOrder(orders_data, certificateCSR);// 最终确认订单
        console.log('Orders Remote Finish Status:', finish_text);
        await saves.updateDB(env.DB_CF, "Apply", {text: "证书签发请求提交成功"}, {uuid: order_info['uuid']})
    }
    if (orders_data.status === 'processing') {
        console.log('Orders Remote Finish Status:', "Certificate Processing");
        await saves.updateDB(env.DB_CF, "Apply", {text: "证书正在等待完成签发"}, {uuid: order_info['uuid']})
    }
    if (orders_data.status === 'valid') {
        const certificate: any = await client_data.getCertificate(orders_data);// 获取证书
        // console.log('Orders Remote Issues Status:', certificate);
        await saves.updateDB(env.DB_CF, "Apply", {cert: certificate}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {flag: 5}, {uuid: order_info['uuid']})
        const timestamp = new Date(new Date().setDate(new Date().getDate() + 90)).getTime();
        await saves.updateDB(env.DB_CF, "Apply", {next: timestamp}, {uuid: order_info['uuid']})
        await saves.updateDB(env.DB_CF, "Apply", {text: "恭喜！证书已成功签发"}, {uuid: order_info['uuid']})
        // await saves.updateDB(env.DB, "Apply", {data: ""}, {uuid: order_info['uuid']})
    }
    return {"texts": "处理成功"};
}

// 吊销证书 ########################################################################################
// RFC 5280 吊销原因码（Let's Encrypt 目前常用支持：0/1/3/4/5）
// 参考：https://datatracker.ietf.org/doc/html/rfc5280#section-5.3.1
//  0 unspecified            未指定（默认）
//  1 keyCompromise          密钥已泄露
//  3 affiliationChanged     归属关系变更
//  4 superseded             已被新证书替代
//  5 cessationOfOperation   停止运营
export const REVOKE_REASONS = new Set<number>([0, 1, 2, 3, 4, 5, 6, 8, 9, 10]);

export async function revokeCert(env: Bindings, order_info: any, reason: number = 0) {
    // 基本校验：必须存在证书原文 =====================================================================
    const cert_pem: string = order_info?.cert || "";
    if (!cert_pem || !/BEGIN CERTIFICATE/.test(cert_pem)) {
        return {"flags": 5, "texts": "当前订单未签发证书，无需吊销"};
    }
    // 读取申请者信息用于获取 ACME 账户上下文 =========================================================
    let order_user: any = (await saves.selectDB(
        env.DB_CF, "Users", {mail: {value: order_info['mail']}}))[0];
    if (!order_user) return {"flags": 5, "texts": "找不到订单对应的用户信息"};
    // 组装 ACME Client ============================================================================
    let client_data: any;
    try {
        client_data = await getStart(env, order_user, order_info);
    } catch (e) {
        const msg = extractAcmeError(e);
        return {"flags": 5, "texts": "ACME 账户初始化失败: " + msg};
    }
    if (client_data == null) return {"flags": 5, "texts": "ACME 账户初始化失败"};
    // 规整 reason 参数 =============================================================================
    let reason_code = Number(reason);
    if (!Number.isFinite(reason_code) || !REVOKE_REASONS.has(reason_code)) reason_code = 0;
    // 调用 ACME 吊销接口 ===========================================================================
    try {
        await client_data.revokeCertificate(cert_pem, {reason: reason_code});
    } catch (e: any) {
        const msg = extractAcmeError(e);
        console.error("revokeCert acme error:", e);
        // 记录失败原因，但不修改订单状态，允许用户重新尝试
        try {
            await saves.updateDB(env.DB_CF, "Apply",
                {text: "证书吊销失败: " + msg},
                {uuid: order_info['uuid']});
        } catch {/* ignore */}
        return {"flags": 5, "texts": "证书吊销失败: " + msg};
    }
    // 吊销成功：更新订单状态为已失效（-1），并清空 cert/keys，便于用户重新申请 =========================
    const timestamp = Date.now();
    await saves.updateDB(env.DB_CF, "Apply",
        {flag: -1, text: "证书已吊销 (reason=" + reason_code + ")", next: timestamp},
        {uuid: order_info['uuid']});
    return {"flags": 0, "texts": "证书吊销成功"};
}

// 获取域名信息 ####################################################################################
async function getNames(order_info: any, full: boolean = false) {
    // 处理域名信息 ================================================================================
    let domain_save: string[] | Record<string, any> = [];
    let domain_data = JSON.parse(order_info['list']);
    for (const uid in domain_data) {
        const domain_now = domain_data[uid];
        // console.log("domain_now: ", domain_now);
        const author_now = domain_now['type'].split("-")[0]
        // 判断是否为IP证书
        const isIP = !!domain_now['isIP'];
        if (full) {
            domain_save.push({
                type: isIP ? 'ip' : author_now,
                value: domain_now['name']
            });
        } else {
            domain_save.push(domain_now['name']);
        }
    }
    return domain_save;
}

// 获取操作接口 ####################################################################################
async function getStart(env: Bindings, order_user: any, order_info: any) {
    let acme_url = acme_url_map[order_info['sign']];
    // 从 Confs 优先读取三家 CA 的账户凭据（回退到 env / 默认值）
    const [GTS_KeyTS, GTS_keyID, GTS_keyMC,
        SSL_KeyTS, SSL_keyID, SSL_keyMC,
        ZRO_KeyTS, ZRO_keyID, ZRO_keyMC] = await Promise.all([
        readConf(env as any, "GTS_KeyTS"),
        readConf(env as any, "GTS_keyID"),
        readConf(env as any, "GTS_keyMC"),
        readConf(env as any, "SSL_KeyTS"),
        readConf(env as any, "SSL_keyID"),
        readConf(env as any, "SSL_keyMC"),
        readConf(env as any, "ZRO_KeyTS"),
        readConf(env as any, "ZRO_keyID"),
        readConf(env as any, "ZRO_keyMC"),
    ]);
    const acme_key_map: Record<string, any> = {
        "lets-encrypt": order_user['keys'],
        "google-trust": GTS_KeyTS,
        "bypass-trust": order_user['keys'],
        "zeroca-trust": ZRO_KeyTS,
        "sslcom-trust": SSL_KeyTS,
    }
    const acme_eab_map: Record<string, any> = {
        "lets-encrypt": undefined,
        "google-trust": {kid: GTS_keyID, hmacKey: GTS_keyMC,},
        "bypass-trust": undefined,
        "zeroca-trust": {kid: ZRO_keyID, hmacKey: ZRO_keyMC,},
        "sslcom-trust": {kid: SSL_keyID, hmacKey: SSL_keyMC,}
    }
    if (order_info['sign'] == "sslcom-trust") acme_url += order_info['type'].substring(0, 3);
    let client_data: Client = new acme.Client({
        directoryUrl: acme_url,
        accountKey: acme_key_map[order_info.sign],
        externalAccountBinding: acme_eab_map[order_info.sign],
    });
    try { // 获取账户信息 ================================
        client_data.getAccountUrl();
    } catch (e) { // 尝试创建账户 ========================
        try {
            await client_data.createAccount({
                termsOfServiceAgreed: true,
                contact: ['mailto:' + order_user['mail']],
            });
        } catch (e) {
            if (e instanceof Error) {
                console.error("Error stack:", e.stack);
                console.error("Error message:", e.message);
            } else {
                console.error("An unknown error occurred:", e);
            }
            throw e;
            // return null
        }
    }
    return client_data;
}

// 获取验证数据 ####################################################################################
async function getAuthy(client_data: any, orders_data: any) {
    let author_list: any[] = await client_data.getAuthorizations(orders_data);
    let author_maps: Record<string, any> = {}
    // console.log("author_list: ", author_list);
    for (const author_data of author_list) {
        // 待验证信息 ======================================
        let author_info: any = author_data['identifier'];
        let author_name: string = author_info['value'];
        if (author_data['wildcard'] === true)
            author_name = "*." + author_name;
        // let author_type: string = author_info['type'];
        // 查找验证信息（优先dns-01，IP证书使用http-01）=================================
        let author_save = undefined
        // console.log(author_data)
        for (const c of author_data['challenges']) {
            if (c.type === "dns-01") {
                author_save = c
                break
            }
        }
        // 如果没有dns-01（如IP证书），尝试http-01
        if (author_save == undefined) {
            for (const c of author_data['challenges']) {
                if (c.type === "http-01") {
                    author_save = c
                    break
                }
            }
        }
        if (author_save == undefined) continue
        let author_text = await client_data.getChallengeKeyAuthorization(author_save)
        console.log(author_text);
        // 返回结果 ========================================
        // console.log(author_name, author_type, author_save['token']);
        author_maps[author_name] = {
            text: author_text,
            data: author_save,
            auth: author_data,
        }
    }
    // console.log(author_maps);
    return author_maps;
}

async function dnsCheck(author_save: any, domain_item: any) {
    if (author_save[domain_item.name] == undefined) return false;
    // 设置数据 =============================================
    let domain_name = domain_item.name.replaceAll("*.", "")
    let author_text = domain_item.auth; // 目标解析记录
    let domain_type = "TXT" // 待验证域名格式文本TXT
    if (domain_item.type == "dns-auto") { // 如果DNS-AUTO模式
        domain_type = "CNAME" // 此时需检查CNAME而不是TXT记录
        author_text = domain_item.auto // 验证内容也改为CNAME
    } // 查询DNS ============================================
    let author_flag: boolean = false // 任意一个DNS正确则通过
    let record_list: any = await query.queryDNS(
        "_acme-challenge." + domain_name, domain_type)
    // console.log('Records for', domain_name, ':');
    for (let record_item of record_list) { // 查询所有DNS记录
        // console.log(record_item['data']);
        // console.log(author_text);
        if (record_item['data'] == author_text) {
            author_flag = true;
            break;
        }
    }
    // console.log(author_flag);
    return author_flag;
}

async function dnsOrder(author_save: any, domain_item: any) {

}