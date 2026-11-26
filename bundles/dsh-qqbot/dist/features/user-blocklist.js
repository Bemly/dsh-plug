const OPENID_RE = /^[0-9A-Fa-f]{32}$/;

export function isGroupUserBlocked(config, message) {
    if (message?.kind !== 'group') return false;
    const sender = String(message.senderId ?? message.author?.member_openid ?? '').trim();
    if (!OPENID_RE.test(sender)) return false;
    const owners = Array.isArray(config?.groupAdmin?.owners) ? config.groupAdmin.owners : [];
    if (owners.includes(sender)) return false;
    const blocked = Array.isArray(config?.access?.groupBlockedUsers) ? config.access.groupBlockedUsers : [];
    return blocked.includes(sender);
}

export function updateGroupBlocklist(config, openid, blocked) {
    const id = String(openid ?? '').trim().toUpperCase();
    if (!OPENID_RE.test(id)) return { ok: false, reason: 'openid 必须是 32 位十六进制字符串' };
    const owners = Array.isArray(config?.groupAdmin?.owners) ? config.groupAdmin.owners : [];
    if (blocked && owners.includes(id)) return { ok: false, reason: '主人白名单用户不能被屏蔽' };
    const access = config.access ?? (config.access = {});
    const list = Array.isArray(access.groupBlockedUsers)
        ? access.groupBlockedUsers.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
        : [];
    access.groupBlockedUsers = blocked
        ? [...new Set([...list, id])]
        : list.filter((x) => x !== id);
    return { ok: true, list: access.groupBlockedUsers };
}
