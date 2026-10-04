import { pushBroadcast } from '../services/fcmService.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const MAX_TITLE = 120;
// Android collapses anything much longer than this in the tray, and the rest
// is only visible once expanded. Kept generous but bounded.
const MAX_BODY = 1000;
const MAX_LINK = 500;

/**
 * Turns what an admin typed into a URL safe to hand every device, or returns
 * an error message explaining why it is not one.
 *
 * A bare domain ("helloloveworld.tv") is the normal way to type a link, so it
 * is upgraded to https rather than rejected. Plain http is refused outright:
 * a broadcast reaches every user at once, and a link that can be tampered
 * with in transit is not something to send at that scale.
 */
export function normaliseLink(raw) {
  if (!raw) return { url: undefined };
  if (raw.length > MAX_LINK) {
    return { error: `Keep the link under ${MAX_LINK} characters` };
  }
  // Whitespace inside a URL is always a mistake, and a newline would let one
  // value look like two.
  if (/\s/.test(raw)) return { error: 'The link cannot contain spaces' };

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'That does not look like a valid link' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      error:
        parsed.protocol === 'http:'
          ? 'Use an https:// link — plain http is not allowed in a broadcast'
          : 'Only https:// links can be sent',
    };
  }
  // A host with no dot is either a typo or an internal name no user can reach.
  if (!parsed.hostname.includes('.')) {
    return { error: 'That does not look like a valid link' };
  }

  return { url: parsed.toString() };
}

/**
 * POST /api/broadcast — admin-only push to every device on the global topic.
 *
 * Takes `{ title, body, image?, link? }`. `image` is the bare filename
 * returned by POST /api/upload — the URL is built here rather than trusted
 * from the client, so a broadcast cannot make every device fetch an arbitrary
 * third-party URL.
 *
 * `link` is different: it is meant to point off-site, so it is validated and
 * normalised rather than rebuilt. It travels in the data payload, not in the
 * visible text, and the app opens it when the notification is tapped.
 */
export const sendBroadcast = async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  const image = String(req.body?.image ?? '').trim();
  const link = String(req.body?.link ?? '').trim();

  if (!title) {
    return res.status(400).json({ success: false, message: 'A title is required' });
  }
  if (!body) {
    return res.status(400).json({ success: false, message: 'A message is required' });
  }
  if (title.length > MAX_TITLE) {
    return res.status(400).json({
      success: false,
      message: `Keep the title under ${MAX_TITLE} characters`,
    });
  }
  if (body.length > MAX_BODY) {
    return res.status(400).json({
      success: false,
      message: `Keep the message under ${MAX_BODY} characters`,
    });
  }

  // Only ever a filename from our own uploads directory — never a full URL,
  // and never a path that could climb out of it.
  let imageUrl;
  if (image) {
    if (image.includes('/') || image.includes('\\') || image.includes('..')) {
      return res.status(400).json({ success: false, message: 'Invalid image reference' });
    }
    imageUrl = uploadPublicUrl(req, image);
  }

  const { url, error: linkError } = normaliseLink(link);
  if (linkError) {
    return res.status(400).json({ success: false, message: linkError });
  }

  const result = await pushBroadcast({
    title,
    body,
    imageUrl,
    data: url ? { url } : {},
  });

  if (!result.sent) {
    // The push itself failed — say so rather than reporting a success the
    // admin would have no way to check.
    return res.status(502).json({
      success: false,
      message:
        result.reason === 'fcm_not_configured'
          ? 'Push notifications are not configured on the server'
          : `Could not send: ${result.reason}`,
    });
  }

  console.log(
    `[broadcast] user ${req.userId} sent "${title}"${url ? ` -> ${url}` : ''}`,
  );
  return res.json({ success: true, messageId: result.messageId, link: url ?? null });
};
