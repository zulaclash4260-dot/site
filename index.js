const { Bot, InlineKeyboard } = require("grammy");
const { TOKEN, ADMIN_IDs, logger, isAdmin, isPrimaryAdmin, FLOOD_LIMIT_SECONDS_GLOBAL, addDynamicAdmin, removeDynamicAdmin, getDynamicAdmins, loadDynamicAdmins } = require("./src/config");
const { safeEditOrReply, ensureBackToMenuButton } = require("./src/helpers");
const { registerMiddleware } = require("./src/middleware");
const { checkUserSubscription, registerForceJoinHandlers } = require("./src/forceJoin");
const {
  showMainAdminPanel,
  promptForBroadcast,
  showUserManagementMenu,
  promptForSend,
  showFileList,
  showAddChannelMenu,
  showForceJoinList,
  showAdvancedSettingsMenu,
  showStatisticsMenu,
  showUserStats,
  showFileStats,
  showForceJoinStats,
  promptForLinkUsageStats,
  showTop30Files,
  showAdminHelpGuide,
  showAdminList,
  showRemoveAdminMenu,
} = require("./src/admin");
const {
  sendFileContent,
  confirmAndSendFile,
  handleFileRequest,
  promptForCaptionSingle,
  processAndSaveSingleFile,
  processAndSaveGroupFiles,
} = require("./src/fileManager");
const { broadcastMessage } = require("./src/broadcast");
const {
  initializeDatabase,
  runQuery,
  getQuery,
  allQuery,
  setSetting,
  readDB,
  saveUser,
  deleteFileByIdentifier,
  getDynamicAdminIds,
  addDynamicAdminDB,
  removeDynamicAdminDB,
} = require("./db");

if (!TOKEN) {
  logger.error(
    "توکن ربات تنظیم نشده است! لطفاً متغیر محیطی BOT_TOKEN یا TOKEN را تنظیم کنید."
  );
  process.exit(1);
}

const bot = new Bot(TOKEN, {
  client: {
    baseFetchConfig: {
      compress: true,
    },
  },
});

// Inject a back-to-menu inline button into every text reply in private chats.
bot.use(async (ctx, next) => {
  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = (text, other = {}, signal) => {
    const options = other || {};
    return originalReply(
      text,
      {
        ...options,
        reply_markup: ensureBackToMenuButton(ctx, options.reply_markup),
      },
      signal
    );
  };
  await next();
});

// --- User Help Guide Text (shared between /help command and callback) ---
const USER_HELP_GUIDE_TEXT = `📖 *راهنمای استفاده از ربات*

🔹 *دریافت فایل*
برای دریافت فایل، کافیست لینک اشتراک‌گذاری فایل را باز کنید. فایل‌ها بصورت خودکار برای شما ارسال خواهند شد.

🔹 *عضویت در کانال‌ها*
ممکن است برای دریافت فایل، نیاز به عضویت در کانال‌های مشخصی داشته باشید. پس از عضویت، دکمه «تایید عضویت» را بزنید.

🔹 *بررسی اجباری*
گاهی از شما خواسته می‌شود کانال را بررسی کرده و ریکشن بزنید. پس از انجام، دکمه «تایید» را بزنید تا فایل ارسال شود.

🔹 *حذف خودکار فایل‌ها*
فایل‌های ارسال شده پس از مدتی بصورت خودکار حذف می‌شوند. لطفاً فایل‌ها را فوراً ذخیره (Save) کنید.

🔹 *دستورات*
• /start - شروع ربات
• /help - نمایش این راهنما`;

function normalizePublicChannelLink(channelId) {
  if (!channelId || typeof channelId !== "string") return null;
  const value = channelId.trim();
  if (!value) return null;

  if (value.startsWith("https://t.me/")) return value;
  if (value.startsWith("http://t.me/")) {
    return `https://${value.slice("http://".length)}`;
  }
  if (value.startsWith("@")) {
    return `https://t.me/${value.slice(1)}`;
  }
  if (/^[A-Za-z0-9_]{5,}$/.test(value)) {
    return `https://t.me/${value}`;
  }

  return null;
}

function buildRegularUserChannelText(settings) {
  const customStartText =
    typeof settings?.regular_user_start_text === "string"
      ? settings.regular_user_start_text.trim()
      : "";
  if (customStartText) {
    return customStartText;
  }

  const channelLink = normalizePublicChannelLink(settings?.file_storage_channel);
  if (channelLink) {
    return `📢 کاربران عزیز:\nفایل‌ها را از کانال زیر بررسی کنید:\n${channelLink}`;
  }

  return "📢 کاربران عزیز:\nفایل‌ها را از کانال رسمی بررسی کنید.";
}

// --- Register Middleware ---
registerMiddleware(bot);

// --- Admin filter ---
const adminBot = bot.filter(isAdmin);

// --- Register Force Join Handlers (single check_sub handler, no duplicates) ---
registerForceJoinHandlers(bot, handleFileRequest, async (ctx) => {
  await ctx.reply("✅ عضویت شما با موفقیت تایید شد!");
  if (isAdmin(ctx)) {
    await showMainAdminPanel(ctx);
  } else {
    const dbData = await readDB();
    await ctx.reply(buildRegularUserChannelText(dbData.settings));
  }
});

// --- Force View Confirmation ---
bot.callbackQuery(/^confirm_force_view:(.*)/, async (ctx) => {
  const fileIdentifier = ctx.match[1];
  await confirmAndSendFile(ctx, fileIdentifier);
});

// --- Resend deleted file ---
bot.callbackQuery(/^resend_file:([^:]+)(?::(\d+))?$/, async (ctx) => {
  const fileIdentifier = ctx.match[1];
  const availableAtRaw = ctx.match[2];
  let canResend = true;

  if (availableAtRaw) {
    const availableAt = Number(availableAtRaw);
    if (Number.isFinite(availableAt) && Date.now() < availableAt) {
      canResend = false;
    }
  } else if (ctx.callbackQuery?.message?.date) {
    const dbData = await readDB();
    const unlockAt =
      ctx.callbackQuery.message.date * 1000 + dbData.settings.delete_timeout_ms;
    if (Date.now() < unlockAt) {
      canResend = false;
    }
  }

  if (!canResend) {
    try {
      await ctx.answerCallbackQuery({
        text: "⏳ هنوز زمان حذف فایل نرسیده است.",
        show_alert: true,
      });
    } catch (e) {
      logger.debug(`Error in answerCallbackQuery (resend too early): ${e.message}`);
    }
    return;
  }

  try {
    await ctx.answerCallbackQuery({
      text: "\u062F\u0631 \u062D\u0627\u0644 \u0627\u0631\u0633\u0627\u0644 \u0645\u062C\u062F\u062F \u0641\u0627\u06CC\u0644..."
    });
  } catch (e) {
    logger.debug(`Error in answerCallbackQuery (resend file): ${e.message}`);
  }
  await handleFileRequest(ctx, fileIdentifier);
});
// --- Commands ---
bot.command("start", async (ctx) => {
  await saveUser(ctx.from.id);
  const fileIdentifier = ctx.match;
  ctx.session.currentFileIdentifier = fileIdentifier || "no_file";
  ctx.session.pendingStartMessageId = fileIdentifier
    ? ctx.message?.message_id ?? null
    : null;

  const isSubscribed = await checkUserSubscription(ctx, ctx.from.id);
  if (!isSubscribed) {
    return;
  }

  if (fileIdentifier) {
    await handleFileRequest(
      ctx,
      fileIdentifier,
      ctx.message?.message_id ?? null
    );
    return;
  }

  if (isAdmin(ctx)) {
    await showMainAdminPanel(ctx);
  } else {
    const dbData = await readDB();
    await ctx.reply(buildRegularUserChannelText(dbData.settings));
  }
});

adminBot.command("cancel", async (ctx) => {
  const currentStep = ctx.session.step;
  if (currentStep && currentStep !== "idle") {
    ctx.session.step = "idle";
    ctx.session.pendingFile = null;
    ctx.session.pendingFiles = [];
    ctx.session.pendingChannel = null;
    ctx.session.pendingExtraLink = null;
    ctx.session.targetChannelId = null;
    ctx.session.is_pending_subscription = false;
    ctx.session.uploadMode = null;
    ctx.session.forceViewMessageId = null;
    ctx.session.currentFileForCaption = null;
    ctx.session.currentFileIdentifier = null;
    ctx.session.pendingStartMessageId = null;
    ctx.session.broadcastMessageContent = null;
    ctx.session.broadcastMessageType = null;
    ctx.session.broadcastMessageOptions = {};
    ctx.session.broadcastOriginalMessageId = null;
    await ctx.reply("✅ عملیات لغو شد.");
    await showMainAdminPanel(ctx);
    logger.info(`عملیات توسط ادمین ${ctx.from?.id} لغو شد.`);
  } else {
    await ctx.reply("هیچ عملیات فعالی برای لغو کردن وجود ندارد.");
  }
});

