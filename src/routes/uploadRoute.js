import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authRequired } from '../middleware/auth.js';
import { uploadPublicUrl } from '../utils/publicUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '../../uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, safe);
  },
});

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
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedImage(file)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

const router = express.Router();

router.post('/', authRequired, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file provided' });
  }
  res.json({
    success: true,
    filename: req.file.filename,
    path: req.file.filename,
    url: uploadPublicUrl(req, req.file.filename),
  });
});

export default router;
