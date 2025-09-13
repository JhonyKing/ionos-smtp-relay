require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const pinoHttp = require("pino-http");
const { validateSendEmail } = require("./src/validate");
const { appendToSent, buildRFC822Message } = require("./src/imap");

// Configuración del logger
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Usar pino-pretty solo en desarrollo, JSON logs en producción
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
      },
    },
  }),
});

const app = express();
const PORT = process.env.PORT || 10000;

// Configurar trust proxy para Cloudflare/Render
app.set("trust proxy", 1);

// Middleware de logging con request ID
const httpLogger = pinoHttp({
  logger,
  genReqId: () => Math.random().toString(36).substring(2, 15),
});

// Middlewares de seguridad y utilidad
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" })); // Limite para attachments
app.use(httpLogger);

// Función para extraer IP real detrás de proxies
const getRealIP = (req) => {
  return req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.ip;
};

// Rate limiting para el endpoint /send
const sendRateLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto por defecto
  max: parseInt(process.env.RATE_LIMIT_MAX) || 30, // 30 requests por minuto por defecto
  keyGenerator: getRealIP,
  message: {
    error: "Demasiadas solicitudes. Intente nuevamente en un momento.",
    retryAfter: Math.ceil(
      (parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000) / 1000
    ),
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Configuración del transporter de Nodemailer para IONOS
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ionos.com",
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true", // false para 587 (STARTTLS), true para 465 (SSL)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Configuraciones adicionales para IONOS
  tls: {
    ciphers: "SSLv3",
  },
  requireTLS: process.env.SMTP_SECURE !== "true",
});

/**
 * Mapea errores SMTP a códigos HTTP apropiados
 * @param {Error} error - Error de nodemailer
 * @returns {Object} - Código HTTP y mensaje
 */
function mapSmtpError(error) {
  const message = error.message.toLowerCase();

  // Errores de autenticación
  if (
    message.includes("authentication") ||
    message.includes("auth") ||
    message.includes("invalid login") ||
    message.includes("535")
  ) {
    return { status: 401, message: "Error de autenticación SMTP" };
  }

  // Errores de conexión/host/puerto
  if (
    message.includes("connection") ||
    message.includes("connect") ||
    message.includes("timeout") ||
    message.includes("enotfound") ||
    message.includes("network") ||
    message.includes("dns")
  ) {
    return { status: 502, message: "Error de conexión con el servidor SMTP" };
  }

  // Errores de TLS/SSL
  if (
    message.includes("tls") ||
    message.includes("ssl") ||
    message.includes("certificate")
  ) {
    return { status: 502, message: "Error de seguridad TLS/SSL" };
  }

  // Errores de validación de email
  if (
    message.includes("recipient") ||
    message.includes("invalid") ||
    message.includes("550") ||
    message.includes("553")
  ) {
    return { status: 422, message: "Dirección de email inválida o rechazada" };
  }

  // Error genérico del servidor
  return { status: 500, message: "Error interno del servidor SMTP" };
}

// Endpoint de health check
app.get("/health", (req, res) => {
  req.log.info("Health check requested");
  res.json({ status: "ok" });
});

// Endpoint principal para envío de emails
app.post("/send", sendRateLimit, async (req, res) => {
  const reqId = req.id;
  req.log.info(
    {
      reqId,
      body: {
        ...req.body,
        attachments: req.body.attachments
          ? `[${req.body.attachments.length} attachments]`
          : undefined,
      },
    },
    "Send email request received"
  );

  try {
    // Validar el body de la request
    const validation = validateSendEmail(req.body);

    if (!validation.success) {
      req.log.warn({ reqId, errors: validation.error }, "Validation failed");
      return res.status(422).json({
        error: "Datos de entrada inválidos",
        details: validation.error,
      });
    }

    const { to, subject, text, html, attachments } = validation.data;

    // Procesar attachments si existen
    const processedAttachments = attachments
      ? attachments.map((att) => ({
          filename: att.filename,
          content: Buffer.from(att.content, "base64"),
          contentType: att.contentType,
        }))
      : undefined;

    // Configurar el email
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      to: to,
      subject: subject,
      text: text,
      html: html,
      attachments: processedAttachments,
    };

    req.log.info(
      { reqId, to, subject, hasAttachments: !!processedAttachments },
      "Sending email"
    );

    // Enviar el email
    const info = await transporter.sendMail(mailOptions);

    // Hook IMAP: Guardar copia en "Enviados" (no bloquear respuesta si falla)
    if (process.env.SAVE_SENT_COPY === "true") {
      try {
        // Construir mensaje RFC822 raw
        const raw = buildRFC822Message(mailOptions, process.env.FROM_EMAIL);

        // Ejecutar append de forma asíncrona sin bloquear la respuesta
        appendToSent({ raw, logger: req.log }).catch((err) => {
          req.log.warn({ reqId, error: err?.message }, "[IMAP] Append falló");
        });

        req.log.info({ reqId }, "[IMAP] Append iniciado en background");
      } catch (imapError) {
        req.log.warn(
          { reqId, error: imapError?.message },
          "[IMAP] Error preparando append"
        );
      }
    }

    req.log.info(
      {
        reqId,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
      },
      "Email sent successfully"
    );

    // Respuesta exitosa
    res.json({
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    });
  } catch (error) {
    const mappedError = mapSmtpError(error);

    req.log.error(
      {
        reqId,
        error: error.message,
        stack: error.stack,
        mappedStatus: mappedError.status,
      },
      "Error sending email"
    );

    res.status(mappedError.status).json({
      error: mappedError.message,
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Middleware para rutas no encontradas
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Endpoint no encontrado",
    availableEndpoints: ["GET /health", "POST /send"],
  });
});

// Middleware global de manejo de errores
app.use((error, req, res, next) => {
  req.log.error(
    { error: error.message, stack: error.stack },
    "Unhandled error"
  );
  res.status(500).json({
    error: "Error interno del servidor",
  });
});

// Función para inicializar el servidor
async function startServer() {
  try {
    // Verificar configuración SMTP
    logger.info("Verificando conexión SMTP...");
    await transporter.verify();
    logger.info("Conexión SMTP verificada exitosamente");

    // Iniciar servidor
    app.listen(PORT, () => {
      logger.info(`Servidor iniciado en puerto ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
      logger.info(`Send endpoint: http://localhost:${PORT}/send`);
    });
  } catch (error) {
    logger.error({ error: error.message }, "Error al inicializar el servidor");
    process.exit(1);
  }
}

// Manejo de señales para cierre graceful
process.on("SIGTERM", () => {
  logger.info("SIGTERM recibido, cerrando servidor...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT recibido, cerrando servidor...");
  process.exit(0);
});

// Inicializar servidor
startServer();
