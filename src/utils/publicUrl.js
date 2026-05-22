export function publicBaseUrl(req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || 'http';
  return `${proto}://${host}`;
}

export function uploadPublicUrl(req, filename) {
  return `${publicBaseUrl(req)}/uploads/${filename}`;
}