adminBot.command("skip", async (ctx) => {
  if (ctx.session.step === "awaiting_caption_input_single") {
    await processAndSaveSingleFile(ctx, null, bot);
  } else if (ctx.session.step === "awaiting_caption_input_group_file") {
    if (ctx.session.currentFileForCaption) {
      ctx.session.pendingFiles.push({
        ...ctx.session.currentFileForCaption,
        user_caption: null,
      });
      ctx.session.currentFileForCaption = null;
    }
    ctx.session.step = "awaiting_group_files";
    await ctx.reply(
      "کپشن نادیده گرفته شد. می‌توانید فایل بعدی را ارسال کنید یا /done را بزنید."
    );
  } else {
    await ctx.reply("دستور /skip در این مرحله قابل استفاده نیست.");
  }
});

adminBot.command("ban", (ctx) => {
  ctx.session.step = "awaiting_user_to_ban";
  ctx.reply(
    "لطفاً شناسه عددی کاربر مورد نظر را ارسال کنید یا یک پیام از او به اینجا فوروارد کنید.\n\nبرای لغو /cancel را ارسال کنید."
  );
});

adminBot.command("unban", (ctx) => {
  ctx.session.step = "awaiting_user_to_unban";
  ctx.reply(
    "لطفاً شناسه عددی کاربری که می‌خواهید از مسدودیت خارج شود را ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید."
  );
});

adminBot.command("list", showFileList);
adminBot.command("addch", showAddChannelMenu);
adminBot.command("mes", promptForBroadcast);

// /help command - works for all users: admin gets admin guide, users get user guide
bot.command("help", async (ctx) => {
  if (isAdmin(ctx)) {
    await showAdminHelpGuide(ctx);
  } else {
    await ctx.reply(USER_HELP_GUIDE_TEXT, { parse_mode: "Markdown" });
  }
});

adminBot.command("done", async (ctx) => {
  if (ctx.session.uploadMode !== "group") {
    await ctx.reply("این دستور فقط در حالت آپلود گروهی قابل استفاده است.");
    return;
  }

  if (
    ctx.session.step === "awaiting_caption_input_group_file" &&
    ctx.session.currentFileForCaption
  ) {
    ctx.session.pendingFiles.push({
      ...ctx.session.currentFileForCaption,
      user_caption: null,
    });
    ctx.session.currentFileForCaption = null;
  }

  if (ctx.session.pendingFiles.length === 0) {
    await ctx.reply("هیچ فایلی برای پردازش وجود ندارد.");
    ctx.session.step = "idle";
    ctx.session.uploadMode = null;
    await showMainAdminPanel(ctx);
    return;
  }

  ctx.session.step = "awaiting_group_storage_decision";
  const keyboard = new InlineKeyboard()
    .text("✅ بله، در کانال ذخیره شود", "store_group_in_channel")
    .text("❎ خیر", "dont_store_in_channel_group")
    .row()
    .text("❌ لغو عملیات", "cancel_upload");
  await ctx.reply(
    `✅ ${ctx.session.pendingFiles.length} فایل آماده پردازش است. آیا مایلید این مجموعه در کانال ذخیره‌سازی نیز آرشیو شود؟`,
    { reply_markup: keyboard }
  );
});

