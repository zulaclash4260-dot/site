const { InlineKeyboard } = require("grammy");
const { logger, isAdmin } = require("./config");
const { generateFileIdentifier, safeEditOrReply } = require("./helpers");
const { checkUserSubscription } = require("./forceJoin");
const { runQuery, getQuery, readDB } = require("../db");

async function sendFileContent(
  ctx,
  file,
  captionText,
  deleteTimeoutMs,
  triggerMessageId = null
) {
  let sentMessages = [];
  const dbData = await readDB();
  deleteTimeoutMs = dbData.settings.delete_timeout_ms;

  if (file.file_ids && Array.isArray(file.file_ids)) {
    for (let i = 0; i < file.file_ids.length; i++) {
      const file_id = file.file_ids[i];
      const file_type = file.file_types[i];
      const captionToSend =
        file.user_captions &&
        file.user_captions[i] !== null &&
        file.user_captions[i] !== undefined
          ? file.user_captions[i]
          : dbData.settings.caption_text;

      let message;
      try {
        switch (file_type) {
          case "photo":
            message = await ctx.replyWithPhoto(file_id, { caption: captionToSend });
            break;
          case "video":
            message = await ctx.replyWithVideo(file_id, { caption: captionToSend });
            break;
          case "audio":
            message = await ctx.replyWithAudio(file_id, { caption: captionToSend });
            break;
          case "document":
            message = await ctx.replyWithDocument(file_id, { caption: captionToSend });
            break;
          default:
            logger.warn(`نوع فایل نامشخص برای ارسال به کاربر: ${file_type}`);
            await ctx.reply("خطا: نوع فایل نامشخص است و قابل ارسال نیست.");
            continue;
        }
        if (message) sentMessages.push(message.message_id);
        logger.info(
          `فایل ${file_id} از نوع ${file_type} به کاربر ${ctx.from?.id} ارسال شد.`
        );
      } catch (e) {
        logger.error(
          `خطا در ارسال فایل ${file_id} از نوع ${file_type} به کاربر ${ctx.from?.id}:`,
          e
        );
        await ctx.reply(
          `❌ خطایی در ارسال فایل رخ داد: ${file_type}. شاید فایل در تلگرام دیگر موجود نباشد. لطفا به ادمین اطلاع دهید.`
        );
      }
    }
  } else {
    const captionToSend =
      file.user_caption !== null && file.user_caption !== undefined
        ? file.user_caption
        : dbData.settings.caption_text;
    let message;
    try {
      switch (file.file_type) {
        case "photo":
          message = await ctx.replyWithPhoto(file.file_id, { caption: captionToSend });
          break;
        case "video":
          message = await ctx.replyWithVideo(file.file_id, { caption: captionToSend });
          break;
        case "audio":
          message = await ctx.replyWithAudio(file.file_id, { caption: captionToSend });
          break;
        case "document":
          message = await ctx.replyWithDocument(file.file_id, { caption: captionToSend });
          break;
        default:
          logger.warn(`نوع فایل نامشخص برای ارسال به کاربر: ${file.file_type}`);
          await ctx.reply("خطا: نوع فایل نامشخص است و قابل ارسال نیست.");
          return;
      }
      if (message) sentMessages.push(message.message_id);
      logger.info(
        `فایل تکی ${file.file_id} از نوع ${file.file_type} به کاربر ${ctx.from?.id} ارسال شد.`
      );
    } catch (e) {
      logger.error(
        `خطا در ارسال فایل تکی ${file.file_id} از نوع ${file.file_type} به کاربر ${ctx.from?.id}:`,
        e
      );
      await ctx.reply(
        `❌ خطایی در ارسال فایل رخ داد: ${file.file_type}. شاید فایل در تلگرام دیگر موجود نباشد. لطفا به ادمین اطلاع دهید.`
      );
    }
  }

  if (sentMessages.length > 0) {
    const resendAvailableAt = Date.now() + deleteTimeoutMs;
    const warningKeyboard = file.file_identifier
      ? new InlineKeyboard().text(
          "\uD83D\uDD04 \u062F\u0631\u06CC\u0627\u0641\u062A \u0645\u062C\u062F\u062F \u0641\u0627\u06CC\u0644",
          `resend_file:${file.file_identifier}:${resendAvailableAt}`
        )
      : undefined;

    await ctx.reply(
      `\u23F3 \u062A\u0648\u062C\u0647: \u0627\u06CC\u0646 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u062A\u0627 ${
        deleteTimeoutMs / 1000
      } \u062B\u0627\u0646\u06CC\u0647 \u062F\u06CC\u06AF\u0631 \u0628\u0635\u0648\u0631\u062A \u062E\u0648\u062F\u06A9\u0627\u0631 \u062D\u0630\u0641 \u062E\u0648\u0627\u0647\u0646\u062F \u0634\u062F.\n\n\uD83D\uDCBE \u0644\u0637\u0641\u0627\u064B \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u0631\u0627 \u0641\u0648\u0631\u0627\u064B \u0630\u062E\u06CC\u0631\u0647 (Save/Forward) \u06A9\u0646\u06CC\u062F`,
      warningKeyboard ? { reply_markup: warningKeyboard } : undefined
    );

    setTimeout(async () => {
      for (const msgId of sentMessages) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msgId);
          logger.info(`Message ${msgId} deleted for chat ${ctx.chat.id}.`);
        } catch (e) {
          logger.warn(`Failed deleting message ${msgId} for chat ${ctx.chat.id}: ${e.message}`);
        }
      }

      if (Number.isInteger(triggerMessageId)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, triggerMessageId);
          logger.info(`Trigger message ${triggerMessageId} deleted for chat ${ctx.chat.id}.`);
        } catch (e) {
          logger.warn(
            `Failed deleting trigger message ${triggerMessageId} for chat ${ctx.chat.id}: ${e.message}`
          );
        }
      }
    }, deleteTimeoutMs);
  }
}

