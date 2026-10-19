/**
 * 证书事件邮件通知
 * ---------------------------------------------------------------------------
 * 为什么单独一个模块：邮件模板、开关判定、去重、限流都是"通知"的关注点，
 * 混进 `certs.ts` 会让状态机更难读；而且 `certs.ts` 只该关心"订单状态怎么走"。
 *
 * 四条铁律：
 *   1. **绝不抛错** —— 邮件发送失败只能记日志，不能影响订单状态推进。
 *   2. **尊重开关** —— `MAIL_ENABLED` 是通知总开关（不影响注册验证码），
 *      再按事件查 `NOTIFY_ON_SUCCESS` / `NOTIFY_ON_FAIL` / `NOTIFY_ON_EXPIRE7`。
 *   3. **去重** —— 到期提醒用 `Apply.notify_flags` 位掩码，否则 daily cron 会天天重复发；
 *      签发成功时重置为 0（新证书重新计时）。
 *   4. **限流** —— 单轮最多发 `NOTIFY_LIMIT` 封：免费版每次 cron 只有 50 个子请求，
 *      而 `0 3 * * *` 那条 cron 还要跑续期与 DCV 清理。
 */

import * as saves from "./saves";
import {readBool, readConf} from "./db/conf";
import {mailSendRaw} from "./users";

/** 通知事件 */
export type NotifyEvent = "pending" | "issued" | "failed" | "expiring7";

/** 事件 → 配置开关（`pending` 与 `issued` 共用 NOTIFY_ON_SUCCESS） */
const SWITCH_KEY: Record<NotifyEvent, string> = {
    pending: "NOTIFY_ON_SUCCESS",
    issued: "NOTIFY_ON_SUCCESS",
    failed: "NOTIFY_ON_FAIL",
    expiring7: "NOTIFY_ON_EXPIRE7",
};

/** 单轮到期提醒最多发几封（保护免费版 50 子请求配额） */
const NOTIFY_LIMIT = 5;

/**
 * `notify_flags` 位定义
 *   bit0：已发「7 天后到期」
 *   bit1：已发「待验证 / 请配置 DNS」—— 只发一次，否则用户每点一次验证就会重复收到
 */
export const FLAG_EXPIRE7 = 1;
export const FLAG_PENDING = 2;

/**
 * **只有这三个状态才发通知**：`2` 待验证 / `5` 已完成 / `-1` 失败。
 * 中间状态（0 新建、1 写挑战、3 验证中、4 签发中）一律不发 —— 自动推进每 10 分钟一轮，
 * 若在中间状态发信会非常吵。这道白名单是防止将来误加调用点的兜底。
 */
const NOTIFIABLE_FLAGS = new Set([2, 5, -1]);

/** 通知总开关 + 事件开关 */
async function enabled(env: any, event: NotifyEvent): Promise<boolean> {
    if (!await readBool(env, "MAIL_ENABLED", false)) return false;
    return await readBool(env, SWITCH_KEY[event], true);
}

/** 站点地址（邮件里的订单链接用），去掉结尾斜杠 */
async function siteHost(env: any): Promise<string> {
    const host = String((await readConf(env, "SITE_HOST")) ?? "").trim();
    return host.replace(/\/+$/, "");
}

function fmtDate(ts: number): string {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toISOString().slice(0, 10);
}

/** 从订单的 `list` 取域名（解析失败返回空数组，不让脏数据阻断通知） */
export function domainsOf(order: any): string[] {
    try {
        const list = typeof order?.list === "string" ? JSON.parse(order.list) : order?.list;
        if (!Array.isArray(list)) return [];
        return list.map((d: any) => String(d?.name ?? "")).filter(Boolean);
    } catch {
        return [];
    }
}

const SIGN_LABEL: Record<string, string> = {
    "lets-encrypt": "Let's Encrypt",
    "google-trust": "Google Trust Services",
    "zeroca-trust": "ZeroSSL",
    "sslcom-trust": "SSL.com",
    "bypass-trust": "自签 / 跳过",
};

function row(k: string, v: string): string {
    return `<tr><td style="padding:3px 12px 3px 0;color:#666;white-space:nowrap">${k}</td>` +
        `<td style="padding:3px 0">${v}</td></tr>`;
}

