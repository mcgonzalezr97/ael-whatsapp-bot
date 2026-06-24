import { Request, Response } from 'express';
import { ConversationState } from './types';
import {
  lookupUser, calculatePlanilla, fmt, formatPlanillaMsg,
  currentPeriod, parsePeriod, mockPaymentLink, mockRadicado, SMLMV,
} from './ael';
import { sendMessage, extractMessage, markAsRead } from './whatsapp';
import { getAIResponse } from './ai';

// ─── Sesiones en memoria (→ Redis en producción) ───────────────────────────
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

// ─── Helpers de parsing ────────────────────────────────────────────────────
const YES = /^(s[ií]|ok|dale|claro|confirmo|correcto|exacto|afirmo|1|sí|si|yes)\b/i;
const NO  = /^(no|nop|neg|cancel|incorrecto|0|nope)\b/i;
const ESCALATE = /asesor|agente humano|persona|hablar con alguien|llamar/i;
const RESTART  = /^(hola|inicio|empezar|menú|menu|reiniciar)\b/i;

function isYes(t: string) { return YES.test(t); }
function isNo(t: string)  { return NO.test(t); }

function parseCedula(t: string): string | null {
  const c = t.replace(/\D/g, '');
  return c.length >= 6 && c.length <= 11 ? c : null;
}

function parseIncome(t: string): number | null {
  // Soporta: 4500000 | $4.500.000 | 4,500,000 | 4.5 millones | 4.5M
  const lower = t.toLowerCase().replace(/\s/g, '');
  const millM = lower.match(/^([\d.,]+)(millones?|m)$/);
  if (millM) {
    const n = parseFloat(millM[1].replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 1_000_000);
  }
  const digits = t.replace(/[^\d]/g, '');
  const n = parseInt(digits, 10);
  return n >= 200_000 && n <= 100_000_000 ? n : null;
}

