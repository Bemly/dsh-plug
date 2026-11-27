/**
 * packer.mjs — 纯几何「弹性切分树 + 模拟退火」自适应多图网格装箱算法
 *
 * 核心原则：
 *   1. 纯几何赋权：按长宽比 R_i = max(w/h, h/w) 的幂次 ω_i = R_i^aspectPower 赋权，
 *      使细长图在面积分配中获得补偿，避免短边被压扁导致文字/细节不可读；
 *   2. 零留白占满（BRIC fill 为主力）：在切分树的每个格子内扣除细分隔线 gutter 后直接占满，
 *      不截断缩小、不人为留白；仅在极少张数对抗输入（N<=4）且 strict 显著更优时兜底回退；
 *   3. 严格不拉伸、不旋转，输出画布自动对齐 token 网格步长 P，确保落在 1120-token 预算内。
 */

import {
    resolvePreset,
    checkCanvas,
    canvasCandidates,
} from './tokenBudget.mjs';

const OP_H = -1; // 左右并排（同高）
const OP_V = -2; // 上下堆叠（同宽）

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/** 校验波兰表达式是否满足 ballot 条件（每步栈深 >= 1，结尾栈深 === 1） */
function isValidBallot(expr, len) {
    let stack = 0;
    for (let i = 0; i < len; i++) {
        if (expr[i] >= 0) {
            stack++;
        } else {
            stack--;
            if (stack < 1) return false;
        }
    }
    return stack === 1;
}

/** 生成平衡切分树对应的波兰表达式（按层交替 H/V，避免链式骨架掉入窄长局部最优） */
function buildBalancedExpr(orderedIndices, startDepth = 0) {
    function build(arr, depth) {
        if (arr.length === 1) return [arr[0]];
        const mid = Math.floor(arr.length / 2);
        const leftPart = build(arr.slice(0, mid), depth + 1);
        const rightPart = build(arr.slice(mid), depth + 1);
        const op = depth % 2 === 0 ? OP_H : OP_V;
        return leftPart.concat(rightPart, [op]);
    }
    return Int32Array.from(build(orderedIndices, startDepth));
}

/** 格式化波兰表达式便于调试/记录 */
function formatExpr(expr) {
    const out = [];
    for (let i = 0; i < expr.length; i++) {
        if (expr[i] === OP_H) out.push('H');
        else if (expr[i] === OP_V) out.push('V');
        else out.push(expr[i]);
    }
    return out.join(' ');
}

/**
 * 在 1120-token 预算内打包多张图片尺寸
 * @param {Array<{w:number, h:number, weight?:number}>} sizes
 * @param {object} opts
 */
