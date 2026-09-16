// /doctor reports what the next message needs: providers that can answer,
// skills installed and pinned, and the current mode. The composer calls it
// bare; the tests drive it through an env so no browser is involved.
const test = require('node:test');
const assert = require('node:assert/strict');

const { assertScannerCanRead, assertSandboxCovers, loadFromIndex } = require('./helpers/index-html.js');
const { resolveChatCommand } = require('../chatlib.js');

test('/doctor parses as a command, not a skill or a message', () => {
  assert.deepEqual(resolveChatCommand('/doctor', []), { kind: 'command', name: 'doctor', args: '' });
});

function doctorDeps(overrides) {
  return Object.assign(
    {
      fetch: async () => ({ json: async () => ([]) }),
      skills: [],
      pinned: [],
      mode: 'chat',
    },
    overrides,
  );
}

test('a healthy deployment reports counts, names and mode', async () => {
  const env = doctorDeps({
    fetch: async () => ({
      json: async () => ([
        { id: 'nara', configured: true },
        { id: 'custom', configured: false },
      ]),
    }),
    skills: [{}, {}, {}],
    pinned: ['a', 'b'],
    mode: 'build',
  });
  assertScannerCanRead(['runDoctorCommand']);
  assertSandboxCovers(['runDoctorCommand'], env);
  const { runDoctorCommand } = loadFromIndex(['runDoctorCommand'], env);
  const report = await runDoctorCommand(env);
  assert.match(report, /^Doctor\n/);
  assert.match(report, /Providers: 1\/2 configured \(nara\)\./);
  assert.match(report, /Skills: 3 installed, 2 pinned to this chat\./);
  assert.match(report, /Mode: BUILD\./);
});

test('an unreachable provider list is reported, not thrown', async () => {
  const env = doctorDeps({
    fetch: async () => {
      throw new Error('socket hang up');
    },
  });
  assertSandboxCovers(['runDoctorCommand'], env);
  const { runDoctorCommand } = loadFromIndex(['runDoctorCommand'], env);
  const report = await runDoctorCommand(env);
  assert.match(report, /Providers: unreachable \(socket hang up\)\./);
  assert.match(report, /Skills: 0 installed, 0 pinned to this chat\./);
  assert.match(report, /Mode: CHAT\./);
});
