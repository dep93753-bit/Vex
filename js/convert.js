// Converts a parsed VEXcode IQ Python/C++ program into VEXcode IQ blocks.
//
// AST (shared by both parsers)
//   statements: expr{e} assign{target,op,value} incdec{target,op} decl{type,name,value|ctorArgs}
//               if{branches[{cond,body}],orelse} while{cond,body} for{target,iter,body}
//               func{name,params[{name,type,def}],body} return{value} break continue pass
//               global import proto comment{text} unknown{text,reason}
//   expressions: num str bool none name{id} attr{obj,name} call{fn,args,kwargs} index
//               bin{op,l,r} cmp{op,l,r} logic{op,l,r} not{e} neg{e} paren{e} tuple list ternary

import { parsePython } from './parse-python.js';
import { parseCpp } from './parse-cpp.js';
import { blk, field, val, stmt, shadowNum, shadowText, buildProject, countBlocks, genId } from './blocks.js';

class Unsupported extends Error {}
const fail = (msg) => { throw new Unsupported(msg); };

// ---------------------------------------------------------------- helpers
const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const unparen = (e) => { while (e && e.k === 'paren') e = e.e; return e; };

// flatten a.b.c into ['a','b','c']; returns null if root isn't a plain name
function chainOf(e) {
  e = unparen(e);
  const out = [];
  while (e && e.k === 'attr') { out.unshift(e.name); e = unparen(e.obj); }
  if (!e || e.k !== 'name') return null;
  out.unshift(e.id);
  return out;
}

// enum-ish value: FORWARD, vex::forward, DirectionType.FORWARD, Color.RED -> 'forward' / 'red'
function enumOf(e) {
  e = unparen(e);
  if (!e) return null;
  if (e.k === 'name') return e.id.toLowerCase();
  if (e.k === 'attr') return e.name.toLowerCase();
  if (e.k === 'str') return e.v.toLowerCase();
  return null;
}

const DIRS = { forward: 'fwd', fwd: 'fwd', reverse: 'rev', rev: 'rev' };
const TURNS = { left: 'left', right: 'right' };
const DIST_UNITS = { mm: 'mm', millimeters: 'mm', inches: 'in', in: 'in', inch: 'in' };
const ROT_UNITS = { degrees: 'deg', deg: 'deg', turns: 'rev', rev: 'rev', revolutions: 'rev' };
const VEL_UNITS = { percent: 'pct', pct: 'pct', rpm: 'rpm', velocityunits: 'pct' };
const STOP_MODES = { brake: 'brake', coast: 'coast', hold: 'hold' };
const COLORS = ['red', 'green', 'blue', 'white', 'yellow', 'orange', 'purple', 'red_violet', 'violet', 'blue_violet', 'blue_green', 'yellow_green', 'yellow_orange', 'red_orange', 'none'];

function pick(map, e, what) {
  const v = enumOf(e);
  if (v && map[v] !== undefined) return map[v];
  fail(`Unknown ${what}: ${describe(e)}`);
}

function describe(e) {
  e = unparen(e);
  if (!e) return '?';
  switch (e.k) {
    case 'num': return String(e.v);
    case 'str': return JSON.stringify(e.v);
    case 'name': return e.id;
    case 'attr': return describe(e.obj) + '.' + e.name;
    case 'call': return describe(e.fn) + '(...)';
    default: return e.k;
  }
}

function isTruthyLiteral(e) { e = unparen(e); return e && ((e.k === 'bool' && e.v) || (e.k === 'num' && e.v !== 0)); }

// ---------------------------------------------------------------- devices
const PY_CTORS = {
  Motor: 'motor', MotorGroup: 'motorgroup', SmartDrive: 'drivetrain', DriveTrain: 'drivetrain', Drivetrain: 'drivetrain',
  Controller: 'controller', Bumper: 'bumper', Touchled: 'touchled', TouchLED: 'touchled', Distance: 'distance',
  Optical: 'optical', ColorSensor: 'color', Gyro: 'gyro', Pneumatic: 'pneumatic', Inertial: 'inertial', Sonar: 'sonar',
  AiVision: 'aivision', Brain: 'brain'
};
const CPP_CTORS = {
  motor: 'motor', motor_group: 'motorgroup', smartdrive: 'drivetrain', drivetrain: 'drivetrain', controller: 'controller',
  bumper: 'bumper', touchled: 'touchled', distance: 'distance', optical: 'optical', colorsensor: 'color', gyro: 'gyro',
  pneumatic: 'pneumatic', inertial: 'inertial', sonar: 'sonar', aivision: 'aivision', brain: 'brain'
};
const KIND_TYPE = {
  motor: ['Motor', 'motor'], motorgroup: ['MotorGroup', 'motor_group'], drivetrain: ['Drivetrain', 'smartdrive'],
  controller: ['Controller', 'controller'], bumper: ['Bumper', 'bumper'], touchled: ['TouchLED', 'touchled'],
  distance: ['Distance', 'distance'], sonar: ['Distance', 'sonar'], optical: ['Optical', 'optical'],
  color: ['Color', 'colorsensor'], gyro: ['Gyro', 'gyro'], pneumatic: ['Pneumatic', 'pneumatic'], aivision: ['AIVision', 'aivision']
};
const TYPE_KIND = {
  Drivetrain: 'drivetrain', Motor: 'motor', MotorGroup: 'motorgroup', Controller: 'controller', Bumper: 'bumper',
  TouchLED: 'touchled', Optical: 'optical', Color: 'color', Gyro: 'gyro', Pneumatic: 'pneumatic', AIVision: 'aivision'
};

function portOf(e) {
  e = unparen(e);
  const id = e && (e.k === 'attr' ? e.name : e.k === 'name' ? e.id : null);
  const m = id && /^PORT(\d+)$/i.exec(id);
  if (m) return +m[1];
  if (e && e.k === 'num') return e.v;
  return null;
}

function ratioString(x) {
  if (x == null || x === 1) return '1:1';
  for (let b = 1; b <= 12; b++) for (let a = 1; a <= 60; a++) if (Math.abs(a / b - x) < 1e-6) return `${a}:${b}`;
  return '1:1';
}

class Devices {
  constructor(gen) {
    this.gen = gen;
    this.map = new Map(); // lowercase code name -> device
    this.order = [];
    this.motorVars = new Map(); // code motor vars (may get absorbed into groups/drivetrain)
    this.absorbed = new Set();
    this.dtParts = new Set();
    this.usedPorts = new Set();
    this.notes = [];
  }
  add(codeName, dev) {
    dev.codeName = codeName;
    this.map.set(codeName.toLowerCase(), dev);
    this.order.push(dev);
    for (const p of dev.ports || []) if (p) this.usedPorts.add(p);
    return dev;
  }
  get(name) {
    if (!name) return null;
    const low = name.toLowerCase();
    if (this.dtParts.has(low)) return { kind: 'dtpart', name };
    return this.map.get(low) || null;
  }
  freePort() {
    for (let p = 1; p <= 12; p++) if (!this.usedPorts.has(p)) { this.usedPorts.add(p); return p; }
    return 0;
  }
  // load VEXcode robotConfig array (from an uploaded project file)
  loadConfig(cfg) {
    for (const d of cfg || []) {
      let kind = TYPE_KIND[d.deviceType];
      if (d.deviceType === 'Distance') kind = d.deviceClass === 'sonar' ? 'sonar' : 'distance';
      if (!kind) continue;
      const copy = JSON.parse(JSON.stringify(d));
      if (kind === 'drivetrain') { copy.name = 'Drivetrain'; copy.customName = false; }
      if (kind === 'controller') { copy.name = 'Controller'; copy.customName = false; }
      this.add(d.name, { kind, name: copy.name, ports: d.port || [], config: copy });
      if (kind === 'drivetrain') {
        ['left_drive_smart', 'right_drive_smart', 'leftdrivesmart', 'rightdrivesmart', 'drivetrain_gyro', 'drivetraingyro', 'drivetraininertial'].forEach(n => this.dtParts.add(n));
      }
    }
  }
  // recognise a device constructor; returns true if the statement was device setup
  tryCtor(lang, name, ctorName, args, declType) {
    const kind = lang === 'py' ? PY_CTORS[ctorName] : CPP_CTORS[ctorName.replace(/^vex::/, '')];
    if (!kind) return false;
    const low = name.toLowerCase();
    if (kind === 'brain') return true;
    if (kind === 'inertial') {
      this.add(name, { kind: 'inertial', name: 'BrainInertial', ports: [] });
      return true;
    }
    if (kind === 'motor') {
      const port = portOf(args[0]);
      let reversed = false, ratio = null;
      for (const a of args.slice(1)) {
        const u = unparen(a);
        if (u.k === 'bool') reversed = u.v;
        else if (u.k === 'num') ratio = u.v;
        else if (enumOf(u) && /ratio_?(\d+)_(\d+)/.test(enumOf(u))) { const m = /ratio_?(\d+)_(\d+)/.exec(enumOf(u)); ratio = (+m[1]) / (+m[2]); }
      }
      this.motorVars.set(low, { name, port, reversed, ratio });
      if (port) this.usedPorts.add(port);
      // standalone motor until absorbed into a group/drivetrain
      this.add(name, {
        kind: 'motor', name, ports: [port],
        config: { port: [port], name, customName: true, deviceType: 'Motor', deviceClass: 'motor', setting: { reversed: String(reversed), fwd: 'forward', rev: 'reverse' }, triportSourcePort: 22 }
      });
      return true;
    }
    if (kind === 'motorgroup') {
      const mv = args.map(a => this.motorVars.get((chainOf(a) || [''])[0].toLowerCase()));
      if (mv.length < 1 || mv.some(m => !m)) return false;
      mv.forEach(m => this.absorb(m.name));
      const setting = { fwd: 'forward', rev: 'reverse' };
      mv.forEach((m, i) => { setting[`motor_${'abcd'[i]}_reversed`] = String(m.reversed); });
      this.add(name, {
        kind: 'motorgroup', name, ports: mv.map(m => m.port),
        config: { port: mv.map(m => m.port), name, customName: true, deviceType: 'MotorGroup', deviceClass: 'motor_group', setting, triportSourcePort: 22 }
      });
      return true;
    }
    if (kind === 'drivetrain') {
      const l = this.motorVars.get((chainOf(args[0]) || [''])[0].toLowerCase());
      const r = this.motorVars.get((chainOf(args[1]) || [''])[0].toLowerCase());
      // left/right may themselves be motor groups (4-motor drivetrain)
      const lg = !l && this.get((chainOf(args[0]) || [''])[0]);
      const rg = !r && this.get((chainOf(args[1]) || [''])[0]);
      let ports, type = '2-motor';
      if (l && r) { ports = [l.port, r.port]; this.absorb(l.name); this.absorb(r.name); this.dtParts.add(l.name.toLowerCase()); this.dtParts.add(r.name.toLowerCase()); }
      else if (lg && rg && lg.kind === 'motorgroup' && rg.kind === 'motorgroup') {
        ports = [...lg.ports, ...rg.ports]; type = '4-motor';
        this.absorb(lg.codeName); this.absorb(rg.codeName); this.dtParts.add(lg.codeName.toLowerCase()); this.dtParts.add(rg.codeName.toLowerCase());
      } else return false;
      let gyroType = 'none', gyroPort = 0, rest = args.slice(2);
      const g = rest.length ? chainOf(rest[0]) : null;
      if (g && rest[0] && unparen(rest[0]).k === 'name') {
        const gd = this.get(g[0]);
        if (gd && gd.kind === 'inertial') { gyroType = 'integrated'; rest = rest.slice(1); }
        else if (gd && gd.kind === 'gyro') { gyroType = 'smart'; gyroPort = gd.ports[0] || 0; this.absorb(gd.codeName); this.dtParts.add(gd.codeName.toLowerCase()); rest = rest.slice(1); }
      }
      // wheel travel / track width / wheelbase / units / ratio
      let wheel = 200, width = 173, base = 76, unit = 'mm', ext = null;
      const nums = [];
      for (const a of rest) {
        const u = unparen(a);
        if (u.k === 'num') nums.push(u.v);
        else if (enumOf(u) === 'inches') unit = 'in';
      }
      const kw = (args.kwargs) || {};
      if (nums[0]) wheel = nums[0];
      if (nums[1]) width = nums[1];
      if (nums[2]) base = nums[2];
      if (nums[3]) ext = nums[3];
      if (kw.wheelTravel && unparen(kw.wheelTravel).k === 'num') wheel = unparen(kw.wheelTravel).v;
      if (kw.trackWidth && unparen(kw.trackWidth).k === 'num') width = unparen(kw.trackWidth).v;
      if (kw.wheelBase && unparen(kw.wheelBase).k === 'num') base = unparen(kw.wheelBase).v;
      if (kw.externalGearRatio && unparen(kw.externalGearRatio).k === 'num') ext = unparen(kw.externalGearRatio).v;
      let ratio = '1:1';
      if (l && l.ratio) ratio = ratioString(l.ratio);
      else if (ext) ratio = ratioString(1 / ext);
      const config = {
        port: [...ports, ...(type === '2-motor' ? [gyroPort] : [gyroPort])], name: 'Drivetrain', customName: false,
        deviceType: 'Drivetrain', deviceClass: 'smartdrive',
        setting: { type, wheelSize: wheel >= 240 ? '250mm' : '200mm', gearRatio: ratio, direction: 'fwd', gyroType, width: String(width), unit, wheelbase: String(base), wheelbaseUnit: unit, xOffset: '0', yOffset: '0', thetaOffset: '0' },
        triportSourcePort: 22
      };
      this.add(name, { kind: 'drivetrain', name: 'Drivetrain', ports: config.port, config });
      return true;
    }
    if (kind === 'controller') {
      this.add(name, { kind: 'controller', name: 'Controller', ports: [], config: defaultController() });
      return true;
    }
    // single-port sensors / pneumatics
    const port = portOf(args[0]);
    if (port) this.usedPorts.add(port);
    const [deviceType, deviceClass] = KIND_TYPE[kind];
    const setting = {};
    if (kind === 'pneumatic') {
      Object.assign(setting, { cylinder1: 'cylinder1', cylinder2: 'cylinder2', cylinder1_reversed: 'false', cylinder2_reversed: 'false' });
      if (this.gen !== 'First') Object.assign(setting, { cylinder3: '', cylinder4: '' });
    }
    this.add(name, { kind, name, ports: [port], config: { port: [port], name, customName: true, deviceType, deviceClass, setting, triportSourcePort: 22 } });
    return true;
  }
  absorb(codeName) {
    const low = codeName.toLowerCase();
    const d = this.map.get(low);
    if (d) { this.order = this.order.filter(x => x !== d); this.map.delete(low); }
  }
  // create a device for a name used in code but never configured
  infer(name, kind) {
    const port = ['controller', 'drivetrain'].includes(kind) ? null : this.freePort();
    let config;
    if (kind === 'drivetrain') {
      const a = this.freePort(), b = this.freePort();
      config = { port: [a, b, 0], name: 'Drivetrain', customName: false, deviceType: 'Drivetrain', deviceClass: 'smartdrive', setting: { type: '2-motor', wheelSize: '200mm', gearRatio: '1:1', direction: 'fwd', gyroType: this.gen === 'First' ? 'none' : 'integrated', width: '173', unit: 'mm', wheelbase: '76', wheelbaseUnit: 'mm', xOffset: '0', yOffset: '0', thetaOffset: '0' }, triportSourcePort: 22 };
      this.notes.push(`No drivetrain setup was found, so a 2-motor Drivetrain was added on ports ${a} and ${b}. Check it in VEXcode's Devices menu.`);
      return this.add(name, { kind, name: 'Drivetrain', ports: config.port, config });
    }
    if (kind === 'controller') return this.add(name, { kind, name: 'Controller', ports: [], config: defaultController() });
    if (kind === 'inertial') return this.add(name, { kind, name: 'BrainInertial', ports: [] });
    const [deviceType, deviceClass] = KIND_TYPE[kind];
    const setting = kind === 'motor' ? { reversed: 'false', fwd: 'forward', rev: 'reverse' } :
      kind === 'pneumatic' ? { cylinder1: 'cylinder1', cylinder2: 'cylinder2', cylinder1_reversed: 'false', cylinder2_reversed: 'false' } : {};
    config = { port: [port], name, customName: true, deviceType, deviceClass, setting, triportSourcePort: 22 };
    this.notes.push(`No setup was found for "${name}", so it was added as a ${deviceType} on port ${port}. Check the port in VEXcode's Devices menu.`);
    return this.add(name, { kind, name, ports: [port], config });
  }
  robotConfig() {
    return this.order.filter(d => d.config).map(d => d.config);
  }
}

