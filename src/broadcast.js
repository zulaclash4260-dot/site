const { logger } = require("./config");
const { allQuery, readDB } = require("../db");

const BROADCAST_PROFILE_LABELS = {
  safe: "ایمن",
  balanced: "متعادل",
  fast: "سریع",
};

const BROADCAST_SPEED_PROFILES = {
  safe: {
    messageDelayMinMs: 2200,
    messageDelayMaxMs: 3000,
    batchSize: 20,
    batchPauseMs: 4000,
    delayIncreaseStep: 450,
    delayDecreaseStep: 25,
    maxAdaptiveDelayMinMs: 6000,
    maxAdaptiveDelayMaxMs: 8000,
    maxRetries: 5,
    safetyIdleEveryMessages: 25,
    safetyIdleMs: 2000,
  },
  balanced: {
    messageDelayMinMs: 1700,
    messageDelayMaxMs: 2400,
    batchSize: 35,
    batchPauseMs: 2500,
    delayIncreaseStep: 350,
    delayDecreaseStep: 30,
    maxAdaptiveDelayMinMs: 4500,
    maxAdaptiveDelayMaxMs: 6500,
    maxRetries: 5,
    safetyIdleEveryMessages: 40,
    safetyIdleMs: 1500,
  },
  fast: {
    messageDelayMinMs: 1300,
    messageDelayMaxMs: 1900,
    batchSize: 45,
    batchPauseMs: 1500,
    delayIncreaseStep: 300,
    delayDecreaseStep: 35,
    maxAdaptiveDelayMinMs: 3800,
    maxAdaptiveDelayMaxMs: 5200,
    maxRetries: 5,
    safetyIdleEveryMessages: 60,
    safetyIdleMs: 1000,
  },
};

const REPORT_INTERVAL_MS = 5 * 60 * 1000;

let isBroadcastInProgress = false;

function resolveBroadcastProfile(profileKeyRaw) {
  const profileKey =
    typeof profileKeyRaw === "string"
      ? profileKeyRaw.trim().toLowerCase()
      : "safe";
  if (BROADCAST_SPEED_PROFILES[profileKey]) {
    return { key: profileKey, config: BROADCAST_SPEED_PROFILES[profileKey] };
  }
  return { key: "safe", config: BROADCAST_SPEED_PROFILES.safe };
}

