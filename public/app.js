// 화면과 상태 — DOM과 화면 상태는 여기에만 둬요. 판정은 다시 계산하지 않고 에이전트 결과를 그대로 보여줘요
import { buildBundle, mapExcluded, findJudgement, parseAreas, groupFolders, fileMime, bundleFileName, orderFolderRefs, MAX_BUNDLE_BYTES, DECISIONS } from './core.js';
import { listDepts, registerRef, removeRef, loadRefs } from './refs.js';
import { buildReport } from './report.js';
import { runCase, pollCase, describeError } from './run.js';
import { STATUS_LABEL, judged, countCases, buildAnswerJson, buildCsv, reportCases, singleReportName, batchReportName } from './export.js';

const MOCK = new URLSearchParams(location.search).get('mock') === '1';
// 목 모드 결과가 실제 결과 목록에 섞이지 않게 저장 키를 나눠요
const CASES_KEY = MOCK ? 'jolup.mock.cases' : 'jolup.cases';
const ROUND_KEY = 'jolup.round';
const TYPE_LABEL = { grad_rule: '시행세칙', curriculum: '교육과정표', subst_table: '대체과목 인정표' };
const DECISION_CLASS = { '졸업 가능': 'd-ok', '확인 필요': 'd-warn', '졸업 요건 부족': 'd-bad' };
const MSG_TYPE = 'PDF, JPG, PNG만 올릴 수 있어요';
// 왼쪽 메뉴와 위쪽 탭이 함께 쓰는 화면 목록. id는 index.html의 data-view와 같아요
const VIEWS = [
  { id: 'refs', label: '기준문서', group: '사정 준비' },
  { id: 'upload', label: '서류 올리기', group: '사정 준비' },
  { id: 'list', label: '사정 목록', group: '사정 결과' },
  { id: 'export', label: '내보내기', group: '사정 결과' },
];

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
const put = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter(Boolean)); };
const coded = (code, message) => Object.assign(new Error(message), { code });
const missingMessage = (types) => `이 학과의 ${types.map((t) => TYPE_LABEL[t]).join(', ')}를 먼저 등록해주세요`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR') : '-');

// ───── 상태 ─────
const state = {
  round: '',
  view: 'upload',
  allViews: false,
  cases: [],
  selectedId: null,
  previewPage: 1,
  filter: { decision: '', status: '' },
  exportScope: 'all',
  manifest: {},
  depts: [],
  extraDepts: [], // 문서를 아직 등록하지 않은 새 학과
  openDept: null,
  tab: 'single',
  single: { dept: '', files: [], studentId: '', bundled: false, rejected: [] },
  folder: emptyFolder(),
};
function emptyFolder() {
  return { groups: [], skipped: [], excluded: new Set(), error: '', busy: false };
}

// 메모리에만 두는 것: 묶음 PDF 바이트, 원본 파일, Blob 주소, 판정 근거 불러오는 상태
const bundles = new Map(); // caseId → Uint8Array
const sources = new Map(); // caseId → { items: [{ name, type, file }], refs: [{ name, file }] }
const blobUrls = new Map(); // caseId → blob: 주소
const evidence = new Map(); // caseId → { loading, message }

const findCase = (id) => state.cases.find((c) => c.id === id);
const selected = () => findCase(state.selectedId);

let noticeTimer;
function notify(message) {
  const el = $('notice');
  el.textContent = message;
  el.hidden = false;
  $('status-msg').textContent = message; // 알림이 사라져도 맨 아래 줄에 남아요
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ───── 틀: 왼쪽 메뉴, 위쪽 탭, 맨 아래 줄 ─────
const shell = { tabs: new Map(), links: new Map(), groups: new Map() };
const defaultView = () => (state.cases.length ? 'list' : 'upload');

function showView(id) {
  state.view = id;
  state.allViews = false;
  document.body.classList.toggle('nav-toggled', document.body.classList.contains('nav-toggled') && !window.matchMedia('(max-width: 900px)').matches); // 좁은 화면에서는 고르면 메뉴를 닫아요
  updateShell();
  $('main').scrollTop = 0;
}

function updateShell() {
  const current = VIEWS.find((v) => v.id === state.view);
  const index = VIEWS.indexOf(current);
  for (const v of VIEWS) {
    const on = !state.allViews && v.id === state.view;
    const tab = shell.tabs.get(v.id);
    tab.setAttribute('aria-selected', String(on));
    tab.textContent = v.id === 'list' && state.cases.length ? `${v.label} (${state.cases.length})` : v.label;
    shell.links.get(v.id).toggleAttribute('aria-current', on);
    if (on) shell.links.get(v.id).setAttribute('aria-current', 'page');
  }
  for (const [name, group] of shell.groups) {
    const on = !state.allViews && name === current.group;
    group.classList.toggle('current', on);
    if (on) group.open = true;
  }
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.dataset.view === state.view));
  document.body.classList.toggle('all-views', state.allViews);
  $('view-tabs').setAttribute('aria-pressed', String(!state.allViews));
  $('view-all').setAttribute('aria-pressed', String(state.allViews));
  $('view-prev').disabled = !state.allViews && index === 0;
  $('view-next').disabled = !state.allViews && index === VIEWS.length - 1;
  $('crumb').textContent = state.allViews ? '졸업사정 > 전체보기' : `졸업사정 > ${current.group} > ${current.label}`;
}

function buildShell() {
  const link = (v) => {
    const el = h('button', { class: 'menu-link', type: 'button', onclick: () => showView(v.id) }, v.label);
    shell.links.set(v.id, el);
    return h('li', {}, el);
  };
  put($('doc-tabs'), VIEWS.map((v) => {
    const el = h('button', { class: 'doc-tab', type: 'button', role: 'tab', onclick: () => showView(v.id) }, v.label);
    shell.tabs.set(v.id, el);
    return el;
  }));
  put($('menu'), [...new Set(VIEWS.map((v) => v.group))].map((name) => {
    const el = h('details', { class: 'menu-group', open: true }, h('summary', {}, name), h('ul', {}, VIEWS.filter((v) => v.group === name).map(link)));
    shell.groups.set(name, el);
    return el;
  }));
  const step = (by) => showView(VIEWS[Math.min(VIEWS.length - 1, Math.max(0, VIEWS.findIndex((v) => v.id === state.view) + by))].id);
  $('view-prev').addEventListener('click', () => step(state.allViews ? 0 : -1));
  $('view-next').addEventListener('click', () => step(state.allViews ? 0 : 1));
  $('view-tabs').addEventListener('click', () => showView(state.view));
  $('view-all').addEventListener('click', () => { state.allViews = true; updateShell(); });
  $('home').addEventListener('click', () => showView(defaultView()));
  $('nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-toggled'));
  $('run-mode').textContent = MOCK ? '목 모드' : '실제 호출';
  state.view = defaultView();
  updateShell();
}

