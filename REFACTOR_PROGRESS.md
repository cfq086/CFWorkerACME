# REFACTOR_PROGRESS.md

> 本文件记录从 `acme-client` 迁移到 `@fishballpkg/acme` 的重构进度。
> 新会话请先通读本文件，再按「未完成 Todo」继续。

---

## 1. 项目背景（为什么换库）

- 当前项目 `CFWorkerACME` 部署在 **Cloudflare Workers** 上做 ACME 证书管理。
- 原依赖 `acme-client@5.4.0` 底层依赖 **Node.js 的 `crypto` 模块**（`createHmac` / `createSign` /
  `RSA_PKCS1_PADDING` 等），在 CF Workers 环境下会报 **`Failed to parse public key`**。
- 为绕过 axios/http adapter 问题，项目还引入了 `patch-package` + `src/http.js`（用 `xior`
  替换 acme-client 内部 axios），维护成本高、且依旧绕不开 Node crypto。
- `@fishballpkg/acme` 是 **零依赖、100% TypeScript、纯 WebCrypto + fetch** 实现的 ACME 客户端，
  原生支持 Cloudflare Workers / Deno / Node，可直接替换。

目标：移除 `acme-client`、`patch-package`，改用 `@fishballpkg/acme`，密钥生成全部改用
WebCrypto，**完全不再引用 Node.js 的 `crypto` 模块**，同时保留原有 D1 存储、R2 上传、
前端面板等无关逻辑不动。

---

## 2. 已完成修改

### 2.1 `package.json`
- `dependencies`：
  - 移除 `"acme-client": "^5.4.0"`
  - 新增 `"@fishballpkg/acme": "^0.18.0"`
  - 其余依赖（`axios`/`crypto-js`/`node-forge`/`xior`/`jszip`/`resend`/`hono` 等）保持不变。
    - `crypto-js`：仍被 `users.ts` / `setup.ts` 用于 SHA256/HmacSHA256/AES，保留。
    - `node-forge`：仍被 `src/utils/pfx.ts` 使用，且新 `src/acme.ts` 用它做 SEC1→PKCS#8 转换，保留。
    - `xior`：仍被 `src/query.ts` 引用，保留。
- `devDependencies`：移除 `"patch-package": "^8.0.1"`。
- `scripts`：
  - 删除 `"patch:acme": "patch-package"` 和 `"postinstall": "patch-package"`。
  - `dev-cf` → `wrangler dev`（去掉 `npm run patch:acme &&`）。
  - `dev-cf:test` → `wrangler dev -c ./wrangler.encrypt.jsonc`。
  - `deploy-cf` → `npm run build && wrangler deploy --minify`。
  - `deploy-cf:test` → `npm run build && wrangler deploy --minify -c ./wrangler.encrypt.jsonc`。

### 2.2 删除文件
- `patches/acme-client+5.4.0.patch`（patch-package 的补丁，已无用）。
- `src/http.js`（acme-client 的 http.js 补丁副本，依赖 Node crypto，已无用）。

### 2.3 新增 `src/acme.ts`（共享封装层）
已完成并写入，导出以下能力，供 `certs.ts` 与 `routes/admin_certs_helper.ts` 复用：

- `ACME_DIRECTORY`：sign → directory URL 映射
  （lets-encrypt / google-trust / bypass-trust / zeroca-trust / sslcom-trust）。
- `generateAccountKeyPair()`：WebCrypto 生成 ECDSA **P-256** 密钥对。
- `generateAccountKeyPem()`：生成账户私钥 PKCS#8 PEM（用于写 `Users.keys`）。
- `sec1PemToPkcs8Pem()`：把 `-----BEGIN EC PRIVATE KEY-----`（SEC1）转成 PKCS#8 PEM
  （用 node-forge 的 `asn1`，因为 `importKeyPairFromPemPrivateKey` 只认 PKCS#8；
  历史配置如 `SSL_KeyTS` 可能是 SEC1 格式）。
