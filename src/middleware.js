const { session } = require("grammy");
const {
  logger,
  isAdmin,
  FLOOD_LIMIT_SECONDS_GLOBAL,
  FLOOD_BAN_DURATION_MS,
} = require("./config");
const { readDB } = require("../db");

const userRateBuckets = new Map();
const temporaryBans = new Map();

function consumeToken(userId, now, capacity, windowMs) {
  const refillRatePerMs = capacity / windowMs;
  const state = userRateBuckets.get(userId) || {
    tokens: capacity,
    lastRefillAt: now,
  };

  const elapsedMs = Math.max(0, now - state.lastRefillAt);
  state.tokens = Math.min(capacity, state.tokens + elapsedMs * refillRatePerMs);
  state.lastRefillAt = now;

  if (state.tokens < 1) {
    userRateBuckets.set(userId, state);
    return false;
  }

  state.tokens -= 1;
  userRateBuckets.set(userId, state);
  return true;
}

function registerMiddleware(bot) {
  // Only process private chats
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      return;
    }
    await next();
  });

  // Ban check
  bot.use(async (ctx, next) => {
    if (!ctx.from || isAdmin(ctx)) return next();
    const dbData = await readDB();
    if (dbData.bannedUsers.includes(ctx.from.id)) {
      return;
    }
    await next();
  });

  // Bot enabled check
  bot.use(async (ctx, next) => {
    const dbData = await readDB();
    if (!dbData.settings.is_bot_enabled && !isAdmin(ctx)) {
      logger.info(`ربات غیرفعال است. پیام کاربر ${ctx.from?.id} نادیده گرفته شد.`);
      return;
    }
    await next();
  });

  // Flood/spam protection (Token Bucket)
  bot.use(async (ctx, next) => {
    if (!ctx.from || isAdmin(ctx)) return next();

    const userId = ctx.from.id;
    const now = Date.now();

    if (temporaryBans.has(userId)) {
      const banExpiresAt = temporaryBans.get(userId);
      if (now < banExpiresAt) {
        logger.warn(`کاربر ${userId} به دلیل اسپم موقتا بن شده است.`);
        return;
      }
      temporaryBans.delete(userId);
    }

    const dbData = await readDB();
    const configuredLimit = Number(dbData.settings.flood_limit_count);
    const bucketCapacity =
      Number.isFinite(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : 10;
    const windowMs = FLOOD_LIMIT_SECONDS_GLOBAL * 1000;

    const isAllowed = consumeToken(userId, now, bucketCapacity, windowMs);
    if (!isAllowed) {
      temporaryBans.set(userId, now + FLOOD_BAN_DURATION_MS);
      await ctx.reply(
        "شما به دلیل ارسال پیام‌های مکرر (اسپم)، به مدت ۱ دقیقه مسدود شدید."
      );
      logger.warn(`کاربر ${userId} به دلیل اسپم به مدت ۱ دقیقه مسدود شد.`);
      return;
    }

    await next();
  });

  // Session middleware
  bot.use(
    session({
      initial: () => ({
        step: "idle",
        pendingFile: null,
        pendingFiles: [],
        pendingChannel: null,
        pendingExtraLink: null,
        targetChannelId: null,
        is_pending_subscription: false,
        uploadMode: null,
        forceViewMessageId: null,
        currentFileForCaption: null,
        currentFileIdentifier: null,
        pendingStartMessageId: null,
        broadcastMessageContent: null,
        broadcastMessageType: null,
        broadcastMessageOptions: {},
        broadcastOriginalMessageId: null,
      }),
    })
  );
}

module.exports = { registerMiddleware };