async function broadcastMessage(ctx, bot) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (isBroadcastInProgress) {
    await bot.api.sendMessage(
      ctx.from.id,
      "⚠️ یک ارسال همگانی دیگر در حال اجرا است. لطفاً بعد از اتمام آن دوباره تلاش کنید."
    );
    return;
  }

  isBroadcastInProgress = true;

  try {
    const dbData = await readDB();
    const { key: speedProfileKey, config: speedProfile } =
      resolveBroadcastProfile(dbData.settings.broadcast_speed_profile);
    const speedProfileLabel = BROADCAST_PROFILE_LABELS[speedProfileKey];

    const users = await allQuery("SELECT id FROM users");
    const bannedUsers = await allQuery("SELECT id FROM banned_users");
    const bannedSet = new Set(bannedUsers.map((row) => row.id));
    const broadcasterId = ctx.from?.id;

    const activeUsers = users
      .map((row) => row.id)
      .filter((userId) => !bannedSet.has(userId) && userId !== broadcasterId);

    if (activeUsers.length === 0) {
      await bot.api.sendMessage(
        ctx.from.id,
        "هیچ کاربر فعالی برای ارسال پیام یافت نشد."
      );
      logger.warn(
        `تلاش برای ارسال همگانی به صفر کاربر فعال توسط ${ctx.from?.id}.`
      );
      return;
    }

    let sentCount = 0;
    let failedCount = 0;
    let hasForwardAccessWarningSent = false;
    const startedAt = Date.now();
    let lastProgressReportAt = Date.now();

    let currentDelayMin = speedProfile.messageDelayMinMs;
    let currentDelayMax = speedProfile.messageDelayMaxMs;

    const messageType = ctx.session.broadcastMessageType;
    const messageOptions = ctx.session.broadcastMessageOptions || {};
    const copyOptions =
      Object.keys(messageOptions).length > 0 ? messageOptions : undefined;
    const originalMessageId = ctx.session.broadcastOriginalMessageId;
    const sourceChatId = ctx.chat?.id;

    if (messageType !== "forwarded_message" && !sourceChatId) {
      await bot.api.sendMessage(
        ctx.from.id,
        "❌ خطا: چت مبدا برای کپی پیام پیدا نشد. لطفاً دوباره تلاش کنید."
      );
      logger.error("Source chat id is missing for copyMessage broadcast.");
      return;
    }

    logger.info(
      `عملیات ارسال همگانی به ${activeUsers.length} کاربر آغاز شد. پروفایل سرعت: ${speedProfileKey}`
    );
    await bot.api.sendMessage(
      ctx.from.id,
      `🚀 ارسال همگانی شروع شد.\n- تعداد گیرنده‌ها: ${activeUsers.length}\n- پروفایل سرعت: ${speedProfileLabel}\n- گزارش پیشرفت: هر ۵ دقیقه`
    );

    async function maybeSendProgressReport(force = false) {
      const now = Date.now();
      if (!force && now - lastProgressReportAt < REPORT_INTERVAL_MS) {
        return;
      }

      const processed = sentCount + failedCount;
      const elapsedMs = Math.max(1, now - startedAt);
      const speedPerHour = (processed * 3600000) / elapsedMs;
      const remaining = Math.max(0, activeUsers.length - processed);
      const etaMinutes =
        processed > 0
          ? Math.ceil((remaining * (elapsedMs / processed)) / 60000)
          : null;

      const progressText = [
        "📊 گزارش دوره‌ای ارسال همگانی (هر ۵ دقیقه):",
        "",
        `- پروفایل سرعت: ${speedProfileLabel}`,
        `- کل گیرنده‌ها: ${activeUsers.length}`,
        `- پردازش‌شده: ${processed}`,
        `- موفق: ${sentCount}`,
        `- ناموفق: ${failedCount}`,
        `- سرعت تقریبی: ${speedPerHour.toFixed(0)} ارسال در ساعت`,
        `- زمان باقی‌مانده تقریبی: ${
          etaMinutes === null ? "نامشخص" : `${etaMinutes} دقیقه`
        }`,
      ].join("\n");

      try {
        await bot.api.sendMessage(ctx.from.id, progressText);
      } catch (reportError) {
        logger.warn(
          `ارسال گزارش دوره‌ای به ادمین ${ctx.from?.id} ناموفق بود: ${reportError.message}`
        );
      }

      lastProgressReportAt = Date.now();
    }

    for (let i = 0; i < activeUsers.length; i += speedProfile.batchSize) {
      const batch = activeUsers.slice(i, i + speedProfile.batchSize);
      logger.info(
        `شروع ارسال دسته ${Math.floor(i / speedProfile.batchSize) + 1} از ${Math.ceil(
          activeUsers.length / speedProfile.batchSize
        )} (شامل ${batch.length} کاربر).`
      );

      for (const [indexInBatch, userId] of batch.entries()) {
        let messageSentSuccessfully = false;
        let retries = 0;

        while (
          !messageSentSuccessfully &&
          retries < speedProfile.maxRetries
        ) {
          try {
            if (messageType === "forwarded_message") {
              const { chat_id, message_id } =
                ctx.session.broadcastMessageContent;
              await bot.api.forwardMessage(userId, chat_id, message_id);
            } else if (copyOptions) {
              await bot.api.copyMessage(
                userId,
                sourceChatId,
                originalMessageId,
                copyOptions
              );
            } else {
              await bot.api.copyMessage(
                userId,
                sourceChatId,
                originalMessageId
              );
            }

            sentCount++;
            messageSentSuccessfully = true;

            currentDelayMin = Math.max(
              speedProfile.messageDelayMinMs,
              currentDelayMin - speedProfile.delayDecreaseStep
            );
            currentDelayMax = Math.max(
              speedProfile.messageDelayMaxMs,
              currentDelayMax - speedProfile.delayDecreaseStep
            );
          } catch (e) {
            if (
              e.description &&
              e.description.includes("Too Many Requests") &&
              e.parameters &&
              e.parameters.retry_after
            ) {
              const retryAfter = e.parameters.retry_after;
              logger.warn(
                `دریافت خطای 429 برای کاربر ${userId}. مکث به مدت ${
                  retryAfter + 1
                } ثانیه (تلاش ${retries + 1}/${speedProfile.maxRetries}).`
              );

              await sleep((retryAfter + 1) * 1000);
              currentDelayMin = Math.min(
                currentDelayMin + speedProfile.delayIncreaseStep,
                speedProfile.maxAdaptiveDelayMinMs
              );
              currentDelayMax = Math.min(
                currentDelayMax + speedProfile.delayIncreaseStep,
                speedProfile.maxAdaptiveDelayMaxMs
              );
              retries++;
            } else {
              failedCount++;
              logger.error(`خطا در ارسال پیام به کاربر ${userId}: ${e.message}`);

              if (e.message.includes("bot was blocked by the user")) {
                logger.info(`کاربر ${userId} ربات را بلاک کرده است.`);
              } else if (
                e.message.includes("chat not found") ||
                e.message.includes("user is deactivated")
              ) {
                logger.info(`کاربر ${userId} یافت نشد یا غیرفعال است.`);
              } else if (
                e.message.includes("message to forward not found") &&
                messageType === "forwarded_message"
              ) {
                logger.warn(
                  `خطا در فوروارد پیام به کاربر ${userId}: پیام اصلی در چت مبدا یافت نشد.`
                );
                if (!hasForwardAccessWarningSent) {
                  hasForwardAccessWarningSent = true;
                  await bot.api.sendMessage(
                    ctx.from.id,
                    `❌ هشدار: برخی از پیام‌های فوروارد شده ارسال نشدند! دلیل: "پیام اصلی یافت نشد" یا "ربات به چت مبدأ دسترسی ندارد".\n\nبرای اطمینان از ارسال موفق، لطفاً از گزینه "ارسال پیام جدید (با حفظ فرمت)" برای پیام‌هایی که از کانال‌ها/گروه‌های خصوصی دریافت می‌کنید، استفاده کنید.`
                  );
                }
              } else if (
                e.message.includes("message can't be copied") &&
                messageType !== "forwarded_message"
              ) {
                logger.warn(
                  `خطا در کپی/ارسال پیام به کاربر ${userId}: ${e.message}.`
                );
              }

              messageSentSuccessfully = true;
            }
          }
        }

        if (!messageSentSuccessfully) {
          failedCount++;
          logger.warn(
            `ارسال به کاربر ${userId} پس از ${speedProfile.maxRetries} تلاش ناموفق بود (احتمالاً 429 تکراری).`
          );
        }

        const processed = sentCount + failedCount;
        if (
          processed > 0 &&
          processed % speedProfile.safetyIdleEveryMessages === 0
        ) {
          await sleep(speedProfile.safetyIdleMs);
        }

        if (indexInBatch < batch.length - 1 && messageSentSuccessfully) {
          const randomDelay =
            Math.random() * (currentDelayMax - currentDelayMin) +
            currentDelayMin;
          await sleep(randomDelay);
        }

        await maybeSendProgressReport();
      }

      if (i + speedProfile.batchSize < activeUsers.length) {
        logger.info(
          `پایان دسته ${Math.floor(i / speedProfile.batchSize) + 1}. مکث ${
            speedProfile.batchPauseMs / 1000
          } ثانیه قبل از دسته بعدی.`
        );
        await sleep(speedProfile.batchPauseMs);
        await maybeSendProgressReport();
      }
    }

    await maybeSendProgressReport(true);
    await bot.api.sendMessage(
      ctx.from.id,
      `✅ عملیات ارسال همگانی تمام شد.\n\n- پروفایل سرعت: ${speedProfileLabel}\n- موفق: ${sentCount} کاربر\n- ناموفق: ${failedCount} کاربر`
    );
    logger.info(
      `عملیات ارسال همگانی پایان یافت. موفق: ${sentCount}, ناموفق: ${failedCount}.`
    );
  } catch (error) {
    logger.error(`خطا در ارسال همگانی: ${error.message}`, error);
    try {
      await bot.api.sendMessage(
        ctx.from.id,
        `❌ خطا در عملیات ارسال همگانی:\n${error.message}`
      );
    } catch (notifyError) {
      logger.warn(
        `ارسال خطای برودکست به ادمین ${ctx.from?.id} ناموفق بود: ${notifyError.message}`
      );
    }
  } finally {
    isBroadcastInProgress = false;
  }
}

module.exports = { broadcastMessage };
