export function selectPendingWake(nextStep = [], nextTurn = []) {
    const pending = [...nextStep, ...nextTurn];
    return pending.length > 0 ? pending[pending.length - 1] : null;
}

export function wakePendingAfterGate(agent, { cancel = true } = {}) {
    if (!agent) return false;
    if (cancel && typeof agent.cancel !== 'function') return false;
    if (cancel) agent.cancel({ kind: 'user' }, { keepInbox: true });
    const wake = selectPendingWake(agent.inbox?.nextStep, agent.inbox?.nextTurn);
    if (!wake || typeof agent.inbox?.remove !== 'function' || typeof agent.followup !== 'function') {
        return false;
    }
    if (!agent.inbox.remove(wake.id)) return false;
    agent.followup(wake);
    return true;
}