function persist() {
  try {
    localStorage.setItem(CASES_KEY, JSON.stringify(state.cases));
  } catch {
    notify('이 브라우저의 저장 공간이 부족해요. 지금 결과를 내보내고 안 쓰는 사정 건을 지워주세요');
  }
}

// 사정 건을 고쳐 저장하고 화면에 반영해요. 미리보기는 건드리지 않아요(iframe을 다시 그리면 보던 쪽을 잃어요)
function patchCase(id, patch) {
  const c = findCase(id);
  if (!c) return null;
  Object.assign(c, patch);
  persist();
  renderList();
  renderCounts();
  if (id === state.selectedId) renderDetail();
  return c;
}
const save = (c, patch) => patchCase(c.id, patch);

function clearBundle(id) {
  const url = blobUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(id);
  bundles.delete(id);
}

// ───── B 기준문서 (PF-01) ─────
async function refreshDepts() {
  const listed = await listDepts(state.manifest);
  const names = new Set(listed.map((d) => d.dept));
  state.extraDepts = state.extraDepts.filter((d) => !names.has(d));
  state.depts = [...listed, ...state.extraDepts.map((dept) => ({ dept, docs: [], missing: Object.keys(TYPE_LABEL), ready: false }))]
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'));
  renderRefs();
  renderUpload();
}

// 기준문서가 바뀌면 그 학과를 쓰는 건의 묶음을 다시 만들어요(검증실패 → 접수, 또는 그 반대)
async function rebuildDeptCases(dept) {
  for (const c of state.cases) {
    if (c.refsFrom === 'dept' && c.dept === dept && ['RECEIVED', 'INVALID'].includes(c.status) && sources.has(c.id)) await buildCase(c);
  }
}

function docChip(d, dept) {
  const label = `${TYPE_LABEL[d.type]}${d.year ? ` ${d.year}` : ''}`;
  if (d.source !== 'registered') return h('span', { class: 'doc', title: d.url }, label);
  return h('span', { class: 'doc registered', title: `등록한 문서: ${d.name}` }, `${label} (등록)`,
    h('button', { type: 'button', 'aria-label': `${dept} ${label} 등록 문서 지우기`, onclick: async () => {
      await removeRef(d.key);
      await refreshDepts();
      await rebuildDeptCases(dept);
      notify(`${label} 등록 문서를 지웠어요`);
    } }, '지우기'));
}

function registerForm(d) {
  const firstMissing = d.missing[0] || 'grad_rule';
  const type = h('select', { 'aria-label': '종류', onchange: () => { yearField.hidden = type.value !== 'curriculum'; } },
    Object.entries(TYPE_LABEL).map(([v, label]) => h('option', { value: v, selected: v === firstMissing }, label)));
  const year = h('input', { type: 'text', inputMode: 'numeric', maxLength: 4, placeholder: '2023', 'aria-label': '교육과정 연도' });
  const yearField = h('label', { class: 'field', hidden: firstMissing !== 'curriculum' }, h('span', {}, '교육과정 연도'), year);
  const file = h('input', { type: 'file', accept: '.pdf', 'aria-label': '기준문서 PDF' });
  const error = h('p', { class: 'error-text', hidden: true });
  const fail = (message) => { error.textContent = message; error.hidden = false; };
  return h('form', { class: 'register', onsubmit: async (e) => {
    e.preventDefault();
    error.hidden = true;
    const f = file.files[0];
    if (!f) return fail('PDF 파일을 골라주세요');
    if (fileMime(f.name) !== 'application/pdf') return fail('기준문서는 PDF만 올릴 수 있어요');
    if (type.value === 'curriculum' && !/^\d{4}$/.test(year.value.trim())) return fail('교육과정 연도를 네 자리 숫자로 적어주세요');
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      await window.PDFLib.PDFDocument.load(bytes);
    } catch {
      return fail(`${f.name}을(를) 열 수 없어요. 암호가 걸렸거나 깨진 파일이에요`);
    }
    await registerRef(d.dept, type.value, year.value.trim(), f.name.normalize('NFC'), bytes);
    await refreshDepts();
    await rebuildDeptCases(d.dept);
    notify(`${d.dept}에 ${TYPE_LABEL[type.value]}를 등록했어요`);
  } },
  h('div', { class: 'row' },
    h('label', { class: 'field' }, h('span', {}, '종류'), type),
    yearField,
    h('label', { class: 'field grow' }, h('span', {}, 'PDF'), file),
    h('button', { class: 'btn primary', type: 'submit' }, '등록')),
  error,
  h('p', { class: 'hint' }, '이 브라우저에만 저장돼요. 같은 학과·종류·연도의 내장 문서보다 우선하고, 지우면 내장 문서로 돌아가요.'));
}

