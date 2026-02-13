const path = require("path");
const Database = require("better-sqlite3");
const { logger } = require("./src/config");

const DB_FILE = path.join(__dirname, "database.sqlite");

let db;
let cachedSettings = null;

async function initializeDatabase() {
  try {
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");

    logger.info("Connected to SQLite database.");

    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      link_usage_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS force_join_channels (
      id INTEGER PRIMARY KEY,
      title TEXT,
      invite_link TEXT,
      button_text TEXT,
      chat_type TEXT DEFAULT 'channel',
      condition_type TEXT,
      condition_limit INTEGER,
      current_members_count INTEGER DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS force_join_extra_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      invite_link TEXT,
      button_text TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS files (
      file_identifier TEXT PRIMARY KEY,
      file_id TEXT,
      file_type TEXT,
      file_ids_json TEXT,
      file_types_json TEXT,
      user_caption TEXT,
      user_captions_json TEXT,
      usage_count INTEGER DEFAULT 0
    )`);

    const alterStatements = [
      { sql: "ALTER TABLE force_join_channels ADD COLUMN current_members_count INTEGER DEFAULT 0", name: "current_members_count" },
      { sql: "ALTER TABLE force_join_channels ADD COLUMN button_text TEXT", name: "button_text" },
      { sql: "ALTER TABLE force_join_channels ADD COLUMN chat_type TEXT DEFAULT 'channel'", name: "chat_type" },
      { sql: "ALTER TABLE files ADD COLUMN usage_count INTEGER DEFAULT 0", name: "usage_count" },
      { sql: "ALTER TABLE users ADD COLUMN created_at INTEGER DEFAULT 0", name: "users.created_at" },
    ];

    for (const { sql, name } of alterStatements) {
      try {
        db.exec(sql);
      } catch (err) {
        if (!String(err.message).includes("duplicate column name")) {
          logger.warn(`Warning while adding ${name}:`, err.message);
        }
      }
    }

    db.exec(`CREATE TABLE IF NOT EXISTS user_channel_joins (
      user_id INTEGER,
      channel_id INTEGER,
      PRIMARY KEY (user_id, channel_id)
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS dynamic_admins (
      id INTEGER PRIMARY KEY
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS pending_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      message_id INTEGER,
      delete_at INTEGER
    )`);

    const defaults = [
      ["is_force_view_enabled", true],
      ["caption_text", "برای دانلود فایل‌های بیشتر، در کانال ما عضو شوید."],
      ["delete_timeout_ms", 30000],
      [
        "force_view_message_text",
        "🔔 لطفاً ۱۰ ثانیه کانال ما را بررسی کنید و ریکشن بزنید تا فایل‌ها برای شما ارسال شوند.",
      ],
      ["is_bot_enabled", true],
      ["flood_limit_count", 10],
      ["file_storage_channel", "@hadiking00123"],
      ["regular_user_start_text", ""],
      ["broadcast_speed_profile", "safe"],
    ];

    for (const [key, value] of defaults) {
      const val = getSetting(key);
      if (val === null) {
        setSetting(key, JSON.stringify(value));
      }
    }

    refreshCachedSettings();
  } catch (err) {
    logger.error("Error connecting to SQLite database:", err.message);
    throw err;
  }
}

function runQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}

function getQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params) || null;
}

function allQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function getSetting(key) {
  const row = getQuery("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
    key,
    value,
  ]);
  cachedSettings = null;
  logger.debug(`Setting '${key}' changed and cache invalidated.`);
  refreshCachedSettings();
}

function refreshCachedSettings() {
  const defaultSettings = {
    caption_text: "برای دانلود فایل‌های بیشتر، در کانال ما عضو شوید.",
    delete_timeout_ms: 30000,
    force_view_message_text:
      "🔔 لطفاً ۱۰ ثانیه کانال ما را بررسی کنید و ریکشن بزنید تا فایل‌ها برای شما ارسال شوند.",
    is_force_view_enabled: true,
    is_bot_enabled: true,
    flood_limit_count: 10,
    file_storage_channel: "@hadiking00123",
    regular_user_start_text: "",
    broadcast_speed_profile: "safe",
  };

  const settings = {};
  for (const key in defaultSettings) {
    let value = getSetting(key);
    if (value === null) {
      setSetting(key, JSON.stringify(defaultSettings[key]));
      settings[key] = defaultSettings[key];
    } else {
      try {
        settings[key] = JSON.parse(value);
      } catch (e) {
        logger.warn(`Failed to parse setting '${key}' value '${value}'. Using raw value.`, e);
        settings[key] = value;
      }
    }
  }
  cachedSettings = settings;
  logger.debug("Bot settings cached.");
  return settings;
}

function getBotSettingsCached() {
  if (!cachedSettings) {
    return refreshCachedSettings();
  }
  return cachedSettings;
}

function readDB() {
  const settings = getBotSettingsCached();
  const users = allQuery("SELECT id, link_usage_count, created_at FROM users");
  const userIds = users.map((row) => row.id);
  const bannedUsers = allQuery("SELECT id FROM banned_users").map(
    (row) => row.id
  );
  const forceJoinChannels = allQuery(
    "SELECT id, title, invite_link, button_text, chat_type, condition_type, condition_limit, current_members_count FROM force_join_channels"
  );
  const forceJoinExtraLinks = allQuery(
    "SELECT id, title, invite_link, button_text FROM force_join_extra_links ORDER BY id ASC"
  );
  const files = allQuery("SELECT * FROM files");

  const forceJoin = forceJoinChannels.map((channel) => ({
    id: channel.id,
    title: channel.title,
    invite_link: channel.invite_link,
    button_text: channel.button_text,
    chat_type: channel.chat_type || "channel",
    condition: channel.condition_type
      ? {
          type: channel.condition_type,
          limit: channel.condition_limit,
          current_count: channel.current_members_count,
        }
      : null,
    joinedUsers: [],
  }));

  const extraForceJoinLinks = forceJoinExtraLinks.map((link) => ({
    id: link.id,
    title: link.title,
    invite_link: link.invite_link,
    button_text: link.button_text,
  }));

  const parsedFiles = files.map((file) => {
    const parsedFile = {
      file_identifier: file.file_identifier,
      file_id: file.file_id,
      file_type: file.file_type,
      user_caption: file.user_caption,
      caption: file.caption,
      usage_count: file.usage_count,
    };
    if (file.file_ids_json) parsedFile.file_ids = JSON.parse(file.file_ids_json);
    if (file.file_types_json) parsedFile.file_types = JSON.parse(file.file_types_json);
    if (file.user_captions_json) parsedFile.user_captions = JSON.parse(file.user_captions_json);
    return parsedFile;
  });

  return {
    settings,
    users: userIds,
    allUsersData: users,
    bannedUsers,
    forceJoin,
    extraForceJoinLinks,
    files: parsedFiles,
  };
}

function saveUser(userId) {
  const now = Date.now();
  const existingUser = getQuery("SELECT id, created_at FROM users WHERE id = ?", [userId]);
  if (!existingUser) {
    runQuery("INSERT INTO users (id, link_usage_count, created_at) VALUES (?, ?, ?)", [
      userId,
      0,
      now,
    ]);
    logger.info(`New user registered: ${userId}`);
  } else if (!existingUser.created_at || Number(existingUser.created_at) <= 0) {
    runQuery("UPDATE users SET created_at = ? WHERE id = ?", [now, userId]);
  }
}

function deleteFileByIdentifier(fileIdentifier) {
  try {
    const result = runQuery("DELETE FROM files WHERE file_identifier = ?", [
      fileIdentifier,
    ]);
    if (result.changes > 0) {
      logger.info(`File deleted from DB: ${fileIdentifier}`);
    } else {
      logger.warn(`Delete requested for missing file: ${fileIdentifier}`);
    }
    return { success: result.changes > 0, changes: result.changes };
  } catch (error) {
    logger.error(`Error deleting file ${fileIdentifier}:`, error);
    return { success: false, changes: 0, error: error.message };
  }
}

function getDynamicAdminIds() {
  const rows = allQuery("SELECT id FROM dynamic_admins");
  return rows.map((row) => row.id);
}

function addDynamicAdminDB(adminId) {
  try {
    runQuery("INSERT OR IGNORE INTO dynamic_admins (id) VALUES (?)", [adminId]);
    return true;
  } catch (error) {
    logger.error(`Error adding admin ${adminId}:`, error);
    return false;
  }
}

function removeDynamicAdminDB(adminId) {
  try {
    const result = runQuery("DELETE FROM dynamic_admins WHERE id = ?", [adminId]);
    return result.changes > 0;
  } catch (error) {
    logger.error(`Error removing admin ${adminId}:`, error);
    return false;
  }
}

function scheduleDeletion(chatId, messageId, deleteAt) {
  runQuery(
    "INSERT INTO pending_deletions (chat_id, message_id, delete_at) VALUES (?, ?, ?)",
    [chatId, messageId, deleteAt]
  );
}

function getExpiredDeletions() {
  const now = Date.now();
  return allQuery("SELECT id, chat_id, message_id FROM pending_deletions WHERE delete_at <= ?", [now]);
}

function removeDeletion(id) {
  runQuery("DELETE FROM pending_deletions WHERE id = ?", [id]);
}

module.exports = {
  initializeDatabase,
  runQuery,
  getQuery,
  allQuery,
  getSetting,
  setSetting,
  getBotSettingsCached,
  readDB,
  saveUser,
  deleteFileByIdentifier,
  getDynamicAdminIds,
  addDynamicAdminDB,
  removeDynamicAdminDB,
  scheduleDeletion,
  getExpiredDeletions,
  removeDeletion,
};
