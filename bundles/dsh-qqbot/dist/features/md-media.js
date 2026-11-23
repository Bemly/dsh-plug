/**
 * md-media.ts — QQ「素材管理」客户端（2026-10-21）
 *
 * 文档：参考文档/api/素材管理.md（来源 bot.q.qq.com/wiki material-management）
 *
 * 用途：把**本地图片**先传到 QQ 平台，拿到 `qqbot-media://image/v1/<token>` 引用串，
 *   再写进 Markdown 消息（msg_type=2）。这样 markdown 卡片里的图不再必须是公网 URL。
 *
 * 三步流程：
 *   1) POST /v2/media-images/prepare  { file_name, file_size, content_type, md5, sha1 } → { upload_id, presigned_url, expires_in }
 *   2) PUT  <presigned_url>           Content-Type 必须与 prepare 完全一致，否则 COS 403；响应头 ETag = 文件 MD5
 *   3) POST /v2/media-images/complete { upload_id, md5 } → { image_id, url, ttl, preview_url }
 *
 * 命中策略（2026-10-21 主人口径：不做本地缓存，直接查服务端 list）：
 *   上传前先 GET /v2/media-images 拉有效列表，**按文件名命中**。
 *   为了"同名不同图"不误命中，文件名里塞**内容指纹**：
 *       cover.png → cover_ab12cd34ef56.png   （sha256 前 12 位）
 *   于是 list 命中 = 服务端权威（已过期/已删的自然不在列表里）+ 内容精确。
 *
 * 限制：单张 ≤10MB；png/jpeg/gif/webp；单机器人最多 100 张；图片滑动过期 90 天（每次被引用顺延）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
const MAX_BYTES = 10 * 1024 * 1024;
const SUPPORTED = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};
function extOf(p) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    const e = m?.[1];
    return e ? e.toLowerCase() : '';
}
function baseNameOf(p) {
    const m = /[\\/]([^\\/]+)$/.exec(p);
    const full = (m && m[1]) || p;
    return full.replace(/\.[A-Za-z0-9]+$/, '');
}
/** 读图片宽高（PNG / GIF / JPEG；webp 暂返回 0） */
export function imageSize(buf) {
    // PNG: 8 字节签名 + IHDR
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG: 扫 SOFn 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) {
                i += 1;
                continue;
            }
            const marker = buf[i + 1] ?? 0;
            const len = buf.readUInt16BE(i + 2);
            // SOF0..SOF15（排除 DHT/JPG/DAC）
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            }
            i += 2 + len;
        }
    }
    // WEBP(VP8X：RIFF....WEBP VP8X，宽高在 offset 24 起，各 3 字节 LE，存的是值-1)
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const kind = buf.toString('ascii', 12, 16);
        if (kind === 'VP8X') {
            const w = 1 + buf.readUIntLE(24, 3);
            const h = 1 + buf.readUIntLE(27, 3);
            return { width: w, height: h };
        }
        if (kind === 'VP8L' && buf.length > 25) {
            const b = buf.readUInt32LE(21);
            return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
    }
    return { width: 0, height: 0 };
}
/** 拉一页有效图片（首页最多 100 张 = 配额上限，够用） */
async function listOnce(target) {
    const r = await target.apiCall('GET', '/v2/media-images');
    if (!r.ok)
        return [];
    const d = (r.data ?? {});
    return Array.isArray(d.images) ? d.images : [];
}
/**
 * 上传一张本地图片，返回 `qqbot-media://` 引用串。
 * 先查服务端列表：若已有**同名（含内容指纹）**的图，直接复用，不再占配额。
 */