- `importAccountKeyPair(pem)`：导入账户私钥 PEM（自动兼容 SEC1）。
- `deriveKeyPairAlgorithm(orderType)`：订单加密类型 → `KeyPairAlgorithm`
  （`rsa2048`→`rsa-2048`；`rsa4096`→`rsa-4096`；其余含 `eccp256`/`eccp384`→`ec-p256`）。
- `bytesToBase64Url` / `base64UrlToBytes` / `pemToDer`：base64url / PEM→DER 工具。
- `buildExternalAccountBindingJws()`：EAB（HS256，对账户公钥 JWK 签名）JWS 构建。
- `createAccountWithExistingKey()`：用**指定现有密钥**在 CA 侧建账户
  （因库的 `createAccount` 会自行生成新密钥并丢弃入参密钥，故用 `client.jwsFetch` 实现）。
- `getAcmeAccount(env, init)`：初始化客户端 + 登录/创建账户，返回 `{ client, account }`。
  - 优先 `client.login({ keyPair, keyPairAlgorithm })`；
  - 捕获 `AccountDoesNotExistError` 后用现有密钥 `createAccountWithExistingKey` 创建；
  - 内部按 sign 从 Confs/env 读取 GTS/SSL/ZRO 的 EAB 凭据（`readConf`）。
- `revokeCertificate(account, certPem, reason?)`：吊销证书（RFC 8555 §7.6，
  用账户密钥走 `account.jwsFetch(directory.revokeCert)`）。

---

## 3. 未完成 Todo（逐项，按建议顺序）

- [ ] **3.1 重写 `src/certs.ts` 的 ACME 调用**（核心，见第 5 节）
- [ ] **3.2 重写 `src/routes/admin_certs_helper.ts`**（`getAcmeClient` 改为返回 `{client, account}`）
- [ ] **3.3 更新 `src/routes/admin_certs.ts`**（移除死 import `* as acme`，吊销改走新 helper）
- [ ] **3.4 替换 `src/users.ts` 的 Node crypto**（`generateKeyPairSync` → WebCrypto）
- [ ] **3.5 替换 `src/routes/setup.ts` 的 Node crypto**（`generateKeyPairSync` → WebCrypto）
- [ ] **3.6 `npm install` 并验证**（typecheck / wrangler dry-run / build）

---

## 4. 关键技术决策

### 4.1 密钥生成改用 WebCrypto
- 账户密钥：`crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign","verify"])`，
  导出 `pkcs8` → PEM（`CryptoKeyUtils.exportKeyPairToPem`），与旧 `generateKeyPairSync('ec', {namedCurve:'prime256v1'})`
  + `export({type:'pkcs8'})` 语义一致。
- 证书密钥：由 `order.finalize()` 内部按 `account.keyPairAlgorithm` 生成，`finalize()` 返回
  `CryptoKeyPair`，再 `CryptoKeyUtils.exportKeyPairToPem(certKeyPair).privateKey` 得到私钥 PEM 存入 `keys` 字段。

### 4.2 EC 算法选择
- 账户密钥固定 ECDSA **P-256**（对应旧 prime256v1）。
- 证书密钥：`rsa2048`→`rsa-2048`，其余→`ec-p256`。
- **已知限制**：`@fishballpkg/acme` 仅支持 EC P-256（不支持 P-384）。旧的 `eccp384` 订单类型
  会退化为 `ec-p256` 证书密钥；IP 证书（`type: 'ip'` 标识符）不受支持（库硬编码 `type: "dns"`）。
  这两点在最终交付说明中需向用户标注。