// --- Message Handler ---
bot.on("message", async (ctx) => {
  const dbData = await readDB();
  if (!dbData.settings.is_bot_enabled && !isAdmin(ctx)) {
    return;
  }

  if (!isAdmin(ctx)) {
    const isSubscribed = await checkUserSubscription(ctx, ctx.from.id);
    if (!isSubscribed) {
      return;
    }
    await ctx.reply(buildRegularUserChannelText(dbData.settings));
    return;
  }

  const { step, uploadMode } = ctx.session;

  if (step === "awaiting_caption_input_single") {
    if (ctx.message.text) {
      await processAndSaveSingleFile(ctx, ctx.message.text, bot);
      ctx.session.step = "idle";
    } else {
      await ctx.reply(
        "لطفاً کپشن را به صورت متنی وارد کنید یا /skip را بزنید."
      );
    }
    return;
  }

  if (step === "awaiting_caption_input_group_file") {
    if (ctx.message.text) {
      if (ctx.session.currentFileForCaption) {
        ctx.session.pendingFiles.push({
          ...ctx.session.currentFileForCaption,
          user_caption: ctx.message.text,
        });
        ctx.session.currentFileForCaption = null;
        ctx.session.step = "awaiting_group_files";
        await ctx.reply(
          "کپشن ذخیره شد. می‌توانید فایل بعدی را ارسال کنید یا /done را بزنید."
        );
      } else {
        await ctx.reply(
          "خطا: فایلی برای افزودن کپشن یافت نشد. لطفاً دوباره تلاش کنید."
        );
        ctx.session.step = "awaiting_group_files";
      }
    } else {
      await ctx.reply("لطفاً کپشن را به صورت متنی وارد کنید یا /skip را بزید.");
    }
    return;
  }

  if (step === "awaiting_admin_to_add") {
    if (!ctx.message.text || !/^\d+$/.test(ctx.message.text)) {
      return ctx.reply(
        "❌ ورودی نامعتبر است. لطفاً فقط شناسه عددی کاربر را ارسال کنید."
      );
    }
    const newAdminId = parseInt(ctx.message.text, 10);
    if (ADMIN_IDs.includes(newAdminId)) {
      ctx.session.step = "idle";
      return ctx.reply("⚠️ این کاربر از قبل ادمین اصلی است.");
    }
    const currentDynamicAdmins = getDynamicAdmins();
    if (currentDynamicAdmins.includes(newAdminId)) {
      ctx.session.step = "idle";
      return ctx.reply("⚠️ این کاربر از قبل ادمین است.");
    }
    const added = await addDynamicAdminDB(newAdminId);
    if (added) {
      addDynamicAdmin(newAdminId);
      await ctx.reply(`✅ کاربر با شناسه \`${newAdminId}\` با موفقیت به عنوان ادمین اضافه شد.`, { parse_mode: "Markdown" });
      logger.info(`ادمین جدید ${newAdminId} توسط ${ctx.from?.id} اضافه شد.`);
      try {
        await bot.api.sendMessage(newAdminId, "🎉 شما به عنوان ادمین ربات اضافه شدید!");
      } catch (e) {
        logger.warn(`نتوانستم به ادمین جدید ${newAdminId} اطلاع دهم.`);
      }
    } else {
      await ctx.reply("❌ خطایی در افزودن ادمین رخ داد.");
    }
    ctx.session.step = "idle";
    await showUserManagementMenu(ctx);
    return;
  }

  if (step === "awaiting_delete_link") {
    const link = ctx.message.text;
    const botUsername = ctx.me.username;
    if (!link || !link.startsWith(`https://t.me/${botUsername}?start=`)) {
      await ctx.reply(
        "❌ لینک وارد شده نامعتبر است. لطفاً یک لینک اشتراک صحیح از این ربات ارسال کنید."
      );
      return;
    }
    const fileIdentifier = link.split("?start=")[1];
    if (!fileIdentifier) {
      await ctx.reply(
        "❌ شناسه فایل از لینک قابل استخراج نیست. لطفاً لینک صحیح را وارد کنید."
      );
      return;
    }

    const deleteResult = await deleteFileByIdentifier(fileIdentifier);
    if (deleteResult.success) {
      await ctx.reply(
        `✅ فایل(ها) با شناسه \`${fileIdentifier}\` با موفقیت از دیتابیس حذف شد.`
      );
      logger.info(`فایل ${fileIdentifier} توسط ادمین ${ctx.from?.id} حذف شد.`);
    } else {
      await ctx.reply(
        `❌ فایلی با شناسه \`${fileIdentifier}\` در دیتابیس یافت نشد.`
      );
      logger.warn(
        `تلاش برای حذف فایل ناموجود ${fileIdentifier} توسط ادمین ${ctx.from?.id}.`
      );
    }
    ctx.session.step = "idle";
    await showMainAdminPanel(ctx);
    return;
  }

  // Handle broadcast messages
  if (
    step === "awaiting_broadcast_message_send" ||
    step === "awaiting_broadcast_message_forward"
  ) {
    const msg = ctx.message;
    let message_type = "unknown";

    ctx.session.broadcastOriginalMessageId = msg.message_id;
    ctx.session.broadcastMessageOptions = {};

    if (step === "awaiting_broadcast_message_forward") {
      if (msg.forward_from_chat && msg.forward_from_message_id) {
        message_type = "forwarded_message";
        ctx.session.broadcastMessageContent = {
          chat_id: msg.forward_from_chat.id,
          message_id: msg.forward_from_message_id,
        };
        logger.info(
          `پیام فوروارد شده از چت ${msg.forward_from_chat.id} برای ارسال همگانی دریافت شد.`
        );
      } else {
        await ctx.reply("❌ برای فوروارد، لطفاً فقط یک پیام را فوروارد کنید.");
        return;
      }
    } else {
      if (msg.text) {
        message_type = "text";
        ctx.session.broadcastMessageContent = msg.text;
        // Store text entities (hyperlinks, bold, italic, etc.) for explicit preservation
        if (msg.entities && msg.entities.length > 0) {
          ctx.session.broadcastMessageOptions.entities = msg.entities;
        }
      } else if (msg.photo) {
        message_type = "photo";
        ctx.session.broadcastMessageContent = msg.photo.slice(-1)[0].file_id;
      } else if (msg.video) {
        message_type = "video";
        ctx.session.broadcastMessageContent = msg.video.file_id;
      } else if (msg.audio) {
        message_type = "audio";
        ctx.session.broadcastMessageContent = msg.audio.file_id;
      } else if (msg.document) {
        message_type = "document";
        ctx.session.broadcastMessageContent = msg.document.file_id;
      } else {
        await ctx.reply(
          "❌ نوع پیام ارسالی برای ارسال همگانی پشتیبانی نمی‌شود."
        );
        return;
      }

      // For exact formatting/caption preservation we copy the original message as-is.
      // Only inline keyboard is carried explicitly when present.
      if (msg.reply_markup?.inline_keyboard) {
        ctx.session.broadcastMessageOptions.reply_markup = msg.reply_markup;
      }

      logger.info(`پیام نوع ${message_type} برای ارسال همگانی دریافت شد.`);
    }

    ctx.session.broadcastMessageType = message_type;
    ctx.session.step = "idle";
    await ctx.reply(
      "✅ پیام برای ارسال همگانی ثبت شد. عملیات ارسال در پس‌زمینه آغاز می‌شود..."
    );
    broadcastMessage(ctx, bot);
    return;
  }

  if (step === "awaiting_channel_info") {
    ctx.session.step = "idle";
    let chatId, chatTitle, chatType, detectedInviteLink;
    try {
      if (ctx.message.forward_from_chat) {
        const chat = ctx.message.forward_from_chat;
        chatId = chat.id;
        chatTitle = chat.title;
        chatType = chat.type;
        logger.info(
          `اطلاعات کانال/گروه دریافت شد: ${chatTitle} (${chatId}).`
        );
      } else if (ctx.message.text) {
        const rawText = ctx.message.text.trim();
        const linkMatch = rawText.match(/^https?:\/\/t\.me\/(\+[\w-]+|[a-zA-Z][\w]{3,})$/i);
        const usernameMatch = rawText.match(/^@([a-zA-Z][\w]{3,})$/);

        if (linkMatch || usernameMatch) {
          let chatIdentifier;
          let isPrivateLink = false;

          if (linkMatch) {
            const pathPart = linkMatch[1];
            if (pathPart.startsWith("+")) {
              isPrivateLink = true;
              chatIdentifier = rawText;
              detectedInviteLink = rawText.replace(/^http:\/\//i, "https://");
            } else {
              chatIdentifier = `@${pathPart}`;
              detectedInviteLink = `https://t.me/${pathPart}`;
            }
          } else {
            chatIdentifier = `@${usernameMatch[1]}`;
            detectedInviteLink = `https://t.me/${usernameMatch[1]}`;
          }

          if (isPrivateLink) {
            return ctx.reply(
              "❌ لینک خصوصی (invite link) به صورت مستقیم قابل شناسایی نیست.\n\n" +
              "لطفاً یک پیام از آن کانال/گروه خصوصی فوروارد کنید تا ربات بتواند آن را شناسایی کند."
            );
          }

          try {
            const chatInfo = await ctx.api.getChat(chatIdentifier);
            chatId = chatInfo.id;
            chatTitle = chatInfo.title || chatIdentifier;
            chatType = chatInfo.type;
            detectedInviteLink = detectedInviteLink || chatInfo.invite_link;
            logger.info(
              `اطلاعات کانال/گروه از لینک دریافت شد: ${chatTitle} (${chatId}) - نوع: ${chatType}`
            );
          } catch (apiError) {
            logger.warn(`خطا در دریافت اطلاعات از لینک ${rawText}: ${apiError.message}`);
            return ctx.reply(
              "❌ ربات نتوانست اطلاعات این کانال/گروه را دریافت کند.\n\n" +
              "مطمئن شوید که:\n" +
              "1. ربات در کانال/گروه ادمین است\n" +
              "2. لینک یا نام کاربری صحیح است\n\n" +
              "همچنین می‌توانید یک پیام از کانال/گروه فوروارد کنید."
            );
          }
        } else {
          return ctx.reply(
            "❌ ورودی نامعتبر است.\n\nلطفاً یکی از موارد زیر را ارسال کنید:\n" +
            "• یک پیام از کانال/گروه فوروارد کنید\n" +
            "• لینک عمومی کانال/گروه (مثل https://t.me/channel_name)\n" +
            "• نام کاربری کانال/گروه (مثل @channel_name)"
          );
        }
      } else {
        return ctx.reply(
          "❌ ورودی نامعتبر است.\n\nلطفاً یکی از موارد زیر را ارسال کنید:\n" +
          "• یک پیام از کانال/گروه فوروارد کنید\n" +
          "• لینک عمومی کانال/گروه (مثل https://t.me/channel_name)\n" +
          "• نام کاربری کانال/گروه (مثل @channel_name)"
        );
      }

      const dbData2 = await readDB();
      if (dbData2.forceJoin.some((c) => c.id == chatId)) {
        return ctx.reply("⚠️ این کانال/گروه قبلاً اضافه شده است.");
      }

      ctx.session.pendingChannel = {
        id: chatId,
        title: chatTitle,
        chatType: chatType || "channel",
      };

      if (detectedInviteLink) {
        ctx.session.pendingChannel.invite_link = detectedInviteLink;
        ctx.session.step = "awaiting_channel_button_text";

        const chatTypeText =
          chatType === "group" || chatType === "supergroup" ? "گروه" : "کانال";
        const visibilityText = detectedInviteLink.includes("/+")
          ? "خصوصی 🔒"
          : "عمومی 🌐";

        await ctx.reply(
          `✅ ${chatTypeText} "${chatTitle}" شناسایی شد. (${visibilityText})\n\n` +
          `لینک: ${detectedInviteLink}\n\n` +
          `حالا متن دکمه جوین اجباری را ارسال کنید.\n\nبرای متن پیش‌فرض عبارت \`default\` را بفرستید.\nبرای لغو /cancel را ارسال کنید.`
        );
      } else {
        ctx.session.step = "awaiting_invite_link";
        await ctx.reply(
          `کانال/گروه "${chatTitle}" شناسایی شد. لطفاً لینک دعوت آن را برای نمایش به کاربران ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید.`
        );
      }
    } catch (error) {
      logger.error("خطا در پردازش کانال:", error);
      await ctx.reply(
        "❌ خطا در دریافت اطلاعات. لطفاً از صحت ورودی اطمینان حاصل کنید."
      );
    }
    return;
  }

  if (step === "awaiting_invite_link") {
    const rawLink = ctx.message.text;
    if (!rawLink) {
      return ctx.reply(
        "❌ لینک نامعتبر است. لطفاً یک لینک تلگرامی صحیح ارسال کنید."
      );
    }
    const link = rawLink.trim().replace(/^http:\/\//i, "https://");
    if (!/^https:\/\/t\.me\//i.test(link)) {
      return ctx.reply(
        "❌ لینک نامعتبر است. لطفاً یک لینک تلگرامی صحیح ارسال کنید."
      );
    }
    const channelInfo = ctx.session.pendingChannel;
    if (!channelInfo) {
      ctx.session.step = "idle";
      return ctx.reply(
        "خطای داخلی! اطلاعات کانال یافت نشد. لطفاً از ابتدا تلاش کنید."
      );
    }

    ctx.session.pendingChannel = {
      ...channelInfo,
      invite_link: link,
    };
    ctx.session.step = "awaiting_channel_button_text";

    await ctx.reply(
      `لینک ذخیره شد. حالا متن دکمه جوین اجباری برای "${channelInfo.title}" را ارسال کنید.\n\nبرای متن پیش‌فرض عبارت \`default\` را بفرستید.\nبرای لغو /cancel را ارسال کنید.`
    );
    return;
  }

  if (step === "awaiting_channel_button_text") {
    const channelInfo = ctx.session.pendingChannel;
    if (!channelInfo || !channelInfo.invite_link) {
      ctx.session.step = "idle";
      ctx.session.pendingChannel = null;
      return ctx.reply(
        "خطای داخلی! اطلاعات کانال/گروه ناقص است. لطفاً دوباره از ابتدا تلاش کنید."
      );
    }

    const incomingText = ctx.message.text;
    if (!incomingText) {
      return ctx.reply(
        "❌ لطفاً متن دکمه را ارسال کنید یا `default` را بفرستید."
      );
    }

    const normalized = incomingText.trim().toLowerCase();
    const buttonText =
      normalized === "default" ? null : incomingText.trim();

    await runQuery(
      `INSERT INTO force_join_channels (id, title, invite_link, button_text, chat_type, condition_type, condition_limit, current_members_count) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        channelInfo.id,
        channelInfo.title,
        channelInfo.invite_link,
        buttonText,
        channelInfo.chatType || "channel",
        null,
        null,
        0,
      ]
    );
    logger.info(
      `آیتم جوین اجباری اضافه شد: ${channelInfo.title} (${channelInfo.id}).`
    );

    ctx.session.step = "idle";
    ctx.session.pendingChannel = null;
    const keyboard = new InlineKeyboard()
      .text("👥 حذف بر اساس تعداد عضو", `set_member_limit:${channelInfo.id}`)
      .row()
      .text("⬅️ بازگشت به پنل اصلی", "admin_panel_main");
    await ctx.reply(
      `✅ "${channelInfo.title}" با موفقیت به جوین اجباری اضافه شد. حالا می‌توانید یک شرط برای حذف خودکار آن تعیین کنید:`,
      { reply_markup: keyboard }
    );
    return;
  }

  if (step === "awaiting_extra_link_url") {
    const rawLink = ctx.message.text;
    if (!rawLink) {
      return ctx.reply(
        "❌ لینک نامعتبر است. لطفاً یک لینک تلگرامی صحیح ارسال کنید."
      );
    }

    const link = rawLink.trim().replace(/^http:\/\//i, "https://");
    if (!/^https:\/\/t\.me\//i.test(link)) {
      return ctx.reply(
        "❌ لینک نامعتبر است. لطفاً یک لینک تلگرامی صحیح ارسال کنید."
      );
    }

    ctx.session.pendingExtraLink = { invite_link: link };
    ctx.session.step = "awaiting_extra_link_button_text";

    await ctx.reply(
      "متن دکمه این لینک کمکی را ارسال کنید.\n\nبرای متن پیش‌فرض عبارت `default` را بفرستید.\nبرای لغو /cancel را ارسال کنید."
    );
    return;
  }

  if (step === "awaiting_extra_link_button_text") {
    const pendingExtraLink = ctx.session.pendingExtraLink;
    if (!pendingExtraLink || !pendingExtraLink.invite_link) {
      ctx.session.step = "idle";
      ctx.session.pendingExtraLink = null;
      return ctx.reply("خطای داخلی! لینک کمکی یافت نشد. لطفاً دوباره تلاش کنید.");
    }

    const incomingText = ctx.message.text;
    if (!incomingText) {
      return ctx.reply(
        "❌ لطفاً متن دکمه را ارسال کنید یا `default` را بفرستید."
      );
    }

    const normalized = incomingText.trim().toLowerCase();
    const buttonText =
      normalized === "default" ? null : incomingText.trim();

    let fallbackTitle = "لینک کمکی";
    try {
      const pathPart = pendingExtraLink.invite_link.replace(
        /^https:\/\/t\.me\//i,
        ""
      );
      if (pathPart) {
        fallbackTitle = pathPart.split("/")[0] || fallbackTitle;
      }
    } catch (e) {
      logger.debug(`خطا در استخراج عنوان پیش‌فرض لینک کمکی: ${e.message}`);
    }

    await runQuery(
      "INSERT INTO force_join_extra_links (title, invite_link, button_text) VALUES (?, ?, ?)",
      [fallbackTitle, pendingExtraLink.invite_link, buttonText]
    );

    ctx.session.step = "idle";
    ctx.session.pendingExtraLink = null;
    await ctx.reply("✅ لینک کمکی (بدون چک عضویت) با موفقیت اضافه شد.");
    await showAddChannelMenu(ctx);
    return;
  }

  if (step === "awaiting_member_limit") {
    const members = parseInt(ctx.message.text, 10);
    if (isNaN(members) || members <= 0) {
      return ctx.reply("❌ لطفاً یک عدد صحیح و مثبت وارد کنید.");
    }
    const channelId = ctx.session.targetChannelId;
    await runQuery(
      `UPDATE force_join_channels SET condition_type = ?, condition_limit = ? WHERE id = ?`,
      ["members", members, channelId]
    );

    const channelRow = await getQuery(
      "SELECT title FROM force_join_channels WHERE id = ?",
      [channelId]
    );
    if (channelRow) {
      await ctx.reply(
        `✅ شرط حذف خودکار برای کانال "${channelRow.title}" پس از عضویت ${members} کاربر جدید تنظیم شد.`
      );
      logger.info(
        `شرط حذف خودکار برای کانال ${channelRow.title} (ID: ${channelId}) به ${members} عضو تنظیم شد.`
      );
    } else {
      await ctx.reply("❌ خطایی رخ داد. کانال مورد نظر یافت نشد.");
      logger.error(`خطا: کانال ${channelId} برای تنظیم شرط حذف یافت نشد.`);
    }
    ctx.session.step = "idle";
    ctx.session.targetChannelId = null;
    return;
  }

  if (step === "awaiting_user_to_ban") {
    let userIdToBan;
    if (ctx.message.forward_from) {
      userIdToBan = ctx.message.forward_from.id;
    } else if (ctx.message.text && /^\d+$/.test(ctx.message.text)) {
      userIdToBan = parseInt(ctx.message.text, 10);
    } else {
      return ctx.reply(
        "❌ ورودی نامعتبر است. لطفاً شناسه عددی کاربر را ارسال کنید یا پیامی از او فوروارد کنید."
      );
    }
    if (ADMIN_IDs.includes(userIdToBan)) {
      return ctx.reply("⚠️ شما نمی‌توانید یک ادمین را مسدود کنید.");
    }
    const banDbData = await readDB();
    if (banDbData.bannedUsers.includes(userIdToBan)) {
      ctx.session.step = "idle";
      return ctx.reply("⚠️ این کاربر قبلاً مسدود شده است.");
    }
    await runQuery("INSERT INTO banned_users (id) VALUES (?)", [userIdToBan]);
    logger.info(`کاربر ${userIdToBan} توسط ادمین ${ctx.from?.id} مسدود شد.`);

    ctx.session.step = "idle";
    await ctx.reply(`✅ کاربر با شناسه ${userIdToBan} با موفقیت مسدود شد.`);
    try {
      await bot.api.sendMessage(
        userIdToBan,
        "شما توسط ادمین از ربات مسدود شدید."
      );
    } catch (e) {
      logger.warn(
        `نتوانستم به کاربر ${userIdToBan} اطلاع دهم که مسدود شده است.`
      );
    }
    return;
  }

  if (step === "awaiting_user_to_unban") {
    if (!ctx.message.text || !/^\d+$/.test(ctx.message.text)) {
      return ctx.reply(
        "❌ ورودی نامعتبر است. لطفاً فقط شناسه عددی کاربر را ارسال کنید."
      );
    }
    const userIdToUnban = parseInt(ctx.message.text, 10);
    const unbanDbData = await readDB();
    if (!unbanDbData.bannedUsers.includes(userIdToUnban)) {
      ctx.session.step = "idle";
      return ctx.reply("⚠️ این کاربر در لیست مسدود شده‌ها قرار ندارد.");
    }
    await runQuery("DELETE FROM banned_users WHERE id = ?", [userIdToUnban]);
    await runQuery(
      "INSERT OR IGNORE INTO users (id, link_usage_count) VALUES (?, 0)",
      [userIdToUnban]
    );
    logger.info(
      `کاربر ${userIdToUnban} توسط ادمین ${ctx.from?.id} رفع مسدودیت شد.`
    );

    ctx.session.step = "idle";
    await ctx.reply(`✅ کاربر با شناسه ${userIdToUnban} از مسدودیت خارج شد.`);
    try {
      await bot.api.sendMessage(
        userIdToUnban,
        "شما از مسدودیت ربات خارج شدید و دوباره می‌توانید از آن استفاده کنید."
      );
    } catch (e) {
      logger.warn(
        `نتوانستم به کاربر ${userIdToUnban} اطلاع دهم که رفع مسدودیت شده است.`
      );
    }
    return;
  }

  if (step === "awaiting_new_caption_text") {
    const newText = ctx.message.text;
    if (!newText) {
      return ctx.reply("❌ لطفاً یک متن معتبر برای کپشن ارسال کنید.");
    }
    await setSetting("caption_text", JSON.stringify(newText));
    ctx.session.step = "idle";
    await ctx.reply("✅ متن کپشن با موفقیت تغییر یافت.");
    await showAdvancedSettingsMenu(ctx);
    logger.info(`متن کپشن توسط ادمین ${ctx.from?.id} تغییر یافت.`);
    return;
  }

  if (step === "awaiting_new_delete_time") {
    const newTime = parseInt(ctx.message.text, 10);
    if (isNaN(newTime) || newTime <= 0) {
      return ctx.reply(
        "❌ لطفاً یک عدد صحیح و مثبت برای زمان حذف (برحسب ثانیه) ارسال کنید."
      );
    }
    await setSetting("delete_timeout_ms", JSON.stringify(newTime * 1000));
    ctx.session.step = "idle";
    await ctx.reply("✅ زمان حذف محتوا با موفقیت تغییر یافت.");
    await showAdvancedSettingsMenu(ctx);
    logger.info(
      `زمان حذف محتوا توسط ادمین ${ctx.from?.id} به ${newTime} ثانیه تغییر یافت.`
    );
    return;
  }

  if (step === "awaiting_new_force_view_text") {
    const newText = ctx.message.text;
    if (!newText) {
      return ctx.reply(
        "❌ لطفاً یک متن معتبر برای پیام بررسی اجباری ارسال کنید."
      );
    }
    await setSetting("force_view_message_text", JSON.stringify(newText));
    ctx.session.step = "idle";
    await ctx.reply("✅ متن بررسی اجباری با موفقیت تغییر یافت.");
    await showAdvancedSettingsMenu(ctx);
    logger.info(`متن بررسی اجباری توسط ادمین ${ctx.from?.id} تغییر یافت.`);
    return;
  }

  if (step === "awaiting_new_flood_limit") {
    const newLimit = parseInt(ctx.message.text, 10);
    if (isNaN(newLimit) || newLimit <= 0) {
      return ctx.reply("❌ لطفاً یک عدد صحیح و مثبت وارد کنید.");
    }
    await setSetting("flood_limit_count", JSON.stringify(newLimit));
    ctx.session.step = "idle";
    await ctx.reply("✅ حد مجاز پیام (ضد اسپم) با موفقیت تغییر یافت.");
    await showAdvancedSettingsMenu(ctx);
    logger.info(
      `حد مجاز پیام توسط ادمین ${ctx.from?.id} به ${newLimit} تغییر یافت.`
    );
    return;
  }

  if (step === "awaiting_new_file_storage_channel") {
    const newChannel = ctx.message.text;
    if (!newChannel || !newChannel.startsWith("@")) {
      return ctx.reply(
        "❌ لطفاً آیدی کانال را با فرمت `@YourChannelID` ارسال کنید."
      );
    }
    await setSetting("file_storage_channel", JSON.stringify(newChannel));
    ctx.session.step = "idle";
    await ctx.reply("✅ کانال ذخیره فایل‌ها با موفقیت تغییر یافت.");
    await showAdvancedSettingsMenu(ctx);
    logger.info(
      `کانال ذخیره فایل‌ها توسط ادمین ${ctx.from?.id} به ${newChannel} تغییر یافت.`
    );
    return;
  }

  if (step === "awaiting_new_regular_start_text") {
    const incomingText = ctx.message.text;
    if (!incomingText) {
      return ctx.reply(
        "❌ لطفاً متن معتبر ارسال کنید. برای برگشت به پیش‌فرض، عبارت `default` را بفرستید."
      );
    }

    const normalized = incomingText.trim().toLowerCase();
    const newStartText = normalized === "default" ? "" : incomingText;

    await setSetting("regular_user_start_text", JSON.stringify(newStartText));
    ctx.session.step = "idle";

    if (newStartText) {
      await ctx.reply("✅ متن استارت کاربران عادی با موفقیت تغییر یافت.");
    } else {
      await ctx.reply("✅ متن استارت کاربران عادی به حالت پیش‌فرض برگشت.");
    }

    await showAdvancedSettingsMenu(ctx);
    logger.info(
      `متن استارت کاربران عادی توسط ادمین ${ctx.from?.id} به‌روزرسانی شد.`
    );
    return;
  }

  if (step === "awaiting_link_for_stats") {
    const link = ctx.message.text;
    const botUsername = ctx.me.username;
    if (!link || !link.startsWith(`https://t.me/${botUsername}?start=`)) {
      await ctx.reply(
        "❌ لینک وارد شده نامعتبر است. لطفاً یک لینک اشتراک صحیح از این ربات ارسال کنید."
      );
      return;
    }
    const fileIdentifier = link.split("?start=")[1];
    if (!fileIdentifier) {
      await ctx.reply(
        "❌ شناسه فایل از لینک قابل استخراج نیست. لطفاً لینک صحیح را وارد کنید."
      );
      return;
    }

    const file = await getQuery(
      "SELECT usage_count FROM files WHERE file_identifier = ?",
      [fileIdentifier]
    );

    if (file) {
      await ctx.reply(
        `📊 آمار استفاده برای لینک \`${fileIdentifier}\`:\n\nتعداد دانلود: *${file.usage_count}* بار`,
        { parse_mode: "Markdown" }
      );
      logger.info(
        `آمار استفاده برای فایل ${fileIdentifier} (${file.usage_count} بار) به ادمین ${ctx.from?.id} نمایش داده شد.`
      );
    } else {
      await ctx.reply(
        `⚠️ فایلی با شناسه \`${fileIdentifier}\` در دیتابیس یافت نشد.`
      );
      logger.warn(
        `تلاش برای مشاهده آمار فایل ناموجود ${fileIdentifier} توسط ادمین ${ctx.from?.id}.`
      );
    }
    ctx.session.step = "idle";
    await showStatisticsMenu(ctx);
    return;
  }

  // Handle media messages for upload
  if (
    ctx.message.photo ||
    ctx.message.video ||
    ctx.message.audio ||
    ctx.message.document
  ) {
    let file_id, file_type;
    const msg = ctx.message;
    if (msg.photo) {
      file_id = msg.photo.slice(-1)[0].file_id;
      file_type = "photo";
    } else if (msg.video) {
      file_id = msg.video.file_id;
      file_type = "video";
    } else if (msg.audio) {
      file_id = msg.audio.file_id;
      file_type = "audio";
    } else if (msg.document) {
      file_id = msg.document.file_id;
      file_type = "document";
    }

    if (file_id && file_type) {
      if (
        ctx.session.step === "awaiting_caption_input_group_file" &&
        ctx.session.currentFileForCaption
      ) {
        ctx.session.pendingFiles.push({
          ...ctx.session.currentFileForCaption,
          user_caption: null,
        });
        ctx.session.currentFileForCaption = null;
      }

      if (uploadMode === "group") {
        ctx.session.currentFileForCaption = { file_id, file_type };
        ctx.session.step = "awaiting_caption_input_group_file";
        const totalFiles = ctx.session.pendingFiles.length + 1;
        const fileTypePersian =
          { photo: "عکس", video: "ویدیو", audio: "آهنگ", document: "سند" }[file_type] || file_type;
        await ctx.reply(
          `✅ فایل شماره ${totalFiles} (${fileTypePersian}) دریافت شد.\n\nلطفاً کپشن آن را وارد کنید یا /skip را بزنید.\nبرای اتمام و ساخت لینک: /done`
        );
      } else if (uploadMode === "single") {
        ctx.session.pendingFile = { id: file_id, type: file_type };
        ctx.session.step = "awaiting_storage_decision";
        const fileTypePersian =
          { photo: "عکس", video: "ویدیو", audio: "آهنگ", document: "سند" }[file_type] || file_type;
        const keyboard = new InlineKeyboard()
          .text("✅ بله، در کانال ذخیره شود", "store_in_channel")
          .text("❎ خیر", "dont_store_in_channel_single")
          .row()
          .text("❌ لغو عملیات", "cancel_upload");
        await ctx.reply(
          `📌 فایل (${fileTypePersian}) دریافت شد.\n\nآیا مایلید این فایل در کانال ذخیره‌سازی نیز آرشیو شود؟`,
          { reply_markup: keyboard, reply_to_message_id: msg.message_id }
        );
      } else {
        const keyboard = new InlineKeyboard()
          .text("⬆️ دریافت لینک فایل", "admin_get_link")
          .row()
          .text("🏠 پنل اصلی", "admin_panel_main");
        await ctx.reply(
          "📁 برای دریافت لینک فایل، لطفاً ابتدا از پنل مدیریت نوع آپلود (تکی یا گروهی) را انتخاب کنید.",
          { reply_markup: keyboard }
        );
      }
      logger.info(
        `فایل از ${ctx.from?.id} دریافت شد. نوع: ${file_type}, شناسه: ${file_id}.`
      );
      return;
    }
  }
});

// --- Callback Query Handlers ---
bot.callbackQuery("admin_broadcast", promptForBroadcast);
bot.callbackQuery("admin_add_channel", showAddChannelMenu);
bot.callbackQuery("admin_list_files", showFileList);
bot.callbackQuery("admin_get_link", promptForSend);
bot.callbackQuery("admin_manage_users", showUserManagementMenu);
bot.callbackQuery("admin_panel_main", showMainAdminPanel);
bot.callbackQuery("admin_advanced_settings", showAdvancedSettingsMenu);
bot.callbackQuery("admin_show_stats", showStatisticsMenu);
bot.callbackQuery("show_user_stats", showUserStats);
bot.callbackQuery("show_file_stats", showFileStats);
bot.callbackQuery("show_force_join_stats", showForceJoinStats);
bot.callbackQuery("show_link_usage_stats", promptForLinkUsageStats);
bot.callbackQuery("show_top_30_files", showTop30Files);
bot.callbackQuery("admin_help_guide", showAdminHelpGuide);
bot.callbackQuery("list_admins", showAdminList);
bot.callbackQuery("remove_admin_start", showRemoveAdminMenu);
bot.callbackQuery("list_force_join_channels", showForceJoinList);

bot.callbackQuery("add_admin_start", async (ctx) => {
  if (!isPrimaryAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "⚠️ فقط ادمین‌های اصلی می‌توانند ادمین جدید اضافه کنند.", show_alert: true });
    return;
  }
  ctx.session.step = "awaiting_admin_to_add";
  const text = "👑 لطفاً شناسه عددی کاربری که می‌خواهید ادمین شود را ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery(/^remove_admin_confirm:(.+)/, async (ctx) => {
  if (!isPrimaryAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "⚠️ فقط ادمین‌های اصلی می‌توانند ادمین‌ها را حذف کنند.", show_alert: true });
    return;
  }
  const adminIdToRemove = parseInt(ctx.match[1], 10);
  if (ADMIN_IDs.includes(adminIdToRemove)) {
    await ctx.answerCallbackQuery({ text: "⚠️ ادمین‌های اصلی قابل حذف نیستند.", show_alert: true });
    return;
  }
  const removed = await removeDynamicAdminDB(adminIdToRemove);
  if (removed) {
    removeDynamicAdmin(adminIdToRemove);
    await ctx.answerCallbackQuery({ text: "✅ ادمین با موفقیت حذف شد." });
    await safeEditOrReply(ctx, `✅ ادمین با شناسه \`${adminIdToRemove}\` با موفقیت حذف شد.`, null, { parse_mode: "Markdown" });
    logger.info(`ادمین ${adminIdToRemove} توسط ${ctx.from?.id} حذف شد.`);
  } else {
    await ctx.answerCallbackQuery({ text: "❌ خطا در حذف ادمین.", show_alert: true });
  }
  await showUserManagementMenu(ctx);
});

