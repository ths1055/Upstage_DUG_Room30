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

// 에이전트 글에 붙는 인용 표시(【†1】, 【4:0†source】 꼴도). API에는 이 표시가 없는 사본이 따로 없어요(설계서 10.1)
const CITATION = /【[^】]*†[^】]*】/g;
const stripFence = (s) => String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').replace(CITATION, '').trim();

// Upstage의 output[].content[].text는 글 전체가 JSON 문자열로 한 번 더 감싸여 와요("{\"student_id\"… , "학생: …\n…"). 벗겨서 돌려줘요
// 인용 표시는 먼저 떼요. 닫는 따옴표 뒤에 붙어 오면("…"【†37】) JSON.parse가 실패해서 \n이 글자로 남고, 판정 근거가 한 줄이 돼 표로 못 읽었어요
function unwrapText(text) {
  const t = String(text ?? '').replace(CITATION, '').trim();
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
  try { r = JSON.parse(stripFence(unwrapText(stripFence(text))))} catch { return { result: null, errors: ['JSON으로 읽히지 않음'], warnings, raw: text }; }
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

// excluded_files 한 항목을 { file_name, category, page }로 맞춰요. 값은 JSON에 적힌 그대로 써요(인용 표시만 떼요)
// 명세는 {file_name, category}예요. 실측(2026-11-08)에서는 file_name에 문서 제목이 쪽 번호 없이 왔어요
// 문자열 항목이 와도 그 글을 file_name으로 봐요
// "(3쪽)"처럼 쪽 번호가 적혀 있고 묶음 PDF의 쪽 지도에 있으면 page를 채워요 → 화면에서 누르면 미리보기가 그 쪽으로 가요
export function mapExcluded(excluded, pageMap) {
  return (Array.isArray(excluded) ? excluded : []).filter((x) => x != null).map((x) => {
    const o = typeof x === 'object' ? x : { file_name: String(x) };
    const file_name = String(o.file_name ?? '').replace(CITATION, '').trim();
    const category = String(o.category ?? '').replace(CITATION, '').trim();
    const m = /\((\d+)쪽\)\s*$/.exec(file_name);
    const hit = m ? (pageMap || []).find((p) => p.page === Number(m[1])) : null;
    return { ...o, file_name, category, page: hit?.page ?? null };
  });
}

// 제외 파일 한 줄 글: JSON 그대로 "file_name (category)"
export const excludedLabel = (x) => `${x.file_name}${x.category ? ` (${x.category})` : ''}`;

// include=all 응답에서 판정 노드 텍스트 찾기. 노드 이름(model, 예: "Instruct - 판정")으로 찾고, 이름이 바뀌었으면 내용으로 찾아요
export function findJudgement(full) {
  const steps = (full.output || []).map((s) => ({ model: s.model || '', text: unwrapText((s.content || []).map((c) => c.text || '').join('')) }));
  const looksRight = (t) => t.includes('[작업 3]') && /판정\s*:/.test(t);
  return (steps.find((s) => /판정$/.test(s.model) && looksRight(s.text)) ?? steps.find((s) => looksRight(s.text)))?.text ?? null;
}

// [작업 3] 10줄 → 표 ("영역: 이수/기준 - **결과** (이유)【†23】"). 굵게 표시와 인용 표시는 떼고 읽어요
// 예전에 원문으로 저장된 글(이중 인코딩이 안 풀린 것)도 다시 읽을 수 있게 unwrapText를 한 번 더 거쳐요
export function parseAreas(judgementText) {
  const AREAS = ['교양필수', '교양선택', '전공기초', '전공필수', '전공선택', '총학점', '평점', '어학', '졸업인증', '서류 확인'];
  const canon = new Map(AREAS.map((a) => [a.replace(/\s/g, ''), a])); // '서류확인'처럼 띄어쓰기가 달라도 알아봐요
  let text = unwrapText(judgementText);
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n'); // 그래도 못 풀었으면 \n 글자를 줄바꿈으로 바꿔요
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(CITATION, '').replaceAll('**', '');
    const m = /^[\s\-*#>]*(?:\d+[.)]\s*)?([^:：]+)[:：]\s*(.*?)\s*[-–—]\s*#?\s*(충족|확인 필요|부족|해당 없음)\s*(?:\((.*)\))?\s*$/.exec(line);
    const area = m && canon.get(m[1].replace(/\s/g, ''));
    if (area) rows.push({ area, value: m[2], result: m[3], note: m[4] || '' });
  }
  return rows.length ? rows : null; // 형식이 안 맞으면 null → 원문을 그대로 보여줘요
}

// 폴더 일괄: <input webkitdirectory>나 끌어다 놓은 폴더의 파일들 → 학생 폴더별 사정 건
// 경로 규칙은 '학과/학번_이름/파일'이에요. 학번_이름 폴더 하나가 학생 1명이고, 바로 위 폴더 이름이 학과예요.
// 학과 폴더를 골라도, 그 위 폴더를 골라도 돼요. 학생 폴더 안의 '기준문서/' 폴더는 그 학생에게 딸린 기준문서로 봐요.
// groups[].skipped는 학생 폴더 안에서 형식이 달라 건너뛴 파일, skipped는 규칙에 맞는 학생 폴더 밖의 파일이에요
export function groupFolders(files) {
  const OK = /\.(pdf|jpe?g|png)$/i;
  const STUDENT = /^(\d{10})_(.+)$/;
  const groups = new Map(), skipped = [];
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).normalize('NFC').split('/').filter(Boolean); // macOS는 한글 경로를 NFD로 줘서 학과명·기준문서 비교가 어긋나요
    const dirs = parts.slice(0, -1);
    const at = dirs.findIndex((d) => STUDENT.test(d));
    if (at < 1) { skipped.push(parts.join('/')); continue; } // 학생 폴더가 없거나 그 위에 학과 폴더가 없어요
    const key = dirs.slice(0, at + 1).join('/');
    const [, inputStudentId, inputName] = STUDENT.exec(dirs[at]);
    const g = groups.get(key) || { key, folder: dirs[at], dept: dirs[at - 1], inputStudentId, inputName, items: [], refs: [], skipped: [] };
    groups.set(key, g);
    if (!OK.test(f.name)) g.skipped.push(parts.at(-1));
    else (dirs[at + 1] === '기준문서' ? g.refs : g.items).push(f);
  }
  return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'ko')), skipped };
}