export async function uploadMarkdownImage(target, filePath) {
    if (!filePath)
        return { ok: false, msg: '没给图片路径' };
    if (!existsSync(filePath))
        return { ok: false, msg: '文件不存在: ' + filePath };
    const ext = extOf(filePath);
    const contentType = SUPPORTED[ext];
    if (!contentType)
        return { ok: false, msg: '只支持 png/jpeg/gif/webp，当前扩展名: ' + (ext || '(无)') };
    let buf;
    try {
        buf = readFileSync(filePath);
    }
    catch (e) {
        return { ok: false, msg: '读取失败: ' + (e instanceof Error ? e.message : String(e)) };
    }
    if (buf.length === 0)
        return { ok: false, msg: '空文件' };
    if (buf.length > MAX_BYTES)
        return { ok: false, msg: '超过 10MB 上限（' + buf.length + ' 字节）' };
    const sha256 = createHash('sha256').update(buf).digest('hex');
    // 文件名带内容指纹：同名 = 同图，list 命中即精确
    const fileName = baseNameOf(filePath).slice(0, 40) + '_' + sha256.slice(0, 12) + '.' + ext;
    const size = imageSize(buf);
    // ① 先在服务端列表里找同名图（权威：已过期/被删的不在列表里）
    const existing = await listOnce(target);
    const hit = existing.find((x) => String(x.file_name || '') === fileName && String(x.url || '').trim() !== '');
    if (hit) {
        return {
            ok: true,
            url: String(hit.url),
            imageId: String(hit.image_id || ''),
            width: size.width,
            height: size.height,
            bytes: buf.length,
            cached: true,
        };
    }
    const md5 = createHash('md5').update(buf).digest('hex');
    const sha1 = createHash('sha1').update(buf).digest('hex');
    // ② prepare
    const prep = await target.apiCall('POST', '/v2/media-images/prepare', {
        file_name: fileName,
        file_size: buf.length,
        content_type: contentType,
        md5,
        sha1,
    });
    if (!prep.ok)
        return { ok: false, msg: 'prepare 失败: ' + (prep.err?.human || prep.err?.code || '未知') };
    const pd = (prep.data ?? {});
    const uploadId = String(pd.upload_id ?? '');
    const presigned = String(pd.presigned_url ?? '');
    if (!uploadId || !presigned)
        return { ok: false, msg: 'prepare 返回缺字段: ' + JSON.stringify(pd).slice(0, 200) };
    // ③ PUT 直传（Content-Type 必须与 prepare 一致，否则 COS 403）
    let etag = md5;
    try {
        const put = await fetch(presigned, {
            method: 'PUT',
            headers: { 'content-type': contentType },
            body: new Uint8Array(buf),
        });
        if (!put.ok) {
            const body = await put.text().catch(() => '');
            return { ok: false, msg: '直传失败 HTTP ' + put.status + ' ' + body.slice(0, 120) };
        }
        const raw = put.headers.get('etag') ?? '';
        if (raw)
            etag = raw.replace(/^"+|"+$/g, '');
    }
    catch (e) {
        return { ok: false, msg: '直传异常: ' + (e instanceof Error ? e.message : String(e)) };
    }
    // ④ complete（md5 用 ETag）
    const done = await target.apiCall('POST', '/v2/media-images/complete', { upload_id: uploadId, md5: etag });
    if (!done.ok)
        return { ok: false, msg: 'complete 失败: ' + (done.err?.human || done.err?.code || '未知') };
    const dd = (done.data ?? {});
    const url = String(dd.url ?? '');
    const imageIdFinal = String(dd.image_id ?? '');
    // 2026-10-21（主人要求）：**用 list 核实** —— complete 说成功但列表里没有 = 没真上去，别当成功。
    try {
        const chk = await listMarkdownImages(target);
        if (chk.ok) {
            const arr = (chk.data ?? {}).images ?? [];
            if (arr.length > 0 && !arr.some((x) => String(x.image_id || '') === imageIdFinal)) {
                return { ok: false, msg: 'complete 成功但 list 查不到该图（image_id=' + imageIdFinal + '），视为上传失败' };
            }
        }
    }
    catch { /* list 不可用则按成功处理 */ }
    if (!url)
        return { ok: false, msg: 'complete 返回缺 url: ' + JSON.stringify(dd).slice(0, 200) };
    const previewUrl = String(dd.preview_url ?? '');
    return {
        ok: true,
        url,
        previewUrl,
        imageId: imageIdFinal,
        width: size.width,
        height: size.height,
        bytes: buf.length,
        cached: false,
    };
}
/** 查询有效图片列表 */
export async function listMarkdownImages(target, cursor = '') {
    const q = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
    const r = await target.apiCall('GET', '/v2/media-images' + q);
    if (!r.ok)
        return { ok: false, msg: r.err?.human || r.err?.code || '未知错误' };
    return { ok: true, data: r.data };
}
/** 删除一张图片（释放配额；已发出的消息不受影响） */
export async function deleteMarkdownImage(target, imageId) {
    if (!imageId)
        return { ok: false, msg: '缺 image_id' };
    const r = await target.apiCall('DELETE', '/v2/media-images/' + encodeURIComponent(imageId) + '/delete');
    if (!r.ok)
        return { ok: false, msg: r.err?.human || r.err?.code || '未知错误' };
    return { ok: true };
}
//# sourceMappingURL=md-media.js.map