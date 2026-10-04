import { pushBroadcast } from '../services/fcmService.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const MAX_TITLE = 120;
// Android collapses anything much longer than this in the tray, and the rest
// is only visible once expanded. Kept generous but bounded.
const MAX_BODY = 1000;

/**
 * POST /api/broadcast — admin-only push to every device on the global topic.
 *
 * Takes `{ title, body, image? }`, where `image` is the bare filename returned
 * by POST /api/upload. The URL is built here rather than trusted from the
 * client, so a broadcast cannot be used to make every device fetch an
 * arbitrary third-party URL.
 */
export const sendBroadcast = async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  const image = String(req.body?.image ?? '').trim();

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

  const result = await pushBroadcast({ title, body, imageUrl });

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

  console.log(`[broadcast] user ${req.userId} sent "${title}"`);
  return res.json({ success: true, messageId: result.messageId });
};