### 4.3 新库 API 对照（acme-client → @fishballpkg/acme）
| 旧 acme-client | 新 @fishballpkg/acme |
| --- | --- |
| `acme.directory.letsencrypt.production` | `ACME_DIRECTORY_URLS.LETS_ENCRYPT` |
| `acme.directory.google.production` | `ACME_DIRECTORY_URLS.GOOGLE` |
| `acme.directory.buypass.production` | `ACME_DIRECTORY_URLS.BUYPASS` |
| `acme.directory.zerossl.production` | `ACME_DIRECTORY_URLS.ZEROSSL` |
| `new acme.Client({directoryUrl, accountKey, externalAccountBinding})` | `AcmeClient.init(url)` + `client.login({keyPair})` / `createAccountWithExistingKey` |
| `client.createAccount({termsOfServiceAgreed, contact})` | 见 `src/acme.ts#createAccountWithExistingKey` |
| `client.createOrder({identifiers:[{type,value}]})` | `account.createOrder({ domains: string[] })` |
| `client.getOrder(order)` | `AcmeOrder.init({ account, url })`（从 URL 重建订单） |
| `client.getAuthorizations(order)` | `order.authorizations` |
| `authorization.findChallenge("dns-01" / "http-01")` | 同：`authorization.findChallenge(...)` |
| `client.getChallengeKeyAuthorization(challenge)` | dns-01 → `challenge.digestToken()`；http-01 → `challenge.keyAuthorization()` |
| `client.verifyChallenge(authz, challenge)` | 本项目已有自己的 `dnsCheck`，无需等价物 |
| `client.completeChallenge(challenge)` | `challenge.submit()` |
| `client.waitForValidStatus(challenge)` | 自写 `waitChallengeValid`（见 5.1） |
| `client.finalizeOrder(order, csr)` | `order.finalize()`（内部生成 CSR，返回 cert CryptoKeyPair） |
| `client.getCertificate(order)` | `order.getCertificate()` |
| `client.revokeCertificate(cert, {reason})` | `src/acme.ts#revokeCertificate` |

### 4.4 订单持久化策略（关键）
- 旧代码把 `createOrder` 结果 `JSON.stringify` 存进 `Apply.data`，之后 `JSON.parse` 再 `getOrder`。
- 新库的 `AcmeOrder`/`AcmeAccount`/`AcmeChallenge` 含 `CryptoKeyPair` 与私有字段，**无法 JSON 序列化**。
- 改为：`Apply.data` 只存 **订单 URL 字符串**（`order.url`）；每个处理阶段用
  `AcmeOrder.init({ account, url })` 从 URL 重建订单（该静态方法会 fetch 订单对象）。

### 4.5 登录/创建账户语义
- `login({ onlyReturnExisting: true })` 在账户不存在时抛 `AccountDoesNotExistError`。
- 捕获后调用 `createAccountWithExistingKey`（走 `jwsFetch`），保留账户密钥不变，
  满足多租户「一个用户一把账户私钥」的现有设计。

---

## 5. 每个待改文件的改动要点

### 5.1 `src/certs.ts`
- 顶部：删除 `import * as acme from 'acme-client'` 和 `import {Client}`；
  新增 `import { AcmeOrder, AcmeChallenge, CryptoKeyUtils } from "@fishballpkg/acme"`，
  以及 `import { getAcmeAccount, deriveKeyPairAlgorithm, revokeCertificate, ACME_DIRECTORY } from "./acme"`。
- 删除本地 `acme_url_map`（改用 `src/acme.ts` 的 `ACME_DIRECTORY`）。
- `getStart(env, order_user, order_info)`：
  ```ts
  return await getAcmeAccount(env, {
      sign: order_info['sign'],
      type: order_info['type'],
      mail: order_user['mail'],
      ownKeyPem: order_user['keys'],
  });
  ```
- `getNames(order_info)`：简化为返回 `string[]`（域名名列表），不再返回 `{type,value}`，
  也不再区分 IP 标识符（新库不支持 ip）。
- 新增 `loadOrder(account, order_info)`：`AcmeOrder.init({ account, url: order_info['data'] })`。
- `newApply`：`order = await account.createOrder({ domains: domain_list })`，
  `data` 存 `order.url`（字符串），其余 flag/next/text 写入逻辑不变。
- `setApply`：
  - `{ account } = await getStart(...)`；`order = await loadOrder(account, order_info)`；
    `author_save = await getAuthy(order)`。
  - `author_save[name]['data']?.type` 改为 `author_save[name]['type']`；
    token 取 `author_save[name]['token']`。其余 dns-auto / dnsAdd / dnsDel 逻辑不变。
