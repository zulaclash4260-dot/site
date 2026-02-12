const { InlineKeyboard } = require("grammy");
const { logger, isAdmin, ADMIN_IDs, FLOOD_LIMIT_SECONDS_GLOBAL, getDynamicAdmins } = require("./config");
const { safeEditOrReply } = require("./helpers");
const { runQuery, getQuery, allQuery, setSetting, readDB } = require("../db");

const BROADCAST_SPEED_LABELS = {
  safe: "ایمن",
  balanced: "متعادل",
  fast: "سریع",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function measureApiPing(ctx) {
  const startedAt = Date.now();
  try {
    await ctx.api.getMe();
    return Date.now() - startedAt;
  } catch (error) {
    logger.warn(`Failed to measure ping for admin ${ctx.from?.id}: ${error.message}`);
    return null;
  }
}

async function showMainAdminPanel(ctx) {
  const text = "سلام ادمین عزیز! به پنل مدیریت خوش آمدید.";
  const keyboard = new InlineKeyboard()
    .text("📨 ارسال همگانی", "admin_broadcast")
    .row()
    .text("➕ مدیریت جوین اجباری", "admin_add_channel")
    .text("🚫 مدیریت کاربران", "admin_manage_users")
    .row()
    .text("📊 آمار فایل‌ها", "admin_list_files")
    .text("⬆️ دریافت لینک فایل", "admin_get_link")
    .row()
    .text("🗑️ حذف فایل با لینک", "admin_delete_file_by_link")
    .row()
    .text("⚙️ تنظیمات پیشرفته", "admin_advanced_settings")
    .text("📈 آمار ربات", "admin_show_stats")
    .row()
    .text("📖 راهنمای ادمین", "admin_help_guide");
  await safeEditOrReply(ctx, text, keyboard);
  logger.info(`پنل ادمین برای ${ctx.from?.id} نمایش داده شد.`);
}

async function promptForBroadcast(ctx) {
  ctx.session.step = "awaiting_broadcast_type_selection";
  const text = "📨 لطفاً نوع پیامی که می‌خواهید ارسال همگانی کنید را انتخاب کنید:";
  const keyboard = new InlineKeyboard()
    .text("📤 ارسال پیام جدید (با حفظ فرمت)", "broadcast_choose_send")
    .row()
    .text("↩️ فوروارد پیام (با برچسب فوروارد)", "broadcast_choose_forward")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
  logger.info(`درخواست ارسال همگانی از ${ctx.from?.id}.`);
}

async function showUserManagementMenu(ctx) {
  const text = "یک گزینه برای مدیریت کاربران انتخاب کنید:";
  const keyboard = new InlineKeyboard()
    .text("🚫 مسدود کردن کاربر", "ban_user_start")
    .row()
    .text("✅ رفع مسدودیت کاربر", "unban_user_start")
    .row()
    .text("👑 افزودن ادمین", "add_admin_start")
    .text("🗑️ حذف ادمین", "remove_admin_start")
    .row()
    .text("📋 لیست ادمین‌ها", "list_admins")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
}

async function promptForSend(ctx) {
  const text = "📁 لطفاً نوع آپلود فایل را انتخاب کنید:\n\n📌 تکی: یک فایل ارسال کنید و لینک دریافت کنید.\n📦 گروهی: چند فایل ارسال کنید و یک لینک مشترک بسازید.";
  const keyboard = new InlineKeyboard()
    .text("📌 دریافت لینک تکی", "upload_single")
    .text("📦 دریافت لینک گروهی", "upload_group")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
}

async function showFileList(ctx) {
  const dbData = await readDB();
  if (dbData.files.length === 0) {
    await ctx.answerCallbackQuery({ text: "هیچ فایلی ذخیره نشده است." });
    return;
  }
  const counts = dbData.files.reduce((acc, file) => {
    const type =
      file.file_type ||
      (Array.isArray(file.file_types) ? file.file_types[0] : "unknown");
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  let message_text = "📊 آمار فایل‌ها:\n\n";
  const keyboard = new InlineKeyboard();
  for (const [type, count] of Object.entries(counts)) {
    const fileTypePersian =
      { photo: "عکس", video: "ویدیو", audio: "آهنگ", document: "سند" }[type] ||
      type;
    message_text += `▫️ ${fileTypePersian}: ${count} عدد\n`;
    keyboard.text(`نمایش ${fileTypePersian}‌ها`, `list_${type}`).row();
  }
  keyboard.row().text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, message_text, keyboard);
}

async function showAddChannelMenu(ctx) {
  const keyboard = new InlineKeyboard()
    .text("➕ افزودن کانال/گروه اجباری", "add_channel_start")
    .row()
    .text("➖ حذف کانال/گروه اجباری", "remove_channel_start")
    .row()
    .text("🔗 افزودن لینک کمکی (بدون چک)", "add_extra_link_start")
    .row()
    .text("🗑️ حذف لینک کمکی (بدون چک)", "remove_extra_link_start")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  const text =
    "برای افزودن اجباری، یک پیام از کانال/گروه فوروارد کنید تا عضویت کاربر چک شود.\n\nبرای لینک کمکی، فقط دکمه لینک اضافه می‌شود و چک عضویت انجام نمی‌شود.";
  await safeEditOrReply(ctx, text, keyboard);
}

async function showAdvancedSettingsMenu(ctx) {
  const dbData = await readDB();
  const currentForceViewStatus = dbData.settings.is_force_view_enabled
    ? "روشن ✅"
    : "خاموش ❌";
  const currentBotStatus = dbData.settings.is_bot_enabled
    ? "روشن ✅"
    : "خاموش ❌";
  const currentFloodLimit = dbData.settings.flood_limit_count;
  const currentFileStorageChannel = dbData.settings.file_storage_channel;
  const currentRegularUserStartText =
    typeof dbData.settings.regular_user_start_text === "string"
      ? dbData.settings.regular_user_start_text.trim()
      : "";
  const currentBroadcastSpeedProfile =
    typeof dbData.settings.broadcast_speed_profile === "string"
      ? dbData.settings.broadcast_speed_profile
      : "safe";
  const currentBroadcastSpeedLabel =
    BROADCAST_SPEED_LABELS[currentBroadcastSpeedProfile] || "ایمن";
  const regularUserStartPreview = currentRegularUserStartText
    ? currentRegularUserStartText.length > 80
      ? `${currentRegularUserStartText.slice(0, 80)}...`
      : currentRegularUserStartText
    : "(پیام پیش‌فرض کانال)";

  const text = `تنظیمات پیشرفته:
    
    متن کپشن پیش‌فرض: ${dbData.settings.caption_text}
    زمان حذف خودکار محتوا: ${dbData.settings.delete_timeout_ms / 1000} ثانیه
    متن بررسی اجباری: ${dbData.settings.force_view_message_text}
    وضعیت بررسی اجباری: ${currentForceViewStatus}
    وضعیت ربات: ${currentBotStatus}
    حداکثر پیام در ${FLOOD_LIMIT_SECONDS_GLOBAL} ثانیه (ضد اسپم): ${currentFloodLimit}
    کانال ذخیره فایل‌ها: \`${currentFileStorageChannel}\`
    متن استارت کاربران عادی: ${regularUserStartPreview}
    پروفایل سرعت ارسال همگانی: ${currentBroadcastSpeedLabel}`;

  const keyboard = new InlineKeyboard()
    .text("📝 تغییر متن کپشن", "change_caption_start")
    .row()
    .text("⏰ تغییر زمان حذف محتوا", "change_delete_time_start")
    .row()
    .text("✍️ تغییر متن بررسی اجباری", "change_force_view_text_start")
    .row()
    .text(
      `💡 ${currentForceViewStatus} کردن بررسی اجباری`,
      "toggle_force_view_status"
    )
    .row()
    .text(`🔘 ${currentBotStatus} کردن ربات`, "toggle_bot_status")
    .row()
    .text("⚠️ تغییر حد مجاز پیام (ضد اسپم)", "change_flood_limit_start")
    .row()
    .text("📂 تغییر کانال ذخیره فایل‌ها", "change_file_storage_channel_start")
    .row()
    .text("👤 تغییر متن استارت کاربران عادی", "change_regular_start_text_start")
    .row()
    .text("🚦 تغییر سرعت ارسال همگانی", "change_broadcast_speed_start")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");

  await safeEditOrReply(ctx, text, keyboard);
}

async function showStatisticsMenu(ctx) {
  const text = "📊 لطفاً نوع آماری که می‌خواهید مشاهده کنید را انتخاب کنید:";
  const keyboard = new InlineKeyboard()
    .text("👥 آمار کاربران", "show_user_stats")
    .row()
    .text("🗂️ آمار فایل‌ها", "show_file_stats")
    .row()
    .text("➕ آمار جوین اجباری", "show_force_join_stats")
    .row()
    .text("🔗 آمار استفاده از لینک‌ها", "show_link_usage_stats")
    .row()
    .text("🔝 30 فایل برتر", "show_top_30_files")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  await safeEditOrReply(ctx, text, keyboard);
}

async function showUserStats(ctx) {
  const dbData = await readDB();
  const totalUsers = dbData.users.length;
  const bannedUsers = dbData.bannedUsers.length;
  const activeUsers = totalUsers - bannedUsers;
  const dynamicAdmins = getDynamicAdmins();
  const totalAdmins = ADMIN_IDs.length + dynamicAdmins.length;

  // Calculate users with activity
  const activeLinkers = dbData.allUsersData.filter((u) => u.link_usage_count > 0).length;
  const totalLinkUsage = dbData.allUsersData.reduce((sum, u) => sum + (u.link_usage_count || 0), 0);
  const avgLinkUsage = totalUsers > 0 ? (totalLinkUsage / totalUsers).toFixed(1) : 0;

  let message = `📊 **آمار کاربران:**

👤 کل کاربران: **${totalUsers}**
✅ کاربران فعال (غیر مسدود): **${activeUsers}**
🚫 کاربران مسدود شده: **${bannedUsers}**
👑 تعداد ادمین‌ها: **${totalAdmins}**

📈 **فعالیت کاربران:**
🔗 کاربران با حداقل یک دانلود: **${activeLinkers}**
📥 مجموع استفاده از لینک‌ها: **${totalLinkUsage}**
📊 میانگین استفاده از لینک به ازای هر کاربر: **${avgLinkUsage}**`;

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت به آمار",
    "admin_show_stats"
  );
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
}

async function showFileStats(ctx) {
  const dbData = await readDB();
  const totalFiles = dbData.files.length;
  const counts = dbData.files.reduce((acc, file) => {
    const type =
      file.file_type ||
      (Array.isArray(file.file_types) ? file.file_types[0] : "unknown");
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const totalDownloads = dbData.files.reduce((sum, f) => sum + (f.usage_count || 0), 0);
  const avgDownloads = totalFiles > 0 ? (totalDownloads / totalFiles).toFixed(1) : 0;
  const mostDownloaded = dbData.files.reduce(
    (max, f) => ((f.usage_count || 0) > (max.usage_count || 0) ? f : max),
    { usage_count: 0 }
  );
  const groupFiles = dbData.files.filter((f) => f.file_ids && Array.isArray(f.file_ids)).length;
  const singleFiles = totalFiles - groupFiles;

  let message = `📊 **آمار فایل‌ها:**

📦 کل فایل‌های ذخیره شده: **${totalFiles}**
📌 فایل‌های تکی: **${singleFiles}**
📦 فایل‌های گروهی: **${groupFiles}**

📥 **آمار دانلود:**
📊 مجموع دانلودها: **${totalDownloads}**
📈 میانگین دانلود هر فایل: **${avgDownloads}**
🏆 بیشترین دانلود: **${mostDownloaded.usage_count || 0}** بار${
    mostDownloaded.file_identifier
      ? ` (\`${mostDownloaded.file_identifier}\`)`
      : ""
  }

📂 **تفکیک بر اساس نوع:**\n`;

  for (const [type, count] of Object.entries(counts)) {
    const fileTypePersian =
      {
        photo: "🖼️ عکس",
        video: "🎬 ویدیو",
        audio: "🎵 آهنگ",
        document: "📄 سند",
        unknown: "❓ نامشخص",
      }[type] || type;
    const percentage = totalFiles > 0 ? ((count / totalFiles) * 100).toFixed(1) : 0;
    message += `${fileTypePersian}: **${count}** عدد (${percentage}%)\n`;
  }

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت به آمار",
    "admin_show_stats"
  );
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
}

async function showForceJoinStats(ctx) {
  const dbData = await readDB();
  const totalForceJoinChannels = dbData.forceJoin.length;
  const totalExtraLinks = Array.isArray(dbData.extraForceJoinLinks)
    ? dbData.extraForceJoinLinks.length
    : 0;

  let message = `📊 آمار جوین اجباری:
    
    ➕ تعداد کل کانال‌ها/گروه‌های جوین اجباری: ${totalForceJoinChannels}
    🔗 تعداد لینک‌های کمکی بدون چک: ${totalExtraLinks}\n\n`;

  if (totalForceJoinChannels > 0) {
    message += `جزئیات کانال‌ها:\n`;
    for (const channel of dbData.forceJoin) {
      let conditionText = "بدون شرط حذف خودکار";
      if (channel.condition) {
        conditionText = `حذف بعد از **${channel.condition.limit}** عضو جدید (فعلی: **${channel.condition.current_count}**)`;
      }
      const currentCount = channel.condition?.current_count || 0;

      const buttonText =
        typeof channel.button_text === "string" && channel.button_text.trim()
          ? channel.button_text.trim()
          : `عضویت در ${channel.title}`;
      message += `- **${channel.title}** (شناسه: \`${channel.id}\`)\n  نوع: ${
        channel.chat_type === "supergroup" || channel.chat_type === "group"
          ? "گروه"
          : "کانال"
      }\n  لینک: ${channel.invite_link}\n  متن دکمه: ${buttonText}\n  ${conditionText}\n  تعداد جوین منحصر به فرد (تایید شده توسط ربات): **${currentCount}** کاربر\n\n`;
    }
  } else {
    message += `فعلاً هیچ کانال/گروهی برای جوین اجباری ثبت نشده است.`;
  }

  if (totalExtraLinks > 0) {
    message += `\n🔗 **لینک‌های کمکی (بدون چک):**\n`;
    for (const link of dbData.extraForceJoinLinks) {
      const btn =
        typeof link.button_text === "string" && link.button_text.trim()
          ? link.button_text.trim()
          : link.title || "لینک کمکی";
      message += `- ${btn}: ${link.invite_link}\n`;
    }
  }

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت به آمار",
    "admin_show_stats"
  );
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
}

async function promptForLinkUsageStats(ctx) {
  ctx.session.step = "awaiting_link_for_stats";
  const text =
    "لطفاً لینک اشتراک فایلی که می‌خواهید آمار استفاده‌اش را مشاهده کنید، ارسال کنید.\n\nبرای لغو /cancel را ارسال کنید.";
  await safeEditOrReply(ctx, text);
}

async function showTop30Files(ctx) {
  const files = await allQuery(
    "SELECT file_identifier, usage_count FROM files ORDER BY usage_count DESC LIMIT 30"
  );

  if (files.length === 0) {
    await ctx.answerCallbackQuery({
      text: "هیچ فایلی برای نمایش آمار دانلود یافت نشد.",
    });
    return;
  }

  await ctx.answerCallbackQuery();

  let message_text = "🔝 **30 فایل پردانلود اخیر:**\n\n";
  const botUsername = ctx.me.username;

  for (const file of files) {
    const link = `https://t.me/${botUsername}?start=${file.file_identifier}`;
    message_text += `[تعداد دانلود: ${file.usage_count}](${link})\n`;
  }

  const chunkSize = 4000;
  const chunks = [];
  while (message_text.length > 0) {
    chunks.push(message_text.substring(0, chunkSize));
    message_text = message_text.substring(chunkSize);
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت به آمار",
    "admin_show_stats"
  );
  await ctx.reply("پایان لیست فایل‌های پردانلود.", { reply_markup: keyboard });
  logger.info(`لیست 30 فایل برتر به ادمین ${ctx.from?.id} نمایش داده شد.`);
}

async function showAdminHelpGuide(ctx) {
  const guideText = `📖 **راهنمای کامل پنل ادمین**

🔹 **ارسال همگانی** (📨)
دو حالت دارد:
• **ارسال پیام جدید**: پیام شما بدون برچسب فوروارد برای همه کاربران کپی و ارسال می‌شود. کپشن، فرمت و دکمه‌های شیشه‌ای حفظ می‌شوند.
• **فوروارد پیام**: پیام با برچسب فوروارد ارسال می‌شود. توجه: اگر پیام از کانال خصوصی باشد ممکن است ارسال نشود.
⚠️ ربات بصورت خودکار با تأخیر بهینه ارسال می‌کند تا از محدودیت تلگرام جلوگیری شود.

🔹 **مدیریت جوین اجباری** (➕)
• یک پیام از کانال/گروه فوروارد کنید تا اضافه شود (چک عضویت انجام می‌شود).
• لینک دعوت و متن دکمه عضویت را تنظیم کنید.
• شرط حذف خودکار بر اساس تعداد عضو قابل تنظیم است.
• می‌توانید لینک کمکی اضافه کنید که فقط نمایش داده می‌شود و چک عضویت ندارد.

🔹 **مدیریت کاربران** (🚫)
• **مسدود کردن**: شناسه عددی بفرستید یا پیامی از کاربر فوروارد کنید.
• **رفع مسدودیت**: شناسه عددی کاربر را بفرستید.
• **افزودن ادمین**: شناسه عددی کاربر را بفرستید تا ادمین شود.
• **حذف ادمین**: از لیست ادمین‌ها انتخاب کنید.
• **لیست ادمین‌ها**: مشاهده تمام ادمین‌های ربات.

🔹 **آمار فایل‌ها** (📊)
تعداد فایل‌ها به تفکیک نوع (عکس/ویدیو/آهنگ/سند) نمایش داده می‌شود.

🔹 **دریافت لینک فایل** (⬆️)
• **تکی**: یک فایل بفرستید، کپشن تنظیم کنید و لینک دریافت کنید.
• **گروهی**: چند فایل بفرستید و یک لینک مشترک بسازید.

🔹 **حذف فایل با لینک** (🗑️)
لینک اشتراک فایل را بفرستید تا از دیتابیس حذف شود.

🔹 **تنظیمات پیشرفته** (⚙️)
• متن کپشن پیش‌فرض
• زمان حذف خودکار محتوا
• متن بررسی اجباری
• روشن/خاموش کردن بررسی اجباری
• روشن/خاموش کردن ربات
• حد مجاز پیام (ضد اسپم)
• کانال ذخیره فایل‌ها
• سرعت ارسال همگانی (ایمن/متعادل/سریع)

🔹 **آمار ربات** (📈)
• آمار کاربران، فایل‌ها، جوین اجباری
• آمار استفاده از لینک‌ها
• ۳۰ فایل پردانلود

🔹 **دستورات مفید**
• /cancel - لغو عملیات جاری
• /skip - رد کردن کپشن
• /done - اتمام آپلود گروهی
• /ban - مسدود کردن کاربر
• /unban - رفع مسدودیت
• /help - نمایش این راهنما`;

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت",
    "admin_panel_main"
  );
  await safeEditOrReply(ctx, guideText, keyboard, { parse_mode: "Markdown" });
  logger.info(`راهنمای ادمین برای ${ctx.from?.id} نمایش داده شد.`);
}

