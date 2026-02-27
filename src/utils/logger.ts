/**
 * Structured logger built on Winston.
 */

import { createLogger, format, transports } from "winston";
import config from "../config/index.js";

const logger = createLogger({
  level: config.log.level,
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack, ...meta }) => {
      const metaStr = Object.keys(meta).length
        ? ` ${JSON.stringify(meta)}`
        : "";
      const stackStr = stack ? `\n${stack}` : "";
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}${stackStr}`;
    }),
  ),
  transports: [new transports.Console()],
});

export default logger;