- `dnsAuthy`：
  - 同样重建 order + getAuthy。
  - 状态判断用 `(await author_data.challenge.fetch()).status`（pending/invalid/valid）。
  - pending 时 `await author_data.challenge.submit()`，然后自写
    `waitChallengeValid(challenge)` 轮询（类似旧 `waitForValidStatus`，超时/interval 可设 30s/3s）。
  - 去掉末尾 `getOrder` 重存 `data`（data 现在只是 URL 不变）。
- `getCerts`：
  - `order = await loadOrder(account, order_info)`；`status = (await order.fetch()).status`。
  - `ready`：`certKeyPair = await order.finalize()`；`CryptoKeyUtils.exportKeyPairToPem(certKeyPair).privateKey`
    写入 `keys`；text 更新。
  - `processing` / `valid` 分支逻辑不变（`valid` 用 `await order.getCertificate()`）。
  - 删除旧的 `acme.crypto.createPrivateRsaKey/createPrivateEcdsaKey/createCsr` 与 `getNames(order_info,false)` 调用。
- `revokeCert`：`acme_acct = await getStart(...)`；`await revokeCertificate(acme_acct.account, order_info.cert, reason_code)`。
- `getAuthy(order)` 重写为：
  ```ts
  async function getAuthy(order: AcmeOrder) {
      const maps: Record<string, any> = {};
      for (const authorization of order.authorizations) {
          const name = authorization.domain; // 含通配 "*.xxx"
          const ch = authorization.findChallenge("dns-01") ?? authorization.findChallenge("http-01");
          if (!ch) continue;
          const type = ch.getType();
          const text = ch.is("dns-01") ? await ch.digestToken() : await ch.keyAuthorization();
          maps[name] = { text, type, token: ch.token, challenge: ch, authorization };
      }
      return maps;
  }
  ```
- 需要新增 `waitChallengeValid` 辅助函数。

### 5.2 `src/routes/admin_certs_helper.ts`
- 删除 `import * as acme from "acme-client"` 和本地 `ACME_URL` 映射。
- 新增 `import { getAcmeAccount, revokeCertificate, ACME_DIRECTORY } from "../acme"`。
- `getAcmeClient` 改为 `getAcmeAccountForOrder(env, user, order)`，内部调用 `getAcmeAccount`：
  ```ts
  return getAcmeAccount(env, {
      sign: String(order.sign ?? "lets-encrypt"),
      type: order.type,
      mail: user.mail,
      ownKeyPem: user.keys,
  });
  ```
  返回值从 `acme.Client` 改为 `{ client, account }`。
  （建议保留导出名 `getAcmeClient` 以少改调用点，或同步改 admin_certs.ts 的调用。）

### 5.3 `src/routes/admin_certs.ts`
- 删除第 17 行 `import * as acme from "acme-client";`（原本就是死代码）。
- `handleRevokeCert` 中：
  ```ts
  const { getAcmeClient } = await import("./admin_certs_helper");
  const client = await getAcmeClient(c.env as any, user, row);
  await client.revokeCertificate(row.cert);
  ```
  改为：
  ```ts
  const { getAcmeClient, revokeCertificate } = await import("./admin_certs_helper");
  const { account } = await getAcmeClient(c.env as any, user, row);
  await revokeCertificate(account, row.cert);
  ```
  （若 admin_certs_helper 直接 re-export `revokeCertificate`，则无需从 `../acme` 再 import。）

### 5.4 `src/users.ts`
- 删除第 6 行 `import {generateKeyPairSync} from "crypto";`。
- 新增 `import {generateAccountKeyPem} from "./acme";`（注意避免与已有 import 冲突/循环依赖）。
- `userRegs` 中：
  ```ts
  const { publicKey, privateKey } = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  console.log(publicKey);
  ...
  updates["keys"] = privateKey.export({type:'pkcs8', format:'pem'});
  ```
  改为：
  ```ts
  updates["keys"] = await generateAccountKeyPem();
  ```
  （原 `publicKey` 的 `console.log` 可删除，或改为打印成功信息。）
  - 注意：`generateAccountKeyPem` 是 async，而该段代码已处于 async 函数内，直接 `await` 即可。
