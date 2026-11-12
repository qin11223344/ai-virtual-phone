import { NextRequest, NextResponse } from "next/server";

// 资源集市的服务端取件代理。
//
// 背景：资源集市原本全在浏览器里直连 jsDelivr / raw.githubusercontent.com，
// 国内网络下这些域名常常整域名不通，结果是封面图全空白、下载报 Failed to fetch，
// 连 _index.json 都拉不到。而本站自己的域名是通的（不然页面都打不开），
// 所以改由服务端替浏览器去取，内容从自己域名下发，浏览器只需要能访问本站。
//
// 安全：只按 owner/repo/ref/path 拼接**固定的三个上游域名**，不接受任意 URL 参数，
// 因此不构成公开 SSRF 跳板（也就没有必要再引内网地址黑名单）。

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const OWNER_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const MAX_PATH_LENGTH = 500;
const UPSTREAM_TIMEOUT_MS = 15000;

function encodePath(path: string): string {
    return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

function safePath(raw: string | null): string {
    const value = (raw ?? "").trim();
    if (!value || value.length > MAX_PATH_LENGTH) return "";
    if (value.includes("..")) return "";
    return value;
}

type Upstream = {
    name: string;
    build: (owner: string, repo: string, ref: string, path: string) => string;
};

/** 文件名里的引号/换行会破坏 Content-Disposition 头，一律清掉 */
function sanitizeFilename(raw: string): string {
    const cleaned = raw.replace(/[\\/\r\n"]/g, "_").trim();
    return cleaned.slice(0, 120) || "resource";
}

/** 老浏览器只认 filename= 里的 ASCII，非 ASCII 用 _ 顶替，中文名走 filename* 那半 */
function asciiFallback(filename: string): string {
    // eslint-disable-next-line no-control-regex
    return filename.replace(/[^\x20-\x7e]/g, "_");
}

// 服务端一般不在这三个域名上受限，raw 优先（无 20MB 限制），jsDelivr 兜底其 CDN 缓存。
const UPSTREAMS: Upstream[] = [
    { name: "raw", build: (o, r, ref, p) => `https://raw.githubusercontent.com/${o}/${r}/${ref}/${p}` },
    { name: "jsdelivr", build: (o, r, ref, p) => `https://cdn.jsdelivr.net/gh/${o}/${r}@${ref}/${p}` },
    { name: "fastly", build: (o, r, ref, p) => `https://fastly.jsdelivr.net/gh/${o}/${r}@${ref}/${p}` },
];

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const owner = (params.get("owner") ?? "").trim();
    const repo = (params.get("repo") ?? "").trim();
    const ref = (params.get("ref") ?? "main").trim();
    const path = safePath(params.get("path"));
    // download=1 时响应带 Content-Disposition: attachment，浏览器当文件下载处理
    const isDownload = params.get("download") === "1";

    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !REF_RE.test(ref) || !path) {
        return NextResponse.json({ error: "资源代理参数不合法" }, { status: 400 });
    }

    const encoded = encodePath(path);
    let lastError = "上游不可用";

    for (const upstream of UPSTREAMS) {
        const url = upstream.build(owner, repo, ref, encoded);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                cache: "no-store",
                headers: { "User-Agent": "ai-phone-resource-hub-proxy" },
            });
            if (!res.ok || !res.body) {
                lastError = `${upstream.name} HTTP ${res.status}`;
                continue;
            }
            const headers = new Headers();
            headers.set("Content-Type", res.headers.get("Content-Type") || "application/octet-stream");
            // 集市资源按 commit 取或按分支取，内容很少变；缓存 5 分钟足够挡住
            // 列表页几十张缩略图的重复请求，又不至于让新上架资源等太久。
            headers.set("Cache-Control", "public, max-age=300");
            headers.set("X-Content-Type-Options", "nosniff");
            const length = res.headers.get("Content-Length");
            if (length) headers.set("Content-Length", length);

            // download=1：带上附件头，浏览器按普通文件下载接管。
            // 这是集市「下载」按钮的唯一路径——前端不再 fetch 整份进内存再造 blob，
            // 那样在安装成 PWA 的安卓窗口里点了没反应，大文件还会被超时截断。
            if (isDownload) {
                const fallbackName = path.split("/").pop() || "resource";
                const filename = sanitizeFilename(params.get("filename") || fallbackName);
                headers.set("Content-Disposition", `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
            }
            return new Response(res.body, { status: 200, headers });
        } catch (err) {
            lastError = `${upstream.name} ${err instanceof Error ? err.message : String(err)}`;
        } finally {
            clearTimeout(timer);
        }
    }

    return NextResponse.json({ error: `资源仓库暂时无法访问（${lastError}）` }, { status: 502 });
}