async function showAdminList(ctx) {
  const dynamicAdmins = getDynamicAdmins();

  let message = `👑 **لیست ادمین‌های ربات:**\n\n`;
  message += `🔒 **ادمین‌های اصلی (غیرقابل حذف):**\n`;
  for (const id of ADMIN_IDs) {
    message += `• \`${id}\`\n`;
  }

  if (dynamicAdmins.length > 0) {
    message += `\n🔓 **ادمین‌های افزوده شده:**\n`;
    for (const id of dynamicAdmins) {
      message += `• \`${id}\`\n`;
    }
  } else {
    message += `\nهیچ ادمین اضافی ثبت نشده است.`;
  }

  message += `\n\n📊 مجموع ادمین‌ها: **${ADMIN_IDs.length + dynamicAdmins.length}**`;

  const keyboard = new InlineKeyboard()
    .text("👑 افزودن ادمین", "add_admin_start")
    .text("🗑️ حذف ادمین", "remove_admin_start")
    .row()
    .text("⬅️ بازگشت", "admin_manage_users");
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
}

async function showRemoveAdminMenu(ctx) {
  const dynamicAdmins = getDynamicAdmins();

  if (dynamicAdmins.length === 0) {
    const keyboard = new InlineKeyboard().text("⬅️ بازگشت", "admin_manage_users");
    await safeEditOrReply(ctx, "هیچ ادمین اضافی‌ای برای حذف وجود ندارد.\n\n⚠️ ادمین‌های اصلی قابل حذف نیستند.", keyboard);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const id of dynamicAdmins) {
    keyboard.text(`❌ حذف ${id}`, `remove_admin_confirm:${id}`).row();
  }
  keyboard.text("⬅️ بازگشت", "admin_manage_users");
  await safeEditOrReply(ctx, "🗑️ کدام ادمین را می‌خواهید حذف کنید؟\n\n⚠️ فقط ادمین‌های افزوده شده قابل حذف هستند.", keyboard);
}

module.exports = {
  showMainAdminPanel,
  promptForBroadcast,
  showUserManagementMenu,
  promptForSend,
  showFileList,
  showAddChannelMenu,
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
};
