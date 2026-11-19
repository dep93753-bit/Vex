// Renders converted block stacks as HTML so you can check them before downloading.
// This is a simplified look, not VEXcode's exact drawing.

const CAT = {
  events: 'cat-events', drive: 'cat-drive', motion: 'cat-motion', looks: 'cat-looks', sounds: 'cat-sounds',
  control: 'cat-control', sensing: 'cat-sensing', operators: 'cat-operators', variables: 'cat-variables',
  myblocks: 'cat-myblocks', comment: 'cat-comment'
};

function category(type) {
  if (type.startsWith('iq_events_')) return CAT.events;
  if (type.startsWith('iq_drivetrain_') || type === 'iq_motion_stop_driving') return CAT.drive;
  if (type.startsWith('iq_motion_')) return CAT.motion;
  if (type.startsWith('iq_looks_') || type.startsWith('iq_screen_') || type === 'iq_console_print') return CAT.looks;
  if (type.startsWith('iq_sounds_')) return CAT.sounds;
  if (type.startsWith('iq_control_')) return CAT.control;
  if (type.startsWith('iq_sensing_')) return CAT.sensing;
  if (type.startsWith('iq_operator_')) return CAT.operators;
  if (type.startsWith('iq_variables_')) return CAT.variables;
  if (type.startsWith('procedures_') || type.startsWith('argument_reporter')) return CAT.myblocks;
  if (type === 'iq_other_comment') return CAT.comment;
  return CAT.control;
}

const T = {
  iq_events_when_started: 'when started',
  iq_events_when_controller_button: 'when Controller {BUTTON} {EVENTTYPE}',
  iq_events_when_controller_axis: 'when Controller {AXIS} is changed',
  iq_events_when_bumper: 'when {BUMPER} {EVENTTYPE}',
  iq_events_when_touchled: 'when {TOUCHLED} {EVENTTYPE}',
  iq_events_when_brain_button: 'when Brain {BUTTON} button {EVENTTYPE}',
  iq_events_when_broadcasted: 'when I receive {BROADCAST_OPTION}',
  iq_events_broadcast: 'broadcast {BROADCAST_OPTION}',
  iq_drivetrain_drive: 'drive {DIRECTION}',
  iq_drivetrain_drive_for: 'drive {DIRECTION} for [AMOUNT] {UNITS} {anddontwait_mutator}',
  iq_drivetrain_turn: 'turn {TURNDIRECTION}',
  iq_drivetrain_turn_for: 'turn {TURNDIRECTION} for [AMOUNT] degrees {anddontwait_mutator}',
  iq_drivetrain_turn_to_heading: 'turn to heading [HEADING] degrees {anddontwait_mutator}',
  iq_motion_stop_driving: 'stop driving',
  iq_drivetrain_set_drive_velocity: 'set drive velocity to [VELOCITY] %',
  iq_drivetrain_set_turn_velocity: 'set turn velocity to [VELOCITY] %',
  iq_drivetrain_set_drive_stopping: 'set drive stopping to {MODE}',
  iq_motion_spin: 'spin {MOTOR} {DIRECTION}',
  iq_motion_spin_for: 'spin {MOTOR} {DIRECTION} for [AMOUNT] {UNITS} {anddontwait_mutator}',
  iq_motion_spin_to_position: 'spin {MOTOR} to position [AMOUNT] {UNITS} {anddontwait_mutator}',
  iq_motion_stop_motor: 'stop {MOTOR}',
  iq_motion_set_motor_velocity: 'set {MOTOR} velocity to [VELOCITY] %',
  iq_motion_set_motor_stopping: 'set {MOTOR} stopping to {MODE}',
  iq_motion_set_motor_torque: 'set {MOTOR} max torque to [TORQUE] %',
  iq_motion_set_motor_position: 'set {MOTOR} position to [DEGS] degrees',
  iq_motion_set_motor_timeout: 'set {MOTOR} timeout to [TIMEOUT] seconds',
  iq_motion_pneumatics_cylinder: '{STATE} {PNEUMATIC} {CYLINDER}',
  iq_motion_pneumatics_compressor: 'turn {PNEUMATIC} pump {STATE}',
  iq_looks_print_new: 'print [DATA] on {TARGET} {andsetcursortonextrow_mutator}',
  iq_looks_next_row_new: 'set cursor to next row on {TARGET}',
  iq_looks_clear_all_rows_new: 'clear all rows on {TARGET}',
  iq_looks_clear_row_new: 'clear row [ROW] on {TARGET}',
  iq_looks_set_cursor_new: 'set cursor to row [ROW] column [COLUMN] on {TARGET}',
  iq_looks_set_font: 'set font to {FONT}',
  iq_looks_set_touchled_color: 'set {TOUCHLED} color to [COLOR]',
  iq_looks_set_touchled_brightness: 'set {TOUCHLED} brightness to [VALUE] %',
  iq_looks_colorlist: '{COLOR}',
  iq_sounds_play_sound: 'play sound {SOUND}',
  iq_control_wait: 'wait [DURATION] seconds',
  iq_control_wait_until: 'wait until [CONDITION]',
  iq_control_break: 'break',
  iq_control_stop_project: 'stop project',
  iq_sensing_controller_is_enabled: 'Controller {isEnabled}',
  iq_sensing_reset_timer: 'reset timer',
  iq_sensing_timer_value: 'timer in seconds',
  iq_sensing_pressing_controller: 'Controller {BUTTON} pressed?',
  iq_sensing_position_of_controller: 'Controller {AXIS} position',
  iq_sensing_pressing_bumper: '{BUMPER} pressed?',
  iq_sensing_pressing_touchled: '{TOUCHLED} pressed?',
  iq_sensing_distance_object_distance: '{DISTANCE} object distance in {UNITS}',
  iq_sensing_distance_found_object: '{DISTANCE} found an object?',
  iq_sensing_distance_from: '{SONAR} distance in {UNITS}',
  iq_sensing_position_of_motor: '{MOTOR} position in {UNITS}',
  iq_sensing_velocity_of_motor: '{MOTOR} velocity in {UNITS}',
  iq_sensing_motor_is_spinning: '{MOTOR} is spinning?',
  iq_sensing_drive_velocity: 'drive velocity in {UNITS}',
  iq_sensing_optical_detect: '{OPTICAL} detects {COLORS}?',
  iq_sensing_object_is_near: '{COLORSENSOR} is near object?',
  iq_sensing_optical_set_light: 'set {OPTICAL} light {OPTION}',
  iq_sensing_optical_set_light_power: 'set {OPTICAL} light power to [POWER] %',
  iq_sensing_rotation_of_gyro: '{GYRO} rotation in degrees',
  iq_sensing_set_gyro_rotation: 'set {GYRO} rotation to [VALUE] degrees',
  iq_sensing_calibrate_gyro: 'calibrate {GYRO} {setting}',
  iq_sensing_inertial_calibrate: 'calibrate BrainInertial',
  iq_variables_set_variable: 'set {VARIABLE} to [VALUE]',
  iq_variables_change_variable: 'change {VARIABLE} by [VALUE]',
  iq_variables_set_boolean_variable: 'set {VARIABLE} to [VALUE]',
  iq_variables_variable: '{VARIABLE}',
  iq_variables_boolean_variable: '{VARIABLE}',
  iq_operator_add: '[NUM1] + [NUM2]',
  iq_operator_subtract: '[NUM1] - [NUM2]',
  iq_operator_multiply: '[NUM1] * [NUM2]',
  iq_operator_divide: '[NUM1] / [NUM2]',
  iq_operator_remainder: 'remainder of [NUM1] / [NUM2]',
  iq_operator_comparison: '[NUM1] {COMPARISON} [NUM2]',
  iq_operator_and_or: '[OPERAND1] {CHECK} [OPERAND2]',
  iq_operator_not: 'not [OPERAND]',
  iq_operator_function: '{OPERATOR} of [NUM]',
  iq_operator_round: 'round [NUM]',
  iq_operator_random: 'pick random [FROM] to [TO]',
  iq_other_comment: '// [COMMENT]',
  argument_reporter_number: '{VALUE}',
  argument_reporter_boolean: '{VALUE}'
};