function renderRefs() {
  const rows = state.depts.flatMap((d) => {
    const open = state.openDept === d.dept;
    return [
      h('tr', { 'data-dept': d.dept },
        h('th', { scope: 'row' }, d.dept),
        h('td', {}, h('div', { class: 'docs' }, d.docs.map((doc) => docChip(doc, d.dept)))),
        h('td', {}, d.ready
          ? h('span', { class: 'tag ok' }, '준비됨')
          : h('span', { class: 'tag warn' }, `빠짐: ${d.missing.map((t) => TYPE_LABEL[t]).join(', ')}`)),
        h('td', { class: 'num' }, h('button', { class: 'btn small', type: 'button', 'aria-expanded': String(open), onclick: () => {
          state.openDept = open ? null : d.dept;
          renderRefs();
        } }, open ? '닫기' : '등록'))),
      open && h('tr', {}, h('td', { colSpan: 4 }, registerForm(d))),
    ];
  });
  const name = h('input', { type: 'text', placeholder: '시행세칙 제목의 공식 명칭', 'aria-label': '새 학과명' });
  const error = h('p', { class: 'error-text', hidden: true });
  put($('refs'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '학과'), h('th', {}, '문서'), h('th', {}, '상태'), h('th', {}, ''))),
      h('tbody', {}, rows))),
    h('form', { class: 'add-dept', onsubmit: (e) => {
      e.preventDefault();
      const dept = name.value.trim().normalize('NFC');
      if (!dept) return;
      if (state.depts.some((d) => d.dept === dept)) {
        error.textContent = '이미 있는 학과예요';
        error.hidden = false;
        return;
      }
      state.extraDepts.push(dept);
      state.openDept = dept;
      refreshDepts();
    } },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', {}, '새 학과 추가'), name), h('button', { class: 'btn', type: 'submit' }, '추가')),
    error,
    h('p', { class: 'hint' }, '학과명은 시행세칙 제목과 한 글자도 다르지 않게 적어요. 에이전트가 성적표 학과명과 정확히 일치로 잇기 때문이에요.')));
}

// ───── C 올리기 (PF-02, PF-03) ─────
function dropzone({ directory, multiple, title, onFiles, onDropTransfer }) {
  const input = h('input', { type: 'file', class: 'sr-only', multiple, webkitdirectory: directory, accept: directory ? null : '.pdf,.jpg,.jpeg,.png', 'aria-label': title,
    onchange: () => { onFiles([...input.files]); input.value = ''; } });
  const zone = h('label', { class: 'dropzone',
    ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    ondragleave: () => zone.classList.remove('over'),
    ondrop: async (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (onDropTransfer) onDropTransfer(await filesFromDrop(e.dataTransfer));
      else onFiles([...e.dataTransfer.files]);
    } }, input, h('strong', {}, title), h('div', { class: 'hint' }, directory ? '여기로 끌어다 놓아도 돼요' : '여기로 끌어다 놓아도 돼요. PDF, JPG, PNG'));
  return zone;
}

// 끌어다 놓은 폴더를 파일 목록으로 펴요. webkitRelativePath를 폴더 선택 때와 같은 모양으로 맞춰요
async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean); // await 전에 받아 둬야 해요
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
      out.push(file);
      return;
    }
    const reader = entry.createReader();
    for (;;) { // readEntries는 한 번에 일부만 돌려줘요
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) return;
      for (const e of batch) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const deptOptions = (value, placeholder) => [
  h('option', { value: '', selected: !value }, placeholder),
  state.depts.map((d) => h('option', { value: d.dept, selected: d.dept === value }, d.ready ? d.dept : `${d.dept} (기준문서 빠짐)`)),
];

function singleTab() {
  const s = state.single;
  const info = state.depts.find((d) => d.dept === s.dept);
  const addFiles = (files) => {
    for (const f of files) (fileMime(f.name) ? s.files : s.rejected).push(f);
    renderUpload();
  };
  const canAdd = s.files.length > 0 && (s.bundled || s.dept);
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, h('span', {}, '학과'),
        h('select', { disabled: s.bundled, onchange: (e) => { s.dept = e.target.value; renderUpload(); } }, deptOptions(s.dept, '학과를 골라주세요'))),
      h('label', { class: 'field grow' }, h('span', {}, '학번(선택)'),
        h('input', { type: 'text', inputMode: 'numeric', value: s.studentId, placeholder: '10자리', oninput: (e) => { s.studentId = e.target.value.trim(); } }))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: s.bundled, onchange: (e) => { s.bundled = e.target.checked; renderUpload(); } }),
      '기준문서가 이미 들어 있음'),
    s.bundled && h('p', { class: 'hint' }, '학과 기준문서를 붙이지 않아요. 이미 묶인 파일에 켜요. 켜지 않으면 기준문서가 두 번 들어가서 매칭이 틀어져요.'),
    !s.bundled && info && !info.ready && h('p', { class: 'error-text' }, missingMessage(info.missing)),
    dropzone({ multiple: true, title: '학생 1명의 파일 고르기', onFiles: addFiles }),
    s.rejected.length > 0 && h('p', { class: 'error-text' }, `${MSG_TYPE}: ${s.rejected.map((f) => f.name).join(', ')}`),
    s.files.length > 0 && h('ul', { class: 'file-list' }, s.files.map((f, i) => h('li', {}, h('span', {}, `${i + 1}. ${f.name}`),
      h('button', { class: 'btn small', type: 'button', onclick: () => { s.files.splice(i, 1); renderUpload(); } }, '빼기')))),
    h('div', { class: 'row center' },
      h('button', { class: 'btn primary', type: 'button', disabled: !canAdd, onclick: addSingleCase }, '목록에 추가'),
      !canAdd && h('span', { class: 'hint' }, s.bundled || s.dept ? '파일을 올려주세요' : '학과를 고르고 파일을 올려주세요')));
}

const MSG_FOLDER = '학과/학번_이름 폴더 아래에 파일을 두고, 학과 폴더나 그 위 폴더를 골라주세요';

// 학생 폴더에 기준문서가 없으면 경로의 학과에 3종이 다 등록돼 있어야 해요
const folderRefsReady = (g) => g.refs.length > 0 || !!state.depts.find((d) => d.dept === g.dept)?.ready;
const groupRunnable = (g) => !state.folder.excluded.has(g.key) && g.items.length > 0 && folderRefsReady(g);

function refsSource(g) {
  if (g.refs.length) return `폴더의 기준문서 ${g.refs.length}개`;
  const info = state.depts.find((d) => d.dept === g.dept);
  if (info?.ready) return '학과 기준문서';
  return h('div', { class: 'error-text' }, info ? missingMessage(info.missing) : '등록되지 않은 학과예요. 폴더 이름을 확인하거나 기준문서에서 학과를 추가해주세요');
}

