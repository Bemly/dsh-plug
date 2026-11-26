import { diagWriteAlways } from './diag.js';

const MIRRORED = Symbol.for('dsh-botqq.logger-mirrored');
/** 落盘文件名 ⇒ `{DSH_HOME|~/.dsh}/qqbot-logger.log`（2MB 轮转，只留 1 份旧档） */
const FILE = 'qqbot-logger';
const MAX_ROW = 2000;

function render(args) {
    return args.map((arg) => {
        if (typeof arg === 'string')
            return arg;
        if (arg instanceof Error)
            return `${arg.name}: ${arg.message}`;
        try {
            return JSON.stringify(arg);
        }
        catch {
            return String(arg);
        }
    }).join(' ').slice(0, MAX_ROW);
}

/**
 * 给 logger 叠一层"warn/error 同时落盘"。
 *
 * 宿主 logger 只往 stdout 写，而 stdout 并不可靠：fnOS 网关包一层 spawn，日志文件由 logrotate
 * 轮转且没有 `copytruncate` ⇒ 长驻进程会继续往被删除的 inode 写，`/var/log/apps/<app>.log` 恒 0 字节
 * （2026-11-26 排查会话消失时踩到：`resume 失败(改走 create): … err=` 一行都查不到）。
 * 只镜像 warn/error —— 出问题的那几行必须留痕，日常 info 不进文件免得把盘写脏。
 *
 * 幂等：已经镜像过的对象原样返回，重复包装不会写两遍。
 */
export function mirrorLogger(base) {
    if (!base || typeof base !== 'object')
        return base;
    if (base[MIRRORED] === true)
        return base;
    return new Proxy(base, {
        get(target, prop) {
            if (prop === MIRRORED)
                return true;
            const value = Reflect.get(target, prop, target);
            if ((prop !== 'warn' && prop !== 'error') || typeof value !== 'function')
                return value;
            return (...args) => {
                diagWriteAlways(FILE, `${prop}: ${render(args)}`);
                return value.apply(target, args);
            };
        },
    });
}
