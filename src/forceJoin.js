const { InlineKeyboard } = require("grammy");
const { logger, ADMIN_IDs } = require("./config");
const { runQuery, getQuery, readDB } = require("../db");

const UNAVAILABLE_RETRY_MS = 10 * 60 * 1000;
const UNAVAILABLE_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

// channel_id -> retry timestamp
const unavailableForceJoinTargetsUntil = new Map();
// channel_id -> last notify timestamp
const unavailableTargetNotifyCache = new Map();

function isMemberStatusAccepted(member) {
  if (!member || !member.status) return false;

  if (
    member.status === "member" ||
    member.status === "administrator" ||
    member.status === "creator"
  ) {
    return true;
  }

  if (member.status === "restricted" && member.is_member) {
    return true;
  }

  return false;
}

function resolveRequiredButtonText(channel) {
  const custom =
    typeof channel.button_text === "string" ? channel.button_text.trim() : "";
  if (custom) return custom;
  return `عضویت در ${channel.title}`;
}

function resolveExtraButtonText(extraLink, index) {
  const custom =
    typeof extraLink.button_text === "string"
      ? extraLink.button_text.trim()
      : "";
  if (custom) return custom;

  const title =
    typeof extraLink.title === "string" ? extraLink.title.trim() : "";
  if (title) return `🔗 ${title}`;

  return `🔗 لینک کمکی ${index + 1}`;
}

function getApiErrorDescription(error) {
  const desc =
    error?.description || error?.message || error?.error_description || String(error);
  return typeof desc === "string" ? desc : String(desc);
}

function isUnavailableTargetError(error) {
  const desc = getApiErrorDescription(error).toLowerCase();
  return (
    desc.includes("chat not found") ||
    desc.includes("bot is not a member of the channel chat") ||
    desc.includes("member list is inaccessible") ||
    desc.includes("chat_admin_required") ||
    desc.includes("forbidden")
  );
}

function isMessageNotModifiedError(error) {
  const desc = getApiErrorDescription(error).toLowerCase();
  return desc.includes("message is not modified");
}

async function notifyAdminsAboutUnavailableTargets(ctx, channels) {
  for (const channel of channels) {
    const cacheKey = String(channel.id);
    const now = Date.now();
    const lastNotifyAt = unavailableTargetNotifyCache.get(cacheKey) || 0;
    if (now - lastNotifyAt < UNAVAILABLE_NOTIFY_COOLDOWN_MS) continue;
    unavailableTargetNotifyCache.set(cacheKey, now);

    const reason = channel.unavailable_reason || "unknown";
    const warningMessage =
      "⚠️ هشدار جوین اجباری:\n\n" +
      `آیتم زیر موقتاً از بررسی عضویت خارج شد چون ربات به آن دسترسی ندارد.\n\n` +
      `عنوان: ${channel.title}\n` +
      `شناسه: ${channel.id}\n` +
      `علت: ${reason}\n\n` +
      "اقدام لازم: ربات را در کانال/گروه ادمین کنید یا آیتم را اصلاح/حذف کنید.";

    for (const adminId of ADMIN_IDs) {
      try {
        await ctx.api.sendMessage(adminId, warningMessage);
      } catch (sendErr) {
        logger.warn(
          `خطا در ارسال هشدار آیتم جوین نامعتبر به ادمین ${adminId}: ${getApiErrorDescription(
            sendErr
          )}`
        );
      }
    }
  }
}

