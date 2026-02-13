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
  const counts = {};
  for (const file of dbData.files) {
    if (file.file_types && Array.isArray(file.file_types)) {
      for (const type of file.file_types) {
        counts[type] = (counts[type] || 0) + 1;
      }
    } else {
      const type = file.file_type || "unknown";
      counts[type] = (counts[type] || 0) + 1;
    }
  }
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
    .text("📋 لیست جوین اجباری", "list_force_join_channels")
    .row()
    .text("🔗 افزودن لینک کمکی (بدون چک)", "add_extra_link_start")
    .row()
    .text("🗑️ حذف لینک کمکی (بدون چک)", "remove_extra_link_start")
    .row()
    .text("⬅️ بازگشت", "admin_panel_main");
  const text =
    "برای افزودن اجباری، یک پیام از کانال/گروه فوروارد کنید یا لینک کانال/گروه (مثل https://t.me/username) را ارسال کنید.\n\nبرای لینک کمکی، فقط دکمه لینک اضافه می‌شود و چک عضویت انجام نمی‌شود.";
  await safeEditOrReply(ctx, text, keyboard);
}

async function showForceJoinList(ctx) {
  const dbData = await readDB();
  const channels = dbData.forceJoin;
  const extraLinks = dbData.extraForceJoinLinks;

  if (channels.length === 0 && extraLinks.length === 0) {
    const keyboard = new InlineKeyboard()
      .text("➕ افزودن کانال/گروه اجباری", "add_channel_start")
      .row()
      .text("⬅️ بازگشت", "admin_add_channel");
    await safeEditOrReply(ctx, "📋 هیچ آیتم جوین اجباری ثبت نشده است.", keyboard);
    return;
  }

  let message = "📋 *لیست جوین اجباری:*\n\n";

  if (channels.length > 0) {
    message += "📢 *کانال‌ها/گروه‌های اجباری (با چک عضویت):*\n\n";
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const chatTypeText =
        ch.chat_type === "group" || ch.chat_type === "supergroup"
          ? "گروه"
          : "کانال";
      const visibility = ch.invite_link && ch.invite_link.includes("/+")
        ? "خصوصی 🔒"
        : "عمومی 🌐";
      const buttonText =
        typeof ch.button_text === "string" && ch.button_text.trim()
          ? ch.button_text.trim()
          : `عضویت در ${ch.title}`;
      let conditionText = "بدون شرط حذف خودکار";
      if (ch.condition) {
        conditionText = `حذف بعد از ${ch.condition.limit} عضو (فعلی: ${ch.condition.current_count})`;
      }

      message += `${i + 1}. *${ch.title}*\n`;
      message += `   🆔 شناسه: \`${ch.id}\`\n`;
      message += `   📌 نوع: ${chatTypeText} (${visibility})\n`;
      message += `   🔗 لینک: ${ch.invite_link}\n`;
      message += `   🔘 متن دکمه: ${buttonText}\n`;
      message += `   ⚙️ شرط: ${conditionText}\n\n`;
    }
  }

  if (extraLinks.length > 0) {
    message += "🔗 *لینک‌های کمکی (بدون چک عضویت):*\n\n";
    for (let i = 0; i < extraLinks.length; i++) {
      const link = extraLinks[i];
      const btn =
        typeof link.button_text === "string" && link.button_text.trim()
          ? link.button_text.trim()
          : link.title || "لینک کمکی";
      message += `${i + 1}. *${btn}*\n`;
      message += `   🔗 ${link.invite_link}\n\n`;
    }
  }

  message += `\n📊 مجموع: ${channels.length} آیتم اجباری، ${extraLinks.length} لینک کمکی`;

  const keyboard = new InlineKeyboard()
    .text("➕ افزودن", "add_channel_start")
    .text("➖ حذف", "remove_channel_start")
    .row()
    .text("⬅️ بازگشت", "admin_add_channel");
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
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
  const pingMs = await measureApiPing(ctx);
  const pingText = pingMs !== null ? `${pingMs}ms` : "نامشخص";

  const uptimeSeconds = Math.floor(process.uptime());
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeSecs = uptimeSeconds % 60;
  const uptimeText = `${uptimeHours} ساعت و ${uptimeMinutes} دقیقه و ${uptimeSecs} ثانیه`;

  const text = `📊 *آمار و وضعیت ربات:*

🟢 وضعیت: فعال
⏱ آپتایم: ${uptimeText}
🏓 پینگ API: ${pingText}

لطفاً نوع آماری که می‌خواهید مشاهده کنید را انتخاب کنید:`;
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
  await safeEditOrReply(ctx, text, keyboard, { parse_mode: "Markdown" });
}

