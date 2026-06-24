/**
 * Test CLI — simula una conversación completa sin WhatsApp ni APIs externas.
 * Uso: npx tsx src/test-cli.ts
 */
import 'dotenv/config';
import * as readline from 'readline';
import { processMessage, getOrCreateSession } from './bot';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const TEST_PHONE = '573001234567';

console.log('\n────────────────────────────────────────');
console.log('  AeL WhatsApp Bot — Test CLI');
console.log('  Cédulas de prueba: 12345678 | 87654321 | 11111111');
console.log('  Escribe "salir" para terminar.');
console.log('────────────────────────────────────────\n');

const state = getOrCreateSession(TEST_PHONE);

async function chat(input: string): Promise<void> {
  if (input.toLowerCase() === 'salir') {
    console.log('\nSesión terminada.\n');
    rl.close();
    process.exit(0);
  }
  try {
    const reply = await processMessage(state, input);
    console.log(`\nAgente AeL:\n${reply}\n`);
  } catch (err) {
    console.error('Error:', err);
  }
  prompt();
}

function prompt(): void {
  rl.question('Tú: ', (input) => chat(input.trim()));
}

// Iniciar con mensaje vacío para disparar el WELCOME
chat('hola');
