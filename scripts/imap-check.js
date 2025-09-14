#!/usr/bin/env node

/**
 * Script de verificación IMAP - Descubre carpeta de Enviados real en IONOS
 * 
 * Uso: npm run imap:check
 */

require('dotenv').config();
const { findOrCreateSentBox } = require('../src/sentbox');

console.log('🔍 IMAP DISCOVERY - Verificación de carpeta Enviados en IONOS');
console.log('================================================================');
console.log('');

(async () => {
  try {
    console.log('⏳ Iniciando descubrimiento...');
    console.log('');
    
    const result = await findOrCreateSentBox();
    
    console.log('');
    console.log('✅ ÉXITO - Carpeta de Enviados encontrada/creada');
    console.log('================================================');
    console.log('📁 Path final:', result.sentPath);
    console.log('🔗 Delimitador:', result.delimiter);
    console.log('🆕 Creada:', result.created ? 'SÍ' : 'NO (ya existía)');
    console.log('');
    console.log('🎯 La carpeta está lista para recibir correos enviados automáticamente');
    console.log('');
    
    process.exit(0);
  } catch (error) {
    console.log('');
    console.error('❌ ERROR EN DESCUBRIMIENTO IMAP');
    console.error('================================');
    console.error('Mensaje:', error.message);
    console.error('');
    console.error('📋 VERIFICAR:');
    console.error('- Variables de entorno IMAP_USER, IMAP_PASS (o SMTP_USER, SMTP_PASS)');
    console.error('- Conectividad a imap.ionos.com:993');
    console.error('- Credenciales válidas para IONOS');
    console.error('');
    console.error('Stack trace completo:');
    console.error(error.stack);
    console.error('');
    
    process.exit(1);
  }
})();
