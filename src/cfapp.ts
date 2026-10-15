import {serveStatic} from 'hono/cloudflare-workers' // @ts-ignore
import manifest from '__STATIC_CONTENT_MANIFEST'
import * as index from './index'
import * as certs from './certs'
import {cleanDNS} from './query'

// SPA fallback: 尝试访问请求路径对应的静态文件，失败后回退到 index.html
index.app.use("*", serveStatic({manifest: manifest, root: "./"}));
index.app.get("*", serveStatic({
    manifest: manifest,
    root: "./",
    path: "index.html",
} as any));
// export default index.app
index.app.fire()

// 定时任务 ############################################################################################################
// ⚠️ 下面三个常量必须与 `wrangler.jsonc` 的 `triggers.crons` **完全一致**
//    （`controller.cron` 是字符串，按值分发；改一边记得改另一边）。
// ⚠️ cron 走的是 **UTC**：`0 3 * * *` = 北京时间 11:00。
// 三个任务**分开跑**（各自独立的 cron 表达式）：失败隔离、预算隔离、频率可以各不相同。
const CRON_PUSH = "*/10 * * * *";   // 自动推进：每 10 分钟
const CRON_RENEW = "0 3 * * *";     // 自动续期：每天 UTC 03:00（北京 11:00）
const CRON_CLEAN = "30 3 * * *";    // DCV 清理：每天 UTC 03:30（北京 11:30）

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
    const key: string = String(cron ?? "").trim().replace(/\s+/g, " ");
    if (key === CRON_PUSH) {
        await runTask("自动推进", () => certs.Processing(env));
        return "push";
    }
    if (key === CRON_RENEW) {
        await runTask("自动续期", () => certs.renewCerts(env));
        return "renew";
    }
    if (key === CRON_CLEAN) {
        await runTask("DCV 清理", () => cleanDNS(env));
        return "clean";
    }
    console.error("[cron] 未识别的 cron 表达式，已忽略:", JSON.stringify(cron),
        "（期望：", CRON_PUSH, "/", CRON_RENEW, "/", CRON_CLEAN, "）");
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
