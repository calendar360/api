import axios from "axios";
import createToken from "../utils/createToken.js";
import { upsertUser } from "../services/userService.js";
import { CLIENT_ID } from "../routes/oauthRoute.js";

function mapUserRow(user, kingschatId) {
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

    const token = createToken(user.id);
    res.json({ success: true, token, user: mapUserRow(user, kcId) });
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

    const token = createToken(user.id);
    res.json({ success: true, token, user: mapUserRow(user, kcId) });
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
