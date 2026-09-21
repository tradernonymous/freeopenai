const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const handoff = require('../desktop/src/remote-handoff.js');

describe('remote-handoff', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof handoff.startHandoff, 'function');
    assert.equal(typeof handoff.watchSession, 'function');
    assert.equal(typeof handoff.stopHandoff, 'function');
    assert.equal(typeof handoff.active, 'function');
    assert.equal(typeof handoff.isActive, 'function');
    assert.equal(typeof handoff.statusText, 'function');
    assert.equal(typeof handoff.HANDOFF_TIMEOUT_MS, 'number');
  });

  it('HANDOFF_TIMEOUT_MS is 5 minutes', () => {
    assert.equal(handoff.HANDOFF_TIMEOUT_MS, 300_000);
  });

  it('active returns null when nothing is running', () => {
    assert.equal(handoff.active(), null);
  });

  it('isActive returns false when nothing is running', () => {
    assert.equal(handoff.isActive(), false);
  });

  it('statusText returns empty string when nothing is running', () => {
    assert.equal(handoff.statusText(), '');
  });

  it('stopHandoff is safe to call when nothing is running', () => {
    handoff.stopHandoff(); // should not throw
  });

  it('startHandoff throws when no api is provided', async () => {
    try {
      await handoff.startHandoff('/tmp', 'do something', {});
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('api'));
    }
  });

  it('startHandoff calls the callbacks in order', async () => {
    const order = [];
    const mockApi = { buildRun: async () => ({ id: 'build-1', status: 'running' }), buildEvents: () => '' };
    await handoff.startHandoff('/tmp', 'fix the bug', {
      api: mockApi,
      packageWorkspace: async (root) => {
        order.push('package');
        return { path: '/tmp/workspace.tar', name: 'workspace.tar' };
      },
      uploadToEngine: async (path, name) => {
        order.push('upload');
        return { url: 'https://engine/uploaded' };
      },
      createBuildSession: async (plan, upload) => {
        order.push('create');
        return { id: 'build-1', status: 'running' };
      },
      onEvent: (e) => {
        order.push('event:' + e.type);
      },
    });
    assert.deepEqual(order, [
      'event:status', 'package',
      'event:status', 'upload',
      'event:status', 'create',
      'event:status',
    ]);
    assert.equal(handoff.isActive(), true);
    assert.ok(handoff.statusText().length > 0);

    // Clean up.
    handoff.stopHandoff();
    assert.equal(handoff.isActive(), false);
  });

  it('startHandoff propagates packaging errors', async () => {
    try {
      await handoff.startHandoff('/tmp', 'plan', {
        api: {},
        packageWorkspace: async () => { throw new Error('disk full'); },
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('package'));
      assert.ok(err.message.includes('disk full'));
    }
  });

  it('startHandoff propagates upload errors', async () => {
    try {
      await handoff.startHandoff('/tmp', 'plan', {
        api: {},
        packageWorkspace: async () => ({ path: '/tmp/tar', name: 'tar' }),
        uploadToEngine: async () => { throw new Error('network error'); },
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('upload'));
    }
  });
});
