const { InlineKeyboard } = require("grammy");
const { logger, isAdmin } = require("./config");

function generateFileIdentifier() {
  return Math.random().toString(36).substring(2, 12);
}

function hasCallbackButton(replyMarkup, callbackData) {
  if (!replyMarkup) return false;

  const rows =
    replyMarkup instanceof InlineKeyboard
      ? replyMarkup.inline_keyboard
      : replyMarkup.inline_keyboard;

  if (!Array.isArray(rows)) return false;

  return rows.some(
    (row) =>
      Array.isArray(row) &&
      row.some((btn) => btn && btn.callback_data === callbackData)
  );
}

function ensureBackToMenuButton(ctx, replyMarkup) {
  if (!ctx?.chat || ctx.chat.type !== "private" || !isAdmin(ctx)) {
    return replyMarkup;
  }

  const menuCallback = isAdmin(ctx) ? "admin_panel_main" : "user_go_home";
  const menuText = "🏠 بازگشت به منو";

  if (!replyMarkup) {
    return new InlineKeyboard().text(menuText, menuCallback);
  }

  const isInlineKeyboardInstance = replyMarkup instanceof InlineKeyboard;
  const isInlineKeyboardObject = Array.isArray(replyMarkup.inline_keyboard);

  // Do not change non-inline reply markups (e.g. reply keyboard/remove keyboard).
  if (!isInlineKeyboardInstance && !isInlineKeyboardObject) {
    return replyMarkup;
  }

  if (hasCallbackButton(replyMarkup, menuCallback)) {
    return replyMarkup;
  }

  if (isInlineKeyboardInstance) {
    replyMarkup.row().text(menuText, menuCallback);
    return replyMarkup;
  }

  return {
    ...replyMarkup,
    inline_keyboard: [
      ...replyMarkup.inline_keyboard,
      [{ text: menuText, callback_data: menuCallback }],
    ],
  };
}

// Helper function to safely edit or reply
async function safeEditOrReply(ctx, text, reply_markup, options = {}) {
  const finalReplyMarkup = ensureBackToMenuButton(ctx, reply_markup);

  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(text, {
        reply_markup: finalReplyMarkup,
        ...options,
      });
      await ctx.answerCallbackQuery();
    } else {
      await ctx.reply(text, { reply_markup: finalReplyMarkup, ...options });
    }
  } catch (e) {
    logger.warn(
      `خطا در ویرایش پیام. ارسال پیام جدید به عنوان جایگزین: ${e.message}`
    );
    try {
      await ctx.reply(text, { reply_markup: finalReplyMarkup, ...options });
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery();
      }
    } catch (replyError) {
      logger.error(`خطا در ارسال پیام جایگزین: ${replyError.message}`);
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
          text: "خطایی رخ داد. لطفاً دوباره تلاش کنید.",
          show_alert: true,
        });
      }
    }
  }
}

module.exports = {
  generateFileIdentifier,
  ensureBackToMenuButton,
  safeEditOrReply,
};
