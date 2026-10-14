/**
 * 管理员吊销证书时复用的 ACME 客户端初始化。
 * 仅暴露 getAcmeClient(env, user, order) 以避免循环依赖。
 *
 * CA 账户凭据（GTS_* / SSL_* / ZRO_*）遵循 Confs → env → 默认值 的三级回退，
 * 便于管理员在系统管理页面直接覆盖而无需重新发布 Worker。
 */
import type {Bindings} from "../index";
import type {ApplyRow, UserRow} from "../db/dao";
import {getAcmeAccount, revokeCertificate} from "../acme";

/** 与 certs.ts 中 getStart() 等价，但独立不依赖 saves 层，返回 { client, account } */
export async function getAcmeClient(
    env: Bindings,
    user: UserRow,
    order: ApplyRow,
) {
    return getAcmeAccount(env, {
        sign: String(order.sign ?? "lets-encrypt"),
        type: order.type,
        mail: user.mail,
        ownKeyPem: user.keys,
    });
}

// 重新导出 revokeCertificate，供 admin_certs.ts 直接使用
export {revokeCertificate};
