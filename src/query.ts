// 域名记录 #######################

import {dnsAll, uidDel} from "./agent";
import * as saves from "./saves";
import {readConf, readInt} from "./db/conf";

interface DnsResponse {
    Status: number; // 查询响应状态
    Answer: { // 返回的查询完整结果
        name: string; // 查询的域名
        type: string; // 查询的类型
        time: number; // 查询有效期
        data: string; // 查询的结果
    };
}

// 解析域名 ################################################################
export async function queryDNS( // =========================================
    domain: string,/* 待查询的域名 */ record: string = "TXT", // 查询类型TXT
    server: string = "https://dns.google/resolve"): Promise<DnsResponse[]> {
    // 查询参数设置 ========================================================
    const params = new URLSearchParams({name: domain, type: record}); // URL
    console.log(`${server}?${params}`);
    try { // 查询过程 ======================================================
        const response = await fetch(`${server}?${params}`);
        if (!response.ok) { // 如果查询失败了 ==============================
            console.error(`查询域名失败: ${response.status}`);
            return []; // 返回空数据保证不异常 =============================
        } // 解析查询数据 ==================================================
        const data: any = await response.json();
        console.log(data);
        if (!data.Answer) return [];
        let txtRecords: any = data.Answer.map( // 映射查询数据 ======
            (r: any) => ({
                name: r.name, type: r.type, time: r.TTL,
                data: r.data.endsWith('.') ? r.data.substring(0, r.data.length - 1) : r.data,
            }));
        // console.log("txtRecords: ", txtRecords);
        return txtRecords || [];
    } catch (error) {
        console.error('解析数据失败:', error);
        return [];
    }
}

// DCV 记录清理 ################################################################

/**
 * 生成 DCV 记录名的匹配正则。
 * 记录名形如 `<hmac前16位hex>.<DCV_AGENT>`（见 `agent.dnsAdd`：name = domain_item['auto']）。
 * ⚠️ 原先写死 `/^[a-f0-9]+\.dcv\.524229\.xyz$/i`，与现 `DCV_AGENT=dav.016699.xyz` 不符，
 *    导致清理逻辑即使被调用也匹配不到任何记录。这里改为从配置动态生成，`.` 做转义。
 */
