/**
 * Módulo IMAP para guardar copias de correos enviados en la carpeta "Enviados" de IONOS
 * 
 * Funcionalidad automática controlada por SAVE_SENT_COPY env var.
 * Solo se ejecuta después de un envío SMTP exitoso.
 * Los errores IMAP no afectan la respuesta al cliente.
 */

const { ImapFlow } = require('imapflow');

/**
 * Guarda una copia del correo enviado en la carpeta "Enviados" del buzón IONOS
 * @param {Object} params - Parámetros de configuración
 * @param {string} params.raw - Mensaje en formato RFC822 raw
 * @param {Object} params.logger - Logger (pino o console)
 * @returns {Promise<void>}
 */
async function appendToSent({ raw, logger }) {
  // Verificar si la funcionalidad está habilitada
  if (process.env.SAVE_SENT_COPY !== 'true') {
    logger?.debug?.('[IMAP] SAVE_SENT_COPY no está activado, omitiendo append');
    return;
  }

  // Configuración IMAP (con fallback a credenciales SMTP)
  const host = process.env.IMAP_HOST || 'imap.ionos.com';
  const port = Number(process.env.IMAP_PORT || 993);
  const secure = String(process.env.IMAP_SECURE || 'true') === 'true';
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASS || process.env.SMTP_PASS;
  const mailbox = process.env.IMAP_MAILBOX || 'Sent';

  logger?.info?.('[IMAP] Configuración:', {
    host,
    port,
    secure,
    user: user ? `${user.substring(0, 3)}***` : 'undefined',
    mailbox
  });

  // Validar credenciales
  if (!user || !pass) {
    logger?.warn?.('[IMAP] Credenciales IMAP ausentes; omitiendo append');
    return;
  }

  if (!raw || typeof raw !== 'string') {
    logger?.warn?.('[IMAP] Mensaje raw inválido; omitiendo append');
    return;
  }

  let client;
  try {
    // Crear cliente IMAP
    client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false // Desactivar logging interno de imapflow
    });

    logger?.info?.('[IMAP] Conectando al servidor...');
    await client.connect();
    logger?.info?.('[IMAP] Conexión establecida');

    // Intentar abrir el buzón de destino
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
      logger?.info?.(`[IMAP] Buzón "${mailbox}" abierto`);
    } catch (mailboxError) {
      // Si el buzón no existe, intentar con buzones alternativos comunes
      const fallbackMailboxes = ['Enviados', 'Sent', 'Sent Items', 'INBOX.Sent'];
      
      logger?.warn?.(`[IMAP] No se pudo abrir "${mailbox}": ${mailboxError?.message}`);
      
      for (const fallback of fallbackMailboxes) {
        try {
          lock = await client.getMailboxLock(fallback);
          logger?.info?.(`[IMAP] Usando buzón alternativo: "${fallback}"`);
          break;
        } catch (fallbackError) {
          logger?.debug?.(`[IMAP] Buzón "${fallback}" tampoco disponible: ${fallbackError?.message}`);
        }
      }
      
      if (!lock) {
        throw new Error(`No se pudo acceder a ningún buzón de enviados (${mailbox}, ${fallbackMailboxes.join(', ')})`);
      }
    }

    try {
      // Append del mensaje en formato RFC822 con flag \Seen
      await client.append(lock.path, raw, ['\\Seen'], new Date());
      logger?.info?.(`[IMAP] Copia guardada exitosamente en "${lock.path}"`);
    } finally {
      // Liberar el lock del buzón
      if (lock?.release) {
        lock.release();
      }
    }

  } catch (error) {
    // Log del error sin afectar el flujo principal
    logger?.warn?.(`[IMAP] Error al guardar en Enviados: ${error?.message}`);
    logger?.debug?.('[IMAP] Stack trace:', error?.stack);
  } finally {
    // Cerrar conexión IMAP
    if (client) {
      try {
        await client.logout();
        logger?.debug?.('[IMAP] Conexión IMAP cerrada');
      } catch (logoutError) {
        logger?.debug?.(`[IMAP] Error al cerrar conexión: ${logoutError?.message}`);
      }
    }
  }
}

/**
 * Construye un mensaje RFC822 raw a partir de las opciones de Nodemailer
 * @param {Object} mailOptions - Opciones del correo de Nodemailer
 * @param {string} fromEmail - Email del remitente (FROM_EMAIL env var)
 * @returns {string} Mensaje en formato RFC822
 */
function buildRFC822Message(mailOptions, fromEmail) {
  const from = fromEmail || mailOptions.from || 'noreply@piensaajedrez.com';
  const to = Array.isArray(mailOptions.to) ? mailOptions.to.join(', ') : mailOptions.to;
  const subject = mailOptions.subject || '';
  const text = mailOptions.text || '';
  const html = mailOptions.html;
  const messageId = mailOptions.messageId || `<${Date.now()}.${Math.random().toString(36)}@piensaajedrez.com>`;
  
  // Construir headers básicos
  let raw = '';
  raw += `Message-ID: ${messageId}\r\n`;
  raw += `Date: ${new Date().toUTCString()}\r\n`;
  raw += `From: ${from}\r\n`;
  raw += `To: ${to}\r\n`;
  raw += `Subject: ${subject}\r\n`;
  raw += `MIME-Version: 1.0\r\n`;
  
  // Agregar headers adicionales si están presentes
  if (mailOptions.cc) {
    const cc = Array.isArray(mailOptions.cc) ? mailOptions.cc.join(', ') : mailOptions.cc;
    raw += `Cc: ${cc}\r\n`;
  }
  
  if (mailOptions.bcc) {
    const bcc = Array.isArray(mailOptions.bcc) ? mailOptions.bcc.join(', ') : mailOptions.bcc;
    raw += `Bcc: ${bcc}\r\n`;
  }

  // Determinar tipo de contenido
  if (html && text) {
    // Multipart: HTML + texto
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36)}`;
    raw += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    
    raw += `--${boundary}\r\n`;
    raw += `Content-Type: text/plain; charset=utf-8\r\n`;
    raw += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    raw += `${text}\r\n\r\n`;
    
    raw += `--${boundary}\r\n`;
    raw += `Content-Type: text/html; charset=utf-8\r\n`;
    raw += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    raw += `${html}\r\n\r\n`;
    
    raw += `--${boundary}--\r\n`;
  } else if (html) {
    // Solo HTML
    raw += `Content-Type: text/html; charset=utf-8\r\n`;
    raw += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    raw += `${html}\r\n`;
  } else {
    // Solo texto plano
    raw += `Content-Type: text/plain; charset=utf-8\r\n`;
    raw += `Content-Transfer-Encoding: 8bit\r\n\r\n`;
    raw += `${text}\r\n`;
  }

  return raw;
}

module.exports = {
  appendToSent,
  buildRFC822Message
};
