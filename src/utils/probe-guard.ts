/**
 * 扫描器探测拦截
 * ---------------------------------------------------------------------------
 * 背景：前端是 SPA，`app.get("*")` 对**所有**未知路径都兜底返回 index.html（200）。
 * 于是公网扫描器探 `/.env`、`/phpinfo.php`、`/.git/config` 时也会拿到 200，
 * 它会据此判定"这些文件存在"，从而持续扫描（日志里 21:59 那一波就是）。
 *
 * 做法：在静态资源与 SPA 兜底**之前**拦一道，命中敏感路径直接 404。
 *
 * ⚠️ 必须放行 `/.well-known/acme-challenge/...` —— http-01 验证要靠它（本项目主要用 dns-01，
 *    但 `web-self` 类型订单走 http-01，不能误伤）。
 */

/** 敏感路径判定（纯函数，便于单测） */
export function isScannerProbe(pathname: string): boolean {
    const p = String(pathname ?? "").toLowerCase();
    if (!p) return false;

    // 1) URL 编码的点/斜杠穿越（%2e / %2f），正常前端路由不会出现
    if (p.includes("%2e")) return true;

    // 2) 隐藏文件/目录：.env / .git / .aws / .docker / .npmrc / .netrc ...
    //    放行 ACME 的 .well-known
    if (/(^|\/)\.(?!well-known(\/|$))/.test(p)) return true;

    // 3) PHP 及常见调试端点（本项目是 Worker，这些根本不可能存在）
    if (/\.php\d*$/.test(p)) return true;
    if (/^\/(actuator|server-status|debug|phpinfo|php_info|_phpinfo|php-info)(\/|$)/.test(p)) return true;

    return false;
}
