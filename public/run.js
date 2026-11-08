// 실행 흐름 — 업로드 → 실행(409·429·5xx 재시도) → 폴링 → 파일 삭제 → 결과 검증. 건마다 따로 돌고, 동시 건수는 제한하지 않아요
// 이 숫자를 바꾸면 설계서 7.5도 같이 고쳐요
import { parseResult } from './core.js';

const POLL_MS = 5_000;
const MAX_WAIT_MS = 20 * 60_000;
const RETRY_MS = 10_000;
const MAX_RETRIES = 5;
// 429·5xx·네트워크 오류: 한꺼번에 여러 건을 보내면 Upstage가 일부를 잠깐 거절해요. 기다렸다 다시 보내요
// Retry-After가 오면 그만큼, 없으면 10초→20초→40초→60초→60초에 0~5초를 더해 건마다 엇갈리게 해요
const BACKOFF_MAX_MS = 60_000;
const JITTER_MS = 5_000;

async function api(path, opt = {}) {
  const r = await fetch(path, opt);
  const body = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok) {
    const retryAfter = Number(r.headers.get('retry-after')) * 1000 || null; // 초 단위만 읽어요
    throw Object.assign(new Error(body?.error?.message || r.statusText), { status: r.status, body, retryAfter });
  }
  return body;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const removeFile = (fileId) => api(`/api/files/${fileId}`, { method: 'DELETE' }).catch(() => {}); // 지우기 실패는 넘어가요
const finished = (patch) => ({ finishedAt: new Date().toISOString(), ...patch });

// 응답을 받지 못했거나 서버 쪽 오류면 잠깐의 문제로 봐요
const isTransient = (e) => e.status === undefined || e.status === 429 || e.status >= 500;

// 오류 종류에 따라 다시 보낼지 정하고 기다려요. 다시 보내지 않으면 오류를 그대로 던져요
// retry409: 실행 요청만 409(업로드한 파일을 아직 처리 중)를 다시 보내요
async function withRetry(fn, { retry409 = false } = {}) {
  for (let tries = 0; ; tries++) {
    try {
      return await fn();
    } catch (e) {
      if (tries >= MAX_RETRIES || e.body?.error?.code === 'E-CONFIG') throw e;
      if (retry409 && e.status === 409) await sleep(RETRY_MS);
      else if (isTransient(e)) await sleep(e.retryAfter ?? Math.min(RETRY_MS * 2 ** tries, BACKOFF_MAX_MS) + Math.random() * JITTER_MS);
      else throw e;
    }
  }
}

// 던져진 오류 → 사정 건에 적을 코드·메시지(설계서 3.6)
export function describeError(e) {
  if (e.body?.error?.code === 'E-CONFIG') return { errorCode: 'E-CONFIG', error: e.message, errors: [] }; // 다시 실행해도 안 되니 그대로 알려줘요
  if (e.status === 413) return { errorCode: 'E-UPLOAD-SIZE', error: '20MB까지 올릴 수 있어요', errors: [] };
  if (isTransient(e)) return { errorCode: 'E-STUDIO-SERVER', error: '잠시 뒤 다시 실행해주세요', errors: [e.status ? `HTTP ${e.status} ${e.message}` : e.message].filter(Boolean) };
  return { errorCode: 'E-STUDIO-REQUEST', error: '실행 요청에 문제가 있어요', errors: [e.message].filter(Boolean) };
}

// c: { name, bytes, inputStudentId, startedAt } — save(c, patch)는 사정 건을 고쳐 저장하고 고친 건을 돌려주는 앱 함수
export async function runCase(c, save) {
  let fileId = null, run;
  try {
    const fd = new FormData();
    fd.append('purpose', 'user_data');
    fd.append('file', new Blob([c.bytes], { type: 'application/pdf' }), c.name);
    const file = await withRetry(() => api('/api/files', { method: 'POST', body: fd }));
    fileId = file.id ?? file.file_id;
    save(c, { fileId }); // 실행 전에 새로고침해도 올린 파일을 지울 수 있게 적어 둬요

    run = await withRetry(() => api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) }), { retry409: true });
  } catch (e) {
    if (fileId) removeFile(fileId);
    return save(c, finished({ status: 'FAILED', ...describeError(e) }));
  }
  save(c, { jobId: run.job_id, status: 'RUNNING' }); // 탭을 닫아도 다시 열면 이어서 확인
  return pollCase({ ...c, fileId, jobId: run.job_id }, save);
}

// c: { fileId, jobId, inputStudentId, startedAt } — 실행 뒤 폴링부터. 페이지를 다시 열었을 때도 이것으로 이어가요
export async function pollCase(c, save) {
  const deadline = (Date.parse(c.startedAt) || Date.now()) + MAX_WAIT_MS;
  let s;
  for (;;) {
    await sleep(POLL_MS);
    s = null;
    try {
      s = await api(`/api/runs/${c.jobId}`);
    } catch (e) {
      if (!isTransient(e)) { // 잠깐의 오류로는 멈추지 않아요. job은 Upstage에서 계속 돌고 있어요
        removeFile(c.fileId);
        return save(c, finished({ status: 'FAILED', ...describeError(e) }));
      }
    }
    if (s && !['queued', 'in_progress'].includes(s.status)) break;
    if (Date.now() >= deadline) {
      removeFile(c.fileId);
      return save(c, finished({ status: 'FAILED', errorCode: 'E-RUN-TIMEOUT', error: '시간이 너무 오래 걸려 중단했어요', errors: [] }));
    }
  }

  removeFile(c.fileId);
  if (s.status !== 'completed') {
    return save(c, finished({ status: 'FAILED', errorCode: 'E-STUDIO-FAILED', error: `에이전트 실행이 실패했어요: ${s.failure_message || '사유를 받지 못했어요'}`, errors: [] }));
  }
  const p = parseResult(s.last_text, { inputStudentId: c.inputStudentId });
  if (p.errors.length) {
    return save(c, finished({ status: 'FAILED', errorCode: 'E-RESULT-PARSE', error: '결과 형식에 문제가 있어요(원문 보기)', result: null, errors: p.errors, warnings: p.warnings, raw: p.raw }));
  }
  return save(c, finished({ status: 'REVIEW', result: p.result, errors: [], warnings: p.warnings }));
}