async function evaluateUserSubscription(ctx, userId, requiredTargets) {
  const missingChannels = [];
  const subscribedChannels = [];
  const unavailableChannels = [];
  const now = Date.now();

  for (const channel of requiredTargets) {
    const retryAt = unavailableForceJoinTargetsUntil.get(channel.id);
    if (retryAt && now < retryAt) {
      // Channel is unavailable: treat user as NOT subscribed to prevent bypass
      missingChannels.push(channel);
      unavailableChannels.push({
        ...channel,
        unavailable_reason: "هنوز در دوره عدم دسترسی است",
      });
      continue;
    }
    if (retryAt && now >= retryAt) {
      unavailableForceJoinTargetsUntil.delete(channel.id);
    }

    try {
      const member = await ctx.api.getChatMember(channel.id, userId);
      if (!isMemberStatusAccepted(member)) {
        missingChannels.push(channel);
        continue;
      }
      subscribedChannels.push(channel);
    } catch (error) {
      const reason = getApiErrorDescription(error);
      if (isUnavailableTargetError(error)) {
        unavailableForceJoinTargetsUntil.set(channel.id, now + UNAVAILABLE_RETRY_MS);
        unavailableChannels.push({
          ...channel,
          unavailable_reason: reason,
        });
        logger.warn(
          `آیتم جوین اجباری ${channel.id} (${channel.title}) موقتاً از چک خارج شد: ${reason}`
        );
        // Treat as missing to prevent bypass
        missingChannels.push(channel);
        continue;
      }

      logger.error(
        `خطا در بررسی عضویت کاربر ${userId} در کانال/گروه ${channel.id} (${channel.title}): ${reason}`
      );
      missingChannels.push(channel);
    }
  }

  return {
    allSubscribed: missingChannels.length === 0,
    missingChannels,
    subscribedChannels,
    unavailableChannels,
  };
}

function buildJoinMessage(missingChannels, extraLinks) {
  let joinMessage =
    "🔔 لطفاً ابتدا در کانال‌ها/گروه‌های زیر عضو شوید و سپس دکمه تایید را بزنید:\n\n";

  missingChannels.forEach((channel) => {
    joinMessage += `- *${channel.title}*\n`;
  });

  if (extraLinks.length > 0) {
    joinMessage +=
      "\n🔗 لینک‌های زیر اختیاری هستند (برای دسترسی بیشتر) و بررسی عضویت برای آن‌ها انجام نمی‌شود:\n";
  }

  return joinMessage;
}

function buildJoinKeyboard(missingChannels, extraLinks, fileIdentifier) {
  const keyboard = new InlineKeyboard();

  missingChannels.forEach((channel) => {
    if (channel.invite_link) {
      keyboard.url(resolveRequiredButtonText(channel), channel.invite_link).row();
    }
  });

  extraLinks.forEach((link, index) => {
    if (link.invite_link) {
      keyboard.url(resolveExtraButtonText(link, index), link.invite_link).row();
    }
  });

  const callbackData = `check_sub:${fileIdentifier || "no_file"}`;
  keyboard.text("✅ تایید عضویت", callbackData);

  return keyboard;
}

async function sendJoinMessage(
  ctx,
  missingChannels,
  extraLinks = [],
  fileIdentifier = "no_file"
) {
  const safeExtraLinks = Array.isArray(extraLinks) ? extraLinks : [];
  const joinMessage = buildJoinMessage(missingChannels, safeExtraLinks);
  const keyboard = buildJoinKeyboard(
    missingChannels,
    safeExtraLinks,
    fileIdentifier
  );

  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(joinMessage, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(joinMessage, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    }
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      logger.debug(`پیام عضویت اجباری برای کاربر ${ctx.from?.id} تغییری نداشت.`);
      return;
    }

    logger.error(
      `خطا در ارسال پیام عضویت اجباری به کاربر ${ctx.from?.id}: ${getApiErrorDescription(
        error
      )}`
    );

    // Fallback to a new message if edit fails.
    try {
      await ctx.reply(joinMessage, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } catch (fallbackError) {
      logger.error(
        `خطا در ارسال پیام جایگزین عضویت اجباری به کاربر ${
          ctx.from?.id
        }: ${getApiErrorDescription(fallbackError)}`
      );
    }
  }
}

/**
 * Check if a user is subscribed to all required force-join channels/groups.
 * If not, sends a message with join buttons and returns false.
 * Also tracks member counts for auto-removal conditions.
 */
