export class SentGroupHistory {
  constructor(limit = 10) {
    this.limit = limit;
    this.byPeer = new Map();
  }

  push(target, id, groupId = null) {
    if (!id) return;
    const key = `${target.scope}:${target.targetId}`;
    let groups = this.byPeer.get(key);
    if (!groups) {
      groups = [];
      this.byPeer.set(key, groups);
    }
    let group = groupId ? groups.find((item) => item.id === groupId) : null;
    if (!group) {
      group = { id: groupId ?? `single-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, items: [] };
      groups.unshift(group);
    }
    group.items.push({ target, id });
    while (groups.length > this.limit) groups.pop();
  }

  async recall(target, index, recallMessage, logger) {
    if (!Number.isInteger(index) || index < 1) return false;
    const key = `${target.scope}:${target.targetId}`;
    const groups = this.byPeer.get(key);
    const group = groups?.[index - 1];
    if (!group || group.recalling) return false;
    group.recalling = true;
    let failed;
    try {
      failed = [];
      for (const item of group.items) {
        try {
          await recallMessage(item.target, item.id);
        } catch (error) {
          logger?.error?.(`recall group ${index} message failed: ${error instanceof Error ? error.message : String(error)}`);
          failed.push(item);
        }
      }
    } finally {
      group.recalling = false;
    }
    if (failed.length > 0) {
      group.items = failed;
      return false;
    }
    const groupIndex = groups.indexOf(group);
    if (groupIndex >= 0) groups.splice(groupIndex, 1);
    if (groups.length === 0) this.byPeer.delete(key);
    return true;
  }
}
