import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { blockCommand, blockedCommand, unblockCommand } from '../dist/commands/block.js';
import { isGroupUserBlocked, updateGroupBlocklist } from '../dist/features/user-blocklist.js';

const OWNER = '11111111111111111111111111111111';
const USER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('blocks only the listed group member and protects owners', () => {
    const config = {
        groupAdmin: { owners: [OWNER] },
        access: { groupBlockedUsers: [USER] },
    };
    assert.equal(isGroupUserBlocked(config, { kind: 'group', senderId: USER }), true);
    assert.equal(isGroupUserBlocked(config, { kind: 'group', author: { member_openid: USER } }), true);
    assert.equal(isGroupUserBlocked(config, { kind: 'c2c', senderId: USER }), false);
    assert.equal(isGroupUserBlocked(config, { kind: 'group', senderId: OWNER }), false);
    assert.equal(isGroupUserBlocked(config, { kind: 'group', senderId: '22222222222222222222222222222222' }), false);
});

test('validates openid and refuses to block an owner', () => {
    const config = { groupAdmin: { owners: [OWNER] }, access: {} };
    assert.equal(updateGroupBlocklist(config, 'bad', true).ok, false);
    assert.equal(updateGroupBlocklist(config, OWNER, true).ok, false);
    assert.equal(updateGroupBlocklist(config, USER.toLowerCase(), true).ok, true);
    assert.deepEqual(config.access.groupBlockedUsers, [USER]);
});

test('block commands persist to the profile settings file and can be undone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-block-test-'));
    const oldHome = process.env.DSH_HOME;
    const oldProfile = globalThis.__dshProfileName;
    try {
        process.env.DSH_HOME = root;
        globalThis.__dshProfileName = 'web';
        const config = { settingsNs: 'im-qqbot', groupAdmin: { owners: [OWNER] }, access: {} };
        const logger = { info() {} };
        const block = blockCommand({ config, logger });
        const unblock = unblockCommand({ config, logger });
        const blocked = blockedCommand({ config });

        assert.match(await block.handler({ command: { raw: USER } }), /已屏蔽/);
        assert.deepEqual(config.access.groupBlockedUsers, [USER]);
        const file = join(root, 'qqbot-settings', 'web', 'im-qqbot.json');
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).access.groupBlockedUsers, [USER]);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.match(await blocked.handler(), new RegExp(USER));
        assert.match(await unblock.handler({ command: { raw: USER } }), /已解除/);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).access.groupBlockedUsers, []);
    }
    finally {
        if (oldHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = oldHome;
        if (oldProfile === undefined) delete globalThis.__dshProfileName;
        else globalThis.__dshProfileName = oldProfile;
        rmSync(root, { recursive: true, force: true });
    }
});