async function showUserStats(ctx) {
  const dbData = await readDB();
  const totalUsers = dbData.users.length;
  const bannedUsers = dbData.bannedUsers.length;
  const bannedSet = new Set(dbData.bannedUsers);
  const activeUsers = dbData.allUsersData.filter((u) => !bannedSet.has(u.id)).length;
  const dynamicAdmins = getDynamicAdmins();
  const totalAdmins = ADMIN_IDs.length + dynamicAdmins.length;

  // Calculate actual download statistics from files table (reliable cumulative counter)
  const totalDownloads = dbData.files.reduce((sum, f) => sum + (f.usage_count || 0), 0);
  const avgDownloadsPerUser = totalUsers > 0 ? (totalDownloads / totalUsers).toFixed(1) : 0;
  const totalFileEntries = dbData.files.length;

  // Registration timeline
  const now = Date.now();
  const usersWithDate = dbData.allUsersData.filter((u) => u.created_at && Number(u.created_at) > 0);
  const last24h = usersWithDate.filter((u) => now - Number(u.created_at) < DAY_MS).length;
  const last7d = usersWithDate.filter((u) => now - Number(u.created_at) < 7 * DAY_MS).length;
  const last30d = usersWithDate.filter((u) => now - Number(u.created_at) < 30 * DAY_MS).length;

  let message = `📊 *آمار کاربران:*

👤 کل کاربران: *${totalUsers}*
✅ کاربران فعال (غیر مسدود): *${activeUsers}*
🚫 کاربران مسدود شده: *${bannedUsers}*
👑 تعداد ادمین‌ها: *${totalAdmins}*

📅 *روند عضویت:*
🕐 ۲۴ ساعت اخیر: *${last24h}* کاربر جدید
📆 ۷ روز اخیر: *${last7d}* کاربر جدید
🗓 ۳۰ روز اخیر: *${last30d}* کاربر جدید

📈 *فعالیت کلی:*
📥 مجموع دانلودها: *${totalDownloads}*
📊 میانگین دانلود به ازای هر کاربر: *${avgDownloadsPerUser}*
🗂 تعداد لینک‌های فایل: *${totalFileEntries}*`;

  const keyboard = new InlineKeyboard().text(
    "⬅️ بازگشت به آمار",
    "admin_show_stats"
  );
  await safeEditOrReply(ctx, message, keyboard, { parse_mode: "Markdown" });
}

