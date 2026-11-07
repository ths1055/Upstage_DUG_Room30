// DELETE /api/files/:id → Upstage 파일 삭제 (경로는 실측해서 맞춰요)
import { upstage, json, relay, FILE_ID } from '../../../lib/upstage.js';

export async function onRequestDelete({ params, env }) {
  if (!FILE_ID.test(params.id)) return json({ error: { code: 'E-STUDIO-REQUEST', message: 'file id 형식 오류' } }, 400);
  return relay(await upstage(env, `/files/${params.id}`, { method: 'DELETE' }));
}
