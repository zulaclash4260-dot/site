const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const winston = require("winston");

// Configure Winston Logger for db.js
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp({ format: "HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      level: "error",
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          ({ level, message, timestamp, stack }) =>
            `${timestamp} ${level}: ${message}${stack ? `\n${stack}` : ""}`
        )
      ),
    }),
    new winston.transports.File({ filename: "bot.log" }),
  ],
});

const DB_FILE = path.join(__dirname, "database.sqlite");

let db;
let cachedSettings = null;

function persistDatabase() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

async function initializeDatabase() {
  try {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file),
    });

    if (fs.existsSync(DB_FILE)) {
      const fileBuffer = fs.readFileSync(DB_FILE);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    logger.info("Connected to SQLite database.");

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      link_usage_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS force_join_channels (
      id INTEGER PRIMARY KEY,
      title TEXT,
      invite_link TEXT,
      button_text TEXT,
      chat_type TEXT DEFAULT 'channel',
      condition_type TEXT,
      condition_limit INTEGER,
      current_members_count INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS force_join_extra_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      invite_link TEXT,
      button_text TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS files (
      file_identifier TEXT PRIMARY KEY,
      file_id TEXT,
      file_type TEXT,
      file_ids_json TEXT,
      file_types_json TEXT,
      user_caption TEXT,
      user_captions_json TEXT,
      usage_count INTEGER DEFAULT 0
    )`);

    try {
      db.run("ALTER TABLE force_join_channels ADD COLUMN current_members_count INTEGER DEFAULT 0");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) {
        logger.warn("Warning while adding current_members_count:", err.message);
      }
    }

    try {
      db.run("ALTER TABLE force_join_channels ADD COLUMN button_text TEXT");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) {
        logger.warn("Warning while adding button_text:", err.message);
      }
    }

    try {
      db.run("ALTER TABLE force_join_channels ADD COLUMN chat_type TEXT DEFAULT 'channel'");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) {
        logger.warn("Warning while adding chat_type:", err.message);
      }
    }

    try {
      db.run("ALTER TABLE files ADD COLUMN usage_count INTEGER DEFAULT 0");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) {
        logger.warn("Warning while adding usage_count:", err.message);
      }
    }

    try {
      db.run("ALTER TABLE users ADD COLUMN created_at INTEGER DEFAULT 0");
    } catch (err) {
      if (!String(err.message).includes("duplicate column name")) {
        logger.warn("Warning while adding users.created_at:", err.message);
      }
    }

    db.run(`CREATE TABLE IF NOT EXISTS user_channel_joins (
      user_id INTEGER,
      channel_id INTEGER,
      PRIMARY KEY (user_id, channel_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS dynamic_admins (
      id INTEGER PRIMARY KEY
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
      const val = await getSetting(key);
      if (val === null) {
        await setSetting(key, JSON.stringify(value));
      }
    }

    await refreshCachedSettings();
    persistDatabase();
  } catch (err) {
    logger.error("Error connecting to SQLite database:", err.message);
    throw err;
  }
}

function runQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();

  const changesRes = db.exec("SELECT changes() AS changes");
  const changes = changesRes?.[0]?.values?.[0]?.[0] ?? 0;
  const rowIdRes = db.exec("SELECT last_insert_rowid() AS lastInsertRowid");
  const lastInsertRowid = rowIdRes?.[0]?.values?.[0]?.[0] ?? 0;

  persistDatabase();
  return { changes, lastInsertRowid };
}

function getQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const hasRow = stmt.step();
  const row = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function allQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function getSetting(key) {
  const row = await getQuery("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
    key,
    value,
  ]);
  cachedSettings = null;
  logger.debug(`Setting '${key}' changed and cache invalidated.`);
  await refreshCachedSettings();
}

async function refreshCachedSettings() {
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
    let value = await getSetting(key);
    if (value === null) {
      await setSetting(key, JSON.stringify(defaultSettings[key]));
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

async function getBotSettingsCached() {
  if (!cachedSettings) {
    return refreshCachedSettings();
  }
  return cachedSettings;
}

async function readDB() {
  const settings = await getBotSettingsCached();
  const users = await allQuery("SELECT id, link_usage_count, created_at FROM users");
  const userIds = users.map((row) => row.id);
  const bannedUsers = (await allQuery("SELECT id FROM banned_users")).map(
    (row) => row.id
  );
  const forceJoinChannels = await allQuery(
    "SELECT id, title, invite_link, button_text, chat_type, condition_type, condition_limit, current_members_count FROM force_join_channels"
  );
  const forceJoinExtraLinks = await allQuery(
    "SELECT id, title, invite_link, button_text FROM force_join_extra_links ORDER BY id ASC"
  );
  const files = await allQuery("SELECT * FROM files");

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

async function saveUser(userId) {
  const now = Date.now();
  const existingUser = await getQuery("SELECT id, created_at FROM users WHERE id = ?", [userId]);
  if (!existingUser) {
    await runQuery("INSERT INTO users (id, link_usage_count, created_at) VALUES (?, ?, ?)", [
      userId,
      0,
      now,
    ]);
    logger.info(`New user registered: ${userId}`);
  } else if (!existingUser.created_at || Number(existingUser.created_at) <= 0) {
    await runQuery("UPDATE users SET created_at = ? WHERE id = ?", [now, userId]);
  }
}

async function deleteFileByIdentifier(fileIdentifier) {
  try {
    const result = await runQuery("DELETE FROM files WHERE file_identifier = ?", [
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

async function getDynamicAdminIds() {
  const rows = await allQuery("SELECT id FROM dynamic_admins");
  return rows.map((row) => row.id);
}

async function addDynamicAdminDB(adminId) {
  try {
    await runQuery("INSERT OR IGNORE INTO dynamic_admins (id) VALUES (?)", [adminId]);
    return true;
  } catch (error) {
    logger.error(`Error adding admin ${adminId}:`, error);
    return false;
  }
}

async function removeDynamicAdminDB(adminId) {
  try {
    const result = await runQuery("DELETE FROM dynamic_admins WHERE id = ?", [adminId]);
    return result.changes > 0;
  } catch (error) {
    logger.error(`Error removing admin ${adminId}:`, error);
    return false;
  }
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
};
