// 내보내기 — 판정별 건수, 정답지 형식 JSON, CSV, 결과 PDF에 넘길 모양. 판정은 에이전트 결과 그대로 옮겨요
import { KEYS, DECISIONS, mapExcluded } from './core.js';

export const STATUS_LABEL = { RECEIVED: '접수', INVALID: '검증실패', QUEUED: '대기', RUNNING: '실행중', REVIEW: '검토대기', FAILED: '실행실패' };

// 판정이 끝난 건만
export const judged = (cases) => cases.filter((c) => c.status === 'REVIEW' && c.result);

// 졸업 가능·졸업 요건 부족·확인 필요·실행실패·미실행
export function countCases(cases) {
  const out = Object.fromEntries([...DECISIONS, '실행실패', '미실행'].map((k) => [k, 0]));
  for (const c of cases) {
    if (c.status === 'REVIEW' && c.result) out[c.result.decision]++;
    else if (c.status === 'FAILED') out['실행실패']++;
    else out['미실행']++;
  }
  return out;
}

// 정답지 형식. answer는 키 6개를 정해진 순서로만 담아요
export function buildAnswerJson(cases, { round = '' } = {}) {
  return {
    task: round || '졸업요건 사정',
    unit: '졸업예정자 1명 = 파일 1개(학생 서류 + 학과 기준문서 묶음 PDF) = 판정 1건',
    output_keys: KEYS,
    decision_values: DECISIONS,
    cases: judged(cases).map((c) => ({
      case_id: c.id,
      file: c.fileName,
      answer: Object.fromEntries(KEYS.map((k) => [k, c.result[k]])),
    })),
  };
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // 표 계산 프로그램이 수식으로 실행하지 않게 해요
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// UTF-8 BOM을 붙여요. 엑셀에서 한글이 깨지지 않게 하려고요
export function buildCsv(cases) {
  const head = ['case_id', 'file', 'label', 'dept', 'status', ...KEYS, 'warnings', 'error', 'checked', 'memo'];
  const rows = cases.map((c) => {
    const r = c.result || {};
    return [c.id, c.fileName, c.label, c.dept, STATUS_LABEL[c.status] ?? c.status,
      r.student_id, r.applicant_name, r.decision, r.reason,
      (r.missing_documents || []).join('; '),
      mapExcluded(r.excluded_files, c.pageMap || []).map((x) => `${x.sourceFile ? `${x.sourceFile} ${x.sourcePage}쪽` : x.file_name} (${x.category})`).join('; '),
      (c.warnings || []).join('; '), c.error, c.checked ? 'Y' : '', c.memo];
  });
  return `﻿${[head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// 사정 건 → buildReport가 읽는 모양. 파일 칸에는 담당자가 알아보는 이름(label)을 써요
export const reportCases = (cases) => cases.map((c) => ({ ...c, fileName: c.label, excludedMapped: mapExcluded(c.result?.excluded_files, c.pageMap || []) }));

const safeName = (s) => String(s || '').normalize('NFC').trim().replace(/[\\/:*?"<>|\s]+/g, '_');

export const singleReportName = (c) => `사정결과_${safeName(c.result?.student_id || c.label.replace(/\.[^.]+$/, ''))}.pdf`;
export const batchReportName = (round, n) => `사정결과_${round ? `${safeName(round)}_` : ''}${n}건.pdf`;