// --- User Help Guide callback (for non-admin users) ---
bot.callbackQuery("user_help_guide", async (ctx) => {
  if (isAdmin(ctx)) {
    await showAdminHelpGuide(ctx);
    return;
  }
  await safeEditOrReply(ctx, USER_HELP_GUIDE_TEXT, null, {
    parse_mode: "Markdown",
  });
});

// --- User Go Home callback ---
bot.callbackQuery("user_go_home", async (ctx) => {
  if (isAdmin(ctx)) {
    await showMainAdminPanel(ctx);
  } else {
    const dbData = await readDB();
    await safeEditOrReply(
      ctx,
      buildRegularUserChannelText(dbData.settings)
    );
  }
});

bot.callbackQuery("admin_delete_file_by_link", async (ctx) => {
  ctx.session.step = "awaiting_delete_link";
  const text =
    "لطفاً لینک اشتراک فایلی که می‌خواهید حذف کنید را ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("ban_user_start", async (ctx) => {
  ctx.session.step = "awaiting_user_to_ban";
  const text =
    "لطفاً شناسه عددی کاربر مورد نظر را ارسال کنید یا یک پیام از او به اینجا فوروارد کنید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("unban_user_start", async (ctx) => {
  ctx.session.step = "awaiting_user_to_unban";
  const text =
    "لطفاً شناسه عددی کاربری که می‌خواهید از مسدودیت خارج شود را ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("broadcast_choose_send", async (ctx) => {
  ctx.session.step = "awaiting_broadcast_message_send";
  const text =
    "✅ حالت «ارسال پیام جدید» فعال شد.\n\nلطفاً پیام مورد نظر خود را برای ارسال مستقیم، ارسال کنید.\n\n*کپشن، پارس مود و دکمه‌های شیشه‌ای (Inline Keyboard) پیام اصلی حفظ خواهند شد.*\n\nبرای لغو /cancel را ارسال کنید.";
  const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
  logger.info(
    `ادمین ${ctx.from?.id} ارسال پیام جدید برای ارسال همگانی را انتخاب کرد.`
  );
});

