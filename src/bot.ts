import { Request, Response } from 'express';
import { ConversationState } from './types';
import { currentPeriod, parsePeriod, fmt, SMLMV } from './ael';
import { sendMessage, extractMessage } from './whatsapp';
import { getAIResponse } from './ai';
import { procesarPlanilla, formatResultMsg } from './ael-scraper';

// ─── Sesiones ──────────────────────────────────────────────────────────────
const sessions = new Map<string, ConversationState>();
const SESSION_TTL = 30 * 60 * 1000;

function session(phone: string): ConversationState {
  const s = sessions.get(phone);
  if (s && Date.now() - s.lastActivity < SESSION_TTL) {
    s.lastActivity = Date.now();
    return s;
  }
  const fresh: ConversationState = {
    phone, step: 'WELCOME', messageHistory: [], lastActivity: Date.now(),
  };
  sessions.set(phone, fresh);
  return fresh;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const ESCALATE = /asesor|humano|persona|llamar/i;
const RESTART  = /^(hola|inicio|empezar|reiniciar|menú|menu)\b/i;

function isYes(t: string) { return /^(s[ií]|ok|dale|claro|confirmo|si|sí|1|yes)\b/i.test(t); }
function isNo(t: string)  { return /^(no|nop|cancel|0)\b/i.test(t); }

function parseIncome(t: string): number | null {
  const lo = t.toLowerCase().replace(/\s/g, '');
  const mm = lo.match(/^([\d.,]+)(millones?|m)$/);
  if (mm) { const n = parseFloat(mm[1].replace(',', '.')); return isNaN(n) ? null : Math.round(n * 1e6); }
  const n = parseInt(t.replace(/[^\d]/g, ''), 10);
  return n >= 200_000 && n <= 100_000_000 ? n : null;
}

// ─── Playwright en background ──────────────────────────────────────────────
async function runPlaywright(s: ConversationState, income: number): Promise<void> {
  try {
    const result = await procesarPlanilla(income, s.period!);
    s.step = 'DONE';
    await sendMessage(s.phone, formatResultMsg(result));
  } catch (err) {
    s.step = 'WELCOME';
    await sendMessage(s.phone, `Ocurrió un error inesperado. Escribe *hola* para intentar de nuevo.`);
  }
}

// ─── Flujo conversacional ──────────────────────────────────────────────────
async function processMsg(s: ConversationState, text: string): Promise<string> {
  s.messageHistory.push({ role: 'user', content: text });

  if (ESCALATE.test(text)) {
    return `Te conecto con un asesor de Aportes en Línea.\n\n*Horario:* lunes a viernes, 8 am – 6 pm\n*Línea:* 01 8000 123 456`;
  }

  if (RESTART.test(text) && s.step !== 'WELCOME') {
    Object.assign(s, { step: 'WELCOME', period: undefined, declaredIncome: undefined, planilla: undefined });
  }

  let reply = '';

  switch (s.step) {

    case 'WELCOME': {
      s.step = 'AWAITING_CONFIRM_PERIOD';
      const p = currentPeriod();
      s.period = p;
      reply =
        `¡Hola! Soy el asistente de *Aportes en Línea*.\n\n` +
        `Voy a gestionar el pago de tu seguridad social directamente en la plataforma.\n\n` +
        `¿Liquidamos la planilla de *${p.display}*?\n\n` +
        `_Si necesitas otro mes escríbelo así: mayo 2026 o 05/2026_`;
      break;
    }

    case 'AWAITING_CONFIRM_PERIOD': {
      if (isNo(text)) {
        reply = `¿Para qué mes necesitas la planilla?\n\nEscríbelo así: *mayo 2026* o *05/2026*`;
        break;
      }

      const period = isYes(text) ? s.period ?? currentPeriod() : (parsePeriod(text) ?? null);

      if (!period) {
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply = aiReply + `\n\nResponde *sí* para usar *${s.period?.display ?? currentPeriod().display}* o escríbeme el mes.`;
        break;
      }

      s.period = period;
      s.step = 'AWAITING_INCOME';
      reply =
        `Perfecto — planilla de *${period.display}*.\n\n` +
        `¿Cuánto fueron tus ingresos totales en ${period.month}?\n\n` +
        `Ejemplos: *4500000* · *$4.500.000* · *4.5 millones*\n\n` +
        `_(El IBC y los aportes los calcula directamente Aportes en Línea)_`;
      break;
    }

    case 'AWAITING_INCOME': {
      const income = parseIncome(text);
      if (!income) {
        if (text.length > 3) {
          const aiReply = await getAIResponse(text, s.messageHistory);
          reply = aiReply + `\n\nEnvíame el monto de tus ingresos de ${s.period!.month}. Ej: *4500000*`;
        } else {
          reply = `No reconocí ese monto. Envíame el número en pesos. Ej: *4500000*`;
        }
        break;
      }

      s.declaredIncome = income;
      s.step = 'PROCESSING';

      // Lanzar Playwright en background — sin await
      setTimeout(() => runPlaywright(s, income), 100);

      reply =
        `Procesando tu planilla de *${s.period!.display}* en Aportes en Línea...\n\n` +
        `Ingresos declarados: *${fmt(income)}*\n\n` +
        `Esto toma entre 30 y 60 segundos. Te aviso cuando esté listo.`;
      break;
    }

    case 'PROCESSING': {
      reply = `Estoy procesando tu planilla, espera un momento. Te aviso cuando termine.`;
      break;
    }

    case 'DONE': {
      if (/pagar|planilla|seguridad|aportes|otro mes/i.test(text)) {
        const p = currentPeriod();
        s.step = 'AWAITING_CONFIRM_PERIOD';
        s.period = p;
        s.declaredIncome = undefined;
        reply = `¿Quieres pagar otra planilla?\n\n¿Liquidamos *${p.display}* o es para otro mes?`;
      } else {
        reply = await getAIResponse(text, s.messageHistory);
      }
      break;
    }

    default: {
      s.step = 'WELCOME';
      reply = `Escribe *hola* para comenzar.`;
    }
  }

  s.messageHistory.push({ role: 'assistant', content: reply });
  return reply;
}

// ─── Handlers Express ──────────────────────────────────────────────────────
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const msg = extractMessage(req.body);
  if (!msg) return;

  const s = session(msg.from);

  try {
    const reply = await processMsg(s, msg.text);
    await sendMessage(msg.from, reply);
  } catch (err) {
    console.error('[Bot error]', err);
    await sendMessage(msg.from, `Tuve un problema técnico. Escribe *hola* para reintentar.`);
  }
}

export function verifyWebhook(req: Request, res: Response): void {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
}

export { processMsg as processMessage, session as getOrCreateSession };