function folderTab() {
  const f = state.folder;
  const choose = (files) => {
    const { groups, skipped } = groupFolders(files);
    state.folder = { ...emptyFolder(), groups, skipped, error: groups.length ? '' : MSG_FOLDER };
    renderUpload();
  };
  const runnable = f.groups.filter(groupRunnable);
  const rows = f.groups.map((g) => {
    const out = f.excluded.has(g.key);
    return h('tr', { class: out ? 'excluded' : null, 'data-folder': g.key },
      h('td', {}, h('input', { type: 'checkbox', checked: !out, 'aria-label': `${g.dept} ${g.folder} 포함`, onchange: (e) => {
        if (e.target.checked) f.excluded.delete(g.key); else f.excluded.add(g.key);
        renderUpload();
      } })),
      h('td', {}, g.dept),
      h('td', { class: 'mono nowrap' }, g.inputStudentId),
      h('th', { scope: 'row' }, g.inputName),
      h('td', { class: 'num' }, g.items.length, g.items.length === 0 && h('div', { class: 'error-text' }, '학생 서류가 없어요')),
      h('td', {}, refsSource(g)),
      h('td', {}, g.skipped.length ? g.skipped.join(', ') : '-'));
  });
  return h('div', { class: 'stack' },
    h('p', { class: 'hint' }, '폴더를 학과/학번_이름/파일 모양으로 두면 경로에서 학과, 학번(10자리), 이름을 읽어요. 학과 폴더 이름은 시행세칙 제목의 학과명과 한 글자도 다르지 않아야 해요.'),
    dropzone({ directory: true, title: '학과 폴더나 그 위 폴더 고르기', onFiles: choose, onDropTransfer: choose }),
    f.error && h('p', { class: 'error-text' }, f.error),
    f.groups.length > 0 && h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '포함'), h('th', {}, '학과'), h('th', {}, '학번'), h('th', {}, '이름'), h('th', { class: 'num' }, '학생 파일'), h('th', {}, '기준문서 출처'), h('th', {}, '건너뛴 파일'))),
      h('tbody', {}, rows))),
    f.skipped.length > 0 && h('p', { class: f.groups.length ? 'hint' : 'error-text' }, `학과/학번_이름 폴더 밖이라 건너뛴 파일: ${f.skipped.join(', ')}`),
    f.groups.length > 0 && h('div', { class: 'row center' },
      h('button', { class: 'btn primary', type: 'button', disabled: !runnable.length || f.busy, onclick: runFolderCases }, f.busy ? '묶는 중…' : `전부 실행 (${runnable.length}건)`),
      h('span', { class: 'hint' }, `기준문서나 학생 서류가 없는 폴더는 실행하지 않아요. ${f.groups.length}개 폴더 중 ${runnable.length}개를 실행해요.`)));
}

function renderUpload() {
  const tab = (id, label) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.tab === id), onclick: () => { state.tab = id; renderUpload(); } }, label);
  put($('upload'),
    h('div', { class: 'tabs', role: 'tablist' }, tab('single', '개별(1명)'), tab('folder', '폴더 일괄')),
    state.tab === 'single' ? singleTab() : folderTab());
}

// ───── 사정 건 만들기, 묶음 PDF (PF-04) ─────
const nextNumber = () => state.cases.reduce((max, c) => Math.max(max, Number(c.id.slice(2)) || 0), 0) + 1;

function newCase(fields) {
  const n = nextNumber();
  return { id: `c_${String(n).padStart(4, '0')}`, source: 'single', label: '', fileName: bundleFileName(state.round, n), dept: '', refsFrom: 'dept', inputStudentId: '', inputName: '',
    pageMap: [], status: 'RECEIVED', fileId: null, jobId: null, startedAt: null, finishedAt: null, result: null, areas: null, areasRaw: null, errors: [], warnings: [], error: null, errorCode: null, raw: null, checked: false, memo: '', ...fields };
}

const toItem = (file) => ({ name: file.name.normalize('NFC'), type: fileMime(file.name), file });
const readItem = async (it) => ({ ...it, bytes: new Uint8Array(await it.file.arrayBuffer()) });

// sources의 파일로 묶음 PDF를 만들어요. 결과가 있는 건은 결과를 지우지 않아요(새로고침 뒤 미리보기를 되살릴 때)
async function buildCase(c) {
  const keepResult = ['REVIEW', 'FAILED'].includes(c.status);
  try {
    const src = sources.get(c.id);
    if (!src?.items.length) throw coded('E-NO-FILES', '파일을 다시 올려주세요');
    let refs = [];
    if (c.refsFrom === 'dept') refs = await loadRefs(c.dept, state.manifest);
    if (c.refsFrom === 'folder') refs = await Promise.all(orderFolderRefs(src.refs).map(readItem));
    const items = await Promise.all(src.items.map(readItem));
    const bundle = await buildBundle(window.PDFLib, items, refs, c.fileName);
    if (bundle.bytes.length > MAX_BUNDLE_BYTES) throw coded('E-UPLOAD-SIZE', '20MB까지 올릴 수 있어요');
    clearBundle(c.id);
    bundles.set(c.id, bundle.bytes);
    patchCase(c.id, keepResult ? { pageMap: bundle.pageMap } : { pageMap: bundle.pageMap, status: 'RECEIVED', error: null, errorCode: null, errors: [] });
    if (c.id === state.selectedId) renderPreview();
    return true;
  } catch (e) {
    const error = e.code === 'E-REF-MISSING' ? missingMessage(e.missing) : e.message;
    if (keepResult) notify(error);
    else {
      clearBundle(c.id);
      patchCase(c.id, { status: 'INVALID', errorCode: e.code || 'E-FILE-UNREADABLE', error });
      if (c.id === state.selectedId) renderPreview();
    }
    return false;
  }
}

