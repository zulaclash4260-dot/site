const winston = require("winston");

const TOKEN = "8447889056:AAH-4V74rjUVnYtKuM79EmGFP_bOS9f1eeA";
const ADMIN_IDs = [6765985635, 6075131517, 5703160092];

const FLOOD_LIMIT_SECONDS_GLOBAL = 30;
const FLOOD_BAN_DURATION_MS = 60 * 1000;

// Configure Winston Logger
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

// Dynamic admins loaded from database (cached for sync access)
const dynamicAdminIds = new Set();

const isAdmin = (ctx) =>
  ADMIN_IDs.includes(ctx.from?.id) || dynamicAdminIds.has(ctx.from?.id);

const isPrimaryAdmin = (ctx) => ADMIN_IDs.includes(ctx.from?.id);

function addDynamicAdmin(id) {
  dynamicAdminIds.add(id);
}

function removeDynamicAdmin(id) {
  dynamicAdminIds.delete(id);
}

function getDynamicAdmins() {
  return Array.from(dynamicAdminIds);
}

function loadDynamicAdmins(ids) {
  dynamicAdminIds.clear();
  for (const id of ids) {
    dynamicAdminIds.add(id);
  }
}

module.exports = {
  TOKEN,
  ADMIN_IDs,
  FLOOD_LIMIT_SECONDS_GLOBAL,
  FLOOD_BAN_DURATION_MS,
  logger,
  isAdmin,
  isPrimaryAdmin,
  addDynamicAdmin,
  removeDynamicAdmin,
  getDynamicAdmins,
  loadDynamicAdmins,
};
