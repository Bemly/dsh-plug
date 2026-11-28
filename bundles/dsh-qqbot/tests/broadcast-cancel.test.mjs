import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advanceTask, cancelTask, confirmTask, createTask, getTask } from '../dist/features/broadcast.js';

test('发送中取消不会被在途推进的旧快照覆盖，也不会继续发下一个目标', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bc-cancel-'));
    const sent = [];
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const client = {
        async sendGroupText(peerId) {
            sent.push(peerId);
            entered();
            await gate;
            return { ok: true, data: { id: 'm-' + peerId } };
        },
        async sendC2cText(peerId) {
            sent.push(peerId);
            return { ok: true, data: { id: 'm-' + peerId } };
        },
    };
    try {
        const task = createTask(dir, {
            type: 'text',
            content: 'hi',
            targets: [{ scope: 'group', peerId: 'g1' }, { scope: 'group', peerId: 'g2' }],
        });
        confirmTask(dir, task.task_id);
        const advancing = advanceTask(dir, task.task_id, client, {});
        await started;
        cancelTask(dir, task.task_id, 'dock');
        release();
        const after = await advancing;
        // 已发的那条要留结果（撤回还要用 message_id），但状态必须是 cancelled
        assert.equal(after.state, 'cancelled');
        assert.equal(after.results.g1?.message_id, 'm-g1');
        assert.equal(getTask(dir, task.task_id).state, 'cancelled');
        // 再推进一次：取消是终态，不能再发 g2
        await advanceTask(dir, task.task_id, client, {});
        assert.deepEqual(sent, ['g1']);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