function dcvRecordRegex(dcvAgent: string): RegExp {
    const escaped: string = dcvAgent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^[a-f0-9]+\\.${escaped}$`, "i");
}

/**
 * 解析 DCV 记录的 comment —— `DCV-Agent#<写入时间戳>@<域名>`（见 `agent.dnsAdd`）。
 * 这是"DCV 记录 → 订单"最可靠的映射依据。解析不出时返回 `{createdAt: 0, domain: ""}`。
 */
function parseDcvComment(comment: any): { createdAt: number; domain: string } {
    const m: RegExpExecArray | null = /^DCV-Agent#(\d+)@(.+)$/.exec(String(comment ?? ""));
    if (!m) return {createdAt: 0, domain: ""};
    const ts: number = Number(m[1]);
    return {createdAt: Number.isFinite(ts) ? ts : 0, domain: m[2].trim()};
}

/**
 * 记录年龄（毫秒）。优先用 comment 里的写入时间，回退 `modified_on`。
 * 取不到任何时间时返回 `-1`（表示"未知"），调用方应保守跳过、不删。
 */
function dcvRecordAge(record: any, now: number): number {
    const {createdAt} = parseDcvComment(record?.['comment']);
    if (createdAt > 0) return Math.abs(now - createdAt);
    const mod: number = new Date(String(record?.['modified_on'] ?? "")).getTime();
    if (!Number.isFinite(mod)) return -1;
    return Math.abs(now - mod);
}

/**
 * 清理 DCV 记录：删除超过 `DCV_KEEP_DAYS` 天的记录，
 * 并把"仍卡在验证"（flag ∈ {1,2,3} 且已创建 ACME 订单）的对应订单置为超时终止。
 *
 * 说明：
 * - 只处理 **DCV 区**里的记录（`dnsAll`）；`dns-self` 类型的记录在用户自己的 DNS 里，不受影响。
 * - 记录 → 订单的映射靠 comment 里的域名反查 `Apply.list`（G5）。
 */
export async function cleanDNS(env: any) { // ===============
    const dcvAgent: string = (await readConf(env, "DCV_AGENT")) ?? "";
    if (!dcvAgent) {
        // 没配 DCV_AGENT 就无法安全识别哪些是 DCV 记录，宁可不删
        console.error('[cleanDNS] 未配置 DCV_AGENT，跳过清理');
        return {"flag": false, "text": "未配置 DCV_AGENT，跳过 DCV 记录清理"};
    }
    const keepDays: number = Math.max(1, await readInt(env, "DCV_KEEP_DAYS", 7));
    const keepMs: number = keepDays * 24 * 60 * 60 * 1000;
    const now: number = Date.now();
    const regex: RegExp = dcvRecordRegex(dcvAgent);

    const resp: any = await dnsAll(env);
    const records: any[] = Array.isArray(resp?.['result']) ? resp['result']
        : (Array.isArray(resp) ? resp : []);

    // 一次性取出"可能卡在验证"的订单，建立 域名 → 订单 映射（避免逐条记录查库）
    const orderByDomain: Map<string, any> = new Map();
    try {
        const candidates: any[] = await saves.selectDB(
            env.DB_CF, "Apply", {flag: {value: 5, op: "!="}});
        for (const o of candidates) {
            const f: number = Number(o?.['flag']);
            if (f !== 1 && f !== 2 && f !== 3) continue; // 只关心 待验证 / 验证中
            if (!o?.['data']) continue;                  // 还没创建 ACME 订单的不算
            let items: any[] = [];
            try {
                items = JSON.parse(o?.['list'] || "[]");
            } catch {
                continue;
            }
            if (!Array.isArray(items)) continue;
            for (const it of items) {
                const name: string = String(it?.['name'] ?? "").toLowerCase();
                if (name && !orderByDomain.has(name)) orderByDomain.set(name, o);
            }
        }
    } catch (e) {
        console.error("[cleanDNS] 读取待处理订单失败:", e);
    }

    let deleted: number = 0;    // 已删除的记录数
    let terminated: number = 0; // 已终止的订单数
    const terminatedUuids: Set<string> = new Set();

    for (const single of records) {
        const rec_name: string = String(single?.['name'] ?? "");
        const rec_uuid: string = String(single?.['id'] ?? "");
        if (!rec_uuid || !regex.test(rec_name)) continue;

        const age: number = dcvRecordAge(single, now);
        if (age < 0 || age < keepMs) {
            console.log('[cleanDNS] 保留', rec_uuid, rec_name, "age(ms)=" + age);
            continue;
        }

        // 先终止对应的卡死订单，再删记录
        const {domain} = parseDcvComment(single?.['comment']);
        const target: any = domain ? orderByDomain.get(domain.toLowerCase()) : undefined;
        if (target && !terminatedUuids.has(String(target['uuid']))) {
            try {
                await saves.updateDB(env.DB_CF, "Apply",
                    {flag: -1, text: "超时系统终止"}, {uuid: target['uuid']});
                terminatedUuids.add(String(target['uuid']));
                terminated += 1;
                console.log('[cleanDNS] 终止超时订单', target['uuid'], domain);
            } catch (e) {
                console.error('[cleanDNS] 终止订单失败:', target['uuid'], e);
            }
        }

        try {
            await uidDel(env, rec_uuid);
            deleted += 1;
            console.log('[cleanDNS] 已删除', rec_uuid, rec_name,
                "age(ms)=" + age, "domain=" + (domain || "-"));
        } catch (e) {
            console.error('[cleanDNS] 删除记录失败:', rec_uuid, e);
        }
    }

    return {
        "flag": true,
        "text": `DCV 清理完成：删除 \`${deleted}\` 条记录（保留期 ${keepDays} 天），终止 \`${terminated}\` 个超时订单`
    };
}
