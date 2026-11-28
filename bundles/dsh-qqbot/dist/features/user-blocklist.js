const OPENID_RE = /^[0-9A-Fa-f]{32}$/;

/** openid 是十六进制串，大小写不敏感；入库统一大写，比对一律走这里。 */
function normId(value) {
    return String(value ?? '').trim().toUpperCase();
}

export function isGroupUserBlocked(config, message) {
    if (message?.kind !== 'group') return false;
    const sender = normId(message.senderId ?? message.author?.member_openid);
    if (!OPENID_RE.test(sender)) return false;
    const owners = (Array.isArray(config?.groupAdmin?.owners) ? config.groupAdmin.owners : []).map(normId);
    if (owners.includes(sender)) return false;
    const blocked = (Array.isArray(config?.access?.groupBlockedUsers) ? config.access.groupBlockedUsers : []).map(normId);
    return blocked.includes(sender);
}

export function updateGroupBlocklist(config, openid, blocked) {
    const id = normId(openid);
    if (!OPENID_RE.test(id)) return { ok: false, reason: 'openid 必须是 32 位十六进制字符串' };
    const owners = (Array.isArray(config?.groupAdmin?.owners) ? config.groupAdmin.owners : []).map(normId);
    if (blocked && owners.includes(id)) return { ok: false, reason: '主人白名单用户不能被屏蔽' };
    const access = config.access ?? (config.access = {});
    const list = Array.isArray(access.groupBlockedUsers)
        ? access.groupBlockedUsers.map(normId).filter(Boolean)
        : [];
    access.groupBlockedUsers = blocked
        ? [...new Set([...list, id])]
        : list.filter((x) => x !== id);
    return { ok: true, list: access.groupBlockedUsers };
}