/**
 * Handle force view confirmation and send file.
 * Fixed: clear forceViewMessageId after confirmation, better error handling for answerCallbackQuery.
 */
async function confirmAndSendFile(ctx, fileIdentifier) {
  const userId = ctx.from.id;
  const pendingStartMessageId = Number.isInteger(ctx.session?.pendingStartMessageId)
    ? ctx.session.pendingStartMessageId
    : null;
  const now = Date.now();
  const messageSentTime = ctx.callbackQuery.message.date * 1000;

  const FORCE_VIEW_WAIT_MS = 10000;
  const elapsed = now - messageSentTime;
  if (elapsed < FORCE_VIEW_WAIT_MS) {
    const remainingSec = Math.ceil((FORCE_VIEW_WAIT_MS - elapsed) / 1000);
    try {
      await ctx.answerCallbackQuery({
        text: `⏳ لطفاً ${remainingSec} ثانیه دیگر صبر کنید، سپس دکمه تأیید را بزنید.\nابتدا پست‌های کانال را مشاهده و ریکشن بزنید.`,
        show_alert: true,
      });
    } catch (e) {
      logger.debug(`خطا در answerCallbackQuery (تایید زودهنگام): ${e.message}`);
    }
    logger.info(`کاربر ${userId} روی دکمه تایید زودتر از زمان کلیک کرد (${remainingSec} ثانیه باقیمانده).`);
    return;
  }

  const isSubscribedNow = await checkUserSubscription(ctx, userId);
  if (!isSubscribedNow) {
    try {
      await ctx.answerCallbackQuery({
        text: "❌ شما هنوز در تمام کانال‌های مورد نیاز عضو نشده‌اید.",
        show_alert: true,
      });
    } catch (e) {
      logger.debug(`خطا در answerCallbackQuery (عضویت ناقص): ${e.message}`);
    }
    logger.info(
      `کاربر ${userId} نتوانست تأیید بررسی اجباری را تکمیل کند (عضویت ناقص).`
    );
    return;
  }

  // Delete the force view message
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.deleteMessage();
      logger.info(
        `پیام بررسی اجباری ${ctx.callbackQuery.message.message_id} برای ${userId} حذف شد.`
      );
    } catch (e) {
      logger.warn(
        `خطا در حذف پیام بررسی اجباری برای ${userId}: ${e.message}`
      );
    }
  }

  // Clear forceViewMessageId from session after successful confirmation
  ctx.session.forceViewMessageId = null;

  // Reset usage count and update file usage
  await runQuery("UPDATE users SET link_usage_count = ? WHERE id = ?", [0, userId]);
  await runQuery(
    "UPDATE files SET usage_count = usage_count + 1 WHERE file_identifier = ?",
    [fileIdentifier]
  );
  logger.info(
    `شمارنده استفاده از لینک کاربر ${userId} ریست شد و usage_count فایل به‌روز شد.`
  );

  // Retrieve and send the file
  const file = await getQuery("SELECT * FROM files WHERE file_identifier = ?", [
    fileIdentifier,
  ]);
  if (file) {
    const dbData = await readDB();
    if (file.file_ids_json) file.file_ids = JSON.parse(file.file_ids_json);
    if (file.file_types_json) file.file_types = JSON.parse(file.file_types_json);
    if (file.user_captions_json) file.user_captions = JSON.parse(file.user_captions_json);
    await sendFileContent(
      ctx,
      file,
      null,
      dbData.settings.delete_timeout_ms,
      pendingStartMessageId
    );
    ctx.session.pendingStartMessageId = null;
  } else {
    await ctx.reply("❌ فایل درخواستی پیدا نشد.");
    logger.warn(
      `فایل ${fileIdentifier} پس از تأیید بررسی اجباری برای کاربر ${userId} یافت نشد.`
    );
    ctx.session.pendingStartMessageId = null;
  }

  // Acknowledge at the end - wrapped in try/catch since message may be deleted
  try {
    await ctx.answerCallbackQuery({
      text: "✅ تایید شد! فایل‌ها در حال ارسال هستند.",
    });
  } catch (e) {
    logger.debug(`خطا در answerCallbackQuery (تایید ارسال فایل): ${e.message}`);
  }
}

