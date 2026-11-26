import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nsPathsOf } from '../features/ns-guard.js';
import { updateGroupBlocklist } from '../features/user-blocklist.js';
import { resolveProfileName } from '../shared/utils.js';

function targetOpenid(cmdCtx, raw) {
    const fromArg = String(raw ?? '').match(/[0-9A-Fa-f]{32}/u)?.[0];
    const quote = cmdCtx?.state?.quote;
    return String(fromArg ?? quote?.senderId ?? quote?.entry?.senderId ?? '').trim();
}

function persist(config, list) {
    const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
    const ns = String(config?.settingsNs || 'im-qqbot');
    const paths = nsPathsOf(home, ns, resolveProfileName());
    const file = paths.file;
    let data = {};
    try {
        const source = existsSync(file) ? file : paths.legacyFile;
        if (existsSync(source)) {
            const parsed = JSON.parse(readFileSync(source, 'utf8'));
            if (parsed && typeof parsed === 'object') data = parsed;
        }
    }
    catch { /* 保留其他设置，损坏时从空对象重建 */ }
    data.access = { ...(data.access && typeof data.access === 'object' ? data.access : {}), groupBlockedUsers: list };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    return file;
}

function usage() {
    return '用法：/block <32位openid>（也可引用对方消息），/unblock <openid>，/blocked 查看名单。';
}

export function blockCommand({ config, logger }) {
    return {
        name: ['block', '屏蔽'],
        description: '屏蔽群聊成员（主人专用）',
        handler: async (cmdCtx) => {
            const id = targetOpenid(cmdCtx, cmdCtx?.command?.raw);
            if (!id) return usage();
            const result = updateGroupBlocklist(config, id, true);
            if (!result.ok) return result.reason;
            try {
                persist(config, result.list);
                logger?.info?.(`[block] 已屏蔽群成员 ${id}`);
                return `已屏蔽 ${id}；其群聊消息将不进历史、不唤醒 AI。`;
            }
            catch (error) {
                return `内存中已屏蔽，但写入设置失败：${error instanceof Error ? error.message : String(error)}`;
            }
        },
    };
}

export function unblockCommand({ config, logger }) {
    return {
        name: ['unblock', '解禁'],
        description: '解除群聊成员屏蔽（主人专用）',
        handler: async (cmdCtx) => {
            const id = targetOpenid(cmdCtx, cmdCtx?.command?.raw);
            if (!id) return usage();
            const result = updateGroupBlocklist(config, id, false);
            if (!result.ok) return result.reason;
            try {
                persist(config, result.list);
                logger?.info?.(`[block] 已解除群成员 ${id}`);
                return `已解除 ${id} 的群聊屏蔽。`;
            }
            catch (error) {
                return `内存中已解除，但写入设置失败：${error instanceof Error ? error.message : String(error)}`;
            }
        },
    };
}

export function blockedCommand({ config }) {
    return {
        name: ['blocked', '屏蔽名单'],
        description: '查看群聊成员屏蔽名单（主人专用）',
        handler: async () => {
            const list = Array.isArray(config?.access?.groupBlockedUsers) ? config.access.groupBlockedUsers : [];
            return list.length ? `群聊屏蔽名单：\n${list.join('\n')}` : '群聊屏蔽名单为空。';
        },
    };
}