async function addSingleCase() {
  const s = state.single;
  const items = s.files.map(toItem);
  const first = items[0].name;
  const c = newCase({
    source: 'single',
    label: items.length > 1 ? `${first} 외 ${items.length - 1}개` : first,
    dept: s.bundled ? '' : s.dept,
    refsFrom: s.bundled ? 'bundled' : 'dept',
    inputStudentId: s.studentId,
    ...(s.bundled ? { fileName: first } : {}), // 이미 묶인 파일은 원래 이름, 학과 기준문서를 붙이면 회차코드_번호
  });
  state.cases.push(c);
  sources.set(c.id, { items, refs: [] });
  Object.assign(s, { files: [], rejected: [], studentId: '' });
  renderUpload();
  await buildCase(c);
  showView('list'); // 실행 단추가 목록에 있어요
  notify(c.status === 'INVALID' ? `추가했지만 실행할 수 없어요: ${c.error}` : `${c.label}을(를) 목록에 추가했어요`);
}

async function runFolderCases() {
  const f = state.folder;
  f.busy = true;
  renderUpload();
  const groups = f.groups.filter(groupRunnable);
  let started = 0;
  for (const g of groups) {
    const c = newCase({ source: 'folder', label: g.folder, dept: g.dept, refsFrom: g.refs.length ? 'folder' : 'dept', inputStudentId: g.inputStudentId, inputName: g.inputName });
    state.cases.push(c);
    sources.set(c.id, { items: g.items.map(toItem), refs: g.refs.map((file) => ({ name: file.name.normalize('NFC'), file })) });
    if (await buildCase(c)) { startCase(c.id); started++; }
  }
  state.folder = emptyFolder();
  renderUpload();
  showView('list');
  notify(`${groups.length}건을 만들어 ${started}건을 실행해요${groups.length > started ? `. ${groups.length - started}건은 검증실패예요` : ''}`);
}

// ───── 실행 (PF-05, PF-10) ─────
// 건마다 따로 돌아요. 기다리지 않고 바로 올려 실행하고, 각자 폴링해요
async function execute(id, resume = false) {
  const c = findCase(id);
  if (!c) return;
  try {
    if (resume) await pollCase(c, save);
    else await runCase({ ...c, name: c.fileName, bytes: bundles.get(id) }, save);
  } catch (e) {
    patchCase(id, { status: 'FAILED', finishedAt: new Date().toISOString(), ...describeError(e) });
  }
}

const canRun = (c) => ['RECEIVED', 'REVIEW', 'FAILED'].includes(c.status) && bundles.has(c.id);
const runLabel = (c) => (['REVIEW', 'FAILED'].includes(c.status) ? '재실행' : '실행');

function startCase(id) {
  const c = findCase(id);
  if (!c || !canRun(c)) return;
  patchCase(id, { status: 'RUNNING', fileId: null, jobId: null, startedAt: new Date().toISOString(), finishedAt: null, result: null, areas: null, areasRaw: null, errors: [], warnings: [], error: null, errorCode: null, raw: null, checked: false });
  evidence.delete(id);
  execute(id);
}

function rerun(c) {
  if (c.status === 'REVIEW' && !window.confirm('지금 결과를 지우고 다시 실행할까요? 확인함 표시도 풀려요')) return;
  startCase(c.id);
}

// 페이지를 다시 열었을 때: job id가 있는 건은 이어서 확인, 나머지는 파일을 다시 올려야 해요
function restoreCases() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(CASES_KEY)) || []; } catch { saved = []; }
  state.cases = saved;
  for (const c of state.cases) {
    if (c.status === 'RUNNING' && c.jobId) continue;
    if (c.status === 'RUNNING' || c.status === 'QUEUED') { // QUEUED는 큐가 있던 때 저장된 건이에요
      if (c.fileId) fetch(`/api/files/${c.fileId}`, { method: 'DELETE' }).catch(() => {}); // 실행 전에 끊겼으니 올린 파일을 지워요
      Object.assign(c, { status: 'RECEIVED', fileId: null, startedAt: null });
    }
  }
  persist();
}

// ───── D 목록 (PF-07) ─────
const allWarnings = (c) => [...(c.warnings || []),
  ...mapExcluded(c.result?.excluded_files, c.pageMap || []).filter((x) => x.warning).map((x) => `${x.file_name}: ${x.warning}`)];

function visibleCases() {
  const { decision, status } = state.filter;
  return state.cases.filter((c) => (!decision || c.result?.decision === decision) && (!status || c.status === status));
}

function decisionChip(c) {
  const d = c.result?.decision;
  return d ? h('span', { class: `decision ${DECISION_CLASS[d] || ''}` }, d) : h('span', { class: 'hint' }, '-');
}

function statusTag(c) {
  const cls = { REVIEW: 'ok', FAILED: 'bad', INVALID: 'bad', RUNNING: 'active' }[c.status] || '';
  return h('span', { class: `tag ${cls}` }, STATUS_LABEL[c.status] ?? c.status);
}

function selectCase(id) {
  state.selectedId = id;
  state.previewPage = 1;
  renderList();
  renderDetail();
  renderPreview();
}