bot.callbackQuery("broadcast_choose_forward", async (ctx) => {
  ctx.session.step = "awaiting_broadcast_message_forward";
  const text =
    "✅ حالت «فوروارد پیام» فعال شد.\n\nلطفاً پیام مورد نظر خود را برای فوروارد همگانی، فوروارد کنید.\n\n*توجه: تمامی جزئیات پیام دقیقاً مانند پیام اصلی فوروارد خواهد شد.*\n\n⚠️ اگر پیام از یک کانال خصوصی فوروارد شود که ربات به آن دسترسی ندارد، ممکن است عملیات فوروارد با شکست مواجه شود.\n\nبرای لغو /cancel را ارسال کنید.";
  const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
  logger.info(
    `ادمین ${ctx.from?.id} فوروارد پیام برای ارسال همگانی را انتخاب کرد.`
  );
});

bot.callbackQuery("add_channel_start", async (ctx) => {
  ctx.session.step = "awaiting_channel_info";
  const text =
    "یک پیام از کانال/گروه مورد نظر فوروارد کنید یا لینک آن را ارسال کنید.\n\nمثال لینک عمومی: https://t.me/channel_name\nمثال لینک خصوصی: https://t.me/+AbCdEfGh\n\nتوجه: برای چک عضویت، ربات باید در آن کانال/گروه ادمین باشد.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("add_extra_link_start", async (ctx) => {
  ctx.session.step = "awaiting_extra_link_url";
  ctx.session.pendingExtraLink = null;
  const text =
    "لینک تلگرامی مورد نظر را ارسال کنید تا به صورت دکمه کمکی (بدون چک عضویت) نمایش داده شود.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("remove_channel_start", async (ctx) => {
  try {
    const dbData = await readDB();
    if (dbData.forceJoin.length === 0) {
      await ctx.answerCallbackQuery({
        text: "هیچ کانال/گروه اجباری برای حذف وجود ندارد.",
      });
      const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_add_channel");
      return await safeEditOrReply(
        ctx,
        "هیچ کانال/گروه اجباری برای حذف وجود ندارد.",
        keyboard
      );
    }
    const keyboard = new InlineKeyboard();
    dbData.forceJoin.forEach((channel) => {
      keyboard.text(`❌ ${channel.title}`, `remove_ch_${channel.id}`).row();
    });
    keyboard.text("⬅️ بازگشت", "admin_add_channel");
    const text =
      "کدام کانال/گروه را می‌خواهید از لیست جوین اجباری حذف کنید؟";
    await safeEditOrReply(ctx, text, keyboard);
  } catch (e) {
    logger.error("خطا در نمایش لیست کانال‌ها برای حذف:", e);
    await ctx.answerCallbackQuery({
      text: "خطا در بارگذاری لیست کانال‌ها.",
      show_alert: true,
    });
    await safeEditOrReply(
      ctx,
      "خطا در بارگذاری لیست کانال‌ها. لطفاً دوباره امتحان کنید.",
      null
    );
  }
});

