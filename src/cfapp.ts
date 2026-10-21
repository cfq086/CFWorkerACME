import * as index from './index'
import * as certs from './certs'
import * as notify from './notify'
import {cleanDNS} from './query'
import {isScannerProbe} from './utils/probe-guard'

// 扫描器探测拦截 ###############################################################################
// 必须在静态资源与 SPA 兜底**之前**：否则 `/.env`、`/phpinfo.php` 这类路径会被兜底成
// 200 + index.html，扫描器据此认为"文件存在"，会一直扫（日志里能看到成片的 .env 探测）。
// 见 src/utils/probe-guard.ts
index.app.use("*", async (c, next) => {
    if (isScannerProbe(new URL(c.req.url).pathname)) {
        return c.text("Not Found", 404);
    }
    await next();
});

// SPA fallback ###############################################################################
// 静态文件由 Cloudflare 资产层（Workers Static Assets）**直接**返回 —— 带压缩、ETag 与 CDN 缓存，
// 且完全不进 Worker（没有冷启动开销）。能走到这里说明没有命中任何静态文件，
// 分两种情况：
//   ① SPA 路由（/certs、/order/xxx、/admin/...）→ 返回入口 HTML，交给前端路由
//   ② 真的不存在 → 同样返回入口 HTML（由前端自己出 404 页）
// ⚠️ 必须在 probe-guard 中间件**之后**注册：Hono 按注册顺序执行，
//    否则敏感路径会被这里兜底成 200。
// ⚠️ 不要给入口 HTML 加长缓存：否则发版后用户会一直拿旧的 index.html。
index.app.get("*", async (c) => {
    const res = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
    res.headers.set("Cache-Control", "no-cache");
    return res;
});
// export default index.app
index.app.fire()

// 定时任务 ############################################################################################################
// ⚠️ 下面两个常量必须与 `wrangler.jsonc` 的 `triggers.crons` **完全一致**
//    （`controller.cron` 是字符串，按值分发；改一边记得改另一边）。
// ⚠️ cron 走的是 **UTC**：`0 3 * * *` = 北京时间 11:00。
//
// 为什么把「自动续期 + DCV 清理」合并成一条（原来是两条）：
//   ① Cloudflare 的 cron 额度是**按账户**算的（免费 5 个），合并少占一个额度；
//   ② 两者都是**每天一次**、错开半小时并无收益，合并后共享一次触发；
//   ③ 失败隔离不丢：合并的两个步骤**各自** try/catch（见下方 runTask），
//      续期失败不会妨碍清理继续执行。
// ⚠️ 合并的代价：两者共享同一 invocation 的 duration/CPU 预算。续期侧已用
//    `CRON_RENEW_SCAN`（默认 20）作为兜底上限 —— 正常路径下 SQL 层已只返回"真的要续期"的几张。
// ⚠️ 下面的表达式是 5 字段标准 cron（分 时 日 月 周），**末尾不能有多余空格**：
//    `controller.cron` 在 runCronTask 里会被 trim + 空白折叠再与常量比较，
//    若常量本身带尾随空格，两边永远不相等 → 自动推进会走 "unknown" 分支被静默忽略。
const CRON_PUSH = "*/10 0-16 * * *";   // 自动推进：每 10 分钟（仅 UTC 0–16 点 = 北京 08–24 点，夜里不跑）
const CRON_DAILY = "0 3 * * *";     // 每日维护（自动续期 + DCV 清理）：UTC 03:00 = 北京 11:00

/** 统一的单任务执行包装：独立 try/catch + 耗时日志，一个任务出错不影响其它任务 */
async function runTask(name: string, fn: () => Promise<any>): Promise<void> {
    const t0 = Date.now();
    try {
        const r: any = await fn();
        console.log(`[cron] ${name} 完成，耗时 ${Date.now() - t0}ms`, r?.text ?? "");
    } catch (e) {
        console.error(`[cron] ${name} 失败（耗时 ${Date.now() - t0}ms）:`, e);
    }
}

/**
 * 按 cron 表达式分发任务。
 * 抽成独立函数是为了能单测（`scheduled()` 里只做一层转发）。
 * 比较前做空白归一化（trim + 连续空白折叠），避免手写表达式时的空格差异导致匹配不上。
 *
 * @returns 命中的任务名；未识别返回 "unknown"
 */
export async function runCronTask(cron: string, env: index.Bindings): Promise<string> {
    const norm = (s: string): string => String(s ?? "").trim().replace(/\s+/g, " ");
    const key: string = norm(cron);
    if (key === norm(CRON_PUSH)) {
        await runTask("自动推进", () => certs.Processing(env));
        return "push";
    }
    if (key === norm(CRON_DAILY)) {
        // 每日维护：先续期、再清理、最后发到期提醒。
        // 顺序说明：续期只是把 flag=5 置回 flag=0（不在清理的终止范围内），
        // 而清理只终止仍卡在 flag 1/2/3 的订单 —— 两者互不干扰；
        // 业务上让续期先跑，清理的"终止卡死订单"就看到本轮最新的订单状态。
        // 到期提醒放最后：续期已把 30 天内的订单置 0，这里只剩「关掉自动续期且 7 天内到期」的，
        // 不会和续期流程重复打扰用户。
        // 三步各自走 runTask（内部 try/catch），任一步失败不影响另一步。
        await runTask("自动续期", () => certs.renewCerts(env));
        await runTask("DCV 清理", () => cleanDNS(env));
        await runTask("到期提醒", () => notify.notifyExpiring(env));
        return "daily";
    }
    console.error("[cron] 未识别的 cron 表达式，已忽略:", JSON.stringify(cron),
        "（期望：", CRON_PUSH, "/", CRON_DAILY, "）");
    return "unknown";
}

export default {
    async fetch(request: Request, env: index.Bindings, ctx: ExecutionContext) {
        return index.app.fetch(request, env, ctx);
    },
    async scheduled(controller: ScheduledController, env: index.Bindings, ctx: ExecutionContext) {
        console.log('[cron] 触发:', controller.cron,
            new Date(controller.scheduledTime).toISOString());
        try {
            await runCronTask(String(controller.cron ?? ""), env);
        } catch (error) {
            // runTask 内部已兜住单任务异常，这里只是最后一道保险
            console.error('[cron] 调度层异常:', error);
        }
    },
};