const BOOL_TYPES = new Set([
  'iq_sensing_pressing_controller', 'iq_sensing_pressing_bumper', 'iq_sensing_pressing_touchled',
  'iq_sensing_distance_found_object', 'iq_sensing_motor_is_spinning', 'iq_sensing_optical_detect',
  'iq_sensing_object_is_near', 'iq_operator_comparison', 'iq_operator_and_or', 'iq_operator_not',
  'iq_variables_boolean_variable', 'argument_reporter_boolean'
]);
const REPORTER_TYPES = new Set(Object.keys(T).filter(t =>
  /^(iq_sensing_(position|velocity|distance_object|distance_from|drive_velocity|timer_value|rotation)|iq_operator_|iq_variables_variable|argument_reporter_number)/.test(t)));

function show(name, value) {
  const v = String(value);
  switch (name) {
    case 'DIRECTION': return { fwd: 'forward', rev: 'reverse' }[v] || v;
    case 'UNITS': return { deg: 'degrees', rev: 'turns', pct: '%', in: 'inches', mm: 'mm', rpm: 'rpm' }[v] || v;
    case 'anddontwait_mutator': return v === 'true' ? '▸ and don\'t wait' : '';
    case 'andsetcursortonextrow_mutator': return v === 'true' ? '→ next row' : '';
    case 'EVENTTYPE': return v;
    case 'BUTTON': return v.replace(/^Button/, '');
    case 'isEnabled': return v === 'true' ? 'enable' : 'disable';
    case 'setting': return v === 'accurate' ? 'for 4 seconds' : 'for 2 seconds';
    case 'COLORS': case 'COLOR': return v.replace(/_/g, ' ');
    default: return v;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderInput(v) {
  if (!v) return '<span class="slot"></span>';
  if (v.block) return renderReporter(v.block);
  const sh = v.shadow;
  if (!sh) return '<span class="slot bool"></span>';
  if (sh.type === 'iq_looks_colorlist') return `<span class="pill color c-${esc(sh.fields[0].value)}">${esc(show('COLOR', sh.fields[0].value))}</span>`;
  if (sh.type === 'comment_text') return `<span class="pill text">${esc(sh.fields[0].value)}</span>`;
  if (sh.type === 'bool_input' || sh.type === 'procedure_bool_input') return `<span class="pill">${esc(sh.fields[0].value)}</span>`;
  const f = sh.fields[0];
  return `<span class="pill${sh.type === 'text' ? ' text' : ''}">${esc(f ? f.value : '')}</span>`;
}

function fill(template, b) {
  const fields = Object.fromEntries(b.fields.map(f => [f.name, f.value]));
  const values = Object.fromEntries(b.values.map(v => [v.name, v]));
  return template.split(/(\{[^}]+\}|\[[^\]]+\])/).map(part => {
    if (/^\{.+\}$/.test(part)) {
      const n = part.slice(1, -1);
      const shown = show(n, fields[n] ?? '');
      if (!shown) return '';
      if (['anddontwait_mutator', 'andsetcursortonextrow_mutator'].includes(n)) return `<span class="hint">${esc(shown)}</span>`;
      return `<span class="dd">${esc(shown)}</span>`;
    }
    if (/^\[.+\]$/.test(part)) return renderInput(values[part.slice(1, -1)]);
    return esc(part);
  }).join('');
}

