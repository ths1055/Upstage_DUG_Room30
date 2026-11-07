// 브라우저 핵심 로직 — 묶음 PDF 만들기, 결과 읽기·검증, 제외 파일 쪽 찾기, 판정 근거 찾기
const A4 = [595.28, 841.89];
export const KEYS = ['student_id', 'applicant_name', 'decision', 'reason', 'missing_documents', 'excluded_files'];
export const DECISIONS = ['졸업 가능', '졸업 요건 부족', '확인 필요'];
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

// 확장자로 형식을 정해요. 브라우저의 File.type은 비어 있을 때가 있어요. PDF·JPG·PNG가 아니면 null(E-UPLOAD-TYPE)
export function fileMime(name) {
  const ext = /\.([^.]+)$/.exec(String(name))?.[1].toLowerCase();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext] ?? null;
}

// 학과 기준문서를 붙일 때의 파일 이름. 성명·학번이 들어가지 않아요
export function bundleFileName(round, n) {
  const code = String(round || '').normalize('NFC').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') || 'round';
  return `${code}_${String(n).padStart(3, '0')}.pdf`;
}

// 학생 폴더의 기준문서/를 묶음 순서(시행세칙 → 교육과정표(연도 순) → 대체과목 인정표)로 맞춰요. 폴더에서는 이름순으로 오기 때문이에요
export function orderFolderRefs(refs) {
  const rank = (n) => (/시행세칙/.test(n) ? 0 : /교육과정/.test(n) ? 1 : /대체과목/.test(n) ? 2 : 3);
  const year = (n) => /(?:19|20)\d{2}/.exec(n)?.[0] ?? '';
  return [...refs].sort((a, b) => rank(a.name) - rank(b.name) || year(a.name).localeCompare(year(b.name)) || a.name.localeCompare(b.name, 'ko'));
}

const unreadable = (name, cause) => Object.assign(new Error(`${name}을(를) 열 수 없어요. 암호가 걸렸거나 깨진 파일이에요`), { code: 'E-FILE-UNREADABLE', fileName: name, cause });

// items: [{ name, type, bytes }] 학생 서류 / refs: [{ name, bytes }] 학과 기준문서(이미 묶인 파일이면 [])
// 암호가 걸린 PDF나 깨진 파일은 E-FILE-UNREADABLE을 던져요(사정 건은 검증실패). 암호 PDF는 pdf-lib로 풀 수 없어서 일부러 거절해요
export async function buildBundle(PDFLib, items, refs, bundleName) {
  const out = await PDFLib.PDFDocument.create();
  const pageMap = [];
  const addPdf = async (bytes, fileName, source) => {
    let src;
    try { src = await PDFLib.PDFDocument.load(bytes); } catch (e) { throw unreadable(fileName, e); }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p, i) => {
      out.addPage(p);
      pageMap.push({ page: out.getPageCount(), source, fileName, sourcePage: i + 1 });
    });
  };
  for (const f of items) {
    if (f.type === 'application/pdf') { await addPdf(f.bytes, f.name, 'student'); continue; }
    let img;
    try { img = f.type === 'image/png' ? await out.embedPng(f.bytes) : await out.embedJpg(f.bytes); } catch (e) { throw unreadable(f.name, e); } // 다시 압축하지 않아요
    const s = Math.min(A4[0] / img.width, A4[1] / img.height);
    const page = out.addPage(A4);
    page.drawImage(img, { x: (A4[0] - img.width * s) / 2, y: (A4[1] - img.height * s) / 2, width: img.width * s, height: img.height * s });
    pageMap.push({ page: out.getPageCount(), source: 'student', fileName: f.name, sourcePage: 1 });
  }
  for (const r of refs) await addPdf(r.bytes, r.name, 'reference');
  return { name: bundleName, bytes: await out.save(), pageMap };
}

// 에이전트 글에 붙는 인용 표시(【†1】). API에는 이 표시가 없는 사본이 따로 없어요(설계서 10.1)
const CITATION = /【†[^】]*】/g;
const stripFence = (s) => String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

// Upstage의 output[].content[].text는 글 전체가 JSON 문자열로 한 번 더 감싸여 와요("{\"student_id\"… , "학생: …\n…"). 벗겨서 돌려줘요
function unwrapText(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('"')) return t;
  try {
    const inner = JSON.parse(t);
    return typeof inner === 'string' ? inner : t;
  } catch {
    return t;
  }
}