function defaultController() {
  return { port: [], name: 'Controller', customName: false, deviceType: 'Controller', deviceClass: 'controller', setting: { left: '', leftDir: 'false', right: '', rightDir: 'false', e: '', eDir: 'false', f: '', fDir: 'false', l3r3: '', l3r3Dir: 'false', drive: 'none' }, triportSourcePort: 22 };
}

// which device kind a method implies (for code with no device setup)
function kindFromUsage(chain, method) {
  const sub = chain.length > 1 ? chain[1].toLowerCase() : '';
  if (/^(button|axis)/.test(sub)) return 'controller';
  const m = method;
  if (['drive', 'drive_for', 'turn', 'turn_for', 'turn_to_heading', 'set_drive_velocity', 'set_turn_velocity'].includes(m)) return 'drivetrain';
  if (['spin', 'spin_for', 'spin_to_position', 'set_velocity', 'set_max_torque', 'set_position', 'set_timeout', 'reset_position'].includes(m)) return 'motor';
  if (['extend', 'retract', 'pump_on', 'pump_off', 'pump'].includes(m)) return 'pneumatic';
  if (['set_color', 'set_brightness'].includes(m)) return 'touchled';
  if (['object_distance', 'is_object_detected'].includes(m)) return 'distance';
  if (['set_light', 'set_light_power'].includes(m)) return 'optical';
  if (['is_near_object'].includes(m)) return 'color';
  return null;
}

// ---------------------------------------------------------------- program model
const GENERATED_FUNCS = new Set([
  'calibrate_drivetrain', 'calibratedrivetrain', 'initializerandomseed', 'vexcodeinit', 'setrandomseedusingaccel',
  'printtobrain_numberformat', 'printtoconsole_numberformat', 'mathrandomint', 'rc_auto_loop_function_controller',
  'play_vexcode_sound', 'convertcolortostring'
]);
const HIDDEN_VARS = new Set(['remote_control_code_enabled', 'remotecontrolcodeenabled', 'brain_precision', 'console_precision']);
// variables VEXcode adds for its built-in driver control code
const GENERATED_VAR_RE = /needs_?to_?be_?stopped|control_?motors_?stopped|^remote_?control_?code_?enabled$|^vexcode_/i;
// comments VEXcode writes into generated code
const GENERATED_COMMENT_RE = /^(register event handlers|post event registration|pre event registration|when started blocks|".*" hat block|User defined function|Generated code\.|Include the IQ Library|Allows for easier use of the VEX Library|Begin project code|define variables? (used|for)|Robot configuration code|Brain should be defined by default|Make sure all required headers|Calibrate the Drivetrain|Initializing random seed|generating and setting random seed)/i;