function procLabel(mutation, values, isDef) {
  const code = mutation.proccode || '';
  const ids = JSON.parse(mutation.argumentids || '[]');
  let i = 0;
  return code.split(/(%[nb])/).map(p => {
    if (p === '%n' || p === '%b') {
      const v = values.find(x => x.name === ids[i++]);
      if (isDef) return renderReporter(v && v.shadow);
      return renderInput(v);
    }
    return esc(p);
  }).join('');
}

function renderReporter(b) {
  if (!b) return '<span class="slot"></span>';
  const cat = category(b.type);
  const shape = BOOL_TYPES.has(b.type) ? 'bool' : 'round';
  const t = T[b.type];
  const label = t ? fill(t, b) : esc(b.type);
  return `<span class="rep ${shape} ${cat}">${label}</span>`;
}

function renderStack(blocks) {
  return blocks.map(renderBlock).join('');
}

function cBlock(cat, parts) {
  // parts: [{label, body}] ; the last part may have no label
  let s = `<div class="blk c ${cat}">`;
  parts.forEach((p, i) => {
    s += `<div class="row${i ? ' arm' : ''}">${p.label}</div>`;
    s += `<div class="mouth">${p.body && p.body.length ? renderStack(p.body) : '<div class="empty"></div>'}</div>`;
  });
  return s + '<div class="row foot"></div></div>';
}

function renderBlock(b) {
  const cat = category(b.type);
  const st = (n) => (b.statements.find(s => s.name === n) || { blocks: [] }).blocks;
  const v = (n) => renderInput(b.values.find(x => x.name === n));
  switch (b.type) {
    case 'iq_control_forever': return cBlock(cat, [{ label: 'forever', body: st('SUBSTACK') }]);
    case 'iq_control_repeat': return cBlock(cat, [{ label: `repeat ${v('TIMES')}`, body: st('SUBSTACK') }]);
    case 'iq_control_repeat_until': return cBlock(cat, [{ label: `repeat until ${v('CONDITION')}`, body: st('SUBSTACK') }]);
    case 'iq_control_while': return cBlock(cat, [{ label: `while ${v('CONDITION')}`, body: st('SUBSTACK') }]);
    case 'iq_control_if_then': return cBlock(cat, [{ label: `if ${v('CONDITION')} then`, body: st('SUBSTACK') }]);
    case 'iq_control_if_then_else': return cBlock(cat, [{ label: `if ${v('CONDITION')} then`, body: st('SUBSTACK') }, { label: 'else', body: st('SUBSTACK2') }]);
    case 'iq_control_if_elseif_else': {
      const n = +(b.mutation && b.mutation.branches) || 1;
      const parts = [];
      for (let i = 1; i <= n; i++) parts.push({ label: `${i === 1 ? 'if' : 'else if'} ${v('CONDITION' + i)} then`, body: st('SUBSTACK' + i) });
      parts.push({ label: 'else', body: st('SUBSTACK_ELSE') });
      return cBlock(cat, parts);
    }
    case 'procedures_definition': {
      const proto = st('custom_block')[0];
      return `<div class="blk hat ${cat}"><div class="row">define ${procLabel(proto.mutation, proto.values, true)}</div></div>`;
    }
    case 'procedures_call':
      return `<div class="blk ${cat}"><div class="row">${procLabel(b.mutation, b.values, false)}</div></div>`;
  }
  const t = T[b.type];
  const hat = b.type.startsWith('iq_events_when');
  return `<div class="blk${hat ? ' hat' : ''} ${cat}"><div class="row">${t ? fill(t, b) : esc(b.type)}</div></div>`;
}

export function renderPreview(stacks) {
  return stacks.map(s => `<div class="stack">${renderStack(s)}</div>`).join('');
}