async function handleFileRequest(ctx, fileIdentifier, sourceMessageId = null) {
  const file = await getQuery("SELECT * FROM files WHERE file_identifier = ?", [
    fileIdentifier,
  ]);
  const userId = ctx.from.id;
  const pendingStartMessageId = Number.isInteger(sourceMessageId)
    ? sourceMessageId
    : Number.isInteger(ctx.session?.pendingStartMessageId)
      ? ctx.session.pendingStartMessageId
      : null;

  if (!file) {
    await ctx.reply("❌ فایل درخواستی پیدا نشد.");
    logger.warn(`درخواست فایل ناموجود ${fileIdentifier} از کاربر ${userId}.`);
    ctx.session.pendingStartMessageId = null;
    return;
  }

  const dbData = await readDB();
  const userRow = dbData.allUsersData.find((u) => u.id === userId);
  let currentLinkUsage = userRow ? userRow.link_usage_count : 0;

  const isSubscribed = await checkUserSubscription(ctx, userId);
  if (!isSubscribed) {
    return;
  }

  // Increment link usage count
  currentLinkUsage++;
  await runQuery("UPDATE users SET link_usage_count = ? WHERE id = ?", [
    currentLinkUsage,
    userId,
  ]);
  logger.info(
    `شمارنده استفاده از لینک کاربر ${userId} برای فایل ${fileIdentifier} به ${currentLinkUsage} افزایش یافت.`
  );

  // Force view/reaction logic for non-admins
  if (dbData.settings.is_force_view_enabled && !isAdmin(ctx)) {
    if (
      currentLinkUsage === 3 ||
      (currentLinkUsage > 1 && (currentLinkUsage - 1) % 5 === 0)
    ) {
      const FORCE_VIEW_WAIT_SECONDS = 10;
      const keyboard = new InlineKeyboard();
      keyboard.text(
        "✅ تایید بازدید و ریکشن",
        `confirm_force_view:${fileIdentifier}`
      );

      const forceViewText =
        dbData.settings.force_view_message_text +
        `\n\n⏳ پس از ${FORCE_VIEW_WAIT_SECONDS} ثانیه بررسی، دکمه «تایید بازدید و ریکشن» را بزنید تا فایل ارسال شود.`;

      try {
        const sentMessage = await ctx.reply(
          forceViewText,
          { reply_markup: keyboard }
        );
        if (Number.isInteger(pendingStartMessageId)) {
          ctx.session.pendingStartMessageId = pendingStartMessageId;
        }
        ctx.session.forceViewMessageId = sentMessage.message_id;
        ctx.session.forceViewMessageSentTime = sentMessage.date * 1000;
        logger.info(
          `فعال‌سازی بررسی اجباری برای کاربر ${userId} (فایل: ${fileIdentifier}, استفاده: ${currentLinkUsage}).`
        );
      } catch (e) {
        logger.error(`خطا در ارسال پیام بررسی اجباری به کاربر ${userId}:`, e);
        await runQuery(
          "UPDATE files SET usage_count = usage_count + 1 WHERE file_identifier = ?",
          [fileIdentifier]
        );
        await sendFileContent(
          ctx,
          file,
          null,
          dbData.settings.delete_timeout_ms,
          pendingStartMessageId
        );
        ctx.session.pendingStartMessageId = null;
      }
      return;
    }
  }

  // Send file directly (no force view required)
  await runQuery(
    "UPDATE files SET usage_count = usage_count + 1 WHERE file_identifier = ?",
    [fileIdentifier]
  );
  logger.info(
    `فایل برای کاربر ${userId} (فایل: ${fileIdentifier}, استفاده: ${currentLinkUsage}) بدون بررسی اجباری ارسال شد.`
  );

  if (file.file_ids_json) file.file_ids = JSON.parse(file.file_ids_json);
  if (file.file_types_json) file.file_types = JSON.parse(file.file_types_json);
  if (file.user_captions_json) file.user_captions = JSON.parse(file.user_captions_json);

  await sendFileContent(
    ctx,
    file,
    null,
    dbData.settings.delete_timeout_ms,
    pendingStartMessageId
  );
  ctx.session.pendingStartMessageId = null;
}