bot.callbackQuery("remove_extra_link_start", async (ctx) => {
  try {
    const links = await allQuery(
      "SELECT id, title, button_text FROM force_join_extra_links ORDER BY id DESC"
    );

    if (links.length === 0) {
      await ctx.answerCallbackQuery({
        text: "هیچ لینک کمکی‌ای برای حذف وجود ندارد.",
      });
      return await safeEditOrReply(
        ctx,
        "هیچ لینک کمکی‌ای برای حذف وجود ندارد.",
        null
      );
    }

    const keyboard = new InlineKeyboard();
    links.forEach((link) => {
      const title = link.button_text || link.title || `ID ${link.id}`;
      keyboard.text(`❌ ${title}`, `remove_extra_link_${link.id}`).row();
    });
    keyboard.text("⬅️ بازگشت", "admin_add_channel");

    await safeEditOrReply(
      ctx,
      "کدام لینک کمکی را می‌خواهید حذف کنید؟",
      keyboard
    );
  } catch (e) {
    logger.error("خطا در نمایش لیست لینک‌های کمکی برای حذف:", e);
    await ctx.answerCallbackQuery({
      text: "خطا در بارگذاری لینک‌های کمکی.",
      show_alert: true,
    });
    await safeEditOrReply(
      ctx,
      "خطا در بارگذاری لینک‌های کمکی. لطفاً دوباره امتحان کنید.",
      null
    );
  }
});

