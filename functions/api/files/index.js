// POST /api/files → Upstage POST /v2/files (묶음 PDF 업로드)
import { upstage, json, relay } from '../../../lib/upstage.js';

const MAX_BYTES = 20 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) {
    return json({ error: { code: 'E-UPLOAD-TYPE', message: 'multipart/form-data로 보내주세요' } }, 400);
  }
  const body = await request.arrayBuffer(); // 풀지 않고 바이트만 읽어요
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
    return json({ error: { code: 'E-UPLOAD-SIZE', message: '20MB까지 올릴 수 있어요' } }, 413);
  }
  const r = await upstage(env, '/files', { method: 'POST', headers: { 'content-type': type }, body });
  return relay(r); // 성공하면 { id: "file_…", … }
}
