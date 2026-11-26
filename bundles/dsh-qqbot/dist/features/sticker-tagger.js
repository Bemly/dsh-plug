/**
 * sticker-tagger.ts — 新图后台自动打标(tags + 详细描述)
 *
 * 用本机已装的 modlens 视觉 CLI(openai 视觉 key)看图, 产出:
 *  - desc: 中文一句话详细描述(画面+情绪+适合场景), 供 list_stickers 返回挑选决策;
 *  - tags: 中文短标签(优先视觉输出【标签】行, 否则从 scene/intent/实体启发提取)。
 * CLI 不可用/超时/失败 → 返回 null, 由调用方把图标记 needsDescribe(待人工整理)。
 *
 * ⚠️ 本地手改功能(fork 新增)。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

let hostVisionBaseUrl = 'https://ai.bemly.moe';
let hostVisionApiKeyEnv = 'KFC_API_KEY';
let hostVisionModel = 'Qwen/Qwen3.6-27B-FP8';

function resolveVisionApiKey() {
    if (process.env[hostVisionApiKeyEnv])
        return process.env[hostVisionApiKeyEnv];
    const dshHome = process.env.DSH_HOME || '';
    const candidates = [
        dshHome ? `${dshHome}/.credentials.yaml` : '',
        dshHome ? `${dshHome}/profiles/web/.credentials.yaml` : '',
        `${process.env.HOME || ''}/.credentials.yaml`,
    ];
    for (const p of candidates) {
        try {
            if (!p || !existsSync(p))
                continue;
            const raw = readFileSync(p, 'utf8');
            const m = raw.match(new RegExp(`(?:^|\\n)\\s*${hostVisionApiKeyEnv}\\s*:\\s*["']?([^\\s"'\r\n]+)["']?`));
            if (m?.[1])
                return m[1].trim();
        }
        catch { /* ignore */ }
    }
    return '';
}

/** 由 im-qqbot 启动时配置视觉模型端点、模型和密钥环境变量 */
export function setStickerVisionLlm(
    _llmOrGetter,
    providerOrBaseUrl = 'https://ai.bemly.moe',
    model = 'Qwen/Qwen3.6-27B-FP8',
    apiKeyEnv = 'KFC_API_KEY',
) {
    if (providerOrBaseUrl && /^https?:\/\//i.test(String(providerOrBaseUrl))) {
        hostVisionBaseUrl = String(providerOrBaseUrl).replace(/\/+$/, '');
    }
    if (model)
        hostVisionModel = String(model);
    if (apiKeyEnv)
        hostVisionApiKeyEnv = String(apiKeyEnv);
}

