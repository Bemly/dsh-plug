import assert from 'node:assert/strict';
import test from 'node:test';
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