async function showFileStats(ctx) {
  const dbData = await readDB();
  const totalEntries = dbData.files.length;

  // Count individual files properly (including files within group entries)
  const counts = {};
  let totalIndividualFiles = 0;
  for (const file of dbData.files) {
    if (file.file_types && Array.isArray(file.file_types)) {
      for (const type of file.file_types) {
        counts[type] = (counts[type] || 0) + 1;
        totalIndividualFiles++;
      }
    } else {
      const type = file.file_type || "unknown";
      counts[type] = (counts[type] || 0) + 1;
      totalIndividualFiles++;
    }
  }

  const totalDownloads = dbData.files.reduce((sum, f) => sum + (f.usage_count || 0), 0);
  const avgDownloads = totalEntries > 0 ? (totalDownloads / totalEntries).toFixed(1) : 0;
  const mostDownloaded = dbData.files.reduce(
    (max, f) => ((f.usage_count || 0) > (max.usage_count || 0) ? f : max),
    { usage_count: 0 }
  );
  const groupFiles = dbData.files.filter((f) => f.file_ids && Array.isArray(f.file_ids)).length;
  const singleFiles = totalEntries - groupFiles;

  let message = `📊 *آمار فایل‌ها:*

📦 کل لینک‌های ذخیره شده: *${totalEntries}*
📁 کل فایل‌های منفرد: *${totalIndividualFiles}*
📌 لینک‌های تکی: *${singleFiles}*
📦 لینک‌های گروهی: *${groupFiles}*

📥 *آمار دانلود:*
📊 مجموع دانلودها: *${totalDownloads}*
📈 میانگین دانلود هر لینک: *${avgDownloads}*
🏆 بیشترین دانلود: *${mostDownloaded.usage_count || 0}* بار${
    mostDownloaded.file_identifier
      ? ` (\`${mostDownloaded.file_identifier}\`)`
      : ""
  }

📂 *تفکیک بر اساس نوع:*\n`;

  for (const [type, count] of Object.entries(counts)) {
    const fileTypePersian =
      {
        photo: "🖼️ عکس",
        video: "🎬 ویدیو",
        audio: "🎵 آهنگ",
        document: "📄 سند",
        unknown: "❓ نامشخص",
      }[type] || type;
    const percentage = totalIndividualFiles > 0 ? ((count / totalIndividualFiles) * 100).toFixed(1) : 0;
    message += `${fileTypePersian}: *${count}* عدد (${percentage}%)\n`;
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

  // Get actual total tracked joins from user_channel_joins table
  const joinCountRow = await getQuery("SELECT COUNT(*) AS total FROM user_channel_joins");
  const totalTrackedJoins = joinCountRow ? joinCountRow.total : 0;

  let message = `📊 *آمار جوین اجباری:*

➕ تعداد کل کانال‌ها/گروه‌های اجباری: *${totalForceJoinChannels}*
🔗 تعداد لینک‌های کمکی بدون چک: *${totalExtraLinks}*
👥 مجموع جوین‌های ثبت شده: *${totalTrackedJoins}*\n\n`;

  if (totalForceJoinChannels > 0) {
    message += `📢 *جزئیات کانال‌ها/گروه‌ها:*\n\n`;
    for (let i = 0; i < dbData.forceJoin.length; i++) {
      const channel = dbData.forceJoin[i];
      const chatTypeText =
        channel.chat_type === "supergroup" || channel.chat_type === "group"
          ? "گروه"
          : "کانال";
      const visibility = channel.invite_link && channel.invite_link.includes("/+")
        ? "خصوصی 🔒"
        : "عمومی 🌐";
      let conditionText = "بدون شرط حذف خودکار";
      if (channel.condition) {
        const progress = channel.condition.limit > 0
          ? ((channel.condition.current_count / channel.condition.limit) * 100).toFixed(0)
          : 0;
        conditionText = `حذف بعد از *${channel.condition.limit}* عضو (فعلی: *${channel.condition.current_count}* - ${progress}%)`;
      }
      // Get actual unique join count from user_channel_joins table
      const channelJoinRow = await getQuery(
        "SELECT COUNT(*) AS cnt FROM user_channel_joins WHERE channel_id = ?",
        [channel.id]
      );
      const currentCount = channelJoinRow ? channelJoinRow.cnt : 0;

      const buttonText =
        typeof channel.button_text === "string" && channel.button_text.trim()
          ? channel.button_text.trim()
          : `عضویت در ${channel.title}`;
      message += `${i + 1}. *${channel.title}*\n`;
      message += `   🆔 شناسه: \`${channel.id}\`\n`;
      message += `   📌 نوع: ${chatTypeText} (${visibility})\n`;
      message += `   🔗 لینک: ${channel.invite_link}\n`;
      message += `   🔘 متن دکمه: ${buttonText}\n`;
      message += `   ⚙️ شرط: ${conditionText}\n`;
      message += `   👥 جوین منحصر به فرد: *${currentCount}* کاربر\n\n`;
    }
  } else {
    message += `فعلاً هیچ کانال/گروهی برای جوین اجباری ثبت نشده است.\n`;
  }

  if (totalExtraLinks > 0) {
    message += `\n🔗 *لینک‌های کمکی (بدون چک):*\n\n`;
    for (let i = 0; i < dbData.extraForceJoinLinks.length; i++) {
      const link = dbData.extraForceJoinLinks[i];
      const btn =
        typeof link.button_text === "string" && link.button_text.trim()
          ? link.button_text.trim()
          : link.title || "لینک کمکی";
      message += `${i + 1}. *${btn}*: ${link.invite_link}\n`;
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

  let message_text = "🔝 *30 فایل پردانلود اخیر:*\n\n";
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
  const guideText = `📖 *راهنمای کامل پنل ادمین*

🔹 *ارسال همگانی* (📨)
دو حالت دارد:
• *ارسال پیام جدید*: پیام شما بدون برچسب فوروارد برای همه کاربران کپی و ارسال می‌شود. کپشن، فرمت و دکمه‌های شیشه‌ای حفظ می‌شوند.
• *فوروارد پیام*: پیام با برچسب فوروارد ارسال می‌شود. توجه: اگر پیام از کانال خصوصی باشد ممکن است ارسال نشود.
⚠️ ربات بصورت خودکار با تأخیر بهینه ارسال می‌کند تا از محدودیت تلگرام جلوگیری شود.

🔹 *مدیریت جوین اجباری* (➕)
• یک پیام از کانال/گروه فوروارد کنید یا لینک عمومی آن را ارسال کنید تا اضافه شود (چک عضویت انجام می‌شود).
• ربات به طور خودکار نوع (کانال/گروه) و وضعیت (عمومی/خصوصی) را تشخیص می‌دهد.
• لینک دعوت و متن دکمه عضویت را تنظیم کنید.
• شرط حذف خودکار بر اساس تعداد عضو قابل تنظیم است.
• می‌توانید لینک کمکی اضافه کنید که فقط نمایش داده می‌شود و چک عضویت ندارد.
• از دکمه «📋 لیست جوین اجباری» برای مشاهده تمام آیتم‌های ثبت شده استفاده کنید.

🔹 *مدیریت کاربران* (🚫)
• *مسدود کردن*: شناسه عددی بفرستید یا پیامی از کاربر فوروارد کنید.
• *رفع مسدودیت*: شناسه عددی کاربر را بفرستید.
• *افزودن ادمین*: شناسه عددی کاربر را بفرستید تا ادمین شود.
• *حذف ادمین*: از لیست ادمین‌ها انتخاب کنید.
• *لیست ادمین‌ها*: مشاهده تمام ادمین‌های ربات.

🔹 *آمار فایل‌ها* (📊)
تعداد فایل‌ها به تفکیک نوع (عکس/ویدیو/آهنگ/سند) نمایش داده می‌شود.

🔹 *دریافت لینک فایل* (⬆️)
• *تکی*: یک فایل بفرستید، کپشن تنظیم کنید و لینک دریافت کنید.
• *گروهی*: چند فایل بفرستید و یک لینک مشترک بسازید.

🔹 *حذف فایل با لینک* (🗑️)
لینک اشتراک فایل را بفرستید تا از دیتابیس حذف شود.

🔹 *تنظیمات پیشرفته* (⚙️)
• متن کپشن پیش‌فرض
• زمان حذف خودکار محتوا
• متن بررسی اجباری
• روشن/خاموش کردن بررسی اجباری
• روشن/خاموش کردن ربات
• حد مجاز پیام (ضد اسپم)
• کانال ذخیره فایل‌ها
• سرعت ارسال همگانی (ایمن/متعادل/سریع)

🔹 *آمار ربات* (📈)
• آمار کاربران، فایل‌ها، جوین اجباری
• آمار استفاده از لینک‌ها
• ۳۰ فایل پردانلود

🔹 *دستورات مفید*
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

  let message = `👑 *لیست ادمین‌های ربات:*\n\n`;
  message += `🔒 *ادمین‌های اصلی (غیرقابل حذف):*\n`;
  for (const id of ADMIN_IDs) {
    message += `• \`${id}\`\n`;
  }

  if (dynamicAdmins.length > 0) {
    message += `\n🔓 *ادمین‌های افزوده شده:*\n`;
    for (const id of dynamicAdmins) {
      message += `• \`${id}\`\n`;
    }
  } else {
    message += `\nهیچ ادمین اضافی ثبت نشده است.`;
  }

  message += `\n\n📊 مجموع ادمین‌ها: *${ADMIN_IDs.length + dynamicAdmins.length}*`;

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
};