bot.callbackQuery(/^remove_ch_/, async (ctx) => {
  const channelIdRaw = ctx.match.input.substring("remove_ch_".length);
  const channelId = parseInt(channelIdRaw, 10);

  try {
    const result = await runQuery(
      "DELETE FROM force_join_channels WHERE id = ?",
      [channelId]
    );
    await runQuery("DELETE FROM user_channel_joins WHERE channel_id = ?", [
      channelId,
    ]);

    if (result.changes > 0) {
      await ctx.answerCallbackQuery({ text: `مورد با موفقیت حذف شد.` });
      logger.info(`کانال جوین اجباری ${channelId} و اطلاعات جوین آن حذف شد.`);
    } else {
      await ctx.answerCallbackQuery({ text: "خطا: مورد یافت نشد." });
      logger.warn(`تلاش برای حذف کانال جوین اجباری ناموجود ${channelId}.`);
    }
    await showAddChannelMenu(ctx);
  } catch (e) {
    logger.error(`خطا در حذف کانال جوین اجباری ${channelId}:`, e);
    await ctx.answerCallbackQuery({
      text: "❌ خطایی در حذف کانال رخ داد.",
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^remove_extra_link_(\d+)$/, async (ctx) => {
  const linkId = parseInt(ctx.match[1], 10);
  try {
    const result = await runQuery(
      "DELETE FROM force_join_extra_links WHERE id = ?",
      [linkId]
    );

    if (result.changes > 0) {
      await ctx.answerCallbackQuery({ text: "لینک کمکی با موفقیت حذف شد." });
      logger.info(`لینک کمکی ${linkId} حذف شد.`);
    } else {
      await ctx.answerCallbackQuery({
        text: "خطا: لینک کمکی یافت نشد.",
        show_alert: true,
      });
    }
    await showAddChannelMenu(ctx);
  } catch (e) {
    logger.error(`خطا در حذف لینک کمکی ${linkId}:`, e);
    await ctx.answerCallbackQuery({
      text: "❌ خطایی در حذف لینک کمکی رخ داد.",
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^list_/, async (ctx) => {
  const fileType = ctx.match.input.substring("list_".length);
  const dbData = await readDB();
  const files = dbData.files.filter((f) => {
    if (f.file_type) return f.file_type === fileType;
    if (f.file_types && Array.isArray(f.file_types))
      return f.file_types.includes(fileType);
    return false;
  });
  if (files.length === 0) {
    await ctx.answerCallbackQuery({
      text: `هیچ فایلی از این نوع یافت نشد.`,
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery();
  const links = files.map(
    (file) => `https://t.me/${ctx.me.username}?start=${file.file_identifier}`
  );
  const chunkSize = 10;
  for (let i = 0; i < links.length; i += chunkSize) {
    const chunk = links.slice(i, i + chunkSize).join("\n");
    try {
      await ctx.reply(chunk, { disable_web_page_preview: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (e) {
      logger.error(`خطا در ارسال لیست لینک‌ها به ${ctx.from?.id}:`, e);
      await ctx.reply("خطا در ارسال برخی لینک‌ها. لطفاً دوباره تلاش کنید.");
      break;
    }
  }
});

bot.callbackQuery("upload_single", async (ctx) => {
  ctx.session.uploadMode = "single";
  ctx.session.step = "awaiting_single_file";
  const text =
    "📌 حالت دریافت لینک تکی فعال شد.\n\nلطفاً فایل مورد نظر (عکس، ویدیو، آهنگ یا سند) را ارسال کنید تا لینک اشتراک‌گذاری آن ساخته شود.\n\nبرای لغو /cancel را ارسال کنید.";
  const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_get_link");
  await safeEditOrReply(ctx, text, keyboard);
});

bot.callbackQuery("upload_group", async (ctx) => {
  ctx.session.uploadMode = "group";
  ctx.session.pendingFiles = [];
  ctx.session.currentFileForCaption = null;
  ctx.session.step = "awaiting_group_files";
  const text =
    "📦 حالت دریافت لینک گروهی فعال شد.\n\nفایل‌های خود را یکی یکی ارسال کنید. برای هر فایل می‌توانید کپشن اختصاصی وارد کنید یا /skip بزنید.\n\nپس از ارسال تمام فایل‌ها، /done را بفرستید تا یک لینک مشترک ساخته شود.\n\nبرای لغو /cancel را ارسال کنید.";
  const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_get_link");
  await safeEditOrReply(ctx, text, keyboard);
});

bot.callbackQuery("store_in_channel", (ctx) =>
  promptForCaptionSingle(ctx, true)
);
bot.callbackQuery("dont_store_in_channel_single", (ctx) =>
  promptForCaptionSingle(ctx, false)
);

bot.callbackQuery("cancel_upload", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.pendingFile = null;
  ctx.session.pendingFiles = [];
  ctx.session.uploadMode = null;
  ctx.session.pendingExtraLink = null;
  ctx.session.forceViewMessageId = null;
  ctx.session.currentFileForCaption = null;
  ctx.session.pendingStartMessageId = null;
  ctx.session.broadcastMessageContent = null;
  ctx.session.broadcastMessageType = null;
  ctx.session.broadcastMessageOptions = {};
  ctx.session.broadcastOriginalMessageId = null;
  const text = "❌ عملیات آپلود فایل لغو شد.";
  await safeEditOrReply(ctx, text);
  await showMainAdminPanel(ctx);
  logger.info(`آپلود فایل توسط ادمین ${ctx.from?.id} لغو شد.`);
});

bot.callbackQuery(/^set_member_limit:(.+)/, async (ctx) => {
  const channelIdRaw = ctx.match[1];
  ctx.session.targetChannelId = parseInt(channelIdRaw, 10);
  ctx.session.step = "awaiting_member_limit";
  const text =
    "لطفاً تعداد اعضای جدیدی که با رسیدن به آن، کانال حذف شود را وارد کنید (مثال: 100).\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("store_group_in_channel", async (ctx) => {
  const text = "⏳ در حال ذخیره فایل‌ها در کانال و ساخت لینک...";
  await safeEditOrReply(ctx, text);
  await processAndSaveGroupFiles(ctx, true, bot);
});

bot.callbackQuery("dont_store_in_channel_group", async (ctx) => {
  const text = "⏳ در حال ساخت لینک اشتراک...";
  await safeEditOrReply(ctx, text);
  await processAndSaveGroupFiles(ctx, false, bot);
});

bot.callbackQuery("change_caption_start", async (ctx) => {
  ctx.session.step = "awaiting_new_caption_text";
  const text =
    "لطفاً متن جدید کپشن را ارسال کنید:\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("change_delete_time_start", async (ctx) => {
  ctx.session.step = "awaiting_new_delete_time";
  const text =
    "لطفاً زمان جدید حذف محتوا را بر حسب ثانیه ارسال کنید (مثال: 30):\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("change_force_view_text_start", async (ctx) => {
  ctx.session.step = "awaiting_new_force_view_text";
  const text =
    "لطفاً متن جدید پیام بررسی اجباری را ارسال کنید:\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("toggle_force_view_status", async (ctx) => {
  const dbData = await readDB();
  const newState = !dbData.settings.is_force_view_enabled;
  await setSetting("is_force_view_enabled", JSON.stringify(newState));
  await ctx.answerCallbackQuery({
    text: `وضعیت بررسی اجباری به ${newState ? "روشن" : "خاموش"} تغییر یافت.`,
    show_alert: true,
  });
  await showAdvancedSettingsMenu(ctx);
  logger.info(
    `وضعیت بررسی اجباری توسط ادمین ${ctx.from?.id} به ${newState} تغییر یافت.`
  );
});

bot.callbackQuery("toggle_bot_status", async (ctx) => {
  const dbData = await readDB();
  const newState = !dbData.settings.is_bot_enabled;
  await setSetting("is_bot_enabled", JSON.stringify(newState));
  await ctx.answerCallbackQuery({
    text: `وضعیت ربات به ${newState ? "روشن" : "خاموش"} تغییر یافت.`,
    show_alert: true,
  });
  await showAdvancedSettingsMenu(ctx);
  logger.info(
    `وضعیت ربات توسط ادمین ${ctx.from?.id} به ${newState} تغییر یافت.`
  );
});

bot.callbackQuery("change_flood_limit_start", async (ctx) => {
  ctx.session.step = "awaiting_new_flood_limit";
  const text = `لطفاً حد مجاز جدید برای تعداد پیام‌ها در ${FLOOD_LIMIT_SECONDS_GLOBAL} ثانیه را وارد کنید (مثال: 10):\n\nبرای لغو /cancel را ارسال کنید.`;
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("change_file_storage_channel_start", async (ctx) => {
  ctx.session.step = "awaiting_new_file_storage_channel";
  const text =
    "لطفاً آیدی جدید کانال ذخیره فایل‌ها را با فرمت `@YourChannelID` ارسال کنید:\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

bot.callbackQuery("change_broadcast_speed_start", async (ctx) => {
  const dbData = await readDB();
  const currentProfile =
    typeof dbData.settings.broadcast_speed_profile === "string"
      ? dbData.settings.broadcast_speed_profile
      : "safe";
  const profileLabels = {
    safe: "ایمن",
    balanced: "متعادل",
    fast: "سریع",
  };
  const currentLabel = profileLabels[currentProfile] || "ایمن";

  const text =
    `🚦 پروفایل سرعت ارسال همگانی را انتخاب کنید.\n\n` +
    `پروفایل فعلی: ${currentLabel}\n\n` +
    `ایمن: کم‌ریسک‌تر و مناسب زمانی که کاربران همزمان از بقیه امکانات ربات استفاده می‌کنند.\n` +
    `متعادل: سرعت مناسب با ریسک کنترل‌شده.\n` +
    `سریع: فقط زمانی که نیاز به اتمام سریع‌تر دارید.`;

  const keyboard = new InlineKeyboard()
    .text("🟢 ایمن (Recommended)", "set_broadcast_speed:safe")
    .row()
    .text("🟡 متعادل", "set_broadcast_speed:balanced")
    .row()
    .text("🔴 سریع", "set_broadcast_speed:fast")
    .row()
    .text("⬅️ بازگشت", "admin_advanced_settings");

  await safeEditOrReply(ctx, text, keyboard);
});

bot.callbackQuery(/^set_broadcast_speed:(safe|balanced|fast)$/, async (ctx) => {
  const profile = ctx.match[1];
  const profileLabels = {
    safe: "ایمن",
    balanced: "متعادل",
    fast: "سریع",
  };

  await setSetting("broadcast_speed_profile", JSON.stringify(profile));
  await ctx.answerCallbackQuery({
    text: `پروفایل سرعت ارسال همگانی روی «${profileLabels[profile]}» تنظیم شد.`,
    show_alert: true,
  });
  logger.info(
    `پروفایل سرعت ارسال همگانی توسط ادمین ${ctx.from?.id} روی ${profile} تنظیم شد.`
  );
  await showAdvancedSettingsMenu(ctx);
});

bot.callbackQuery("change_regular_start_text_start", async (ctx) => {
  ctx.session.step = "awaiting_new_regular_start_text";
  const text =
    "لطفاً متن استارت کاربران عادی را ارسال کنید.\n\nبرای بازگشت به پیام پیش‌فرض، عبارت `default` را بفرستید.\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
});

// --- Error Handler ---
async function notifyAdminOnError(error, update, updateId) {
  const escapeHtml = (text) => {
    if (typeof text !== "string") return text;
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const errorDetails = `
🚨 <b>خطای جدی در ربات!</b> 🚨

<b>زمان:</b> ${new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}
<b>شناسه آپدیت:</b> <code>${updateId}</code>
<b>نوع آپدیت:</b> <code>${escapeHtml(
    Object.keys(update)[1]
  )}</code>

<b>پیام خطا:</b> <code>${escapeHtml(error.message)}</code>
<b>نام خطا:</b> <code>${escapeHtml(error.name)}</code>

<b>استک تریس:</b>
<pre>
${escapeHtml(
  error.stack
    ? error.stack.substring(0, 1500) +
        (error.stack.length > 1500 ? "\n...(ادامه در لاگ کنسول)" : "")
    : "N/A"
)}
</pre>

<b>اطلاعات Context:</b>
<pre>
${escapeHtml(
  JSON.stringify(
    {
      chatId:
        update.message?.chat?.id ||
        update.callback_query?.message?.chat?.id ||
        "N/A",
      userId:
        update.message?.from?.id || update.callback_query?.from?.id || "N/A",
      username:
        update.message?.from?.username ||
        update.callback_query?.from?.username ||
        "N/A",
      queryData: update.callback_query?.data || "N/A",
      messageText: update.message?.text || "N/A",
    },
    null,
    2
  ).substring(0, 500)
)}
</pre>
`.trim();

  for (const adminId of ADMIN_IDs) {
    try {
      await bot.api.sendMessage(adminId, errorDetails, { parse_mode: "HTML" });
      logger.error(`خطای بحرانی به ادمین ${adminId} اطلاع داده شد.`);
    } catch (adminError) {
      logger.error(
        `فاجعه! نتوانستم به ادمین ${adminId} اطلاع دهم:`,
        adminError
      );
    }
  }
}

bot.catch(async (err) => {
  const ctx = err.ctx;
  logger.error(`خطا هنگام پردازش آپدیت ${ctx.update.update_id}:`, err);

  await notifyAdminOnError(err.error, ctx.update, ctx.update.update_id);

  try {
    if (ctx.chat?.type === "private") {
      await ctx.reply(
        "❌ متاسفانه خطایی غیرمنتظره رخ داد. ادمین از این موضوع مطلع شد و در حال بررسی است."
      );
    }
  } catch (userReplyError) {
    logger.error("خطا در ارسال پیام به کاربر در بلاک catch:", userReplyError);
  }
});

// --- Start Bot ---
async function startBot() {
  await initializeDatabase();
  // Load dynamic admins from database into memory cache
  const dynamicAdminIdsList = await getDynamicAdminIds();
  loadDynamicAdmins(dynamicAdminIdsList);
  logger.info("ربات در حال اجرا است...");
  await bot.start();
}

startBot();