async function checkUserSubscription(ctx, userId) {
  const dbData = await readDB();

  if (dbData.forceJoin.length === 0) {
    return true;
  }

  const { allSubscribed, missingChannels, subscribedChannels, unavailableChannels } =
    await evaluateUserSubscription(ctx, userId, dbData.forceJoin);

  if (unavailableChannels.length > 0) {
    await notifyAdminsAboutUnavailableTargets(ctx, unavailableChannels);
  }

  for (const channel of subscribedChannels) {
    if (channel.condition && channel.condition.type === "members") {
      await trackChannelJoin(ctx, userId, channel);
    }
  }

  if (!allSubscribed) {
    ctx.session.is_pending_subscription = true;
    await sendJoinMessage(
      ctx,
      missingChannels,
      dbData.extraForceJoinLinks,
      ctx.session.currentFileIdentifier || "no_file"
    );
    return false;
  }

  ctx.session.is_pending_subscription = false;
  return true;
}

/**
 * Track that a user has joined a channel/group and check auto-removal condition.
 * Uses INSERT OR IGNORE to prevent race conditions with duplicate inserts.
 */
async function trackChannelJoin(ctx, userId, channel) {
  const userHasJoinedBefore = await getQuery(
    "SELECT 1 FROM user_channel_joins WHERE user_id = ? AND channel_id = ?",
    [userId, channel.id]
  );

  if (!userHasJoinedBefore) {
    await runQuery(
      "INSERT OR IGNORE INTO user_channel_joins (user_id, channel_id) VALUES (?, ?)",
      [userId, channel.id]
    );
    await runQuery(
      "UPDATE force_join_channels SET current_members_count = current_members_count + 1 WHERE id = ?",
      [channel.id]
    );
    logger.info(
      `کاربر ${userId} به ${channel.title} (${channel.id}) پیوست. شمارنده اعضا افزایش یافت.`
    );

    const updatedChannel = await getQuery(
      "SELECT condition_limit, current_members_count FROM force_join_channels WHERE id = ?",
      [channel.id]
    );

    if (
      updatedChannel &&
      updatedChannel.condition_limit &&
      updatedChannel.current_members_count >= updatedChannel.condition_limit
    ) {
      await notifyAdminAndRemoveChannel(
        ctx,
        channel,
        updatedChannel.current_members_count
      );
    }
  }
}

/**
 * Notify admins and remove a force join channel/group when its member limit is reached.
 * @param {number} actualCount - The actual current count from the database
 */
async function notifyAdminAndRemoveChannel(ctx, channelInfo, actualCount) {
  const currentCount = actualCount || channelInfo.condition?.current_count || 0;
  const buttonText = resolveRequiredButtonText(channelInfo);
  const chatTypeText =
    channelInfo.chat_type === "group" || channelInfo.chat_type === "supergroup"
      ? "گروه"
      : "کانال";

  const message = `
🔔 *آیتم جوین اجباری حذف شد!* 🔔
تعداد کاربران عضو شده به حد نصاب رسید.

*مشخصات:*
- *عنوان:* ${channelInfo.title}
- *نوع:* ${chatTypeText}
- *شناسه:* \`${channelInfo.id}\`
- *لینک دعوت:* ${channelInfo.invite_link}
- *متن دکمه:* ${buttonText}
- *نوع شرط:* ${
    channelInfo.condition?.type === "members" ? "بر اساس تعداد عضو" : "نامشخص"
  }
- *حد نصاب تعیین شده:* ${channelInfo.condition?.limit} کاربر
- *تعداد کاربران عضو شده:* ${currentCount} کاربر
`.trim();

  await runQuery("DELETE FROM force_join_channels WHERE id = ?", [
    channelInfo.id,
  ]);
  await runQuery("DELETE FROM user_channel_joins WHERE channel_id = ?", [
    channelInfo.id,
  ]);

  for (const adminId of ADMIN_IDs) {
    try {
      await ctx.api.sendMessage(adminId, message, { parse_mode: "Markdown" });
    } catch (error) {
      logger.error(`خطا در ارسال پیام حذف آیتم به ادمین ${adminId}:`, error);
    }
  }

  logger.info(
    `آیتم جوین اجباری حذف شد: ${channelInfo.title} (${channelInfo.id})`
  );
}

/**
 * Register force join related callback handlers on the bot.
 * @param {object} bot - The bot instance
 * @param {Function} handleFileRequest - Handler for file requests
 * @param {Function} onSubscriptionConfirmed - Called after subscription confirmed with no file (to show start content)
 */
