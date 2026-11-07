// 실행 흐름 — 업로드 → 실행(409 재시도) → 폴링 → 파일 삭제 → 결과 검증, 동시 실행 큐
// 이 숫자를 바꾸면 설계서 7.5도 같이 고쳐요
import { parseResult } from './core.js';

export const CONCURRENCY = 2;
const POLL_MS = 5_000;
const MAX_WAIT_MS = 20 * 60_000;
const RETRY_MS = 10_000;
const MAX_RETRIES = 5;

async function api(path, opt = {}) {
  const r = await fetch(path, opt);
  const body = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(body?.error?.message || r.statusText), { status: r.status, body });
  return body;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const removeFile = (fileId) => api(`/api/files/${fileId}`, { method: 'DELETE' }).catch(() => {}); // 지우기 실패는 넘어가요
const finished = (patch) => ({ finishedAt: new Date().toISOString(), ...patch });

// 응답을 받지 못했거나 서버 쪽 오류면 잠깐의 문제로 봐요
const isTransient = (e) => e.status === undefined || e.status === 429 || e.status >= 500;

// 던져진 오류 → 사정 건에 적을 코드·메시지(설계서 3.6)
export function describeError(e) {
  if (e.body?.error?.code === 'E-CONFIG') return { errorCode: 'E-CONFIG', error: e.message, errors: [] }; // 다시 실행해도 안 되니 그대로 알려줘요
  if (e.status === 413) return { errorCode: 'E-UPLOAD-SIZE', error: '20MB까지 올릴 수 있어요', errors: [] };
  if (isTransient(e)) return { errorCode: 'E-STUDIO-SERVER', error: '잠시 뒤 다시 실행해주세요', errors: [] };
  return { errorCode: 'E-STUDIO-REQUEST', error: '실행 요청에 문제가 있어요', errors: [e.message].filter(Boolean) };
}

// c: { name, bytes, inputStudentId, startedAt } — save(c, patch)는 사정 건을 고쳐 저장하고 고친 건을 돌려주는 앱 함수
export async function runCase(c, save) {
  let fileId = null, run;
  try {
    const fd = new FormData();
    fd.append('purpose', 'user_data');
    fd.append('file', new Blob([c.bytes], { type: 'application/pdf' }), c.name);
    const file = await api('/api/files', { method: 'POST', body: fd });
    fileId = file.id ?? file.file_id;
    save(c, { fileId }); // 실행 전에 새로고침해도 올린 파일을 지울 수 있게 적어 둬요

    for (let tries = 0; ; tries++) { // 409: 업로드한 파일을 아직 처리 중 → 10초 뒤 다시(최대 5번)
      try {
        run = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) });
        break;
      } catch (e) {
        if (e.status !== 409 || tries >= MAX_RETRIES) throw e;
        await sleep(RETRY_MS);
      }
    }
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

// 동시에 limit건만 worker를 돌리고, 나머지는 넣은 순서대로 기다려요
export function createQueue(worker, limit = CONCURRENCY) {
  const waiting = [];
  let active = 0;
  const next = () => {
    while (active < limit && waiting.length) {
      const item = waiting.shift();
      active++;
      Promise.resolve().then(() => worker(item)).catch((e) => console.error(e)).finally(() => { active--; next(); });
    }
  };
  return { add(item) { waiting.push(item); next(); } };
}