function wrap(title: string, rows: string[], footer: string): string {
    return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;` +
        `font-size:14px;line-height:1.7;color:#222">` +
        `<h2 style="margin:0 0 12px;font-size:17px">${title}</h2>` +
        `<table style="border-collapse:collapse">${rows.join("")}</table>` +
        `<p style="margin:16px 0 0;color:#888;font-size:12px">${footer}</p></div>`;
}

/**
 * 组装邮件内容（纯函数，便于单测）。
 * @param order 需含 mail / uuid / list / sign / next / text
 */
export async function buildMail(
    env: any, event: NotifyEvent, order: any, extra?: any,
): Promise<{ subject: string; html: string }> {
    const domains = domainsOf(order);
    const domainText = domains.length ? domains.join("、") : "-";
    const first = domains[0] || String(order?.uuid ?? "");
    const base = await siteHost(env);
    const link = base ? `${base}/#/order/${order?.uuid ?? ""}` : "";
    const linkRow = link ? row("查看订单：", `<a href="https://${link}">${link}</a>`) : "";
    const caText = SIGN_LABEL[String(order?.sign ?? "")] || String(order?.sign ?? "-");

    if (event === "pending") {
        return {
            subject: `【待验证】请为 ${first} 配置 DNS 记录`,
            html: wrap("请配置 DNS 记录", [
                row("域名：", domainText),
                row("当前状态：", "等待配置 DNS 验证记录"),
                linkRow,
            ], "请到订单页按提示添加 TXT 记录，配置生效后点击「验证全部」即可继续签发。"),
        };
    }

    if (event === "issued") {
        return {
            subject: `【证书签发成功】${first}`,
            html: wrap("证书签发成功 🎉", [
                row("域名：", domainText),
                row("证书厂商：", caText),
                row("到期时间：", fmtDate(Number(order?.next ?? 0))),
                linkRow,
            ], "已开启自动续期的证书会在到期前 30 天自动续签；未开启请及时手动续期。"),
        };
    }

    if (event === "failed") {
        return {
            subject: `【证书申请失败】${first}`,
            html: wrap("证书申请失败", [
                row("域名：：", domainText),
                row("失败原因：：", String(extra?.reason ?? order?.text ?? "未知")),
                linkRow,
            ], "可登录后在订单页查看详情，处理后重新提交。"),
        };
    }

    // expiring7
    const days = Math.max(1, Number(extra?.days ?? 1));
    return {
        subject: `【证书即将到期】${first}（剩 ${days} 天）`,
        html: wrap(`证书将在 ${days} 天后到期`, [
            row("域名：", domainText),
            row("到期时间：", fmtDate(Number(order?.next ?? 0))),
            row("剩余天数：", `${days} 天`),
            linkRow,
        ], "已开启自动续期的证书会在到期前 30 天自动续签；未开启请及时手动续期。"),
    };
}

/**
 * 发一条订单事件通知（**永不抛错**）。调用方不需要再包 try/catch。
 *
 * @param order 至少包含 `mail` 与 `flag`；建议传完整订单行（模板要用 list / sign / next / text / notify_flags）
 * @param once  一次性事件的位掩码（如 `FLAG_PENDING`）：已置位则跳过，发送成功后置位。
 *              **发送失败不置位**，下一轮还能重试。
 */
