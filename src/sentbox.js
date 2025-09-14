/**
 * Rutina de descubrimiento IMAP para encontrar/crear carpeta de Enviados real en IONOS
 * 
 * No adivina nombres - usa SPECIAL-USE y descubrimiento real del servidor
 */

const { ImapFlow } = require('imapflow');

/**
 * Encuentra o crea la carpeta de Enviados real usando SPECIAL-USE e introspección del servidor
 * @returns {Promise<{sentPath: string, delimiter: string, created?: boolean}>}
 */
async function findOrCreateSentBox() {
  console.log('[IMAP DISCOVERY] Iniciando descubrimiento de carpeta Enviados...');
  
  // Configuración IMAP
  const host = process.env.IMAP_HOST || 'imap.ionos.com';
  const port = Number(process.env.IMAP_PORT || 993);
  const secure = String(process.env.IMAP_SECURE || 'true') === 'true';
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASS || process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('IMAP credentials missing (IMAP_USER/IMAP_PASS or SMTP_USER/SMTP_PASS)');
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false // Usar nuestro logging
  });

  console.log(`[IMAP DISCOVERY] Conectando a ${host}:${port} (secure: ${secure})...`);
  await client.connect();
  console.log('[IMAP DISCOVERY] Conexión establecida');

  // Log capabilities
  console.log('[IMAP DISCOVERY] Server capabilities:', JSON.stringify(client.capabilities, null, 2));

  let lock = null;
  try {
    // 1) Forzar login/capabilities y obtener un lock rápido para asegurar estado
    try {
      lock = await client.getMailboxLock('INBOX');
      console.log('[IMAP DISCOVERY] INBOX accessible');
    } catch (e) {
      console.log('[IMAP DISCOVERY] INBOX lock failed (not critical):', e.message);
    }
    if (lock) {
      await lock.release();
      lock = null;
    }

    // 2) Intentar SPECIAL-USE (\Sent) - Método estándar RFC6154
    console.log('[IMAP DISCOVERY] Buscando carpetas con SPECIAL-USE...');
    let special = [];
    try {
      special = await client.list({ specialUse: true });
      console.log('[IMAP DISCOVERY] Carpetas SPECIAL-USE encontradas:', 
        special.map(mb => ({ path: mb.path, flags: mb.flags, specialUse: mb.specialUse }))
      );
    } catch (e) {
      console.log('[IMAP DISCOVERY] SPECIAL-USE no soportado o falló:', e.message);
    }

    let sent = special.find(mb => 
      (mb.flags && mb.flags.includes('\\Sent')) ||
      (mb.specialUse && mb.specialUse === '\\Sent')
    );

    if (sent) {
      console.log('[IMAP DISCOVERY] ✅ Carpeta Sent encontrada via SPECIAL-USE:', sent.path);
    }

    // 3) Si no hubo SPECIAL-USE, listar todo y detectar delimitador
    console.log('[IMAP DISCOVERY] Listando todas las carpetas...');
    const all = await client.list('*');
    console.log('[IMAP DISCOVERY] Carpetas encontradas:');
    all.forEach(mb => {
      console.log(`  - Path: "${mb.path}", Flags: [${mb.flags ? mb.flags.join(', ') : 'none'}]`);
    });

    // Detectar delimitador mirando el primer mailbox con subniveles
    let delimiter = '/'; // default
    for (const mb of all) {
      if (mb.path.includes('/')) {
        delimiter = '/';
        break;
      } else if (mb.path.includes('.')) {
        delimiter = '.';
        break;
      }
    }
    console.log('[IMAP DISCOVERY] Delimitador detectado:', delimiter);

    // Si todavía no tenemos sent, buscar por nombres comunes EXACTOS entre los devueltos por el servidor
    if (!sent) {
      console.log('[IMAP DISCOVERY] Buscando por nombres comunes exactos...');
      const candidates = [
        'Sent', 'Sent Items', 'Sent Messages',
        `INBOX${delimiter}Sent`, `INBOX${delimiter}Sent Items`,
        'Enviados', 'Elementos enviados',
        'Gesendet', 'Gesendete Elemente', // Alemán
        'Envoyés', 'Éléments envoyés'    // Francés
      ];
      
      console.log('[IMAP DISCOVERY] Candidatos a buscar:', candidates);
      
      const byPath = new Map(all.map(mb => [mb.path.toLowerCase(), mb]));
      const hit = candidates.find(c => byPath.has(c.toLowerCase()));
      
      if (hit) {
        sent = byPath.get(hit.toLowerCase());
        console.log('[IMAP DISCOVERY] ✅ Carpeta Sent encontrada por coincidencia exacta:', sent.path);
      }
    }

    // 4) Crear si no existe
    let created = false;
    if (!sent) {
      console.log('[IMAP DISCOVERY] No se encontró carpeta Sent existente. Intentando crear...');
      const tryPaths = [
        `INBOX${delimiter}Sent`,
        `INBOX${delimiter}Sent Items`,
        'Sent'
      ];
      
      for (const p of tryPaths) {
        try {
          console.log(`[IMAP DISCOVERY] Intentando crear: "${p}"`);
          await client.mailboxCreate(p, { specialUse: '\\Sent' });
          created = true;
          console.log(`[IMAP DISCOVERY] ✅ Carpeta creada exitosamente: "${p}"`);
          
          // Refrescar lista y tomar el creado
          const refreshed = await client.list('*');
          sent = refreshed.find(mb => mb.path === p);
          if (sent) break;
        } catch (e) {
          console.log(`[IMAP DISCOVERY] ❌ Falló crear "${p}":`, e.message);
          // Intenta siguiente
        }
      }
      
      if (!sent) {
        throw new Error('No pude crear ni encontrar carpeta de enviados después de todos los intentos');
      }
    }

    const sentPath = sent.path;
    console.log('[IMAP DISCOVERY] 🎯 Path final de enviados:', sentPath, created ? '(CREADA)' : '(EXISTENTE)');

    // 5) Validar acceso con APPEND de prueba
    console.log('[IMAP DISCOVERY] Validando acceso con APPEND de prueba...');
    const testMessage = Buffer.from(
      'From: test@piensaajedrez.com\r\n' +
      `To: ${user}\r\n` +
      'Subject: IMAP Discovery Probe - Safe to Delete\r\n' +
      'Date: ' + new Date().toUTCString() + '\r\n' +
      '\r\n' +
      'This is a test message for IMAP discovery. Safe to delete.\r\n'
    );
    
    try {
      const appendResult = await client.append(sentPath, testMessage, { 
        flags: ['\\Seen', '\\Deleted'] 
      });
      console.log('[IMAP DISCOVERY] ✅ APPEND de prueba exitoso:', appendResult);
      
      // Intentar limpiar el mensaje de prueba inmediatamente
      try {
        const cleanLock = await client.getMailboxLock(sentPath);
        try {
          // Buscar y marcar para eliminar mensajes de prueba
          const messages = await client.search({ header: { subject: 'IMAP Discovery Probe' } });
          if (messages.length > 0) {
            await client.messageFlagsAdd(messages, ['\\Deleted']);
            await client.expunge();
            console.log('[IMAP DISCOVERY] ✅ Mensaje de prueba eliminado');
          }
        } finally {
          await cleanLock.release();
        }
      } catch (cleanupError) {
        console.log('[IMAP DISCOVERY] ⚠️ No se pudo limpiar mensaje de prueba (no crítico):', cleanupError.message);
      }
      
    } catch (e) {
      const msg = String(e?.message || e);
      console.log('[IMAP DISCOVERY] ❌ APPEND de prueba falló:', msg);
      
      // Si el servidor responde TRYCREATE, intenta crear y reintentar
      if (/TRYCREATE/i.test(msg)) {
        console.log('[IMAP DISCOVERY] Servidor sugiere TRYCREATE, reintentando...');
        try {
          await client.mailboxCreate(sentPath, { specialUse: '\\Sent' });
          const retryResult = await client.append(sentPath, testMessage, { 
            flags: ['\\Seen', '\\Deleted'] 
          });
          console.log('[IMAP DISCOVERY] ✅ APPEND exitoso después de TRYCREATE:', retryResult);
        } catch (e2) {
          await client.logout();
          throw new Error(`APPEND falló incluso tras TRYCREATE: ${e2.message}`);
        }
      } else {
        await client.logout();
        throw new Error(`APPEND falló: ${msg}`);
      }
    }

    await client.logout();
    console.log('[IMAP DISCOVERY] Desconectado del servidor');

    const result = { sentPath, delimiter, created };
    console.log('[IMAP DISCOVERY] 🎉 RESULTADO FINAL:', result);
    
    return result;

  } catch (error) {
    // Asegurar cleanup
    if (lock) {
      try { await lock.release(); } catch {}
    }
    try { await client.logout(); } catch {}
    
    console.error('[IMAP DISCOVERY] ❌ ERROR FATAL:', error.message);
    throw error;
  }
}

module.exports = {
  findOrCreateSentBox
};
