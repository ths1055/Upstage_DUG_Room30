// 학과 기준문서 — 기본 내장(refs/manifest.json) + 이 브라우저에서 등록한 문서(IndexedDB)
// 종류: grad_rule(시행세칙, 1개), curriculum(교육과정표, 연도별 1개 이상), subst_table(대체과목 인정표, 1개)
const DB = 'jolup', STORE = 'refs';
const REQUIRED = ['grad_rule', 'curriculum', 'subst_table'];
const ORDER = { grad_rule: 0, curriculum: 1, subst_table: 2 };

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
    t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error);
  });
}

// 등록: 같은 학과·종류·연도면 바꿔 끼워요
export function registerRef(dept, type, year, name, bytes) {
  if (!REQUIRED.includes(type)) throw new Error('종류 오류');
  const key = `${dept}|${type}|${type === 'curriculum' ? year : ''}`;
  return tx('readwrite', (s) => s.put({ key, dept, type, year: type === 'curriculum' ? String(year) : '', name, bytes, at: Date.now() }));
}
export const removeRef = (key) => tx('readwrite', (s) => s.delete(key));
const allRegistered = () => tx('readonly', (s) => s.getAll());

// builtin: manifest.json 내용 { 학과: [{ type, year?, url }] }
export async function listDepts(builtin) {
  const reg = await allRegistered();
  const names = new Set([...Object.keys(builtin), ...reg.map((r) => r.dept)]);
  return [...names].sort((a, b) => a.localeCompare(b, 'ko')).map((dept) => {
    const docs = refsOf(dept, builtin, reg);
    const missing = REQUIRED.filter((t) => !docs.some((d) => d.type === t));
    return { dept, docs, missing, ready: missing.length === 0 };
  });
}
function refsOf(dept, builtin, reg) {
  const byKey = new Map();
  for (const d of builtin[dept] || []) byKey.set(`${d.type}|${d.year || ''}`, { ...d, year: d.year || '', source: 'builtin' });
  for (const r of reg.filter((x) => x.dept === dept)) byKey.set(`${r.type}|${r.year}`, { ...r, source: 'registered' }); // 등록한 문서가 우선
  return [...byKey.values()].sort((a, b) => ORDER[a.type] - ORDER[b.type] || String(a.year).localeCompare(String(b.year)));
}
// 묶음 PDF에 넣을 바이트 목록(시행세칙 → 교육과정표(연도순) → 대체과목 인정표)
export async function loadRefs(dept, builtin) {
  const { docs, missing } = (await listDepts(builtin)).find((d) => d.dept === dept) || { docs: [], missing: REQUIRED };
  if (missing.length) throw Object.assign(new Error(`기준문서 없음: ${missing.join(', ')}`), { code: 'E-REF-MISSING', missing });
  return Promise.all(docs.map(async (d) => ({ name: d.name || d.url.split('/').pop(), bytes: d.bytes ? new Uint8Array(d.bytes) : await fetchBytes(d.url) })));
}
async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`기준문서를 받지 못했어요: ${url}`), { code: 'E-REF-FETCH' });
  return new Uint8Array(await r.arrayBuffer());
}
