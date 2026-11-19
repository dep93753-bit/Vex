// Block tree helpers + VEXcode IQ workspace XML / project file writer.

const ID_SOUP = '!#$%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MUT_NS = 'http://www.w3.org/1999/xhtml';

let rng = Math.random;
export function setRandom(fn) { rng = fn; }
export function genId() {
  let s = '';
  for (let i = 0; i < 20; i++) s += ID_SOUP[Math.floor(rng() * ID_SOUP.length)];
  return s;
}

// ---- block constructors ----
export function blk(type, { fields = [], values = [], statements = [], mutation = null, shadow = false } = {}) {
  return { type, fields, values, statements, mutation, shadow };
}
export function field(name, value, attrs) { return { name, value: String(value), attrs: attrs || null }; }
export function val(name, shadow, block) { return { name, shadow: shadow || null, block: block || null }; }
export function stmt(name, blocks) { return { name, blocks: blocks || [] }; }

export const shadowNum = (type, n) => blk(type, { shadow: true, fields: [field('NUM', fmtNum(n))] });
export const shadowText = (t) => blk('text', { shadow: true, fields: [field('TEXT', t)] });

export function fmtNum(n) {
  if (typeof n === 'string') return n;
  if (!isFinite(n)) return '0';
  // avoid float noise like 0.30000000000000004
  const r = Math.round(n * 1e9) / 1e9;
  return String(r);
}

// ---- XML writer ----
export function esc(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrs(obj) {
  if (!obj) return '';
  return Object.entries(obj).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
}

function writeInner(b) {
  let s = '';
  if (b.mutation) s += `<mutation xmlns="${MUT_NS}"${attrs(b.mutation)}></mutation>`;
  for (const f of b.fields) s += `<field name="${esc(f.name)}"${attrs(f.attrs)}>${esc(f.value)}</field>`;
  for (const v of b.values) {
    s += `<value name="${esc(v.name)}">`;
    if (v.shadow) s += writeChain([v.shadow], 0);
    if (v.block) s += writeChain([v.block], 0);
    s += '</value>';
  }
  for (const st of b.statements) {
    if (!st.blocks.length) continue;
    s += `<statement name="${esc(st.name)}">${writeChain(st.blocks, 0)}</statement>`;
  }
  return s;
}

export function writeChain(arr, idx, pos) {
  // iterative-ish: build from the end so long scripts don't blow the stack
  let tail = '';
  for (let i = arr.length - 1; i >= idx; i--) {
    const b = arr[i];
    const tag = b.shadow ? 'shadow' : 'block';
    const p = i === idx && pos ? ` x="${pos.x}" y="${pos.y}"` : '';
    const inner = writeInner(b) + (tail ? `<next>${tail}</next>` : '');
    tail = `<${tag} type="${esc(b.type)}" id="${esc(genId())}"${p}>${inner}</${tag}>`;
  }
  return tail;
}

export function countBlocks(arr) {
  let n = 0;
  for (const b of arr) {
    if (!b.shadow) n++;
    for (const v of b.values) if (v.block) n += countBlocks([v.block]);
    for (const st of b.statements) n += countBlocks(st.blocks);
  }
  return n;
}

function stackHeight(arr) {
  // rough on-screen height estimate in workspace units
  let h = 0;
  for (const b of arr) {
    h += 56;
    for (const st of b.statements) h += Math.max(stackHeight(st.blocks), 40) + 30;
  }
  return h;
}

export function buildWorkspaceXml(stacks, variables) {
  let s = '<xml xmlns="https://developers.google.com/blockly/xml"><variables>';
  for (const v of variables) {
    const t = v.type && v.type !== 'number' ? ` type="${esc(v.type)}"` : '';
    s += `<variable${t} id="${esc(genId())}">${esc(v.name)}</variable>`;
  }
  s += '</variables>';
  let y = 0;
  const x = 0;
  for (const st of stacks) {
    s += writeChain(st, 0, { x, y });
    y += stackHeight(st) + 80;
  }
  s += '</xml>';
  return s;
}

export function buildProject({ stacks, variables, robotConfig, gen }) {
  return {
    mode: 'Blocks',
    hardwareTarget: 'brain',
    workspace: buildWorkspaceXml(stacks, variables),
    robotConfig,
    slot: 0,
    platform: 'IQ',
    sdkVersion: '20230818.11.00.00',
    appVersion: '4.68.1',
    fileFormat: '2.0.0',
    targetBrainGen: gen === 'First' ? 'First' : 'Second',
    v5SoundsEnabled: false,
    downloadLanguage: 'python',
    virtualSkillsYear: '2023'
  };
}