async function promptForCaptionSingle(ctx, shouldStore) {
  if (
    ctx.session.step !== "awaiting_storage_decision" ||
    ctx.session.uploadMode !== "single"
  ) {
    return await ctx.answerCallbackQuery({
      text: "خطای داخلی. لطفاً دوباره تلاش کنید.",
      show_alert: true,
    });
  }

  ctx.session.currentFileForCaption = {
    file_id: ctx.session.pendingFile.id,
    file_type: ctx.session.pendingFile.type,
    shouldStore: shouldStore,
  };
  ctx.session.step = "awaiting_caption_input_single";
  ctx.session.pendingFile = null;
  ctx.session.uploadMode = null;

  const text =
    "لطفاً کپشن مورد نظر را برای این فایل وارد کنید یا /skip را بزید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
}

async function processAndSaveSingleFile(ctx, userCaption, bot) {
  const fileToProcess = ctx.session.currentFileForCaption;
  if (!fileToProcess) {
    await ctx.reply(
      "خطا: اطلاعات فایل برای افزودن کپشن یافت نشد. لطفاً دوباره تلاش کنید."
    );
    logger.error("فایل برای پردازش تکی یافت نشد.");
    return;
  }

  const dbData = await readDB();
  const fileIdentifier = generateFileIdentifier();

  const existingFile = await getQuery(
    "SELECT file_identifier FROM files WHERE file_id = ?",
    [fileToProcess.file_id]
  );
  if (existingFile) {
    const link = `https://t.me/${ctx.me.username}?start=${existingFile.file_identifier}`;
    await ctx.reply(
      `⚠️ این فایل قبلاً در دیتابیس شما موجود است.\nلینک:\n${link}`
    );
    const { showMainAdminPanel } = require("./admin");
    await showMainAdminPanel(ctx);
    logger.warn(`فایل ${fileToProcess.file_id} قبلاً موجود بود.`);
    return;
  }

  const captionToSend =
    userCaption !== null ? userCaption : dbData.settings.caption_text;
  const FILE_STORAGE_CHANNEL_CURRENT = dbData.settings.file_storage_channel;

  if (fileToProcess.shouldStore) {
    try {
      switch (fileToProcess.file_type) {
        case "photo":
          await bot.api.sendPhoto(FILE_STORAGE_CHANNEL_CURRENT, fileToProcess.file_id, { caption: captionToSend });
          break;
        case "video":
          await bot.api.sendVideo(FILE_STORAGE_CHANNEL_CURRENT, fileToProcess.file_id, { caption: captionToSend });
          break;
        case "audio":
          await bot.api.sendAudio(FILE_STORAGE_CHANNEL_CURRENT, fileToProcess.file_id, { caption: captionToSend });
          break;
        case "document":
          await bot.api.sendDocument(FILE_STORAGE_CHANNEL_CURRENT, fileToProcess.file_id, { caption: captionToSend });
          break;
        default:
          logger.warn(`نوع فایل نامشخص برای ذخیره: ${fileToProcess.file_type}`);
          await ctx.reply("خطا: نوع فایل نامشخص است و قابل ذخیره نیست.");
          return;
      }
      logger.info(
        `فایل تکی ${fileToProcess.file_id} به کانال ذخیره ${FILE_STORAGE_CHANNEL_CURRENT} ارسال شد.`
      );
    } catch (error) {
      logger.error(
        `خطا در ارسال فایل تکی به کانال ${FILE_STORAGE_CHANNEL_CURRENT}:`,
        error
      );
      await ctx.reply(
        `❌ خطا در ارسال فایل به کانال. مطمئن شوید ربات در آن ادمین است. فایل با شناسه ${fileToProcess.file_id} ذخیره نشد.`
      );
      const { showMainAdminPanel } = require("./admin");
      await showMainAdminPanel(ctx);
      return;
    }
  }

  await runQuery(
    `INSERT INTO files (file_identifier, file_id, file_type, user_caption, usage_count) VALUES (?, ?, ?, ?, ?)`,
    [fileIdentifier, fileToProcess.file_id, fileToProcess.file_type, userCaption, 0]
  );

  ctx.session.currentFileForCaption = null;
  const link = `https://t.me/${ctx.me.username}?start=${fileIdentifier}`;
  await ctx.reply(
    `✅ لینک فایل تکی با موفقیت ساخته شد!\n\n🔗 لینک اشتراک‌گذاری:\n${link}\n\n📋 شناسه فایل: \`${fileIdentifier}\``
  );
  const { showMainAdminPanel } = require("./admin");
  await showMainAdminPanel(ctx);
  logger.info(`لینک جدید برای فایل تکی ${fileIdentifier} ساخته شد.`);
}

