/**
 * tokenBudget.mjs — 默认高分辨率（1120 tokens）网格预算校验与画布候选生成
 *
 * 经验模型说明（非 Google 官方公开公式）：
 *   · 标准档 P = 64 px/token，保守档（密集小字/OCR）P = 60 px/token
 *   · 单图默认预算上限 T = 1120 tokens，长边最多 38 格（38×64 = 2432 px，38×60 = 2280 px）
 *   · 三个判定条件同时满足才不触发额外降采样且不产生残缺网格：
 *       (1) max(w, h) <= 38 * P
 *       (2) ceil(w / P) * ceil(h / P) <= 1120
 *       (3) w % P === 0 && h % P === 0
 *
 * 关键纠正：
 *   2560×2560（40×40 = 1600 格）在 P=64 时实际超出了 1120 格预算，会触发降采样；
 *   真正卡死的是网格总数，因此吃满预算的画布长宽比大约只在 29:38 ~ 38:29 之间
 *   （如 2432×1856 = 1102 格、2240×2048 = 1120 格、2112×2112 = 1089 格）。
 */

export const PRESETS = {
    standard: { P: 64, T: 1120, maxTilesLong: 38 },
    conservative: { P: 60, T: 1120, maxTilesLong: 38 },
};

/** 解析预设名或自定义参数对象 { P, T, maxTilesLong } */
export function resolvePreset(p = 'standard') {
    if (typeof p === 'string') {
        const preset = PRESETS[p];
        if (!preset) {
            throw new Error(`未知 token 预算预设: ${p}（可选: ${Object.keys(PRESETS).join(', ')}）`);
        }
        return { ...preset };
    }
    if (p && typeof p === 'object') {
        const P = Number(p.P);
        const T = Number(p.T);
        const maxTilesLong = Number(p.maxTilesLong);
        if (!(P > 0 && T > 0 && maxTilesLong > 0)) {
            throw new Error(`无效 token 预算参数: ${JSON.stringify(p)}`);
        }
        return { P, T, maxTilesLong };
    }
    throw new Error(`无效 preset 参数: ${String(p)}`);
}

/** 计算给定像素宽高对应的网格数 */
export function tilesOf(w, h, P) {
    return Math.ceil(w / P) * Math.ceil(h / P);
}

/** 校验画布尺寸 (w, h) 是否落在 1120-token 网格预算内 */
export function checkCanvas(w, h, preset = 'standard', { alignGrid = false } = {}) {
    const { P, T, maxTilesLong } = resolvePreset(preset);
    const reasons = [];
    if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) {
        return {
            ok: false,
            cols: 0,
            rows: 0,
            tiles: 0,
            longPx: 0,
            reasons: ['画布宽高必须为正整数'],
        };
    }

    const cols = Math.ceil(w / P);
    const rows = Math.ceil(h / P);
    const tiles = cols * rows;
    const longPx = Math.max(w, h);
    const maxLongPx = maxTilesLong * P;

    if (longPx > maxLongPx) {
        reasons.push(`长边 ${longPx} px 超过上限 ${maxLongPx} px（${maxTilesLong}×${P}）`);
    }
    if (tiles > T) {
        reasons.push(`网格数 ${cols}×${rows} = ${tiles} 超过预算上限 ${T}`);
    }
    if (alignGrid && (w % P !== 0 || h % P !== 0)) {
        reasons.push(`画布尺寸 ${w}×${h} 未对齐网格步长 P=${P}（存在残缺格）`);
    }

    return {
        ok: reasons.length === 0,
        cols,
        rows,
        tiles,
        longPx,
        reasons,
    };
}

/** 生成所有 Pareto 最优候选网格画布（共 maxTilesLong 个） */
export function canvasCandidates(preset = 'standard') {
    const { P, T, maxTilesLong } = resolvePreset(preset);
    const cands = [];
    for (let cols = 1; cols <= maxTilesLong; cols++) {
        const rows = Math.min(maxTilesLong, Math.floor(T / cols));
        if (rows >= 1) {
            cands.push({
                cols,
                rows,
                W: cols * P,
                H: rows * P,
                tiles: cols * rows,
            });
        }
    }
    return cands;
}

/** 为指定宽高比 aspect = W/H 的盒子寻找能放下的最大像素尺寸候选画布 */
export function bestFit(aspect, cands) {
    if (!(aspect > 0) || !Array.isArray(cands) || cands.length === 0) {
        throw new Error('bestFit 需要正的宽高比与非空候选列表');
    }
    let bestCand = null;
    let bestW = -1;
    let bestTiles = Infinity;

    for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const boxW = Math.min(c.W, c.H * aspect);
        if (boxW > bestW + 1e-9 || (Math.abs(boxW - bestW) <= 1e-9 && c.tiles < bestTiles)) {
            bestW = boxW;
            bestCand = c;
            bestTiles = c.tiles;
        }
    }

    return {
        cand: bestCand,
        boxW: bestW,
        boxH: bestW / aspect,
    };
}