function renderList() {
  const rows = visibleCases().map((c) => {
    const warnings = allWarnings(c);
    const needFiles = !bundles.has(c.id) && c.status === 'RECEIVED';
    const showRun = ['RECEIVED', 'INVALID', 'FAILED'].includes(c.status);
    return h('tr', { class: c.id === state.selectedId ? 'selected' : null, 'data-case': c.id, onclick: () => selectCase(c.id) },
      h('th', { scope: 'row' }, h('button', { class: 'link', type: 'button', onclick: (e) => { e.stopPropagation(); selectCase(c.id); } }, c.label)),
      h('td', { class: 'mono nowrap' }, c.result?.student_id || c.inputStudentId || '-'),
      h('td', {}, c.result?.applicant_name || c.inputName || '-'),
      h('td', {}, c.dept || '-'),
      h('td', {}, decisionChip(c)),
      h('td', {}, statusTag(c)),
      h('td', {}, warnings.length ? h('span', { class: 'warn-count', title: warnings.join('\n') }, `경고 ${warnings.length}`) : ''),
      h('td', {}, c.checked && h('span', { class: 'checked-mark', title: '담당자 확인함', 'aria-label': '담당자 확인함' }, '✓')),
      h('td', { class: 'num' }, showRun && h('button', { class: 'btn small', type: 'button', disabled: !canRun(c), title: needFiles ? '파일을 다시 올려주세요' : c.status === 'INVALID' ? c.error : null,
        onclick: (e) => { e.stopPropagation(); startCase(c.id); } }, runLabel(c))));
  });
  const waiting = state.cases.filter((c) => c.status === 'RECEIVED' && bundles.has(c.id));
  updateShell(); // 탭의 건수를 맞춰요
  const runAll = $('run-all');
  if (runAll) {
    runAll.disabled = waiting.length === 0;
    runAll.textContent = `전부 실행 (${waiting.length}건)`;
  }
  const reset = $('reset-list');
  if (reset) {
    const running = state.cases.some((c) => c.status === 'RUNNING');
    reset.disabled = state.cases.length === 0 || running;
    reset.title = running ? '실행 중인 건이 끝나면 초기화할 수 있어요' : '';
  }
  put($('list'), state.cases.length === 0
    ? h('p', { class: 'empty' }, '아직 사정 건이 없어요. 서류 올리기에서 파일이나 폴더를 올려주세요.')
    : rows.length === 0
      ? h('p', { class: 'empty' }, '거른 조건에 맞는 사정 건이 없어요.')
      : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['파일·폴더', '학번', '성명', '학과', '판정', '상태', '경고', '확인', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows))));
}

function buildListTools() {
  const filter = (label, key, options) => h('label', { class: 'check' }, h('span', { class: 'hint' }, label),
    h('select', { 'aria-label': `${label}으로 거르기`, onchange: (e) => { state.filter[key] = e.target.value; renderList(); } },
      h('option', { value: '' }, '전체'), options.map(([v, t]) => h('option', { value: v }, t))));
  put($('list-tools'),
    filter('판정', 'decision', DECISIONS.map((d) => [d, d])),
    filter('상태', 'status', Object.entries(STATUS_LABEL)),
    h('button', { id: 'run-all', class: 'btn primary', type: 'button', onclick: () => {
      state.cases.filter((c) => c.status === 'RECEIVED' && bundles.has(c.id)).forEach((c) => startCase(c.id));
    } }, '전부 실행'),
    h('button', { id: 'reset-list', class: 'btn danger', type: 'button', onclick: resetList }, '목록 초기화'));
}

// 실행 중인 건이 있으면 버튼이 꺼져 있어요. 올린 파일과 job을 추적하지 못하게 되기 때문이에요
function resetList() {
  if (!window.confirm(`사정 건 ${state.cases.length}건을 모두 지울까요? 결과와 메모도 함께 지워지고 되돌릴 수 없어요. 내보내지 않은 결과는 먼저 내보내주세요`)) return;
  for (const c of state.cases) {
    clearBundle(c.id);
    sources.delete(c.id);
    evidence.delete(c.id);
  }
  state.cases = [];
  persist();
  selectCase(null);
  renderCounts();
}

// ───── E 상세 (PF-07~09, PF-11) ─────
async function loadEvidence(c) {
  evidence.set(c.id, { loading: true });
  renderDetail();
  try {
    const r = await fetch(`/api/runs/${c.jobId}/steps`);
    if (r.status === 404) throw coded('gone', '근거를 더는 받을 수 없어요');
    if (!r.ok) throw coded('fail', describeError({ status: r.status }).error);
    const text = findJudgement(await r.json());
    if (!text) throw coded('gone', '근거를 더는 받을 수 없어요');
    evidence.delete(c.id);
    const areas = parseAreas(text);
    patchCase(c.id, { areas, areasRaw: areas ? null : text }); // 표 형식이 안 맞으면 원문 그대로
  } catch (e) {
    evidence.set(c.id, { message: e.code ? e.message : describeError(e).error });
    if (c.id === state.selectedId) renderDetail();
  }
}

function evidenceBlock(c) {
  const ev = evidence.get(c.id);
  if (c.areas?.length) {
    return h('div', {}, h('h3', {}, '판정 근거(영역별 결과)'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '영역'), h('th', {}, '이수/기준'), h('th', {}, '결과'), h('th', {}, '이유'))),
      h('tbody', {}, c.areas.map((a) => h('tr', {}, h('th', { scope: 'row' }, a.area), h('td', { class: 'mono' }, a.value), h('td', { class: 'nowrap' }, a.result), h('td', {}, a.note)))))));
  }
  if (c.areasRaw) return h('div', {}, h('h3', {}, '판정 근거(원문)'), h('pre', {}, c.areasRaw));
  if (!c.jobId || c.status !== 'REVIEW') return null;
  return h('div', { class: 'row center' },
    h('button', { class: 'btn', type: 'button', disabled: ev?.loading, onclick: () => loadEvidence(c) }, ev?.loading ? '받는 중…' : '판정 근거 보기'),
    ev?.message && h('span', { class: 'error-text' }, ev.message));
}

// 파일을 다시 올리거나 더해요. 학생 폴더의 기준문서를 쓰는 건은 폴더째로 받아요
async function replaceFiles(c, files) {
  const accepted = files.filter((f) => fileMime(f.name));
  const rejected = files.filter((f) => !fileMime(f.name));
  if (rejected.length) notify(`${MSG_TYPE}: ${rejected.map((f) => f.name).join(', ')}`);
  if (!accepted.length) return;
  const src = sources.get(c.id) || { items: [], refs: [] };
  if (c.refsFrom === 'folder' && accepted[0].webkitRelativePath) {
    const inRefs = (f) => f.webkitRelativePath.normalize('NFC').split('/').includes('기준문서');
    src.items = accepted.filter((f) => !inRefs(f)).map(toItem);
    src.refs = accepted.filter(inRefs).map((f) => ({ name: f.name.normalize('NFC'), file: f }));
  } else {
    src.items.push(...accepted.map(toItem));
  }
  sources.set(c.id, src);
  const hadResult = ['REVIEW', 'FAILED'].includes(c.status);
  const ok = await buildCase(c);
  if (ok && hadResult) notify('묶음 PDF를 새로 만들었어요. 파일이 바뀌었다면 재실행해야 결과에 반영돼요');
}