export async function notifyOrderEvent(
    env: any, order: any, event: NotifyEvent, extra?: any, once?: number,
): Promise<void> {
    try {
        // ① 状态白名单：只有 2 / 5 / -1 发，中间状态一律跳过（防误加调用点）
        const flagNum = Number(order?.flag);
        if (!NOTIFIABLE_FLAGS.has(flagNum)) {
            console.warn("[notify] 跳过：非通知状态", {event, flag: order?.flag, uuid: order?.uuid});
            return;
        }
        // ② 一次性事件去重（「请配置 DNS」只发一次）
        const prevFlags = Number(order?.notify_flags ?? 0);
        if (once && (prevFlags & once) !== 0) {
            console.log("[notify] 跳过：该事件已发送过", {event, once, notify_flags: prevFlags, uuid: order?.uuid});
            return;
        }
        // ③ 开关（关闭时打日志，否则线上表现为"静默不发"，无从排查）
        if (!await enabled(env, event)) {
            console.log("[notify] 跳过：通知开关未开启",
                {event, key: SWITCH_KEY[event], uuid: order?.uuid});
            return;
        }
        const to = String(order?.mail ?? "").trim();
        if (!to) {
            console.warn("[notify] 跳过：订单缺少收件邮箱", {event, uuid: order?.uuid});
            return;
        }

        const {subject, html} = await buildMail(env, event, order, extra);
        const r: any = await mailSendRaw(env, to, subject, html);
        if (r?.flags !== 0) {
            console.warn("[notify] 未发送成功:", event, order?.uuid, r?.nonce);
            return;
        }
        // ③ 发送成功后才置位
        if (once) {
            try {
                await saves.updateDB(env.DB_CF, "Apply",
                    {notify_flags: prevFlags | once}, {uuid: order?.uuid});
            } catch (e) {
                console.error("[notify] 置位失败:", order?.uuid, e);
            }
        }
    } catch (e) {
        // 邮件绝不能影响订单状态推进
        console.error("[notify] 发送异常（已忽略）:", event, order?.uuid, e);
    }
}

/**
 * 到期前 7 天提醒（daily cron 的第三步）。
 *
 * 只处理：`flag=5`（已签发）、`next` 落在**未来 7 天内**、且 `notify_flags` 的 bit0 为 0。
 * 已过期的**不在这里处理**（`NOTIFY_ON_EXPIRED` 属后续阶段，需另加 bit1）。
 *
 * 顺序说明：daily 里先跑 `renewCerts`（把 30 天内的置 flag=0），所以这里只剩
 * 「关掉自动续期、且 7 天内到期」的订单 —— 不会与续期流程重复打扰。
 */
export async function notifyExpiring(env: any): Promise<any> {
    if (!await enabled(env, "expiring7")) {
        return {"text": "到期提醒：已关闭（MAIL_ENABLED 或 NOTIFY_ON_EXPIRE7）"};
    }
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    let rows: any[] = [];
    try {
        // ⚠️ cols 必须包含 `flag`：notifyOrderEvent 的状态白名单要用它判定（缺了会被静默拦掉）
        rows = await saves.selectDB(env.DB_CF, "Apply",
            {flag: {value: 5}, next: {value: now + sevenDays, op: "<="}},
            {cols: ["uuid", "mail", "flag", "next", "list", "sign", "text", "notify_flags"]});
    } catch (e) {
        console.error("[notifyExpiring] 查询失败:", e);
        return {"text": "到期提醒：查询失败"};
    }

    let sent = 0, skipped = 0, limited = 0;
    for (const o of rows) {
        const nextAt = Number(o?.["next"] ?? 0);
        if (!Number.isFinite(nextAt) || nextAt <= 0 || nextAt <= now) { skipped++; continue; }
        if (nextAt > now + sevenDays) { skipped++; continue; }        // 双保险
        const flags = Number(o?.["notify_flags"] ?? 0);
        if ((flags & FLAG_EXPIRE7) !== 0) { skipped++; continue; }    // 已提醒过
        if (sent >= NOTIFY_LIMIT) { limited++; continue; }            // 单轮限流
        const days = Math.max(1, Math.ceil((nextAt - now) / (24 * 60 * 60 * 1000)));
        // 显式带 flag：白名单需要它；查询列已含 flag，这里再兜一层防漏
        await notifyOrderEvent(env, {...o, flag: 5}, "expiring7", {days});
        try {
            // 置位放在发送之后：发送失败也要置位，否则会每天重试同一封
            await saves.updateDB(env.DB_CF, "Apply",
                {notify_flags: flags | FLAG_EXPIRE7}, {uuid: o["uuid"]});
        } catch (e) {
            console.error("[notifyExpiring] 置位失败:", o["uuid"], e);
        }
        sent++;
    }
    return {
        "text": `到期提醒完成：发送 \`${sent}\` 封，跳过 \`${skipped}\` 个` +
            (limited > 0 ? `，超出单轮上限 \`${limited}\` 个（下一轮继续）` : ""),
    };
}
