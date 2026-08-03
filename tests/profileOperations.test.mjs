import test from 'node:test';
import assert from 'node:assert/strict';

test('profile subscriber matching logic accurately handles legacy and new metadata fields', () => {
  const matchSubscribersByProfile = (subscribers, profileName) => {
    return subscribers.filter((sub) => {
      const p = sub.webui_meta?.profile_name || sub.webui_meta?.profile || sub.profile_name || sub.profile;
      return p === profileName;
    });
  };

  const subscribers = [
    { imsi: '460020000000001', webui_meta: { profile_name: 'default' }, subscriber_status: 0 },
    { imsi: '460020000000002', webui_meta: { profile: 'default' }, subscriber_status: 1 },
    { imsi: '460020000000003', profile_name: 'vip', subscriber_status: 0 },
    { imsi: '460020000000004', profile: 'iot', subscriber_status: 0 },
    { imsi: '460020000000005', webui_meta: { profile_name: 'vip' }, subscriber_status: 0 },
  ];

  const defaultSubs = matchSubscribersByProfile(subscribers, 'default');
  assert.equal(defaultSubs.length, 2);
  assert.deepEqual(defaultSubs.map(s => s.imsi), ['460020000000001', '460020000000002']);

  const vipSubs = matchSubscribersByProfile(subscribers, 'vip');
  assert.equal(vipSubs.length, 2);
  assert.deepEqual(vipSubs.map(s => s.imsi), ['460020000000003', '460020000000005']);

  const iotSubs = matchSubscribersByProfile(subscribers, 'iot');
  assert.equal(iotSubs.length, 1);
  assert.equal(iotSubs[0].imsi, '460020000000004');

  const nonExistent = matchSubscribersByProfile(subscribers, 'ghost');
  assert.equal(nonExistent.length, 0);
});

test('profile delete protection correctly flags in-use profiles', () => {
  const evaluateDeleteEligibility = (profileName, count, force) => {
    if (count > 0 && !force) {
      return {
        allowed: false,
        error: 'PROFILE_IN_USE',
        message: `Profile "${profileName}" is currently used by ${count} subscriber(s). Provide force=true to proceed.`,
        subscriberCount: count,
      };
    }
    return { allowed: true };
  };

  const blocked = evaluateDeleteEligibility('default', 42, false);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.error, 'PROFILE_IN_USE');
  assert.equal(blocked.subscriberCount, 42);

  const allowedWithForce = evaluateDeleteEligibility('default', 42, true);
  assert.equal(allowedWithForce.allowed, true);

  const allowedUnused = evaluateDeleteEligibility('unused_profile', 0, false);
  assert.equal(allowedUnused.allowed, true);
});
