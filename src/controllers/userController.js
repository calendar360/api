import axios from "axios";
import pool from "../db/pool.js";
import createToken from "../utils/createToken.js";
import { upsertUser } from "../services/userService.js";
import { CLIENT_ID } from "../routes/oauthRoute.js";
import { computeMeetingsAccess } from "../services/meetingsAccessService.js";

/* ── Birthday handling ──────────────────────────────────────────────────────
 * KingsChat does not document a birthdate field on
 * https://connect.kingsch.at/developer/api/profile, and the payload shape
 * differs between the code-exchange and profile-token login paths. So we
 * probe every field name it plausibly uses, and store the raw profile in
 * users.kingschat_profile — GET /api/user/kingschat-profile then shows
 * exactly what KingsChat returns for this client id.
 */
const BIRTHDAY_KEYS = [
  "birthday", "birth_day", "birthdate", "birth_date",
  "date_of_birth", "dateOfBirth", "dob", "DOB",
  "born_on", "bornOn", "birthDate", "birthDay",
];

function toIsoDate(year, month, day) {
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Year is optional: a birthday only needs month/day. 1900 is the sentinel
  // for "year unknown" and is never shown to the user.
  const y = Number.isFinite(year) && year > 1900 ? year : 1900;
  return `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Normalises whatever KingsChat sends into 'YYYY-MM-DD', or null. */
export function parseBirthday(value) {
  if (value == null) return null;

  // Some providers nest { day, month, year }.
  if (typeof value === "object") {
    const day = value.day ?? value.date;
    const month = value.month;
    if (day && month) return toIsoDate(Number(value.year), Number(month), Number(day));
    return null;
  }

  if (typeof value === "number") {
    const d = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return toIsoDate(+m[1], +m[2], +m[3]);

  // Day-first, matching KingsChat's primary audience. A US-style MM/DD/YYYY
  // would be misread, which is why the user always confirms before it is saved.
  m = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return toIsoDate(+m[3], +m[2], +m[1]);

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractKingsChatBirthday(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of BIRTHDAY_KEYS) {
      if (!(key in src)) continue;
      const parsed = parseBirthday(src[key]);
      if (parsed) {
        console.log("[kc] birthday found on profile key:", key);
        return parsed;
      }
    }
  }
  return null;
}

/** pg returns DATE as a UTC-midnight Date; format with UTC getters so the
 *  day never shifts backwards in a negative-offset timezone. */
function toDateOnly(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Stores the raw KingsChat profile and any birthday found in it. The user's
 *  own `birthday` is deliberately NOT set here — the app asks them to confirm
 *  first, so a wrongly-parsed date can never silently become their birthday. */
async function recordKingsChatProfile(userId, rawProfile, kcBirthday) {
  try {
    await pool.query(
      `UPDATE users
          SET kingschat_profile = $1,
              kingschat_birthday = COALESCE($2::date, kingschat_birthday),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`,
      [rawProfile ?? null, kcBirthday, userId],
    );
  } catch (e) {
    console.error("[kc] recordKingsChatProfile failed:", e.message);
  }
}

async function reloadUser(userId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  return rows[0];
}

function mapUserRow(user, kingschatId) {
  const {
    active: meetingsSubActive,
    expiresAt: meetingsSubExpiresAt,
    isFree: meetingsSubIsFree,
    freeUsesLeft: meetingsFreeUsesLeft,
    freeUsesTotal: meetingsFreeUsesTotal,
  } = computeMeetingsAccess(user);
  return {
    id: user.id,
    kingschatId: kingschatId || user.kingschat_id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || user.profile_photo,
    firebaseUid: user.firebase_uid,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    isAdmin: user.is_admin === true,
    isPaid: user.is_paid === true,
    meetingsSubActive,
    meetingsSubIsFree: meetingsSubIsFree === true,
    meetingsSubExpiresAt: meetingsSubExpiresAt || null,
    // Free meetings still available. The app shows this before scheduling,
    // since creating a meeting on the free tier spends one.
    meetingsFreeUsesLeft,
    meetingsFreeUsesTotal,
    // Birthday the user has confirmed, what KingsChat reported, and where the
    // confirmed value came from. The app prompts whenever these disagree.
    birthday: toDateOnly(user.birthday),
    birthdaySource: user.birthday_source || null,
    birthdaySyncedAt: user.birthday_synced_at || null,
    kingschatBirthday: toDateOnly(user.kingschat_birthday),
  };
}

export const syncUser = async (req, res) => {
  try {
    const {
      name,
      email,
      kingschatId,
      firebaseUid,
      firstName,
      lastName,
      username,
      avatar,
      profilePhoto,
      isAdmin,
    } = req.body || {};

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "email required" });
    }

    const displayName =
      name ||
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      username ||
      "KingsChat User";

    const user = await upsertUser({
      name: displayName,
      email,
      kingschatId: kingschatId ? String(kingschatId) : null,
      firebaseUid,
      firstName,
      lastName,
      username,
      avatar,
      profilePhoto,
      isAdmin: isAdmin === true,
    });

    const token = createToken(user.id);
    console.log("[user] synced id=", user.id, "email=", user.email);

    res.json({
      success: true,
      token,
      user: mapUserRow(user, kingschatId),
    });
  } catch (error) {
    console.error("syncUser error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Login from KingsChat post_redirect profile (no access token). */
export const kingschatProfileLogin = async (req, res) => {
  try {
    const data = req.body?.profile || req.body || {};
    const kcUser = data.user || data;
    const kcId = String(kcUser.user_id || kcUser.id || kcUser.userId || "");
    if (!kcId) {
      return res
        .status(400)
        .json({ success: false, message: "KingsChat profile missing id" });
    }

    const fullName = kcUser.name || kcUser.fullName || "KingsChat User";
    const emailRaw = data.email ?? kcUser.email;
    const email =
      (typeof emailRaw === "object" && emailRaw !== null
        ? emailRaw.address
        : emailRaw) || `kc_${kcId}@kingschat.local`;
    const avatar = kcUser.avatar_url || kcUser.avatar || null;
    const username = kcUser.username || String(email).split("@")[0];
    const parts = String(fullName).trim().split(/\s+/);

    const user = await upsertUser({
      name: fullName,
      email: String(email),
      kingschatId: kcId,
      firstName: parts[0] || fullName,
      lastName: parts.length > 1 ? parts.slice(1).join(" ") : "",
      username,
      avatar,
      profilePhoto: avatar,
    });

    await recordKingsChatProfile(
      user.id,
      data,
      extractKingsChatBirthday(kcUser, data),
    );

    const token = createToken(user.id);
    res.json({
      success: true,
      token,
      user: mapUserRow(await reloadUser(user.id), kcId),
    });
  } catch (error) {
    console.error("kingschatProfileLogin", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const kingschatLogin = async (req, res) => {
  var { kc_code, kc_token } = req.body || {};

  // console.log("kingschatLogin payload:", { kc_code, kc_token });

  if (!kc_code && !kc_token) {
    return res.status(400).json({ success: false, message: "bad request" });
  }

  const profileURL = "https://connect.kingsch.at/developer/api/profile";
  const tokenURL = "https://connect.kingsch.at/developer/api/oauth2/token";

  try {
    if (!kc_token && kc_code) {
      const params = new URLSearchParams();
      params.append("grant_type", "code");
      params.append("client_id", CLIENT_ID);
      params.append("code", kc_code);

      const tokenResponse = await axios.post(tokenURL, params, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const tokenData = tokenResponse.data || {};
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        return res
          .status(400)
          .json({ success: false, message: "invalid kingschat code" });
      }

      kc_token = accessToken;
    }

    const profileResponse = await axios.get(profileURL, {
      headers: {
        Authorization: `Bearer ${kc_token}`,
      },
    });

    const profileData = profileResponse.data || {};
    const profile = profileData.profile || profileData;
    const kcUser = profile?.user || profile;

    const kcId = String(
      profile?.id || profile?.userId || kcUser?.user_id || kcUser?.id || "",
    );
    if (!kcId) {
      return res
        .status(400)
        .json({ success: false, message: "KingsChat profile missing id" });
    }

    const fullName =
      kcUser?.name || profile?.name || profile?.fullName || "KingsChat User";
    const emailRaw = profile?.email ?? kcUser?.email;
    const email =
      (typeof emailRaw === "object" && emailRaw !== null
        ? emailRaw.address
        : emailRaw) || `kc_${kcId}@kingschat.local`;
    const avatar =
      kcUser?.avatar_url || profile?.avatar || profile?.picture || null;
    const username = kcUser?.username || String(email).split("@")[0];
    const nameParts = String(fullName).trim().split(/\s+/);

    const user = await upsertUser({
      name: fullName,
      email: String(email),
      kingschatId: kcId,
      firstName: nameParts[0] || fullName,
      lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : "",
      username,
      avatar,
      profilePhoto: avatar,
    });

    await recordKingsChatProfile(
      user.id,
      profileData,
      extractKingsChatBirthday(kcUser, profile, profileData),
    );

    const token = createToken(user.id);
    res.json({
      success: true,
      token,
      user: mapUserRow(await reloadUser(user.id), kcId),
    });
  } catch (error) {
    const kcStatus = error.response?.status;
    const message =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      "KingsChat login failed";
    console.error("kingschatLogin error", kcStatus ?? "", message);
    const status = kcStatus && kcStatus < 500 ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
};

export const registerFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res
        .status(400)
        .json({ success: false, message: "token required" });
    }
    const { saveUserFcmToken } = await import("../services/fcmService.js");
    await saveUserFcmToken(req.userId, token);
    res.json({ success: true });
  } catch (error) {
    console.error("registerFcmToken", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.userId;
    const { default: pool } = await import("../db/pool.js");
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [
      userId,
    ]);
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    res.json({ success: true, user: mapUserRow(result.rows[0]) });
  } catch (error) {
    console.error("getMe error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/** PATCH /api/user/birthday — the user confirms or edits their birthday.
 *  `source` records whether the value came from the KingsChat prompt or was
 *  typed in, so the app knows not to prompt again for the same value. */
export const updateBirthday = async (req, res) => {
  try {
    const { birthday, source } = req.body || {};
    const parsed = parseBirthday(birthday);
    if (!parsed) {
      return res
        .status(400)
        .json({ success: false, message: "birthday must be a valid date" });
    }
    const src = source === "kingschat" ? "kingschat" : "manual";
    await pool.query(
      `UPDATE users
          SET birthday = $1::date,
              birthday_source = $2,
              birthday_synced_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`,
      [parsed, src, req.userId],
    );
    const user = await reloadUser(req.userId);
    res.json({ success: true, user: mapUserRow(user) });
  } catch (error) {
    console.error("updateBirthday", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** DELETE /api/user/birthday — user declined the prompt or cleared the date.
 *  birthday_synced_at is kept set so the prompt is not shown again on every
 *  single login; the app only re-asks when KingsChat reports a different date. */
export const clearBirthday = async (req, res) => {
  try {
    await pool.query(
      `UPDATE users
          SET birthday = NULL,
              birthday_source = 'declined',
              birthday_synced_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [req.userId],
    );
    const user = await reloadUser(req.userId);
    res.json({ success: true, user: mapUserRow(user) });
  } catch (error) {
    console.error("clearBirthday", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** GET /api/user/kingschat-profile — diagnostic. Returns the raw profile
 *  payload KingsChat sent for the signed-in user, so the available fields
 *  (birthdate among them) can be confirmed from real data rather than guessed. */
export const getKingsChatProfile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT kingschat_profile, kingschat_birthday, birthday, birthday_source
         FROM users WHERE id = $1`,
      [req.userId],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ success: false, message: "user not found" });

    const raw = row.kingschat_profile || null;
    res.json({
      success: true,
      // Every key present in the payload, so a birthdate field is easy to spot
      // even if it is not one of the names we probe for.
      topLevelKeys: raw && typeof raw === "object" ? Object.keys(raw) : [],
      userKeys:
        raw && typeof raw === "object" && raw.user && typeof raw.user === "object"
          ? Object.keys(raw.user)
          : [],
      detectedBirthday: toDateOnly(row.kingschat_birthday),
      confirmedBirthday: toDateOnly(row.birthday),
      birthdaySource: row.birthday_source || null,
      profile: raw,
    });
  } catch (error) {
    console.error("getKingsChatProfile", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