async function processAndSaveGroupFiles(ctx, shouldStore, bot) {
  const dbData = await readDB();
  const fileIdentifier = generateFileIdentifier();
  const filesToSave = ctx.session.pendingFiles;
  const FILE_STORAGE_CHANNEL_CURRENT = dbData.settings.file_storage_channel;

  if (filesToSave.length === 0) {
    await ctx.reply("هیچ فایلی برای ذخیره سازی گروهی وجود ندارد.");
    logger.warn(`تلاش برای ذخیره سازی گروهی بدون فایل.`);
    return;
  }

  if (shouldStore) {
    for (const file of filesToSave) {
      const captionToSend =
        file.user_caption !== null ? file.user_caption : dbData.settings.caption_text;
      try {
        switch (file.file_type) {
          case "photo":
            await bot.api.sendPhoto(FILE_STORAGE_CHANNEL_CURRENT, file.file_id, { caption: captionToSend });
            break;
          case "video":
            await bot.api.sendVideo(FILE_STORAGE_CHANNEL_CURRENT, file.file_id, { caption: captionToSend });
            break;
          case "audio":
            await bot.api.sendAudio(FILE_STORAGE_CHANNEL_CURRENT, file.file_id, { caption: captionToSend });
            break;
          case "document":
            await bot.api.sendDocument(FILE_STORAGE_CHANNEL_CURRENT, file.file_id, { caption: captionToSend });
            break;
          default:
            logger.warn(`نوع فایل نامشخص برای ذخیره گروهی: ${file.file_type}`);
            await ctx.reply("خطا: نوع فایل نامشخص است و قابل ذخیره نیست.");
            continue;
        }
        logger.info(
          `فایل ${file.file_id} (گروهی) به کانال ذخیره ${FILE_STORAGE_CHANNEL_CURRENT} ارسال شد.`
        );
      } catch (error) {
        logger.error(
          `خطا در ارسال فایل گروهی به کانال ${FILE_STORAGE_CHANNEL_CURRENT}:`,
          error
        );
        await ctx.reply(
          `❌ خطا در ارسال فایل به کانال (فایل ${file.file_id}). مطمئن شوید ربات در آن ادمین است.`
        );
      }
    }
  }

  const fileIds = JSON.stringify(filesToSave.map((f) => f.file_id));
  const fileTypes = JSON.stringify(filesToSave.map((f) => f.file_type));
  const userCaptions = JSON.stringify(filesToSave.map((f) => f.user_caption));

  await runQuery(
    `INSERT INTO files (file_identifier, file_ids_json, file_types_json, user_captions_json, usage_count) VALUES (?, ?, ?, ?, ?)`,
    [fileIdentifier, fileIds, fileTypes, userCaptions, 0]
  );

  ctx.session.uploadMode = null;
  ctx.session.pendingFiles = [];
  ctx.session.step = "idle";
  const link = `https://t.me/${ctx.me.username}?start=${fileIdentifier}`;
  await ctx.reply(
    `✅ لینک مجموعه فایل‌ها با موفقیت ساخته شد!\n\n📦 تعداد فایل‌ها: ${filesToSave.length}\n🔗 لینک اشتراک‌گذاری:\n${link}\n\n📋 شناسه: \`${fileIdentifier}\``
  );
  const { showMainAdminPanel } = require("./admin");
  await showMainAdminPanel(ctx);
  logger.info(`لینک جدید برای مجموعه فایل‌ها ${fileIdentifier} ساخته شد.`);
}

module.exports = {
  sendFileContent,
  confirmAndSendFile,
  handleFileRequest,
  promptForCaptionSingle,
  processAndSaveSingleFile,
  processAndSaveGroupFiles,
};
