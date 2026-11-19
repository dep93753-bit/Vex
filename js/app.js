import { convertCode, readProjectFile, makeProjectFile, detectLanguage, detectGen } from './convert.js';
import { renderPreview } from './preview.js';

const $ = (id) => document.getElementById(id);
const els = {
  tabPaste: $('tab-paste'), tabFile: $('tab-file'), panelPaste: $('panel-paste'), panelFile: $('panel-file'),
  code: $('code'), example: $('example'), file: $('file'), drop: $('drop'), fileName: $('file-name'),
  lang: $('lang'), gen: $('gen'), name: $('name'), comments: $('comments'),
  convert: $('convert'), error: $('error'),
  result: $('result'), summary: $('summary'), leftOut: $('left-out'), notes: $('notes'), notesList: $('notes-list'),
  devicesList: $('devices-list'), preview: $('preview'), download: $('download'),
  dialog: $('issues-dialog'), issuesList: $('issues-list')
};

let mode = 'paste';
let fileInfo = null; // result of readProjectFile for an uploaded file
let lastProject = null;
let lastName = 'MyProject';

const EXAMPLE = `#region VEXcode Generated Robot Configuration
from vex import *

brain = Brain()
brain_inertial = Inertial()
left_drive_smart = Motor(Ports.PORT1, 1.0, False)
right_drive_smart = Motor(Ports.PORT6, 1.0, True)
drivetrain = SmartDrive(left_drive_smart, right_drive_smart, brain_inertial, 200)
claw_motor = Motor(Ports.PORT4, False)
controller = Controller()
#endregion VEXcode Generated Robot Configuration

# Drive a square, then open and close the claw
def open_claw():
    claw_motor.spin_for(REVERSE, 90, DEGREES)

def close_claw():
    claw_motor.spin_for(FORWARD, 90, DEGREES)

def when_controller_e_up():
    open_claw()

drivetrain.set_drive_velocity(50, PERCENT)
brain.screen.print("Starting!")
brain.screen.next_row()

for side in range(4):
    drivetrain.drive_for(FORWARD, 300, MM)
    drivetrain.turn_for(RIGHT, 90, DEGREES)

close_claw()
wait(1, SECONDS)
open_claw()

controller.buttonEUp.pressed(when_controller_e_up)
`;

// ---------- tabs ----------
function setMode(m) {
  mode = m;
  els.tabPaste.setAttribute('aria-selected', String(m === 'paste'));
  els.tabFile.setAttribute('aria-selected', String(m === 'file'));
  els.panelPaste.hidden = m !== 'paste';
  els.panelFile.hidden = m !== 'file';
}
els.tabPaste.addEventListener('click', () => setMode('paste'));
els.tabFile.addEventListener('click', () => setMode('file'));
[els.tabPaste, els.tabFile].forEach(t => t.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const other = t === els.tabPaste ? els.tabFile : els.tabPaste;
    other.focus(); other.click();
  }
}));

els.example.addEventListener('click', () => {
  els.code.value = EXAMPLE;
  if (!els.name.value) els.name.value = 'SquareAndClaw';
});

// ---------- file input ----------
async function takeFile(f) {
  if (!f) return;
  const text = await f.text();
  const info = readProjectFile(text, f.name);
  fileInfo = info;
  els.fileName.textContent = f.name;
  if (info.error) { showError(info.error); return; }
  hideError();
  if (!els.name.value && info.name) els.name.value = info.name;
}
els.file.addEventListener('change', () => takeFile(els.file.files[0]));
['dragenter', 'dragover'].forEach(ev => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); }));
els.drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