function filesBlock(c) {
  if (c.status === 'RUNNING') return null;
  const src = sources.get(c.id);
  const asFolder = c.refsFrom === 'folder' && !src;
  const input = h('input', { type: 'file', class: 'sr-only', multiple: true, webkitdirectory: asFolder, accept: asFolder ? null : '.pdf,.jpg,.jpeg,.png', 'aria-label': '파일 올리기',
    onchange: () => { const files = [...input.files]; input.value = ''; replaceFiles(c, files); } });
  const label = !src ? (asFolder ? '학생 폴더 다시 올리기' : '파일 다시 올리기') : '파일 더하기';
  return h('div', {},
    h('h3', {}, '파일'),
    src && h('ul', { class: 'file-list' }, src.items.map((it, i) => h('li', {}, h('span', {}, it.name),
      h('button', { class: 'btn small', type: 'button', disabled: src.items.length < 2, onclick: async () => {
        src.items.splice(i, 1);
        await buildCase(c);
      } }, '빼기')))),
    h('label', { class: 'btn small', style: 'display:inline-block;margin-top:4px' }, input, label));
}

function resultBlock(c) {
  const r = c.result;
  if (!r) return null;
  const excluded = mapExcluded(r.excluded_files, c.pageMap || []);
  return [
    h('div', {}, h('h3', {}, '이유'), h('p', {}, r.reason)),
    h('div', {}, h('h3', {}, '빠진 서류'), r.missing_documents.length ? h('ul', { class: 'plain-list' }, r.missing_documents.map((d) => h('li', {}, d))) : h('p', {}, '없음')),
    h('div', {}, h('h3', {}, '제외 파일'), excluded.length
      ? h('ul', { class: 'plain-list' }, excluded.map((x) => h('li', {},
        x.page
          ? h('button', { class: 'link', type: 'button', onclick: () => goToPage(x.page) }, `${x.sourceFile} ${x.sourcePage}쪽`)
          : x.file_name,
        ` (${x.category})`,
        x.warning && h('span', { class: 'error-text' }, ` ${x.warning}`))))
      : h('p', {}, '없음')),
  ];
}

function renderDetail() {
  const section = $('detail-section');
  const c = selected();
  section.hidden = !c;
  $('workspace').classList.toggle('has-detail', !!c);
  if (!c) return;
  const d = c.result?.decision;
  const warnings = allWarnings(c);
  // 메모를 쓰는 중에 폴링으로 다시 그려져도 입력을 잃지 않게, 입력값은 바로 사정 건에 적어요
  put($('detail'),
    h('div', { class: 'detail-head' },
      h('div', {}, h('h2', {}, c.label), h('div', { class: 'hint' }, statusTag(c), ' ', c.id)),
      h('button', { class: 'btn small', type: 'button', onclick: () => selectCase(null) }, '닫기')),
    d && h('div', { class: `band ${DECISION_CLASS[d] || ''}` }, `판정  ${d}`),
    c.error && h('div', { class: 'alert' }, c.error,
      c.errors?.length > 0 && h('ul', {}, c.errors.map((e) => h('li', {}, e))),
      c.raw && h('details', {}, h('summary', {}, '원문 보기'), h('pre', {}, c.raw))),
    warnings.length > 0 && h('div', { class: 'alert warning' }, '경고', h('ul', {}, warnings.map((w) => h('li', {}, w)))),
    h('dl', { class: 'kv' },
      h('dt', {}, '학번'), h('dd', { class: 'mono' }, c.result?.student_id || c.inputStudentId || '-'),
      h('dt', {}, '성명'), h('dd', {}, c.result?.applicant_name || '-'),
      h('dt', {}, '학과'), h('dd', {}, c.dept || '(묶음 PDF)'),
      h('dt', {}, '보낸 파일'), h('dd', {}, c.fileName),
      h('dt', {}, '기준문서'), h('dd', {}, { dept: '학과 기준문서', folder: '학생 폴더의 기준문서', bundled: '이미 묶인 파일' }[c.refsFrom]),
      c.jobId && [h('dt', {}, '실행 ID'), h('dd', { class: 'mono' }, c.jobId)],
      c.finishedAt && [h('dt', {}, '완료 시각'), h('dd', {}, fmtTime(c.finishedAt))]),
    resultBlock(c),
    evidenceBlock(c),
    c.status === 'REVIEW' && h('div', { class: 'confirm' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: c.checked, onchange: (e) => patchCase(c.id, { checked: e.target.checked }) }),
        '확인함'),
      h('label', { class: 'field stacked' }, h('span', {}, '메모(선택). 판정은 바뀌지 않고 이 브라우저에만 저장돼요'),
        h('textarea', { value: c.memo, oninput: (e) => { c.memo = e.target.value; persist(); } }))),
    filesBlock(c),
    h('div', { class: 'actions' },
      ['RECEIVED', 'INVALID'].includes(c.status) && h('button', { class: 'btn primary', type: 'button', disabled: !canRun(c), onclick: () => startCase(c.id) }, '실행'),
      ['REVIEW', 'FAILED'].includes(c.status) && h('button', { class: 'btn', type: 'button', disabled: !canRun(c), title: canRun(c) ? null : '파일을 다시 올려주세요', onclick: () => rerun(c) }, '재실행'),
      c.status === 'REVIEW' && h('button', { class: 'btn primary', type: 'button', onclick: (e) => exportSingle(c, e.currentTarget) }, 'PDF로 내보내기'),
      c.status !== 'RUNNING' && h('button', { class: 'btn danger', type: 'button', onclick: () => {
        if (!window.confirm(`${c.label} 사정 건을 지울까요?`)) return;
        clearBundle(c.id);
        sources.delete(c.id);
        evidence.delete(c.id);
        state.cases =state.cases.filter((x) => x.id !== c.id);
        persist();
        selectCase(null);
        renderCounts();
      } }, '지우기')));
}

