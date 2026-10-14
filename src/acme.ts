/**
 * @fishballpkg/acme 业务封装层
 * -------------------------------------------------------------------------
 * 统一封装 ACME 客户端初始化、账户登录/创建、吊销等能力，供
 * `certs.ts` 与 `routes/admin_certs_helper.ts` 复用。
 *
 * 本模块完全基于 @fishballpkg/acme（零依赖、纯 WebCrypto / fetch）实现，
 * 不依赖 Node.js 的 `crypto` 模块，可在 Cloudflare Workers 运行。
 */

import {
    AccountDoesNotExistError,
    AcmeAccount,
    AcmeClient,
    AcmeError,
    ACME_DIRECTORY_URLS,
    CryptoKeyUtils,
    type ExternalAccountBinding,
    type KeyPairAlgorithm,
} from "@fishballpkg/acme";
import forge from "node-forge";
import type {Bindings} from "./index";
import {readConf} from "./db/conf";

/** sign → ACME directory URL 映射（sslcom 为自定义 CA） */
export const ACME_DIRECTORY: Record<string, string> = {
    "lets-encrypt": ACME_DIRECTORY_URLS.LETS_ENCRYPT,
    "google-trust": ACME_DIRECTORY_URLS.GOOGLE,
    "bypass-trust": ACME_DIRECTORY_URLS.BUYPASS,
    "zeroca-trust": ACME_DIRECTORY_URLS.ZEROSSL,
    "sslcom-trust": "https://acme.ssl.com/sslcom-dv-",
};

/* ============================ 密码学工具 ============================ */

/** 生成 ACME 账户密钥对（ECDSA P-256，与旧 EC prime256v1 语义一致） */
export async function generateAccountKeyPair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
}

/** 生成 ACME 账户私钥（PKCS#8 PEM），用于写入 Users.keys */
export async function generateAccountKeyPem(): Promise<string> {
    const keyPair = await generateAccountKeyPair();
    return (await CryptoKeyUtils.exportKeyPairToPem(keyPair)).privateKey;
}

/**
 * 将 SEC1 EC 私钥（`-----BEGIN EC PRIVATE KEY-----`）转换为 PKCS#8 PEM。
 * @fishballpkg/acme 的 importKeyPairFromPemPrivateKey 只接受 PKCS#8，
 * 而历史配置（如 wrangler 中的 SSL_KeyTS）可能是 SEC1 格式。
 */
function sec1PemToPkcs8Pem(pem: string): string {
    const msg = forge.pem.decode(pem)[0];
    if (!msg) throw new Error("私钥 PEM 为空或格式非法");
    const sec1Der = msg.body;
    const sec1 = forge.asn1.fromDer(sec1Der);

    let curveOidDer: string | null = null;
    for (const child of (sec1 as any).value as any[]) {
        // 寻找 [0] EXPLICIT ECParameters
        if (child.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && child.type === 0) {
            const inner = Array.isArray(child.value) ? child.value[0] : null;
            if (inner && inner.type === forge.asn1.Type.OID) curveOidDer = inner.value as string;
            break;
        }
    }
    if (!curveOidDer) throw new Error("EC 私钥缺少 namedCurve 参数，无法转换为 PKCS#8");

    const pkcs8 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
            forge.asn1.integerToDer(0).getBytes()),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
                forge.asn1.oidToDer("1.2.840.10045.2.1").getBytes()), // id-ecPublicKey
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, curveOidDer),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, sec1Der),
    ]);

    const b64 = forge.util.encode64(forge.asn1.toDer(pkcs8).getBytes());
    const lines = b64.match(/.{1,64}/g)?.join("\n") ?? "";
    return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

/**
 * 规范化 PEM 字符串：
 * - 将字面量 `\n` / `\r\n`（反斜杠 + 字符序列）还原为真实换行符；
 * - 去掉首尾空白与残留回车（\r）。
 */
function normalizePem(pem: string): string {
    return String(pem ?? "")
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\r/g, "")
        .trim()+ '\n';
}

/** 导入 ACME 账户私钥 PEM（自动兼容 SEC1 → PKCS#8） */
export async function importAccountKeyPair(pem: string): Promise<CryptoKeyPair> {
    const keyPem = String(pem ?? "");
    console.log("实际读到的密钥:", JSON.stringify(keyPem));
    const normalized = normalizePem(keyPem);
    console.log("处理后的密钥:", JSON.stringify(normalized));
    if (!normalized) throw new Error("ACME 账户私钥为空");
    const forImport = normalized.includes("BEGIN EC PRIVATE KEY")
        ? sec1PemToPkcs8Pem(normalized)
        : normalized;
    try {
        return await CryptoKeyUtils.importKeyPairFromPemPrivateKey(forImport);
    } catch (e: any) {
        console.error("importKeyPairFromPemPrivateKey 失败:", e?.message ?? String(e));
        throw e;
    }
}

/** 根据订单加密类型推导证书密钥算法（finalize 时使用） */
export function deriveKeyPairAlgorithm(orderType: unknown): KeyPairAlgorithm {
    switch (String(orderType ?? "").toLowerCase()) {
        case "rsa2048":
        case "rsa": return "rsa-2048";
        case "rsa4096": return "rsa-4096";
        default: return "ec-p256"; // eccp256 / eccp384 / 默认
    }
}

/* ============================ base64 工具 ============================ */

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** PEM → DER（base64 解码去掉头和尾） */
function pemToDer(pem: string): Uint8Array {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----.*$/s, "")
        .replace(/\s/g, "");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/* ============================ 账户初始化 ============================ */

