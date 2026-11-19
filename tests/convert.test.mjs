// Run with:  node tests/convert.test.mjs
import assert from 'node:assert/strict';
import { convertCode, makeProjectFile, readProjectFile } from '../js/convert.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name); console.log(e); process.exitCode = 1; }
}
const types = (r) => {
  const out = [];
  const walk = (arr) => arr.forEach(b => { out.push(b.type); b.values.forEach(v => v.block && walk([v.block])); b.statements.forEach(s => walk(s.blocks)); });
  r.stacks.forEach(walk);
  return out;
};

test('python drivetrain + motors', () => {
  const r = convertCode(`from vex import *
brain = Brain()
brain_inertial = Inertial()
left_drive_smart = Motor(Ports.PORT1, 1.0, False)
right_drive_smart = Motor(Ports.PORT6, 1.0, True)
drivetrain = SmartDrive(left_drive_smart, right_drive_smart, brain_inertial, 200)
arm = Motor(Ports.PORT4, False)
drivetrain.drive_for(FORWARD, 200, MM)
drivetrain.turn_for(LEFT, 90, DEGREES, wait=False)
arm.spin_for(REVERSE, 2, TURNS)
wait(500, MSEC)
`);
  assert.equal(r.issues.length, 0);
  assert.deepEqual(types(r), ['iq_events_when_started', 'iq_drivetrain_drive_for', 'iq_drivetrain_turn_for', 'iq_motion_spin_for', 'iq_control_wait']);
  const dt = r.robotConfig.find(d => d.deviceType === 'Drivetrain');
  assert.deepEqual(dt.port, [1, 6, 0]);
  assert.equal(dt.setting.gyroType, 'integrated');
  const wait = r.stacks[0][4];
  assert.equal(wait.values[0].shadow.fields[0].value, '0.5');
});

test('python control flow, variables, events, my blocks', () => {
  const r = convertCode(`from vex import *
controller = Controller()
m = Motor(Ports.PORT2)
count = 0
ready = False
def go(n):
    m.spin_for(FORWARD, n, DEGREES)
def on_up():
    global count
    count += 1
while True:
    if controller.buttonLUp.pressing():
        go(90)
    elif count > 3:
        ready = True
    else:
        m.stop()
controller.buttonEUp.pressed(on_up)
`);
  assert.equal(r.issues.length, 0);
  const t = types(r);
  for (const x of ['iq_control_forever', 'iq_control_if_elseif_else', 'procedures_call', 'procedures_definition', 'iq_events_when_controller_button', 'iq_variables_change_variable', 'iq_variables_set_boolean_variable', 'argument_reporter_number']) assert.ok(t.includes(x), x);
});

test('c++ program with repeat, waitUntil, printf, globals, #define', () => {
  const r = convertCode(`#include "vex.h"
using namespace vex;
brain Brain;
motor LeftMotor = motor(PORT1, false);
motor RightMotor = motor(PORT6, true);
drivetrain Drivetrain = drivetrain(LeftMotor, RightMotor, 200, 173, 76, mm, 1);
bumper Bump = bumper(PORT8);
#define SPEED 40
int laps = 0;
int main() {
  Drivetrain.setDriveVelocity(SPEED, percent);
  repeat(4) {
    Drivetrain.driveFor(forward, 100, mm);
    laps++;
  }
  waitUntil(Bump.pressing());
  Brain.Screen.print("laps: %d", laps);
  Brain.Screen.newLine();
  printf("done\\n");
  return 0;
}`);
  assert.equal(r.issues.length, 0);
  const t = types(r);
  for (const x of ['iq_control_repeat', 'iq_control_wait_until', 'iq_sensing_pressing_bumper', 'iq_looks_print_new', 'iq_variables_change_variable']) assert.ok(t.includes(x), x);
  assert.ok(!t.includes('iq_looks_next_row_new'), 'print + newLine should merge');
});

test('unsupported code is reported, not converted', () => {
  const r = convertCode(`from vex import *
m = Motor(Ports.PORT1)
items = [1, 2, 3]
class Thing:
    pass
m.spin(FORWARD)
`);
  assert.deepEqual(r.issues.map(i => i.line), [3, 4]);
  assert.deepEqual(types(r), ['iq_events_when_started', 'iq_motion_spin']);
});

test('project file is valid JSON with well-formed workspace', () => {
  const r = convertCode('from vex import *\nm = Motor(Ports.PORT1)\nm.spin(FORWARD)\nbrain.screen.print("a < b & c")\n');
  const p = makeProjectFile(r);
  assert.equal(p.mode, 'Blocks');
  assert.equal(p.platform, 'IQ');
  assert.ok(p.workspace.startsWith('<xml'));
  assert.ok(p.workspace.includes('a &lt; b &amp; c'));
  assert.ok(Array.isArray(p.robotConfig));
});

test('reads VEXcode text project files', () => {
  const file = JSON.stringify({ mode: 'Text', textContent: 'm.spin(FORWARD)', textLanguage: 'python', targetBrainGen: 'First', robotConfig: [{ port: [3], name: 'm', customName: true, deviceType: 'Motor', deviceClass: 'motor', setting: { reversed: 'false', fwd: 'forward', rev: 'reverse' } }] });
  const info = readProjectFile(file, 'test.iqpython');
  assert.equal(info.lang, 'py');
  assert.equal(info.gen, 'First');
  const r = convertCode(info.code, info);
  assert.equal(r.issues.length, 0);
  assert.equal(makeProjectFile(r).targetBrainGen, 'First');
});

console.log(`\n${passed} passed`);