export function pack(sizes, opts = {}) {
    const tStart = performance.now();
    if (!Array.isArray(sizes) || sizes.length === 0) {
        throw new Error('sizes 必须是非空数组');
    }

    const {
        preset: presetOpt = 'standard',
        aspectPower = 0.85,
        delta = 0.15,
        gutter = 0,
        restarts = 8,
        iters: itersOpt = null,
        seed = 20261127,
        maxUpscale = Infinity,
        mode: modeOpt = 'auto',
    } = opts;

    if (modeOpt !== 'auto' && modeOpt !== 'fill' && modeOpt !== 'strict') {
        throw new Error(`无效 mode: ${modeOpt}（可选 'auto' | 'fill' | 'strict'）`);
    }

    const N = sizes.length;
    const aspects = new Float64Array(N);
    const ratioList = new Float64Array(N);
    const weights = new Float64Array(N);
    const sqrtW = new Float64Array(N);
    const bases = new Float64Array(N);
    const leafUnitW = new Float64Array(N);
    const leafUnitH = new Float64Array(N);

    for (let i = 0; i < N; i++) {
        const s = sizes[i];
        if (!s || !(Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0)) {
            throw new Error(`第 ${i} 张图尺寸无效: ${JSON.stringify(s)}`);
        }
        const extraWeight = s.weight === undefined ? 1 : Number(s.weight);
        if (!(Number.isFinite(extraWeight) && extraWeight > 0)) {
            throw new Error(`第 ${i} 张图权重无效: ${String(s.weight)}`);
        }
        const a = s.w / s.h;
        const R = a >= 1 ? a : 1 / a;
        const wt = Math.pow(R, aspectPower) * extraWeight;

        aspects[i] = a;
        ratioList[i] = R;
        weights[i] = wt;
        sqrtW[i] = Math.sqrt(wt);
        const base = Math.sqrt(s.w * s.h) / sqrtW[i];
        bases[i] = base;
        leafUnitW[i] = s.w / base;
        leafUnitH[i] = s.h / base;
    }

    const preset = resolvePreset(presetOpt);
    const { P } = preset;
    const cands = canvasCandidates(preset);

    const M = 2 * N - 1;
    // 预分配所有工作数组，SA 内循环零 GC 分配
    const left = new Int32Array(M);
    const right = new Int32Array(M);
    const stack = new Int32Array(M);
    const asp = new Float64Array(M);
    const nodeW = new Float64Array(M);
    const nodeH = new Float64Array(M);
    const leafEll = new Float64Array(N);
    const unitW = new Float64Array(M);
    const unitH = new Float64Array(M);

    const evalOut = {
        fillScore: -1,
        fillMin: 0,
        fillCandIdx: 0,
        fillBoxW: 0,
        fillBoxH: 0,
        strictK: -1,
        strictCandIdx: 0,
        strictBoxW: 0,
        strictBoxH: 0,
    };

    function evaluate(expr, needFill, needStrict) {
        let sp = 0;
        for (let k = 0; k < M; k++) {
            const t = expr[k];
            if (t >= 0) {
                left[k] = -1;
                right[k] = -1;
                asp[k] = aspects[t];
                if (needStrict) {
                    unitW[k] = leafUnitW[t];
                    unitH[k] = leafUnitH[t];
                }
                stack[sp++] = k;
            } else {
                const r = stack[--sp];
                const l = stack[--sp];
                left[k] = l;
                right[k] = r;
                if (t === OP_H) {
                    asp[k] = asp[l] + asp[r];
                    if (needStrict) {
                        unitW[k] = unitW[l] + unitW[r];
                        unitH[k] = unitH[l] > unitH[r] ? unitH[l] : unitH[r];
                    }
                } else {
                    const al = asp[l];
                    const ar = asp[r];
                    asp[k] = (al * ar) / (al + ar);
                    if (needStrict) {
                        unitW[k] = unitW[l] > unitW[r] ? unitW[l] : unitW[r];
                        unitH[k] = unitH[l] + unitH[r];
                    }
                }
                stack[sp++] = k;
            }
        }

        if (needFill) {
            const rootAsp = asp[M - 1];
            nodeW[M - 1] = 1;
            nodeH[M - 1] = 1 / rootAsp;
            for (let k = M - 1; k >= 0; k--) {
                const t = expr[k];
                if (t >= 0) {
                    leafEll[t] = Math.sqrt(nodeW[k] * nodeH[k]) / sqrtW[t];
                } else {
                    const l = left[k];
                    const r = right[k];
                    if (t === OP_H) {
                        const h = nodeH[k];
                        nodeH[l] = h;
                        nodeW[l] = h * asp[l];
                        nodeH[r] = h;
                        nodeW[r] = h * asp[r];
                    } else {
                        const w = nodeW[k];
                        nodeW[l] = w;
                        nodeH[l] = w / asp[l];
                        nodeW[r] = w;
                        nodeH[r] = w / asp[r];
                    }
                }
            }

            let fillCandIdx = 0;
            let fillBoxW = -1;
            let fillTiles = Infinity;
            for (let i = 0; i < cands.length; i++) {
                const c = cands[i];
                const candW = c.H * rootAsp;
                const bw = c.W < candW ? c.W : candW;
                if (bw > fillBoxW + 1e-9 || (Math.abs(bw - fillBoxW) <= 1e-9 && c.tiles < fillTiles)) {
                    fillBoxW = bw;
                    fillCandIdx = i;
                    fillTiles = c.tiles;
                }
            }

            const fillBoxH = fillBoxW / rootAsp;
            const cand = cands[fillCandIdx];
            const fW = Math.max(P, Math.min(cand.W, Math.ceil((fillBoxW - 1e-9) / P) * P));
            const fH = Math.max(P, Math.min(cand.H, Math.ceil((fillBoxH - 1e-9) / P) * P));
            const fillUtil = (fillBoxW * fillBoxH) / (fW * fH);

            let mn = Infinity;
            let mx = 0;
            let sum = 0;
            for (let i = 0; i < N; i++) {
                const e = leafEll[i] * fillBoxW;
                if (e < mn) mn = e;
                if (e > mx) mx = e;
                sum += e;
            }
            const mean = sum / N;
            const spread = mx / mn;
            const excess = spread > 1 + delta ? spread - (1 + delta) : 0;
            const fillScore =
                ((0.75 * mn + 0.25 * mean) / (1 + 2.0 * excess)) /
                Math.pow(spread, 0.25) *
                Math.sqrt(fillUtil);

            evalOut.fillScore = fillScore;
            evalOut.fillMin = mn;
            evalOut.fillCandIdx = fillCandIdx;
            evalOut.fillBoxW = fillBoxW;
            evalOut.fillBoxH = fillBoxH;
        }

        if (needStrict) {
            const Wb = unitW[M - 1];
            const Hb = unitH[M - 1];
            let strictCandIdx = 0;
            let strictK = -1;
            let strictTiles = Infinity;
            for (let i = 0; i < cands.length; i++) {
                const c = cands[i];
                const kw = c.W / Wb;
                const kh = c.H / Hb;
                const k = kw < kh ? kw : kh;
                if (k > strictK + 1e-9 || (Math.abs(k - strictK) <= 1e-9 && c.tiles < strictTiles)) {
                    strictK = k;
                    strictCandIdx = i;
                    strictTiles = c.tiles;
                }
            }
            evalOut.strictK = strictK;
            evalOut.strictCandIdx = strictCandIdx;
            evalOut.strictBoxW = strictK * Wb;
            evalOut.strictBoxH = strictK * Hb;
        }
    }

    function runSA(target) {
        const isFill = target === 'fill';
        const rng = mulberry32(isFill ? seed : seed ^ 0x9e3779b9);
        const sortedIdx = Array.from({ length: N }, (_, i) => i).sort((a, b) => aspects[a] - aspects[b]);

        const iters = itersOpt ?? clamp(6000 * N, 20000, 300000);
        const T0 = 0.12;
        const ratio = 0.005; // T1 = 0.0006
        const curOpPos = new Int32Array(N - 1);
        const curOperandPos = new Int32Array(N);

        let bestExpr = null;
        let bestScore = -Infinity;
        let bestMin = 0;

        for (let r = 0; r < restarts; r++) {
            let expr;
            if (r === 0) {
                expr = buildBalancedExpr(sortedIdx, 0);
            } else {
                const shuffled = sortedIdx.slice();
                for (let i = N - 1; i > 0; i--) {
                    const j = Math.floor(rng() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
                expr = buildBalancedExpr(shuffled, r % 2);
                if (r > 1) {
                    for (let i = 0; i < M; i++) {
                        if (expr[i] < 0 && rng() < 0.3) {
                            expr[i] = expr[i] === OP_H ? OP_V : OP_H;
                        }
                    }
                }
            }

            let oi = 0;
            let pi = 0;
            for (let i = 0; i < M; i++) {
                if (expr[i] >= 0) curOperandPos[oi++] = i;
                else curOpPos[pi++] = i;
            }

            evaluate(expr, isFill, !isFill);
            let curScore = isFill ? evalOut.fillScore : evalOut.strictK;
            const score0 = curScore > 1e-9 ? curScore : 1;
            if (curScore > bestScore) {
                bestScore = curScore;
                bestMin = isFill ? evalOut.fillMin : evalOut.strictK;
                bestExpr = new Int32Array(expr);
            }

            for (let it = 0; it < iters; it++) {
                const Temp = T0 * Math.pow(ratio, it / (iters - 1));
                const mv = rng();

                if (mv < 0.4) {
                    const i1 = Math.floor(rng() * N);
                    let i2 = Math.floor(rng() * (N - 1));
                    if (i2 >= i1) i2++;
                    const p1 = curOperandPos[i1];
                    const p2 = curOperandPos[i2];
                    const tmp = expr[p1];
                    expr[p1] = expr[p2];
                    expr[p2] = tmp;

                    evaluate(expr, isFill, !isFill);
                    const ns = isFill ? evalOut.fillScore : evalOut.strictK;
                    const deltaS = ns - curScore;
                    if (deltaS >= 0 || rng() < Math.exp(deltaS / (Temp * score0))) {
                        curScore = ns;
                        if (ns > bestScore) {
                            bestScore = ns;
                            bestMin = isFill ? evalOut.fillMin : evalOut.strictK;
                            bestExpr = new Int32Array(expr);
                        }
                    } else {
                        expr[p2] = expr[p1];
                        expr[p1] = tmp;
                    }
                } else if (mv < 0.7) {
                    const idx = Math.floor(rng() * (N - 1));
                    const p = curOpPos[idx];
                    const oldOp = expr[p];
                    expr[p] = oldOp === OP_H ? OP_V : OP_H;

                    evaluate(expr, isFill, !isFill);
                    const ns = isFill ? evalOut.fillScore : evalOut.strictK;
                    const deltaS = ns - curScore;
                    if (deltaS >= 0 || rng() < Math.exp(deltaS / (Temp * score0))) {
                        curScore = ns;
                        if (ns > bestScore) {
                            bestScore = ns;
                            bestMin = isFill ? evalOut.fillMin : evalOut.strictK;
                            bestExpr = new Int32Array(expr);
                        }
                    } else {
                        expr[p] = oldOp;
                    }
                } else {
                    const p = Math.floor(rng() * (M - 1));
                    const a = expr[p];
                    const b = expr[p + 1];
                    if ((a >= 0) === (b >= 0)) continue;
                    expr[p] = b;
                    expr[p + 1] = a;
                    if (!isValidBallot(expr, M)) {
                        expr[p] = a;
                        expr[p + 1] = b;
                        continue;
                    }

                    evaluate(expr, isFill, !isFill);
                    const ns = isFill ? evalOut.fillScore : evalOut.strictK;
                    const deltaS = ns - curScore;
                    if (deltaS >= 0 || rng() < Math.exp(deltaS / (Temp * score0))) {
                        curScore = ns;
                        let oi2 = 0;
                        let pi2 = 0;
                        for (let k = 0; k < M; k++) {
                            if (expr[k] >= 0) curOperandPos[oi2++] = k;
                            else curOpPos[pi2++] = k;
                        }
                        if (ns > bestScore) {
                            bestScore = ns;
                            bestMin = isFill ? evalOut.fillMin : evalOut.strictK;
                            bestExpr = new Int32Array(expr);
                        }
                    } else {
                        expr[p] = a;
                        expr[p + 1] = b;
                    }
                }
            }
        }

        return { expr: bestExpr, score: bestScore, minSigma: bestMin };
    }

    // 4. 求解最优树与模式选择
    let bestExpr = null;
    let mode = 'fill';

    if (N === 1) {
        bestExpr = Int32Array.from([0]);
        mode = modeOpt === 'strict' ? 'strict' : 'fill';
    } else if (N === 2) {
        const candH = Int32Array.from([0, 1, OP_H]);
        const candV = Int32Array.from([0, 1, OP_V]);
        evaluate(candH, true, true);
        const fH = { ...evalOut };
        evaluate(candV, true, true);
        const fV = { ...evalOut };

        const bestFillExpr = fH.fillScore >= fV.fillScore ? candH : candV;
        const bestFillMin = fH.fillScore >= fV.fillScore ? fH.fillMin : fV.fillMin;
        const bestStrictExpr = fH.strictK >= fV.strictK ? candH : candV;
        const bestStrictK = fH.strictK >= fV.strictK ? fH.strictK : fV.strictK;

        if (modeOpt === 'strict' || (modeOpt === 'auto' && bestStrictK > bestFillMin * 1.15)) {
            mode = 'strict';
            bestExpr = bestStrictExpr;
        } else {
            mode = 'fill';
            bestExpr = bestFillExpr;
        }
    } else if (modeOpt === 'strict') {
        mode = 'strict';
        bestExpr = runSA('strict').expr;
    } else if (modeOpt === 'fill' || N >= 5) {
        mode = 'fill';
        bestExpr = runSA('fill').expr;
    } else {
        // mode === 'auto' && (N === 3 || N === 4)
        const fillRes = runSA('fill');
        const strictRes = runSA('strict');
        if (strictRes.score > fillRes.minSigma * 1.15) {
            mode = 'strict';
            bestExpr = strictRes.expr;
        } else {
            mode = 'fill';
            bestExpr = fillRes.expr;
        }
    }

    // 5. 用全局最优表达式重建最终像素布局
    evaluate(bestExpr, mode === 'fill', mode === 'strict');
    const cand = cands[mode === 'fill' ? evalOut.fillCandIdx : evalOut.strictCandIdx];
    const rawBoxW = mode === 'fill' ? evalOut.fillBoxW : evalOut.strictBoxW;
    const rawBoxH = mode === 'fill' ? evalOut.fillBoxH : evalOut.strictBoxH;
    const kStrict = evalOut.strictK;

    const W = clamp(Math.round(rawBoxW), 1, cand.W);
    const H = clamp(Math.round(rawBoxH), 1, cand.H);
    const boxW = W;
    const boxH = H;
    const ox = 0;
    const oy = 0;

    const cells = new Array(M);
    cells[M - 1] = { x: ox, y: oy, w: boxW, h: boxH };

    const leafCells = new Array(N);
    for (let k = M - 1; k >= 0; k--) {
        const cell = cells[k];
        const t = bestExpr[k];
        if (t >= 0) {
            leafCells[t] = cell;
            continue;
        }
        const l = left[k];
        const r = right[k];
        if (mode === 'fill') {
            if (t === OP_H) {
                const lw = cell.h * asp[l];
                cells[l] = { x: cell.x, y: cell.y, w: lw, h: cell.h };
                cells[r] = { x: cell.x + lw, y: cell.y, w: cell.w - lw, h: cell.h };
            } else {
                const th = cell.w / asp[l];
                cells[l] = { x: cell.x, y: cell.y, w: cell.w, h: th };
                cells[r] = { x: cell.x, y: cell.y + th, w: cell.w, h: cell.h - th };
            }
        } else {
            const lw = kStrict * unitW[l];
            const lh = kStrict * unitH[l];
            const rw = kStrict * unitW[r];
            const rh = kStrict * unitH[r];
            if (t === OP_H) {
                cells[l] = { x: cell.x, y: cell.y + (cell.h - lh) / 2, w: lw, h: lh };
                cells[r] = { x: cell.x + lw, y: cell.y + (cell.h - rh) / 2, w: rw, h: rh };
            } else {
                cells[l] = { x: cell.x + (cell.w - lw) / 2, y: cell.y, w: lw, h: lh };
                cells[r] = { x: cell.x + (cell.w - rw) / 2, y: cell.y + lh, w: rw, h: rh };
            }
        }
    }

    // 6. 每个叶子直接占满分配的 cell（仅扣除 gutter 分隔线），不再人为截断留白
    const placements = new Array(N);
    let lMin = Infinity;
    let lMax = 0;
    let shortMin = Infinity;
    let shortMax = 0;
    let sigmaMin = Infinity;
    let sigmaMax = 0;
    let sumArea = 0;

    for (let i = 0; i < N; i++) {
        const { w: wi, h: hi } = sizes[i];
        const cell = leafCells[i];
        // 先将共享浮点边界量化为整数像素框，确保 gutter=0 时相邻格子也绝不重叠
        const ix0 = clamp(Math.round(cell.x), 0, W - 1);
        const iy0 = clamp(Math.round(cell.y), 0, H - 1);
        const ix1 = clamp(Math.round(cell.x + cell.w), ix0 + 1, W);
        const iy1 = clamp(Math.round(cell.y + cell.h), iy0 + 1, H);
        const boxWi = ix1 - ix0;
        const boxHi = iy1 - iy0;

        const availW = Math.max(1, boxWi - gutter);
        const availH = Math.max(1, boxHi - gutter);
        const rawScale = Math.min(availW / wi, availH / hi);
        const nativeCapped = rawScale > maxUpscale;
        const s = nativeCapped ? maxUpscale : rawScale;

        let dw;
        let dh;
        const maxDw = Math.max(1, Math.floor(availW));
        const maxDh = Math.max(1, Math.floor(availH));
        if (wi >= hi) {
            dh = clamp(Math.floor(hi * s), 1, maxDh);
            dw = Math.max(1, Math.round(dh * (wi / hi)));
            while (dw > maxDw && dh > 1) {
                dh--;
                dw = Math.max(1, Math.round(dh * (wi / hi)));
            }
            if (dw > maxDw) dw = maxDw;
        } else {
            dw = clamp(Math.floor(wi * s), 1, maxDw);
            dh = Math.max(1, Math.round(dw * (hi / wi)));
            while (dh > maxDh && dw > 1) {
                dw--;
                dh = Math.max(1, Math.round(dw * (hi / wi)));
            }
            if (dh > maxDh) dh = maxDh;
        }

        const x = ix0 + Math.floor((boxWi - dw) / 2);
        const y = iy0 + Math.floor((boxHi - dh) / 2);

        const longEdge = Math.max(dw, dh);
        const shortEdge = Math.min(dw, dh);
        if (longEdge < lMin) lMin = longEdge;
        if (longEdge > lMax) lMax = longEdge;
        if (shortEdge < shortMin) shortMin = shortEdge;
        if (shortEdge > shortMax) shortMax = shortEdge;

        const sigma = Math.sqrt(dw * dh) / sqrtW[i];
        if (sigma < sigmaMin) sigmaMin = sigma;
        if (sigma > sigmaMax) sigmaMax = sigma;
        sumArea += dw * dh;

        placements[i] = {
            idx: i,
            x,
            y,
            w: dw,
            h: dh,
            aspectRatio: Number(ratioList[i].toFixed(3)),
            weight: Number(weights[i].toFixed(4)),
            shortEdge,
            longEdge,
            sigma: Number(sigma.toFixed(2)),
            tokensApprox: Number(((dw * dh) / (P * P)).toFixed(1)),
            scale: Number((dw / wi).toFixed(4)),
            nativeCapped,
            cell: {
                x: Number(cell.x.toFixed(2)),
                y: Number(cell.y.toFixed(2)),
                w: Number(cell.w.toFixed(2)),
                h: Number(cell.h.toFixed(2)),
            },
        };
    }

    const token = checkCanvas(W, H, preset);
    const ms = Number((performance.now() - tStart).toFixed(1));

    return {
        canvas: {
            W,
            H,
            cols: token.cols,
            rows: token.rows,
            tiles: token.tiles,
        },
        placements,
        stats: {
            mode,
            aspectPower,
            lMin,
            lMax,
            shortMin,
            shortMax,
            sigmaMin: Number(sigmaMin.toFixed(2)),
            sigmaMax: Number(sigmaMax.toFixed(2)),
            spread: sigmaMax / sigmaMin,
            util: sumArea / (W * H),
            token,
            expr: formatExpr(bestExpr),
            ms,
        },
    };
}

/** 严格校验打包结果（越界、重叠、比例失真、token 预算，以及可选的 maxSpread） */
export function validate(result, sizes, opts = {}) {
    const {
        preset = 'standard',
        maxSpread = null,
    } = opts;

    const { canvas, placements, stats } = result;
    const { W, H } = canvas;

    if (!stats.token || !stats.token.ok) {
        const check = checkCanvas(W, H, preset);
        throw new Error(`Token 预算校验失败: ${(check.reasons || []).join('; ')}`);
    }
    const freshCheck = checkCanvas(W, H, preset);
    if (!freshCheck.ok) {
        throw new Error(`画布 ${W}×${H} 未通过预算复核: ${freshCheck.reasons.join('; ')}`);
    }

    if (placements.length !== sizes.length) {
        throw new Error(`输出数量 ${placements.length} 与输入 ${sizes.length} 不符`);
    }

    for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        const src = sizes[p.idx];
        if (p.x < 0 || p.y < 0 || p.x + p.w > W || p.y + p.h > H) {
            throw new Error(`图 ${p.idx} 越界: (${p.x},${p.y}) ${p.w}×${p.h} vs 画布 ${W}×${H}`);
        }
        const errW = Math.abs(p.w - p.h * (src.w / src.h));
        const errH = Math.abs(p.h - p.w * (src.h / src.w));
        if (errW > 1 || errH > 1) {
            throw new Error(
                `图 ${p.idx} 比例失真: 输出 ${p.w}×${p.h} vs 原图 ${src.w}×${src.h} (errW=${errW.toFixed(2)}, errH=${errH.toFixed(2)})`
            );
        }
        for (let j = i + 1; j < placements.length; j++) {
            const q = placements[j];
            const overlapX = p.x < q.x + q.w && p.x + p.w > q.x;
            const overlapY = p.y < q.y + q.h && p.y + p.h > q.y;
            if (overlapX && overlapY) {
                throw new Error(`图 ${p.idx} 与图 ${q.idx} 发生重叠`);
            }
        }
    }

    if (maxSpread !== null && maxSpread !== undefined && stats.spread > maxSpread + 1e-9) {
        throw new Error(
            `尺度波动 spread=${stats.spread.toFixed(4)} 超过允许上限 ${maxSpread} (sigmaMin=${stats.sigmaMin}, sigmaMax=${stats.sigmaMax})`
        );
    }

    return true;
}
