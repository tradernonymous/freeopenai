// Marks a Windows .exe as a windowed (GUI) program instead of a console one.
//
// Node's single-executable build is a copy of node.exe, which is a console
// program: double-clicking it flashes a black console window before the app
// window opens. Windows decides that from one field in the PE header, the
// Subsystem (3 = console, 2 = GUI), so the build flips that field. Node supports
// running without a console: its stdout and stderr become silent sinks.
//
// Usage (in CI, after the app is injected): node set-gui-subsystem.js <exe>
const fs = require('fs');

const SUBSYSTEM_GUI = 2;

function setGuiSubsystem(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a PE file: no MZ header');
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 + 70 > buffer.length || buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Not a PE file: no PE signature');
  }
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Not a PE file: unknown optional header magic 0x' + magic.toString(16));
  // Subsystem sits at the same offset (68) in PE32 and PE32+ optional headers.
  const field = optionalHeader + 68;
  const before = buffer.readUInt16LE(field);
  buffer.writeUInt16LE(SUBSYSTEM_GUI, field);
  return before;
}

module.exports = { setGuiSubsystem };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node set-gui-subsystem.js <exe>');
    process.exit(2);
  }
  const buffer = fs.readFileSync(file);
  const before = setGuiSubsystem(buffer);
  fs.writeFileSync(file, buffer);
  console.log('subsystem ' + before + ' -> ' + SUBSYSTEM_GUI + ' in ' + file);
}
