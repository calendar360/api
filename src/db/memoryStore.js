/** In-memory user store when PostgreSQL is unavailable (zero-setup dev). */
const users = new Map();
let nextId = 1;

export function findUserByKingschatId(kcId) {
  for (const u of users.values()) {
    if (u.kingschat_id === kcId) return u;
  }
  return null;
}

export function findUserByEmail(email) {
  for (const u of users.values()) {
    if (u.email === email) return u;
  }
  return null;
}

export function upsertKingschatUser({ name, email, kcId, accessToken, refreshToken, avatar }) {
  let user = findUserByKingschatId(kcId) || findUserByEmail(email);
  if (user) {
    user.name = name;
    user.email = email;
    user.kingschat_access_token = accessToken;
    user.kingschat_refresh_token = refreshToken || user.kingschat_refresh_token;
    user.avatar = avatar || user.avatar;
    user.updated_at = new Date();
    users.set(user.id, user);
    return user;
  }
  user = {
    id: nextId++,
    name,
    email,
    password: '',
    kingschat_id: kcId,
    kingschat_refresh_token: refreshToken,
    kingschat_access_token: accessToken,
    avatar,
    created_at: new Date(),
    updated_at: new Date(),
  };
  users.set(user.id, user);
  return user;
}

export function findUserById(id) {
  return users.get(id) ?? null;
}