function findRegions(src, lang) {
  // VEXcode generated robot-configuration region (device setup + driver-control code)
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const regions = [];
  let start = null;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (lang === 'py' ? /^#\s*region\b.*VEXcode Generated/i.test(t) : /^#pragma\s+region\b.*VEXcode Generated/i.test(t)) start = i + 1;
    if (start != null && (lang === 'py' ? /^#\s*endregion\b/i.test(t) : /^#pragma\s+endregion\b/i.test(t))) { regions.push([start, i + 1]); start = null; }
  });
  if (start != null) regions.push([start, lines.length]);
  return regions;
}

function controllerSettingsFromRegion(text) {
  const s = {};
  const re = /[Bb]utton(L|R|E|F)Up\/[Bb]utton\1Down status[\s\S]{0,40}?to control (\w+)/g;
  let m;
  while ((m = re.exec(text))) s[{ L: 'left', R: 'right', E: 'e', F: 'f' }[m[1]]] = m[2];
  if (/[Ll]eft[Ss]ide[Ss]peed\s*=\s*\w+\.[aA]xisA\.position\(\)\s*[;\n]/.test(text) && /[Rr]ight[Ss]ide[Ss]peed\s*=\s*\w+\.[aA]xisD\.position\(\)/.test(text)) s.drive = 'tank';
  else if (/[Ll]eft[Ss]ide[Ss]peed\s*=\s*\w+\.[aA]xisA\.position\(\)\s*\+\s*\w+\.[aA]xisC\.position\(\)/.test(text)) s.drive = 'split';
  else if (/[Ll]eft[Ss]ide[Ss]peed\s*=\s*\w+\.[aA]xisA\.position\(\)\s*\+\s*\w+\.[aA]xisB\.position\(\)/.test(text)) s.drive = 'left';
  return s;
}

export function detectLanguage(src, filename) {
  if (filename) {
    if (/\.(iqpython|py)$/i.test(filename)) return 'py';
    if (/\.(iqcpp|cpp|cc|h|hpp|c)$/i.test(filename)) return 'cpp';
  }
  let py = 0, cpp = 0;
  if (/^\s*(from|import)\s+\w/m.test(src)) py += 3;
  if (/^\s*def\s+\w+\s*\(.*\)\s*:/m.test(src)) py += 3;
  if (/:\s*(#.*)?$/m.test(src)) py += 1;
  if (/^\s*#\s*include\b/m.test(src)) cpp += 3;
  if (/;\s*(\/\/.*)?$/m.test(src)) cpp += 2;
  if (/\b(int|void)\s+\w+\s*\([^)]*\)\s*\{/.test(src)) cpp += 3;
  if (/[{}]/.test(src)) cpp += 1;
  if (/\bwhile\s*\(\s*true\s*\)/.test(src)) cpp += 2;
  if (/\bwhile\s+True\s*:/.test(src)) py += 2;
  if (/\w+\.\w+\(\w*\)\s*$/m.test(src) && !/;\s*$/m.test(src)) py += 1;
  return cpp > py ? 'cpp' : 'py';
}

export function detectGen(src) {
  if (/\b(Inertial|brain_inertial|BrainInertial|inertial)\b/.test(src) || /\bOptical\b|\boptical\b|AiVision|aivision/.test(src)) return 'Second';
  if (/\b(Sonar|sonar)\b|ColorSensor\(|colorsensor\(/.test(src)) return 'First';
  return 'Second';
}

// Read an uploaded VEXcode project file (or plain text). Returns {code, lang, gen, robotConfig, name}
export function readProjectFile(text, filename) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let j;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (j && typeof j === 'object') {
      if (j.mode === 'Blocks') return { error: 'This file is already a blocks project.' };
      const code = j.textContent ?? j.code ?? '';
      const lang = j.textLanguage === 'cpp' ? 'cpp' : j.textLanguage === 'python' ? 'py' : detectLanguage(code, filename);
      return {
        code, lang,
        gen: j.targetBrainGen === 'First' ? 'First' : j.targetBrainGen === 'Second' ? 'Second' : null,
        robotConfig: j.robotConfig || j.rconfig || null,
        name: (filename || '').replace(/\.[^.]+$/, '')
      };
    }
  }
  return { code: text, lang: detectLanguage(text, filename), gen: null, robotConfig: null, name: (filename || '').replace(/\.[^.]+$/, '') };
}

// ---------------------------------------------------------------- the converter
export function convertCode(code, { lang, gen, robotConfig, keepComments = true } = {}) {
  lang = lang || detectLanguage(code);
  gen = gen || detectGen(code);
  const issues = [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const parsed = lang === 'cpp' ? parseCpp(code) : parsePython(code);
  if (parsed.fatal) {
    issues.push({ line: parsed.fatal.line, text: (lines[parsed.fatal.line - 1] || '').trim(), reason: `Could not read the code: ${parsed.fatal.msg}`, fatal: true });
    return { ok: false, issues, notes: [], stacks: [], variables: [], robotConfig: [], gen, lang };
  }

  const regions = findRegions(code, lang);
  const inRegion = (ln) => regions.some(([a, b]) => ln >= a && ln <= b);
  const devices = new Devices(gen);
  const fromFile = Array.isArray(robotConfig) && robotConfig.length > 0;
  if (fromFile) devices.loadConfig(robotConfig);

  // ---- pass 1: split top level into functions / device setup / main code
  const funcs = new Map();
  let main = [];
  const globalDecls = [];
  const ctx0 = { lang };

  const ctorOf = (value) => {
    const v = unparen(value);
    if (!v || v.k !== 'call') return null;
    const c = chainOf(v.fn);
    if (!c) return null;
    return { name: c[c.length - 1], args: Object.assign(v.args.slice(), { kwargs: v.kwargs }) };
  };

  const handleDeviceStmt = (s) => {
    // python: name = Ctor(...);  c++: type name = type(...);  or  type name(args);
    if (s.k === 'assign' && s.op === '=' && unparen(s.target).k === 'name') {
      const c = ctorOf(s.value);
      if (c && (lang === 'py' ? PY_CTORS[c.name] : CPP_CTORS[c.name])) {
        if (fromFile && (devices.get(unparen(s.target).id) || c.name === 'Brain' || c.name === 'Inertial')) return true; // trust the file's device list
        return devices.tryCtor(lang, unparen(s.target).id, c.name, c.args) || 'bad';
      }
    }
    if (s.k === 'decl') {
      const base = s.type.replace(/^vex::/, '').replace(/\s+/g, '');
      if (CPP_CTORS[base]) {
        if (fromFile && devices.get(s.name)) return true;
        if (s.ctorArgs) return devices.tryCtor(lang, s.name, base, s.ctorArgs) || 'bad';
        const c = ctorOf(s.value);
        if (c) return devices.tryCtor(lang, s.name, c.name, c.args) || 'bad';
        if (!s.value) return devices.tryCtor(lang, s.name, base, []) || 'bad';
      }
    }
    return false;
  };

  // #define NAME 123  ->  constant numbers
  const constants = new Map();
  for (const pp of parsed.pragmas || []) {
    const m = /^#\s*define\s+([A-Za-z_]\w*)\s+\(?\s*(-?\d+(?:\.\d+)?)[fF]?\s*\)?\s*$/.exec(pp.v.trim());
    if (m) constants.set(m[1], parseFloat(m[2]));
  }
  // broadcast messages: python  msg = Event()   c++  event msg = event();
  const events = new Set();
  const isEventCtor = (v) => { const c = ctorOf(v); return !!c && /^event$/i.test(c.name) && !c.args.length; };
  for (const s of parsed.body) {
    if (s.k === 'assign' && s.op === '=' && unparen(s.target).k === 'name' && isEventCtor(s.value)) events.add(unparen(s.target).id);
    if (s.k === 'decl' && /^(vex::)?event$/.test(s.type)) events.add(s.name);
  }

  for (const s of parsed.body) {
    const generated = inRegion(s.line);
    if ((s.k === 'decl' && events.has(s.name)) || (s.k === 'assign' && unparen(s.target).k === 'name' && events.has(unparen(s.target).id))) continue;
    const dev = handleDeviceStmt(s);
    if (dev === true) continue;
    if (dev === 'bad' && !generated) { issues.push(issueFor(s, 'This device setup line could not be understood')); continue; }
    if (generated) continue; // everything else in the generated region is VEXcode boilerplate
    if (s.k === 'func') {
      if (GENERATED_FUNCS.has(s.name.toLowerCase())) continue;
      if (lang === 'cpp' && s.name === 'main') { main.push(...s.body); continue; }
      funcs.set(s.name, s);
      continue;
    }
    if (s.k === 'proto' || s.k === 'import' || s.k === 'global' || s.k === 'pass') continue;
    if (lang === 'py' && s.k === 'if' && s.branches.length === 1 && !s.orelse && JSON.stringify(s.branches[0].cond).includes('"__name__"')) { main.push(...s.branches[0].body); continue; }
    if (lang === 'cpp' && s.k === 'decl') {
      // global variable
      if (GENERATED_VAR_RE.test(s.name) || HIDDEN_VARS.has(s.name.toLowerCase())) continue;
      if (s.ctorArgs && s.ctorArgs.length === 1 && GENERATED_FUNCS.has((chainOf(s.ctorArgs[0]) || [''])[0].toLowerCase())) continue;
      if (s.ctorArgs && /task|thread/.test(s.type)) { main.push(s); continue; }
      globalDecls.push(s);
      continue;
    }
    if (lang === 'cpp' && s.k === 'comment') continue; // comments between C++ functions
    if (lang === 'cpp' && s.k !== 'unknown') { issues.push(issueFor(s, 'Code outside of a function')); continue; }
    main.push(s);
  }
  // driver-control settings from the generated region
  if (!fromFile) {
    const ctrl = devices.order.find(d => d.kind === 'controller');
    if (ctrl) {
      const regionText = regions.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
      Object.assign(ctrl.config.setting, controllerSettingsFromRegion(regionText));
    }
  }

  // ---- variables: collect & infer types
  const varTypes = new Map(); // name -> 'number' | 'boolean'
  const paramNames = new Set();
  for (const f of funcs.values()) for (const p of f.params) paramNames.add(p.name);
  const boolish = (e) => {
    e = unparen(e);
    if (!e) return false;
    if (e.k === 'bool' || e.k === 'cmp' || e.k === 'logic' || e.k === 'not') return true;
    if (e.k === 'call') {
      const c = chainOf(e.fn);
      const m = c && camelToSnake(c[c.length - 1]);
      return ['pressing', 'is_object_detected', 'is_near_object', 'is_spinning', 'is_done', 'found_object'].includes(m);
    }
    if (e.k === 'name' && varTypes.get(e.id) === 'boolean') return true;
    return false;
  };
  const noteVar = (name, valueExpr, declType) => {
    if (devices.get(name) || events.has(name) || constants.has(name) || HIDDEN_VARS.has(name.toLowerCase()) || GENERATED_VAR_RE.test(name)) return;
    let t = varTypes.get(name);
    const isBool = (declType && /\bbool\b/.test(declType)) || (valueExpr && boolish(valueExpr));
    if (!t) t = isBool ? 'boolean' : 'number';
    else if (isBool && t !== 'boolean' && valueExpr && unparen(valueExpr).k === 'bool') t = 'boolean';
    varTypes.set(name, t);
  };
  const walkVars = (stmts) => {
    for (const s of stmts) {
      if (s.k === 'assign' && unparen(s.target).k === 'name') noteVar(unparen(s.target).id, s.op === '=' ? s.value : null);
      if (s.k === 'incdec' && unparen(s.target).k === 'name') noteVar(unparen(s.target).id, null);
      if (s.k === 'decl' && !s.ctorArgs) noteVar(s.name, s.value, s.type);
      if (s.k === 'if') { s.branches.forEach(b => walkVars(b.body)); if (s.orelse) walkVars(s.orelse); }
      if (s.k === 'while' || s.k === 'for') walkVars(s.body);
    }
  };
  // two passes so boolean-ness can propagate through other variables
  for (let pass = 0; pass < 2; pass++) {
    walkVars(globalDecls); walkVars(main);
    for (const f of funcs.values()) walkVars(f.body);
  }
  for (const p of paramNames) if (!funcs.has(p)) varTypes.delete(p);

  // ---- procedures
  const procs = new Map(); // name -> {defId, params:[{name,id,type,def}], proccode, funcname}
  const usedAsEvent = new Set();
  const ensureProc = (f) => {
    if (procs.has(f.name)) return procs.get(f.name);
    const params = f.params.map(p => ({ name: p.name, id: genId(), type: /\bbool\b/.test(p.type || '') || f.body.some(st => usesAsCondition(st, p.name)) ? 'b' : 'n', def: p.def }));
    const proccode = [f.name, ...params.map(p => `%${p.type}`)].join(' ');
    const funcname = [f.name, ...params.map(p => p.name)].join('_');
    const pr = { defId: genId(), params, proccode, funcname, f };
    procs.set(f.name, pr);
    return pr;
  };

  // ---------------------------------------------------------------- statement conversion
  const stacks = [];   // [[hat, ...body]]
  const notes = [];
  let curLine = 0;
  const note = (msg) => notes.push({ line: curLine, text: (lines[curLine - 1] || '').trim(), msg });
  const eventStacks = [];

  function issueFor(s, reason) {
    const line = s.line || 0;
    return { line, endLine: s.endLine || line, text: (lines[line - 1] || '').trim(), reason };
  }

  function convertBody(stmts, ctx) {
    const out = [];
    stmts.forEach((s, idx) => {
      curLine = s.line || curLine;
      try {
        const r = convertStmt(s, ctx, idx === stmts.length - 1);
        if (r) out.push(...(Array.isArray(r) ? r : [r]));
      } catch (e) {
        if (!(e instanceof Unsupported)) { console.error(e); issues.push(issueFor(s, 'Internal error: ' + e.message)); return; }
        issues.push(issueFor(s, e.message));
      }
    });
    // "print" followed by "next row" on the brain screen -> one print block that moves to the next row
    for (let i = out.length - 2; i >= 0; i--) {
      const a = out[i], b = out[i + 1];
      if (a.type === 'iq_looks_print_new' && b.type === 'iq_looks_next_row_new' &&
        a.fields[0].value === 'Brain' && a.fields[1].value === 'false') {
        a.fields[1] = field('andsetcursortonextrow_mutator', 'true');
        out.splice(i + 1, 1);
      }
    }
    return out;
  }

  // VEXcode adds a short wait at the end of every loop it generates; blocks add it back automatically
  function loopBody(stmts) {
    const last = stmts[stmts.length - 1];
    if (last && last.k === 'expr' && isWaitCall(last.e)) {
      const a = unparen(last.e).args || [];
      const n = a[0] && unparen(a[0]);
      const u = a[1] ? enumOf(a[1]) : (chainOf(unparen(last.e).fn) || [''])[0].toLowerCase() === 'sleep' ? 'msec' : 'seconds';
      if (n && n.k === 'num' && ((u === 'msec' && n.v <= 20) || (u === 'seconds' && n.v <= 0.02))) return stmts.slice(0, -1);
    }
    return stmts;
  }

  function convertStmt(s, ctx, isLast) {
    switch (s.k) {
      case 'unknown': throw new Unsupported(friendlyReason(s.reason));
      case 'pass': case 'global': case 'import': case 'proto': return null;
      case 'comment': {
        if (!keepComments) return null;
        const t = s.text.replace(/^[-=*#/\s]+$/, '').trim();
        if (!t || /^(end)?region\b/i.test(t) || /^pragma\b/.test(t) || GENERATED_COMMENT_RE.test(t)) return null;
        return blk('iq_other_comment', { values: [val('COMMENT', blk('comment_text', { shadow: true, fields: [field('comment', t)] }))] });
      }
      case 'func': fail('Functions inside other code are not supported in blocks');
      case 'break': return blk('iq_control_break');
      case 'continue': fail("'continue' has no block in VEXcode IQ");
      case 'return': {
        if (s.value && !(ctx.isEntry && unparen(s.value).k === 'num')) fail('Returning a value has no block in VEXcode IQ');
        if (isLast || ctx.isEntry) return null;
        fail("'return' in the middle of code has no block (only at the end of a function)");
      }
      case 'decl': {
        if (s.ctorArgs) {
          // vex::task t(func);
          const base = s.type.replace(/^vex::/, '');
          if (['task', 'thread'].includes(base) && s.ctorArgs.length === 1) return threadHat(s.ctorArgs[0], s);
          if (handleDeviceStmt(s) === true) return null;
          fail(`'${s.type} ${s.name}(...)' has no block`);
        }
        if (handleDeviceStmt(s) === true) return null;
        if (s.value) {
          const c = ctorOf(s.value);
          if (c && ['task', 'thread'].includes(c.name) && c.args.length === 1) return threadHat(c.args[0], s);
          return setVar(s.name, s.value, ctx);
        }
        if (/\bbool\b/.test(s.type) || varTypes.has(s.name)) return null; // plain declaration
        fail('Unsupported declaration');
      }
      case 'incdec': {
        const t = unparen(s.target);
        if (t.k !== 'name') fail('Only variables can use ++/--');
        return changeVar(t.id, { k: 'num', v: s.op === '++' ? 1 : -1 }, ctx);
      }
      case 'assign': return convertAssign(s, ctx);
      case 'expr': return convertExprStmt(s.e, ctx, s);
      case 'if': return convertIf(s, ctx);
      case 'while': return convertWhile(s, ctx);
      case 'for': return convertFor(s, ctx);
    }
    fail('This statement has no block');
  }

  function friendlyReason(r) {
    if (!r) return 'This code could not be read';
    return r;
  }

  function convertAssign(s, ctx) {
    const t = unparen(s.target);
    if (t.k === 'tuple') fail('Assigning several variables at once is not supported in blocks');
    if (t.k === 'attr' || t.k === 'index') fail('Only plain variables can be set in blocks');
    if (t.k !== 'name') fail('Unsupported assignment');
    const name = t.id;
    if (ctx.params && ctx.params.has(name)) fail(`"${name}" is a function input; blocks can't change function inputs`);
    if (/^remote_?control_?code_?enabled$/i.test(name) && s.op === '=') {
      const v = unparen(s.value);
      if (v.k !== 'bool') fail('Controller enable/disable needs True or False');
      return blk('iq_sensing_controller_is_enabled', { fields: [field('isEnabled', v.v ? 'true' : 'false')] });
    }
    if (GENERATED_VAR_RE.test(name)) return null;
    // thread handle: ws2 = Thread(when_started2)
    const c = ctorOf(s.value);
    if (c && /^(thread|task)$/i.test(c.name) && c.args.length === 1 && s.op === '=') return threadHat(c.args[0], s);
    if (devices.get(name)) fail(`"${name}" is a device and can't be set like a variable`);
    if (s.op === '=') {
      const v = unparen(s.value);
      if (v.k === 'bin' && (v.op === '+' || v.op === '-') && unparen(v.l).k === 'name' && unparen(v.l).id === name && varTypes.get(name) !== 'boolean' && !isStringy(v.r)) {
        const amt = v.op === '+' ? v.r : (unparen(v.r).k === 'num' ? { k: 'num', v: -unparen(v.r).v } : { k: 'neg', e: v.r });
        return changeVar(name, amt, ctx);
      }
      return setVar(name, s.value, ctx);
    }
    const rhs = s.value;
    const self = { k: 'name', id: name };
    switch (s.op) {
      case '+=': return changeVar(name, rhs, ctx);
      case '-=': return changeVar(name, unparen(rhs).k === 'num' ? { k: 'num', v: -unparen(rhs).v } : { k: 'neg', e: rhs }, ctx);
      case '*=': return setVar(name, { k: 'bin', op: '*', l: self, r: rhs }, ctx);
      case '/=': return setVar(name, { k: 'bin', op: '/', l: self, r: rhs }, ctx);
      case '%=': return setVar(name, { k: 'bin', op: '%', l: self, r: rhs }, ctx);
    }
    fail(`'${s.op}' has no block`);
  }

  function setVar(name, value, ctx) {
    const v = unparen(value);
    if (v.k === 'str') fail('Text variables are not supported in VEXcode IQ blocks');
    if (v.k === 'list') fail('Lists are not supported by this converter');
    if (v.k === 'none') fail('None/null values have no block');
    if (varTypes.get(name) === 'boolean') {
      const shadow = blk('bool_input', { shadow: true, fields: [field('VALUE', v.k === 'bool' ? String(v.v) : 'false')] });
      return blk('iq_variables_set_boolean_variable', {
        fields: [field('VARIABLE', name, { variabletype: 'boolean' })],
        values: [val('VALUE', shadow, v.k === 'bool' ? null : boolExpr(v, ctx))]
      });
    }
    return blk('iq_variables_set_variable', { fields: [field('VARIABLE', name)], values: [numInput('VALUE', value, ctx)] });
  }
  function changeVar(name, value, ctx) {
    if (ctx.params && ctx.params.has(name)) fail(`"${name}" is a function input; blocks can't change function inputs`);
    if (varTypes.get(name) === 'boolean') fail('Can\'t add to a true/false variable');
    return blk('iq_variables_change_variable', { fields: [field('VARIABLE', name)], values: [numInput('VALUE', value, ctx)] });
  }

  function convertIf(s, ctx) {
    const n = s.branches.length;
    const conds = s.branches.map(b => boolExpr(b.cond, ctx));
    const bodies = s.branches.map(b => convertBody(b.body, ctx));
    const orelse = s.orelse ? convertBody(s.orelse, ctx) : null;
    if (n === 1 && !orelse) return blk('iq_control_if_then', { values: [val('CONDITION', null, conds[0])], statements: [stmt('SUBSTACK', bodies[0])] });
    if (n === 1) return blk('iq_control_if_then_else', { values: [val('CONDITION', null, conds[0])], statements: [stmt('SUBSTACK', bodies[0]), stmt('SUBSTACK2', orelse)] });
    const values = [], statements = [];
    conds.forEach((c, i) => { values.push(val(`CONDITION${i + 1}`, null, c)); });
    bodies.forEach((b, i) => statements.push(stmt(`SUBSTACK${i + 1}`, b)));
    statements.push(stmt('SUBSTACK_ELSE', orelse || []));
    // VEXcode writes values and statements interleaved; order doesn't matter to Blockly
    return blk('iq_control_if_elseif_else', { mutation: { branches: String(n) }, values, statements });
  }

  function convertWhile(s, ctx) {
    const cond = unparen(s.cond);
    if (isTruthyLiteral(cond)) return blk('iq_control_forever', { statements: [stmt('SUBSTACK', convertBody(loopBody(s.body), ctx))] });
    if (cond.k === 'bool' && !cond.v) return null;
    // "while not X: wait(...)" is how VEXcode writes "wait until X"
    const onlyWaits = s.body.length === 0 || s.body.every(b => b.k === 'pass' || (b.k === 'expr' && isWaitCall(b.e)));
    if (onlyWaits) {
      const target = cond.k === 'not' ? cond.e : { k: 'not', e: cond };
      return blk('iq_control_wait_until', { values: [val('CONDITION', null, boolExpr(target, ctx))] });
    }
    if (cond.k === 'not') {
      return blk('iq_control_repeat_until', { values: [val('CONDITION', null, boolExpr(cond.e, ctx))], statements: [stmt('SUBSTACK', convertBody(loopBody(s.body), ctx))] });
    }
    return blk('iq_control_while', { values: [val('CONDITION', null, boolExpr(cond, ctx))], statements: [stmt('SUBSTACK', convertBody(loopBody(s.body), ctx))] });
  }

  function isWaitCall(e) {
    e = unparen(e);
    if (!e || e.k !== 'call') return false;
    const c = chainOf(e.fn);
    return !!c && ['wait', 'sleep'].includes(c[c.length - 1].toLowerCase());
  }

  function usesName(node, name) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(n => usesName(n, name));
    if (node.k === 'name' && node.id === name) return true;
    for (const k of Object.keys(node)) {
      if (k === 'line' || k === 'endLine') continue;
      const v = node[k];
      if (v && typeof v === 'object' && usesName(v, name)) return true;
    }
    return false;
  }

  function convertFor(s, ctx) {
    const it = unparen(s.iter);
    const c = it && it.k === 'call' ? chainOf(it.fn) : null;
    if (!c || c.join('.') !== 'range') fail('Only "for ... in range(...)" loops can become blocks');
    if (Object.keys(it.kwargs || {}).length) fail('range() with keywords is not supported');
    let start = { k: 'num', v: 0 }, count;
    if (it.args.length === 1) count = it.args[0];
    else if (it.args.length === 2) {
      start = it.args[0];
      const a = unparen(it.args[0]), b = unparen(it.args[1]);
      count = a.k === 'num' && b.k === 'num' ? { k: 'num', v: Math.max(0, b.v - a.v) } : { k: 'bin', op: '-', l: it.args[1], r: it.args[0] };
    } else fail('range() with a step is not supported in blocks');
    const target = s.target && unparen(s.target);
    if (target && target.k !== 'name') fail('Unsupported loop variable');
    const loopVarUsed = target && s.body.some(b => usesName(b, target.id));
    if (loopVarUsed) {
      if (ctx.params && ctx.params.has(target.id)) fail('Loop variable has the same name as a function input');
      varTypes.set(target.id, 'number');
    }
    const body = convertBody(loopBody(s.body), ctx);
    const rep = blk('iq_control_repeat', { values: [numInput('TIMES', count, ctx, 'math_whole_number')], statements: [stmt('SUBSTACK', body)] });
    if (!loopVarUsed) return rep;
    // keep a counter variable in step with the loop
    rep.statements[0].blocks.push(blk('iq_variables_change_variable', { fields: [field('VARIABLE', target.id)], values: [numInput('VALUE', { k: 'num', v: 1 }, ctx)] }));
    return [blk('iq_variables_set_variable', { fields: [field('VARIABLE', target.id)], values: [numInput('VALUE', start, ctx)] }), rep];
  }

  // ---------------------------------------------------------------- inputs
  function numInput(name, e, ctx, shadowType = 'math_number') {
    e = foldConst(e);
    if (e.k === 'num') return val(name, shadowNum(shadowType, e.v));
    if (e.k === 'bool') return val(name, shadowNum(shadowType, e.v ? 1 : 0));
    const def = shadowType === 'math_positive_number' || shadowType === 'math_whole_number' ? 1 : 0;
    return val(name, shadowNum(shadowType, def), numExpr(e, ctx));
  }
  function textInput(name, e, ctx) {
    e = unparen(e);
    if (e.k === 'str') {
      if (e.fstr) fail('f-strings are not supported in blocks; print the text and the value separately');
      return val(name, shadowText(e.v));
    }
    if (e.k === 'num') return val(name, shadowText(String(e.v)));
    if (e.k === 'bin' && e.op === '+' && (isStringy(e.l) || isStringy(e.r))) fail('Joining text with + has no block in VEXcode IQ; print the parts separately');
    if (e.k === 'call' && chainOf(e.fn) && ['str', 'to_string'].includes(chainOf(e.fn).join('.')) && e.args.length === 1) return textInput(name, e.args[0], ctx);
    const b = valueExpr(e, ctx);
    return val(name, shadowText(''), b);
  }
  function isStringy(e) { e = unparen(e); return e.k === 'str' || (e.k === 'call' && chainOf(e.fn) && chainOf(e.fn)[0] === 'str'); }

  // reporter for any value (number or boolean)
  function valueExpr(e, ctx) {
    e = unparen(e);
    if (boolishExpr(e, ctx)) return boolExpr(e, ctx);
    return numExpr(e, ctx);
  }
  function boolishExpr(e, ctx) {
    e = unparen(e);
    if (e.k === 'name' && ctx.params && ctx.params.has(e.id)) return ctx.params.get(e.id).type === 'b';
    return boolish(e);
  }

  // replace #define constants with their numbers
  function foldConst(e) {
    e = unparen(e);
    if (!e) return e;
    if (e.k === 'name' && constants.has(e.id) && !varTypes.has(e.id)) return { k: 'num', v: constants.get(e.id), line: e.line };
    if (e.k === 'neg') { const i = foldConst(e.e); if (i.k === 'num') return { k: 'num', v: -i.v, line: e.line }; }
    return e;
  }

  function numExpr(e, ctx) {
    e = foldConst(e);
    switch (e.k) {
      case 'num': {
        // a bare number where a block is required: (0 + n)
        return blk('iq_operator_add', { values: [val('NUM1', shadowNum('math_number', 0)), val('NUM2', shadowNum('math_number', e.v))] });
      }
      case 'name': return varReporter(e.id, ctx);
      case 'neg': {
        const inner = unparen(e.e);
        if (inner.k === 'num') return numExpr({ k: 'num', v: -inner.v }, ctx);
        return blk('iq_operator_function', { fields: [field('OPERATOR', 'negate')], values: [numInput('NUM', inner, ctx)] });
      }
      case 'bin': {
        const map = { '+': 'iq_operator_add', '-': 'iq_operator_subtract', '*': 'iq_operator_multiply', '/': 'iq_operator_divide', '%': 'iq_operator_remainder' };
        if (e.op === '+' && (isStringy(e.l) || isStringy(e.r))) fail('Joining text has no block in VEXcode IQ');
        if (e.op === '//') {
          // floor division -> round(a / b) is not identical; refuse
          fail("'//' (whole-number division) has no matching block");
        }
        const t = map[e.op];
        if (!t) fail(`The '${e.op}' operator has no block in VEXcode IQ`);
        return blk(t, { values: [numInput('NUM1', e.l, ctx), numInput('NUM2', e.r, ctx)] });
      }
      case 'cmp': case 'logic': case 'not': case 'bool': return boolExpr(e, ctx);
      case 'call': return callReporter(e, ctx);
      case 'attr': {
        const c = chainOf(e);
        fail(`"${c ? c.join('.') : describe(e)}" has no block`);
      }
      case 'str': fail('Text values can only be used in print blocks');
      case 'ternary': fail("Inline 'if ... else' expressions have no block");
      case 'index': fail('Lists/arrays are not supported by this converter');
    }
    fail(`This value (${describe(e)}) has no block`);
  }

  function varReporter(name, ctx) {
    if (ctx.params && ctx.params.has(name)) {
      const p = ctx.params.get(name);
      return blk(p.type === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_number', {
        mutation: { funcname: ctx.proc.funcname, argumentid: p.id, proceduredefid: ctx.proc.defId },
        fields: [field('VALUE', name)]
      });
    }
    if (devices.get(name)) fail(`"${name}" is a device, not a value`);
    if (!varTypes.has(name)) {
      if (/^(true|false)$/i.test(name)) fail('True/False can only be used to set a true/false variable');
      fail(`"${name}" is never set in this code, so it can't become a variable block`);
    }
    if (varTypes.get(name) === 'boolean') return blk('iq_variables_boolean_variable', { fields: [field('VARIABLE', name, { variabletype: 'boolean' })] });
    return blk('iq_variables_variable', { fields: [field('VARIABLE', name)] });
  }

  function boolExpr(e, ctx) {
    e = unparen(e);
    switch (e.k) {
      case 'logic': return blk('iq_operator_and_or', { fields: [field('CHECK', e.op)], values: [val('OPERAND1', null, boolExpr(e.l, ctx)), val('OPERAND2', null, boolExpr(e.r, ctx))] });
      case 'not': return blk('iq_operator_not', { values: [val('OPERAND', null, boolExpr(e.e, ctx))] });
      case 'cmp': return compare(e, ctx);
      case 'bool': fail('A plain True/False here has no block');
      case 'name': {
        if (ctx.params && ctx.params.has(e.id)) return varReporter(e.id, ctx);
        if (varTypes.get(e.id) === 'boolean') return varReporter(e.id, ctx);
        if (varTypes.has(e.id)) {
          // number variable used as a condition -> (x != 0)
          return blk('iq_operator_not', { values: [val('OPERAND', null, compare({ k: 'cmp', op: '==', l: e, r: { k: 'num', v: 0 } }, ctx))] });
        }
        return varReporter(e.id, ctx);
      }
      case 'call': {
        const b = callReporter(e, ctx);
        if (b.__bool) return b;
        // numeric reporter used as condition -> (x != 0)
        return blk('iq_operator_not', { values: [val('OPERAND', null, blk('iq_operator_comparison', { fields: [field('COMPARISON', '==')], values: [val('NUM1', shadowNum('math_number_string', 0), b), val('NUM2', shadowNum('math_number_string', 0))] }))] });
      }
    }
    fail(`This condition (${describe(e)}) has no block`);
  }

  function compare(e, ctx) {
    // optical.color() == Color.RED  ->  optical detects red?
    const l = unparen(e.l), r = unparen(e.r);
    if ((e.op === '==' || e.op === '!=') && l.k === 'call') {
      const c = chainOf(l.fn);
      if (c && c.length === 2 && c[1].toLowerCase() === 'color') {
        const d = deviceFor(c, 'color');
        if (d.kind === 'optical') {
          const col = enumOf(r);
          if (!col || !COLORS.includes(col)) fail('Unknown color');
          const b = blk('iq_sensing_optical_detect', { fields: [field('OPTICAL', d.name), field('COLORS', col)] });
          return e.op === '==' ? b : blk('iq_operator_not', { values: [val('OPERAND', null, b)] });
        }
      }
    }
    if (['in', 'not in', 'is', 'is not'].includes(e.op)) fail(`'${e.op}' comparisons have no block`);
    if (boolishExpr(l, ctx) || boolishExpr(r, ctx) || l.k === 'bool' || r.k === 'bool') {
      // comparing true/false values
      const other = l.k === 'bool' ? r : r.k === 'bool' ? l : null;
      const lit = l.k === 'bool' ? l : r.k === 'bool' ? r : null;
      if (other && lit && (e.op === '==' || e.op === '!=')) {
        const want = (lit.v === true) === (e.op === '==');
        const b = boolExpr(other, ctx);
        return want ? b : blk('iq_operator_not', { values: [val('OPERAND', null, b)] });
      }
      fail('Comparing two true/false values has no block');
    }
    const mk = (op, a, b) => blk('iq_operator_comparison', { fields: [field('COMPARISON', op)], values: [numInput('NUM1', a, ctx, 'math_number_string'), numInput('NUM2', b, ctx, 'math_number_string')] });
    const not = (b) => blk('iq_operator_not', { values: [val('OPERAND', null, b)] });
    switch (e.op) {
      case '<': case '>': case '<=': case '==': return mk(e.op, e.l, e.r);
      case '>=': return mk('<=', e.r, e.l);
      case '!=': return not(mk('==', e.l, e.r));
    }
    fail(`'${e.op}' has no block`);
  }

  // ---------------------------------------------------------------- calls
  function normCall(e) {
    const c = chainOf(e.fn);
    if (!c) fail(`"${describe(e.fn)}" can't become a block`);
    const method = camelToSnake(c[c.length - 1]);
    return { c, method, args: e.args, kwargs: e.kwargs || {} };
  }

  function deviceFor(c, method) {
    const root = c[0];
    let d = devices.get(root);
    if (d && d.kind === 'dtpart') fail(`"${root}" is one of the drivetrain's motors; blocks can only control the whole drivetrain`);
    if (!d) {
      if (/^brain_?inertial$/i.test(root)) {
        if (gen === 'First') fail('The 1st gen brain has no built-in gyro');
        return devices.infer(root, 'inertial');
      }
      const kind = kindFromUsage(c, method);
      if (!kind) fail(`"${root}" isn't a device in this project`);
      d = devices.infer(root, kind);
    }
    return d;
  }

  // wait / sleep durations -> seconds input
  function secondsInput(name, amount, unitExpr, ctx, shadowType = 'math_positive_number', defaultUnit = 'sec') {
    const u = unitExpr ? enumOf(unitExpr) : defaultUnit;
    const a = unparen(amount);
    if (['seconds', 'sec', 'timeunits.sec'].includes(u)) return numInput(name, a, ctx, shadowType);
    if (['msec', 'ms', 'milliseconds'].includes(u)) {
      if (a.k === 'num') return numInput(name, { k: 'num', v: a.v / 1000 }, ctx, shadowType);
      return numInput(name, { k: 'bin', op: '/', l: a, r: { k: 'num', v: 1000 } }, ctx, shadowType);
    }
    fail(`Unknown time unit: ${describe(unitExpr)}`);
  }

  // Parse motion args: [dir], amount, units, [velocity, vunits], [wait]
  function motionArgs(args, kwargs, dirMap, unitMap, unitWhat) {
    let i = 0, dir = null;
    if (dirMap && args[0] && dirMap[enumOf(args[0])] !== undefined) { dir = dirMap[enumOf(args[0])]; i++; }
    const amount = args[i++];
    if (!amount) fail('Missing amount');
    let units = null;
    if (args[i] && unitMap[enumOf(args[i])] !== undefined) units = unitMap[enumOf(args[i++])];
    else if (args[i] && enumOf(args[i]) && unparen(args[i]).k !== 'bool') fail(`Unknown ${unitWhat}: ${describe(args[i])}`);
    let wait = true, vel = null, vunits = 'pct';
    const rest = args.slice(i);
    if (rest.length && unparen(rest[rest.length - 1]).k === 'bool') wait = unparen(rest.pop()).v;
    if (rest.length) {
      vel = rest[0];
      if (rest[1]) vunits = pick(VEL_UNITS, rest[1], 'velocity unit');
      if (rest.length > 2) fail('Too many inputs for this command');
    }
    for (const [k, v] of Object.entries(kwargs)) {
      if (k === 'wait' || k === 'waitForCompletion') { const u = unparen(v); if (u.k !== 'bool') fail('wait= must be True or False'); wait = u.v; }
      else if (k === 'units') { units = unitMap[enumOf(v)]; if (!units) fail(`Unknown ${unitWhat}`); }
      else if (k === 'velocity') vel = v;
      else if (k === 'units_v') vunits = pick(VEL_UNITS, v, 'velocity unit');
      else fail(`The "${k}=" option has no block`);
    }
    if (vel && vunits !== 'pct') fail('Speeds must be in percent to become blocks');
    return { dir, amount, units, wait, vel };
  }
  const waitField = (wait) => field('anddontwait_mutator', wait ? 'false' : 'true');

  function convertExprStmt(e, ctx, s) {
    e = unparen(e);
    if (e.k === 'str') return null; // docstring
    if (e.k !== 'call') fail('This line does nothing a block can do');
    const { c, method, args, kwargs } = normCall(e);
    const full = c.map(x => x.toLowerCase()).join('.');
    const root = c[0].toLowerCase();

    // ---- broadcast messages
    if (c.length === 1 && events.has(c[0]) && args.length === 1) {
      const f = funcByRef(args[0]);
      usedAsEvent.add(f.name);
      eventStacks.push({ hat: blk('iq_events_when_broadcasted', { fields: [field('BROADCAST_OPTION', c[0], { variabletype: 'broadcast_msg' })] }), f });
      return null;
    }
    if (c.length === 2 && events.has(c[0])) {
      if (method === 'broadcast') return blk('iq_events_broadcast', { fields: [field('BROADCAST_OPTION', c[0], { variabletype: 'broadcast_msg' })] });
      fail(`${c.join('.')}() has no block`);
    }

    // ---- plain functions
    if (c.length === 1) {
      const fname = c[0];
      if (['wait', 'sleep'].includes(root)) {
        if (root === 'sleep' && args.length === 1) return blk('iq_control_wait', { values: [secondsInput('DURATION', args[0], null, ctx, 'math_positive_number', 'msec')] });
        return blk('iq_control_wait', { values: [secondsInput('DURATION', args[0], args[1], ctx)] });
      }
      if (root === 'waituntil' || root === 'wait_until') return blk('iq_control_wait_until', { values: [val('CONDITION', null, boolExpr(args[0], ctx))] });
      if (root === 'print') return pythonPrint(args, kwargs, ctx);
      if (root === 'printf') return cppPrintf(args, ctx);
      if (['thread', 'task'].includes(root) && args.length === 1) return threadHat(args[0], s);
      if (GENERATED_FUNCS.has(root)) return null;
      if (funcs.has(fname)) return procCall(funcs.get(fname), args, ctx);
      fail(`"${fname}()" has no block`);
    }
    if (full === 'task.sleep' || full === 'this_thread.sleep_for' || full === 'vex.task.sleep') return blk('iq_control_wait', { values: [secondsInput('DURATION', args[0], null, ctx, 'math_positive_number', 'msec')] });

    // ---- brain
    if (root === 'brain') return brainStmt(c, method, args, kwargs, ctx, s);

    // ---- event registration: device.something.pressed(handler)
    if (['pressed', 'released', 'changed'].includes(method) && args.length === 1 && (chainOf(args[0]) || []).length === 1) {
      return eventHat(c, method, args[0], s);
    }

    const d = deviceFor(c, method);
    if (d.kind === 'controller') fail(`"${c.join('.')}" has no block`);
    return deviceStmt(d, c, method, args, kwargs, ctx);
  }

  function pythonPrint(args, kwargs, ctx) {
    for (const k of Object.keys(kwargs)) if (!['end', 'sep', 'precision'].includes(k)) fail(`print(${k}=...) has no block`);
    const newline = !(kwargs.end && unparen(kwargs.end).k === 'str' && unparen(kwargs.end).v === '');
    if (kwargs.end && !(unparen(kwargs.end).k === 'str' && ['', '\n'].includes(unparen(kwargs.end).v))) fail('print(end=...) can only be "" in blocks');
    if (!args.length) return blk('iq_looks_print_new', { fields: [field('TARGET', 'Console'), field('andsetcursortonextrow_mutator', 'true')], values: [val('DATA', shadowText(''))] });
    // python puts a space between printed items
    const sep = kwargs.sep && unparen(kwargs.sep).k === 'str' ? unparen(kwargs.sep).v : ' ';
    return args.map((a, i) => {
      let item = a;
      const u = unparen(a);
      if (i < args.length - 1 && u.k === 'str' && !u.fstr) item = { k: 'str', v: u.v + sep };
      return blk('iq_looks_print_new', {
        fields: [field('TARGET', 'Console'), field('andsetcursortonextrow_mutator', i === args.length - 1 && newline ? 'true' : 'false')],
        values: [textInput('DATA', item, ctx)]
      });
    });
  }

  function formatArgs(args, ctx, target) {
    // print("text") / print("%d", x) / print(fmt(), x)
    let a = args.slice();
    const first = a[0] && unparen(a[0]);
    if (first && first.k === 'call' && GENERATED_FUNCS.has((chainOf(first.fn) || [''])[0].toLowerCase())) a = a.slice(1);
    else if (first && first.k === 'str' && /%/.test(first.v) && a.length > 1) {
      const fmt = first.v;
      // split "Speed: %d rpm" around the placeholders
      const parts = fmt.split(/%[-+ #0]*\d*(?:\.\d+)?[lh]*[dfisuxXeEgGc]/);
      if (parts.length - 1 !== a.length - 1) fail('This print format is too complex for blocks');
      const out = [];
      parts.forEach((p, i) => {
        if (p.replace(/\n$/, '')) out.push({ k: 'str', v: p.replace(/\n$/, '') });
        if (i < a.length - 1) out.push(a[i + 1]);
      });
      return { items: out, newline: /\n$/.test(fmt) };
    }
    if (first && first.k === 'str') {
      const nl = /\n$/.test(first.v);
      return { items: a.length === 1 && first.v.replace(/\n$/, '') === '' ? [] : [{ k: 'str', v: first.v.replace(/\n$/, '') }, ...a.slice(1)], newline: nl };
    }
    return { items: a, newline: false };
  }

  function cppPrintf(args, ctx) {
    const { items, newline } = formatArgs(args, ctx);
    if (!items.length) return blk('iq_looks_print_new', { fields: [field('TARGET', 'Console'), field('andsetcursortonextrow_mutator', 'true')], values: [val('DATA', shadowText(''))] });
    return items.map((it, i) => blk('iq_looks_print_new', {
      fields: [field('TARGET', 'Console'), field('andsetcursortonextrow_mutator', i === items.length - 1 && newline ? 'true' : 'false')],
      values: [textInput('DATA', it, ctx)]
    }));
  }

  function brainStmt(c, method, args, kwargs, ctx, s) {
    const sub = (c[1] || '').toLowerCase();
    if (sub === 'screen') {
      switch (method) {
        case 'print': {
          for (const k of Object.keys(kwargs)) if (!['sep', 'precision'].includes(k)) fail(`print(${k}=...) has no block`);
          const { items } = lang === 'cpp' ? formatArgs(args, ctx) : { items: args };
          if (!items.length) fail('Nothing to print');
          return items.map(it => blk('iq_looks_print_new', { fields: [field('TARGET', 'Brain'), field('andsetcursortonextrow_mutator', 'false')], values: [textInput('DATA', it, ctx)] }));
        }
        case 'next_row': case 'new_line': return blk('iq_looks_next_row_new', { fields: [field('TARGET', 'Brain')] });
        case 'clear_screen': if (args.length) fail('Clearing the screen to a color has no block'); return blk('iq_looks_clear_all_rows_new', { fields: [field('TARGET', 'Brain')] });
        case 'clear_row': case 'clear_line':
          if (!args.length) fail('clear_row() needs a row number');
          return blk('iq_looks_clear_row_new', { fields: [field('TARGET', 'Brain')], values: [numInput('ROW', args[0], ctx, 'math_whole_number')] });
        case 'set_cursor':
          return blk('iq_looks_set_cursor_new', { fields: [field('TARGET', 'Brain')], values: [numInput('ROW', args[0], ctx, 'math_whole_number'), numInput('COLUMN', args[1], ctx, 'math_whole_number')] });
        case 'set_font': {
          const f = enumOf(args[0]);
          if (!f || !/^(mono|prop)\d+$/.test(f)) fail('Unknown font');
          return blk('iq_looks_set_font', { fields: [field('FONT', f)] });
        }
      }
      fail(`brain.screen.${method}() has no block`);
    }
    if (sub === 'timer') {
      if (['clear', 'reset'].includes(method)) return blk('iq_sensing_reset_timer');
      fail(`Timer ${method}() has no block`);
    }
    if (method === 'play_sound') {
      const raw = (unparen(args[0]).k === 'attr' ? unparen(args[0]).name : unparen(args[0]).k === 'name' ? unparen(args[0]).id : '');
      if (!raw) fail('Unknown sound');
      const snd = /^[A-Z0-9_]+$/.test(raw) ? raw.toLowerCase().replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase()) : raw;
      return blk('iq_sounds_play_sound', { fields: [field('SOUND', snd)] });
    }
    if (method === 'program_stop') return blk('iq_control_stop_project');
    if (/^button/i.test(c[1] || '') && ['pressed', 'released'].includes(method)) return eventHat(c, method, args[0], s);
    fail(`${c.join('.')}() has no block`);
  }

  function deviceStmt(d, c, method, args, kwargs, ctx) {
    const N = d.name;
    if (c.length > 2) fail(`"${c.join('.')}" has no block`);
    // speed given inside the command -> separate "set velocity" block first
    const velBlock = (vel, which) => {
      note('The speed in this command was moved into its own "set velocity" block just before it.');
      if (which === 'drive') return blk('iq_drivetrain_set_drive_velocity', { fields: [field('UNITS', 'pct')], values: [numInput('VELOCITY', vel, ctx)] });
      if (which === 'turn') return blk('iq_drivetrain_set_turn_velocity', { fields: [field('UNITS', 'pct')], values: [numInput('VELOCITY', vel, ctx)] });
      return blk('iq_motion_set_motor_velocity', { fields: [field('MOTOR', N), field('UNITS', 'pct')], values: [numInput('VELOCITY', vel, ctx)] });
    };
    const withVel = (b, vel, which) => vel ? [velBlock(vel, which), b] : b;
    const simpleVel = () => {
      // spin(dir, vel, units) / drive(dir, vel, units)
      if (args.length === 1) return null;
      if (args.length > 3) fail('Too many inputs for this command');
      if (args[2] && pick(VEL_UNITS, args[2], 'velocity unit') !== 'pct') fail('Speeds must be in percent to become blocks');
      return args[1];
    };
    const stopMode = (which) => {
      if (!args.length) return null;
      note('The stopping mode in this command was moved into its own "set stopping" block just before it.');
      const mode = pick(STOP_MODES, args[0], 'stopping mode');
      return which === 'drive' ? blk('iq_drivetrain_set_drive_stopping', { fields: [field('MODE', mode)] })
        : blk('iq_motion_set_motor_stopping', { fields: [field('MOTOR', N), field('MODE', mode)] });
    };
    switch (d.kind) {
      case 'drivetrain':
        switch (method) {
          case 'drive': {
            const v = simpleVel();
            return withVel(blk('iq_drivetrain_drive', { fields: [field('DIRECTION', pick(DIRS, args[0], 'direction'))] }), v, 'drive');
          }
          case 'drive_for': {
            const m = motionArgs(args, kwargs, DIRS, DIST_UNITS, 'distance unit');
            return withVel(blk('iq_drivetrain_drive_for', { fields: [field('DIRECTION', m.dir || 'fwd'), field('UNITS', m.units || 'mm'), waitField(m.wait)], values: [numInput('AMOUNT', m.amount, ctx)] }), m.vel, 'drive');
          }
          case 'turn': {
            const v = simpleVel();
            return withVel(blk('iq_drivetrain_turn', { fields: [field('TURNDIRECTION', pick(TURNS, args[0], 'turn direction'))] }), v, 'turn');
          }
          case 'turn_for': {
            const m = motionArgs(args, kwargs, TURNS, ROT_UNITS, 'angle unit');
            if (m.units && m.units !== 'deg') fail('Turns are measured in degrees in blocks');
            return withVel(blk('iq_drivetrain_turn_for', { fields: [field('TURNDIRECTION', m.dir || 'right'), waitField(m.wait)], values: [numInput('AMOUNT', m.amount, ctx)] }), m.vel, 'turn');
          }
          case 'turn_to_heading': {
            const m = motionArgs(args, kwargs, null, ROT_UNITS, 'angle unit');
            return withVel(blk('iq_drivetrain_turn_to_heading', { fields: [waitField(m.wait)], values: [numInput('HEADING', m.amount, ctx)] }), m.vel, 'turn');
          }
          case 'stop': { const sm = stopMode('drive'); const b = blk('iq_motion_stop_driving'); return sm ? [sm, b] : b; }
          case 'set_drive_velocity': case 'set_turn_velocity': {
            const units = args[1] ? pick(VEL_UNITS, args[1], 'velocity unit') : 'pct';
            if (units !== 'pct') fail('Drivetrain velocity must be in percent in blocks');
            return blk(method === 'set_drive_velocity' ? 'iq_drivetrain_set_drive_velocity' : 'iq_drivetrain_set_turn_velocity', { fields: [field('UNITS', 'pct')], values: [numInput('VELOCITY', args[0], ctx)] });
          }
          case 'set_stopping': return blk('iq_drivetrain_set_drive_stopping', { fields: [field('MODE', pick(STOP_MODES, args[0], 'stopping mode'))] });
        }
        break;
      case 'motor': case 'motorgroup':
        switch (method) {
          case 'spin': {
            const v = simpleVel();
            return withVel(blk('iq_motion_spin', { fields: [field('MOTOR', N), field('DIRECTION', pick(DIRS, args[0], 'direction'))] }), v, 'motor');
          }
          case 'spin_for': {
            const m = motionArgs(args, kwargs, DIRS, ROT_UNITS, 'rotation unit');
            return withVel(blk('iq_motion_spin_for', { fields: [field('MOTOR', N), field('DIRECTION', m.dir || 'fwd'), field('UNITS', m.units || 'deg'), waitField(m.wait)], values: [numInput('AMOUNT', m.amount, ctx)] }), m.vel, 'motor');
          }
          case 'spin_to_position': {
            const m = motionArgs(args, kwargs, null, ROT_UNITS, 'rotation unit');
            return withVel(blk('iq_motion_spin_to_position', { fields: [field('MOTOR', N), field('UNITS', m.units || 'deg'), waitField(m.wait)], values: [numInput('AMOUNT', m.amount, ctx)] }), m.vel, 'motor');
          }
          case 'stop': { const sm = stopMode('motor'); const b = blk('iq_motion_stop_motor', { fields: [field('MOTOR', N)] }); return sm ? [sm, b] : b; }
          case 'set_velocity': {
            const units = args[1] ? pick(VEL_UNITS, args[1], 'velocity unit') : 'pct';
            if (units !== 'pct') fail('Motor velocity must be in percent in blocks');
            return blk('iq_motion_set_motor_velocity', { fields: [field('MOTOR', N), field('UNITS', 'pct')], values: [numInput('VELOCITY', args[0], ctx)] });
          }
          case 'set_stopping': return blk('iq_motion_set_motor_stopping', { fields: [field('MOTOR', N), field('MODE', pick(STOP_MODES, args[0], 'stopping mode'))] });
          case 'set_max_torque': {
            if (args[1] && enumOf(args[1]) !== 'percent') fail('Motor torque must be in percent in blocks');
            return blk('iq_motion_set_motor_torque', { fields: [field('MOTOR', N)], values: [numInput('TORQUE', args[0], ctx)] });
          }
          case 'set_position': case 'reset_position': {
            const a = method === 'reset_position' ? [{ k: 'num', v: 0 }, { k: 'name', id: 'degrees' }] : args;
            const units = a[1] ? pick(ROT_UNITS, a[1], 'rotation unit') : 'deg';
            if (units !== 'deg') fail('Motor position can only be set in degrees in blocks');
            return blk('iq_motion_set_motor_position', { fields: [field('MOTOR', N), field('UNITS', 'deg')], values: [numInput('DEGS', a[0], ctx)] });
          }
          case 'set_timeout': {
            const u = args[1] ? enumOf(args[1]) : 'seconds';
            const v = ['msec'].includes(u) ? { k: 'bin', op: '/', l: args[0], r: { k: 'num', v: 1000 } } : args[0];
            if (!['seconds', 'msec', 'sec'].includes(u)) fail('Unknown time unit');
            return blk('iq_motion_set_motor_timeout', { fields: [field('MOTOR', N)], values: [numInput('TIMEOUT', unparen(v).k === 'bin' && unparen(args[0]).k === 'num' ? { k: 'num', v: unparen(args[0]).v / 1000 } : v, ctx)] });
          }
        }
        break;
      case 'pneumatic':
        switch (method) {
          case 'extend': case 'retract': {
            const cyl = enumOf(args[0]);
            if (!cyl || !/^cylinder[1-4]$/.test(cyl)) fail('Unknown cylinder (use CYLINDER1 or CYLINDER2)');
            return blk('iq_motion_pneumatics_cylinder', { fields: [field('PNEUMATIC', N), field('CYLINDER', cyl), field('STATE', method)] });
          }
          case 'pump_on': case 'pump_off':
            return blk('iq_motion_pneumatics_compressor', { fields: [field('PNEUMATIC', N), field('STATE', method === 'pump_on' ? 'on' : 'off')] });
          case 'pump': {
            const v = unparen(args[0]);
            if (!v || v.k !== 'bool') fail('pump() needs True or False');
            return blk('iq_motion_pneumatics_compressor', { fields: [field('PNEUMATIC', N), field('STATE', v.v ? 'on' : 'off')] });
          }
        }
        break;
      case 'touchled':
        switch (method) {
          case 'set_color': {
            let col = enumOf(args[0]);
            if (col === 'transparent' || col === 'black') col = 'none';
            if (!col || !COLORS.includes(col)) fail('Only the standard color names can become a block');
            return blk('iq_looks_set_touchled_color', { fields: [field('TOUCHLED', N)], values: [val('COLOR', blk('iq_looks_colorlist', { shadow: true, fields: [field('COLOR', col)] }))] });
          }
          case 'set_brightness': return blk('iq_looks_set_touchled_brightness', { fields: [field('TOUCHLED', N)], values: [numInput('VALUE', args[0], ctx, 'math_whole_number')] });
        }
        break;
      case 'optical':
        switch (method) {
          case 'set_light': {
            const st = enumOf(args[0]);
            if (!['on', 'off'].includes(st)) fail('set_light needs ON or OFF');
            return blk('iq_sensing_optical_set_light', { fields: [field('OPTICAL', N), field('OPTION', st)] });
          }
          case 'set_light_power': return blk('iq_sensing_optical_set_light_power', { fields: [field('OPTICAL', N)], values: [numInput('POWER', args[0], ctx)] });
        }
        break;
      case 'gyro': case 'inertial':
        switch (method) {
          case 'calibrate': {
            if (d.kind === 'inertial') return blk('iq_sensing_inertial_calibrate');
            const t = args[0] ? enumOf(args[0]) : 'normal';
            return blk('iq_sensing_calibrate_gyro', { fields: [field('GYRO', N), field('setting', ['extended', 'accurate'].includes(t) ? 'accurate' : 'quick')] });
          }
          case 'set_rotation': return blk('iq_sensing_set_gyro_rotation', { fields: [field('GYRO', N)], values: [numInput('VALUE', args[0], ctx)] });
        }
        break;
    }
    fail(`${c.join('.')}() has no block`);
  }

  function callReporter(e, ctx) {
    const { c, method, args } = normCall(e);
    const root = c[0].toLowerCase();
    const mkBool = (b) => { b.__bool = true; return b; };
    if (c.length === 1) {
      if (['abs', 'fabs'].includes(root)) return blk('iq_operator_function', { fields: [field('OPERATOR', 'abs')], values: [numInput('NUM', args[0], ctx)] });
      if (['round'].includes(root) && args.length === 1) return blk('iq_operator_round', { values: [numInput('NUM', args[0], ctx)] });
      if (['int', 'float', 'double'].includes(root) && args.length === 1) return numExpr(args[0], ctx);
      if (root === 'mathrandomint' || root === 'randint') return blk('iq_operator_random', { values: [numInput('FROM', args[0], ctx), numInput('TO', args[1], ctx)] });
      if (funcs.has(c[0])) fail('Functions that return a value have no block in VEXcode IQ');
      fail(`"${c[0]}()" has no block`);
    }
    if ((root === 'math' || root === 'std') && ['fabs', 'abs'].includes(method)) return blk('iq_operator_function', { fields: [field('OPERATOR', 'abs')], values: [numInput('NUM', args[0], ctx)] });
    if (['urandom', 'random'].includes(root) && method === 'randint') return blk('iq_operator_random', { values: [numInput('FROM', args[0], ctx), numInput('TO', args[1], ctx)] });
    if (root === 'brain') {
      if ((c[1] || '').toLowerCase() === 'timer' && ['time', 'value'].includes(method)) {
        const u = args[0] ? enumOf(args[0]) : 'seconds';
        const t = blk('iq_sensing_timer_value');
        if (u === 'msec') return blk('iq_operator_multiply', { values: [val('NUM1', shadowNum('math_number', 0), t), val('NUM2', shadowNum('math_number', 1000))] });
        if (u !== 'seconds') fail('Unknown time unit');
        return t;
      }
      fail(`${c.join('.')}() has no block`);
    }
    const d = deviceFor(c, method);
    const N = d.name;
    if (d.kind === 'controller') {
      const part = c[1] || '';
      if (/^button/i.test(part) && method === 'pressing') {
        const btn = 'Button' + part.replace(/^button/i, '');
        if (!/^Button(LUp|LDown|RUp|RDown|EUp|EDown|FUp|FDown|L3|R3)$/.test(btn)) fail(`Unknown controller button ${part}`);
        return mkBool(blk('iq_sensing_pressing_controller', { fields: [field('BUTTON', btn)] }));
      }
      if (/^axis[A-D]$/i.test(part) && method === 'position') return blk('iq_sensing_position_of_controller', { fields: [field('AXIS', 'Axis' + part.slice(-1).toUpperCase())] });
      fail(`${c.join('.')}() has no block`);
    }
    if (c.length > 2) fail(`${c.join('.')}() has no block`);
    switch (d.kind) {
      case 'motor': case 'motorgroup':
        if (method === 'position') return blk('iq_sensing_position_of_motor', { fields: [field('MOTOR', N), field('UNITS', args[0] ? pick(ROT_UNITS, args[0], 'rotation unit') : 'deg')] });
        if (method === 'velocity') return blk('iq_sensing_velocity_of_motor', { fields: [field('MOTOR', N), field('UNITS', args[0] ? pick(VEL_UNITS, args[0], 'velocity unit') : 'pct')] });
        if (method === 'is_spinning') return mkBool(blk('iq_sensing_motor_is_spinning', { fields: [field('MOTOR', N)] }));
        break;
      case 'drivetrain':
        if (method === 'velocity') return blk('iq_sensing_drive_velocity', { fields: [field('UNITS', args[0] ? pick(VEL_UNITS, args[0], 'velocity unit') : 'pct')] });
        break;
      case 'bumper':
        if (method === 'pressing') return mkBool(blk('iq_sensing_pressing_bumper', { fields: [field('BUMPER', N)] }));
        break;
      case 'touchled':
        if (method === 'pressing') return mkBool(blk('iq_sensing_pressing_touchled', { fields: [field('TOUCHLED', N)] }));
        break;
      case 'distance':
        if (method === 'object_distance') return blk('iq_sensing_distance_object_distance', { fields: [field('DISTANCE', N), field('UNITS', args[0] ? pick(DIST_UNITS, args[0], 'distance unit') : 'mm')] });
        if (method === 'is_object_detected' || method === 'found_object') return mkBool(blk('iq_sensing_distance_found_object', { fields: [field('DISTANCE', N)] }));
        break;
      case 'sonar':
        if (method === 'distance' || method === 'object_distance') return blk('iq_sensing_distance_from', { fields: [field('SONAR', N), field('UNITS', args[0] ? pick(DIST_UNITS, args[0], 'distance unit') : 'mm')] });
        break;
      case 'color':
        if (method === 'is_near_object') return mkBool(blk('iq_sensing_object_is_near', { fields: [field('COLORSENSOR', N)] }));
        break;
      case 'gyro': case 'inertial':
        if (method === 'rotation') return blk('iq_sensing_rotation_of_gyro', { fields: [field('GYRO', N)] });
        break;
    }
    fail(`${c.join('.')}() has no block`);
  }

  // ---------------------------------------------------------------- hats / procedures
  function funcByRef(ref) {
    const c = chainOf(ref);
    if (!c || c.length !== 1) fail('Event handlers must be plain function names');
    const f = funcs.get(c[0]);
    if (!f) fail(`Function "${c[0]}" was not found`);
    if (f.params.length) fail('Event handlers with inputs have no block');
    return f;
  }

  function threadHat(ref, s) {
    const f = funcByRef(ref);
    usedAsEvent.add(f.name);
    const hat = blk('iq_events_when_started');
    eventStacks.push({ hat, f });
    return null;
  }

  function eventHat(c, method, ref, s) {
    const f = funcByRef(ref);
    const root = c[0];
    let hat;
    if (root.toLowerCase() === 'brain') {
      const b = (c[1] || '').replace(/^button/i, '');
      hat = blk('iq_events_when_brain_button', { fields: [field('BUTTON', b.charAt(0).toUpperCase() + b.slice(1)), field('EVENTTYPE', method)] });
    } else {
      const d = deviceFor(c, method);
      const part = c[1] || '';
      if (d.kind === 'controller') {
        if (/^axis[A-D]$/i.test(part) && method === 'changed') hat = blk('iq_events_when_controller_axis', { fields: [field('AXIS', 'Axis' + part.slice(-1).toUpperCase())] });
        else if (/^button/i.test(part) && method !== 'changed') {
          const btn = 'Button' + part.replace(/^button/i, '');
          hat = blk('iq_events_when_controller_button', { fields: [field('BUTTON', btn), field('EVENTTYPE', method)] });
        }
      } else if (c.length === 2 && d.kind === 'bumper' && method !== 'changed') hat = blk('iq_events_when_bumper', { fields: [field('BUMPER', d.name), field('EVENTTYPE', method)] });
      else if (c.length === 2 && d.kind === 'touchled' && method !== 'changed') hat = blk('iq_events_when_touchled', { fields: [field('TOUCHLED', d.name), field('EVENTTYPE', method)] });
    }
    if (!hat) fail(`"${c.join('.')}.${method}" has no event block`);
    usedAsEvent.add(f.name);
    eventStacks.push({ hat, f });
    return null;
  }

  function procCall(f, args, ctx) {
    const pr = ensureProc(f);
    if (args.length > pr.params.length) fail('Too many inputs for this function');
    const values = pr.params.map((p, i) => {
      let a = args[i] ?? p.def;
      if (!a) fail(`Missing input "${p.name}"`);
      a = unparen(a);
      if (p.type === 'b' || (a.k === 'bool')) {
        if (a.k === 'bool' && p.type !== 'b') p.type = 'b';
        const sh = blk('procedure_bool_input', { shadow: true, fields: [field('BOOLVALUE', a.k === 'bool' ? String(a.v) : 'false')] });
        return val(p.id, sh, a.k === 'bool' ? null : boolExpr(a, ctx));
      }
      return Object.assign(numInput(p.id, a, ctx), { name: p.id });
    });
    const b = blk('procedures_call', { mutation: { proccode: '', proceduredefid: pr.defId, argumentids: JSON.stringify(pr.params.map(p => p.id)), warp: 'false' }, values });
    b.__proc = pr; // proccode is finalised after all calls are seen (param types may change)
    return b;
  }

  // ---------------------------------------------------------------- assemble
  const mainCtx = { isEntry: true };
  // pull out "entry" functions called from the main code: main(), when_started1(), whenStarted1()
  const entryRe = /^(main|when_?started\d*|whenstarted\d*)$/i;
  const mainStmts = [];
  const extraEntries = [];
  const isEntryCall = (s) => {
    const e = s && s.k === 'expr' ? unparen(s.e) : null;
    const c = e && e.k === 'call' ? chainOf(e.fn) : null;
    return !!(c && c.length === 1 && entryRe.test(c[0]) && funcs.has(c[0]));
  };
  const isThreadStmt = (s) => s && ((s.k === 'decl' && /task|thread/.test(s.type)) || (s.k === 'assign' && ctorOf(s.value) && /^(thread|task)$/i.test(ctorOf(s.value).name)));
  main = main.filter((s, i) => {
    if (s.k === 'expr' && isWaitCall(s.e)) {
      const a = unparen(s.e).args || [];
      const tiny = a[0] && unparen(a[0]).k === 'num' && unparen(a[0]).v === 15 && a[1] && enumOf(a[1]) === 'msec';
      let j = i + 1;
      while (main[j] && main[j].k === 'comment') j++;
      if (tiny && (isEntryCall(main[j]) || isThreadStmt(main[j]))) return false;
    }
    return true;
  });
  for (const s of main) {
    const e = s.k === 'expr' ? unparen(s.e) : null;
    const c = e && e.k === 'call' ? chainOf(e.fn) : null;
    if (c && c.length === 1 && entryRe.test(c[0]) && funcs.has(c[0]) && !funcs.get(c[0]).params.length && !e.args.length) {
      extraEntries.push(funcs.get(c[0]));
      usedAsEvent.add(c[0]);
      continue;
    }
    mainStmts.push(s);
  }
  // global C++ variable initial values go first
  const globalInits = globalDecls.filter(g => g.value).map(g => ({ k: 'assign', target: { k: 'name', id: g.name }, op: '=', value: g.value, line: g.line }));
  const firstBody = convertBody([...globalInits, ...mainStmts], mainCtx);
  const entryBodies = extraEntries.map(f => convertBody(f.body, { isEntry: true }));

  const onlyComments = firstBody.every(b => b.type === 'iq_other_comment');
  if ((firstBody.length && !(onlyComments && (entryBodies.length || eventStacks.length))) || (!entryBodies.length && !eventStacks.length)) stacks.push([blk('iq_events_when_started'), ...firstBody]);
  entryBodies.forEach(b => stacks.push([blk('iq_events_when_started'), ...b]));
  // event hats (bodies converted now so their issues are listed in order)
  for (let i = 0; i < eventStacks.length; i++) {
    const { hat, f } = eventStacks[i];
    stacks.push([hat, ...convertBody(f.body, { isEntry: true })]);
  }
  // procedures: every user function not used as an event/entry
  const procOrder = [];
  const doneProcs = new Set();
  const emitProc = (f) => {
    if (doneProcs.has(f.name)) return;
    doneProcs.add(f.name);
    const pr = ensureProc(f);
    const params = new Map(pr.params.map(p => [p.name, p]));
    const body = convertBody(f.body, { params, proc: pr, isProc: true });
    procOrder.push({ pr, body });
  };
  for (const f of funcs.values()) if (!usedAsEvent.has(f.name) || procs.has(f.name)) emitProc(f);
  // procedures referenced only from other procedures created later
  for (const f of funcs.values()) if (procs.has(f.name)) emitProc(f);

  for (const { pr, body } of procOrder) {
    pr.proccode = [pr.f.name, ...pr.params.map(p => `%${p.type}`)].join(' ');
    const protoValues = pr.params.map(p => val(p.id, blk(p.type === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_number', {
      shadow: true, mutation: { funcname: pr.funcname, argumentid: p.id, proceduredefid: pr.defId }, fields: [field('VALUE', p.name)]
    })));
    const proto = blk('procedures_prototype', {
      shadow: true,
      mutation: {
        proccode: pr.proccode, proceduredefid: pr.defId,
        argumentids: JSON.stringify(pr.params.map(p => p.id)),
        argumentnames: JSON.stringify(pr.params.map(p => p.name)),
        argumentdefaults: JSON.stringify(pr.params.map(() => 'todo')),
        argumenttypes: JSON.stringify(pr.params.map(p => p.type)),
        warp: 'false'
      },
      values: protoValues
    });
    stacks.push([blk('procedures_definition', { statements: [stmt('custom_block', [proto])] }), ...body]);
  }
  // finalise call blocks' proccode now that param types are known
  const fixCalls = (arr) => {
    for (const b of arr) {
      if (b.__proc) b.mutation.proccode = b.__proc.proccode || [b.__proc.f.name, ...b.__proc.params.map(p => `%${p.type}`)].join(' ');
      for (const v of b.values) if (v.block) fixCalls([v.block]);
      for (const st of b.statements) fixCalls(st.blocks);
    }
  };
  stacks.forEach(fixCalls);

  // variables actually referenced
  const variables = [...varTypes.entries()].map(([name, type]) => ({ name, type }));
  for (const ev of events) variables.push({ name: ev, type: 'broadcast_msg' });
  issues.sort((a, b) => a.line - b.line);
  const blockCount = stacks.reduce((n, s) => n + countBlocks(s), 0);
  return { ok: true, issues, notes: [...devices.notes.map(msg => ({ line: 0, text: '', msg })), ...notes], stacks, variables, robotConfig: devices.robotConfig(), gen, lang, blockCount };
}

function usesAsCondition(s, name) {
  const isN = (e) => { e = unparen(e); return e && e.k === 'name' && e.id === name; };
  const check = (e) => { e = unparen(e); if (!e) return false; if (isN(e)) return true; if (e.k === 'not') return check(e.e); if (e.k === 'logic') return check(e.l) || check(e.r); return false; };
  if (s.k === 'if') return s.branches.some(b => check(b.cond) || b.body.some(x => usesAsCondition(x, name))) || (s.orelse || []).some(x => usesAsCondition(x, name));
  if (s.k === 'while') return check(s.cond) || s.body.some(x => usesAsCondition(x, name));
  if (s.k === 'for') return s.body.some(x => usesAsCondition(x, name));
  return false;
}

export function makeProjectFile(result) {
  return buildProject({ stacks: result.stacks, variables: result.variables, robotConfig: result.robotConfig, gen: result.gen });
}