async function autoTagViaHostLlm(localPath, logger) {
    const apiKey = resolveVisionApiKey();
    const baseUrl = hostVisionBaseUrl.replace(/\/+$/, '');
    if (!baseUrl)
        return null;
    try {
        const ext = extname(localPath).toLowerCase();
        const mimeMap = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
        };
        let mimeType = mimeMap[ext] || 'image/png';
        let buf = readFileSync(localPath);
        // 大图(>350KB)或动图(gif)先用 ffmpeg 缩成首帧 ≤512px JPEG，避免触发网关 HTTP 413
        if (buf.length > 350 * 1024 || ext === '.gif') {
            try {
                const compressed = execFileSync('ffmpeg', [
                    '-v', 'error',
                    '-i', localPath,
                    '-frames:v', '1',
                    '-vf', "scale='min(512,iw)':-2",
                    '-f', 'image2pipe',
                    '-vcodec', 'mjpeg',
                    '-q:v', '6',
                    'pipe:1',
                ], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
                if (compressed && compressed.length > 0 && compressed.length < buf.length) {
                    buf = compressed;
                    mimeType = 'image/jpeg';
                }
            }
            catch { /* 压缩失败则回退原图 */ }
        }
        const data = buf.toString('base64');
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey)
            headers['Authorization'] = `Bearer ${apiKey}`;
        const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: hostVisionModel,
                max_tokens: 256,
                messages: [
                    {
                        role: 'system',
                        content: '你是 QQ 群聊表情包自动打标助手，只按要求输出【标签】和【描述】两行。',
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } },
                            { type: 'text', text: PROMPT },
                        ],
                    },
                ],
            }),
            signal: AbortSignal.timeout(45000),
        });
        if (!resp.ok) {
            const errTxt = await resp.text().catch(() => '');
            logger?.warn?.(`[sticker-tagger] 视觉接口 HTTP ${resp.status}: ${errTxt.slice(0, 160)}`);
            return null;
        }
        const json = await resp.json();
        const content = json?.choices?.[0]?.message?.content;
        const summary = (typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
                : '').trim();
        if (!summary)
            return null;
        const { tags, desc } = parseSummary(summary, {});
        if (!desc && tags.length === 0)
            return null;
        return { tags, desc };
    }
    catch (err) {
        logger?.warn?.(`[sticker-tagger] 视觉模型(${hostVisionModel})打标失败: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
const MODLENS_CANDIDATES = [
// 公开版不内置任何机器绝对路径。用法: 配置 sticker.visionCli 命令模板(含 {img}), 或把本机视觉 CLI 路径加进候选数组。
];
const PROMPT = '请用简体中文回答，只输出两行，不要输出其他内容：第一行以【标签】开头，给出 3-6 个逗号分隔的中文短标签（从内容/情绪/用途三个维度）；第二行以【描述】开头，给一句中文详细描述（画面内容+情绪+适合在什么群聊场合用这张图）。';
const GENERIC = new Set(['人物', '物品', '画面', '图片', '图像', '场景', '内容', '插画', '动漫', '二次元', '背景', '角色', '风格']);
/** 找可用的 modlens CLI 路径(缓存) */
let cliPath;
function resolveCli() {
    if (cliPath !== undefined)
        return cliPath ?? undefined;
    cliPath = null;
    for (const p of MODLENS_CANDIDATES) {
        if (existsSync(p)) {
            cliPath = p;
            return p;
        }
    }
    return undefined;
}
/** 简易命令行切分(支持双引号), 供 visionCli 模板使用 */
function splitArgs(cmd) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
        const w = m[1] ?? m[2] ?? m[3];
        if (typeof w === 'string')
            out.push(w);
    }
    return out;
}
/**
 * 对本地图片自动打标。visionCli 为空时自动探测本机 modlens(仅作一个候选实现);
 * 探测不到/失败 → null(图保持"待整理", 由 agent 视觉工具补——引擎与具体插件解耦)。
 */
export async function autoTagImage(localPath, visionCli, logger) {
    let argv;
    const templ = (visionCli ?? '').trim();
    if (templ) {
        argv = splitArgs(templ.replaceAll('{img}', localPath));
    }
    else {
        // 优先走宿主 ctx.llm（默认 kfc / Qwen/Qwen3.6-27B-FP8），免外部脚本与密钥
        const hostRes = await autoTagViaHostLlm(localPath, logger);
        if (hostRes)
            return hostRes;
        const cli = resolveCli();
        if (!cli) {
            logger?.debug?.('[sticker-tagger] 无可用视觉CLI(config.visionCli 为空且未探测到), 跳过自动打标');
            return null;
        }
        argv = ['node', cli, 'analyze', '-i', localPath, '--prompt', PROMPT];
    }
    if (!argv || argv.length === 0)
        return null;
    const bin = argv[0];
    if (!bin)
        return null;
    try {
        const stdout = await new Promise((resolve, reject) => {
            execFile(bin, argv.slice(1), {
                encoding: 'utf8',
                timeout: 90_000,
                windowsHide: true,
                maxBuffer: 4 * 1024 * 1024,
            }, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const m = stdout.match(/\{[\s\S]*\}/);
        if (!m)
            return null;
        const parsed = JSON.parse(m[0]);
        const summary = parsed?.result?.summary?.trim();
        if (!summary)
            return null;
        const { tags, desc } = parseSummary(summary, parsed.result);
        if (!desc && tags.length === 0)
            return null;
        return { tags, desc };
    }
    catch (err) {
        logger?.debug?.(`[sticker-tagger] 自动打标失败: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/** 启发式从语义字段取标签(视觉未输出【标签】行时兜底) */
function heuristicTags(json) {
    const out = [];
    const push = (s) => {
        if (!s)
            return;
        const t = s.trim().replace(/[，,。.!！?？]/g, ' ').split(/\s+/).filter(Boolean);
        for (const w of t) {
            const clean = w.trim().slice(0, 12);
            if (clean && !GENERIC.has(clean) && !out.includes(clean))
                out.push(clean);
            if (out.length >= 5)
                return;
        }
    };
    const sem = json?.semantics ?? {};
    push(sem.scene);
    for (const e of sem.entities ?? [])
        push(e.name);
    push(sem.intent);
    return out.slice(0, 6);
}
/** 解析视觉输出: 优先【标签】/【描述】行 */
function parseSummary(summary, json) {
    const tags = [];
    let desc = '';
    const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (line.startsWith('【标签】') || line.startsWith('标签:')) {
            for (const t of line.replace(/^【标签】|^标签:/, '').split(/[,，]/)) {
                const c = t.trim().replace(/^[0-9]+[.、]/, '').trim();
                if (c && !tags.includes(c))
                    tags.push(c.slice(0, 12));
            }
        }
        else if (line.startsWith('【描述】') || line.startsWith('描述:')) {
            desc = line.replace(/^【描述】|^描述:/, '').trim();
        }
        else if (!desc && line.length > desc.length) {
            desc = line; // 未按格式时整行作描述
        }
    }
    if (tags.length === 0)
        tags.push(...heuristicTags(json));
    return { tags: tags.slice(0, 8), desc: desc.slice(0, 300) };
}
//# sourceMappingURL=sticker-tagger.js.map