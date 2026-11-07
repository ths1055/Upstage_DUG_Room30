// GET /api/runs/:id → Upstage GET /v2/responses/:id (마지막 step만 받아 작게 돌려줘요)
import { upstage, json, JOB_ID } from '../../../lib/upstage.js';

export async function onRequestGet({ params, env }) {
  if (!JOB_ID.test(params.id)) return json({ error: { code: 'E-STUDIO-REQUEST', message: 'job id 형식 오류' } }, 400);
  const r = await upstage(env, `/responses/${params.id}?include=last`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return json(body, r.status);
  const last = body.output?.at(-1)?.content?.map((c) => c.text || '').join('') ?? null;
  return json({
    status: body.status, // queued · in_progress · completed · failed
    // 실패 사유는 error, 중간에 끊긴 사유는 incomplete_details에 와요
    failure_message: body.error?.message ?? (typeof body.error === 'string' ? body.error : null) ?? body.incomplete_details?.reason ?? null,
    last_text: body.status === 'completed' ? last : null,
  });
}