// 마지막 노드(결과_json변환) 텍스트 → 결과 JSON + 오류·경고
export function parseResult(text, { inputStudentId = '' } = {}) {
  const errors = [], warnings = [];
  let r;
  // 값에 붙어 오는 인용 표시도 여기서 떼요. 판정·이유의 내용은 바꾸지 않아요
  try { r = JSON.parse(stripFence(unwrapText(stripFence(text))), (_, v) => (typeof v === 'string' ? v.replace(CITATION, '') : v)); } catch { return { result: null, errors: ['JSON으로 읽히지 않음'], warnings, raw: text }; }
  if (typeof r === 'string') return { result: null, errors: ['JSON으로 읽히지 않음'], warnings, raw: text };
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return { result: null, errors: ['JSON 객체가 아님'], warnings, raw: text };
  for (const k of KEYS) if (!(k in r)) errors.push(`${k} 없음`);
  if (!DECISIONS.includes(r.decision)) errors.push('decision 값 오류');
  if (!Array.isArray(r.missing_documents) || !Array.isArray(r.excluded_files)) errors.push('배열이 아님');
  if (r.student_id && !/^\d{10}$/.test(r.student_id)) warnings.push('학번 형식이 10자리 숫자가 아님');
  if (r.missing_documents?.length && r.decision !== '확인 필요') warnings.push('빠진 서류가 있는데 확인 필요가 아님');
  if (inputStudentId && r.student_id && r.student_id !== inputStudentId) warnings.push('업로드 때 학번과 다름');
  return { result: r, errors, warnings, raw: text };
}

// excluded_files의 "파일명 (3쪽)" → 쪽 지도에서 원본 파일 찾기
export function mapExcluded(excluded, pageMap) {
  return (excluded || []).map((x) => {
    const m = /\((\d+)쪽\)\s*$/.exec(x.file_name || '');
    const hit = m ? pageMap.find((p) => p.page === Number(m[1])) : null;
    return { ...x, page: hit?.page ?? null, sourceFile: hit?.fileName ?? null, sourcePage: hit?.sourcePage ?? null, warning: m && !hit ? '쪽 지도에 없는 쪽' : null };
  });
}

// include=all 응답에서 판정 노드 텍스트 찾기. 노드 이름(model, 예: "Instruct - 판정")으로 찾고, 이름이 바뀌었으면 내용으로 찾아요
export function findJudgement(full) {
  const steps = (full.output || []).map((s) => ({ model: s.model || '', text: unwrapText((s.content || []).map((c) => c.text || '').join('')) }));
  const looksRight = (t) => t.includes('[작업 3]') && /판정\s*:/.test(t);
  return (steps.find((s) => /판정$/.test(s.model) && looksRight(s.text)) ?? steps.find((s) => looksRight(s.text)))?.text ?? null;
}

// [작업 3] 10줄 → 표 ("영역: 이수/기준 - **결과** (이유)【†23】"). 굵게 표시와 인용 표시는 떼고 읽어요
export function parseAreas(judgementText) {
  const AREAS = ['교양필수', '교양선택', '전공기초', '전공필수', '전공선택', '총학점', '평점', '어학', '졸업인증', '서류 확인'];
  const rows = [];
  for (const raw of String(judgementText || '').split('\n')) {
    const line = raw.replace(CITATION, '').replaceAll('**', '');
    const m = /^\s*(?:\d+\.\s*)?([^:：]+)[:：]\s*(.*?)\s*-\s*(충족|확인 필요|부족|해당 없음)\s*(?:\((.*)\))?\s*$/.exec(line);
    if (m && AREAS.includes(m[1].trim())) rows.push({ area: m[1].trim(), value: m[2], result: m[3], note: m[4] || '' });
  }
  return rows.length ? rows : null; // 형식이 안 맞으면 null → 원문을 그대로 보여줘요
}

// 폴더 일괄: <input webkitdirectory>나 끌어다 놓은 폴더의 파일들 → 학생 폴더별 사정 건
// 고른 폴더 바로 아래의 폴더 하나가 학생 1명이에요. 그 안의 '기준문서/' 폴더는 그 학생에게 딸린 기준문서로 봐요.
export function groupFolders(files, deptNames = []) {
  const OK = /\.(pdf|jpe?g|png)$/i;
  const groups = new Map(), skipped = [];
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).normalize('NFC').split('/').filter(Boolean); // macOS는 한글 경로를 NFD로 줘서 학과명·기준문서 비교가 어긋나요
    if (parts.length < 3 || !OK.test(f.name)) { skipped.push(parts.join('/')); continue; } // 루트/학생폴더/파일 구조가 아니거나 형식이 다르면 건너뜀
    const folder = parts[1];
    const g = groups.get(folder) || { folder, dept: deptNames.find((d) => folder.includes(d)) || null, items: [], refs: [] };
    (parts.length > 3 && parts[2] === '기준문서' ? g.refs : g.items).push(f);
    groups.set(folder, g);
  }
  for (const g of groups.values()) {
    const m = /^(\d{10})(?:_|$)/.exec(g.folder);
    g.inputStudentId = m ? m[1] : '';
  }
  return { groups: [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder, 'ko')), skipped };
}