// ---------- helpers ----------
function showError(msg) { els.error.textContent = msg; els.error.hidden = false; }
function hideError() { els.error.hidden = true; }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function safeName(s) {
  const n = (s || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');
  return n || 'MyProject';
}

function deviceText(d) {
  const ports = (d.port || []).filter(p => p);
  const label = { Drivetrain: 'Drivetrain', Motor: 'Motor', MotorGroup: 'Motor group', Controller: 'Controller', Bumper: 'Bumper switch', TouchLED: 'Touch LED', Distance: 'Distance sensor', Optical: 'Optical sensor', Color: 'Color sensor', Gyro: 'Gyro sensor', Pneumatic: 'Pneumatics', AIVision: 'AI Vision sensor' }[d.deviceType] || d.deviceType;
  const p = ports.length ? ` — port${ports.length > 1 ? 's' : ''} ${ports.join(', ')}` : '';
  return `<strong>${esc(d.name)}</strong> (${esc(label)})${esc(p)}`;
}

// ---------- convert ----------
function gatherInput() {
  if (mode === 'file') {
    if (!fileInfo) return { error: 'Choose a file first.' };
    if (fileInfo.error) return { error: fileInfo.error };
    return { ...fileInfo };
  }
  const code = els.code.value;
  if (!code.trim()) return { error: 'Paste some code first.' };
  return { code, lang: null, gen: null, robotConfig: null };
}

function askAboutIssues(issues) {
  els.issuesList.innerHTML = issues.map(i => {
    const where = i.line ? `Line ${i.line}${i.endLine && i.endLine > i.line ? `–${i.endLine}` : ''}` : 'Code';
    return `<li><strong>${esc(where)}:</strong> <code>${esc(i.text || '')}</code><span class="why">${esc(i.reason)}</span></li>`;
  }).join('');
  return new Promise((resolve) => {
    els.dialog.returnValue = '';
    els.dialog.addEventListener('close', () => resolve(els.dialog.returnValue === 'continue'), { once: true });
    els.dialog.showModal();
  });
}

els.convert.addEventListener('click', async () => {
  hideError();
  const input = gatherInput();
  if (input.error) { showError(input.error); return; }
  const lang = els.lang.value !== 'auto' ? els.lang.value : (input.lang || detectLanguage(input.code));
  const gen = els.gen.value !== 'auto' ? els.gen.value : (input.gen || detectGen(input.code));

  let result;
  try {
    result = convertCode(input.code, { lang, gen, robotConfig: input.robotConfig, keepComments: els.comments.checked });
  } catch (e) {
    console.error(e);
    showError('Something went wrong while converting: ' + e.message);
    return;
  }
  if (!result.ok) {
    const f = result.issues[0];
    showError(`Your code couldn't be read (line ${f.line}): ${f.reason.replace(/^Could not read the code: /, '')}\nCheck that the language setting is right (${lang === 'py' ? 'Python' : 'C++'}).`);
    els.result.hidden = true;
    return;
  }
  if (result.issues.length) {
    const go = await askAboutIssues(result.issues);
    if (!go) return;
  }
  showResult(result, lang);
});

function showResult(result, lang) {
  lastProject = makeProjectFile(result);
  lastName = safeName(els.name.value);
  const nStacks = result.stacks.length;
  els.summary.textContent = `${result.blockCount} block${result.blockCount === 1 ? '' : 's'} in ${nStacks} script${nStacks === 1 ? '' : 's'} · from ${lang === 'py' ? 'Python' : 'C++'} · ${result.gen === 'First' ? '1st' : '2nd'} generation brain`;

  if (result.issues.length) {
    els.leftOut.hidden = false;
    els.leftOut.innerHTML = `<strong>${result.issues.length} line${result.issues.length === 1 ? ' was' : 's were'} left out</strong> (line${result.issues.length === 1 ? '' : 's'} ${result.issues.map(i => i.line).join(', ')}). Check the project in VEXcode before running it.`;
  } else els.leftOut.hidden = true;

  if (result.notes.length) {
    els.notes.hidden = false;
    els.notesList.innerHTML = result.notes.map(n => `<li>${n.line ? `<strong>Line ${n.line}:</strong> ` : ''}${esc(n.msg)}</li>`).join('');
  } else els.notes.hidden = true;

  const devs = result.robotConfig;
  els.devicesList.innerHTML = devs.length ? devs.map(d => `<li>${deviceText(d)}</li>`).join('') : '<li>No devices</li>';
  els.preview.innerHTML = renderPreview(result.stacks);
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

els.download.addEventListener('click', () => {
  if (!lastProject) return;
  const blob = new Blob([JSON.stringify(lastProject)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = lastName + '.iqblocks';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});
