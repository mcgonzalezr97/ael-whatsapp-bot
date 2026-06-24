import axios from 'axios';

const BASE_URL = () =>
  `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

// ─── Enviar mensaje de texto ───────────────────────────────────────────────
export async function sendMessage(to: string, text: string): Promise<void> {
  // WhatsApp tiene límite de 4096 caracteres por mensaje
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await axios.post(
      BASE_URL(),
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: chunk, preview_url: false },
      },
      { headers: headers() }
    );
    // Pequeño delay entre mensajes para preservar orden
    if (chunks.length > 1) await sleep(300);
  }
}

// ─── Marcar mensaje como leído ─────────────────────────────────────────────
export async function markAsRead(messageId: string): Promise<void> {
  await axios.post(
    BASE_URL(),
    { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    { headers: headers() }
  ).catch(() => {}); // No bloquear si falla
}

// ─── Extraer mensaje entrante del payload de Meta ─────────────────────────
export interface IncomingMessage {
  from: string;
  messageId: string;
  text: string;
}

export function extractMessage(body: unknown): IncomingMessage | null {
  try {
    const b = body as Record<string, unknown>;
    const entry = (b?.entry as unknown[])?.[0] as Record<string, unknown>;
    const change = (entry?.changes as unknown[])?.[0] as Record<string, unknown>;
    const value = change?.value as Record<string, unknown>;
    const msg = (value?.messages as unknown[])?.[0] as Record<string, unknown>;

    if (!msg || msg.type !== 'text') return null;

    return {
      from: msg.from as string,
      messageId: msg.id as string,
      text: ((msg.text as Record<string, unknown>)?.body as string)?.trim() ?? '',
    };
  } catch {
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start) end = lastBreak;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
