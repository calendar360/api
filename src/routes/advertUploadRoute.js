import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authRequired } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Advert artwork is uploaded here instead of to `/api/upload`.
 *
 * The difference is the destination: `uploads/` is served statically, so
 * anything landing there is world-readable the instant it is written — before
 * payment, before review, and still after a rejection. This directory is not
 * served statically at all. The only way to read a file in it is
 * `GET /api/ads/:id/image`, which checks the advert's status first.
 */
export const advertUploadsDir = path.join(__dirname, '../../uploads-adverts');

if (!fs.existsSync(advertUploadsDir)) {
  fs.mkdirSync(advertUploadsDir, { recursive: true });
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

function isAllowedImage(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  if (IMAGE_EXT.test(name)) return true;
  // Flutter / Android often send application/octet-stream even for real photos.
  if (mime === 'application/octet-stream' || mime === '') return true;
  return false;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, advertUploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedImage(file)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

const router = express.Router();

/**
 * POST /api/upload/advert
 *
 * Returns only the stored filename. There is deliberately no URL in the
 * response: nothing can be read until the file is attached to an advert, at
 * which point the advert's own image route decides who may see it.
 */
// Throttled because this is the one endpoint that writes to disk before an
// advert exists: without it, anyone could upload 8MB at a time in a loop and
// the per-user advert cap would never see it. After authRequired, so the
// allowance is per account rather than per network.
router.post(
  '/advert',
  authRequired,
  rateLimit({ max: 20, windowMs: 60 * 60 * 1000, name: 'advert-upload' }),
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'No image file provided' });
    }
    res.json({ success: true, filename: req.file.filename, path: req.file.filename });
  },
);

export default router;
