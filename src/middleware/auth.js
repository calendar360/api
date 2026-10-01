import jwt from 'jsonwebtoken';

// Kept as a fallback so existing tokens keep verifying on deployments where
// JWT_SECRET was never set. New installs should always set JWT_SECRET.
const FALLBACK_SECRET =
  'a9597f305350a847503b7d86967d731a401ffa32ce21320f6ced2c929f143dcb2f05f23dcacabdf0ca12ce84f9e598aa6b86c8c83ce0c04bf64e585e18b03f3c';

/**
 * The single secret used for signing. Exported because payment return URLs
 * have to sign themselves — a redirect arriving from Espees cannot carry the
 * `token` header that [authRequired] reads, so those routes authenticate by
 * verifying an HMAC in the query string instead.
 */
export function tokenSecret() {
  return process.env.JWT_SECRET || FALLBACK_SECRET;
}

export const authOptional = async (req, res, next) => {
  const token = req.headers.token;
  if (!token) {
    req.userId = null;
    return next();
  }
  try {
    req.userId = decodeToken(token);
    next();
  } catch {
    req.userId = null;
    next();
  }
};

export const authRequired = async (req, res, next) => {
  const token = req.headers.token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
  try {
    req.userId = decodeToken(token);
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

function decodeToken(token) {
  const primary = process.env.JWT_SECRET;

  if (primary) {
    try {
      return jwt.verify(token, primary).id;
    } catch (err) {
      if (err.name === 'JsonWebTokenError') {
        return jwt.verify(token, FALLBACK_SECRET).id;
      }
      throw err;
    }
  }
  return jwt.verify(token, FALLBACK_SECRET).id;
}
