import {Bindings} from "./index";
import {readConf} from "./db/conf";

/**
 * 读取 DCV 相关配置：Confs → env → ""
 * 单次请求周期内多次访问同一 key 由 readConf 内部缓存兜底，性能与直读 env 接近。
 */
async function dcv(env: Bindings, name: "DCV_ZONES" | "DCV_EMAIL" | "DCV_TOKEN"): Promise<string> {
    return (await readConf(env as any, name)) ?? "";
}

export async function dnsAdd(env: Bindings, domain_item: any, domain_name: string) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "POST", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records`,
        {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        JSON.stringify({
            comment: 'DCV-Agent#' + Date.now() + '@' + domain_name,
            content: domain_item['auth'],
            name: domain_item['auto'],
            ttl: 60,
            type: 'TXT'
        }))
}

export async function dnsDel(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    let domain_uuid: string = await dnsUID(env, domain_name, domain_type);
    return await uidDel(env, domain_uuid);

}

export async function dnsUID(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    let domain_list: Record<string, any> = await dnsAll(env);
    console.log("dnsAll 返回的数据:", JSON.stringify(domain_list));
    let domain_uuid = "";
    if (!domain_list || !Array.isArray(domain_list['result'])) {
        return "";
    }
    for (const domain_item of domain_list['result']) {
        // console.log(domain_item['name'], domain_name);
        if (domain_item['name'] === domain_name
            && domain_item.type == domain_type) {
            domain_uuid = domain_item['id'];
            break;
        }
    }
    return domain_uuid;
}

export async function dnsAll(env: Bindings) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "GET", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records`,
        {
            'Authorization': `Bearer ${token}`,
        }, undefined)
}

export async function uidDel(env: Bindings, domain_uuid: string) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "DELETE", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records/${domain_uuid}`,
        {
            'Authorization': `Bearer ${token}`,
        }, undefined)
}

export async function dnsAPI(method: string = "POST",
                             url: string,
                             header: Record<string, any>,
                             body: BodyInit | null | undefined) {
    try {
        console.log(method, url);
        const response = await fetch(url,
            {
                method: method,
                headers: header,
                body: body
            }
        );
        const data: Record<string, any> = await response.json();
        // console.log('Result:', data);
        return data;
    } catch (error) {
        console.error(error);
        return {};
    }
}