// ─── Máquina de estados ────────────────────────────────────────────────────
async function processMsg(s: ConversationState, text: string): Promise<string> {
  s.messageHistory.push({ role: 'user', content: text });

  // Escalamiento a humano — en cualquier paso
  if (ESCALATE.test(text)) {
    return (
      `Te conecto con un asesor de Aportes en Línea ahora mismo.\n\n` +
      `*Horario:* lunes a viernes, 8 am – 6 pm\n` +
      `*Línea gratuita:* 01 8000 123 456\n` +
      `*WhatsApp:* +57 310 000 0000`
    );
  }

  // Reinicio global
  if (RESTART.test(text) && s.step !== 'WELCOME') {
    Object.assign(s, { step: 'WELCOME', userProfile: undefined, period: undefined, planilla: undefined, declaredIncome: undefined });
  }

  let reply = '';
  let ai = false;

  switch (s.step) {

    // ── Bienvenida ──────────────────────────────────────────────────────────
    case 'WELCOME': {
      s.step = 'AWAITING_CEDULA';
      reply =
        `¡Hola! Soy el asistente de *Aportes en Línea*.\n\n` +
        `Te ayudo a liquidar y pagar tu seguridad social desde aquí, sin llamadas ni filas.\n\n` +
        `Empecemos. ¿Cuál es tu número de *cédula de ciudadanía*?`;
      break;
    }

    // ── Recibir cédula ──────────────────────────────────────────────────────
    case 'AWAITING_CEDULA': {
      const ced = parseCedula(text);
      if (!ced) {
        ai = true;
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply = aiReply + `\n\nCuando quieras, envíame tu número de cédula (solo dígitos).`;
        break;
      }
      const profile = lookupUser(ced);
      if (!profile) {
        reply =
          `No encontré ninguna cuenta asociada a la cédula *${ced}*.\n\n` +
          `Verifica el número. Si aún no tienes cuenta en Aportes en Línea, escríbeme *"registro"* o llama al 01 8000 123 456.`;
        break;
      }
      s.userProfile = profile;
      s.step = 'AWAITING_CONFIRM_PROFILE';
      reply =
        `Encontré tu cuenta, *${profile.name}*.\n\n` +
        `Afiliaciones registradas:\n` +
        `• Salud: ${profile.affiliations.salud}\n` +
        `• Pensión: ${profile.affiliations.pension}\n` +
        `• ARL: ${profile.affiliations.arl} (Clase ${profile.affiliations.arlClase})\n\n` +
        `¿Esta información es correcta?`;
      break;
    }

    // ── Confirmar perfil ────────────────────────────────────────────────────
    case 'AWAITING_CONFIRM_PROFILE': {
      if (isNo(text)) {
        s.step = 'AWAITING_CEDULA';
        reply = `Entendido. Escríbeme de nuevo tu cédula para intentarlo.`;
        break;
      }
      if (!isYes(text)) {
        ai = true;
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply = aiReply + `\n\n¿Los datos de tu perfil son correctos? Responde *sí* o *no*.`;
        break;
      }
      const period = currentPeriod();
      s.step = 'AWAITING_CONFIRM_PERIOD';
      reply =
        `Perfecto. Vamos a liquidar la planilla de *${period.display}*.\n\n` +
        `¿Es este el periodo correcto?\n\n` +
        `_Si quieres pagar otro mes, escríbelo así: mayo 2025 o 05/2025_`;
      break;
    }

    // ── Confirmar periodo ───────────────────────────────────────────────────
    case 'AWAITING_CONFIRM_PERIOD': {
      if (isNo(text)) {
        reply =
          `¿Para qué mes necesitas la planilla?\n\n` +
          `Escríbelo así: *mayo 2025* o *05/2025*`;
        break;
      }

      let period = isYes(text) ? currentPeriod() : parsePeriod(text);

      if (!period) {
        ai = true;
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply =
          aiReply +
          `\n\nPara cambiar el periodo escríbelo así: _mayo 2025_ o _05/2025_. ` +
          `O responde *sí* para usar *${currentPeriod().display}*.`;
        break;
      }

      s.period = period;
      s.step = 'AWAITING_INCOME';
      reply =
        `Listo — planilla de *${period.display}*.\n\n` +
        `¿Cuánto fueron tus ingresos totales en ${period.month}?\n\n` +
        `Envíame el monto en pesos. Ejemplos:\n` +
        `• *4500000*\n` +
        `• *$4.500.000*\n` +
        `• *4.5 millones*\n\n` +
        `_El IBC se calcula como el 40% de este valor, con un mínimo de ${fmt(SMLMV)} (1 SMLMV 2025)._`;
      break;
    }

    // ── Recibir ingresos ────────────────────────────────────────────────────
    case 'AWAITING_INCOME': {
      const income = parseIncome(text);
      if (!income) {
        if (text.length > 2) {
          ai = true;
          const aiReply = await getAIResponse(text, s.messageHistory);
          reply =
            aiReply +
            `\n\nEnvíame el monto de tus ingresos de ${s.period!.month} en pesos. ` +
            `Ejemplo: *4500000*`;
        } else {
          reply =
            `No reconocí ese monto. Envíame solo el número sin letras. Ejemplos:\n` +
            `• *3200000*\n` +
            `• *$3.200.000*\n` +
            `• *3.2 millones*`;
        }
        break;
      }
      const planilla = calculatePlanilla(s.userProfile!, s.period!, income);
      s.declaredIncome = income;
      s.planilla = planilla;
      s.step = 'AWAITING_CONFIRM_PLANILLA';
      reply = formatPlanillaMsg(planilla);
      break;
    }

    // ── Confirmar planilla ──────────────────────────────────────────────────
    case 'AWAITING_CONFIRM_PLANILLA': {
      if (isNo(text)) {
        s.step = 'AWAITING_INCOME';
        s.planilla = undefined;
        reply =
          `Entendido. Ingresa de nuevo el monto correcto de tus ingresos de ${s.period!.month}.`;
        break;
      }
      if (!isYes(text)) {
        ai = true;
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply = aiReply + `\n\n¿Confirmamos la planilla para proceder al pago?`;
        break;
      }
      s.step = 'AWAITING_PAYMENT_METHOD';
      reply =
        `Perfecto. ¿Cómo quieres pagar *${fmt(s.planilla!.total)}*?\n\n` +
        `*1.* PSE — débito desde tu cuenta bancaria\n` +
        `*2.* Nequi — desde tu billetera virtual\n` +
        `*3.* Daviplata — desde tu billetera virtual\n\n` +
        `Responde con el número de tu opción.`;
      break;
    }

    // ── Seleccionar método de pago ──────────────────────────────────────────
    case 'AWAITING_PAYMENT_METHOD': {
      const MAP: Record<string, string> = {
        '1': 'PSE', 'pse': 'PSE',
        '2': 'Nequi', 'nequi': 'Nequi',
        '3': 'Daviplata', 'daviplata': 'Daviplata',
      };
      const method = MAP[text.toLowerCase().trim()];

      if (!method) {
        reply = `Responde *1* para PSE, *2* para Nequi o *3* para Daviplata.`;
        break;
      }

      s.pendingPaymentMethod = method;

      if (method === 'PSE') {
        s.step = 'AWAITING_PAYMENT_CONFIRM';
        const link = mockPaymentLink();
        reply =
          `Aquí tienes tu enlace de pago seguro por PSE:\n\n` +
          `🔗 ${link}\n\n` +
          `*Monto:* ${fmt(s.planilla!.total)}\n` +
          `*Concepto:* Planilla SS ${s.planilla!.period.display}\n` +
          `*Validez:* 15 minutos\n\n` +
          `Cuando completes el pago en tu banco, escríbeme *PAGADO*.`;
      } else {
        // Nequi / Daviplata: débito inmediato simulado
        const rad = mockRadicado(s.planilla!.period);
        s.step = 'DONE';
        reply =
          `Procesando pago con ${method}...\n\n` +
          `*Pago aprobado.*\n\n` +
          `Planilla *${s.planilla!.period.display}*: liquidada\n` +
          `Radicado: *${rad}*\n` +
          `Monto pagado: *${fmt(s.planilla!.total)}*\n\n` +
          `El comprobante fue enviado a ${s.userProfile!.email}.\n\n` +
          `¿Necesitas algo más?`;
      }
      break;
    }

    // ── Esperar confirmación de pago PSE ────────────────────────────────────
    case 'AWAITING_PAYMENT_CONFIRM': {
      if (/^(pagado|pague|listo|confirmo|ya pagué|hecho|ok)\b/i.test(text)) {
        const rad = mockRadicado(s.planilla!.period);
        s.step = 'DONE';
        reply =
          `*Pago verificado y confirmado.*\n\n` +
          `Planilla *${s.planilla!.period.display}*: liquidada\n` +
          `Radicado: *${rad}*\n` +
          `Monto: *${fmt(s.planilla!.total)}*\n\n` +
          `Comprobante enviado a ${s.userProfile!.email}.\n\n` +
          `¿Hay algo más en lo que pueda ayudarte?`;
      } else if (/cancel|no pude|falló|vencido|error|problema/i.test(text)) {
        s.step = 'AWAITING_PAYMENT_METHOD';
        s.pendingPaymentMethod = undefined;
        reply =
          `Sin problema. ¿Quieres intentar con otro método?\n\n` +
          `*1.* PSE  *2.* Nequi  *3.* Daviplata`;
      } else {
        ai = true;
        const aiReply = await getAIResponse(text, s.messageHistory);
        reply = aiReply + `\n\nCuando completes el pago por PSE, escríbeme *PAGADO*.`;
      }
      break;
    }

    // ── Post-pago ───────────────────────────────────────────────────────────
    case 'DONE': {
      if (/pagar|planilla|seguridad social|aportes|otro mes/i.test(text)) {
        const period = currentPeriod();
        s.step = 'AWAITING_CONFIRM_PERIOD';
        s.planilla = undefined;
        s.declaredIncome = undefined;
        reply =
          `¡Claro! Vamos con otra planilla.\n\n` +
          `Usando el mismo perfil: *${s.userProfile!.name}*.\n\n` +
          `¿Liquido la planilla de *${period.display}* o es para otro mes?`;
      } else {
        ai = true;
        reply = await getAIResponse(text, s.messageHistory);
      }
      break;
    }

    default: {
      s.step = 'WELCOME';
      reply = `Escribe *hola* para comenzar de nuevo.`;
    }
  }

  const finalReply = ai ? reply : reply;
  s.messageHistory.push({ role: 'assistant', content: finalReply });
  return finalReply;
}

// ─── Handlers Express ──────────────────────────────────────────────────────

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  res.sendStatus(200); // Siempre ack inmediato — Meta reintenta si tarda >5s

  const msg = extractMessage(req.body);
  if (!msg) return;

  const s = session(msg.from);
  await markAsRead(msg.messageId);

  try {
    const reply = await processMsg(s, msg.text);
    await sendMessage(msg.from, reply);
  } catch (err) {
    console.error('[Bot error]', err);
    await sendMessage(
      msg.from,
      `Tuve un problema técnico. Intenta de nuevo en un momento o escribe *"asesor"*.`
    );
  }
}

export function verifyWebhook(req: Request, res: Response): void {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verificación OK');
    res.status(200).send(challenge);
  } else {
    console.warn('[Webhook] Token inválido');
    res.sendStatus(403);
  }
}

// Exportar para test CLI
export { processMsg as processMessage, session as getOrCreateSession };