function goToPage(n) {
  state.previewPage = n;
  renderPreview();
  if (bundles.has(state.selectedId)) $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPreview() {
  const c = selected();
  if (!c) { put($('preview')); return; }
  const bytes = bundles.get(c.id);
  if (!bytes) {
    put($('preview'), h('h3', {}, '묶음 PDF 미리보기'), h('p', { class: 'preview-empty' }, c.pageMap?.length ? '파일을 다시 올리면 볼 수 있어요' : '묶음 PDF가 아직 없어요'));
    return;
  }
  if (!blobUrls.has(c.id)) blobUrls.set(c.id, URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })));
  // 주소의 #page만 바꾸면 PDF 뷰어가 움직이지 않을 때가 있어서 iframe을 새로 만들어요
  put($('preview'),
    h('div', { class: 'row center' }, h('h3', { style: 'margin:0' }, '묶음 PDF 미리보기'),
      h('select', { 'aria-label': '쪽 지도', style: 'width:auto;max-width:100%', onchange: (e) => goToPage(Number(e.target.value)) },
        c.pageMap.map((p) => h('option', { value: p.page, selected: p.page === state.previewPage }, `${p.page}쪽 · ${p.fileName} ${p.sourcePage}쪽${p.source === 'reference' ? ' (기준문서)' : ''}`)))),
    h('iframe', { src: `${blobUrls.get(c.id)}#page=${state.previewPage}`, title: `묶음 PDF ${state.previewPage}쪽` }));
}

// ───── F 건수, 내보내기 (PF-11~13) ─────
function renderCounts() {
  const counts = { ...countCases(state.cases), 전체: state.cases.length };
  document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = `${counts[el.dataset.count]}건`; });
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let fontsPromise = null; // 처음 내보낼 때 한 번 받아서 다시 써요
function loadFonts() {
  fontsPromise ??= Promise.all(['Regular', 'Bold'].map(async (w) => {
    const r = await fetch(`fonts/NotoSansKR-${w}.otf`);
    if (!r.ok) throw new Error('글꼴 없음');
    return new Uint8Array(await r.arrayBuffer());
  })).then(([regular, bold]) => ({ regular, bold })).catch((e) => { fontsPromise = null; throw e; });
  return fontsPromise;
}

async function makeReport(cases) {
  let fonts;
  try {
    fonts = await loadFonts();
  } catch {
    throw coded('E-REPORT-FONT', '글꼴을 불러오지 못해 PDF를 만들 수 없어요');
  }
  const round = MOCK ? `목 모드 예시 ${state.round}`.trim() : state.round;
  return buildReport(window.PDFLib, window.fontkit, fonts, reportCases(cases), { round });
}

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '만드는 중…';
  try {
    await fn();
  } catch (e) {
    notify(e.code ? e.message : `내보내지 못했어요: ${e.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const exportSingle = (c, button) => withBusy(button, async () => {
  download(singleReportName(c), await makeReport([c]), 'application/pdf');
});

function exportScopeCases() {
  return state.exportScope === 'filtered' ? visibleCases() : state.cases;
}

function buildExports() {
  const pdf = h('button', { class: 'btn primary', type: 'button', onclick: () => withBusy(pdf, async () => {
    const scope = exportScopeCases();
    const done = judged(scope);
    if (!done.length) { notify('판정이 끝난 건이 없어요'); return; }
    download(batchReportName(state.round, done.length), await makeReport(done), 'application/pdf');
    notify(scope.length > done.length ? `${done.length}건을 내보냈어요. 판정이 끝나지 않은 ${scope.length - done.length}건은 뺐어요` : `${done.length}건을 내보냈어요`);
  }) }, '결과 PDF');
  const json = h('button', { class: 'btn', type: 'button', onclick: () => {
    const scope = exportScopeCases();
    const done = judged(scope);
    if (!done.length) { notify('판정이 끝난 건이 없어요'); return; }
    const task = MOCK ? `목 모드 예시 ${state.round}`.trim() : state.round;
    download(`사정결과_${done.length}건.json`, `${JSON.stringify(buildAnswerJson(scope, { round: task }), null, 2)}\n`, 'application/json');
    if (scope.length > done.length) notify(`판정이 끝나지 않은 ${scope.length - done.length}건은 뺐어요`);
  } }, 'JSON');
  const csv = h('button', { class: 'btn', type: 'button', onclick: () => {
    const scope = exportScopeCases();
    if (!scope.length) { notify('내보낼 사정 건이 없어요'); return; }
    download(`사정결과_${scope.length}건.csv`, buildCsv(scope), 'text/csv;charset=utf-8');
  } }, 'CSV');
  put($('exports'),
    h('label', { class: 'check' }, h('span', { class: 'hint' }, '범위'),
      h('select', { 'aria-label': '내보낼 범위', onchange: (e) => { state.exportScope = e.target.value; } },
        h('option', { value: 'all' }, '전체'), h('option', { value: 'filtered' }, '지금 거른 목록'))),
    pdf, json, csv);
}

// ───── 시작 ─────
async function init() {
  $('mock-band').hidden = !MOCK;
  if (MOCK) {
    const { createMockFetch } = await import('./mock.js');
    const answers = await (await fetch('mock/answers.json')).json();
    window.fetch = createMockFetch(window.fetch.bind(window), { answers, storage: localStorage });
  }

  try { state.round = localStorage.getItem(ROUND_KEY) || ''; } catch { /* 저장소를 못 쓰면 비워 둬요 */ }
  const round = $('round');
  round.value = state.round;
  round.addEventListener('input', () => {
    state.round = round.value.trim();
    try { localStorage.setItem(ROUND_KEY, state.round); } catch { /* 입력은 이번 화면에서만 써요 */ }
  });

  restoreCases();
  buildShell();
  buildListTools();
  buildExports();
  renderList();
  renderCounts();

  if (!window.PDFLib || !window.fontkit) notify('PDF 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해주세요');
  const r = await fetch('refs/manifest.json');
  state.manifest = r.ok ? await r.json() : {};
  await refreshDepts();

  // 실행중이던 건을 이어서 확인해요
  for (const c of state.cases.filter((x) => x.status === 'RUNNING' && x.jobId)) execute(c.id, true);
}

init().catch((e) => {
  console.error(e);
  notify(`화면을 준비하지 못했어요: ${e.message}`);
});