/** External Account Binding JWS（HS256 对账户公钥 JWK 签名） */
async function buildExternalAccountBindingJws(
    newAccountUrl: string,
    eab: ExternalAccountBinding,
    publicKeyJwk: JsonWebKey,
) {
    const hmacKey = await crypto.subtle.importKey(
        "raw",
        base64UrlToBytes(eab.hmacKey),
        {name: "HMAC", hash: "SHA-256"},
        false,
        ["sign"],
    );
    const protectedHeader = {alg: "HS256", kid: eab.kid, url: newAccountUrl};
    const protectedB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(protectedHeader)));
    const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({...publicKeyJwk})));
    const signature = await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(`${protectedB64}.${payloadB64}`),
    );
    return {protected: protectedB64, payload: payloadB64, signature: bytesToBase64Url(new Uint8Array(signature))};
}

/**
 * 用**指定的现有密钥**在 CA 侧创建账户。
 * @fishballpkg/acme 的 `createAccount` 会自行生成新密钥并丢弃入参密钥，
 * 与多租户复用账户私钥的需求冲突，故在此直接走 jwsFetch 实现。
 */
async function createAccountWithExistingKey(
    client: AcmeClient,
    keyPair: CryptoKeyPair,
    keyPairAlgorithm: KeyPairAlgorithm,
    mail: string,
    externalAccountBinding?: ExternalAccountBinding,
): Promise<AcmeAccount> {
    const publicKeyJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
    const eabJws = externalAccountBinding?.kid && externalAccountBinding?.hmacKey
        ? await buildExternalAccountBindingJws(client.directory.newAccount, externalAccountBinding, publicKeyJwk)
        : undefined;

    const response = await client.jwsFetch(client.directory.newAccount, {
        privateKey: keyPair.privateKey,
        protected: {jwk: publicKeyJwk},
        payload: {
            termsOfServiceAgreed: true,
            contact: [`mailto:${mail}`],
            ...(eabJws ? {externalAccountBinding: eabJws} : {}),
        },
    });
    if (!response.ok) throw new AcmeError((await response.json()) as any);

    const accountUrl = response.headers.get("Location");
    if (!accountUrl) throw new Error("无法从 Location 响应头获取账户 URL");
    await response.body?.cancel();

    return new AcmeAccount({client, url: accountUrl, keyPair, keyPairAlgorithm});
}

export interface AcmeAccountInit {
    /** CA 标识：lets-encrypt / google-trust / bypass-trust / zeroca-trust / sslcom-trust */
    sign: string;
    /** 订单加密类型（影响证书密钥算法） */
    type?: string | number | null;
    /** 联系邮箱（创建账户时使用） */
    mail: string;
    /** 用户自有账户私钥 PEM（Let's Encrypt / Buypass 使用） */
    ownKeyPem?: string | null;
}

/**
 * 初始化 ACME 客户端并登录/创建账户。
 * 优先 login（onlyReturnExisting）；账户不存在时用现有密钥创建。
 */
export async function getAcmeAccount(
    env: Bindings,
    init: AcmeAccountInit,
): Promise<{client: AcmeClient; account: AcmeAccount}> {
    const sign = init.sign in ACME_DIRECTORY ? init.sign : "lets-encrypt";
    let url = ACME_DIRECTORY[sign];
    if (sign === "sslcom-trust") url += String(init.type ?? "").substring(0, 3);

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

    const keysMap: Record<string, string | null | undefined> = {
        "lets-encrypt": init.ownKeyPem,
        "google-trust": GTS_KeyTS,
        "bypass-trust": init.ownKeyPem,
        "zeroca-trust": ZRO_KeyTS,
        "sslcom-trust": SSL_KeyTS,
    };
    const eabMap: Record<string, ExternalAccountBinding | undefined> = {
        "lets-encrypt": undefined,
        "google-trust": GTS_keyID && GTS_keyMC ? {kid: GTS_keyID, hmacKey: GTS_keyMC} : undefined,
        "bypass-trust": undefined,
        "zeroca-trust": ZRO_keyID && ZRO_keyMC ? {kid: ZRO_keyID, hmacKey: ZRO_keyMC} : undefined,
        "sslcom-trust": SSL_keyID && SSL_keyMC ? {kid: SSL_keyID, hmacKey: SSL_keyMC} : undefined,
    };

    const accountKeyPem = keysMap[sign] ?? "";
    const client = await AcmeClient.init(url);
    const keyPair = await importAccountKeyPair(accountKeyPem);
    const keyPairAlgorithm = deriveKeyPairAlgorithm(init.type);

    let account: AcmeAccount;
    try {
        account = await client.login({keyPair, keyPairAlgorithm});
    } catch (e) {
        if (e instanceof AccountDoesNotExistError) {
            account = await createAccountWithExistingKey(
                client, keyPair, keyPairAlgorithm, init.mail, eabMap[sign]);
        } else {
            throw e;
        }
    }
    return {client, account};
}

/* ============================ 吊销 ============================ */

/** 吊销证书（RFC 8555 §7.6，使用账户密钥签名） */
export async function revokeCertificate(
    account: AcmeAccount,
    certPem: string,
    reason?: number,
): Promise<void> {
    const response = await account.jwsFetch(account.client.directory.revokeCert, {
        payload: {
            certificate: bytesToBase64Url(pemToDer(certPem)),
            ...(reason !== undefined && reason !== null ? {reason} : {}),
        },
    });
    if (!response.ok) throw new AcmeError((await response.json()) as any);
    await response.body?.cancel();
}