function registerForceJoinHandlers(bot, handleFileRequest, onSubscriptionConfirmed) {
  bot.callbackQuery(/^check_sub:(.*)/, async (ctx) => {
    const fileIdentifier = ctx.match[1];
    const userId = ctx.from.id;

    const dbData = await readDB();

    if (dbData.forceJoin.length === 0) {
      try {
        await ctx.answerCallbackQuery({
          text: "✅ هیچ کانال/گروه اجباری‌ای تنظیم نشده است.",
        });
      } catch (e) {
        logger.debug(
          `خطا در answerCallbackQuery (بدون آیتم اجباری): ${e.message}`
        );
      }

      if (fileIdentifier && fileIdentifier !== "no_file") {
        await handleFileRequest(ctx, fileIdentifier);
      } else if (typeof onSubscriptionConfirmed === "function") {
        await onSubscriptionConfirmed(ctx);
      } else {
        await ctx.reply("✅ عضویت شما با موفقیت تایید شد!");
      }
      return;
    }

    const { allSubscribed, missingChannels, subscribedChannels, unavailableChannels } =
      await evaluateUserSubscription(ctx, userId, dbData.forceJoin);

    if (unavailableChannels.length > 0) {
      await notifyAdminsAboutUnavailableTargets(ctx, unavailableChannels);
    }

    for (const channel of subscribedChannels) {
      if (channel.condition && channel.condition.type === "members") {
        await trackChannelJoin(ctx, userId, channel);
      }
    }

    if (!allSubscribed) {
      let alertText = "❌ شما هنوز در تمام کانال‌ها/گروه‌های مورد نیاز عضو نشده‌اید.";
      if (missingChannels.length > 0) {
        let channelList = "\nلطفاً عضو شوید:";
        for (const ch of missingChannels) {
          const entry = `\n- ${ch.title}`;
          if ((alertText + channelList + entry).length > 195) {
            channelList += "\n...";
            break;
          }
          channelList += entry;
        }
        alertText += channelList;
      }

      try {
        await ctx.answerCallbackQuery({
          text: alertText,
          show_alert: true,
        });
      } catch (e) {
        logger.warn(`خطا در ارسال alert به کاربر ${userId}: ${e.message}`);
      }

      logger.info(
        `کاربر ${userId} نتوانست تأیید جوین اجباری را تکمیل کند (عضویت ناقص).`
      );

      await sendJoinMessage(
        ctx,
        missingChannels,
        dbData.extraForceJoinLinks,
        fileIdentifier
      );
      return;
    }

    ctx.session.is_pending_subscription = false;

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      try {
        await ctx.deleteMessage();
        logger.info(
          `پیام بررسی عضویت ${ctx.callbackQuery.message.message_id} برای ${userId} پس از تایید حذف شد.`
        );
      } catch (e) {
        logger.warn(`خطا در حذف پیام بررسی عضویت برای ${userId}: ${e.message}`);
      }
    }

    if (ctx.session.forceViewMessageId) {
      try {
        await ctx.answerCallbackQuery({
          text: "✅ عضویت شما تایید شد. لطفاً دکمه 'تایید بازدید و ریکشن' را بزنید.",
        });
      } catch (e) {
        logger.debug(`خطا در answerCallbackQuery (تایید عضویت): ${e.message}`);
      }
      return;
    }

    if (fileIdentifier && fileIdentifier !== "no_file") {
      await handleFileRequest(ctx, fileIdentifier);
    } else if (typeof onSubscriptionConfirmed === "function") {
      await onSubscriptionConfirmed(ctx);
    } else {
      await ctx.reply("✅ عضویت شما با موفقیت تایید شد!");
    }

    try {
      await ctx.answerCallbackQuery();
    } catch (e) {
      logger.debug(`خطا در answerCallbackQuery (تایید نهایی): ${e.message}`);
    }
  });
}

module.exports = {
  checkUserSubscription,
  trackChannelJoin,
  notifyAdminAndRemoveChannel,
  registerForceJoinHandlers,
};
