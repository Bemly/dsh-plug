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

test('openid 大小写不敏感：小写入站也能命中大写台账', () => {
    const config = {
        groupAdmin: { owners: ['1111AAAA1111AAAA1111AAAA1111AAAA'] },
        access: { groupBlockedUsers: ['BBBB2222BBBB2222BBBB2222BBBB2222'] },
    };
    // 入站 openid 常是小写，台账/白名单可能是大写（或反之）
    assert.equal(isGroupUserBlocked(config, { kind: 'group', senderId: 'bbbb2222bbbb2222bbbb2222bbbb2222' }), true);
    assert.equal(isGroupUserBlocked(config, { kind: 'group', senderId: '1111aaaa1111aaaa1111aaaa1111aaaa' }), false);
    // 小写 openid 也不能把主人拉黑，且写入后仍然只有一条
    const cfg2 = { groupAdmin: { owners: ['1111aaaa1111aaaa1111aaaa1111aaaa'] }, access: {} };
    assert.equal(updateGroupBlocklist(cfg2, '1111AAAA1111AAAA1111AAAA1111AAAA', true).ok, false);
    assert.equal(updateGroupBlocklist(cfg2, 'bbbb2222bbbb2222bbbb2222bbbb2222', true).ok, true);
    assert.equal(updateGroupBlocklist(cfg2, 'BBBB2222BBBB2222BBBB2222BBBB2222', true).ok, true);
    assert.deepEqual(cfg2.access.groupBlockedUsers, ['BBBB2222BBBB2222BBBB2222BBBB2222']);
});