- 检查 `src/acme.ts` 是否会与 `users.ts` 产生循环依赖：`users.ts` → `./acme` → `./db/conf` + `./index`(仅类型)。
  `./acme` 只 `import type {Bindings}` from `./index`，属类型引用，运行时无环。`users.ts` 本身被
  `index.ts` 导入，但 `acme.ts` 不反向导入 `users.ts`，安全。

### 5.5 `src/routes/setup.ts`
- 删除第 17 行 `import {generateKeyPairSync} from "crypto";` 及 `// @ts-ignore` 注释。
- 新增 `import {generateAccountKeyPem} from "../acme";`。
- `createAcmeAccountKeyPem()` 由同步改为异步，或直接在调用点 `await generateAccountKeyPem()`：
  - `handleSetup` 中 `patch.keys = createAcmeAccountKeyPem()` → `patch.keys = await generateAccountKeyPem();`
  - `dao.insertUser({ ... keys: createAcmeAccountKeyPem() ... })` → `keys: await generateAccountKeyPem()`。
  - 若保留 `createAcmeAccountKeyPem` 包装，则改为 `async function` 并返回 `await generateAccountKeyPem()`。

### 5.6 `src/routes/openapi.ts`（遗漏调用点）
- 第 30 行 `import {getAcmeClient} from "./admin_certs_helper";` 改为
  `import {getAcmeClient, revokeCertificate} from "./admin_certs_helper";`。
- `handleApiRevokeCert` 中（约 306 行）：
  ```ts
  const client = await getAcmeClient(c.env as any, user, row);
  await client.revokeCertificate(row.cert);
  ```
  改为：
  ```ts
  const {account} = await getAcmeClient(c.env as any, user, row);
  await revokeCertificate(account, row.cert);
  ```

---

## 6. 验证 / 部署命令（供后续会话执行）

```bash
# 安装依赖（会安装 @fishballpkg/acme，并移除 acme-client / patch-package）
npm install

# 类型检查（项目无 typecheck 脚本，直接用 tsc --noEmit）
npx tsc --noEmit

# 本地 dry-run 校验 Workers 打包（wrangler）
npx wrangler dev --dry-run

# 前端构建 + 部署（正式）
npm run deploy-cf

# 测试环境部署（wrangler.encrypt.jsonc）
npm run deploy-cf:test
```

> 注意：`wrangler.jsonc` 的 `compatibility_flags` 仍含 `nodejs_compat`。迁移后理论上不再需要它，
> 但保留不影响运行；是否移除由用户决定（移除可进一步验证无 Node 依赖）。

---

## 7. 已知风险 / 需向用户说明

1. **`eccp384` 订单类型**：新库只支持 EC P-256，会退化为 `ec-p256` 证书密钥。
2. **IP 证书**（`type:'ip'` 标识符）：新库 `createOrder` 硬编码 `type:"dns"`，不支持。
3. **SEC1 账户私钥**：已通过 `sec1PemToPkcs8Pem`（node-forge）兼容转换；若转换失败会抛错，
   需检查历史配置中的 `SSL_KeyTS` 等 SEC1 密钥。
4. **账户首次创建**：新库 `createAccount` 不接收指定密钥，已用 `jwsFetch` 自实现「指定密钥建户」，
   需重点验证 EAB CA（Google/ZeroSSL/SSL.com）首次建户与后续登录两条路径。
5. **吊销**：新库 roadmap 未内置 revoke，已用 `jwsFetch(revokeCert)` 自实现，需实测。

---

## 8. 账户密钥导入失败（getImportParameters）分析与下一步

> 现象：部署后 `processOne error at flag=0: at getImportParameters (cfapp.js:10:513)
> at Object.importKeyPairFromPemPrivateKey`。D1 读出的 PEM 看着正常，但导入时在
> `getImportParameters` 崩溃。涉及 CA 账户密钥 `SSL_KeyTS` / `ZRO_KeyTS`。

### 8.1 源码定位（已读 3 个库文件，未读 .d.ts）
- `esm/CryptoKeyUtils/importKeyPairFromPemPrivateKey.js`：`getImportParameters` 在此（L27-52）。
- `esm/utils/pem.js`：`extractFirstPemObject` 剥掉头尾 + 去空白 + base64 解码成 DER。
- `esm/utils/crypto.js`：算法名/参数常量（`ec`=ECDSA、`rsa`=RSASSA-PKCS1-v1_5）。
- 调用顺序：`importKeyPairFromPemPrivateKey(pem)` → `extractFirstPemObject(pem)` 得 DER →
  `getImportParameters(DER)` **直接解 ASN.1** 读 `privateKeyAlgorithm`。
  （文本层只用来取 DER；字符串格式本身在这一步已不再被读取。）

### 8.2 `getImportParameters` 的 4 个抛出点
- 外层 SEQUENCE 取不到第 2 个元素 → `Malformed PKCS#8 private key: missing privateKeyAlgorithm.`
- AlgorithmIdentifier 取不到算法 OID → `Malformed PKCS#8 private key: empty AlgorithmIdentifier.`
- EC 曲线缺失或 ≠ prime256v1 → `Unsupported EC curve in PEM private key. Only P-256 (prime256v1) is supported.`
- 算法 OID 非 rsaEncryption / id-ecPublicKey → `Unsupported algorithm in PEM private key. Expected an EC (P-256) or RSA key.`
- 注：堆栈来自 minify 后的 `cfapp.js`，`decodeSequence` 可能被内联进 `getImportParameters`，
  故也可能表现为 ASN.1 解码错误。

### 8.3 @fishballpkg/acme 对 PEM 的严格要求
- 必须是真正的 **PKCS#8**（`BEGIN PRIVATE KEY`）；**不接受 SEC1**（`BEGIN EC PRIVATE KEY`）、
  **PKCS#1**（`BEGIN RSA PRIVATE KEY`）、证书、`BEGIN ENCRYPTED PRIVATE KEY`。
- 必须是 **EC P-256 或 RSA**：
  - EC 曲线只支持 **P-256（prime256v1, OID 1.2.840.10045.3.1.7）**；
    **P-384 / secp384r1 / secp256k1 / 显式域参数 EC 一律不支持**；
  - RSA 仅接受 `rsaEncryption`（1.2.840.113549.1.1.1）。
- 算法 / 曲线 OID 做**逐字节**比较；曲线必须是 AlgorithmIdentifier 的直接 namedCurve 参数。
- `extractFirstPemObject` 只取**第一个** PEM 对象，body 必须为合法 base64。

### 8.4 已做改动
- `src/acme.ts` 的 `normalizePem`：字面量 `\n`/`\r\n` → 真实换行 + 去首尾空白（保留尾部换行）。
- `importAccountKeyPair`：在调用 `importKeyPairFromPemPrivateKey` 前已加 `try-catch`，
  失败时 `console.error("importKeyPairFromPemPrivateKey 失败:", e.message)` 后原样抛出，
  便于部署后抓**精确错误文案**。

### 8.5 下一步（新会话执行）
1. 部署后触发一次 flag=0 申请，抓日志中的 `importKeyPairFromPemPrivateKey 失败: <e.message>`：
   - `missing` / `empty` → DER 结构/解码问题（多半 key 不是 PKCS#8，或 body 有杂质）；
   - `Unsupported algorithm` → 实际是 PKCS#1 / SEC1 / 证书 / RSA 变种 OID；
   - `Unsupported EC curve` → 实际不是 P-256（很可能 P-384）。
2. 验证实际密钥的真实曲线/算法：
   ```bash
   openssl pkey -in test.key -text -noout | findstr /i "oid"
   ```
   期望输出 `prime256v1`；若为 `secp384r1` 等则新库不支持，需更换密钥或改用受支持曲线。
3. 依据结论决定修复方向（转换密钥格式/曲线，或改用受支持的账户密钥）。
